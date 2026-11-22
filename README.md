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

## Seiten

| Adresse | Für wen |
|---|---|
| `/h/CODE` | QR-Code der Führung: setzt das Hör-Cookie bis zum Ablauf, dann weiter zu `/` |
| `/` | Hörer (Gruppe) – nur mit gültigem Hörcode, sonst Hinweis „Führung beendet“ |
| `/funk-runde?k=SENDE_TOKEN` | Sende-Seite: aktuellen Hörcode lesen (GET) bzw. neuen anlegen (POST, `stunden=`) |
| `/senden?k=SENDE_TOKEN` | Frank: Sende-Seite mit QR-Code |
| `/status` | Live-Anzeige, Zuhörerzahl |
| `/hoer-mp4` (WebSocket) | Hörer-Seite: AAC in MP4, schneller Weg für Chrome, Firefox, Safari |
| `/hoer-ws`, `/stream` | Rückfall: MP3 per WebSocket bzw. normaler Audio-Strom |
| `/guide` | Teilnehmer: der Guide, den ihre Runde freischaltet |
| `/guide?k=SENDE_TOKEN&g=GUIDE-ID` | Frank: Vorschau eines bestimmten Guides |
| `/guide/verwalten?k=SENDE_TOKEN` | Frank: Guides, Stationen und Runden pflegen |
| `/g/CODE` | QR-Code einer Runde |

## Audioguide: mehrere Guides (seit 22.11.2026)

Es kann beliebig viele Guides geben (z. B. Hauptführung, Ergänzungen, andere Sprache). Jede Runde gehört zu genau einem Guide; die Gruppe sieht nur diesen und kommt auch nur an dessen Bilder und Töne.

Je Station:
- **Text** (wird angezeigt und ist die Vorlage zum Vorlesen) und **Quelle**
- **Zwei Tonspuren**: `sprecher` (Originalstimme, wird bevorzugt) und `ki` (KI-Stimme). Läuft die KI-Spur, steht für die Teilnehmer „Gelesen von einer KI-Stimme“ daneben. Gibt es beide, können sie umschalten.
- **Bis zu 3 Fotos** mit Bildunterschrift
- **Früher/Heute** (`zeitreise`): zwei Bilder vom gleichen Standpunkt, Teilnehmer schieben einen Regler. Feld `art` ist heute immer `bild`; `panorama` ist für spätere 360°-Ansichten reserviert und wird noch nicht angezeigt.

Daten in `daten/`: `guides.json`, `stationen.json` (Feld `guide`), `runden.json` (Feld `guide`), Medien in `daten/medien/`. Ältere Daten (ein Guide, Feld `audio`) werden beim Start einmalig umgestellt: alles landet im Guide „Audioguide“, die alte Aufnahme wird zur Originalstimme.

**Guide einspielen** (Inhalte liegen nicht in diesem öffentlichen Repo):

```
SENDE_TOKEN=... node werkzeuge/guide-import.js https://funk.mentolder.de ORDNER
```

`ORDNER/guide.json` beschreibt Titel, Stationen, Bilder (JPEG) und optional Tondateien; Aufbau im Kopf von `werkzeuge/guide-import.js`. Gibt es den Titel schon, bricht das Werkzeug ab.

## Einstellungen

- Hörcode je Führung (seit 29.10.2026): Die Sende-Seite legt einen Code mit Ablaufzeit an (Standard 4 Stunden, wählbar 2 Std. bis 2 Tage). Ein neuer Code oder der Ablauf beendet alle Hörer mit altem Code. Gespeichert in `daten/funk-runde.json`.
- `SENDE_TOKEN`: geheimer Teil der Sende- und Verwaltungslinks. Kommt aus dem Kubernetes-Secret `fuehrungsfunk` (Namespace `workspace`), liegt **nicht** in GitHub.
- `ICECAST_SOURCE_PW`: wird bei jedem Start neu gewürfelt (`start.sh`), verlässt den Container nie.
- Daten des Audioguides: `/app/daten/` (eigener Speicher, bleibt bei Neustarts erhalten).

## Update einspielen

1. Änderung committen und pushen (GitHub Desktop) → GitHub baut `ghcr.io/gekko32/fuehrungsfunk:latest`.
2. Auf dem Server neu starten: `kubectl rollout restart deploy/fuehrungsfunk -n workspace`.
3. Im Änderungsprotokoll (`technik/hetzner/AENDERUNGSPROTOKOLL.md`) vermerken.

Die Kubernetes-Beschreibung steht in `gekko32/mentolder-prod`, Datei `prod-fleet/mentolder/fuehrungsfunk.yaml`.

## Noch offen (Echttest)

Auf Android-Chrome, Android-Firefox, iPhone-Safari und Samsung Internet testen. Einsatzreif erst, wenn alle unter etwa 5 s Verzögerung liegen. Mikrofonaufnahme und Kamera-Upload im Audioguide auf echtem Handy prüfen.
