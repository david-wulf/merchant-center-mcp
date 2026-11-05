# merchant-center-mcp

## Zweck

Haengt Claude Code und Claude Desktop an **Googles offiziellen Merchant-API-MCP-Endpunkt**
(`https://merchantapi.googleapis.com/mcp`). Der Endpunkt kennt keine dynamische
Client-Registrierung, deshalb kann sich ein MCP-Client dort nicht selbst anmelden, und ein
statischer Bearer-Header laeuft nach einer Stunde ab. Dieser Wrapper spricht stdio nach innen,
Streamable HTTP nach aussen und holt je Aufruf ein frisches Token.

Bis 2026-11-05 lag der Code als `~/.claude/gmc-mcp-proxy.mjs` und `~/.claude/gmc-oauth-anmelden.mjs`
und hiess in der Konfiguration `gmc`. Fachliche Doku (Agentur-Weg, Registrierung, Stand je Kunde):
Brain-Record `okf/werkzeuge/merchant-center-mcp.md`.

## Aufbau

- `server.mjs` — der MCP-Server (stdio). Keine Abhaengigkeiten, nur Node-Standardbibliothek
  (`fetch`, `node:crypto`). Dienstkonto: JWT selbst signiert. Nutzer-Anmeldung: Refresh-Token.
  Token-Cache bis 60 s vor Ablauf. Schreibschutz per Namensmuster (`WRITE`).
- `oauth-anmelden.mjs` — holt einmalig eine Nutzer-Anmeldung (PKCE, Redirect auf 127.0.0.1) und
  schreibt sie als `authorized_user`-JSON oder als `.env`-Zeile `GMC_REFRESH_TOKEN=…`.

## Tools

Kommen vollstaendig von Google, der Wrapper definiert keine eigenen. Stand 2026-09-17: 13 Werkzeuge,
davon 11 lesend (`list_accounts`, `list_products`, `get_product_by_name`, `report_search`,
`list_account_issues`, `list_aggregate_product_statuses`, `list_programs`, `list_data_sources`,
`get_data_source`, `get_file_upload`, `get_automatic_improvements`) und 2 schreibend
(`create_data_source`, `fetch_data_source`). Mit `GMC_READONLY=1` (Standard) sind die schreibenden
aus `tools/list` gefiltert und werden bei `tools/call` vor dem Verlassen des Rechners abgelehnt.

## Lokal starten & pruefen

```bash
npm run check                      # Syntax beider Dateien
node server.mjs </dev/null         # ohne Anmeldung: Exit 3 mit Klartext auf stderr
```

Live-Nachweis nur ueber die eingebundene Instanz nach einem Neustart von Claude Code
(`mcp__merchant-center-mcp__list_accounts`). Configs nie per Skript auslesen, um an Env-Werte zu
kommen.

## Einbindung in Claude

Server-Name `merchant-center-mcp` (User-Scope in `~/.claude.json` und in der
`claude_desktop_config.json`). Start ueber `infisical-run.mjs`, damit die Anmeldung nur zur
Laufzeit im Prozess liegt:

```
node C:\Users\david\.claude\infisical-run.mjs --project <infisical-projekt-id> --env dev -- node C:\Users\david\Claude-Code-Projekte\merchant-center-mcp\server.mjs
```

Env im Eintrag: `GMC_READONLY=1`. Werkzeuge erscheinen als `mcp__merchant-center-mcp__<name>`.

## Konfiguration

| Variable | Bedeutung |
|---|---|
| `GMC_OAUTH_CLIENT_ID`, `GMC_OAUTH_CLIENT_SECRET`, `GMC_REFRESH_TOKEN` | Nutzer-Anmeldung aus Infisical (Projekt `consulting-merchant-center`, Env `dev`). Alle drei oder keiner; haben Vorrang vor `GMC_KEY_FILE` |
| `GMC_KEY_FILE` | Pfad zu Dienstkonto-Schluessel (`service_account`) oder Anmeldedatei (`authorized_user`) |
| `GMC_GCP_PROJECT` | optional, setzt `X-Goog-User-Project`. **Leer lassen**: gesetzt verlangt Google zusaetzlich `roles/serviceusage.serviceUsageConsumer`, und die 403 verdeckt den eigentlichen Fehler |
| `GMC_READONLY` | `1` (Standard) = schreibende Werkzeuge gesperrt, `0` = frei |
| `GMC_ENDPOINT` | abweichender Endpunkt (optional) |

Die Variablennamen behalten das Praefix `GMC_`, weil die Secrets in Infisical so heissen.

## Neues Tool hinzufuegen

Nicht hier: Die Werkzeuge kommen von Google. Aendert Google die Liste, nur pruefen, ob das
Schreib-Muster `WRITE` in `server.mjs` neue schreibende Namen noch erfasst.

## Grenzen

- MCP spricht ueber stdout: dorthin nur Protokoll, jede Diagnose nach stderr.
- Token und Schluessel werden nie protokolliert; Fehlertexte von Google tragen kein Token.
- Jeder Aufruf braucht ein beim Merchant-Konto **registriertes** Google-Cloud-Projekt, sonst 401.
- Ein Refresh-Token laeuft nach sieben Tagen ab, solange der Zustimmungsbildschirm auf „Testen" steht.

## Remotes

`origin`: GitHub `david-wulf/merchant-center-mcp` (privat), Push zusaetzlich auf Forgejo
`davidwulf/merchant-center-mcp` (privat). Kein Team-Remote: Werkzeug der eigenen Firma, nicht
homeandsmart.

## Offen

- Kein automatischer Test gegen den echten Endpunkt.
- Nicht im Homelab-Gateway eingebunden, nur lokal.
