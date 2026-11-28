import { DEVICES_HTML } from "./ui-devices.js";
import { GITHUB_HTML } from "./ui-github.js";
import { HEALTH_HTML, HISTORY_HTML, LOG_HTML, RISKS_HTML, RUNS_HTML } from "./ui-views.js";

/**
 * The admin panel's markup: the sign-in, the navigation and the nine pages. The panel is one document with one page shown at a time, each at an address of its own (`/#/books`): the page
 * that is not shown is hidden, but its elements are there, so the script draws into every one of them as the answers come. Each page has its own `h1`, and the navigation is a
 * landmark with a name in which the page that is open is marked with `aria-current`.
 */

export interface PageRoute {
  id: string;
  /** The key of the text that names the page, in the navigation and in its heading. */
  title: string;
  intro: string;
  english: string;
  summary: string;
  /** The path of the icon, drawn on a 24 x 24 grid. */
  icon: string;
}

export const PAGES: PageRoute[] = [
  { id: "overview", title: "navOverview", intro: "introOverview", english: "Overview", summary: "How this server is doing, and what needs you.", icon: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>' },
  { id: "books", title: "navBooks", intro: "introBooks", english: "Books and runs", summary: "What the autopilot is doing for each book on this server.", icon: '<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z"/><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3"/>' },
  { id: "updates", title: "navUpdates", intro: "introUpdates", english: "Updates", summary: "Which version runs, whether a newer one is available, and how earlier updates went.", icon: '<path d="M12 4v11"/><path d="m7.5 11 4.5 4.5 4.5-4.5"/><path d="M5 19.5h14"/>' },
  { id: "clients", title: "navClients", intro: "introClients", english: "Clients", summary: "The apps and tools that use this server, and how to connect a new one.", icon: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>' },
  { id: "apps", title: "navApps", intro: "introApps", english: "Connected apps", summary: "Books that apps such as ChatGPT or Claude can reach through MCP, the passkeys that approve them, and what they called.", icon: '<path d="M10 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>' },
  { id: "ai", title: "navAi", intro: "introAi", english: "AI and spending", summary: "Which AI endpoints this server may call, and how much it may spend.", icon: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>' },
  { id: "network", title: "navNetwork", intro: "introNetwork", english: "Network", summary: "Which addresses may reach this server, and the Cloudflare connector that publishes it.", icon: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>' },
  { id: "log", title: "navLog", intro: "introLog", english: "Action log", summary: "What you and your clients changed on this server.", icon: '<path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>' },
  { id: "security", title: "navSecurity", intro: "introSecurity", english: "Security", summary: "Risks in this server's set-up, the devices that sign in without the code, and the admin code.", icon: '<path d="M12 3l7.5 3v5.5c0 4.5-3.1 8.2-7.5 9.5-4.4-1.3-7.5-5-7.5-9.5V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>' },
];

const icon = (paths: string) => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths}</svg>`;

export const MENU_ICON = icon('<path d="M4 7h16M4 12h16M4 17h16"/>');

export const NAV_HTML = `<nav class="nav" id="nav" aria-label="Sections">
        <ul>
${PAGES.map((page) => `          <li><a href="#/${page.id}" id="nav-${page.id}" data-route="${page.id}">${icon(page.icon)}<span class="label" data-i18n="${page.title}">${page.english}</span><span class="count hidden" id="badge-${page.id}"></span></a></li>`).join("\n")}
        </ul>
      </nav>`;

export const LOGIN_HTML = `<section class="panel login" id="login-view">
      <h1 id="login-title" tabindex="-1" data-i18n="loginTitle">Sign in</h1>
      <p class="panel-help" data-i18n="loginHelp">Enter the admin code of this server. To see it, run on this computer:</p>
      <pre class="code"><code>npx narrarium-server admin-code</code></pre>
      <form id="login-form" class="form" autocomplete="off">
        <label for="code" data-i18n="adminCode">Admin code</label>
        <input id="code" type="password" required minlength="32" maxlength="200" spellcheck="false">
        <label class="check" for="remember"><input type="checkbox" id="remember" aria-describedby="remember-help"><span data-i18n="rememberDevice">Remember this device forever</span></label>
        <p class="field-help" id="remember-help" data-i18n="rememberHelp">This browser keeps a random key (never your admin code) and signs in by itself. You can revoke it at any time in Security, and signing out forgets it.</p>
        <button type="submit" id="login-submit" data-i18n="signIn">Sign in</button>
      </form>
      <p class="notice hidden" id="new-code-box"><span data-i18n="newCode">New admin code (shown once):</span> <code id="new-code"></code></p>
      <p class="error" id="login-error" role="alert"></p>
    </section>`;

const head = (page: PageRoute) => `<header class="page-head"><h1 id="title-${page.id}" tabindex="-1" data-i18n="${page.title}">${page.english}</h1><p class="lede" data-i18n="${page.intro}">${page.summary}</p></header>`;
const page = (id: string, body: string) => {
  const route = PAGES.find((candidate) => candidate.id === id) as PageRoute;
  return `<section class="page hidden" id="page-${id}" data-route="${id}">
      ${head(route)}
      ${body}
    </section>`;
};

const OVERVIEW = page("overview", `<div class="tiles" id="ov-tiles"></div>

      ${HEALTH_HTML}

      <section class="panel" id="ov-books">
        <div class="panel-head"><h2 id="ov-books-title" data-i18n="ovBooksTitle">Books at a glance</h2><a href="#/books" id="ov-books-all" data-i18n="ovBooksAll">All books</a></div>
        <ul class="glance" id="ov-books-list"></ul>
        <p class="muted small" id="ov-books-note"></p>
      </section>

      <section class="panel" id="overview">
        <h2 data-i18n="overview">This server</h2>
        <div class="pills" id="pills"></div>
        <dl class="facts" id="facts"></dl>
      </section>`);

const BOOKS = page("books", `${RUNS_HTML}

      ${GITHUB_HTML}`);

const UPDATES = page("updates", `<section class="panel" id="updates">
        <div class="panel-head"><h2 id="updates-title" data-i18n="updatesVersion">Version</h2><button type="button" class="ghost small" id="updates-check" data-i18n="check">Check again</button></div>
        <p id="updates-message" role="status"></p>
        <p class="muted" id="updates-last"></p>
        <div class="row"><button type="button" class="hidden" id="update-now"></button></div>
      </section>

      ${HISTORY_HTML}`);

const CLIENTS = page("clients", `<section class="panel" id="pairing">
        <h2 data-i18n="pairTitle">Connect a client</h2>
        <p class="panel-help" data-i18n="pairHelp">In Narrarium open Settings → Personal server, choose Pair and type this code. Then approve the request here.</p>
        <div id="pairing-box"></div>
        <div class="row"><button type="button" id="pairing-start" data-i18n="pairStart">Generate a pairing code</button></div>
      </section>

      <section class="panel" id="clients">
        <h2 id="clients-title" data-i18n="clientsConnected">Connected clients</h2>
        <div class="table-wrap" tabindex="0" role="region" aria-labelledby="clients-title"><table class="stack pairs" role="table" aria-labelledby="clients-title"><thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col" data-i18n="name">Name</th><th role="columnheader" scope="col" data-i18n="permissions">Permissions</th><th role="columnheader" scope="col" data-i18n="source">Source</th><th role="columnheader" scope="col" data-i18n="verification">Code</th><th role="columnheader" scope="col" data-i18n="created">Created</th><th role="columnheader" scope="col" data-i18n="lastSeen">Last seen</th><th role="columnheader" scope="col"><span class="sr-only" data-i18n="colActions">Actions</span></th></tr></thead><tbody role="rowgroup" id="client-rows"></tbody></table></div>
        <h3 data-i18n="tokenTitle">Create a token by hand</h3>
        <form id="token-form" class="form" autocomplete="off">
          <label for="token-label" data-i18n="clientName">Client name</label>
          <input id="token-label" maxlength="80" required>
          <label class="check" for="token-update"><input type="checkbox" id="token-update"><span data-i18n="allowUpdates">Also allow updating the server</span></label>
          <button type="submit" data-i18n="issueToken">Create token</button>
        </form>
        <p class="notice hidden" id="token-box"><span data-i18n="tokenOnce">Token (shown once):</span> <code id="token-value"></code> <button type="button" class="ghost small" id="token-copy" data-i18n="copy">Copy</button></p>
      </section>`);

const APPS = page("apps", `<section class="panel" id="mcp">
        <h2 id="mcp-title" data-i18n="mcpBooksTitle">Books and their MCP addresses</h2>
        <p class="panel-help" data-i18n="mcpHelp">Every book has its own MCP address. Paste it in ChatGPT or Claude: they send you to a page of this server where you prove it is you with a passkey or the admin code, and choose what the app may do with that book.</p>
        <p class="notice hidden" id="mcp-public-note" data-i18n="mcpNoPublic">This server has no public address yet: apps on other computers cannot reach it and passkeys cannot be used. Set the public API address in Approved network.</p>
        <ul class="list" id="mcp-books"></ul>
      </section>

      <section class="panel" id="passkeys">
        <h2 id="passkeys-title" data-i18n="passkeysTitle">Passkeys</h2>
        <p class="panel-help" data-i18n="passkeysHelp">A passkey lets you approve an app on the consent page with your fingerprint, face or screen lock. The admin code always works as well.</p>
        <ul class="list" id="passkey-rows"></ul>
        <div class="row"><button type="button" id="passkey-link" data-i18n="passkeyAdd">Add a passkey</button></div>
        <p class="notice hidden" id="passkey-link-box"><span data-i18n="passkeyLink">Open this address on the device that will keep the passkey (valid ten minutes, works once):</span> <code id="passkey-link-value"></code> <button type="button" class="ghost small" id="passkey-link-copy" data-i18n="copy">Copy</button></p>
      </section>

      <section class="panel" id="audit">
        <h2 id="audit-title" data-i18n="auditTitle">Recent calls</h2>
        <p class="panel-help" data-i18n="auditHelp">Who called which tool, on which book, and when. What the book says is never recorded here.</p>
        <div class="table-wrap long" tabindex="0" role="region" aria-labelledby="audit-title"><table class="stack" role="table" aria-labelledby="audit-title"><thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col" data-i18n="auditWhen">When</th><th role="columnheader" scope="col" data-i18n="auditCaller">Caller</th><th role="columnheader" scope="col" data-i18n="auditBook">Book</th><th role="columnheader" scope="col" data-i18n="auditTool">Tool</th><th role="columnheader" scope="col" data-i18n="auditResult">Result</th></tr></thead><tbody role="rowgroup" id="audit-rows"></tbody></table></div>
        <div class="row"><button type="button" class="ghost" id="audit-more" data-i18n="auditMore">Older calls</button></div>
      </section>`);

const AI = page("ai", `<section class="panel" id="ai">
        <h2 id="ai-title" data-i18n="aiTitle">AI endpoints</h2>
        <p class="panel-help" data-i18n="aiHelp">The server calls only the AI endpoints you approve, and only then sends an API key there. The endpoints of a configuration sent by a client wait here, with the address requests start with.</p>
        <ul class="list" id="ai-pending"></ul>
        <p class="muted" id="ai-approved"></p>
        <p class="small"><a href="#/network" data-i18n="aiChange">Change the approved endpoints in Network</a></p>
      </section>

      <section class="panel" id="spend">
        <h2 id="spend-title" data-i18n="spendTitle">AI spending</h2>
        <p class="panel-help" data-i18n="spendHelp">Limits that only you can set, whatever a client asks for. When one is reached no AI call is made: the autopilot stops with a message and resumes later.</p>
        <dl class="facts" id="spend-facts"></dl>
        <form id="spend-form" class="form" autocomplete="off">
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
      </section>`);

const NETWORK = page("network", `<section class="panel" id="network">
        <h2 id="network-title" data-i18n="networkTitle">Approved network</h2>
        <form id="network-form" class="form" autocomplete="off">
          <label for="net-ai" data-i18n="aiBases">Approved AI endpoints (one address per line: an origin, or an origin and a path)</label>
          <textarea id="net-ai" rows="3" spellcheck="false"></textarea>
          <label for="net-origins" data-i18n="origins">Extra client origins (one per line)</label>
          <textarea id="net-origins" rows="2" spellcheck="false"></textarea>
          <p class="field-help" id="net-default-origins"></p>
          <label for="net-public" data-i18n="publicUrl">Public API address (https://, for example a Cloudflare hostname)</label>
          <input id="net-public" spellcheck="false">
          <label for="net-admin" data-i18n="adminPublicUrl">Public admin address (optional)</label>
          <input id="net-admin" spellcheck="false">
          <label class="check" for="net-remote-admin"><input type="checkbox" id="net-remote-admin"><span data-i18n="remoteAdmin">Serve this panel on its public address</span></label>
          <button type="submit" data-i18n="save">Save</button>
        </form>
      </section>

      <section class="panel" id="cloudflare">
        <h2 id="cloudflare-title">Cloudflare</h2>
        <dl class="facts" id="tunnel-facts"></dl>
        <p class="panel-help" data-i18n="tunnelHelp">Create a remotely-managed tunnel in the Cloudflare dashboard, route a hostname to http://127.0.0.1 and the API port, install cloudflared 2025.4.0 or newer, then paste the connector token.</p>
        <form id="tunnel-form" class="form" autocomplete="off">
          <label for="tunnel-token" data-i18n="tunnelToken">Connector token</label>
          <input id="tunnel-token" type="password" spellcheck="false">
          <label for="tunnel-host" data-i18n="tunnelHost">Hostname (https://, informational)</label>
          <input id="tunnel-host" spellcheck="false">
          <div class="row"><button type="submit" data-i18n="tunnelSave">Save and start</button><button type="button" class="ghost" id="tunnel-restart" data-i18n="restart">Restart</button><button type="button" class="ghost danger" id="tunnel-remove" data-i18n="remove">Remove</button></div>
        </form>
      </section>`);

const LOG = page("log", LOG_HTML);

const SECURITY = page("security", `${RISKS_HTML}

      ${DEVICES_HTML}

      <section class="panel" id="ai-calls">
        <h2 id="ai-calls-title" data-i18n="callsTitle">AI call records</h2>
        <p class="panel-help" data-i18n="callsHelp">While the autopilot runs, the server keeps what each AI call sent and what came back, so that the app can show it. The records hold the book's text, its secrets and your notes; they stay in the book's private folder on this computer, outside git.</p>
        <dl class="facts" id="ai-calls-facts"></dl>
        <div class="row"><button type="button" class="ghost" id="ai-calls-toggle"></button></div>
      </section>

      <section class="panel" id="admin-code">
        <h2 id="admin-code-title" data-i18n="codeTitle">Admin code</h2>
        <p class="panel-help" data-i18n="codeDevicesNote">Changing the admin code also revokes every remembered device.</p>
        <form id="code-form" class="form" autocomplete="off">
          <label for="code-1" data-i18n="codeNew">New code (32-200 characters)</label>
          <input id="code-1" type="password" minlength="32" maxlength="200">
          <label for="code-2" data-i18n="codeRepeat">Repeat the new code</label>
          <input id="code-2" type="password" minlength="32" maxlength="200">
          <div class="row"><button type="submit" data-i18n="codeSet">Set this code</button><button type="button" class="ghost" id="code-rotate" data-i18n="codeRotate">Generate a random code</button></div>
        </form>
      </section>`);

export const PAGES_HTML = [OVERVIEW, BOOKS, UPDATES, CLIENTS, APPS, AI, NETWORK, LOG, SECURITY].join("\n\n    ");
