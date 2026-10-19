// Audioguide – vorgesprochene Stationen (Ton, Text, bis zu 2 Fotos).
// Frank pflegt die Stationen und schaltet pro Führung eine Runde per QR-Code frei.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const DATEN = path.join(__dirname, 'daten');
const MEDIEN = path.join(DATEN, 'medien');
const STATIONEN = path.join(DATEN, 'stationen.json');
const RUNDEN = path.join(DATEN, 'runden.json');
fs.mkdirSync(MEDIEN, { recursive: true });

const ID = /^[0-9a-f]{12}$/;
const DATEI = /^[0-9a-f]{12}\.(mp3|jpg)$/;
const ZEICHEN = 'abcdefghjkmnpqrstuvwxyz23456789'; // ohne verwechselbare Zeichen
const MAX_FOTOS = 2;

const lies = (f, leer) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return leer; } };
const schreib = (f, d) => { fs.writeFileSync(f + '.tmp', JSON.stringify(d, null, 1)); fs.renameSync(f + '.tmp', f); };
const neueId = () => crypto.randomBytes(6).toString('hex');
const loesche = (datei) => { if (datei) fs.rm(path.join(MEDIEN, datei), { force: true }, () => {}); };

function json(res, code, daten) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(daten));
}

function koerper(req, max) {
  return new Promise((ok, fehler) => {
    const teile = []; let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > max) { fehler(new Error('Datei zu groß')); req.destroy(); } else teile.push(c);
    });
    req.on('end', () => ok(Buffer.concat(teile)));
    req.on('error', fehler);
  });
}

// Jede Aufnahme wird zu MP3 mit gleichmäßiger Lautstärke; das spielt jedes Handy ab.
function zuMp3(quelle, ziel) {
  return new Promise((ok, fehler) => execFile('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', quelle, '-vn', '-ac', '1', '-ar', '44100',
    '-af', 'loudnorm=I=-16:TP=-1.5', '-c:a', 'libmp3lame', '-b:a', '96k', ziel,
  ], (err) => (err ? fehler(err) : ok())));
}

// Ton- und Bilddateien mit Range-Unterstützung ausliefern (Safari braucht das für Audio).
function medium(req, res, datei) {
  const voll = path.join(MEDIEN, datei);
  fs.stat(voll, (err, st) => {
    if (err) { res.writeHead(404); return res.end(); }
    const typ = datei.endsWith('.mp3') ? 'audio/mpeg' : 'image/jpeg';
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const ende = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
      res.writeHead(206, { 'Content-Type': typ, 'Content-Range': `bytes ${start}-${ende}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': ende - start + 1, 'Cache-Control': 'private, max-age=3600' });
      return fs.createReadStream(voll, { start, end: ende }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': typ, 'Accept-Ranges': 'bytes', 'Content-Length': st.size, 'Cache-Control': 'private, max-age=3600' });
    fs.createReadStream(voll).pipe(res);
  });
}

module.exports = function guide(SCHLUESSEL, seite) {
  const istFrank = (req, url) => (req.headers['x-schluessel'] || url.searchParams.get('k')) === SCHLUESSEL;

  function runde(req) {
    const m = /(?:^|;\s*)runde=([a-z0-9]+)/.exec(req.headers.cookie || '');
    return m ? lies(RUNDEN, []).find((r) => r.code === m[1] && r.bis > Date.now()) : null;
  }

  return async function (req, res, url) {
    const p = url.pathname;
    const teile = p.split('/').filter(Boolean);

    // QR-Code der Runde: Cookie setzen, dann zur Stationsliste.
    if (teile[0] === 'g' && teile.length === 2) {
      const r = lies(RUNDEN, []).find((x) => x.code === teile[1] && x.bis > Date.now());
      const kopf = { Location: '/guide', 'Cache-Control': 'no-store' };
      if (r) {
        const sicher = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
        kopf['Set-Cookie'] = `runde=${r.code}; Max-Age=${Math.floor((r.bis - Date.now()) / 1000)}; Path=/; HttpOnly; SameSite=Lax${sicher}`;
      }
      res.writeHead(302, kopf);
      res.end();
      return true;
    }
    if (teile[0] !== 'guide') return false;

    if (p === '/guide') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(seite('guide.html')); return true; }
    if (p === '/guide/verwalten') {
      if (!istFrank(req, url)) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Kein Zugriff.'); return true; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(seite('verwalten.html')); return true;
    }

    const frank = istFrank(req, url);
    const r = frank ? null : runde(req);

    if (teile[1] === 'medien' && DATEI.test(teile[2] || '') && teile.length === 3) {
      if (!frank && !r) { res.writeHead(403); res.end(); return true; }
      medium(req, res, teile[2]);
      return true;
    }

    if (p === '/guide/api/stationen' && req.method === 'GET') {
      if (!frank && !r) return json(res, 403, { fehler: 'gesperrt' }), true;
      json(res, 200, { bis: r ? r.bis : null, stationen: lies(STATIONEN, []) });
      return true;
    }

    // Ab hier nur für Frank.
    if (teile[1] !== 'api') return false;
    if (!frank) return json(res, 403, { fehler: 'Kein Zugriff' }), true;

    try {
      const st = lies(STATIONEN, []);
      const id = teile[3];
      const s = ID.test(id || '') ? st.find((x) => x.id === id) : null;

      if (p === '/guide/api/station' && req.method === 'POST') {
        const neu = { id: neueId(), titel: 'Neue Station', text: '', audio: null, fotos: [] };
        st.push(neu); schreib(STATIONEN, st);
        return json(res, 200, neu), true;
      }
      if (teile[2] === 'station' && s && teile.length === 4) {
        if (req.method === 'PUT') {
          const d = JSON.parse((await koerper(req, 100000)).toString('utf8'));
          if (typeof d.titel === 'string') s.titel = d.titel.slice(0, 200);
          if (typeof d.text === 'string') s.text = d.text.slice(0, 20000);
          schreib(STATIONEN, st);
          return json(res, 200, s), true;
        }
        if (req.method === 'DELETE') {
          loesche(s.audio); s.fotos.forEach(loesche);
          schreib(STATIONEN, st.filter((x) => x !== s));
          return json(res, 200, { ok: true }), true;
        }
      }
      if (teile[2] === 'station' && s && teile[4] === 'audio' && req.method === 'PUT') {
        const roh = path.join(DATEN, 'upload-' + neueId());
        fs.writeFileSync(roh, await koerper(req, 60 * 1024 * 1024));
        const datei = neueId() + '.mp3';
        try { await zuMp3(roh, path.join(MEDIEN, datei)); } finally { fs.rm(roh, { force: true }, () => {}); }
        loesche(s.audio); s.audio = datei; schreib(STATIONEN, st);
        return json(res, 200, s), true;
      }
      if (teile[2] === 'station' && s && teile[4] === 'audio' && req.method === 'DELETE') {
        loesche(s.audio); s.audio = null; schreib(STATIONEN, st);
        return json(res, 200, s), true;
      }
      if (teile[2] === 'station' && s && teile[4] === 'foto' && req.method === 'POST') {
        if (s.fotos.length >= MAX_FOTOS) return json(res, 400, { fehler: `Höchstens ${MAX_FOTOS} Fotos` }), true;
        const daten = await koerper(req, 15 * 1024 * 1024);
        if (daten[0] !== 0xff || daten[1] !== 0xd8) return json(res, 400, { fehler: 'Kein JPEG' }), true;
        const datei = neueId() + '.jpg';
        fs.writeFileSync(path.join(MEDIEN, datei), daten);
        s.fotos.push(datei); schreib(STATIONEN, st);
        return json(res, 200, s), true;
      }
      if (teile[2] === 'station' && s && teile[4] === 'foto' && req.method === 'DELETE' && s.fotos.includes(teile[5])) {
        loesche(teile[5]); s.fotos = s.fotos.filter((f) => f !== teile[5]); schreib(STATIONEN, st);
        return json(res, 200, s), true;
      }
      if (p === '/guide/api/reihenfolge' && req.method === 'PUT') {
        const ids = JSON.parse((await koerper(req, 100000)).toString('utf8'));
        const neu = ids.map((i) => st.find((x) => x.id === i)).filter(Boolean);
        if (neu.length !== st.length) return json(res, 400, { fehler: 'Reihenfolge unvollständig' }), true;
        schreib(STATIONEN, neu);
        return json(res, 200, { ok: true }), true;
      }

      if (p === '/guide/api/runden' && req.method === 'GET') {
        return json(res, 200, lies(RUNDEN, []).filter((x) => x.bis > Date.now())), true;
      }
      if (p === '/guide/api/runde' && req.method === 'POST') {
        const d = JSON.parse((await koerper(req, 1000)).toString('utf8') || '{}');
        const stunden = Math.min(Math.max(Number(d.stunden) || 4, 1), 24 * 14);
        let code = '';
        for (const b of crypto.randomBytes(6)) code += ZEICHEN[b % ZEICHEN.length];
        const neu = { code, bis: Date.now() + stunden * 3600 * 1000 };
        schreib(RUNDEN, [...lies(RUNDEN, []).filter((x) => x.bis > Date.now()), neu]);
        return json(res, 200, neu), true;
      }
      if (teile[2] === 'runde' && teile.length === 4 && req.method === 'DELETE') {
        schreib(RUNDEN, lies(RUNDEN, []).filter((x) => x.code !== teile[3] && x.bis > Date.now()));
        return json(res, 200, { ok: true }), true;
      }
    } catch (e) {
      console.error('guide:', e.message);
      return json(res, 400, { fehler: e.message }), true;
    }
    json(res, 404, { fehler: 'Nicht gefunden' });
    return true;
  };
};
