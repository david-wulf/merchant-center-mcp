#!/usr/bin/env node
// oauth-anmelden.mjs -- holt einmalig eine Nutzer-Anmeldung (Refresh-Token) fuer
// server.mjs. Danach handelt der Merchant-Center-MCP als DEIN Google-Nutzer und sieht
// jedes Merchant Center, in dem dieser Nutzer eingetragen ist (Agenturarbeit, z. B. Kunden,
// die kein Dienstkonto freigeben koennen).
//
// Aufruf:
//   node oauth-anmelden.mjs --client <client_secret_....json> --out <anmeldung.json>
//
//   --client   OAuth-Client vom Typ "Desktop-App" aus der Google Cloud Console
//              (APIs & Dienste -> Anmeldedaten -> OAuth-Client-ID -> herunterladen).
//              Das Projekt dieses Clients muss als Merchant-API-Entwickler registriert sein.
//   --out      Zieldatei. Ergebnis im Format "authorized_user" (wie gcloud) - diesen Pfad dann
//              als GMC_KEY_FILE eintragen. Eine vorhandene Datei wird nur mit --ueberschreiben
//              ersetzt.
//   --kein-browser  Adresse nur ausgeben, nicht selbst oeffnen.
//
// Infisical-Weg (Projekt consulting-merchant-center): --client weglassen, dann kommt der Client
// aus GMC_OAUTH_CLIENT_ID/GMC_OAUTH_CLIENT_SECRET. Endet --out auf .env, enthaelt die Datei nur
// die Zeile GMC_REFRESH_TOKEN=... zum Import in Infisical (Oberflaeche: Datei hineinziehen).
// Danach die Datei loeschen. Aufruf:
//   node infisical-run.mjs --project <id> -- node oauth-anmelden.mjs --out <pfad>.env
//
// Ablauf: Browser oeffnet die Google-Anmeldung, Google leitet auf 127.0.0.1 zurueck (nur dieser
// Rechner), der Code wird mit PKCE gegen das Token getauscht. Kein Token und kein Client-Secret
// wird ausgegeben; die Datei bekommt nur Lese-/Schreibrecht fuer dich (soweit Windows das kennt).
import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const log = (...a) => process.stderr.write("[merchant-center-mcp anmelden] " + a.join(" ") + "\n");
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const clientDatei = opt("--client");
const ziel = opt("--out");
const ausUmgebung = !clientDatei && process.env.GMC_OAUTH_CLIENT_ID && process.env.GMC_OAUTH_CLIENT_SECRET;
if ((!clientDatei && !ausUmgebung) || !ziel) {
  log("Aufruf: node oauth-anmelden.mjs [--client <client_secret.json>] --out <anmeldung.json|.env> [--ueberschreiben]");
  log("Ohne --client muessen GMC_OAUTH_CLIENT_ID und GMC_OAUTH_CLIENT_SECRET gesetzt sein.");
  process.exit(2);
}
const nurToken = ziel.toLowerCase().endsWith(".env");
if (fs.existsSync(ziel) && !argv.includes("--ueberschreiben")) {
  log("Zieldatei existiert schon:", ziel, "- mit --ueberschreiben ersetzen.");
  process.exit(2);
}

let client;
if (ausUmgebung) {
  client = { client_id: process.env.GMC_OAUTH_CLIENT_ID, client_secret: process.env.GMC_OAUTH_CLIENT_SECRET };
} else {
  try {
    const j = JSON.parse(fs.readFileSync(clientDatei, "utf8"));
    client = j.installed || j.web;
  } catch (e) {
    log("Client-Datei nicht lesbar oder kein JSON:", e.message);
    process.exit(3);
  }
}
if (!client?.client_id || !client?.client_secret) {
  log("Client-Datei enthaelt kein installed/web mit client_id und client_secret.");
  process.exit(3);
}

const SCOPES = ["https://www.googleapis.com/auth/content", "openid", "email"];
const verifier = crypto.randomBytes(48).toString("base64url");
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
const state = crypto.randomBytes(16).toString("hex");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname !== "/") { res.writeHead(404).end(); return; }
  const fertig = (code, text) => {
    res.writeHead(code, { "content-type": "text/plain; charset=utf-8" }).end(text);
    server.close();
  };
  if (url.searchParams.get("state") !== state) {
    fertig(400, "Ungueltige Antwort (state passt nicht). Fenster schliessen und neu starten.");
    log("Abbruch: state passt nicht.");
    process.exitCode = 1;
    return;
  }
  if (url.searchParams.get("error")) {
    fertig(400, "Anmeldung abgebrochen: " + url.searchParams.get("error"));
    log("Abbruch durch Google:", url.searchParams.get("error"));
    process.exitCode = 1;
    return;
  }
  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: url.searchParams.get("code") || "",
        code_verifier: verifier,
        redirect_uri: redirectUri,
        client_id: client.client_id,
        client_secret: client.client_secret,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.refresh_token) {
      throw new Error(`Token-Tausch fehlgeschlagen (${r.status}): ${j.error_description || j.error || "kein Refresh-Token"}`);
    }
    // E-Mail nur zur Anzeige aus dem id_token (nicht geprueft - es kommt direkt von Google).
    let konto = "";
    try { konto = JSON.parse(Buffer.from(j.id_token.split(".")[1], "base64url").toString()).email || ""; } catch {}
    fs.writeFileSync(ziel, nurToken
      ? `GMC_REFRESH_TOKEN=${j.refresh_token}\n`
      : JSON.stringify({
          type: "authorized_user",
          client_id: client.client_id,
          client_secret: client.client_secret,
          refresh_token: j.refresh_token,
          account: konto,
        }, null, 2), { mode: 0o600 });
    fertig(200, "Angemeldet" + (konto ? " als " + konto : "") + ". Das Fenster kann zu.");
    log("Gespeichert:", ziel, konto ? "(" + konto + ")" : "");
    log(nurToken
      ? "Jetzt die Datei in Infisical (consulting-merchant-center, dev) importieren und danach loeschen."
      : "Jetzt GMC_KEY_FILE auf diese Datei setzen und Claude Code neu starten.");
  } catch (e) {
    fertig(500, "Fehler: " + e.message);
    log(e.message);
    process.exitCode = 1;
  }
});

let redirectUri;
server.listen(0, "127.0.0.1", () => {
  redirectUri = `http://127.0.0.1:${server.address().port}/`;
  const auth = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  log("Browser oeffnet die Google-Anmeldung. Falls nicht, diese Adresse oeffnen:");
  process.stderr.write(auth + "\n");
  if (argv.includes("--kein-browser")) return;
  const oeffnen = process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", auth]]
    : process.platform === "darwin" ? ["open", [auth]] : ["xdg-open", [auth]];
  spawn(oeffnen[0], oeffnen[1], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
});
setTimeout(() => { log("Keine Anmeldung innerhalb von 5 Minuten - Abbruch."); process.exit(1); }, 300_000).unref();
