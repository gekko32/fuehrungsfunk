# Führungsfunk + Audioguide

Frank spricht ins Handy (Browser), die Gruppe hört auf dem eigenen Handy (Browser, Link oder QR-Code). Keine App. Dazu ein Audioguide mit vorgesprochenen Stationen.

**Läuft auf:** Geralds Hetzner-Server, Adresse **https://funk.mentolder.de** (seit 19.10.2026, Testbetrieb).
Vorher: NUC, Container 205 (siehe `grenzspaziergang/04-prototypen/fuehrungsfunk/`).

```
Franks Handy ──WebSocket──> Node-App :8090 ──ffmpeg──> Icecast 127.0.0.1:8000/live
                               │
Gruppe <── /hoer-ws (WebSocket, springt bei Rückstand nach vorn) oder /stream (MP3)
```

Alles läuft in **einem** Container: Node-App, ffmpeg und Icecast (nur intern erreichbar).

**Anmeldung (ab A72, Spezifikation `technik/hetzner/SPEZ-FUNK-AUDIOGUIDE.md`):** Vor der App sitzt ein Anmelde-Vorschalter (`oauth2-proxy-funk`, Pocket ID). Die Teilnehmerwege (unten „ohne Anmeldung“) lässt er durch, alles andere verlangt eine Anmeldung. Die App erlaubt die Verwaltung nur, wenn das Kopffeld `X-Forwarded-Email` in `VERWALTUNG_EMAILS` steht; ohne diese Einstellung ist die Verwaltung gesperrt. Teilnehmerwege werten das Kopffeld nie aus. Einen Schlüssel in der Adresse gibt es nicht mehr.

## Seiten

| Adresse | Für wen | Anmeldung |
|---|---|---|
| `/h/CODE` | QR-Code der Führung: setzt das Hör-Cookie bis zum Ablauf, dann weiter zu `/` | ohne |
| `/` | Hörer (Gruppe) – nur mit gültigem Hörcode, sonst Hinweis „Führung beendet“ | ohne |
| `/status` | Live-Anzeige, Zuhörerzahl | ohne |
| `/hoer-mp4` (WebSocket) | Hörer-Seite: AAC in MP4, schneller Weg für Chrome, Firefox, Safari | ohne |
| `/hoer-ws`, `/stream` | Rückfall: MP3 per WebSocket bzw. normaler Audio-Strom | ohne |
| `/g/CODE` | QR-Code einer Audioguide-Runde | ohne |
| `/guide`, `/guide/api/stationen`, `/guide/medien/…` | Teilnehmer: der Guide, den ihre Runde freischaltet (nur mit Runden-Cookie) | ohne |
| `/senden`, `/ws` (WebSocket) | Sende-Seite mit QR-Code und Sendeweg | Verwaltung |
| `/funk-runde` | Hörcode lesen (GET) bzw. neuen anlegen (POST, `stunden=`) | Verwaltung |
| `/guide/verwalten` | Guides, Stationen und Runden pflegen | Verwaltung |
| `/guide/vorschau?g=GUIDE-ID` | Vorschau eines beliebigen Guides | Verwaltung |
| `/guide/api/…` (außer `stationen`) | Schnittstelle der Verwaltung | Verwaltung |

## Audioguide: mehrere Guides (seit 22.11.2026)

Es kann beliebig viele Guides geben (z. B. Hauptführung, Ergänzungen, andere Sprache). Jede Runde gehört zu genau einem Guide; die Gruppe sieht nur diesen und kommt auch nur an dessen Bilder und Töne.

Je Station:
- **Text** (wird angezeigt und ist die Vorlage zum Vorlesen) und **Quelle**
- **Zwei Tonspuren**: `sprecher` (Originalstimme, wird bevorzugt) und `ki` (KI-Stimme). Läuft die KI-Spur, steht für die Teilnehmer „Gelesen von einer KI-Stimme“ daneben. Gibt es beide, können sie umschalten.
- **Bis zu 3 Fotos** mit Bildunterschrift
- **Früher/Heute** (`zeitreise`): zwei Bilder vom gleichen Standpunkt, Teilnehmer schieben einen Regler. Feld `art` ist heute immer `bild`; `panorama` ist für spätere 360°-Ansichten reserviert und wird noch nicht angezeigt.

Daten in `daten/`: `guides.json`, `stationen.json` (Feld `guide`), `runden.json` (Felder `guide` und `art`; heute immer `qr`, später z. B. `buchung` für eine Freischaltung per Buchungsnummer), Medien in `daten/medien/`. Ältere Daten (ein Guide, Feld `audio`) werden beim Start einmalig umgestellt: alles landet im Guide „Audioguide“, die alte Aufnahme wird zur Originalstimme.

**Guide einspielen** (Inhalte liegen nicht in diesem öffentlichen Repo):

```
kubectl -n workspace port-forward deploy/fuehrungsfunk 8090:8090
ALS=adresse@example.org node werkzeuge/guide-import.js http://localhost:8090 ORDNER
```

`ORDNER/guide.json` beschreibt Titel, Stationen, Bilder (JPEG) und optional Tondateien; Aufbau im Kopf von `werkzeuge/guide-import.js`. Gibt es den Titel schon, bricht das Werkzeug ab.

## Einstellungen

- Hörcode je Führung (seit 29.10.2026): Die Sende-Seite legt einen Code mit Ablaufzeit an (Standard 4 Stunden, wählbar 2 Std. bis 2 Tage). Ein neuer Code oder der Ablauf beendet alle Hörer mit altem Code. Gespeichert in `daten/funk-runde.json`.
- `VERWALTUNG_EMAILS`: kommagetrennte Liste der Adressen, die verwalten dürfen (heute nur Gerald). Leer = Verwaltung gesperrt.
- `DATEN_DIR`: Datenordner (Standard `/app/daten`, für Tests ein eigener).
- `ICECAST_SOURCE_PW`: wird bei jedem Start neu gewürfelt (`start.sh`), verlässt den Container nie.
- Daten des Audioguides: `/app/daten/` (eigener Speicher, bleibt bei Neustarts erhalten).

## Tests

`npm test` startet die App mit eigenem Datenordner und prüft Rechte (ohne Anmeldung, fremde Adresse, Verwalter, ohne Einstellung), Sende-WebSocket, Trennung der Guides, Trennung Funk/Audioguide und die Übernahme alter Daten. Läuft auch beim Bau auf GitHub.

## Update einspielen

1. Änderung committen und pushen (GitHub Desktop) → GitHub baut `ghcr.io/gekko32/fuehrungsfunk:latest`.
2. Auf dem Server neu starten: `kubectl rollout restart deploy/fuehrungsfunk -n workspace`.
3. Im Änderungsprotokoll (`technik/hetzner/AENDERUNGSPROTOKOLL.md`) vermerken.

Die Kubernetes-Beschreibung steht in `gekko32/mentolder-prod`, Datei `prod-fleet/mentolder/fuehrungsfunk.yaml`.

## Noch offen (Echttest)

Auf Android-Chrome, Android-Firefox, iPhone-Safari und Samsung Internet testen. Einsatzreif erst, wenn alle unter etwa 5 s Verzögerung liegen. Mikrofonaufnahme und Kamera-Upload im Audioguide auf echtem Handy prüfen.
