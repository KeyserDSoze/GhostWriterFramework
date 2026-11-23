/**
 * Admin panel of the personal server, served on the loopback admin port under a strict CSP
 * (no inline scripts or styles). Texts are in English and Italian; data is always set as text.
 *
 * It is one document with one page shown at a time, each at an address of its own (`/#/books`, `/#/security`…): the sign-in, the navigation (`ui-pages.ts`), the style (`ui-style.ts`), the
 * views of the server's state (`ui-views.ts`) and the remembered devices (`ui-devices.ts`) are put together here, with the script that runs them.
 */

import { DEVICES_JS } from "./ui-devices.js";
import { LOGIN_HTML, MENU_ICON, NAV_HTML, PAGES, PAGES_HTML } from "./ui-pages.js";
import { ADMIN_CSS } from "./ui-style.js";
import { VIEWS_JS } from "./ui-views.js";

export { ADMIN_CSS };

export const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>Narrarium server</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="stylesheet" href="/admin.css">
<script src="/admin.js" defer></script>
</head>
<body>
<a class="skip" id="skip" href="#main" data-i18n="skip">Skip to content</a>
<header class="topbar">
  <button type="button" class="ghost menu-btn hidden" id="menu-button" aria-expanded="false" aria-controls="sidebar">${MENU_ICON}<span data-i18n="menu">Menu</span></button>
  <div class="brand"><span class="logo" aria-hidden="true">N</span><div class="brand-text"><span class="brand-name" data-i18n="title">Narrarium server</span><span class="brand-sub" id="subtitle"></span></div></div>
  <button type="button" class="ghost small" id="lang" aria-label="Language">IT</button>
</header>
<div class="layout" id="layout">
  <div class="sidebar" id="sidebar">
    ${NAV_HTML}
    <div class="side-foot">
      <p class="small muted hidden" id="logout-note" data-i18n="logoutForgets">Signing out also forgets this device.</p>
      <button type="button" class="ghost hidden" id="logout" aria-describedby="logout-note" data-i18n="logout">Sign out</button>
    </div>
  </div>
  <main id="main" tabindex="-1">
    <p class="muted hidden" id="boot" role="status" data-i18n="signingIn">Signing in…</p>
    ${LOGIN_HTML}

    <div class="hidden" id="main-view">
    ${PAGES_HTML}
    </div>
    <p class="toast hidden" id="toast" role="status"></p>
  </main>
</div>
</body>
</html>
`;

export const ADMIN_JS = String.raw`"use strict";
(function () {
  var T = {
    en: {
      title: "Narrarium server", logout: "Sign out", loginTitle: "Sign in", loginHelp: "Enter the admin code of this server. To see it, run on this computer:",
      adminCode: "Admin code", signIn: "Sign in", newCode: "New admin code (shown once):", overview: "This server", updates: "Updates", check: "Check again",
      pairTitle: "Connect a client", pairHelp: "In Narrarium open Settings → Personal server, choose Pair and type this code. Then approve the request here.",
      pairStart: "Generate a pairing code", clientsTitle: "Clients", name: "Name", permissions: "Permissions", created: "Created", lastSeen: "Last seen",
      clientName: "Client name", allowUpdates: "Also allow updating the server", issueToken: "Create token", tokenOnce: "Token (shown once):", copy: "Copy",
      aiTitle: "AI endpoints", aiHelp: "The server calls only the AI endpoints you approve, and only then sends an API key there. The endpoints of a configuration sent by a client wait here, with the address requests start with.",
      networkTitle: "Approved network", aiBases: "Approved AI endpoints (one address per line: an origin, or an origin and a path)", origins: "Extra client origins (one per line)",
      spendTitle: "AI spending", spendHelp: "Limits that only you can set, whatever a client asks for. When one is reached no AI call is made: the autopilot stops with a message and resumes later.",
      spendState: "AI calls", spendOn: "allowed", spendOff: "paused by you", spendToday: "Today (UTC {day})", spendUsed: "{tokens} tokens · {calls} calls", spendCostUsed: " · {cost} {currency}", spendUnknown: " · {n} calls with no known cost",
      spendTokensDay: "Tokens per day, UTC (0 = no limit)", spendCostDay: "Cost per day, in the currency of the AI settings (0 = no limit)", spendTokensRun: "Tokens per run (0 = no limit)", spendCostRun: "Cost per run (0 = no limit)",
      spendSave: "Save limits", spendPause: "Pause AI spending", spendResume: "Resume AI spending", spendPauseConfirm: "Pause all AI spending now? Every autopilot stops at once and nothing more is sent to any AI provider until you resume.",
      publicUrl: "Public API address (https://, for example a Cloudflare hostname)", adminPublicUrl: "Public admin address (optional)",
      remoteAdmin: "Serve this panel on its public address", save: "Save", tunnelHelp: "Create a remotely-managed tunnel in the Cloudflare dashboard, route a hostname to http://127.0.0.1 and the API port, install cloudflared 2025.4.0 or newer, then paste the connector token.",
      tunnelToken: "Connector token", tunnelHost: "Hostname (https://, informational)", tunnelSave: "Save and start", restart: "Restart", remove: "Remove",
      booksTitle: "Books on this server", codeTitle: "Admin code", codeNew: "New code (32-200 characters)", codeRepeat: "Repeat the new code", codeSet: "Set this code",
      codeRotate: "Generate a random code", label: "Name", serverId: "Server id", fingerprint: "Fingerprint", version: "Version", engine: "Engine", api: "API", admin: "Admin panel",
      data: "Data folder", git: "git", supervisor: "Supervisor", yes: "yes", no: "no", supervisedYes: "active: remote updates possible", supervisedNo: "not active: start with npx narrarium-server start",
      installed: "Installed", latest: "Latest on npm", updateTo: "Update to {v}", updateConfirm: "Update the server to {v}? It stops, installs the verified package and restarts.",
      updateRequested: "Update requested: the server will restart in a moment.", lastUpdate: "Last update {from} → {to}: {outcome}, {at}", completed: "completed", failed: "failed",
      checking: "Checking npm…", updatesFailed: "The update check did not answer. Try again in a moment.",
      reasons: { available: "Version {v} is available, signed by npm and attested by the Narrarium publishing workflow.", up_to_date: "This server runs the latest verified version.", not_published: "The server package is not published on npm yet.", no_trusted_release: "The latest npm release is not signed and attested by the Narrarium publishing workflow, so it is not offered.", unavailable: "npm cannot be checked right now.", no_supervisor: "Version {v} is available. To install it from here, start the server with npx narrarium-server start (without --direct).", missing_scope: "Version {v} is available." },
      outcomes: { completed: "completed", failed: "not installed, the previous version stays active", limited: "not done, limit of three updates per hour reached", stopping: "not done, the server did not stop in time" },
      pending: "Waiting for the supervisor: {v}", noBooks: "No books yet. Move a book here from its Autopilot page in Narrarium.", noPending: "No endpoint waiting for approval.",
      approved: "Approved: {list}", none: "none", approve: "Approve", dismiss: "Dismiss", revoke: "Revoke", regenerate: "New token", revoked: "revoked", active: "active",
      pairCode: "Code for the client (valid until {t}):", pairWaiting: "Waiting for a client to type the code…", pairRequest: "{label} asks to connect.", pairApprove: "Approve",
      pairCancel: "Cancel", pairApproved: "Approved: the client receives its token now.", allowUpdatesShort: "allow updates", copied: "Copied.", saved: "Saved.",
      source: "Source", verification: "Code", thisComputer: "this computer", pairFrom: "From {source}", pairVerify: "Your device should show the code {code}. If it does not, or the source is not yours, cancel.", pairReject: "Reject",
      unknownSource: "unknown",
      sessionExpired: "Session expired: sign in again.", codeMismatch: "The two codes differ.", rotateConfirm: "Replace the admin code with a random one? You will sign in again.",
      removeConfirm: "Remove the Cloudflare token and stop the connector?", regenerateConfirm: "Create a new token for this client? The old one stops working.",
      tunnelEnabled: "Enabled", tunnelProcess: "Connector", tunnelBinary: "cloudflared", tunnelOther: "Other connectors", tunnelHostLabel: "Hostname", running: "running", stopped: "stopped",
      tunnelFailed: "stopped with an error", available: "available", missing: "missing", detected: "detected (left untouched)", maintenance: "restarting for an update",
      defaults: "Always allowed: {list}", status: { idle: "ready", running: "running", paused: "paused", "waiting-author": "waiting for the author", error: "stopped by an error", completed: "completed" },
      local: "local", github: "GitHub", working: "autopilot running", lang: "IT",
      mcpTitle: "Connected apps (MCP)", mcpHelp: "Every book has its own MCP address. Paste it in ChatGPT or Claude: they send you to a page of this server where you prove it is you with a passkey or the admin code, and choose what the app may do with that book.",
      mcpNoPublic: "This server has no public address yet: apps on other computers cannot reach it and passkeys cannot be used. Set the public API address in Approved network.",
      mcpEnabled: "MCP on", mcpAddress: "Address", mcpSlug: "Address name (slug)", mcpSlugChange: "Change", mcpNoApps: "No app is connected to this book.",
      mcpAppFrom: "returns to {host}", mcpLastUsed: "last used {when}", mcpRevoked: "Access revoked.",
      mcpOffConfirm: "Switching MCP off disconnects the {n} app(s) connected to this book, and they will have to ask you again. Continue?",
      mcpSlugConfirm: "Changing the address disconnects the {n} app(s) connected to this book, and they will have to ask you again. Continue?",
      passkeysTitle: "Passkeys", passkeysHelp: "A passkey lets you approve an app on the consent page with your fingerprint, face or screen lock. The admin code always works as well.",
      passkeyAdd: "Add a passkey", passkeyLink: "Open this address on the device that will keep the passkey (valid ten minutes, works once):", passkeyNone: "No passkey yet: the admin code is the only way to approve an app.",
      passkeyName: "Name of the passkey", passkeyRename: "Rename", passkeyUsed: "used {when}", passkeyOtherHost: "for another address: it cannot be used now",
      passkeyLastConfirm: "This is your last passkey. After removing it the admin code is the only way to approve an app (it keeps working). Remove it?",
      auditTitle: "Recent calls", auditHelp: "Who called which tool, on which book, and when. What the book says is never recorded here.", auditWhen: "When", auditCaller: "Caller", auditBook: "Book",
      auditTool: "Tool", auditResult: "Result", auditMore: "Older calls", auditNone: "No call yet.", auditOk: "done", auditFailed: "failed: {code}"
    },
    it: {
      title: "Server Narrarium", logout: "Esci", loginTitle: "Accedi", loginHelp: "Inserisci il codice amministratore di questo server. Per vederlo, esegui su questo computer:",
      adminCode: "Codice amministratore", signIn: "Accedi", newCode: "Nuovo codice amministratore (mostrato una volta):", overview: "Questo server", updates: "Aggiornamenti", check: "Controlla di nuovo",
      pairTitle: "Collega un client", pairHelp: "In Narrarium apri Impostazioni → Server personale, scegli Abbina e digita questo codice. Poi approva la richiesta qui.",
      pairStart: "Genera un codice di abbinamento", clientsTitle: "Client", name: "Nome", permissions: "Permessi", created: "Creato", lastSeen: "Ultimo accesso",
      clientName: "Nome del client", allowUpdates: "Consenti anche di aggiornare il server", issueToken: "Crea token", tokenOnce: "Token (mostrato una volta):", copy: "Copia",
      aiTitle: "Endpoint AI", aiHelp: "Il server chiama solo gli endpoint AI che approvi, e solo allora vi invia una chiave API. Gli endpoint di una configurazione inviata da un client attendono qui, con l'indirizzo da cui partono le richieste.",
      networkTitle: "Rete approvata", aiBases: "Endpoint AI approvati (un indirizzo per riga: un'origine, oppure origine e percorso)", origins: "Origini client aggiuntive (una per riga)",
      spendTitle: "Spesa AI", spendHelp: "Limiti che solo tu puoi impostare, qualunque cosa chieda un client. Quando se ne raggiunge uno non parte nessuna chiamata AI: l'autopilot si ferma con un messaggio e riprende dopo.",
      spendState: "Chiamate AI", spendOn: "consentite", spendOff: "in pausa (deciso da te)", spendToday: "Oggi (UTC {day})", spendUsed: "{tokens} token · {calls} chiamate", spendCostUsed: " · {cost} {currency}", spendUnknown: " · {n} chiamate senza costo noto",
      spendTokensDay: "Token al giorno, UTC (0 = nessun limite)", spendCostDay: "Costo al giorno, nella valuta delle impostazioni AI (0 = nessun limite)", spendTokensRun: "Token per corsa (0 = nessun limite)", spendCostRun: "Costo per corsa (0 = nessun limite)",
      spendSave: "Salva i limiti", spendPause: "Metti in pausa la spesa AI", spendResume: "Riattiva la spesa AI", spendPauseConfirm: "Mettere in pausa tutta la spesa AI adesso? Ogni autopilot si ferma subito e non viene inviato altro a nessun provider AI finché non riattivi.",
      publicUrl: "Indirizzo pubblico dell'API (https://, per esempio un hostname Cloudflare)", adminPublicUrl: "Indirizzo pubblico del pannello (facoltativo)",
      remoteAdmin: "Servi questo pannello anche sul suo indirizzo pubblico", save: "Salva", tunnelHelp: "Crea un tunnel gestito da remoto nella dashboard Cloudflare, instrada un hostname verso http://127.0.0.1 e la porta dell'API, installa cloudflared 2025.4.0 o successivo, poi incolla il token del connettore.",
      tunnelToken: "Token del connettore", tunnelHost: "Hostname (https://, informativo)", tunnelSave: "Salva e avvia", restart: "Riavvia", remove: "Rimuovi",
      booksTitle: "Libri su questo server", codeTitle: "Codice amministratore", codeNew: "Nuovo codice (32-200 caratteri)", codeRepeat: "Ripeti il nuovo codice", codeSet: "Imposta questo codice",
      codeRotate: "Genera un codice casuale", label: "Nome", serverId: "Id del server", fingerprint: "Impronta", version: "Versione", engine: "Motore", api: "API", admin: "Pannello",
      data: "Cartella dati", git: "git", supervisor: "Supervisore", yes: "sì", no: "no", supervisedYes: "attivo: aggiornamenti remoti possibili", supervisedNo: "non attivo: avvia con npx narrarium-server start",
      installed: "Installata", latest: "Ultima su npm", updateTo: "Aggiorna a {v}", updateConfirm: "Aggiornare il server a {v}? Si ferma, installa il pacchetto verificato e riparte.",
      updateRequested: "Aggiornamento richiesto: il server ripartirà tra poco.", lastUpdate: "Ultimo aggiornamento {from} → {to}: {outcome}, {at}", completed: "completato", failed: "non riuscito",
      checking: "Controllo di npm…", updatesFailed: "Il controllo degli aggiornamenti non ha risposto. Riprova tra poco.",
      reasons: { available: "È disponibile la versione {v}, firmata da npm e attestata dal flusso di pubblicazione di Narrarium.", up_to_date: "Questo server esegue l'ultima versione verificata.", not_published: "Il pacchetto del server non è ancora pubblicato su npm.", no_trusted_release: "L'ultima release su npm non è firmata e attestata dal flusso di pubblicazione di Narrarium, quindi non viene proposta.", unavailable: "Al momento non è possibile controllare npm.", no_supervisor: "È disponibile la versione {v}. Per installarla da qui, avvia il server con npx narrarium-server start (senza --direct).", missing_scope: "È disponibile la versione {v}." },
      outcomes: { completed: "completato", failed: "non installato, resta attiva la versione precedente", limited: "non eseguito, raggiunto il limite di tre aggiornamenti all'ora", stopping: "non eseguito, il server non si è fermato in tempo" },
      pending: "In attesa del supervisore: {v}", noBooks: "Nessun libro. Sposta qui un libro dalla sua pagina Autopilot in Narrarium.", noPending: "Nessun endpoint in attesa di approvazione.",
      approved: "Approvati: {list}", none: "nessuno", approve: "Approva", dismiss: "Ignora", revoke: "Revoca", regenerate: "Nuovo token", revoked: "revocato", active: "attivo",
      pairCode: "Codice per il client (valido fino alle {t}):", pairWaiting: "In attesa che un client digiti il codice…", pairRequest: "{label} chiede di collegarsi.", pairApprove: "Approva",
      pairCancel: "Annulla", pairApproved: "Approvato: il client riceve ora il suo token.", allowUpdatesShort: "consenti aggiornamenti", copied: "Copiato.", saved: "Salvato.",
      source: "Origine", verification: "Codice", thisComputer: "questo computer", pairFrom: "Da {source}", pairVerify: "Il tuo dispositivo deve mostrare il codice {code}. Se non lo mostra, o l'origine non è tua, annulla.", pairReject: "Rifiuta",
      unknownSource: "sconosciuta",
      sessionExpired: "Sessione scaduta: accedi di nuovo.", codeMismatch: "I due codici sono diversi.", rotateConfirm: "Sostituire il codice amministratore con uno casuale? Dovrai accedere di nuovo.",
      removeConfirm: "Rimuovere il token Cloudflare e fermare il connettore?", regenerateConfirm: "Creare un nuovo token per questo client? Quello vecchio smette di funzionare.",
      tunnelEnabled: "Attivo", tunnelProcess: "Connettore", tunnelBinary: "cloudflared", tunnelOther: "Altri connettori", tunnelHostLabel: "Hostname", running: "in esecuzione", stopped: "fermo",
      tunnelFailed: "fermo per un errore", available: "disponibile", missing: "mancante", detected: "rilevati (non toccati)", maintenance: "riavvio per aggiornamento",
      defaults: "Sempre consentite: {list}", status: { idle: "pronto", running: "in esecuzione", paused: "in pausa", "waiting-author": "aspetta l'autore", error: "fermo per un errore", completed: "completato" },
      local: "locale", github: "GitHub", working: "autopilot al lavoro", lang: "EN",
      mcpTitle: "App collegate (MCP)", mcpHelp: "Ogni libro ha il suo indirizzo MCP. Incollalo in ChatGPT o Claude: ti mandano a una pagina di questo server dove dimostri che sei tu con una passkey o il codice amministratore, e scegli cosa l'app può fare con quel libro.",
      mcpNoPublic: "Questo server non ha ancora un indirizzo pubblico: le app su altri computer non lo raggiungono e le passkey non si possono usare. Imposta l'indirizzo pubblico dell'API in Rete approvata.",
      mcpEnabled: "MCP attivo", mcpAddress: "Indirizzo", mcpSlug: "Nome dell'indirizzo (slug)", mcpSlugChange: "Cambia", mcpNoApps: "Nessuna app è collegata a questo libro.",
      mcpAppFrom: "torna a {host}", mcpLastUsed: "ultimo uso {when}", mcpRevoked: "Accesso revocato.",
      mcpOffConfirm: "Spegnere l'MCP scollega le {n} app collegate a questo libro, che dovranno chiederti di nuovo il permesso. Continuare?",
      mcpSlugConfirm: "Cambiare l'indirizzo scollega le {n} app collegate a questo libro, che dovranno chiederti di nuovo il permesso. Continuare?",
      passkeysTitle: "Passkey", passkeysHelp: "Una passkey ti permette di approvare un'app nella pagina di consenso con impronta, volto o blocco schermo. Il codice amministratore funziona sempre.",
      passkeyAdd: "Aggiungi una passkey", passkeyLink: "Apri questo indirizzo sul dispositivo che terrà la passkey (valido dieci minuti, funziona una volta):", passkeyNone: "Nessuna passkey: il codice amministratore è l'unico modo per approvare un'app.",
      passkeyName: "Nome della passkey", passkeyRename: "Rinomina", passkeyUsed: "usata {when}", passkeyOtherHost: "per un altro indirizzo: ora non si può usare",
      passkeyLastConfirm: "È la tua ultima passkey. Dopo averla rimossa il codice amministratore è l'unico modo per approvare un'app (continua a funzionare). Rimuoverla?",
      auditTitle: "Chiamate recenti", auditHelp: "Chi ha chiamato quale strumento, su quale libro, e quando. Quello che dice il libro non viene mai registrato qui.", auditWhen: "Quando", auditCaller: "Chiamante", auditBook: "Libro",
      auditTool: "Strumento", auditResult: "Esito", auditMore: "Chiamate precedenti", auditNone: "Nessuna chiamata finora.", auditOk: "eseguita", auditFailed: "non riuscita: {code}"
    }
  };
  var ROUTES = ${JSON.stringify(PAGES.map((page) => page.id))};
  var PAGE_TITLES = ${JSON.stringify(Object.fromEntries(PAGES.map((page) => [page.id, page.title])))};
  var LOADING = ["health-rows", "runs-rows", "history-rows", "log-rows", "client-rows", "audit-rows", "device-rows"];
  var MAX_DEVICES = 20;
  var SEEN_KEY = "narrarium-admin-seen:" + location.origin;
  var lang = localStorage.getItem("narrarium-admin-lang") || ((navigator.language || "en").toLowerCase().indexOf("it") === 0 ? "it" : "en");
  var csrf = "";
  /** Whether the server has accepted this page: a tab that opens with the cookie of a session has no token for changes yet, but it is in. */
  var signed = false;
  var state = null;
  var timer = null;
  var pairCode = null;
  var mcp = null;
  var audit = { rows: [], next: null, older: false };
  var updatesInfo = null;
  var route = "";
  var polling = false;
  var memo = {};
  var dirty = {};
  var tilesSeen = "";

  function t(key, values) {
    var text = (T[lang] && T[lang][key]) || T.en[key] || key;
    if (values) Object.keys(values).forEach(function (name) { text = text.split("{" + name + "}").join(String(values[name])); });
    return text;
  }
  function pick(group, key, values) {
    var table = t(group); var text = (table && table[key]) || "";
    if (values) Object.keys(values).forEach(function (name) { text = text.split("{" + name + "}").join(String(values[name])); });
    return text;
  }
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; }
  function when(iso) { if (!iso) return "—"; var date = new Date(iso); return isNaN(date.getTime()) ? "—" : date.toLocaleString(lang === "it" ? "it-IT" : "en-GB"); }
  function toast(text) { var box = $("toast"); box.textContent = text; box.classList.remove("hidden"); clearTimeout(toast.timer); toast.timer = setTimeout(function () { box.classList.add("hidden"); }, 5000); }
  function fail(error) { toast(error && error.message ? error.message : String(error)); }
  /** What a poll asks for again and finds unchanged is not drawn again: a keyboard that is on a button of a table does not lose it every twenty seconds. */
  function unchanged(key, data, quiet) {
    var text = JSON.stringify(data);
    if (quiet && memo[key] === text) return true;
    memo[key] = text; return false;
  }

  function applyTexts() {
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-i18n]").forEach(function (node) { node.textContent = t(node.getAttribute("data-i18n")); });
    document.querySelectorAll("[data-i18n-placeholder]").forEach(function (node) { node.setAttribute("placeholder", t(node.getAttribute("data-i18n-placeholder"))); });
    $("lang").textContent = t("lang");
    $("lang").setAttribute("aria-label", t("langSwitch", { code: t("lang"), language: t("langOther") }));
    $("nav").setAttribute("aria-label", t("navLabel"));
    tilesSeen = "";
    if (state) render();
    if (mcp) renderMcp();
    renderAudit();
    renderViews();
    renderDevices();
    renderChrome();
    updateTitle();
  }

  // ---- talking to the server
  function send(method, path, body) {
    var headers = { "content-type": "application/json" };
    if (method === "POST") headers["x-csrf-token"] = csrf;
    return fetch(path, { method: method, headers: headers, credentials: "same-origin", body: body === undefined ? undefined : JSON.stringify(body) }).then(function (response) {
      return response.text().then(function (text) {
        var data = {}; try { data = text ? JSON.parse(text) : {}; } catch (error) { data = {}; }
        return { status: response.status, ok: response.ok, data: data };
      });
    });
  }
  /** A request that finds the session over signs in again with the device's token, if this device is remembered, and goes on; if not, or if the token is refused, the sign-in is shown. */
  function recover(method, path, body) {
    return silentLogin().then(function () { return call(method, path, body, true); }, function (error) { if (error && error.rejected) signOut(error.message); throw error; });
  }
  function call(method, path, body, again) {
    return send(method, path, body).then(function (answer) {
      if (path === "/admin/api/login") { if (!answer.ok) throw new Error(answer.data.message || ("HTTP " + answer.status)); return answer.data; }
      if (answer.status === 401 && !again) return recover(method, path, body);
      if (answer.status === 403 && answer.data.code === "csrf" && !again) {
        // Another tab signed in since, and the cookie is of that session: ask for the token that goes with it.
        return send("GET", "/admin/api/session").then(function (fresh) {
          if (fresh.ok && typeof fresh.data.csrf === "string") { csrf = fresh.data.csrf; sessionStorage.setItem("narrarium-admin-csrf", csrf); return call(method, path, body, true); }
          if (fresh.status === 401) return recover(method, path, body);
          throw new Error(answer.data.message || "HTTP 403");
        });
      }
      if (answer.status === 401) { signOut(t("sessionExpired")); throw new Error(t("sessionExpired")); }
      if (!answer.ok) throw new Error(answer.data.message || ("HTTP " + answer.status));
      return answer.data;
    });
  }

  // ---- signing in and out
  /** A mark (no secret in it) that this browser has been in: a page that opens asks the server whether the session is still there only if it was. */
  function markSeen(yes) { try { if (yes) localStorage.setItem(SEEN_KEY, "1"); else localStorage.removeItem(SEEN_KEY); } catch (error) { /* a browser that keeps nothing just asks for the code */ } }
  function wasSeen() { try { return localStorage.getItem(SEEN_KEY) === "1"; } catch (error) { return false; } }
  function signOut(message) {
    var wasIn = !$("main-view").classList.contains("hidden");
    csrf = ""; signed = false; state = null; mcp = null; updatesInfo = null; pairCode = null; audit = { rows: [], next: null, older: false }; route = ""; memo = {}; dirty = {}; tilesSeen = "";
    sessionStorage.removeItem("narrarium-admin-csrf"); markSeen(false);
    $("main-view").classList.add("hidden"); $("boot").classList.add("hidden"); $("login-view").classList.remove("hidden");
    $("logout").classList.add("hidden"); $("logout-note").classList.add("hidden"); $("menu-button").classList.add("hidden");
    $("layout").classList.remove("signed"); closeMenu();
    $("pills").textContent = ""; $("subtitle").textContent = ""; $("ov-tiles").textContent = ""; $("ov-books-list").textContent = "";
    // What was on the pages goes with the session: nothing of the server (not a token that was shown once) stays in a page that asks for the code.
    ["client-rows", "audit-rows", "mcp-books", "passkey-rows", "ai-pending", "ai-approved", "facts", "spend-facts", "tunnel-facts", "pairing-box", "token-value", "passkey-link-value"].forEach(function (id) { $(id).textContent = ""; });
    $("token-box").classList.add("hidden"); $("passkey-link-box").classList.add("hidden");
    if (timer) { clearInterval(timer); timer = null; }
    resetViews(); resetDevices(); renderBadges();
    $("login-error").textContent = message || "";
    updateTitle();
    if (wasIn && $("login-title").focus) $("login-title").focus();
  }
  function signedIn() {
    signed = true; markSeen(true);
    $("login-view").classList.add("hidden"); $("boot").classList.add("hidden"); $("main-view").classList.remove("hidden"); $("login-error").textContent = "";
    $("layout").classList.add("signed"); $("logout").classList.remove("hidden"); $("menu-button").classList.remove("hidden");
    showLoading(LOADING);
    show(routeOf(location.hash) || "overview", false);
    refresh(); loadUpdates(); loadMcp(); loadAudit(false); loadViews(); loadDevices();
    renderChrome();
    if (!timer) timer = setInterval(poll, 20000);
  }
  function poll() {
    if (document.visibilityState !== "visible") return;
    polling = true;
    try { refresh(true); loadMcp(); if (!audit.older) loadAudit(false); loadViews(); loadDevices(); } finally { polling = false; }
  }

  // ---- pages: one at a time, each at an address of its own
  function routeOf(hash) { var match = /^#\/([a-z]+)\/?$/.exec(hash || ""); return match && ROUTES.indexOf(match[1]) >= 0 ? match[1] : ""; }
  function updateTitle() { document.title = t(route && !$("main-view").classList.contains("hidden") ? PAGE_TITLES[route] : "loginTitle") + " · " + t("title"); }
  function closeMenu() { $("layout").classList.remove("nav-open"); $("menu-button").setAttribute("aria-expanded", "false"); }
  /** What a page shows is read again when it is opened, so a page that was left a while ago is not stale. */
  function visit(id) {
    if (id === "overview") { refresh(true); loadHealth(); loadRuns(); loadRisks(); }
    else if (id === "books") loadRuns();
    else if (id === "updates") { loadUpdates(); loadHistory(); }
    else if (id === "clients" || id === "ai" || id === "network") refresh(true);
    else if (id === "apps") { loadMcp(); if (!audit.older) loadAudit(false); }
    else if (id === "log") { if (!actionLog.older) loadLog(false); }
    else if (id === "security") { loadRisks(); loadDevices(); }
  }
  function show(next, moved) {
    route = next;
    // The page that opens with no address in the URL gets its own entry, so that going back from the next one comes back to it.
    if (!moved && location.hash !== "#/" + next && typeof history !== "undefined" && history.replaceState) history.replaceState(null, "", "#/" + next);
    ROUTES.forEach(function (id) {
      var link = $("nav-" + id);
      if (id === next) { $("page-" + id).classList.remove("hidden"); link.setAttribute("aria-current", "page"); }
      else { $("page-" + id).classList.add("hidden"); link.removeAttribute("aria-current"); }
    });
    closeMenu(); updateTitle();
    if (typeof window.scrollTo === "function") window.scrollTo(0, 0);
    if (moved) { var heading = $("title-" + next); if (heading && heading.focus) heading.focus(); visit(next); }
  }
  function onHash() {
    if ($("main-view").classList.contains("hidden")) return;
    var next = routeOf(location.hash) || (location.hash ? "" : "overview");
    if (next && next !== route) show(next, true);
  }

  // ---- what the navigation and the first page say at a glance
  function setCount(id, count, key, tone) {
    var node = $("badge-" + id); node.textContent = "";
    if (!count) { node.className = "count hidden"; return; }
    node.className = "count " + tone;
    var number = el("span", "", String(count)); number.setAttribute("aria-hidden", "true");
    node.appendChild(number); node.appendChild(el("span", "sr-only", plural(key, count, { n: count })));
  }
  function updateAvailable(info) { return !!info && (info.available === true || info.canRequest === true); }
  function renderBadges() {
    var attention = health && health.attention ? health.attention.length : 0;
    var running = runs && typeof runs.running === "number" ? runs.running : 0;
    var review = risks && risks.counts ? (risks.counts.high || 0) + (risks.counts.medium || 0) : 0;
    var waiting = state && state.pairing && state.pairing.requested && !state.pairing.approved ? 1 : 0;
    var pending = state && state.pendingAiBases ? state.pendingAiBases.length : 0;
    setCount("overview", attention, "badgeAttention", "warn");
    setCount("books", running, "badgeRunning", "ok");
    setCount("updates", updateAvailable(updatesInfo) ? 1 : 0, "badgeUpdate", "info");
    setCount("clients", waiting, "badgeClient", "warn");
    setCount("ai", pending, "badgeAi", "warn");
    setCount("security", review, "badgeRisks", risks && risks.counts && risks.counts.high ? "bad" : "warn");
  }
  function tile(label, value, sub, href) {
    var node = el(href ? "a" : "div", "tile"); if (href) node.setAttribute("href", href);
    node.appendChild(el("span", "tile-label", label));
    var big = el("span", "tile-value"); if (typeof value === "string") big.textContent = value; else big.appendChild(value);
    node.appendChild(big);
    if (sub) node.appendChild(el("span", "tile-sub", sub));
    return node;
  }
  function renderTiles() {
    var box = $("ov-tiles");
    if (!state) { box.textContent = ""; return; }
    var made = [];
    var attention = health && health.attention ? health.attention : null;
    var healthValue = !health ? t("loading") : attention.length ? badge(plural("badgeAttention", attention.length, { n: attention.length }), "warn", "!") : badge(t("healthOk"), "ok", "✓");
    made.push(["health", t("tileHealth"), healthValue, attention && attention.length ? attention.map(function (id) { return pick("healthNames", id) || id; }).join(", ") : "", ""]);
    var total = runs ? runs.total : state.books.length;
    made.push(["books", t("tileBooks"), runs ? t("tileBooksValue", fill({ running: runs.running, max: runs.maxConcurrentRuns })) : t("loading"), runs ? (total ? plural("tileBooksSub", total, { total: total }) : t("tileBooksNone")) : "", "#/books"]);
    var news = !updatesInfo ? t("loading") : updateAvailable(updatesInfo) && updatesInfo.latestVersion ? badge(t("tileUpdateAvailable", { v: updatesInfo.latestVersion }), "info", "↑") : updatesInfo.reason === "up_to_date" ? badge(t("tileUpToDate"), "ok", "✓") : badge(t("tileUpdateUnknown"), "off", "?");
    made.push(["updates", t("tileUpdates"), news, updatesInfo && updatesInfo.installedVersion ? t("tileInstalled", { v: updatesInfo.installedVersion }) : "", "#/updates"]);
    var counts = risks && risks.counts ? risks.counts : null; var review = counts ? (counts.high || 0) + (counts.medium || 0) : 0;
    var parts = []; if (counts) ["high", "medium", "note"].forEach(function (level) { if (counts[level]) parts.push(many("riskCounts", level, counts[level], { n: counts[level] })); });
    var riskValue = !counts ? t("loading") : review ? badge(plural("tileRisksSome", review, { n: review }), counts.high ? "bad" : "warn", counts.high ? "✕" : "!") : badge(t("tileRisksNone"), "ok", "✓");
    made.push(["security", t("tileSecurity"), riskValue, parts.join(", "), "#/security"]);
    var signature = JSON.stringify(made.map(function (entry) { return [entry[0], typeof entry[2] === "string" ? entry[2] : entry[2].textContent, entry[3], entry[4]]; })) + lang;
    if (signature === tilesSeen) return;
    tilesSeen = signature; box.textContent = "";
    made.forEach(function (entry) { box.appendChild(tile(entry[1], entry[2], entry[3], entry[4] || "")); });
  }
  function renderGlance() {
    var list = $("ov-books-list"); var note = $("ov-books-note"); list.textContent = ""; note.textContent = "";
    if (!state) return;
    if (!runs) { list.appendChild(el("li", "loading", t("loading"))); return; }
    var books = runs.books || [];
    if (!books.length) { list.appendChild(el("li", "empty-state", t("noBooks"))); return; }
    books.slice(0, 5).forEach(function (book) {
      var item = el("li"); item.appendChild(el("span", "glance-title", book.title));
      var tone = RUN_TONE[book.state] || ["off", "–"]; item.appendChild(badge(pick("runsStates", book.state) || book.state, tone[0], tone[1]));
      if (book.chapter) item.appendChild(el("span", "muted small", t("runsChapter", { current: book.chapter.current, total: book.chapter.total })));
      list.appendChild(item);
    });
    if (runs.total > 5) note.textContent = t("ovMore", { n: runs.total - 5 });
  }
  function renderChrome() {
    renderBadges(); renderTiles(); renderGlance();
    var remembered = !$("main-view").classList.contains("hidden") && !!readDevice();
    if (remembered) $("logout-note").classList.remove("hidden"); else $("logout-note").classList.add("hidden");
  }

  function editing() { var active = document.activeElement; return active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA") && active.closest("form"); }
  function refresh(quiet) {
    return call("GET", "/admin/api/status").then(function (data) { if (unchanged("status", data, quiet)) return; state = data; render(quiet); }).catch(function (error) { if (!quiet) fail(error); });
  }
  function fact(list, label, value, copy, shown) {
    list.appendChild(el("dt", "", label));
    var dd = el("dd", "", shown || value);
    if (copy) { var button = el("button", "ghost small", t("copy")); button.type = "button"; button.addEventListener("click", function () { navigator.clipboard.writeText(value).then(function () { toast(t("copied")); }, fail); }); dd.appendChild(document.createTextNode(" ")); dd.appendChild(button); }
    list.appendChild(dd);
  }
  function pill(text, kind) { $("pills").appendChild(el("span", "pill " + (kind || ""), text)); }
  function render(quiet) {
    var s = state; if (!s) return;
    $("subtitle").textContent = s.label;
    $("pills").textContent = "";
    pill("v" + s.serverVersion);
    pill(t("supervisor") + ": " + (s.supervised ? t("yes") : t("no")), s.supervised ? "ok" : "warn");
    if (s.tunnel && s.tunnel.enabled) pill("Cloudflare: " + (s.tunnel.process === "running" ? t("running") : s.tunnel.process === "failed" ? t("tunnelFailed") : t("stopped")), s.tunnel.process === "running" ? "ok" : s.tunnel.process === "failed" ? "bad" : "warn");
    if (s.maintenance) pill(t("maintenance"), "warn");
    if (s.aiCalls && !s.aiCalls.enabled) pill(t("callsPillOff"));
    if (s.books.some(function (book) { return book.running; })) pill(t("working"), "ok");
    var facts = $("facts"); facts.textContent = "";
    fact(facts, t("label"), s.label); fact(facts, t("serverId"), s.serverId); fact(facts, t("fingerprint"), s.fingerprint, true, s.fingerprint.replace(/(.{4})(?=.)/g, "$1 "));
    fact(facts, t("version"), s.serverVersion); fact(facts, t("engine"), s.engineVersion); fact(facts, t("api"), s.apiUrl, true);
    fact(facts, t("admin"), location.origin); fact(facts, t("data"), s.dataRoot); fact(facts, t("git"), s.git ? t("available") : t("missing"));
    fact(facts, t("supervisor"), s.supervised ? t("supervisedYes") : t("supervisedNo"));
    renderPairing(); renderClients(); renderAi(); renderSpend(quiet); renderAiCalls();
    if (!quiet || !editing()) renderNetwork();
    renderTunnel(); renderChrome();
  }
  function sourceName(source) { return !source ? t("unknownSource") : source === "local" ? t("thisComputer") : source; }
  function renderPairing() {
    var box = $("pairing-box"); box.textContent = ""; var p = state.pairing;
    if (pairCode && (!p || p.expiresAt < Date.now())) pairCode = null;
    if (pairCode) { box.appendChild(el("p", "muted", t("pairCode", { t: new Date(pairCode.expiresAt).toLocaleTimeString(lang === "it" ? "it-IT" : "en-GB") }))); box.appendChild(el("p", "pair-code", pairCode.code.replace(/(\d{3})(\d{3})(\d{3})/, "$1 $2 $3"))); }
    if (p && p.requested && !p.approved) {
      var row = el("div", "notice"); row.appendChild(el("p", "", t("pairRequest", { label: p.label || "?" })));
      row.appendChild(el("p", "muted small", [t("pairFrom", { source: sourceName(p.source) }), p.userAgent || "", p.requestedAt ? when(p.requestedAt) : ""].filter(Boolean).join(" · ")));
      if (p.verification) { var check = el("p", "", ""); check.appendChild(el("span", "pair-code", p.verification)); check.appendChild(document.createTextNode(" ")); check.appendChild(el("span", "muted small", t("pairVerify", { code: p.verification }))); row.appendChild(check); }
      var allow = el("label", "check"); var box2 = document.createElement("input"); box2.type = "checkbox"; allow.appendChild(box2); allow.appendChild(el("span", "", t("allowUpdatesShort"))); row.appendChild(allow);
      var actions = el("div", "row"); var approve = el("button", "", t("pairApprove")); approve.type = "button";
      approve.addEventListener("click", function () { call("POST", "/admin/api/pairing/approve", { id: p.id, allowUpdate: box2.checked }).then(function () { pairCode = null; toast(t("pairApproved")); refresh(); }, fail); });
      var cancel = el("button", "ghost danger", t("pairReject")); cancel.type = "button";
      cancel.addEventListener("click", function () { call("POST", "/admin/api/pairing/cancel", {}).then(function () { pairCode = null; refresh(); }, fail); });
      actions.appendChild(approve); actions.appendChild(cancel); row.appendChild(actions); box.appendChild(row);
    } else if (p && !p.approved) box.appendChild(el("p", "muted", t("pairWaiting")));
  }
  function renderClients() {
    var body = $("client-rows"); body.textContent = "";
    if (!state.clients.length) emptyRow(body, 7, t("clientsNone"));
    state.clients.slice().reverse().forEach(function (client) {
      var tr = trow(); if (client.revoked) tr.className = "revoked"; var named = rowHead(); named.textContent = client.label; tr.appendChild(named);
      var scopes = tcell("permissions", "wide"); client.scopes.forEach(function (scope) { scopes.appendChild(el("span", "chip" + (scope === "update" ? " update" : ""), scope)); }); tr.appendChild(scopes);
      var where = tcell("source"); where.appendChild(el("div", "", sourceName(client.source)));
      if (client.userAgent) { var agent = el("div", "muted small agent", client.userAgent); agent.title = client.userAgent; where.appendChild(agent); }
      tr.appendChild(where);
      var code = tcell("verification"); code.textContent = client.verification ? client.verification : "—"; tr.appendChild(code);
      var made = tcell("created"); made.textContent = when(client.createdAt); tr.appendChild(made);
      var seen = tcell("lastSeen"); seen.textContent = client.revoked ? t("revoked") : when(client.lastSeenAt); tr.appendChild(seen);
      var actions = tcell("colActions", "wide");
      if (!client.revoked) {
        var regenerate = el("button", "ghost small", t("regenerate")); regenerate.type = "button";
        regenerate.addEventListener("click", function () { if (!confirm(t("regenerateConfirm"))) return; call("POST", "/admin/api/token", { label: client.label, scopes: client.scopes, replaceId: client.id }).then(function (result) { showToken(result.token); refresh(); }, fail); });
        var revoke = el("button", "ghost small danger", t("revoke")); revoke.type = "button";
        revoke.addEventListener("click", function () { call("POST", "/admin/api/revoke", { id: client.id }).then(function () { toast(t("revoked")); refresh(); }, fail); });
        actions.appendChild(regenerate); actions.appendChild(document.createTextNode(" ")); actions.appendChild(revoke);
      }
      tr.appendChild(actions); body.appendChild(tr);
    });
  }
  function showToken(token) { $("token-value").textContent = token; $("token-box").classList.remove("hidden"); }
  function renderAi() {
    var list = $("ai-pending"); list.textContent = "";
    if (!state.pendingAiBases.length) list.appendChild(el("li", "muted", t("noPending")));
    state.pendingAiBases.forEach(function (base) {
      var li = el("li"); li.appendChild(el("code", "", base)); var row = el("span", "row");
      var approve = el("button", "small", t("approve")); approve.type = "button"; approve.addEventListener("click", function () { call("POST", "/admin/api/ai/approve", { bases: [base] }).then(function () { toast(t("saved")); refresh(); }, fail); });
      var dismiss = el("button", "ghost small", t("dismiss")); dismiss.type = "button"; dismiss.addEventListener("click", function () { call("POST", "/admin/api/ai/dismiss", { bases: [base] }).then(function () { refresh(); }, fail); });
      row.appendChild(approve); row.appendChild(dismiss); li.appendChild(row); list.appendChild(li);
    });
    $("ai-approved").textContent = t("approved", { list: state.allowedAiBases.length ? state.allowedAiBases.join(", ") : t("none") });
  }
  function renderSpend(quiet) {
    var s = state.spend; var card = $("spend");
    if (!s) { card.classList.add("hidden"); return; }
    card.classList.remove("hidden");
    var facts = $("spend-facts"); facts.textContent = "";
    fact(facts, t("spendState"), s.paused ? t("spendOff") : t("spendOn"));
    var today = s.today || {};
    var used = t("spendUsed", { tokens: today.tokens || 0, calls: today.calls || 0 });
    if (typeof today.cost === "number") used += t("spendCostUsed", { cost: today.cost, currency: today.currency || "" }).replace(/ $/, "");
    if (today.costUnknownCalls) used += t("spendUnknown", { n: today.costUnknownCalls });
    fact(facts, t("spendToday", { day: today.day || "" }), used);
    if (s.warning) fact(facts, "!", s.warning);
    $("spend-toggle").textContent = s.paused ? t("spendResume") : t("spendPause");
    if (!dirty["spend-form"] && (!quiet || !editing())) {
      var limits = s.limits || {};
      $("spend-tokens-day").value = String(limits.maxTokensPerDay || 0); $("spend-cost-day").value = String(limits.maxCostPerDay || 0);
      $("spend-tokens-run").value = String(limits.maxTokensPerRun || 0); $("spend-cost-run").value = String(limits.maxCostPerRun || 0);
    }
  }
  function renderAiCalls() {
    var c = state.aiCalls; var card = $("ai-calls");
    if (!c) { card.classList.add("hidden"); return; }
    card.classList.remove("hidden");
    var facts = $("ai-calls-facts"); facts.textContent = "";
    fact(facts, t("callsState"), c.enabled ? t("callsOn") : t("callsOff"));
    fact(facts, t("callsBudget"), t("callsBudgetValue", { size: bytes(c.budgetBytes) }));
    fact(facts, t("callsFree"), t("callsFreeValue", { size: bytes(c.minFreeBytes) }));
    $("ai-calls-toggle").textContent = c.enabled ? t("callsTurnOff") : t("callsTurnOn");
  }
  function renderNetwork() {
    if (dirty["network-form"]) return;
    $("net-ai").value = state.allowedAiBases.join("\n"); $("net-origins").value = state.origins.join("\n");
    $("net-default-origins").textContent = t("defaults", { list: state.defaultOrigins.join(", ") });
    $("net-public").value = state.publicUrl || ""; $("net-admin").value = state.adminPublicUrl || ""; $("net-remote-admin").checked = !!state.allowRemoteAdmin;
  }
  function renderTunnel() {
    var tunnel = state.tunnel || {}; var facts = $("tunnel-facts"); facts.textContent = "";
    fact(facts, t("tunnelEnabled"), tunnel.enabled ? t("yes") : t("no"));
    fact(facts, t("tunnelProcess"), tunnel.process === "running" ? t("running") : tunnel.process === "failed" ? t("tunnelFailed") : t("stopped"));
    fact(facts, t("tunnelBinary"), tunnel.binaryAvailable ? t("available") : t("missing"));
    if (tunnel.otherConnectorDetected) fact(facts, t("tunnelOther"), t("detected"));
    if (tunnel.hostname) fact(facts, t("tunnelHostLabel"), tunnel.hostname);
    if (tunnel.lastError) fact(facts, "!", tunnel.lastError);
  }
  function loadMcp() {
    var quiet = polling;
    return call("GET", "/admin/api/mcp").then(function (data) { if (unchanged("mcp", data, quiet)) return; mcp = data; renderMcp(); }, function () {});
  }
  function loadAudit(older) {
    var quiet = polling;
    var query = "?limit=20" + (older && audit.next ? "&before=" + audit.next : "");
    return call("GET", "/admin/api/mcp/audit" + query).then(function (page) {
      if (!older && unchanged("audit", page, quiet)) return;
      audit.rows = older ? audit.rows.concat(page.entries) : page.entries; audit.next = page.nextBefore; if (older) audit.older = true; renderAudit();
    }, function () {});
  }
  function chip(text) { return el("span", "chip", text); }
  function renderMcp() {
    if (!mcp) return;
    var note = $("mcp-public-note"); if (mcp.publicUrl) note.classList.add("hidden"); else note.classList.remove("hidden");
    var list = $("mcp-books"); list.textContent = "";
    if (!mcp.books.length) list.appendChild(el("li", "muted", t("noBooks")));
    mcp.books.forEach(function (book) { list.appendChild(renderMcpBook(book)); });
    renderPasskeys();
  }
  function renderMcpBook(book) {
    var li = el("li", "mcp-book"); var head = el("div", "mcp-head"); head.appendChild(el("strong", "", book.title));
    var label = el("label", "check"); var toggle = document.createElement("input"); toggle.type = "checkbox"; toggle.checked = !!book.enabled;
    label.appendChild(toggle); label.appendChild(el("span", "", t("mcpEnabled"))); head.appendChild(label); li.appendChild(head);
    toggle.addEventListener("change", function () {
      var on = toggle.checked;
      if (!on && book.apps.length && !confirm(t("mcpOffConfirm", { n: book.apps.length }))) { toggle.checked = true; return; }
      call("POST", "/admin/api/mcp/book", { bookId: book.bookId, enabled: on }).then(function () { toast(t("saved")); loadMcp(); }, function (error) { toggle.checked = !on; fail(error); });
    });
    var where = el("p", "muted small", t("mcpAddress") + ": "); where.appendChild(el("code", "", book.url)); li.appendChild(where);
    var row = el("div", "inline"); var slug = document.createElement("input"); slug.value = book.slug; slug.setAttribute("maxlength", "80"); slug.setAttribute("aria-label", t("mcpSlug")); slug.setAttribute("spellcheck", "false");
    var change = el("button", "ghost small", t("mcpSlugChange")); change.type = "button";
    change.addEventListener("click", function () {
      var value = slug.value.trim(); if (!value || value === book.slug) return;
      if (book.apps.length && !confirm(t("mcpSlugConfirm", { n: book.apps.length }))) { slug.value = book.slug; return; }
      call("POST", "/admin/api/mcp/book", { bookId: book.bookId, slug: value }).then(function () { toast(t("saved")); loadMcp(); }, fail);
    });
    row.appendChild(slug); row.appendChild(change); li.appendChild(row);
    var apps = el("ul", "list"); if (!book.apps.length) apps.appendChild(el("li", "muted small", t("mcpNoApps")));
    book.apps.forEach(function (app) {
      var item = el("li"); var who = el("span", "", app.name + " "); app.scopes.forEach(function (scope) { who.appendChild(chip(scope)); });
      who.appendChild(el("span", "muted small", " " + t("mcpAppFrom", { host: app.redirectHost }) + " · " + t("mcpLastUsed", { when: when(app.lastUsedAt) }))); item.appendChild(who);
      var revoke = el("button", "ghost small danger", t("revoke")); revoke.type = "button";
      revoke.addEventListener("click", function () { call("POST", "/admin/api/mcp/revoke", { id: app.id }).then(function () { toast(t("mcpRevoked")); loadMcp(); }, fail); });
      item.appendChild(revoke); apps.appendChild(item);
    });
    li.appendChild(apps);
    return li;
  }
  function renderPasskeys() {
    var list = $("passkey-rows"); list.textContent = "";
    if (!mcp.passkeys.length) list.appendChild(el("li", "muted", t("passkeyNone")));
    mcp.passkeys.forEach(function (key) {
      var li = el("li"); var info = el("span"); info.appendChild(el("strong", "", key.label));
      info.appendChild(el("span", "muted small", " " + [key.rpId, t("created") + " " + when(key.createdAt), key.lastUsedAt ? t("passkeyUsed", { when: when(key.lastUsedAt) }) : "", key.usable ? "" : t("passkeyOtherHost")].filter(Boolean).join(" · "))); li.appendChild(info);
      var actions = el("span", "row"); var name = document.createElement("input"); name.value = key.label; name.setAttribute("maxlength", "40"); name.setAttribute("aria-label", t("passkeyName"));
      var rename = el("button", "ghost small", t("passkeyRename")); rename.type = "button";
      rename.addEventListener("click", function () { call("POST", "/admin/api/passkeys/rename", { id: key.id, label: name.value }).then(function () { toast(t("saved")); loadMcp(); }, fail); });
      var remove = el("button", "ghost small danger", t("remove")); remove.type = "button";
      remove.addEventListener("click", function () {
        var last = mcp.passkeys.length === 1;
        if (last && !confirm(t("passkeyLastConfirm"))) return;
        call("POST", "/admin/api/passkeys/remove", last ? { id: key.id, confirmLast: true } : { id: key.id }).then(function () { toast(t("saved")); loadMcp(); }, fail);
      });
      actions.appendChild(name); actions.appendChild(rename); actions.appendChild(remove); li.appendChild(actions); list.appendChild(li);
    });
  }
  function renderAudit() {
    var body = $("audit-rows"); body.textContent = "";
    if (!audit.rows.length) emptyRow(body, 5, t("auditNone"));
    audit.rows.forEach(function (entry) {
      var tr = trow(); var moment = rowHead(); moment.textContent = when(entry.at); tr.appendChild(moment);
      [["auditCaller", entry.client], ["auditBook", entry.bookId], ["auditTool", entry.tool], ["auditResult", entry.ok ? t("auditOk") : t("auditFailed", { code: entry.code || "?" })]].forEach(function (pair) { var value = tcell(pair[0]); value.textContent = pair[1]; tr.appendChild(value); });
      body.appendChild(tr);
    });
    if (audit.next === null) $("audit-more").classList.add("hidden"); else $("audit-more").classList.remove("hidden");
  }
  function loadUpdates() {
    $("updates-message").textContent = t("checking"); $("updates-last").textContent = ""; $("update-now").classList.add("hidden");
    return call("GET", "/admin/api/updates").then(function (info) {
      updatesInfo = info; renderChrome();
      var reason = info.canRequest ? "available" : info.reason;
      var text = (reason && pick("reasons", reason, { v: info.latestVersion || "" })) || info.message;
      $("updates-message").textContent = t("installed") + ": " + info.installedVersion + (info.latestVersion ? " · " + t("latest") + ": " + info.latestVersion : "") + " — " + text;
      var last = info.lastUpdate ? t("lastUpdate", { outcome: pick("outcomes", info.lastUpdate.outcome) || t(info.lastUpdate.state), from: info.lastUpdate.fromVersion, to: info.lastUpdate.version, at: when(info.lastUpdate.at) }) : "";
      if (info.pending) last = (last ? last + " · " : "") + t("pending", { v: info.pending.version });
      $("updates-last").textContent = last;
      var button = $("update-now");
      if (info.canRequest && info.latestVersion) {
        button.textContent = t("updateTo", { v: info.latestVersion }); button.classList.remove("hidden");
        button.onclick = function () { if (!confirm(t("updateConfirm", { v: info.latestVersion }))) return; call("POST", "/admin/api/updates", { version: info.latestVersion, installedVersion: info.installedVersion }).then(function () { toast(t("updateRequested")); refresh(); loadUpdates(); }, fail); };
      } else button.classList.add("hidden");
    }).catch(function () { updatesInfo = null; $("updates-message").textContent = t("updatesFailed"); renderChrome(); });
  }
${VIEWS_JS}
${DEVICES_JS}
  function lines(id) { return $(id).value.split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean); }
  function copyText(id) { navigator.clipboard.writeText($(id).textContent).then(function () { toast(t("copied")); }, fail); }
  document.addEventListener("DOMContentLoaded", function () {
    applyTexts();
    bindViews();
    bindDevices();
    $("lang").addEventListener("click", function () { lang = lang === "it" ? "en" : "it"; localStorage.setItem("narrarium-admin-lang", lang); applyTexts(); if (state) loadUpdates(); });
    $("skip").addEventListener("click", function (event) { event.preventDefault(); $("main").focus(); });
    $("menu-button").addEventListener("click", function () {
      var open = !$("layout").classList.contains("nav-open");
      if (open) $("layout").classList.add("nav-open"); else $("layout").classList.remove("nav-open");
      $("menu-button").setAttribute("aria-expanded", open ? "true" : "false");
    });
    ROUTES.forEach(function (id) { $("nav-" + id).addEventListener("click", closeMenu); });
    document.addEventListener("keydown", function (event) { if (event.key === "Escape" && $("layout").classList.contains("nav-open")) { closeMenu(); $("menu-button").focus(); } });
    document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible" && signed) poll(); });
    if (typeof window.addEventListener === "function") window.addEventListener("hashchange", onHash);
    $("login-form").addEventListener("submit", function (event) {
      event.preventDefault();
      var remember = $("remember").checked;
      call("POST", "/admin/api/login", { code: $("code").value, remember: remember }).then(function (data) {
        csrf = data.csrf; sessionStorage.setItem("narrarium-admin-csrf", csrf); $("code").value = ""; $("remember").checked = false; $("new-code-box").classList.add("hidden");
        if (data.device && data.device.token) { saveDevice(data.device); toast(t("deviceRemembered")); }
        else if (data.deviceLimit) toast(t("deviceLimit", { n: MAX_DEVICES }));
        signedIn();
      }, function (error) { $("login-error").textContent = error.message; });
    });
    $("logout").addEventListener("click", function () {
      var device = readDevice();
      call("POST", "/admin/api/logout", device ? { deviceId: device.id } : {}).catch(function () {}).then(function () { forgetDevice(); signOut(""); });
    });
    $("updates-check").addEventListener("click", function () { loadUpdates(); });
    $("pairing-start").addEventListener("click", function () { call("POST", "/admin/api/pairing", {}).then(function (result) { pairCode = result; refresh(); }, fail); });
    $("passkey-link").addEventListener("click", function () {
      call("POST", "/admin/api/passkeys/link", {}).then(function (result) { $("passkey-link-value").textContent = result.url; $("passkey-link-box").classList.remove("hidden"); }, fail);
    });
    $("passkey-link-copy").addEventListener("click", function () { copyText("passkey-link-value"); });
    $("audit-more").addEventListener("click", function () { loadAudit(true); });
    $("token-form").addEventListener("submit", function (event) {
      event.preventDefault();
      var scopes = ["read", "write", "run"]; if ($("token-update").checked) scopes.push("update");
      call("POST", "/admin/api/token", { label: $("token-label").value, scopes: scopes }).then(function (result) { showToken(result.token); $("token-label").value = ""; $("token-update").checked = false; refresh(); }, fail);
    });
    $("token-copy").addEventListener("click", function () { copyText("token-value"); });
    ["network-form", "spend-form"].forEach(function (id) { $(id).addEventListener("input", function () { dirty[id] = true; }); });
    $("network-form").addEventListener("submit", function (event) {
      event.preventDefault();
      call("POST", "/admin/api/network", { allowedAiBases: lines("net-ai"), origins: lines("net-origins"), publicUrl: $("net-public").value.trim(), adminPublicUrl: $("net-admin").value.trim(), allowRemoteAdmin: $("net-remote-admin").checked }).then(function () { dirty["network-form"] = false; document.activeElement && document.activeElement.blur && document.activeElement.blur(); toast(t("saved")); refresh(); }, fail);
    });
    $("spend-form").addEventListener("submit", function (event) {
      event.preventDefault();
      function amount(id) { var text = $(id).value.trim(); return text === "" ? 0 : Number(text); }
      call("POST", "/admin/api/spend", { maxTokensPerDay: amount("spend-tokens-day"), maxCostPerDay: amount("spend-cost-day"), maxTokensPerRun: amount("spend-tokens-run"), maxCostPerRun: amount("spend-cost-run") }).then(function () { dirty["spend-form"] = false; document.activeElement && document.activeElement.blur && document.activeElement.blur(); toast(t("saved")); refresh(); }, fail);
    });
    $("spend-toggle").addEventListener("click", function () {
      var pause = !(state && state.spend && state.spend.paused);
      if (pause && !confirm(t("spendPauseConfirm"))) return;
      call("POST", "/admin/api/spend", { paused: pause }).then(function () { refresh(); }, fail);
    });
    $("ai-calls-toggle").addEventListener("click", function () {
      var off = !!(state && state.aiCalls && state.aiCalls.enabled);
      if (off && !confirm(t("callsOffConfirm"))) return;
      call("POST", "/admin/api/ai-calls", { enabled: !off }).then(function () { refresh(); }, fail);
    });
    $("tunnel-form").addEventListener("submit", function (event) {
      event.preventDefault();
      call("POST", "/admin/api/tunnel/configure", { token: $("tunnel-token").value, hostname: $("tunnel-host").value.trim() || undefined }).then(function () { $("tunnel-token").value = ""; toast(t("saved")); refresh(); }, fail);
    });
    $("tunnel-restart").addEventListener("click", function () { call("POST", "/admin/api/tunnel/restart", {}).then(function () { refresh(); }, fail); });
    $("tunnel-remove").addEventListener("click", function () { if (!confirm(t("removeConfirm"))) return; call("POST", "/admin/api/tunnel/remove", {}).then(function () { refresh(); }, fail); });
    $("code-form").addEventListener("submit", function (event) {
      event.preventDefault();
      if ($("code-1").value !== $("code-2").value) { toast(t("codeMismatch")); return; }
      call("POST", "/admin/api/admin-code/set", { code: $("code-1").value }).then(function () { $("code-1").value = ""; $("code-2").value = ""; forgetDevice(); signOut(""); }, fail);
    });
    $("code-rotate").addEventListener("click", function () {
      if (!confirm(t("rotateConfirm"))) return;
      call("POST", "/admin/api/admin-code/rotate", {}).then(function (result) { forgetDevice(); signOut(""); $("new-code").textContent = result.code; $("new-code-box").classList.remove("hidden"); }, fail);
    });
    // A page that opens finds out whether it is in already: with the token it kept for this tab, with the cookie of a session that another tab made, or with the key of this device.
    csrf = sessionStorage.getItem("narrarium-admin-csrf") || "";
    if (!csrf && !readDevice() && !wasSeen()) { signOut(""); return; }
    $("login-view").classList.add("hidden"); $("boot").classList.remove("hidden");
    var opening = csrf || readDevice() ? call("GET", "/admin/api/status") : send("GET", "/admin/api/status").then(function (answer) { if (!answer.ok) throw new Error(""); return answer.data; });
    opening.then(function (data) { state = data; signedIn(); }, function (error) { if (!error || !error.rejected) signOut(""); });
  });
})();
`;
