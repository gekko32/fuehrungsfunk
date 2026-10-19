// Führungsfunk – Live-Audio vom Guide-Handy an die Handys der Gruppe.
// Sender (Browser, MediaRecorder) -> WebSocket -> ffmpeg -> Icecast -> /stream -> Hörer (<audio>).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8090);
const TOKEN = process.env.SENDE_TOKEN;            // geheimer Teil des Sende-Links
const ICE_PW = process.env.ICECAST_SOURCE_PW;
const ICE = 'http://127.0.0.1:8000';
if (!TOKEN || !ICE_PW) { console.error('SENDE_TOKEN und ICECAST_SOURCE_PW fehlen'); process.exit(1); }

const seite = (name) => fs.readFileSync(path.join(__dirname, name));
const guide = require('./guide')(TOKEN, seite);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (await guide(req, res, url)) return;
  if (url.pathname === '/') return sende(res, 200, 'text/html; charset=utf-8', seite('hoeren.html'));
  if (url.pathname === '/senden') {
    if (url.searchParams.get('k') !== TOKEN) return sende(res, 403, 'text/plain; charset=utf-8', 'Kein Zugriff.');
    return sende(res, 200, 'text/html; charset=utf-8', seite('senden.html'));
  }
  if (url.pathname === '/stream') return streamWeiterleiten(req, res);
  if (url.pathname === '/status') return status(res);
  sende(res, 404, 'text/plain; charset=utf-8', 'Nicht gefunden.');
});

function sende(res, code, typ, body) {
  res.writeHead(code, { 'Content-Type': typ, 'Cache-Control': 'no-store' });
  res.end(body);
}

// Icecast lauscht nur lokal; die Hörer bekommen den Strom über diesen Server.
function streamWeiterleiten(req, res) {
  console.log('Hörer per HTTP:', req.headers['user-agent']);
  const up = http.get(ICE + '/live', (ice) => {
    if (ice.statusCode !== 200) { ice.resume(); return sende(res, 503, 'text/plain; charset=utf-8', 'Gerade keine Sendung.'); }
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    ice.pipe(res);
  });
  up.on('error', () => sende(res, 503, 'text/plain; charset=utf-8', 'Gerade keine Sendung.'));
  req.on('close', () => up.destroy());
}

function status(res) {
  http.get(ICE + '/status-json.xsl', (r) => {
    let d = '';
    r.on('data', (c) => (d += c));
    r.on('end', () => {
      let src;
      try { src = JSON.parse(d).icestats.source; } catch { src = null; }
      const live = Array.isArray(src) ? src.find((s) => s.listenurl.endsWith('/live')) : src;
      sende(res, 200, 'application/json', JSON.stringify({ live: !!live, hoerer: live ? live.listeners : 0 }));
    });
  }).on('error', () => sende(res, 200, 'application/json', '{"live":false,"hoerer":0}'));
}

// Es darf immer nur ein Sender aktiv sein; ein neuer verdrängt den alten.
let aktiv = null;
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, sock, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/hoer-ws') return wss.handleUpgrade(req, sock, head, (ws) => zuhoeren(ws, req));
  if (url.pathname !== '/ws' || url.searchParams.get('k') !== TOKEN) return sock.destroy();
  wss.handleUpgrade(req, sock, head, (ws) => verbinden(ws));
});

// Hörer per WebSocket: wird anders als ein HTTP-Strom im Cloudflare-Tunnel nicht gepuffert.
function zuhoeren(ws, req) {
  console.log('Hörer per WebSocket:', req.headers['user-agent']);
  const up = http.get(ICE + '/live', (ice) => {
    if (ice.statusCode !== 200) { ice.resume(); return ws.close(); }
    ice.on('data', (c) => { if (ws.readyState === 1 && ws.bufferedAmount < 256 * 1024) ws.send(c); });
    ice.on('end', () => ws.close());
  });
  up.on('error', () => ws.close());
  ws.on('close', () => up.destroy());
}

function verbinden(ws) {
  if (aktiv) aktiv.close(4000, 'verdraengt');
  aktiv = ws;
  const ff = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'warning',
    '-fflags', 'nobuffer', '-i', 'pipe:0',
    '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '64k',
    '-content_type', 'audio/mpeg', '-ice_name', 'Führungsfunk',
    '-f', 'mp3', `icecast://source:${ICE_PW}@127.0.0.1:8000/live`,
  ]);
  ff.stderr.on('data', (d) => console.error('ffmpeg:', d.toString().trim()));
  ff.stdin.on('error', () => {});
  ff.on('exit', (c) => { console.log('ffmpeg beendet', c); ws.close(); });
  // Messprotokoll: kommen die Daten vom Handy gleichmäßig an?
  let bytes = 0, letzte = Date.now(), groessteLuecke = 0;
  const mess = setInterval(() => { console.log('Sender: ' + (bytes / 1024).toFixed(1) + ' KB in 5 s, größte Lücke ' + groessteLuecke + ' ms'); bytes = 0; groessteLuecke = 0; }, 5000);
  ws.on('message', (chunk) => { const j = Date.now(); groessteLuecke = Math.max(groessteLuecke, j - letzte); letzte = j; bytes += chunk.length; ff.stdin.write(chunk); });
  ws.on('close', () => {
    clearInterval(mess);
    ff.stdin.end();
    setTimeout(() => ff.kill('SIGKILL'), 2000);
    if (aktiv === ws) aktiv = null;
  });
  console.log('Sender verbunden');
}

server.listen(PORT, () => console.log('Führungsfunk auf Port', PORT));
