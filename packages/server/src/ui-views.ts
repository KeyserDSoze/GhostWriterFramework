import { VIEW_TEXTS } from "./ui-texts.js";

/**
 * The admin panel's overview views: the risks of the set-up, the health of the server, the books in progress, the history of the updates and the action log. Their markup and their script
 * are here; `ui.ts` puts them in the pages, the style (`ui-style.ts`) and the script of the panel. Like the rest of the panel they work under the strict CSP (nothing inline, nothing from
 * outside) and everything that comes from the server is put in as text, never as markup.
 *
 * Accessibility (WCAG 2.2 AA): a state is always a word (with a glyph that a screen reader skips), never a colour alone; every table has headers with a scope and a name, and a table
 * that scrolls is a focusable region; the one line of risks and the one line of health are polite live regions that are written again only when their words change; the colours are the
 * page's own tokens, whose contrast a test checks.
 */

export const RISKS_HTML = `<section class="panel risks hidden" id="risks">
        <h2 id="risks-title" data-i18n="riskTitle">Risks in this server's set-up</h2>
        <p class="panel-help" data-i18n="riskHelp">Each one is true of this server right now, and goes away when you change it.</p>
        <p class="risk-summary" id="risk-summary" role="status" aria-live="off" aria-atomic="true"></p>
        <ul class="risk-list" id="risk-list"></ul>
        <details class="risk-notes hidden" id="risk-notes">
          <summary id="risk-notes-summary"></summary>
          <ul class="risk-list" id="risk-note-list"></ul>
        </details>
      </section>`;

export const HEALTH_HTML = `<section class="panel" id="health">
        <div class="panel-head"><h2 id="health-title" data-i18n="healthTitle">Server health</h2><button type="button" class="ghost small" id="health-refresh" data-i18n="check">Check again</button></div>
        <p class="health-summary" id="health-summary" role="status" aria-live="off" aria-atomic="true"></p>
        <div class="table-wrap" tabindex="0" role="region" aria-labelledby="health-title"><table class="stack lines" role="table" aria-labelledby="health-title"><thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col" data-i18n="healthCheck">Check</th><th role="columnheader" scope="col" class="c-status" data-i18n="healthStatus">Status</th><th role="columnheader" scope="col" data-i18n="healthDetails">Details</th></tr></thead><tbody role="rowgroup" id="health-rows"></tbody></table></div>
        <p class="muted small" id="health-note"></p>
      </section>`;

export const RUNS_HTML = `<section class="panel" id="runs">
        <h2 id="runs-title" data-i18n="runsTitle">Books in progress</h2>
        <p class="runs-summary" id="runs-summary"></p>
        <p class="muted small" id="runs-today"></p>
        <div class="table-wrap long" tabindex="0" role="region" aria-labelledby="runs-title"><table class="stack" role="table" aria-labelledby="runs-title"><thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col" class="c-book" data-i18n="runsBook">Book</th><th role="columnheader" scope="col" class="c-state" data-i18n="runsState">State</th><th role="columnheader" scope="col" class="c-progress" data-i18n="runsProgress">Progress</th><th role="columnheader" scope="col" class="c-run" data-i18n="runsRun">Run</th><th role="columnheader" scope="col" class="c-spent" data-i18n="runsSpend">Spent</th></tr></thead><tbody role="rowgroup" id="runs-rows"></tbody></table></div>
        <p class="muted small" id="runs-note"></p>
        <div class="row"><button type="button" class="ghost hidden" id="runs-more"></button></div>
      </section>`;

/** The history of the updates is a panel of its own on the Updates page. */
export const HISTORY_HTML = `<section class="panel" id="history">
        <h2 id="history-title" data-i18n="histTitle">Update history</h2>
        <p class="panel-help" data-i18n="histHelp">The last updates: how each ended, who asked, and what the supervisor checked on the way. A newer release that this server refused to offer is listed too.</p>
        <div class="table-wrap long" tabindex="0" role="region" aria-labelledby="history-title"><table class="stack" role="table" aria-labelledby="history-title"><thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col" class="c-when" data-i18n="histWhen">When</th><th role="columnheader" scope="col" class="c-version" data-i18n="histVersion">Version</th><th role="columnheader" scope="col" class="c-by" data-i18n="histBy">Asked by</th><th role="columnheader" scope="col" class="c-result" data-i18n="histResult">Result</th><th role="columnheader" scope="col" class="c-checks" data-i18n="histChecks">Checks</th></tr></thead><tbody role="rowgroup" id="history-rows"></tbody></table></div>
        <p class="muted small" id="history-note"></p>
      </section>`;

export const LOG_HTML = `<section class="panel" id="log">
        <h2 class="sr-only" id="log-title" data-i18n="logTitle">Action log</h2>
        <div class="filters">
          <div><label for="log-type" data-i18n="logFilterType">Type</label><select id="log-type"><option value="" data-i18n="logTypeAll">All types</option><option value="access" data-i18n="logTypeAccess">Access</option><option value="clients" data-i18n="logTypeClients">Clients</option><option value="updates" data-i18n="logTypeUpdates">Updates</option><option value="apps" data-i18n="logTypeApps">Apps (MCP)</option><option value="ai" data-i18n="logTypeAi">AI endpoints</option><option value="spend" data-i18n="logTypeSpend">AI spending</option><option value="network" data-i18n="logTypeNetwork">Network</option><option value="books" data-i18n="logTypeBooks">Books and runs</option></select></div>
          <div><label for="log-result" data-i18n="logFilterResult">Result</label><select id="log-result"><option value="" data-i18n="logResultAll">All results</option><option value="true" data-i18n="logResultWorked">Worked</option><option value="false" data-i18n="logResultFailed">Failed</option></select></div>
        </div>
        <div class="table-wrap long" tabindex="0" role="region" aria-labelledby="log-title"><table class="stack" role="table" aria-labelledby="log-title"><thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col" class="c-when" data-i18n="logWhen">When</th><th role="columnheader" scope="col" class="c-who" data-i18n="logWho">Who</th><th role="columnheader" scope="col" class="c-what" data-i18n="logWhat">What</th><th role="columnheader" scope="col" class="c-on" data-i18n="logOn">On</th><th role="columnheader" scope="col" class="c-result" data-i18n="logOutcome">Result</th></tr></thead><tbody role="rowgroup" id="log-rows"></tbody></table></div>
        <p class="muted small" id="log-note"></p>
        <div class="row"><button type="button" class="ghost hidden" id="log-more" data-i18n="logMore">Older entries</button></div>
      </section>`;

/** Runs inside the panel's own function: it uses its `t`, `pick`, `el`, `call`, `when`, `$`, `lang`, `csrf` and `T`. */
export const VIEWS_JS = String.raw`  // ---- the overview views: risks, health, books in progress, update history, action log
  var VIEW_TEXTS = ${JSON.stringify(VIEW_TEXTS)};
  Object.keys(VIEW_TEXTS).forEach(function (language) {
    Object.keys(VIEW_TEXTS[language]).forEach(function (key) { T[language][key] = VIEW_TEXTS[language][key]; });
  });
  var RUNS_PAGE = 10;
  var RUNS_ALL = 200;
  var risks = null;
  var health = null;
  var runs = null;
  var runsAll = false;
  var runsSerial = 0;
  var updatesHistory = null;
  var actionLog = { rows: [], next: null, older: false, type: "", result: "", serial: 0, loaded: false };
  var RISK_GO = { "remote-admin": ["#/network", "navNetwork"], "client-update": ["#/clients", "navClients"], "oauth-write": ["#/apps", "navApps"], "spend-unlimited": ["#/ai", "navAi"], "no-passkey": ["#/apps", "navApps"], "client-run": ["#/clients", "navClients"], "ai-remote": ["#/ai", "navAi"], "device-remember": ["#/security", "navSecurity"] };
  var RISK_TONE = { high: ["bad", "✕"], medium: ["warn", "!"], note: ["info", "i"] };
  var HEALTH_TONE = { ok: ["ok", "✓"], info: ["info", "i"], warn: ["warn", "!"], bad: ["bad", "✕"], off: ["off", "–"], unknown: ["off", "?"] };
  var RUN_TONE = { stalled: ["warn", "!"], retrying: ["warn", "↻"], running: ["ok", "▶"], waiting: ["info", "?"], error: ["bad", "✕"], unreadable: ["bad", "✕"], paused: ["off", "‖"], idle: ["off", "–"], completed: ["ok", "✓"], none: ["off", "–"] };
  var HISTORY_TONE = { requested: ["info", "…"], completed: ["ok", "✓"], failed: ["bad", "✕"], limited: ["off", "–"], stopping: ["off", "–"], refused: ["warn", "!"] };

  function fill(values) {
    var out = {};
    Object.keys(values).forEach(function (name) {
      var value = values[name];
      out[name] = value === undefined || value === null || (typeof value === "number" && !isFinite(value)) ? "?" : value;
    });
    return out;
  }
  function plural(key, n, values) { return t(n === 1 && T[lang][key + "One"] ? key + "One" : key, values); }
  function many(group, key, n, values) { var one = n === 1 ? pick(group, key + "-one", values) : ""; return one || pick(group, key, values); }
  function num(value) { return typeof value === "number" && isFinite(value) ? value.toLocaleString(lang === "it" ? "it-IT" : "en-GB") : "?"; }
  function bytes(value) {
    var units = ["B", "KiB", "MiB", "GiB", "TiB"]; var step = 0; var size = typeof value === "number" && isFinite(value) && value > 0 ? value : 0;
    while (size >= 1024 && step < units.length - 1) { size = size / 1024; step += 1; }
    return (step === 0 || size >= 100 ? Math.round(size) : Math.round(size * 10) / 10) + " " + units[step];
  }
  function span(ms) {
    var seconds = Math.floor((typeof ms === "number" && isFinite(ms) && ms > 0 ? ms : 0) / 1000);
    if (seconds < 60) return seconds + " " + t("unitSec");
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + " " + t("unitMin");
    var hours = Math.floor(minutes / 60);
    if (hours < 48) return hours + " " + t("unitHour") + (minutes % 60 ? " " + (minutes % 60) + " " + t("unitMin") : "");
    var days = Math.floor(hours / 24);
    return days + " " + t("unitDay") + (hours % 24 ? " " + (hours % 24) + " " + t("unitHour") : "");
  }
  function badge(text, tone, glyph) {
    var node = el("span", "badge " + tone); var mark = el("span", "glyph", glyph); mark.setAttribute("aria-hidden", "true");
    node.appendChild(mark); node.appendChild(document.createTextNode(" " + text));
    return node;
  }
  /** Rows and cells keep their table roles (a phone draws them as blocks), and a cell knows its label for the card it becomes. */
  function trow() { var node = el("tr"); node.setAttribute("role", "row"); return node; }
  function rowHead() { var node = el("th"); node.setAttribute("scope", "row"); node.setAttribute("role", "rowheader"); return node; }
  function tcell(label, cls) { var node = el("td", cls || ""); node.setAttribute("role", "cell"); if (label) node.setAttribute("data-label", t(label)); return node; }
  function dash(node) { node.appendChild(document.createTextNode("—")); node.classList.add("empty"); return node; }
  function emptyRow(body, columns, text) {
    var row = trow(); var box = tcell("", "empty-state"); box.textContent = text; box.setAttribute("colspan", String(columns)); row.appendChild(box); body.appendChild(row);
  }
  /** Written only when the words are not the same: a screen reader says it when it changes, and not again at every poll. */
  function setLive(id, text) { var node = $(id); if (node.textContent !== text) node.textContent = text; node.setAttribute("aria-live", "polite"); }
  function setNote(id, text) { var node = $(id); if (node.textContent !== text) node.textContent = text; }
  /** A quiet "Loading…" in a table that has nothing yet; whatever draws the table (or fails to) takes it away. */
  function showLoading(ids) {
    ids.forEach(function (id) {
      var body = $(id); if (body.children.length) return;
      var row = trow(); row.className = "loading-row"; var box = tcell("", "loading"); box.textContent = t("loading"); box.setAttribute("colspan", "6"); row.appendChild(box); body.appendChild(row);
    });
  }
  function clearLoading(id) { var body = $(id); if (body && body.children.length === 1 && body.children[0].className === "loading-row") body.textContent = ""; }
  function load(path, apply, noteId, bodyId) {
    var quiet = polling;
    return call("GET", path).then(function (data) { if (signed) { if (noteId) setNote(noteId, ""); if (!unchanged(path, data, quiet)) apply(data); } }).catch(function () { if (signed) { if (bodyId) clearLoading(bodyId); if (noteId) setNote(noteId, t("viewFailed")); } });
  }

  // Risks
  function more(list, count) { return list.join(", ") + (typeof count === "number" && count > list.length ? ", …" : ""); }
  function riskValues(risk) {
    var f = risk.facts || {};
    var values = { count: f.count, books: f.books, address: f.address, publicUrl: f.publicUrl, clients: f.clients, apps: f.apps, labels: undefined, hosts: undefined };
    if (Array.isArray(f.labels)) values.labels = more(f.labels, f.count);
    if (risk.id === "oauth-write" && Array.isArray(f.apps)) values.apps = more(f.apps.map(function (app) { return app.name + " (" + app.bookId + ")"; }), f.count);
    if (Array.isArray(f.hosts)) values.hosts = f.hosts.join(", ");
    if (risk.id === "spend-unlimited") {
      var who = [];
      if (f.clients) who.push(many("riskWho", "clients", f.clients, { n: f.clients }));
      if (f.apps) who.push(many("riskWho", "apps", f.apps, { n: f.apps }));
      values.who = who.join(" " + t("riskAnd") + " ");
    }
    return fill(values);
  }
  function riskItem(risk, level) {
    var f = risk.facts || {}; var needsName = risk.id === "no-passkey" && f.canAddPasskey === false;
    var target = needsName ? ["#/network", "navNetwork"] : RISK_GO[risk.id]; var values = riskValues(risk); var tone = RISK_TONE[level];
    var item = el("li", "risk " + level); var head = el("div", "risk-head");
    head.appendChild(badge(pick("riskLevels", level), tone[0], tone[1]));
    head.appendChild(el("span", "risk-title", many("riskTitles", risk.id, typeof f.count === "number" ? f.count : f.books, values)));
    item.appendChild(head);
    var why = pick("riskWhy", risk.id === "device-remember" && f.remote ? "device-remember-remote" : risk.id, values); if (why) item.appendChild(el("p", "muted small", why));
    var action = el("p", "", pick("riskDo", needsName ? "no-passkey-name" : risk.id, values) + " ");
    // The devices are on the page where this is read: there is nowhere else to go.
    if (risk.id !== "device-remember") { var link = el("a", "", t("riskGo", { where: t(target[1]) })); link.setAttribute("href", target[0]); action.appendChild(link); }
    item.appendChild(action);
    return item;
  }
  function renderRisks() {
    var card = $("risks");
    if (!risks) { card.classList.add("hidden"); return; }
    var list = $("risk-list"); var notes = $("risk-note-list"); list.textContent = ""; notes.textContent = "";
    var counts = { high: 0, medium: 0, note: 0 };
    (risks.risks || []).forEach(function (risk) {
      if (!risk || !RISK_GO[risk.id]) return;
      var level = risk.level === "high" || risk.level === "medium" ? risk.level : "note";
      counts[level] += 1; (level === "note" ? notes : list).appendChild(riskItem(risk, level));
    });
    var total = counts.high + counts.medium + counts.note; var parts = [];
    ["high", "medium", "note"].forEach(function (level) { if (counts[level]) parts.push(many("riskCounts", level, counts[level], { n: counts[level] })); });
    card.classList.remove("hidden"); card.classList.remove("risks-high"); card.classList.remove("risks-medium");
    if (counts.high) card.classList.add("risks-high"); else if (counts.medium) card.classList.add("risks-medium");
    setLive("risk-summary", total ? t("riskSummary", { list: parts.join(", ") }) : t("riskNone"));
    var folded = $("risk-notes");
    if (counts.note) { folded.classList.remove("hidden"); $("risk-notes-summary").textContent = t("riskNotes", { n: counts.note }); } else folded.classList.add("hidden");
    renderChrome();
  }
  function loadRisks() { return load("/admin/api/risks", function (data) { risks = data; renderRisks(); }); }

  // Health
  function healthDetail(check, status) {
    var f = check.facts || {};
    if (status === "unknown" && check.id !== "disk") return t("healthUnknown");
    switch (check.id) {
      case "server":
        return f.maintenance ? pick("healthText", "server-maintenance") : pick("healthText", "server", fill({ uptime: span(f.uptimeMs), since: f.startedAt ? when(f.startedAt) : undefined }));
      case "versions":
        var kind = f.update || "unknown"; if (kind === "pending" && !f.latest) kind = "pending-unknown";
        return pick("healthText", "versions-" + kind, fill({ server: f.server, engine: f.engine, latest: f.latest }));
      case "disk":
        return status === "unknown" ? pick("healthText", "disk-unknown") : pick("healthText", "disk-" + (status === "bad" ? "bad" : status === "warn" ? "warn" : "ok"), { free: bytes(f.freeBytes), total: bytes(f.totalBytes) });
      case "git":
        return many("healthText", "git-" + (status === "ok" ? "ok" : status === "warn" ? "warn" : "info"), f.githubBooks, fill({ githubBooks: f.githubBooks }));
      case "tunnel":
        if (status === "off") return pick("healthText", "tunnel-off");
        if (status === "ok") return pick("healthText", "tunnel-ok");
        if (status === "warn") return pick("healthText", "tunnel-warn");
        var why = pick("healthTunnelErrors", f.errorCode || "");
        return why ? pick("healthText", "tunnel-bad", { why: why }) : pick("healthText", "tunnel-bad-unknown");
      case "runs":
        return many("healthText", "runs-" + (status === "warn" ? "warn" : status === "info" ? "info" : "ok"), f.refused24h, fill({ running: f.running, max: f.max, refused24h: f.refused24h }));
      case "spend":
        var said = [];
        if (f.paused) said.push(pick("healthText", "spend-paused"));
        if (f.capReached) said.push(pick("healthText", "spend-cap-" + f.capReached));
        if (f.damaged) said.push(pick("healthText", "spend-damaged"));
        return said.length ? said.join(" ") : pick("healthText", "spend-ok");
      case "books":
        var total = f.total || 0; var bits = [];
        if (!total) return pick("healthText", "books-none");
        if (status === "ok") return many("healthText", "books-ok", total, { total: total });
        if (f.unreadable) bits.push(many("healthText", "books-part-unreadable", f.unreadable, { n: f.unreadable }));
        if (f.error) bits.push(many("healthText", "books-part-error", f.error, { n: f.error }));
        if (f.stalled) bits.push(many("healthText", "books-part-stalled", f.stalled, { n: f.stalled }));
        return many("healthText", "books-warn", total, { total: total, parts: bits.join(", ") });
      case "error":
        if (!f.at) return pick("healthText", "error-ok");
        return pick("healthText", "error", fill({ when: when(f.at), name: f.name, route: f.route, where: pick("healthWhere", f.where || "") || f.where, requestId: f.requestId }));
      default:
        return "—";
    }
  }
  function healthRow(check) {
    var row = trow(); var name = rowHead(); name.textContent = pick("healthNames", check.id) || check.id; row.appendChild(name);
    var status = HEALTH_TONE[check.status] ? check.status : "unknown"; var tone = HEALTH_TONE[status];
    var state = tcell("healthStatus"); state.appendChild(badge(pick("healthStates", status), tone[0], tone[1])); row.appendChild(state);
    var detail = tcell("healthDetails"); detail.textContent = healthDetail(check, status); row.appendChild(detail);
    return row;
  }
  function renderHealth() {
    if (!health) return;
    var body = $("health-rows"); body.textContent = "";
    (health.checks || []).forEach(function (check) { if (check && check.id) body.appendChild(healthRow(check)); });
    var attention = (health.attention || []).map(function (id) { return pick("healthNames", id) || id; });
    setLive("health-summary", health.overall === "ok" || !attention.length ? t("healthOk") : t("healthAttention", { list: attention.join(", ") }));
    renderChrome();
  }
  function loadHealth() { return load("/admin/api/health", function (data) { health = data; renderHealth(); }, "health-note", "health-rows"); }

  // Books in progress
  function stepName(step) { return pick("runsSteps", step) || step; }
  function errorText(failure) {
    var parts = [];
    if (failure.kind) parts.push(pick("runsKinds", failure.kind) || failure.kind);
    if (failure.task) parts.push(pick("runsText", "atStep", { step: stepName(failure.task) }));
    if (typeof failure.status === "number") parts.push(pick("runsText", "http", { status: failure.status }));
    return parts.length ? pick("runsText", "lastError", { parts: parts.join(", ") }) : "";
  }
  function runDetail(book) {
    var parts = [];
    if (book.state === "stalled") parts.push(pick("runsText", "stalled", fill({ age: span(book.heartbeatAgeMs) })));
    if (book.state === "retrying" && book.retry) parts.push(pick("runsText", "retrying", fill({ attempt: book.retry.attempt, retries: book.retry.retries, in: span(book.retry.inMs) })));
    if (book.state === "waiting") parts.push(pick("runsText", "waiting"));
    if ((book.state === "error" || book.state === "retrying") && book.lastError) { var failure = errorText(book.lastError); if (failure) parts.push(failure); }
    if (book.state === "unreadable" && book.error) parts.push(book.error);
    if (book.pausePending) parts.push(pick("runsText", book.pausePending));
    return parts.join(" ");
  }
  function stepLine(book) {
    var parts = [t("runsNow", { step: stepName(book.step) })];
    if (typeof book.stepChapter === "number") parts.push(typeof book.stepScene === "number" ? t("runsStepScene", { n: book.stepChapter, s: book.stepScene }) : t("runsStepChapter", { n: book.stepChapter }));
    if (typeof book.stepSinceMs === "number") parts.push(t("runsFor", { span: span(book.stepSinceMs) }));
    return parts.join(" · ");
  }
  function spendText(spent) {
    var text = t("runsSpent", { tokens: num(spent.tokens), calls: num(spent.calls) });
    if (typeof spent.cost === "number") text += t("spendCostUsed", { cost: spent.cost, currency: spent.currency || "" }).replace(/ $/, "");
    if (spent.costUnknownCalls) text += t("spendUnknown", { n: spent.costUnknownCalls });
    return text;
  }
  function runRow(book) {
    var row = trow();
    var title = rowHead(); title.appendChild(el("div", "", book.title)); title.appendChild(el("div", "muted small", book.storage === "github" ? t("github") : t("local"))); row.appendChild(title);
    var state = tcell("runsState", "state-cell"); var tone = RUN_TONE[book.state] || ["off", "–"];
    state.appendChild(badge(pick("runsStates", book.state) || book.state, tone[0], tone[1]));
    var detail = runDetail(book); if (detail) state.appendChild(el("div", "muted small", detail));
    row.appendChild(state);
    var progress = tcell("runsProgress");
    if (book.chapter) {
      var line = t("runsChapter", { current: book.chapter.current, total: book.chapter.total });
      var bar = document.createElement("progress"); bar.setAttribute("value", String(book.chapter.done)); bar.setAttribute("max", String(book.chapter.total)); bar.setAttribute("aria-label", line);
      progress.appendChild(bar); progress.appendChild(el("div", "", line + " · " + t("runsDone", { done: book.chapter.done })));
    }
    if (book.step) progress.appendChild(el("div", "muted small", stepLine(book)));
    if (!progress.children.length) dash(progress);
    row.appendChild(progress);
    var runner = book.runner; var run = tcell("runsRun");
    if (runner) run.appendChild(el("div", "", runner.host === "browser" ? (runner.label ? pick("runsRunners", "browser", { label: runner.label }) : pick("runsRunners", "browser-unnamed")) : pick("runsRunners", runner.thisServer ? "server" : "other")));
    var going = book.state === "running" || book.state === "stalled" || book.state === "retrying";
    if (going && typeof book.sinceMs === "number") run.appendChild(el("div", "muted small", t("runsFor", { span: span(book.sinceMs) })));
    else if (book.updatedAt) run.appendChild(el("div", "muted small", t("runsUpdated", { when: when(book.updatedAt) })));
    if (!run.children.length) dash(run);
    row.appendChild(run);
    var spent = tcell("runsSpend");
    if (book.spend) { spent.appendChild(el("div", "", spendText(book.spend))); if (!book.spend.active) spent.appendChild(el("div", "muted small", t("runsLastRun"))); } else dash(spent);
    row.appendChild(spent);
    return row;
  }
  function renderRuns() {
    if (!runs) return;
    var body = $("runs-rows"); body.textContent = ""; var books = runs.books || [];
    if (!books.length) emptyRow(body, 5, t("noBooks"));
    books.forEach(function (book) { body.appendChild(runRow(book)); });
    $("runs-summary").textContent = plural("runsSummary", runs.total, fill({ running: runs.running, max: runs.maxConcurrentRuns, total: runs.total }));
    var today = runs.spendToday;
    $("runs-today").textContent = today && typeof today.tokens === "number" ? t("spendToday", { day: today.day || "" }) + ": " + spendText(today) : "";
    var button = $("runs-more");
    if (runs.total > RUNS_PAGE) { button.classList.remove("hidden"); button.textContent = runsAll ? t("runsLess") : t("runsMore", { total: runs.total }); } else button.classList.add("hidden");
    setNote("runs-note", runsAll && runs.total > books.length ? t("runsShowing", { n: books.length, total: runs.total }) : "");
    renderChrome();
  }
  function loadRuns() {
    var serial = ++runsSerial;
    return load("/admin/api/runs?limit=" + (runsAll ? RUNS_ALL : RUNS_PAGE), function (data) { if (serial === runsSerial) { runs = data; renderRuns(); } }, "runs-note", "runs-rows");
  }

  // History of the updates
  function checkLabel(name) { return pick("histCheckNames", name) || name; }
  function checkResult(result) { return pick("histCheckResults", result) || result; }
  function stoppedAt(refusal) {
    if (!refusal || !refusal.check) return "";
    return t("histStoppedAt", { check: checkLabel(refusal.check), result: checkResult(refusal.kind), code: refusal.code ? " (" + refusal.code + ")" : "" });
  }
  function checksCell(entry) {
    var box = tcell("histChecks"); var checks = entry.checks || []; var stop = stoppedAt(entry.refusal);
    if (entry.state === "limited" || entry.state === "stopping") { box.appendChild(el("span", "muted small", t("histNoCheck"))); return box; }
    if (entry.state === "requested") return dash(box);
    if (stop || (entry.refusal && entry.refusal.reason)) {
      if (stop) box.appendChild(el("div", "", stop));
      if (entry.refusal.reason) box.appendChild(el("div", "muted small", entry.refusal.reason));
    } else if (checks.length) {
      var passed = 0; var tolerated = 0;
      checks.forEach(function (check) { if (check.result === "passed") passed += 1; else if (check.result === "tolerated") tolerated += 1; });
      box.appendChild(el("div", "", tolerated ? t("histSomePassed", { passed: passed, tolerated: tolerated }) : t("histAllPassed", { n: checks.length })));
    } else box.appendChild(el("span", "muted small", t("histNoRecord")));
    if (checks.length) {
      var details = document.createElement("details"); details.className = "checks"; details.appendChild(el("summary", "", t("histDetails")));
      var list = el("ul");
      checks.forEach(function (check) {
        var item = el("li", "", checkLabel(check.check) + ": " + checkResult(check.result) + (check.code ? " (" + check.code + ")" : ""));
        if (check.reason) item.appendChild(el("div", "muted small", check.reason));
        list.appendChild(item);
      });
      details.appendChild(list); box.appendChild(details);
    }
    return box;
  }
  function historyRow(entry) {
    var row = trow();
    var when_ = tcell("histWhen"); when_.textContent = when(entry.at); row.appendChild(when_);
    var version = tcell("histVersion", "nowrap"); version.textContent = entry.from && entry.to ? entry.from + " → " + entry.to : (entry.to || entry.from || "—"); row.appendChild(version);
    var by = tcell("histBy");
    if (entry.by === "admin") by.textContent = pick("histBys", "admin");
    else if (entry.by === "client") by.textContent = entry.actor ? pick("histBys", "client", { actor: entry.actor }) : pick("histBys", "client-unnamed");
    else dash(by);
    row.appendChild(by);
    var result = tcell("histResult"); var tone = HISTORY_TONE[entry.state] || ["off", "–"];
    result.appendChild(badge(pick("histStates", entry.state) || entry.state, tone[0], tone[1])); row.appendChild(result);
    row.appendChild(checksCell(entry));
    return row;
  }
  function renderHistory() {
    if (!updatesHistory) return;
    var body = $("history-rows"); body.textContent = ""; var entries = updatesHistory.entries || [];
    if (!entries.length) emptyRow(body, 5, t("histNone"));
    entries.forEach(function (entry) { body.appendChild(historyRow(entry)); });
  }
  function loadHistory() { return load("/admin/api/updates/history", function (data) { updatesHistory = data; renderHistory(); }, "history-note", "history-rows"); }

  // Action log
  function logActor(actor) {
    var who = actor || {}; var kind = who.kind || "system";
    if (kind === "client" || kind === "device") return who.label ? pick("logActors", kind, { label: who.label }) : pick("logActors", kind + "-unnamed");
    return pick("logActors", kind) || kind;
  }
  function logRow(entry) {
    var row = trow();
    var moment = tcell("logWhen"); moment.textContent = when(entry.at); row.appendChild(moment);
    var who = tcell("logWho"); who.appendChild(el("div", "", logActor(entry.actor)));
    if (entry.source) who.appendChild(el("div", "muted small", t("logFrom", { source: entry.source === "local" ? t("thisComputer") : entry.source })));
    row.appendChild(who);
    var what = tcell("logWhat"); what.textContent = pick("logActions", entry.action) || String(entry.action); row.appendChild(what);
    var on = tcell("logOn");
    var devices = entry.action === "admin.device.revoke" && (entry.detail === "all" || entry.detail === "code-changed") ? Number(entry.object) : NaN;
    if (isFinite(devices)) on.appendChild(el("div", "", plural("logDevices", devices, { n: devices })));
    else { if (entry.label) on.appendChild(el("div", "", entry.label)); if (entry.object) on.appendChild(el("code", "", entry.object)); }
    if (entry.detail) on.appendChild(el("div", "muted small", pick("logDetails", entry.detail) || entry.detail));
    if (!on.children.length) dash(on);
    row.appendChild(on);
    var result = tcell("logOutcome"); result.appendChild(entry.ok ? badge(t("logDone"), "ok", "✓") : badge(t("logFailed", { code: entry.code || "?" }), "bad", "✕"));
    if (entry.count > 1) result.appendChild(el("div", "muted small", t("logRepeat", { count: entry.count, when: when(entry.last || entry.at) })));
    row.appendChild(result);
    return row;
  }
  function renderLog() {
    if (!actionLog.loaded) return;
    var body = $("log-rows"); body.textContent = "";
    if (!actionLog.rows.length) emptyRow(body, 5, actionLog.type || actionLog.result ? t("logNoneFiltered") : t("logNone"));
    actionLog.rows.forEach(function (entry) { body.appendChild(logRow(entry)); });
    if (actionLog.next === null || actionLog.next === undefined) $("log-more").classList.add("hidden"); else $("log-more").classList.remove("hidden");
  }
  function loadLog(older) {
    var serial = ++actionLog.serial;
    var query = "?limit=20" + (actionLog.type ? "&type=" + encodeURIComponent(actionLog.type) : "") + (actionLog.result ? "&ok=" + encodeURIComponent(actionLog.result) : "") + (older && actionLog.next ? "&before=" + actionLog.next : "");
    return load("/admin/api/log" + query, function (page) {
      if (serial !== actionLog.serial) return;
      actionLog.rows = older ? actionLog.rows.concat(page.entries || []) : (page.entries || []); actionLog.next = page.nextBefore === undefined ? null : page.nextBefore;
      actionLog.older = !!older; actionLog.loaded = true; renderLog();
    }, "log-note", "log-rows");
  }

  function loadViews() { loadRisks(); loadHealth(); loadRuns(); loadHistory(); if (!actionLog.older) loadLog(false); }
  function renderViews() { renderRisks(); renderHealth(); renderRuns(); renderHistory(); renderLog(); }
  function resetViews() {
    risks = null; health = null; runs = null; updatesHistory = null; runsAll = false; runsSerial += 1;
    actionLog = { rows: [], next: null, older: false, type: "", result: "", serial: actionLog.serial + 1, loaded: false };
    ["risk-list", "risk-note-list", "health-rows", "runs-rows", "history-rows", "log-rows", "risk-summary", "health-summary", "runs-summary", "runs-today", "health-note", "runs-note", "history-note", "log-note"].forEach(function (id) { $(id).textContent = ""; });
    ["risks", "risk-notes", "runs-more", "log-more"].forEach(function (id) { $(id).classList.add("hidden"); });
    $("risk-summary").setAttribute("aria-live", "off"); $("health-summary").setAttribute("aria-live", "off");
    $("log-type").value = ""; $("log-result").value = "";
  }
  function bindViews() {
    function filtered() { actionLog.type = $("log-type").value; actionLog.result = $("log-result").value; actionLog.older = false; loadLog(false); }
    $("log-type").addEventListener("change", filtered);
    $("log-result").addEventListener("change", filtered);
    $("log-more").addEventListener("click", function () { loadLog(true); });
    $("runs-more").addEventListener("click", function () { runsAll = !runsAll; loadRuns(); });
    $("health-refresh").addEventListener("click", function () { loadHealth(); });
  }
`;
