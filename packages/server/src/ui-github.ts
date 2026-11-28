/**
 * The "GitHub connection" card of the admin panel (on the Books page): how the server's own connection to GitHub is (not connected, waiting for the owner to type a code, connected, or lost), who
 * it is connected as, when it was renewed and when it ends, which broker renews it, the code to type and where, the problem in words, and the button that disconnects it. The owner starts
 * the connection from Narrarium (which knows the GitHub App's client id and the broker); here it is read, and ended. The texts are in `ui-texts.ts`. Like the rest of the panel it works under
 * the strict CSP and everything the server says is put in as text, never as markup; a state is a word with a glyph, never a colour alone.
 */

export const GITHUB_HTML = `<section class="panel" id="github">
        <h2 id="github-title" data-i18n="ghTitle">GitHub connection</h2>
        <p class="panel-help" data-i18n="ghHelp">The server can connect to GitHub on its own, with the GitHub App, and renew that connection without any browser open. A book that uses it keeps no token. You start it from Narrarium (Settings → Personal server); here you see how it is, and can disconnect it.</p>
        <p class="github-state" id="github-state" role="status" aria-live="off" aria-atomic="true"></p>
        <dl class="facts" id="github-facts"></dl>
        <div class="notice hidden" id="github-code-box">
          <p><span data-i18n="ghCodeIntro">Open this address on any device and enter the code:</span> <a id="github-address" rel="noopener noreferrer" target="_blank"></a></p>
          <p><span data-i18n="ghCode">Code</span>: <code id="github-code"></code> <button type="button" class="ghost small" id="github-code-copy" data-i18n="copy">Copy</button></p>
          <p class="muted small" id="github-code-until"></p>
        </div>
        <p class="notice hidden" id="github-problem" role="status"></p>
        <p class="muted small" id="github-note"></p>
        <div class="row"><button type="button" class="ghost danger" id="github-disconnect" data-i18n="ghDisconnect" disabled>Disconnect</button></div>
      </section>`;

/** Runs inside the panel's own function: it uses its `t`, `pick`, `plural`, `el`, `call`, `load`, `when`, `$`, `toast`, `fail`, `copyText`, `fact`, `badge`. */
export const GITHUB_JS = String.raw`  // ---- the server's own GitHub connection
  var github = null;
  var GITHUB_TONE = { connected: ["ok", "✓"], pending: ["info", "…"], "needs-reconnect": ["bad", "✕"], disconnected: ["off", "–"] };
  function githubProblemText(problem, state) {
    var code = problem.code;
    // A code that means one thing is told in the panel's language; the ones that say more than one (what GitHub refused, what could not be saved) keep the words of the server.
    if (code === "renewal-failed" && state === "needs-reconnect") return pick("ghProblems", "lost");
    return code === "renewal-failed" || code === "github-rejected" ? String(problem.message || code) : (pick("ghProblems", code) || String(problem.message || code));
  }
  function renderGithub() {
    var g = github; if (!g) return;
    var state = g.state in GITHUB_TONE ? g.state : "disconnected";
    var tone = GITHUB_TONE[state];
    var line = $("github-state"); line.textContent = "";
    line.appendChild(badge(pick("ghStates", state === "connected" && !g.login ? "connectedNoLogin" : state, { login: g.login || "" }), tone[0], tone[1]));
    line.setAttribute("aria-live", "polite");
    var facts = $("github-facts"); facts.textContent = "";
    if (g.login) fact(facts, t("ghAccount"), g.login);
    if (g.broker) fact(facts, t("ghBroker"), g.broker);
    if (state === "connected") {
      if (g.connectedAt) fact(facts, t("ghConnectedAt"), when(g.connectedAt));
      if (g.renewedAt) fact(facts, t("ghRenewedAt"), when(g.renewedAt));
      if (g.accessTokenExpiresAt) fact(facts, t("ghExpires"), when(g.accessTokenExpiresAt));
      if (g.refreshTokenExpiresAt) fact(facts, t("ghRefreshExpires"), when(g.refreshTokenExpiresAt));
    }
    if (typeof g.books === "number" && g.books > 0) fact(facts, t("ghBooks"), String(g.books));
    if (Array.isArray(g.allowedBrokerOrigins)) fact(facts, t("ghAllowed"), g.allowedBrokerOrigins.length ? g.allowedBrokerOrigins.join(", ") : t("none"));
    var box = $("github-code-box");
    if (state === "pending" && g.pending) {
      box.classList.remove("hidden");
      var address = $("github-address"); address.textContent = g.pending.verificationUri;
      if (/^https:\/\//.test(g.pending.verificationUri)) address.setAttribute("href", g.pending.verificationUri); else address.removeAttribute("href");
      $("github-code").textContent = g.pending.userCode;
      $("github-code-until").textContent = t("ghCodeUntil", { t: when(g.pending.expiresAt) });
    } else box.classList.add("hidden");
    var problem = $("github-problem");
    if (g.problem) { problem.textContent = githubProblemText(g.problem, state); problem.classList.remove("hidden"); }
    else { problem.textContent = ""; problem.classList.add("hidden"); }
    $("github-note").textContent = state === "disconnected" ? t("ghNoteDisconnected") : state === "needs-reconnect" ? t("ghNoteLost") : "";
    var button = $("github-disconnect");
    button.textContent = state === "pending" ? t("ghCancel") : t("ghDisconnect");
    button.disabled = state === "disconnected";
  }
  function loadGithub() { return load("/admin/api/github", function (data) { github = data; renderGithub(); }, "github-note"); }
  function disconnectGithub() {
    var books = github && typeof github.books === "number" ? github.books : 0;
    var asking = github && github.state === "pending" ? t("ghCancelConfirm") : books > 0 ? plural("ghDisconnectConfirmBooks", books, { n: books }) : t("ghDisconnectConfirm");
    if (!confirm(asking)) return;
    call("POST", "/admin/api/github/disconnect", {}).then(function (data) { github = data; renderGithub(); toast(t("ghDisconnected")); }, fail);
  }
  function resetGithub() {
    github = null;
    ["github-state", "github-facts", "github-code", "github-address", "github-code-until", "github-problem", "github-note"].forEach(function (id) { $(id).textContent = ""; });
    $("github-code-box").classList.add("hidden"); $("github-problem").classList.add("hidden"); $("github-disconnect").disabled = true;
  }
  function bindGithub() {
    $("github-disconnect").addEventListener("click", disconnectGithub);
    $("github-code-copy").addEventListener("click", function () { copyText("github-code"); });
  }
`;
