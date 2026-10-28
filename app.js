// Führungsfunk – Live-Audio vom Guide-Handy an die Handys der Gruppe.
// Sender (Browser, MediaRecorder) -> WebSocket -> ffmpeg -> (a) AAC in fragmentiertem MP4 -> /hoer-mp4
// (MediaSource, Chrome/Firefox/Safari) und (b) MP3 -> Icecast -> /hoer-ws bzw. /stream (Rückfall).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8090);
const TOKEN = process.env.SENDE_TOKEN;            // geheimer Teil des Sende-Links
const ICE_PW = process.env.ICECAST_SOURCE_PW;
const ICE = 'http://127.0.0.1:8000';
if (!TOKEN || !ICE_PW) { console.error('SENDE_TOKEN und ICECAST_SOURCE_PW fehlen'); process.exit(1); }

const seite = (name) => fs.readFileSync(path.join(__dirname, name));

// Hörcode je Führung (wie die Runden des Audioguides): Der QR-Code enthält /h/CODE, das setzt
// ein Cookie bis zum Ablauf. Hören geht nur mit dem aktuellen, gültigen Code; ein neuer Code
// oder der Ablauf beendet alte Hörer. Gespeichert in daten/ (bleibt bei Neustarts erhalten).
const FUNK = path.join(__dirname, 'daten', 'funk-runde.json');
const ZEICHEN = 'abcdefghjkmnpqrstuvwxyz23456789';
fs.mkdirSync(path.dirname(FUNK), { recursive: true });
const funkRunde = () => { try { const r = JSON.parse(fs.readFileSync(FUNK, 'utf8')); return r.bis > Date.now() ? r : null; } catch { return null; } };
function hoerCode(req) {
  const m = /(?:^|;\s*)funk=([a-z0-9]+)/.exec(req.headers.cookie || '');
  const r = funkRunde();
  return m && r && m[1] === r.code ? r.code : null;
}
const alleHoerer = new Set(); // { code, schliessen }
function alteBeenden() {
  const r = funkRunde();
  for (const h of alleHoerer) if (!r || h.code !== r.code) h.schliessen();
}
setInterval(alteBeenden, 30000);
const ZU = '<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Führung hören</title><style>body{margin:0;background:#f6f4ef;color:#1f2421;font:18px/1.45 system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;text-align:center}@media (prefers-color-scheme:dark){body{background:#161917;color:#ecefea}}main{max-width:420px}</style></head><body><main><h1>Führung hören</h1><p>Diese Führung ist beendet oder der QR-Code ist nicht mehr gültig.</p><p>Bitte den QR-Code der aktuellen Führung scannen.</p></main></body></html>';
const guide = require('./guide')(TOKEN, seite);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (await guide(req, res, url)) return;
  const hp = /^\/h\/([a-z0-9]+)$/.exec(url.pathname);
  if (hp) {
    const rd = funkRunde(), kopf = { Location: '/', 'Cache-Control': 'no-store' };
    if (rd && rd.code === hp[1]) {
      const sicher = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      kopf['Set-Cookie'] = `funk=${rd.code}; Max-Age=${Math.floor((rd.bis - Date.now()) / 1000)}; Path=/; HttpOnly; SameSite=Lax${sicher}`;
    }
    res.writeHead(302, kopf); return res.end();
  }
  if (url.pathname === '/') return hoerCode(req) ? sende(res, 200, 'text/html; charset=utf-8', seite('hoeren.html')) : sende(res, 200, 'text/html; charset=utf-8', ZU);
  if (url.pathname === '/funk-runde') {
    if (url.searchParams.get('k') !== TOKEN) return sende(res, 403, 'text/plain; charset=utf-8', 'Kein Zugriff.');
    if (req.method === 'POST') {
      const stunden = Math.min(72, Math.max(1, Number(url.searchParams.get('stunden')) || 4));
      let code = ''; for (const b of crypto.randomBytes(6)) code += ZEICHEN[b % ZEICHEN.length];
      const neu = { code, bis: Date.now() + stunden * 3600 * 1000 };
      fs.writeFileSync(FUNK + '.tmp', JSON.stringify(neu)); fs.renameSync(FUNK + '.tmp', FUNK);
      alteBeenden();
      return sende(res, 200, 'application/json', JSON.stringify(neu));
    }
    return sende(res, 200, 'application/json', JSON.stringify(funkRunde()));
  }
  if (url.pathname === '/senden') {
    if (url.searchParams.get('k') !== TOKEN) return sende(res, 403, 'text/plain; charset=utf-8', 'Kein Zugriff.');
    return sende(res, 200, 'text/html; charset=utf-8', seite('senden.html'));
  }
  if (url.pathname === '/stream') { const c = hoerCode(req); return c ? streamWeiterleiten(req, res, c) : sende(res, 403, 'text/plain; charset=utf-8', 'Kein gültiger Hörcode.'); }
  if (url.pathname === '/status') return status(res, !!hoerCode(req));
  sende(res, 404, 'text/plain; charset=utf-8', 'Nicht gefunden.');
});

function sende(res, code, typ, body) {
  res.writeHead(code, { 'Content-Type': typ, 'Cache-Control': 'no-store' });
  res.end(body);
}

// Icecast lauscht nur lokal; die Hörer bekommen den Strom über diesen Server.
function streamWeiterleiten(req, res, code) {
  console.log('Hörer per HTTP:', req.headers['user-agent']);
  const h = { code, schliessen: () => res.destroy() };
  alleHoerer.add(h); res.on('close', () => alleHoerer.delete(h));
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

function zuhoerenMp4(ws, req, code) {
  console.log('Hörer per MP4:', req.headers['user-agent']);
  const h = { ws, init: false, code, schliessen: () => ws.close(4002, 'Führung beendet') };
  if (initSeg) { ws.send(initSeg); h.init = true; }
  mp4Hoerer.add(h); alleHoerer.add(h);
  ws.on('close', () => { mp4Hoerer.delete(h); alleHoerer.delete(h); });
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

function status(res, zugang) {
  http.get(ICE + '/status-json.xsl', (r) => {
    let d = '';
    r.on('data', (c) => (d += c));
    r.on('end', () => {
      let src;
      try { src = JSON.parse(d).icestats.source; } catch { src = null; }
      const live = Array.isArray(src) ? src.find((s) => s.listenurl.endsWith('/live')) : src;
      sende(res, 200, 'application/json', JSON.stringify({ zugang, live: !!live, hoerer: (live ? live.listeners : 0) + mp4Hoerer.size }));
    });
  }).on('error', () => sende(res, 200, 'application/json', JSON.stringify({ zugang, live: false, hoerer: 0 })));
}

// Es darf immer nur ein Sender aktiv sein; ein neuer verdrängt den alten.
let aktiv = null;
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, sock, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/hoer-mp4' || url.pathname === '/hoer-ws') {
    const code = hoerCode(req);
    if (!code) return sock.destroy();
    const ziel = url.pathname === '/hoer-mp4' ? zuhoerenMp4 : zuhoeren;
    return wss.handleUpgrade(req, sock, head, (ws) => ziel(ws, req, code));
  }
  if (url.pathname !== '/ws' || url.searchParams.get('k') !== TOKEN) return sock.destroy();
  wss.handleUpgrade(req, sock, head, (ws) => verbinden(ws));
});

// Hörer per WebSocket: wird anders als ein HTTP-Strom im Cloudflare-Tunnel nicht gepuffert.
function zuhoeren(ws, req, code) {
  console.log('Hörer per WebSocket:', req.headers['user-agent']);
  const h = { code, schliessen: () => ws.close(4002, 'Führung beendet') };
  alleHoerer.add(h); ws.on('close', () => alleHoerer.delete(h));
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
  // Neuer Sender = neues Init-Segment. Wer schon auf den Start wartet, bekommt es mit dem ersten
  // Fragment; nur Hörer mit der alten Sendung im Puffer trennen (Code 4001: sofort neu verbinden).
  initSeg = null;
  for (const h of mp4Hoerer) if (h.init) h.ws.close(4001, 'neue Sendung');
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
