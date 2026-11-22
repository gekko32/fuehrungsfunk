// Audioguide – mehrere Guides mit vorgesprochenen Stationen (Ton, Text, Fotos, Früher/Heute).
// Frank pflegt die Guides und schaltet pro Führung eine Runde für genau einen Guide per QR-Code frei.
//
// Datenmodell (daten/):
//   guides.json    [{ id, titel, beschreibung }]
//   stationen.json [{ id, guide, titel, text, quelle,
//                     ton: { sprecher, ki },              // MP3-Dateien; sprecher = Originalstimme
//                     fotos: [{ datei, text }],           // Bildunterschrift je Foto
//                     zeitreise: { art, frueher, heute } }] // art 'bild' (Schieberegler), später 'panorama'
//   runden.json    [{ code, bis, guide, art }]               // art 'qr'; später z. B. 'buchung'
//
// Wege: Teilnehmer nur mit Rundencode (Cookie) unter /g/…, /guide, /guide/api/stationen,
// /guide/medien/…; dort wird die Anmeldung nie ausgewertet. Gerald (angemeldet über den
// Vorschalter) pflegt unter /guide/verwalten und /guide/api/…, Vorschau unter /guide/vorschau.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

let DATEN, MEDIEN, GUIDES, STATIONEN, RUNDEN;

const ID = /^[0-9a-f]{12}$/;
const DATEI = /^[0-9a-f]{12}\.(mp3|jpg)$/;
const ZEICHEN = 'abcdefghjkmnpqrstuvwxyz23456789'; // ohne verwechselbare Zeichen
const MAX_FOTOS = 3;
const STIMMEN = ['sprecher', 'ki'];
const SEITEN = ['frueher', 'heute'];

const lies = (f, leer) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return leer; } };
const schreib = (f, d) => { fs.writeFileSync(f + '.tmp', JSON.stringify(d, null, 1)); fs.renameSync(f + '.tmp', f); };
const neueId = () => crypto.randomBytes(6).toString('hex');
const loesche = (datei) => { if (datei) fs.rm(path.join(MEDIEN, datei), { force: true }, () => {}); };
const leereZeitreise = () => ({ art: 'bild', frueher: null, heute: null });

// Ältere Daten (ein Guide, Feld audio, Fotos als Dateinamen) einmalig ins neue Modell überführen.
function aufraeumen() {
  let guides = lies(GUIDES, null);
  const st = lies(STATIONEN, []);
  const runden = lies(RUNDEN, []);
  if (!Array.isArray(guides) || !guides.length) guides = [{ id: neueId(), titel: 'Audioguide', beschreibung: '' }];
  const erster = guides[0].id;
  for (const s of st) {
    if (!s.guide || !guides.some((g) => g.id === s.guide)) s.guide = erster;
    if (!s.ton) s.ton = { sprecher: s.audio || null, ki: null };
    delete s.audio;
    s.fotos = (s.fotos || []).map((f) => (typeof f === 'string' ? { datei: f, text: '' } : f));
    if (!s.zeitreise) s.zeitreise = leereZeitreise();
    if (typeof s.quelle !== 'string') s.quelle = '';
  }
  for (const r of runden) { if (!r.guide) r.guide = erster; if (!r.art) r.art = 'qr'; }
  schreib(GUIDES, guides); schreib(STATIONEN, st); schreib(RUNDEN, runden);
}

const dateienVon = (s) => [s.ton.sprecher, s.ton.ki, ...s.fotos.map((f) => f.datei),
  s.zeitreise.frueher && s.zeitreise.frueher.datei, s.zeitreise.heute && s.zeitreise.heute.datei].filter(Boolean);

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
const jsonKoerper = async (req) => JSON.parse((await koerper(req, 200000)).toString('utf8') || '{}');

// Jede Aufnahme wird zu MP3 mit gleichmäßiger Lautstärke; das spielt jedes Handy ab.
function zuMp3(quelle, ziel) {
  return new Promise((ok, fehler) => execFile('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', quelle, '-vn', '-ac', '1', '-ar', '44100',
    '-af', 'loudnorm=I=-16:TP=-1.5', '-c:a', 'libmp3lame', '-b:a', '96k', ziel,
  ], (err) => (err ? fehler(err) : ok())));
}

async function jpegSpeichern(req) {
  const daten = await koerper(req, 15 * 1024 * 1024);
  if (daten[0] !== 0xff || daten[1] !== 0xd8) throw new Error('Kein JPEG');
  const datei = neueId() + '.jpg';
  fs.writeFileSync(path.join(MEDIEN, datei), daten);
  return datei;
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

module.exports = function guide(istVerwaltung, seite, daten) {
  DATEN = daten; MEDIEN = path.join(DATEN, 'medien');
  GUIDES = path.join(DATEN, 'guides.json'); STATIONEN = path.join(DATEN, 'stationen.json'); RUNDEN = path.join(DATEN, 'runden.json');
  fs.mkdirSync(MEDIEN, { recursive: true });
  aufraeumen();

  function runde(req) {
    const m = /(?:^|;\s*)runde=([a-z0-9]+)/.exec(req.headers.cookie || '');
    return m ? lies(RUNDEN, []).find((r) => r.code === m[1] && r.bis > Date.now()) : null;
  }
  const html = (res, name) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(seite(name)); };

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

    const guides = lies(GUIDES, []);
    const stationenVon = (gid) => lies(STATIONEN, []).filter((s) => s.guide === gid);
    const ausliefern = (gid, bis) => {
      const g = guides.find((x) => x.id === gid);
      if (!g) return json(res, 404, { fehler: 'Guide nicht gefunden' }), true;
      return json(res, 200, { guide: g, bis, stationen: stationenVon(gid) }), true;
    };

    // ---------- Teilnehmer: nur mit gültiger Runde ----------
    if (p === '/guide') { html(res, 'guide.html'); return true; }
    if (p === '/guide/api/stationen' && req.method === 'GET') {
      const r = runde(req);
      if (!r) return json(res, 403, { fehler: 'gesperrt' }), true;
      return ausliefern(r.guide, r.bis);
    }
    if (teile[1] === 'medien' && teile.length === 3) {
      const r = runde(req);
      const ok = r && DATEI.test(teile[2]) && stationenVon(r.guide).some((s) => dateienVon(s).includes(teile[2]));
      if (!ok) { res.writeHead(403); res.end(); return true; }
      medium(req, res, teile[2]);
      return true;
    }

    // ---------- Ab hier nur Verwaltung (Anmeldung über den Vorschalter) ----------
    if (!istVerwaltung(req)) {
      if (teile[1] === 'api' || teile[1] === 'vorschau') return json(res, 403, { fehler: 'Kein Zugriff' }), true;
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Kein Zugriff.'); return true;
    }
    if (p === '/guide/verwalten') { html(res, 'verwalten.html'); return true; }
    if (p === '/guide/vorschau') { html(res, 'guide.html'); return true; }
    if (p === '/guide/vorschau/api/stationen' && req.method === 'GET') {
      return ausliefern(url.searchParams.get('g') || (guides[0] || {}).id, null);
    }
    if (teile[1] === 'vorschau' && teile[2] === 'medien' && DATEI.test(teile[3] || '') && teile.length === 4) {
      medium(req, res, teile[3]);
      return true;
    }
    if (teile[1] !== 'api') { json(res, 404, { fehler: 'Nicht gefunden' }); return true; }

    try {
      const st = lies(STATIONEN, []);
      const id = teile[3];

      // ---------- Guides ----------
      if (p === '/guide/api/guides' && req.method === 'GET') {
        return json(res, 200, guides.map((g) => ({ ...g, anzahl: st.filter((s) => s.guide === g.id).length }))), true;
      }
      if (p === '/guide/api/guide' && req.method === 'POST') {
        const d = await jsonKoerper(req);
        const neu = { id: neueId(), titel: String(d.titel || 'Neuer Guide').slice(0, 200), beschreibung: String(d.beschreibung || '').slice(0, 2000) };
        schreib(GUIDES, [...guides, neu]);
        return json(res, 200, neu), true;
      }
      const g = teile[2] === 'guide' && ID.test(id || '') ? guides.find((x) => x.id === id) : null;
      if (g && teile.length === 4 && req.method === 'PUT') {
        const d = await jsonKoerper(req);
        if (typeof d.titel === 'string') g.titel = d.titel.slice(0, 200);
        if (typeof d.beschreibung === 'string') g.beschreibung = d.beschreibung.slice(0, 2000);
        schreib(GUIDES, guides);
        return json(res, 200, g), true;
      }
      if (g && teile.length === 4 && req.method === 'DELETE') {
        if (guides.length === 1) return json(res, 400, { fehler: 'Der letzte Guide bleibt bestehen' }), true;
        st.filter((s) => s.guide === g.id).forEach((s) => dateienVon(s).forEach(loesche));
        schreib(STATIONEN, st.filter((s) => s.guide !== g.id));
        schreib(GUIDES, guides.filter((x) => x !== g));
        schreib(RUNDEN, lies(RUNDEN, []).filter((x) => x.guide !== g.id));
        return json(res, 200, { ok: true }), true;
      }

      // ---------- Stationen ----------
      const s = teile[2] === 'station' && ID.test(id || '') ? st.find((x) => x.id === id) : null;

      if (p === '/guide/api/station' && req.method === 'POST') {
        const d = await jsonKoerper(req);
        if (!guides.some((x) => x.id === d.guide)) return json(res, 400, { fehler: 'Unbekannter Guide' }), true;
        const neu = { id: neueId(), guide: d.guide, titel: 'Neue Station', text: '', quelle: '', ton: { sprecher: null, ki: null }, fotos: [], zeitreise: leereZeitreise() };
        st.push(neu); schreib(STATIONEN, st);
        return json(res, 200, neu), true;
      }
      if (s && teile.length === 4) {
        if (req.method === 'PUT') {
          const d = await jsonKoerper(req);
          if (typeof d.titel === 'string') s.titel = d.titel.slice(0, 200);
          if (typeof d.text === 'string') s.text = d.text.slice(0, 20000);
          if (typeof d.quelle === 'string') s.quelle = d.quelle.slice(0, 500);
          // Bildunterschriften: { datei: text } für Fotos und Früher/Heute-Bilder
          if (d.bildtexte && typeof d.bildtexte === 'object') {
            for (const bild of [...s.fotos, s.zeitreise.frueher, s.zeitreise.heute].filter(Boolean)) {
              if (typeof d.bildtexte[bild.datei] === 'string') bild.text = d.bildtexte[bild.datei].slice(0, 500);
            }
          }
          schreib(STATIONEN, st);
          return json(res, 200, s), true;
        }
        if (req.method === 'DELETE') {
          dateienVon(s).forEach(loesche);
          schreib(STATIONEN, st.filter((x) => x !== s));
          return json(res, 200, { ok: true }), true;
        }
      }
      // Ton: /station/ID/ton/sprecher oder /station/ID/ton/ki
      if (s && teile[4] === 'ton' && STIMMEN.includes(teile[5]) && teile.length === 6) {
        const stimme = teile[5];
        if (req.method === 'PUT') {
          const roh = path.join(DATEN, 'upload-' + neueId());
          fs.writeFileSync(roh, await koerper(req, 60 * 1024 * 1024));
          const datei = neueId() + '.mp3';
          try { await zuMp3(roh, path.join(MEDIEN, datei)); } finally { fs.rm(roh, { force: true }, () => {}); }
          loesche(s.ton[stimme]); s.ton[stimme] = datei; schreib(STATIONEN, st);
          return json(res, 200, s), true;
        }
        if (req.method === 'DELETE') {
          loesche(s.ton[stimme]); s.ton[stimme] = null; schreib(STATIONEN, st);
          return json(res, 200, s), true;
        }
      }
      if (s && teile[4] === 'foto' && req.method === 'POST' && teile.length === 5) {
        if (s.fotos.length >= MAX_FOTOS) return json(res, 400, { fehler: `Höchstens ${MAX_FOTOS} Fotos` }), true;
        const datei = await jpegSpeichern(req);
        s.fotos.push({ datei, text: String(url.searchParams.get('text') || '').slice(0, 500) }); schreib(STATIONEN, st);
        return json(res, 200, s), true;
      }
      if (s && teile[4] === 'foto' && req.method === 'DELETE' && s.fotos.some((f) => f.datei === teile[5])) {
        loesche(teile[5]); s.fotos = s.fotos.filter((f) => f.datei !== teile[5]); schreib(STATIONEN, st);
        return json(res, 200, s), true;
      }
      // Früher/Heute: /station/ID/zeitreise/frueher oder /heute
      if (s && teile[4] === 'zeitreise' && SEITEN.includes(teile[5]) && teile.length === 6) {
        const seite = teile[5];
        if (req.method === 'PUT') {
          const datei = await jpegSpeichern(req);
          if (s.zeitreise[seite]) loesche(s.zeitreise[seite].datei);
          s.zeitreise[seite] = { datei, text: String(url.searchParams.get('text') || '').slice(0, 500) };
          schreib(STATIONEN, st);
          return json(res, 200, s), true;
        }
        if (req.method === 'DELETE') {
          if (s.zeitreise[seite]) loesche(s.zeitreise[seite].datei);
          s.zeitreise[seite] = null; schreib(STATIONEN, st);
          return json(res, 200, s), true;
        }
      }
      if (p === '/guide/api/reihenfolge' && req.method === 'PUT') {
        const d = await jsonKoerper(req);
        const eigene = st.filter((x) => x.guide === d.guide);
        const neu = (d.ids || []).map((i) => eigene.find((x) => x.id === i)).filter(Boolean);
        if (!eigene.length || neu.length !== eigene.length) return json(res, 400, { fehler: 'Reihenfolge unvollständig' }), true;
        schreib(STATIONEN, [...st.filter((x) => x.guide !== d.guide), ...neu]);
        return json(res, 200, { ok: true }), true;
      }

      // ---------- Runden ----------
      if (p === '/guide/api/runden' && req.method === 'GET') {
        return json(res, 200, lies(RUNDEN, []).filter((x) => x.bis > Date.now())), true;
      }
      if (p === '/guide/api/runde' && req.method === 'POST') {
        const d = await jsonKoerper(req);
        if (!guides.some((x) => x.id === d.guide)) return json(res, 400, { fehler: 'Unbekannter Guide' }), true;
        const stunden = Math.min(Math.max(Number(d.stunden) || 4, 1), 24 * 14);
        let code = '';
        for (const b of crypto.randomBytes(6)) code += ZEICHEN[b % ZEICHEN.length];
        const neu = { code, bis: Date.now() + stunden * 3600 * 1000, guide: d.guide, art: 'qr' };
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
