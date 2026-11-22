// Legt einen Guide samt Stationen aus einem Inhaltsordner an (über die normale Schnittstelle).
//
//   SENDE_TOKEN=... node werkzeuge/guide-import.js https://funk.mentolder.de ORDNER
//
// ORDNER/guide.json:
//   { "titel": "...", "beschreibung": "...",
//     "stationen": [ { "titel": "...", "quelle": "...", "text": "...",
//                      "fotos": [ { "datei": "bilder/x.jpg", "text": "Bildunterschrift" } ],
//                      "zeitreise": { "frueher": { "datei": "...", "text": "..." }, "heute": { ... } },
//                      "ton": { "ki": "ton/01.mp3", "sprecher": "ton/01-frank.mp3" } } ] }
// Bilder müssen JPEG sein. Gibt es schon einen Guide mit demselben Titel, bricht das Werkzeug ab.
const fs = require('fs');
const path = require('path');

const [basis, ordner] = process.argv.slice(2);
const token = process.env.SENDE_TOKEN;
if (!basis || !ordner || !token) { console.error('Aufruf: SENDE_TOKEN=... node guide-import.js BASIS-URL ORDNER'); process.exit(1); }

async function api(methode, pfad, body, typ) {
  const r = await fetch(basis.replace(/\/$/, '') + '/guide/api/' + pfad, { method: methode, headers: { 'X-Schluessel': token, ...(typ ? { 'Content-Type': typ } : {}) }, body });
  const d = await r.json();
  if (!r.ok) throw new Error(pfad + ': ' + (d.fehler || r.status));
  return d;
}
const datei = (p) => fs.readFileSync(path.join(ordner, p));
const text = (t) => '?text=' + encodeURIComponent(t || '');

(async () => {
  const inhalt = JSON.parse(fs.readFileSync(path.join(ordner, 'guide.json'), 'utf8'));
  const vorhanden = await api('GET', 'guides');
  if (vorhanden.some((g) => g.titel === inhalt.titel)) throw new Error(`Guide „${inhalt.titel}“ gibt es schon – erst löschen oder Titel ändern.`);

  const g = await api('POST', 'guide', JSON.stringify({ titel: inhalt.titel, beschreibung: inhalt.beschreibung || '' }), 'application/json');
  console.log('Guide angelegt:', g.titel, g.id);
  for (const [i, s] of inhalt.stationen.entries()) {
    const neu = await api('POST', 'station', JSON.stringify({ guide: g.id }), 'application/json');
    await api('PUT', 'station/' + neu.id, JSON.stringify({ titel: s.titel, text: s.text, quelle: s.quelle || '' }), 'application/json');
    for (const f of s.fotos || []) await api('POST', 'station/' + neu.id + '/foto' + text(f.text), datei(f.datei), 'image/jpeg');
    for (const seite of ['frueher', 'heute']) {
      const b = s.zeitreise && s.zeitreise[seite];
      if (b) await api('PUT', 'station/' + neu.id + '/zeitreise/' + seite + text(b.text), datei(b.datei), 'image/jpeg');
    }
    for (const stimme of ['ki', 'sprecher']) {
      const t = s.ton && s.ton[stimme];
      if (t) await api('PUT', 'station/' + neu.id + '/ton/' + stimme, datei(t), 'audio/mpeg');
    }
    console.log(`  ${i + 1}. ${s.titel}`);
  }
  console.log('Fertig. Vorschau:', basis.replace(/\/$/, '') + '/guide?g=' + g.id + '&k=…');
})().catch((e) => { console.error('Abbruch:', e.message); process.exit(1); });
