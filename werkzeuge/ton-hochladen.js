// Tondateien der Reihe nach an die Stationen eines Guides hängen (01.* -> Station 1 usw.).
//
//   ALS=adresse GEHEIMNIS=... node werkzeuge/ton-hochladen.js BASIS-URL GUIDE-ID ORDNER [ki|sprecher]
//
// Wie guide-import.js: spricht die App direkt an (im Pod oder per port-forward), Kopffelder wie
// der Anmelde-Vorschalter. Dateien: NN.mp3 oder NN.wav (zweistellig). Standard-Stimme: ki.
// Vorhandene Tonspur derselben Stimme wird ersetzt; fehlt eine Datei, bleibt die Station unverändert.
const fs = require('fs');
const path = require('path');

const [basis, guideId, ordner, stimme = 'ki'] = process.argv.slice(2);
const { ALS: als, GEHEIMNIS: geheimnis } = process.env;
if (!basis || !guideId || !ordner || !als || !geheimnis || !['ki', 'sprecher'].includes(stimme)) {
  console.error('Aufruf: ALS=adresse GEHEIMNIS=... node ton-hochladen.js BASIS-URL GUIDE-ID ORDNER [ki|sprecher]');
  process.exit(1);
}
const kopf = { 'X-Forwarded-Email': als, Authorization: 'Basic ' + Buffer.from('ton:' + geheimnis).toString('base64') };

(async () => {
  const r = await fetch(`${basis}/guide/vorschau/api/stationen?g=${guideId}`, { headers: kopf });
  if (!r.ok) throw new Error('Stationen nicht lesbar: ' + r.status);
  const { guide, stationen } = await r.json();
  console.log(`Guide „${guide.titel}“, ${stationen.length} Stationen, Stimme ${stimme}`);
  const dateien = fs.readdirSync(ordner);
  for (const [i, s] of stationen.entries()) {
    const nr = String(i + 1).padStart(2, '0');
    const datei = dateien.find((d) => d === nr + '.mp3') || dateien.find((d) => d === nr + '.wav');
    if (!datei) { console.log(`  ${nr} ${s.titel}: keine Datei, übersprungen`); continue; }
    const antwort = await fetch(`${basis}/guide/api/station/${s.id}/ton/${stimme}`, {
      method: 'PUT', headers: { ...kopf, 'Content-Type': 'application/octet-stream' }, body: fs.readFileSync(path.join(ordner, datei)),
    });
    if (!antwort.ok) throw new Error(`${nr}: ${antwort.status} ${await antwort.text()}`);
    console.log(`  ${nr} ${s.titel}: ${datei} hochgeladen`);
  }
})().catch((e) => { console.error('Abbruch:', e.message); process.exit(1); });
