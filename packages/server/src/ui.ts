/**
 * Admin panel of the personal server, served on the loopback admin port under a strict CSP
 * (no inline scripts or styles). Texts are in English and Italian; data is always set as text.
 */

export const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Narrarium server</title>
<link rel="stylesheet" href="/admin.css">
<script src="/admin.js" defer></script>
</head>
<body>
<header class="top">
  <div class="brand"><span class="logo" aria-hidden="true">N</span><div><h1 data-i18n="title">Narrarium server</h1><p class="muted" id="subtitle"></p></div></div>
  <div class="actions">
    <div class="pills" id="pills"></div>
    <button type="button" class="ghost" id="lang" aria-label="Language">IT</button>
    <button type="button" class="ghost hidden" id="logout" data-i18n="logout">Sign out</button>
  </div>
</header>
<main>
  <section class="card login" id="login-view">
    <h2 data-i18n="loginTitle">Sign in</h2>
    <p class="muted" data-i18n="loginHelp">Enter the admin code of this server. To see it, run on this computer:</p>
    <pre class="code"><code>npx narrarium-server admin-code</code></pre>
    <form id="login-form" autocomplete="off">
      <label for="code" data-i18n="adminCode">Admin code</label>
      <input id="code" type="password" required minlength="32" maxlength="200" spellcheck="false">
      <button type="submit" data-i18n="signIn">Sign in</button>
    </form>
    <p class="notice hidden" id="new-code-box"><span data-i18n="newCode">New admin code (shown once):</span> <code id="new-code"></code></p>
    <p class="error" id="login-error" role="alert"></p>
  </section>

  <div class="grid hidden" id="main-view">
    <section class="card" id="overview">
      <h2 data-i18n="overview">This server</h2>
      <dl class="facts" id="facts"></dl>
    </section>

    <section class="card" id="updates">
      <div class="card-head"><h2 data-i18n="updates">Updates</h2><button type="button" class="ghost small" id="updates-check" data-i18n="check">Check again</button></div>
      <p id="updates-message"></p>
      <p class="muted" id="updates-last"></p>
      <button type="button" class="hidden" id="update-now"></button>
    </section>

    <section class="card" id="pairing">
      <h2 data-i18n="pairTitle">Connect a client</h2>
      <p class="muted" data-i18n="pairHelp">In Narrarium open Settings → Personal server, choose Pair and type this code. Then approve the request here.</p>
      <div id="pairing-box"></div>
      <button type="button" id="pairing-start" data-i18n="pairStart">Generate a pairing code</button>
    </section>

    <section class="card wide" id="clients">
      <h2 data-i18n="clientsTitle">Clients</h2>
      <div class="table-wrap"><table><thead><tr><th data-i18n="name">Name</th><th data-i18n="permissions">Permissions</th><th data-i18n="created">Created</th><th data-i18n="lastSeen">Last seen</th><th></th></tr></thead><tbody id="client-rows"></tbody></table></div>
      <form id="token-form" class="inline" autocomplete="off">
        <input id="token-label" maxlength="80" required data-i18n-placeholder="clientName" placeholder="Client name">
        <label class="check"><input type="checkbox" id="token-update"> <span data-i18n="allowUpdates">Also allow updating the server</span></label>
        <button type="submit" data-i18n="issueToken">Create token</button>
      </form>
      <p class="notice hidden" id="token-box"><span data-i18n="tokenOnce">Token (shown once):</span> <code id="token-value"></code> <button type="button" class="ghost small" id="token-copy" data-i18n="copy">Copy</button></p>
    </section>

    <section class="card" id="ai">
      <h2 data-i18n="aiTitle">AI endpoints</h2>
      <p class="muted" data-i18n="aiHelp">The server calls only the AI endpoints you approve. Endpoints sent by a client wait here.</p>
      <ul class="list" id="ai-pending"></ul>
      <p class="muted" id="ai-approved"></p>
    </section>

    <section class="card" id="network">
      <h2 data-i18n="networkTitle">Approved network</h2>
      <form id="network-form" autocomplete="off">
        <label for="net-ai" data-i18n="aiBases">Approved AI endpoints (one origin per line)</label>
        <textarea id="net-ai" rows="3" spellcheck="false"></textarea>
        <label for="net-origins" data-i18n="origins">Extra client origins (one per line)</label>
        <textarea id="net-origins" rows="2" spellcheck="false"></textarea>
        <p class="muted small" id="net-default-origins"></p>
        <label for="net-public" data-i18n="publicUrl">Public API address (https://, for example a Cloudflare hostname)</label>
        <input id="net-public" spellcheck="false">
        <label for="net-admin" data-i18n="adminPublicUrl">Public admin address (optional)</label>
        <input id="net-admin" spellcheck="false">
        <label class="check"><input type="checkbox" id="net-remote-admin"> <span data-i18n="remoteAdmin">Serve this panel on its public address</span></label>
        <button type="submit" data-i18n="save">Save</button>
      </form>
    </section>

    <section class="card" id="cloudflare">
      <h2>Cloudflare</h2>
      <dl class="facts" id="tunnel-facts"></dl>
      <p class="muted" data-i18n="tunnelHelp">Create a remotely-managed tunnel in the Cloudflare dashboard, route a hostname to http://127.0.0.1 and the API port, install cloudflared 2025.4.0 or newer, then paste the connector token.</p>
      <form id="tunnel-form" autocomplete="off">
        <label for="tunnel-token" data-i18n="tunnelToken">Connector token</label>
        <input id="tunnel-token" type="password" spellcheck="false">
        <label for="tunnel-host" data-i18n="tunnelHost">Hostname (https://, informational)</label>
        <input id="tunnel-host" spellcheck="false">
        <div class="row"><button type="submit" data-i18n="tunnelSave">Save and start</button><button type="button" class="ghost" id="tunnel-restart" data-i18n="restart">Restart</button><button type="button" class="ghost danger" id="tunnel-remove" data-i18n="remove">Remove</button></div>
      </form>
    </section>

    <section class="card" id="books">
      <h2 data-i18n="booksTitle">Books on this server</h2>
      <ul class="list" id="book-rows"></ul>
    </section>

    <section class="card" id="admin-code">
      <h2 data-i18n="codeTitle">Admin code</h2>
      <form id="code-form" autocomplete="off">
        <label for="code-1" data-i18n="codeNew">New code (32-200 characters)</label>
        <input id="code-1" type="password" minlength="32" maxlength="200">
        <label for="code-2" data-i18n="codeRepeat">Repeat the new code</label>
        <input id="code-2" type="password" minlength="32" maxlength="200">
        <div class="row"><button type="submit" data-i18n="codeSet">Set this code</button><button type="button" class="ghost" id="code-rotate" data-i18n="codeRotate">Generate a random code</button></div>
      </form>
    </section>
  </div>
  <p class="toast hidden" id="toast" role="status"></p>
</main>
</body>
</html>
`;

export const ADMIN_CSS = `:root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--fg:#1f2328;--muted:#5f6670;--line:#e3e1dc;--accent:#0f766e;--accent-fg:#fff;--warn:#b45309;--bad:#b91c1c;--ok:#15803d;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--card:#1b1e23;--fg:#e8e6e3;--muted:#9aa1ab;--line:#2c3138;--accent:#2dd4bf;--accent-fg:#06201d;--warn:#f59e0b;--bad:#f87171;--ok:#4ade80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg)}
.top{display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:center;padding:16px 24px;border-bottom:1px solid var(--line);background:var(--card);position:sticky;top:0;z-index:2}
.brand{display:flex;gap:12px;align-items:center}.logo{display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--accent);color:var(--accent-fg);font-weight:700}
h1{font-size:18px;margin:0}h2{font-size:16px;margin:0 0 10px}.muted{color:var(--muted)}.small{font-size:13px}
.actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.pills{display:flex;flex-wrap:wrap;gap:6px}
.pill{border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:12px}.pill.ok{border-color:var(--ok);color:var(--ok)}.pill.warn{border-color:var(--warn);color:var(--warn)}.pill.bad{border-color:var(--bad);color:var(--bad)}
main{padding:24px;max-width:1200px;margin:0 auto}.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(340px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px}.card.wide{grid-column:1/-1}.login{max-width:520px;margin:40px auto}
.card-head{display:flex;justify-content:space-between;align-items:center;gap:8px}
label{display:block;font-size:13px;color:var(--muted);margin:10px 0 4px}label.check{display:flex;gap:8px;align-items:center;color:var(--fg)}
input,textarea{width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:transparent;color:inherit;font:inherit}textarea{font-family:ui-monospace,monospace;font-size:13px}
input[type=checkbox]{width:auto}
button{border:1px solid var(--accent);background:var(--accent);color:var(--accent-fg);border-radius:8px;padding:7px 14px;font:inherit;cursor:pointer;margin-top:10px}
button.ghost{background:transparent;color:var(--fg);border-color:var(--line)}button.danger{color:var(--bad)}button.small{padding:3px 9px;font-size:13px;margin-top:0}button:disabled{opacity:.5;cursor:not-allowed}
.row{display:flex;flex-wrap:wrap;gap:8px}.inline{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px}.inline > input{flex:1;min-width:180px}.inline button,.inline label{margin-top:0}
.facts{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;margin:0}.facts dt{color:var(--muted);font-size:13px}.facts dd{margin:0;overflow-wrap:anywhere}
code,pre{font-family:ui-monospace,monospace;font-size:13px}pre.code{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;overflow:auto}
.notice{background:var(--bg);border:1px dashed var(--accent);border-radius:8px;padding:8px 10px;word-break:break-all}
.error{color:var(--bad);min-height:1em}.hidden{display:none!important}
.pair-code{font-size:30px;letter-spacing:4px;font-family:ui-monospace,monospace;margin:6px 0}
.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:middle}th{font-size:12px;color:var(--muted);font-weight:600}
.chip{display:inline-block;border:1px solid var(--line);border-radius:6px;padding:0 6px;margin:1px 2px;font-size:12px}.chip.update{border-color:var(--warn);color:var(--warn)}
.list{list-style:none;margin:0;padding:0}.list li{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line)}
.toast{position:fixed;right:16px;bottom:16px;background:var(--fg);color:var(--bg);padding:10px 14px;border-radius:10px;max-width:420px;z-index:5}
.revoked{opacity:.55}
@media (max-width:640px){main{padding:12px}.top{padding:12px}.facts{grid-template-columns:1fr}}
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
      aiTitle: "AI endpoints", aiHelp: "The server calls only the AI endpoints you approve. Endpoints sent by a client wait here.",
      networkTitle: "Approved network", aiBases: "Approved AI endpoints (one origin per line)", origins: "Extra client origins (one per line)",
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
      sessionExpired: "Session expired: sign in again.", codeMismatch: "The two codes differ.", rotateConfirm: "Replace the admin code with a random one? You will sign in again.",
      removeConfirm: "Remove the Cloudflare token and stop the connector?", revokeConfirm: "Revoke this client? It stops working immediately.", regenerateConfirm: "Create a new token for this client? The old one stops working.",
      tunnelEnabled: "Enabled", tunnelProcess: "Connector", tunnelBinary: "cloudflared", tunnelOther: "Other connectors", tunnelHostLabel: "Hostname", running: "running", stopped: "stopped",
      tunnelFailed: "stopped with an error", available: "available", missing: "missing", detected: "detected (left untouched)", maintenance: "restarting for an update",
      defaults: "Always allowed: {list}", status: { idle: "ready", running: "running", paused: "paused", "waiting-author": "waiting for the author", error: "stopped by an error", completed: "completed" },
      local: "local", github: "GitHub", working: "autopilot running", lang: "IT"
    },
    it: {
      title: "Server Narrarium", logout: "Esci", loginTitle: "Accedi", loginHelp: "Inserisci il codice amministratore di questo server. Per vederlo, esegui su questo computer:",
      adminCode: "Codice amministratore", signIn: "Accedi", newCode: "Nuovo codice amministratore (mostrato una volta):", overview: "Questo server", updates: "Aggiornamenti", check: "Controlla di nuovo",
      pairTitle: "Collega un client", pairHelp: "In Narrarium apri Impostazioni → Server personale, scegli Abbina e digita questo codice. Poi approva la richiesta qui.",
      pairStart: "Genera un codice di abbinamento", clientsTitle: "Client", name: "Nome", permissions: "Permessi", created: "Creato", lastSeen: "Ultimo accesso",
      clientName: "Nome del client", allowUpdates: "Consenti anche di aggiornare il server", issueToken: "Crea token", tokenOnce: "Token (mostrato una volta):", copy: "Copia",
      aiTitle: "Endpoint AI", aiHelp: "Il server chiama solo gli endpoint AI che approvi. Quelli inviati da un client attendono qui.",
      networkTitle: "Rete approvata", aiBases: "Endpoint AI approvati (un'origine per riga)", origins: "Origini client aggiuntive (una per riga)",
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
      sessionExpired: "Sessione scaduta: accedi di nuovo.", codeMismatch: "I due codici sono diversi.", rotateConfirm: "Sostituire il codice amministratore con uno casuale? Dovrai accedere di nuovo.",
      removeConfirm: "Rimuovere il token Cloudflare e fermare il connettore?", revokeConfirm: "Revocare questo client? Smette subito di funzionare.", regenerateConfirm: "Creare un nuovo token per questo client? Quello vecchio smette di funzionare.",
      tunnelEnabled: "Attivo", tunnelProcess: "Connettore", tunnelBinary: "cloudflared", tunnelOther: "Altri connettori", tunnelHostLabel: "Hostname", running: "in esecuzione", stopped: "fermo",
      tunnelFailed: "fermo per un errore", available: "disponibile", missing: "mancante", detected: "rilevati (non toccati)", maintenance: "riavvio per aggiornamento",
      defaults: "Sempre consentite: {list}", status: { idle: "pronto", running: "in esecuzione", paused: "in pausa", "waiting-author": "aspetta l'autore", error: "fermo per un errore", completed: "completato" },
      local: "locale", github: "GitHub", working: "autopilot al lavoro", lang: "EN"
    }
  };
  var lang = localStorage.getItem("narrarium-admin-lang") || ((navigator.language || "en").toLowerCase().indexOf("it") === 0 ? "it" : "en");
  var csrf = "";
  var state = null;
  var timer = null;
  var pairCode = null;

  function t(key, values) {
    var text = (T[lang] && T[lang][key]) || T.en[key] || key;
    if (values) Object.keys(values).forEach(function (name) { text = text.split("{" + name + "}").join(String(values[name])); });
    return text;
  }
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; }
  function when(iso) { if (!iso) return "—"; var date = new Date(iso); return isNaN(date.getTime()) ? "—" : date.toLocaleString(lang === "it" ? "it-IT" : "en-GB"); }
  function toast(text) { var box = $("toast"); box.textContent = text; box.classList.remove("hidden"); clearTimeout(toast.timer); toast.timer = setTimeout(function () { box.classList.add("hidden"); }, 4000); }
  function applyTexts() {
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-i18n]").forEach(function (node) { node.textContent = t(node.getAttribute("data-i18n")); });
    document.querySelectorAll("[data-i18n-placeholder]").forEach(function (node) { node.setAttribute("placeholder", t(node.getAttribute("data-i18n-placeholder"))); });
    $("lang").textContent = t("lang");
    if (state) render();
  }
  function call(method, path, body) {
    var headers = { "content-type": "application/json" };
    if (method === "POST") headers["x-csrf-token"] = csrf;
    return fetch(path, { method: method, headers: headers, credentials: "same-origin", body: body === undefined ? undefined : JSON.stringify(body) }).then(function (response) {
      return response.text().then(function (text) {
        var data = {}; try { data = text ? JSON.parse(text) : {}; } catch (error) { data = {}; }
        if (response.status === 401 && path !== "/admin/api/login") { signOut(t("sessionExpired")); throw new Error(t("sessionExpired")); }
        if (!response.ok) throw new Error(data.message || ("HTTP " + response.status));
        return data;
      });
    });
  }
  function fail(error) { toast(error && error.message ? error.message : String(error)); }
  function signOut(message) {
    csrf = ""; state = null; sessionStorage.removeItem("narrarium-admin-csrf");
    $("main-view").classList.add("hidden"); $("login-view").classList.remove("hidden"); $("logout").classList.add("hidden"); $("pills").textContent = ""; $("subtitle").textContent = "";
    if (timer) { clearInterval(timer); timer = null; }
    $("login-error").textContent = message || "";
  }
  function signedIn() {
    $("login-view").classList.add("hidden"); $("main-view").classList.remove("hidden"); $("logout").classList.remove("hidden"); $("login-error").textContent = "";
    refresh(); loadUpdates(); if (!timer) timer = setInterval(function () { if (document.visibilityState === "visible") refresh(true); }, 20000);
  }
  function editing() { var active = document.activeElement; return active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA") && active.closest("form"); }
  function refresh(quiet) {
    return call("GET", "/admin/api/status").then(function (data) { state = data; render(quiet); }).catch(function (error) { if (!quiet) fail(error); });
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
    if (s.books.some(function (book) { return book.running; })) pill(t("working"), "ok");
    var facts = $("facts"); facts.textContent = "";
    fact(facts, t("label"), s.label); fact(facts, t("serverId"), s.serverId); fact(facts, t("fingerprint"), s.fingerprint, true, s.fingerprint.replace(/(.{4})(?=.)/g, "$1 "));
    fact(facts, t("version"), s.serverVersion); fact(facts, t("engine"), s.engineVersion); fact(facts, t("api"), s.apiUrl, true);
    fact(facts, t("admin"), location.origin); fact(facts, t("data"), s.dataRoot); fact(facts, t("git"), s.git ? t("available") : t("missing"));
    fact(facts, t("supervisor"), s.supervised ? t("supervisedYes") : t("supervisedNo"));
    renderPairing(); renderClients(); renderAi();
    if (!quiet || !editing()) renderNetwork();
    renderTunnel(); renderBooks();
  }
  function renderPairing() {
    var box = $("pairing-box"); box.textContent = ""; var p = state.pairing;
    if (pairCode && (!p || p.expiresAt < Date.now())) pairCode = null;
    if (pairCode) { box.appendChild(el("p", "muted", t("pairCode", { t: new Date(pairCode.expiresAt).toLocaleTimeString(lang === "it" ? "it-IT" : "en-GB") }))); box.appendChild(el("p", "pair-code", pairCode.code.replace(/(\d{3})(\d{3})(\d{3})/, "$1 $2 $3"))); }
    if (p && p.requested && !p.approved) {
      var row = el("div", "notice"); row.appendChild(el("p", "", t("pairRequest", { label: p.label || "?" })));
      var allow = el("label", "check"); var box2 = document.createElement("input"); box2.type = "checkbox"; allow.appendChild(box2); allow.appendChild(el("span", "", t("allowUpdatesShort"))); row.appendChild(allow);
      var actions = el("div", "row"); var approve = el("button", "", t("pairApprove")); approve.type = "button";
      approve.addEventListener("click", function () { call("POST", "/admin/api/pairing/approve", { id: p.id, allowUpdate: box2.checked }).then(function () { pairCode = null; toast(t("pairApproved")); refresh(); }, fail); });
      var cancel = el("button", "ghost", t("pairCancel")); cancel.type = "button";
      cancel.addEventListener("click", function () { call("POST", "/admin/api/pairing/cancel", {}).then(function () { pairCode = null; refresh(); }, fail); });
      actions.appendChild(approve); actions.appendChild(cancel); row.appendChild(actions); box.appendChild(row);
    } else if (p && !p.approved) box.appendChild(el("p", "muted", t("pairWaiting")));
  }
  function renderClients() {
    var body = $("client-rows"); body.textContent = "";
    state.clients.slice().reverse().forEach(function (client) {
      var tr = el("tr", client.revoked ? "revoked" : ""); tr.appendChild(el("td", "", client.label));
      var scopes = el("td"); client.scopes.forEach(function (scope) { scopes.appendChild(el("span", "chip" + (scope === "update" ? " update" : ""), scope)); }); tr.appendChild(scopes);
      tr.appendChild(el("td", "", when(client.createdAt))); tr.appendChild(el("td", "", client.revoked ? t("revoked") : when(client.lastSeenAt)));
      var actions = el("td");
      if (!client.revoked) {
        var regenerate = el("button", "ghost small", t("regenerate")); regenerate.type = "button";
        regenerate.addEventListener("click", function () { if (!confirm(t("regenerateConfirm"))) return; call("POST", "/admin/api/token", { label: client.label, scopes: client.scopes, replaceId: client.id }).then(function (result) { showToken(result.token); refresh(); }, fail); });
        var revoke = el("button", "ghost small danger", t("revoke")); revoke.type = "button";
        revoke.addEventListener("click", function () { if (!confirm(t("revokeConfirm"))) return; call("POST", "/admin/api/revoke", { id: client.id }).then(function () { refresh(); }, fail); });
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
  function renderNetwork() {
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
  function renderBooks() {
    var list = $("book-rows"); list.textContent = "";
    if (!state.books.length) list.appendChild(el("li", "muted", t("noBooks")));
    state.books.forEach(function (book) {
      var li = el("li"); li.appendChild(el("span", "", book.title));
      var statuses = t("status"); var status = book.status ? (statuses[book.status] || book.status) : "—";
      li.appendChild(el("span", "muted small", (book.storage === "github" ? t("github") : t("local")) + " · " + status + (book.error ? " · " + book.error : "")));
      list.appendChild(li);
    });
  }
  function pick(group, key, values) {
    var table = t(group); var text = (table && table[key]) || "";
    if (values) Object.keys(values).forEach(function (name) { text = text.split("{" + name + "}").join(String(values[name])); });
    return text;
  }
  function loadUpdates() {
    $("updates-message").textContent = t("checking"); $("updates-last").textContent = ""; $("update-now").classList.add("hidden");
    return call("GET", "/admin/api/updates").then(function (info) {
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
    }).catch(function () { $("updates-message").textContent = t("updatesFailed"); });
  }
  function lines(id) { return $(id).value.split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean); }
  document.addEventListener("DOMContentLoaded", function () {
    applyTexts();
    $("lang").addEventListener("click", function () { lang = lang === "it" ? "en" : "it"; localStorage.setItem("narrarium-admin-lang", lang); applyTexts(); if (state) loadUpdates(); });
    $("login-form").addEventListener("submit", function (event) {
      event.preventDefault();
      call("POST", "/admin/api/login", { code: $("code").value }).then(function (data) { csrf = data.csrf; sessionStorage.setItem("narrarium-admin-csrf", csrf); $("code").value = ""; $("new-code-box").classList.add("hidden"); signedIn(); }, function (error) { $("login-error").textContent = error.message; });
    });
    $("logout").addEventListener("click", function () { call("POST", "/admin/api/logout", {}).catch(function () {}).then(function () { signOut(""); }); });
    $("updates-check").addEventListener("click", function () { loadUpdates(); });
    $("pairing-start").addEventListener("click", function () { call("POST", "/admin/api/pairing", {}).then(function (result) { pairCode = result; refresh(); }, fail); });
    $("token-form").addEventListener("submit", function (event) {
      event.preventDefault();
      var scopes = ["read", "write", "run"]; if ($("token-update").checked) scopes.push("update");
      call("POST", "/admin/api/token", { label: $("token-label").value, scopes: scopes }).then(function (result) { showToken(result.token); $("token-label").value = ""; $("token-update").checked = false; refresh(); }, fail);
    });
    $("token-copy").addEventListener("click", function () { navigator.clipboard.writeText($("token-value").textContent).then(function () { toast(t("copied")); }, fail); });
    $("network-form").addEventListener("submit", function (event) {
      event.preventDefault();
      call("POST", "/admin/api/network", { allowedAiBases: lines("net-ai"), origins: lines("net-origins"), publicUrl: $("net-public").value.trim(), adminPublicUrl: $("net-admin").value.trim(), allowRemoteAdmin: $("net-remote-admin").checked }).then(function () { document.activeElement && document.activeElement.blur(); toast(t("saved")); refresh(); }, fail);
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
      call("POST", "/admin/api/admin-code/set", { code: $("code-1").value }).then(function () { $("code-1").value = ""; $("code-2").value = ""; signOut(""); }, fail);
    });
    $("code-rotate").addEventListener("click", function () {
      if (!confirm(t("rotateConfirm"))) return;
      call("POST", "/admin/api/admin-code/rotate", {}).then(function (result) { signOut(""); $("new-code").textContent = result.code; $("new-code-box").classList.remove("hidden"); }, fail);
    });
    csrf = sessionStorage.getItem("narrarium-admin-csrf") || "";
    if (csrf) call("GET", "/admin/api/status").then(function (data) { state = data; signedIn(); }, function () { signOut(""); });
  });
})();
`;
