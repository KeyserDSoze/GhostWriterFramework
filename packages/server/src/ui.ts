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
      <div class="table-wrap"><table><thead><tr><th data-i18n="name">Name</th><th data-i18n="permissions">Permissions</th><th data-i18n="source">Source</th><th data-i18n="verification">Code</th><th data-i18n="created">Created</th><th data-i18n="lastSeen">Last seen</th><th></th></tr></thead><tbody id="client-rows"></tbody></table></div>
      <form id="token-form" class="inline" autocomplete="off">
        <input id="token-label" maxlength="80" required data-i18n-placeholder="clientName" placeholder="Client name">
        <label class="check"><input type="checkbox" id="token-update"> <span data-i18n="allowUpdates">Also allow updating the server</span></label>
        <button type="submit" data-i18n="issueToken">Create token</button>
      </form>
      <p class="notice hidden" id="token-box"><span data-i18n="tokenOnce">Token (shown once):</span> <code id="token-value"></code> <button type="button" class="ghost small" id="token-copy" data-i18n="copy">Copy</button></p>
    </section>

    <section class="card" id="ai">
      <h2 data-i18n="aiTitle">AI endpoints</h2>
      <p class="muted" data-i18n="aiHelp">The server calls only the AI endpoints you approve, and only then sends an API key there. The endpoints of a configuration sent by a client wait here, with the address requests start with.</p>
      <ul class="list" id="ai-pending"></ul>
      <p class="muted" id="ai-approved"></p>
    </section>

    <section class="card" id="spend">
      <h2 id="spend-title" data-i18n="spendTitle">AI spending</h2>
      <p class="muted" data-i18n="spendHelp">Limits that only you can set, whatever a client asks for. When one is reached no AI call is made: the autopilot stops with a message and resumes later.</p>
      <dl class="facts" id="spend-facts"></dl>
      <form id="spend-form" autocomplete="off">
        <label for="spend-tokens-day" data-i18n="spendTokensDay">Tokens per day, UTC (0 = no limit)</label>
        <input id="spend-tokens-day" type="number" min="0" step="1">
        <label for="spend-cost-day" data-i18n="spendCostDay">Cost per day, in the currency of the AI settings (0 = no limit)</label>
        <input id="spend-cost-day" type="number" min="0" step="any">
        <label for="spend-tokens-run" data-i18n="spendTokensRun">Tokens per run (0 = no limit)</label>
        <input id="spend-tokens-run" type="number" min="0" step="1">
        <label for="spend-cost-run" data-i18n="spendCostRun">Cost per run (0 = no limit)</label>
        <input id="spend-cost-run" type="number" min="0" step="any">
        <div class="row"><button type="submit" data-i18n="spendSave">Save limits</button><button type="button" class="ghost" id="spend-toggle"></button></div>
      </form>
    </section>

    <section class="card" id="network">
      <h2 data-i18n="networkTitle">Approved network</h2>
      <form id="network-form" autocomplete="off">
        <label for="net-ai" data-i18n="aiBases">Approved AI endpoints (one address per line: an origin, or an origin and a path)</label>
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

    <section class="card wide" id="mcp">
      <h2 data-i18n="mcpTitle">Connected apps (MCP)</h2>
      <p class="muted" data-i18n="mcpHelp">Every book has its own MCP address. Paste it in ChatGPT or Claude: they send you to a page of this server where you prove it is you with a passkey or the admin code, and choose what the app may do with that book.</p>
      <p class="notice hidden" id="mcp-public-note" data-i18n="mcpNoPublic">This server has no public address yet: apps on other computers cannot reach it and passkeys cannot be used. Set the public API address in Approved network.</p>
      <ul class="list" id="mcp-books"></ul>
      <h3 data-i18n="passkeysTitle">Passkeys</h3>
      <p class="muted" data-i18n="passkeysHelp">A passkey lets you approve an app on the consent page with your fingerprint, face or screen lock. The admin code always works as well.</p>
      <ul class="list" id="passkey-rows"></ul>
      <div class="row"><button type="button" id="passkey-link" data-i18n="passkeyAdd">Add a passkey</button></div>
      <p class="notice hidden" id="passkey-link-box"><span data-i18n="passkeyLink">Open this address on the device that will keep the passkey (valid ten minutes, works once):</span> <code id="passkey-link-value"></code> <button type="button" class="ghost small" id="passkey-link-copy" data-i18n="copy">Copy</button></p>
      <h3 data-i18n="auditTitle">Recent calls</h3>
      <p class="muted" data-i18n="auditHelp">Who called which tool, on which book, and when. What the book says is never recorded here.</p>
      <div class="table-wrap"><table><thead><tr><th data-i18n="auditWhen">When</th><th data-i18n="auditCaller">Caller</th><th data-i18n="auditBook">Book</th><th data-i18n="auditTool">Tool</th><th data-i18n="auditResult">Result</th></tr></thead><tbody id="audit-rows"></tbody></table></div>
      <div class="row"><button type="button" class="ghost" id="audit-more" data-i18n="auditMore">Older calls</button></div>
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
.revoked{opacity:.55}.agent{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
h3{font-size:14px;margin:18px 0 6px}.list li.mcp-book{display:block}.mcp-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between}.mcp-book .list{margin:6px 0 4px 8px}.mcp-book .inline{margin-top:6px}
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
  var lang = localStorage.getItem("narrarium-admin-lang") || ((navigator.language || "en").toLowerCase().indexOf("it") === 0 ? "it" : "en");
  var csrf = "";
  var state = null;
  var timer = null;
  var pairCode = null;
  var mcp = null;
  var audit = { rows: [], next: null, older: false };

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
    if (mcp) renderMcp();
    renderAudit();
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
    refresh(); loadUpdates(); loadMcp(); loadAudit(false);
    if (!timer) timer = setInterval(function () { if (document.visibilityState === "visible") { refresh(true); loadMcp(); if (!audit.older) loadAudit(false); } }, 20000);
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
    renderPairing(); renderClients(); renderAi(); renderSpend(quiet);
    if (!quiet || !editing()) renderNetwork();
    renderTunnel(); renderBooks();
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
    state.clients.slice().reverse().forEach(function (client) {
      var tr = el("tr", client.revoked ? "revoked" : ""); tr.appendChild(el("td", "", client.label));
      var scopes = el("td"); client.scopes.forEach(function (scope) { scopes.appendChild(el("span", "chip" + (scope === "update" ? " update" : ""), scope)); }); tr.appendChild(scopes);
      var where = el("td"); where.appendChild(el("div", "", sourceName(client.source)));
      if (client.userAgent) { var agent = el("div", "muted small agent", client.userAgent); agent.title = client.userAgent; where.appendChild(agent); }
      tr.appendChild(where);
      tr.appendChild(el("td", "", client.verification ? client.verification : "—"));
      tr.appendChild(el("td", "", when(client.createdAt))); tr.appendChild(el("td", "", client.revoked ? t("revoked") : when(client.lastSeenAt)));
      var actions = el("td");
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
    if (!quiet || !editing()) {
      var limits = s.limits || {};
      $("spend-tokens-day").value = String(limits.maxTokensPerDay || 0); $("spend-cost-day").value = String(limits.maxCostPerDay || 0);
      $("spend-tokens-run").value = String(limits.maxTokensPerRun || 0); $("spend-cost-run").value = String(limits.maxCostPerRun || 0);
    }
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
  function loadMcp() {
    return call("GET", "/admin/api/mcp").then(function (data) { mcp = data; renderMcp(); }, function () {});
  }
  function loadAudit(older) {
    var query = "?limit=20" + (older && audit.next ? "&before=" + audit.next : "");
    return call("GET", "/admin/api/mcp/audit" + query).then(function (page) {
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
    if (!audit.rows.length) { var empty = el("tr"); var cell = el("td", "muted", t("auditNone")); cell.setAttribute("colspan", "5"); empty.appendChild(cell); body.appendChild(empty); }
    audit.rows.forEach(function (entry) {
      var tr = el("tr"); tr.appendChild(el("td", "", when(entry.at))); tr.appendChild(el("td", "", entry.client)); tr.appendChild(el("td", "", entry.bookId)); tr.appendChild(el("td", "", entry.tool));
      tr.appendChild(el("td", "", entry.ok ? t("auditOk") : t("auditFailed", { code: entry.code || "?" }))); body.appendChild(tr);
    });
    if (audit.next === null) $("audit-more").classList.add("hidden"); else $("audit-more").classList.remove("hidden");
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
    $("passkey-link").addEventListener("click", function () {
      call("POST", "/admin/api/passkeys/link", {}).then(function (result) { $("passkey-link-value").textContent = result.url; $("passkey-link-box").classList.remove("hidden"); }, fail);
    });
    $("passkey-link-copy").addEventListener("click", function () { navigator.clipboard.writeText($("passkey-link-value").textContent).then(function () { toast(t("copied")); }, fail); });
    $("audit-more").addEventListener("click", function () { loadAudit(true); });
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
    $("spend-form").addEventListener("submit", function (event) {
      event.preventDefault();
      function amount(id) { var text = $(id).value.trim(); return text === "" ? 0 : Number(text); }
      call("POST", "/admin/api/spend", { maxTokensPerDay: amount("spend-tokens-day"), maxCostPerDay: amount("spend-cost-day"), maxTokensPerRun: amount("spend-tokens-run"), maxCostPerRun: amount("spend-cost-run") }).then(function () { document.activeElement && document.activeElement.blur && document.activeElement.blur(); toast(t("saved")); refresh(); }, fail);
    });
    $("spend-toggle").addEventListener("click", function () {
      var pause = !(state && state.spend && state.spend.paused);
      if (pause && !confirm(t("spendPauseConfirm"))) return;
      call("POST", "/admin/api/spend", { paused: pause }).then(function () { refresh(); }, fail);
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
