import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { seedBookFiles } from "narrarium-engine/testing";
import { fakeBrowser } from "./fake-browser.mjs";
import { adminLogin, until, withServer } from "./helpers.mjs";
import { BROKER, CLIENT_ID, fakeWorld, secretsOf } from "./github-connection-fakes.mjs";

// The "GitHub connection" card of the admin panel (on the Books page): the panel's script runs in a small fake browser against a real server with a fake GitHub and broker in the process. What each
// request carries, and what the server answers, is the real one.

const ROUTE = "/api/v1/github/connection";
const ENV = { ...process.env };

/** A panel that is signed in: the tab, what it asked of the server, and what its `confirm` was asked. */
async function openPanel(server, { language = "en-GB", confirm = () => true } = {}) {
  const origin = server.adminUrl;
  const page = { html: await (await fetch(`${origin}/`)).text(), script: await (await fetch(`${origin}/admin.js`)).text() };
  const jar = { cookie: undefined };
  const requests = [];
  const asked = [];
  const fetchFor = async (route, init = {}) => {
    const headers = { origin, ...(init.headers ?? {}) };
    if (jar.cookie) headers.cookie = jar.cookie;
    requests.push({ route, method: init.method ?? "GET", csrf: headers["x-csrf-token"] });
    const response = await fetch(`${origin}${route}`, { method: init.method, headers, body: init.body });
    const set = response.headers.get("set-cookie");
    if (set) jar.cookie = set.split(";")[0];
    const text = await response.text();
    return { status: response.status, ok: response.ok, text: async () => text };
  };
  const store = () => {
    const values = new Map();
    return { getItem: (name) => values.get(name) ?? null, setItem: (name, value) => void values.set(name, String(value)), removeItem: (name) => void values.delete(name) };
  };
  const tab = fakeBrowser(page.html, page.script, {
    fetch: fetchFor,
    location: { origin, hash: "#/books" },
    navigator: { language, clipboard: { writeText: async () => undefined } },
    confirm: (text) => {
      asked.push(text);
      return confirm(text);
    },
    extra: { localStorage: store(), sessionStorage: store() },
  });
  await tab.ready;
  const code = (await readFile(path.join(server.data.root, "private", "admin-code.txt"), "utf8")).trim();
  tab.$("code").value = code;
  await tab.$("login-form").dispatch("submit");
  await until(() => !tab.$("main-view").classList.contains("hidden"));
  return { tab, requests, asked, html: page.html, script: page.script };
}

const facts = (tab) => {
  const nodes = tab.$("github-facts").children.map((node) => node.textContent);
  const out = {};
  for (let index = 0; index < nodes.length; index += 2) out[nodes[index]] = nodes[index + 1];
  return out;
};
const stateText = (tab) => tab.$("github-state").textContent;
const shown = (tab, id) => !tab.$(id).classList.contains("hidden");

/** Let the owner connect from the app: the server polls its fake GitHub by itself. */
async function connect(server, world, script = ["tokens"]) {
  const { token } = await server.auth.issue("app", ["read", "write"]);
  const api = (method, body) => fetch(`${server.url}${ROUTE}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((response) => response.json());
  world.script.push(...script);
  const started = await api("POST", { clientId: CLIENT_ID, broker: BROKER });
  return { api, started };
}

const reload = async (tab) => {
  await tab.fire("visibilitychange");
  await new Promise((resolve) => setTimeout(resolve, 120));
};

async function scenario(run, world = fakeWorld()) {
  await withServer(async (server, client, dataDir) => run({ server, client, dataDir, world }), { githubConnection: world.options });
}

test("P15 github: the Books page has the card, with a name, a live status line and a Disconnect button that is off while nothing is connected", async () => {
  await scenario(async ({ server }) => {
    const { tab, html } = await openPanel(server);
    assert.match(html, /<section class="panel" id="github">\s*<h2 id="github-title" data-i18n="ghTitle">GitHub connection<\/h2>/, "a panel with its heading");
    assert.match(html, /<p class="github-state" id="github-state" role="status" aria-live="off" aria-atomic="true">/, "one status line, a live region that is written when its words change");
    assert.equal(tab.$("github-title").textContent, "GitHub connection");
    await until(() => stateText(tab) !== "");
    assert.match(stateText(tab), /Not connected/);
    assert.equal(tab.$("github-disconnect").disabled, true, "nothing to disconnect");
    assert.match(tab.$("github-note").textContent, /Connect it from Narrarium/);
    assert.equal(shown(tab, "github-code-box"), false);
    assert.equal(shown(tab, "github-problem"), false);
    assert.deepEqual(facts(tab), {});
    assert.equal(tab.$("github-state").attributes["aria-live"], "polite", "a state is announced once it is drawn");
  });
});

test("P15 github: connected, the card says who, which broker, when it was renewed and when it ends, and the Disconnect button asks first and then disconnects with the panel's token for changes", async () => {
  await scenario(async ({ server, world, dataDir }) => {
    const { api } = await connect(server, world);
    await until(() => server.githubConnection.status().state === "connected");
    const { tab, requests, asked } = await openPanel(server);
    await until(() => /Connected as octocat/.test(stateText(tab)));
    assert.match(stateText(tab), /✓/, "the state is a word with a glyph, never a colour alone");
    const shownFacts = facts(tab);
    assert.equal(shownFacts.Account, "octocat");
    assert.equal(shownFacts.Broker, BROKER);
    for (const label of ["Connected", "Current token ends", "Renewal needed before"]) assert.ok(shownFacts[label] && shownFacts[label] !== "—", `${label}: ${shownFacts[label]}`);
    assert.equal("Last renewed" in shownFacts, false, "not renewed yet");
    assert.equal("Books using it" in shownFacts, false);
    assert.equal(tab.$("github-disconnect").disabled, false);
    assert.equal(tab.$("github-disconnect").textContent, "Disconnect");
    for (const secret of secretsOf(world)) assert.equal(JSON.stringify([...tab.all("[data-i18n]"), tab.$("github-facts")].map((node) => node.textContent)).includes(secret), false);

    // A renewal shows when it happened.
    world.advance(8 * 3_600_000 - 5 * 60_000);
    await server.githubConnection.accessToken();
    await reload(tab);
    assert.ok(facts(tab)["Last renewed"], "the renewal is told");

    // It asks first. A "no" sends nothing.
    const declined = await openPanel(server, { confirm: () => false });
    await until(() => /Connected as octocat/.test(stateText(declined.tab)));
    await declined.tab.$("github-disconnect").click();
    assert.equal(declined.asked.length, 1);
    assert.match(declined.asked[0], /Disconnect the server from GitHub\?.*revoke its own token/);
    assert.equal(declined.requests.some((request) => request.route === "/admin/api/github/disconnect"), false, "a no sends nothing");
    assert.equal(server.githubConnection.status().state, "connected");

    // A yes disconnects: the panel's own route, with its token for changes.
    const before = requests.length;
    await tab.$("github-disconnect").click();
    await until(() => /Not connected/.test(stateText(tab)));
    assert.equal(asked.length, 1);
    const post = requests.slice(before).find((request) => request.route === "/admin/api/github/disconnect");
    assert.equal(post.method, "POST");
    assert.ok(post.csrf && post.csrf.length > 20, "with the token for changes");
    assert.equal(server.githubConnection.status().state, "disconnected");
    assert.equal(world.callsTo("broker:revoke-token").length, 1, "the server's own token was revoked, and nothing else");
    assert.equal(tab.$("github-disconnect").disabled, true);
    assert.match(tab.$("toast").textContent, /Disconnected from GitHub/);
    assert.deepEqual(facts(tab), {});
    await assert.rejects(readFile(path.join(server.data.root, "private", "github-connection.json")), { code: "ENOENT" });
    const log = (await readFile(path.join(server.data.root, "admin-log.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const entry = log.find((line) => line.action === "github.disconnect");
    assert.deepEqual(entry.actor, { kind: "admin" }, "the owner's log says that he did it");
    assert.equal((await api("GET")).state, "disconnected");
  });
});

test("P15 github: waiting for the code, the card shows the code, the address to open and until when; the button cancels, after asking", async () => {
  const world = fakeWorld();
  let release;
  world.hold = new Promise((resolve) => {
    release = resolve;
  });
  await scenario(async ({ server }) => {
    const { api } = await connect(server, world, []);
    const { tab, requests, asked } = await openPanel(server);
    await until(() => /Waiting for the code/.test(stateText(tab)));
    assert.equal(shown(tab, "github-code-box"), true);
    assert.equal(tab.$("github-code").textContent, "WDJB-MJHT");
    assert.equal(tab.$("github-address").textContent, "https://github.com/login/device");
    assert.equal(tab.$("github-address").attributes.href, "https://github.com/login/device", "the address is a link");
    assert.equal(tab.$("github-address").attributes.rel, "noopener noreferrer");
    assert.match(tab.$("github-code-until").textContent, /valid until/);
    assert.equal(facts(tab).Broker, BROKER);
    assert.equal(tab.$("github-disconnect").textContent, "Cancel the connection");
    assert.equal(tab.$("github-disconnect").disabled, false);
    await tab.$("github-code-copy").click();
    await tab.$("github-disconnect").click();
    assert.match(asked[0], /Cancel the connection that is waiting for the code\?/);
    await until(() => /Not connected/.test(stateText(tab)));
    assert.equal(shown(tab, "github-code-box"), false, "the code goes with the connection");
    assert.equal((await api("GET")).state, "disconnected");
    assert.equal(requests.filter((request) => request.route === "/admin/api/github/disconnect").length, 1);
    release();
  }, world);
});

test("P15 github: a connection that was lost says so in words, in English and in Italian, and the Disconnect button stays", async () => {
  await scenario(async ({ server, world }) => {
    await connect(server, world);
    await until(() => server.githubConnection.status().state === "connected");
    world.current = { access: "x", refresh: "somebody-else-used-it" };
    world.advance(8 * 3_600_000);
    await server.githubConnection.accessToken().catch(() => undefined);
    const { tab } = await openPanel(server);
    await until(() => /Lost/.test(stateText(tab)));
    assert.match(stateText(tab), /✕/);
    assert.equal(shown(tab, "github-problem"), true);
    assert.match(tab.$("github-problem").textContent, /GitHub no longer accepts the server's connection/);
    assert.match(tab.$("github-note").textContent, /same GitHub App and broker/);
    assert.equal(facts(tab).Account, "octocat");
    assert.equal(tab.$("github-disconnect").disabled, false);
    await tab.$("lang").click();
    assert.match(stateText(tab), /Perso/);
    assert.match(tab.$("github-problem").textContent, /GitHub non accetta più la connessione del server/);
    assert.equal(tab.$("github-disconnect").textContent, "Scollega");
    assert.equal(tab.$("github-title").textContent, "Connessione a GitHub");
    assert.equal(tab.$("github-code-copy").textContent, "Copia");
    assert.ok("Account" in facts(tab) && "Broker" in facts(tab));
  });
});

test("P15 github: the problem of a connection that could not be made is in the panel's language, with what to switch on", async () => {
  await scenario(async ({ server, world }) => {
    const { tab } = await openPanel(server);
    const cases = [
      ["device-flow-disabled", /Enable Device Flow/, /Enable Device Flow/],
      ["expiring_tokens", /Expire user authorization tokens/, /Expire user authorization tokens/],
      ["access_denied", /refused on github\.com/, /rifiutata su github\.com/],
      ["expired_token", /expired before it was entered/, /scaduto prima di essere inserito/],
    ];
    for (const [reply, english, italian] of cases) {
      if (reply === "expiring_tokens") {
        world.tokenKind = "plain";
        world.script.push("tokens");
      } else if (reply === "device-flow-disabled") world.deviceReply = "device_flow_disabled";
      else world.script.push(reply);
      const { api } = await connect(server, world, []);
      await until(() => server.githubConnection.status().problem);
      await reload(tab);
      await until(() => shown(tab, "github-problem"));
      assert.match(stateText(tab), /Not connected/);
      assert.match(tab.$("github-problem").textContent, english, reply);
      await tab.$("lang").click();
      assert.match(tab.$("github-problem").textContent, italian, `${reply} in Italian`);
      await tab.$("lang").click();
      world.deviceReply = undefined;
      world.tokenKind = "expiring";
      await api("DELETE");
    }
  });
});

test("P15 github: a problem that says more than one thing keeps the words of the server, and the list of brokers the owner accepts is shown", async () => {
  await scenario(async ({ server, world }) => {
    await server.data.updateConfig((next) => {
      next.githubConnection = { allowedBrokerOrigins: [BROKER] };
    });
    await connect(server, world);
    await until(() => server.githubConnection.status().state === "connected");
    world.broker = "garbage";
    world.advance(8 * 3_600_000 - 5 * 60_000);
    await server.githubConnection.accessToken();
    const { tab } = await openPanel(server);
    await until(() => /Connected as octocat/.test(stateText(tab)));
    assert.match(tab.$("github-problem").textContent, /not what the server expects/, "what the server says, in English");
    assert.equal(facts(tab)["Brokers you accept"], BROKER);
    await tab.$("lang").click();
    assert.equal(facts(tab)["Broker che accetti"], BROKER);
  });
});

test("P15 github: with a book on the connection the panel counts it, and the confirmation says what stops (one book, or several)", async () => {
  const origin = await mkdtemp(path.join(os.tmpdir(), "narrarium-ghpanel-origin-"));
  const seed = await mkdtemp(path.join(os.tmpdir(), "narrarium-ghpanel-seed-"));
  try {
    execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin], { env: ENV });
    execFileSync("git", ["init", "--quiet", "-b", "main", seed], { env: ENV });
    for (const [file, content] of Object.entries(seedBookFiles())) {
      await mkdir(path.dirname(path.join(seed, file)), { recursive: true });
      await writeFile(path.join(seed, file), content);
    }
    const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-C", seed, ...args], { env: ENV, stdio: "pipe" });
    git("add", "-A");
    git("commit", "--quiet", "-m", "seed");
    git("push", "--quiet", origin, "main");
    const world = fakeWorld();
    await withServer(async (server, client) => {
      await connect(server, world);
      await until(() => server.githubConnection.status().state === "connected");
      await client.registerBook("gh", { title: "Remote", storage: { kind: "github", owner: "me", repo: "remote", branch: "main" }, githubAuth: "connection" });
      const { tab, asked } = await openPanel(server, { confirm: () => false });
      await until(() => /Connected as octocat/.test(stateText(tab)));
      assert.equal(facts(tab)["Books using it"], "1");
      await tab.$("github-disconnect").click();
      assert.match(asked[0], /The book that uses it stops publishing/);
      await client.registerBook("gh2", { title: "Two", storage: { kind: "github", owner: "me", repo: "remote", branch: "main" }, githubAuth: "connection" });
      await reload(tab);
      assert.equal(facts(tab)["Books using it"], "2");
      await tab.$("github-disconnect").click();
      assert.match(asked[1], /The 2 books that use it stop publishing/);
    }, { githubConnection: world.options, githubRemoteUrl: () => origin });
  } finally {
    await rm(origin, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(seed, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("P15 github: the panel's routes are the owner's: no session, no token for changes, or another origin gets nothing, and the connection stays", async () => {
  await scenario(async ({ server, world }) => {
    await connect(server, world);
    await until(() => server.githubConnection.status().state === "connected");
    const origin = server.adminUrl;
    const anonymous = await fetch(`${origin}/admin/api/github`);
    assert.equal(anonymous.status, 401, "no session");
    const noOrigin = await fetch(`${origin}/admin/api/github/disconnect`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(noOrigin.status, 403, "a post that does not come from the panel");
    const owner = await adminLogin(server);
    const wrongOrigin = await fetch(`${origin}/admin/api/github/disconnect`, { method: "POST", headers: { origin: "https://evil.example", cookie: owner.cookie, "x-csrf-token": owner.csrf, "content-type": "application/json" }, body: "{}" });
    assert.equal(wrongOrigin.status, 403);
    const noCsrf = await fetch(`${origin}/admin/api/github/disconnect`, { method: "POST", headers: { origin, cookie: owner.cookie, "content-type": "application/json" }, body: "{}" });
    assert.equal(noCsrf.status, 403, "without the token for changes");
    assert.equal(server.githubConnection.status().state, "connected", "none of them disconnected anything");
    const read = await owner.call("GET", "/admin/api/github");
    assert.equal(read.status, 200);
    assert.equal(read.body.state, "connected");
    assert.equal(read.body.login, "octocat");
    assert.equal(read.body.books, 0);
    for (const secret of secretsOf(world)) assert.equal(JSON.stringify(read.body).includes(secret), false, "the answer carries no token");
    const status = await owner.call("GET", "/admin/api/status");
    assert.equal(JSON.stringify(status.body).includes("ghu_"), false);
    const done = await owner.call("POST", "/admin/api/github/disconnect", {});
    assert.equal(done.status, 200);
    assert.equal(done.body.state, "disconnected");
    assert.equal((await owner.call("POST", "/admin/api/github/disconnect", {})).body.state, "disconnected", "again is not an error");
    const log = (await readFile(path.join(server.data.root, "admin-log.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(log.filter((line) => line.action === "github.disconnect").length, 1, "a disconnect that changed nothing leaves no line");
  });
});
