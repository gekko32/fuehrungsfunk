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
| `/` | Hörer (Gruppe) |
| `/senden?k=SENDE_TOKEN` | Frank: Sende-Seite mit QR-Code |
| `/status` | Live-Anzeige, Zuhörerzahl |
| `/guide` | Teilnehmer: Audioguide |
| `/guide/verwalten?k=SENDE_TOKEN` | Frank: Stationen und Runden pflegen |
| `/g/CODE` | QR-Code einer Runde |

## Einstellungen

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
