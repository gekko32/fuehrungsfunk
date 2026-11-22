// Standortdaten dürfen nie gespeichert werden: Der Server entfernt bei jedem Bild alle Metadaten.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { ohneMetadaten } = require('../guide');

const sauber = fs.readFileSync(path.join(__dirname, 'testbild.jpg'));

function segment(marker, inhalt) {
  const daten = Buffer.isBuffer(inhalt) ? inhalt : Buffer.from(inhalt, 'latin1');
  const kopf = Buffer.alloc(4);
  kopf[0] = 0xff; kopf[1] = marker; kopf.writeUInt16BE(daten.length + 2, 2);
  return Buffer.concat([kopf, daten]);
}

// Testbild mit allem, was Standort oder persönliche Angaben tragen kann.
const VERDAECHTIG = ['Exif', 'GPSLatitude', '53.9581', 'ns.adobe.com/xap', 'Photoshop 3.0', 'Aufgenommen in Pötenitz', 'MotionPhoto', 'JFXX'];
function mitMetadaten() {
  const exif = segment(0xe1, 'Exif\0\0II*\0\x08\0\0\0GPSLatitude 53.9581 N GPSLongitude 10.8803 E');
  const xmp = segment(0xe1, 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><exif:GPSLatitude>53.9581</exif:GPSLatitude></x:xmpmeta>');
  const iptc = segment(0xed, 'Photoshop 3.0\0Ort: Priwall');
  const kommentar = segment(0xfe, 'Aufgenommen in Pötenitz');
  const jfxx = segment(0xe0, 'JFXX\0\x10Vorschaubild');
  const anhang = Buffer.from('MotionPhoto_Data GPSLatitude 53.9581', 'latin1');
  // Nach SOI einfügen, Rest des sauberen Bildes dahinter, Anhang hinter das Bildende.
  return Buffer.concat([sauber.subarray(0, 2), exif, xmp, iptc, kommentar, jfxx, sauber.subarray(2), anhang]);
}

const bilddaten = (b) => b.subarray(b.indexOf(Buffer.from([0xff, 0xda])));

test('ohneMetadaten entfernt EXIF/GPS, XMP, IPTC, Kommentare, Vorschaubild und Anhänge', () => {
  const vorher = mitMetadaten();
  for (const w of VERDAECHTIG) assert.ok(vorher.includes(Buffer.from(w, 'latin1')), 'Testbild enthält ' + w);
  const nachher = ohneMetadaten(vorher);
  for (const w of VERDAECHTIG) assert.ok(!nachher.includes(Buffer.from(w, 'latin1')), 'noch enthalten: ' + w);
  assert.ok(!nachher.includes(Buffer.from('Lavc', 'latin1')), 'Kommentar des Werkzeugs entfernt');
  // Bild bleibt ein gültiges JPEG mit unveränderten Bilddaten
  assert.deepStrictEqual([...nachher.subarray(0, 2)], [0xff, 0xd8]);
  assert.deepStrictEqual([...nachher.subarray(-2)], [0xff, 0xd9]);
  assert.ok(bilddaten(nachher).equals(bilddaten(sauber)), 'Bilddaten unverändert');
  assert.ok(nachher.includes(Buffer.from('JFIF\0', 'latin1')), 'JFIF-Kopf bleibt');
});

test('ohneMetadaten lehnt Nicht-JPEG und abgeschnittene Dateien ab', () => {
  assert.throws(() => ohneMetadaten(Buffer.from('GIF89a')), /Kein JPEG/);
  assert.throws(() => ohneMetadaten(sauber.subarray(0, sauber.length - 10)), /beschädigt/);
});

test('Hochgeladene Bilder werden ohne Metadaten gespeichert (Foto und Früher/Heute)', async () => {
  const daten = fs.mkdtempSync(path.join(os.tmpdir(), 'funk-meta-'));
  const port = 18290;
  const kind = spawn(process.execPath, [path.join(__dirname, '..', 'app.js')], {
    env: { ...process.env, PORT: String(port), ICECAST_SOURCE_PW: 'x', DATEN_DIR: daten, VERWALTUNG_EMAILS: 'chef@example.org', VERWALTUNG_PROXY_GEHEIMNIS: 'g' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((ok, fehler) => { kind.stdout.on('data', (d) => String(d).includes('Port') && ok()); kind.on('exit', fehler); });
    const kopf = { 'X-Forwarded-Email': 'chef@example.org', Authorization: 'Basic ' + Buffer.from('x:g').toString('base64') };
    const api = async (methode, pfad, body) => {
      const r = await fetch(`http://127.0.0.1:${port}/guide/api/${pfad}`, { method: methode, headers: kopf, body });
      assert.ok(r.ok, pfad + ' ' + r.status); return r.json();
    };
    const g = (await api('GET', 'guides'))[0];
    const s = await api('POST', 'station', JSON.stringify({ guide: g.id }));
    const foto = (await api('POST', `station/${s.id}/foto`, mitMetadaten())).fotos[0].datei;
    const frueher = (await api('PUT', `station/${s.id}/zeitreise/frueher`, mitMetadaten())).zeitreise.frueher.datei;
    for (const datei of [foto, frueher]) {
      const gespeichert = fs.readFileSync(path.join(daten, 'medien', datei));
      for (const w of VERDAECHTIG) assert.ok(!gespeichert.includes(Buffer.from(w, 'latin1')), `${datei}: noch enthalten ${w}`);
      assert.ok(bilddaten(gespeichert).equals(bilddaten(sauber)));
    }
    // Kaputtes JPEG wird abgelehnt, nichts gespeichert
    const r = await fetch(`http://127.0.0.1:${port}/guide/api/station/${s.id}/foto`, { method: 'POST', headers: kopf, body: sauber.subarray(0, 50) });
    assert.strictEqual(r.status, 400);
  } finally { kind.kill(); }
});
