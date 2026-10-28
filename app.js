// Führungsfunk – Live-Audio vom Guide-Handy an die Handys der Gruppe.
// Sender (Browser, MediaRecorder) -> WebSocket -> ffmpeg -> (a) AAC in fragmentiertem MP4 -> /hoer-mp4
// (MediaSource, Chrome/Firefox/Safari) und (b) MP3 -> Icecast -> /hoer-ws bzw. /stream (Rückfall).
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

// Hörer des MP4-Wegs. Neue Hörer bekommen zuerst das Init-Segment (ftyp+moov), danach jedes
// Fragment (moof+mdat). Bei AAC ist jedes Fragment ein Einstiegspunkt.
const mp4Hoerer = new Set();
let initSeg = null;

function zuhoerenMp4(ws, req) {
  console.log('Hörer per MP4:', req.headers['user-agent']);
  const h = { ws, init: false };
  if (initSeg) { ws.send(initSeg); h.init = true; }
  mp4Hoerer.add(h);
  ws.on('close', () => mp4Hoerer.delete(h));
}

// Zerlegt die MP4-Ausgabe von ffmpeg in Boxen und verteilt sie.
function mp4Verteiler() {
  let rest = Buffer.alloc(0), ftyp = null, moof = null;
  return (chunk) => {
    rest = Buffer.concat([rest, chunk]);
    while (rest.length >= 8) {
      let groesse = rest.readUInt32BE(0);
      const typ = rest.toString('latin1', 4, 8);
      if (groesse === 1) { if (rest.length < 16) break; groesse = Number(rest.readBigUInt64BE(8)); }
      if (groesse < 8) { rest = Buffer.alloc(0); break; }
      if (rest.length < groesse) break;
      const box = Buffer.from(rest.subarray(0, groesse));
      rest = rest.subarray(groesse);
      if (typ === 'ftyp') ftyp = box;
      else if (typ === 'moov') initSeg = Buffer.concat([ftyp || Buffer.alloc(0), box]);
      else if (typ === 'moof') moof = box;
      else if (typ === 'mdat' && moof && initSeg) {
        const frag = Buffer.concat([moof, box]); moof = null;
        for (const h of mp4Hoerer) {
          if (h.ws.readyState !== 1) continue;
          if (!h.init) { h.ws.send(initSeg); h.init = true; }
          if (h.ws.bufferedAmount < 256 * 1024) h.ws.send(frag);
        }
      }
    }
  };
}

function status(res) {
  http.get(ICE + '/status-json.xsl', (r) => {
    let d = '';
    r.on('data', (c) => (d += c));
    r.on('end', () => {
      let src;
      try { src = JSON.parse(d).icestats.source; } catch { src = null; }
      const live = Array.isArray(src) ? src.find((s) => s.listenurl.endsWith('/live')) : src;
      sende(res, 200, 'application/json', JSON.stringify({ live: !!live, hoerer: (live ? live.listeners : 0) + mp4Hoerer.size }));
    });
  }).on('error', () => sende(res, 200, 'application/json', '{"live":false,"hoerer":0}'));
}

// Es darf immer nur ein Sender aktiv sein; ein neuer verdrängt den alten.
let aktiv = null;
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, sock, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/hoer-mp4') return wss.handleUpgrade(req, sock, head, (ws) => zuhoerenMp4(ws, req));
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
  // Neuer Sender = neues Init-Segment: MP4-Hörer trennen, sie verbinden sich nach 2 s neu.
  initSeg = null;
  for (const h of mp4Hoerer) h.ws.close(4001, 'neue Sendung');
  const ff = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'warning',
    '-fflags', 'nobuffer', '-i', 'pipe:0',
    // (b) MP3 an Icecast (Rückfallweg)
    '-map', '0:a', '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '64k',
    '-content_type', 'audio/mpeg', '-ice_name', 'Führungsfunk',
    '-f', 'mp3', `icecast://source:${ICE_PW}@127.0.0.1:8000/live`,
    // (a) AAC als fragmentiertes MP4, Fragmente von 0,2 s, für alle Browser per MediaSource
    '-map', '0:a', '-ac', '1', '-ar', '44100', '-c:a', 'aac', '-b:a', '64k',
    '-f', 'mp4', '-movflags', 'empty_moov+default_base_moof+skip_trailer',
    '-frag_duration', '200000', '-flush_packets', '1', 'pipe:1',
  ]);
  ff.stdout.on('data', mp4Verteiler());
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
