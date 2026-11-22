// Rechte und Trennung (SPEZ-FUNK-AUDIOGUIDE K5–K8, K18, K19, K26, K27).
// Startet die App mit eigenem Datenordner; Icecast läuft dabei nicht (wird hier nicht gebraucht).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const CHEF = 'chef@example.org';
let port = 18190;

async function starte(env, vorher) {
  const daten = fs.mkdtempSync(path.join(os.tmpdir(), 'funk-test-'));
  if (vorher) vorher(daten);
  const p = port++;
  const kind = spawn(process.execPath, [path.join(__dirname, '..', 'app.js')], {
    env: { ...process.env, PORT: String(p), ICECAST_SOURCE_PW: 'x', DATEN_DIR: daten, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((ok, fehler) => {
    kind.stdout.on('data', (d) => { if (String(d).includes('Port')) ok(); });
    kind.on('exit', (c) => fehler(new Error('App beendet: ' + c)));
  });
  const basis = `http://127.0.0.1:${p}`;
  const hol = (pfad, opt = {}) => fetch(basis + pfad, { redirect: 'manual', ...opt });
  const alsChef = (pfad, opt = {}) => hol(pfad, { ...opt, headers: { 'X-Forwarded-Email': CHEF, ...(opt.headers || {}) } });
  return { basis, daten, hol, alsChef, ende: () => kind.kill() };
}

const VERWALTUNGSWEGE = ['/senden', '/funk-runde', '/guide/verwalten', '/guide/vorschau', '/guide/vorschau/api/stationen', '/guide/api/guides', '/guide/api/runden'];
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

test('Verwaltung: ohne Anmeldung, mit fremder Adresse und mit Verwalter', async () => {
  const a = await starte({ VERWALTUNG_EMAILS: ` ${CHEF} ,zweite@example.org` });
  try {
    for (const w of VERWALTUNGSWEGE) {
      assert.strictEqual((await a.hol(w)).status, 403, 'ohne Anmeldung ' + w);
      assert.strictEqual((await a.hol(w, { headers: { 'X-Forwarded-Email': 'fremd@example.org' } })).status, 403, 'fremd ' + w);
      assert.strictEqual((await a.alsChef(w)).status, 200, 'Verwalter ' + w);
    }
    // Groß-/Kleinschreibung egal, zweiter Eintrag der Liste gilt auch
    assert.strictEqual((await a.hol('/senden', { headers: { 'X-Forwarded-Email': 'CHEF@Example.org' } })).status, 200);
    assert.strictEqual((await a.hol('/senden', { headers: { 'X-Forwarded-Email': 'zweite@example.org' } })).status, 200);
    // Alter Weg mit Schlüssel in der Adresse öffnet nichts mehr (K8)
    assert.strictEqual((await a.hol('/senden?k=irgendwas')).status, 403);
    assert.strictEqual((await a.hol('/guide/verwalten?k=irgendwas')).status, 403);
    // Ändern ohne Anmeldung geht nicht
    assert.strictEqual((await a.hol('/guide/api/guide', { method: 'POST', body: '{}' })).status, 403);
    assert.strictEqual((await a.hol('/funk-runde?stunden=4', { method: 'POST' })).status, 403);
  } finally { a.ende(); }
});

test('Ohne VERWALTUNG_EMAILS ist die Verwaltung gesperrt', async () => {
  const a = await starte({ VERWALTUNG_EMAILS: '' });
  try {
    for (const w of VERWALTUNGSWEGE) assert.strictEqual((await a.alsChef(w)).status, 403, w);
  } finally { a.ende(); }
});

test('Sende-WebSocket nur für den Verwalter', async () => {
  const a = await starte({ VERWALTUNG_EMAILS: CHEF });
  try {
    const url = a.basis.replace('http', 'ws') + '/ws';
    for (const kopf of [{}, { 'X-Forwarded-Email': 'fremd@example.org' }]) {
      const ergebnis = await new Promise((ok) => {
        const ws = new WebSocket(url, { headers: kopf });
        ws.on('open', () => { ws.close(); ok('offen'); });
        ws.on('error', () => ok('abgelehnt'));
      });
      assert.strictEqual(ergebnis, 'abgelehnt', JSON.stringify(kopf));
    }
  } finally { a.ende(); }
});

test('Runde zeigt genau ihren Guide, Teilnehmerwege werten die Anmeldung nicht aus', async () => {
  const a = await starte({ VERWALTUNG_EMAILS: CHEF });
  try {
    const j = async (r) => { const x = await r; assert.ok(x.ok, x.status + ' ' + x.url); return x.json(); };
    const post = (pfad, daten) => a.alsChef('/guide/api/' + pfad, { method: 'POST', body: JSON.stringify(daten) });
    const g1 = await j(post('guide', { titel: 'Eins' }));
    const g2 = await j(post('guide', { titel: 'Zwei' }));
    const s1 = await j(post('station', { guide: g1.id }));
    const s2 = await j(post('station', { guide: g2.id }));
    const f1 = (await j(a.alsChef(`/guide/api/station/${s1.id}/foto?text=a`, { method: 'POST', body: JPEG }))).fotos[0].datei;
    const f2 = (await j(a.alsChef(`/guide/api/station/${s2.id}/foto?text=b`, { method: 'POST', body: JPEG }))).fotos[0].datei;
    const runde = await j(post('runde', { guide: g1.id, stunden: 4 }));
    assert.strictEqual(runde.art, 'qr');

    // QR-Code setzt das Cookie
    const qr = await a.hol('/g/' + runde.code);
    assert.strictEqual(qr.status, 302);
    const cookie = qr.headers.get('set-cookie').split(';')[0];

    const sicht = await j(a.hol('/guide/api/stationen', { headers: { Cookie: cookie } }));
    assert.strictEqual(sicht.guide.id, g1.id);
    assert.deepStrictEqual(sicht.stationen.map((s) => s.id), [s1.id]);
    assert.strictEqual((await a.hol('/guide/medien/' + f1, { headers: { Cookie: cookie } })).status, 200);
    assert.strictEqual((await a.hol('/guide/medien/' + f2, { headers: { Cookie: cookie } })).status, 403, 'fremder Guide');
    // ?g= in der Teilnehmeradresse ändert nichts
    const versuch = await j(a.hol('/guide/api/stationen?g=' + g2.id, { headers: { Cookie: cookie } }));
    assert.strictEqual(versuch.guide.id, g1.id);

    // Verwalter-Kopffeld öffnet auf Teilnehmerwegen nichts
    assert.strictEqual((await a.alsChef('/guide/api/stationen')).status, 403);
    assert.strictEqual((await a.alsChef('/guide/medien/' + f1)).status, 403);
    // Vorschau für den Verwalter sieht jeden Guide
    assert.strictEqual((await j(a.alsChef('/guide/vorschau/api/stationen?g=' + g2.id))).guide.id, g2.id);
    assert.strictEqual((await a.alsChef('/guide/vorschau/medien/' + f2)).status, 200);

    // Runde beenden: danach nichts mehr (K19)
    assert.ok((await a.alsChef('/guide/api/runde/' + runde.code, { method: 'DELETE' })).ok);
    assert.strictEqual((await a.hol('/guide/api/stationen', { headers: { Cookie: cookie } })).status, 403);
    assert.strictEqual((await a.hol('/guide/medien/' + f1, { headers: { Cookie: cookie } })).status, 403);
  } finally { a.ende(); }
});

test('Funk und Audioguide sind getrennt (K26)', async () => {
  const a = await starte({ VERWALTUNG_EMAILS: CHEF });
  try {
    const guides = await (await a.alsChef('/guide/api/guides')).json();
    const runde = await (await a.alsChef('/guide/api/runde', { method: 'POST', body: JSON.stringify({ guide: guides[0].id }) })).json();
    const guideCookie = (await a.hol('/g/' + runde.code)).headers.get('set-cookie').split(';')[0];
    const funk = await (await a.alsChef('/funk-runde?stunden=4', { method: 'POST' })).json();
    const funkCookie = (await a.hol('/h/' + funk.code)).headers.get('set-cookie').split(';')[0];

    assert.strictEqual((await a.hol('/guide/api/stationen', { headers: { Cookie: funkCookie } })).status, 403, 'Hörcode öffnet keinen Guide');
    const seite = await (await a.hol('/', { headers: { Cookie: guideCookie } })).text();
    assert.match(seite, /beendet oder der QR-Code ist nicht mehr gültig/, 'Guide-Runde öffnet keinen Funk');
    assert.strictEqual((await a.hol('/stream', { headers: { Cookie: guideCookie } })).status, 403);
    // Beides nebeneinander
    const beide = `${funkCookie}; ${guideCookie}`;
    assert.strictEqual((await a.hol('/guide/api/stationen', { headers: { Cookie: beide } })).status, 200);
    assert.match(await (await a.hol('/', { headers: { Cookie: beide } })).text(), /id="play"/, 'Hörseite mit Zuhören-Knopf');
  } finally { a.ende(); }
});

test('Alte Daten werden übernommen (K27)', async () => {
  const a = await starte({ VERWALTUNG_EMAILS: CHEF }, (daten) => {
    fs.mkdirSync(path.join(daten, 'medien'));
    fs.writeFileSync(path.join(daten, 'medien', 'aaaaaaaaaaaa.mp3'), 'x');
    fs.writeFileSync(path.join(daten, 'stationen.json'), JSON.stringify([{ id: 'cccccccccccc', titel: 'Alt', text: 't', audio: 'aaaaaaaaaaaa.mp3', fotos: [] }]));
    fs.writeFileSync(path.join(daten, 'runden.json'), JSON.stringify([{ code: 'altcode', bis: Date.now() + 3600e3 }]));
  });
  try {
    const guides = await (await a.alsChef('/guide/api/guides')).json();
    assert.deepStrictEqual(guides.map((g) => [g.titel, g.anzahl]), [['Audioguide', 1]]);
    const st = await (await a.hol('/guide/api/stationen', { headers: { Cookie: 'runde=altcode' } })).json();
    assert.strictEqual(st.stationen[0].ton.sprecher, 'aaaaaaaaaaaa.mp3', 'alte Aufnahme ist Originalstimme');
    assert.strictEqual(st.stationen[0].ton.ki, null);
    const runden = JSON.parse(fs.readFileSync(path.join(a.daten, 'runden.json'), 'utf8'));
    assert.deepStrictEqual([runden[0].guide, runden[0].art], [guides[0].id, 'qr']);
  } finally { a.ende(); }
});
