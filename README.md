# merchant-center-mcp

stdio-MCP-Server vor Googles offiziellem Merchant-API-MCP-Endpunkt
(`https://merchantapi.googleapis.com/mcp`). Der Endpunkt beherrscht keine dynamische
Client-Registrierung; dieser Wrapper meldet sich selbst an (Dienstkonto per JWT oder
Nutzer-Anmeldung per Refresh-Token), haelt das Token frisch und blendet im Standard alle
schreibenden Werkzeuge aus.

Keine Abhaengigkeiten, Node 18 oder neuer.

## Start

```bash
GMC_KEY_FILE=/pfad/zu/anmeldung.json node server.mjs
```

oder mit Nutzer-Anmeldung aus der Umgebung (`GMC_OAUTH_CLIENT_ID`, `GMC_OAUTH_CLIENT_SECRET`,
`GMC_REFRESH_TOKEN`). Weitere Variablen: `GMC_READONLY` (Standard `1`), `GMC_GCP_PROJECT`,
`GMC_ENDPOINT`.

## Nutzer-Anmeldung holen

```bash
node oauth-anmelden.mjs --client client_secret.json --out anmeldung.json
```

Oeffnet die Google-Anmeldung im Browser, tauscht den Code per PKCE und schreibt eine
`authorized_user`-Datei. Endet `--out` auf `.env`, steht darin nur `GMC_REFRESH_TOKEN=…`.

## Werkzeuge

Kommen von Google. Lesend u. a. `list_accounts`, `list_products`, `get_product_by_name`,
`report_search`, `list_account_issues`. Schreibend (`create_data_source`, `fetch_data_source`)
nur mit `GMC_READONLY=0`.

Details zu Aufbau, Einbindung und Grenzen: [CLAUDE.md](CLAUDE.md).
