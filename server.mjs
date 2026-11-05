#!/usr/bin/env node
// server.mjs -- haengt Claude Code an Googles offiziellen
// Merchant-API-MCP-Endpunkt (https://merchantapi.googleapis.com/mcp).
//
// Warum ueberhaupt ein Wrapper?
// Der Endpunkt kann Service-Accounts -- aber seine OAuth-Seite beherrscht keine
// dynamische Client-Registrierung. Claude Code kann sich dort also nicht selbst
// anmelden ("Incompatible auth server"), und ein statischer Header hilft nicht,
// weil ein Service-Account-Token nach einer Stunde ablaeuft. Dieser Wrapper
// spricht stdio nach innen, Streamable HTTP nach aussen, und legt pro Aufruf ein
// frisches Token sowie den Pflicht-Header X-Goog-User-Project dazu.
//
// Zwei Anmeldearten, beide ueber GMC_KEY_FILE - die Datei sagt, welche:
//   - Service-Account-Schluessel ("type": "service_account"): fuer das EIGENE Merchant Center.
//   - Nutzer-Anmeldung ("type": "authorized_user", client_id/client_secret/refresh_token, wie
//     gcloud sie schreibt; erzeugt mit oauth-anmelden.mjs): fuer Agenturarbeit. Der MCP
//     handelt dann als DEIN Google-Nutzer und sieht jedes Merchant Center, in dem dieser Nutzer
//     eingetragen ist. Das Google-Cloud-Projekt des OAuth-Clients muss als Entwickler registriert
//     sein (bei deinem eigenen Merchant-Center-Konto), sonst antwortet die API mit 401.
//
// Dritter Weg ohne Datei: die Nutzer-Anmeldung als drei Variablen GMC_OAUTH_CLIENT_ID,
// GMC_OAUTH_CLIENT_SECRET und GMC_REFRESH_TOKEN. So kommt sie per infisical-run.mjs aus Infisical
// (Projekt consulting-merchant-center) und liegt nirgends auf der Platte. Sind alle drei gesetzt,
// gewinnen sie vor GMC_KEY_FILE.
//
// Umgebungsvariablen:
//   GMC_KEY_FILE      Pfad zur Schluessel- bzw. Anmeldedatei      (Pflicht ohne die drei GMC_OAUTH-/GMC_REFRESH-Werte)
//   GMC_GCP_PROJECT   Google-Cloud-Projekt-ID fuer die Quote     (optional)
//                     Googles Doku nennt X-Goog-User-Project als Pflicht. Ist der
//                     Aufrufer aber ein Service-Account, rechnet Google die Quote
//                     ohnehin dessen eigenem Projekt zu -- und dann verlangt der
//                     gesetzte Header zusaetzlich die Rolle
//                     roles/serviceusage.serviceUsageConsumer, sonst kommt
//                     HTTP 403 "Caller does not have required permission to use
//                     project ...". Leer lassen heisst: Header weg, Rolle unnoetig.
//   GMC_READONLY      "1" = schreibende Werkzeuge ausblenden     (Standard: 1)
//   GMC_ENDPOINT      abweichender Endpunkt                      (optional)
//
// WICHTIG: MCP spricht ueber stdout. Hier geht dorthin ausschliesslich das
// Protokoll -- jede Diagnose nach stderr, sonst bricht die Verbindung.
// Das Token wird nie protokolliert, der Schluessel nie ausgegeben.

import fs from "node:fs";
import crypto from "node:crypto";

const log = (...a) => process.stderr.write("[merchant-center-mcp] " + a.join(" ") + "\n");

const KEY_FILE = process.env.GMC_KEY_FILE;
const GCP_PROJECT = process.env.GMC_GCP_PROJECT;
const ENDPOINT = process.env.GMC_ENDPOINT || "https://merchantapi.googleapis.com/mcp";
const READONLY = (process.env.GMC_READONLY ?? "1") !== "0";
const SCOPE = "https://www.googleapis.com/auth/content";

const ENV_ANMELDUNG = ["GMC_OAUTH_CLIENT_ID", "GMC_OAUTH_CLIENT_SECRET", "GMC_REFRESH_TOKEN"];
const envGesetzt = ENV_ANMELDUNG.filter((n) => process.env[n]);
if (envGesetzt.length > 0 && envGesetzt.length < ENV_ANMELDUNG.length) {
  log("Nutzer-Anmeldung unvollstaendig, es fehlt:",
      ENV_ANMELDUNG.filter((n) => !process.env[n]).join(", "));
  process.exit(3);
}

// --- Schluessel einlesen -----------------------------------------------------
let key;
if (envGesetzt.length === ENV_ANMELDUNG.length) {
  key = {
    type: "authorized_user",
    client_id: process.env.GMC_OAUTH_CLIENT_ID,
    client_secret: process.env.GMC_OAUTH_CLIENT_SECRET,
    refresh_token: process.env.GMC_REFRESH_TOKEN,
    account: "aus Umgebung",
  };
} else {
  if (!KEY_FILE) { log("Weder GMC_KEY_FILE noch", ENV_ANMELDUNG.join("/"), "gesetzt."); process.exit(3); }
  try {
    key = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
  } catch (e) {
    log("Schluesseldatei nicht lesbar oder kein JSON:", KEY_FILE, "--", e.message);
    process.exit(3);
  }
}
const NUTZER = key.type === "authorized_user";
if (NUTZER) {
  if (!key.client_id || !key.client_secret || !key.refresh_token) {
    log("Anmeldedatei (authorized_user) enthaelt kein client_id/client_secret/refresh_token.");
    process.exit(3);
  }
} else if (!key.client_email || !key.private_key || !key.token_uri) {
  log("Schluesseldatei enthaelt kein client_email/private_key/token_uri.");
  process.exit(3);
}
log("Schluessel geladen:", NUTZER ? `Nutzer-Anmeldung (${key.account || "OAuth"})` : key.client_email,
    "| Quote-Projekt:", GCP_PROJECT ||
      (NUTZER ? "(kein Header, Quote laeuft ueber das Projekt des OAuth-Clients)"
              : "(kein Header, Quote laeuft ueber den Service-Account)"),
    "| Modus:", READONLY ? "nur lesen" : "lesen und schreiben");

// --- Token: Dienstkonto per selbst signiertem JWT, Nutzer per Refresh-Token --
const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
let cached = { value: null, expires: 0 };

function tokenAnfrage(now) {
  if (NUTZER) {
    return new URLSearchParams({
      grant_type: "refresh_token",
      client_id: key.client_id,
      client_secret: key.client_secret,
      refresh_token: key.refresh_token,
    });
  }
  const input = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: key.client_email, scope: SCOPE, aud: key.token_uri,
    exp: now + 3600, iat: now,
  })}`;
  const sig = crypto.createSign("RSA-SHA256").update(input).end()
    .sign(key.private_key, "base64url");
  return new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: `${input}.${sig}`,
  });
}

async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cached.value && cached.expires - 60 > now) return cached.value;

  const r = await fetch(key.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenAnfrage(now),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    // j kann eine Fehlerbeschreibung tragen, aber nie ein Token -- Ausgabe ist sicher.
    throw new Error(`Token-Tausch fehlgeschlagen (${r.status}): ${j.error_description || j.error || "unbekannt"}`);
  }
  cached = { value: j.access_token, expires: now + (j.expires_in || 3600) };
  return cached.value;
}

// --- Schreibschutz -----------------------------------------------------------
// Googles Alpha-Endpunkt fuehrt neben den lesenden auch "low-risk" schreibende
// Werkzeuge (z. B. Datenquelle anlegen). Im Standardmodus bleiben sie draussen:
// ein falscher Schreibzugriff kostet im Wiederholungsfall das Merchant-Center-Konto,
// ein fehlender Lesezugriff nur einen Neustart.
const WRITE = /^(create|update|delete|insert|patch|upload|set_|add_|remove_|fetch_data_source|link|unlink)/i;
const isWrite = (name) => WRITE.test(name);

// --- Streamable-HTTP-Client --------------------------------------------------
let sessionId = null;

function parseBody(text, contentType) {
  // Der Endpunkt antwortet entweder als JSON oder als SSE-Stream.
  if (contentType && contentType.includes("text/event-stream")) {
    const out = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try { out.push(JSON.parse(payload)); } catch { /* Teilstueck, ignorieren */ }
    }
    return out;
  }
  if (!text.trim()) return [];
  try {
    const j = JSON.parse(text);
    return Array.isArray(j) ? j : [j];
  } catch {
    return [];
  }
}

async function forward(message) {
  const headers = {
    authorization: `Bearer ${await accessToken()}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (GCP_PROJECT) headers["x-goog-user-project"] = GCP_PROJECT;
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const res = await fetch(ENDPOINT, {
    method: "POST", headers, body: JSON.stringify(message),
  });

  const sid = res.headers.get("mcp-session-id");
  if (sid && sid !== sessionId) { sessionId = sid; log("Sitzung:", sid); }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
  }
  return parseBody(text, res.headers.get("content-type") || "");
}

// --- stdio: zeilengetrennte JSON-RPC-Nachrichten -----------------------------
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

const errorFor = (id, message, code = -32603) =>
  ({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg) {
  // Schreibschutz greift, bevor die Nachricht das Haus verlaesst.
  if (READONLY && msg.method === "tools/call" && isWrite(msg.params?.name || "")) {
    send(errorFor(msg.id,
      `Werkzeug "${msg.params.name}" schreibt und ist im Nur-Lesen-Modus gesperrt. ` +
      `Zum Loesen GMC_READONLY=0 setzen und den Server neu starten.`, -32602));
    return;
  }

  let replies;
  try {
    replies = await forward(msg);
  } catch (e) {
    log("Weiterleitung fehlgeschlagen:", e.message);
    if (msg.id !== undefined && msg.id !== null) send(errorFor(msg.id, e.message));
    return;
  }

  for (const r of replies) {
    // Im Nur-Lesen-Modus die schreibenden Werkzeuge aus der Liste nehmen,
    // damit das Modell sie gar nicht erst anbietet.
    if (READONLY && Array.isArray(r?.result?.tools)) {
      const vorher = r.result.tools.length;
      r.result.tools = r.result.tools.filter((t) => !isWrite(t.name));
      if (vorher !== r.result.tools.length) {
        log(`Werkzeugliste: ${r.result.tools.length} von ${vorher} (schreibende ausgeblendet)`);
      }
    }
    send(r);
  }
}

let buffer = "";
let chain = Promise.resolve(); // Reihenfolge der Antworten beibehalten
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); }
    catch (e) { log("Unlesbare Zeile verworfen:", e.message); continue; }
    chain = chain.then(() => handle(msg)).catch((e) => log("unerwartet:", e.message));
  }
});
process.stdin.on("end", () => process.exit(0));
