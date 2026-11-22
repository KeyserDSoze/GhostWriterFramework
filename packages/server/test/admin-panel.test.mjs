import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { withServer } from "./helpers.mjs";

/**
 * Just enough of a browser to run the admin panel's own script: elements that keep their children, text, classes and listeners, a
 * `fetch` that answers from a table, and storage. The panel is a string in the bundle that no compiler looks at, so this is the only
 * way to know that it draws what the server sends.
 */
function fakeBrowser(html, script, routes) {
  class Element {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.className = "";
      this.attributes = {};
      this.listeners = {};
      this.own = "";
      this.value = "";
      this.checked = false;
      this.title = "";
      this.type = "";
      const element = this;
      this.classList = {
        add: (name) => {
          if (!element.className.split(" ").includes(name)) element.className = `${element.className} ${name}`.trim();
        },
        remove: (name) => {
          element.className = element.className.split(" ").filter((entry) => entry && entry !== name).join(" ");
        },
        contains: (name) => element.className.split(" ").includes(name),
      };
    }

    get textContent() {
      return this.own + this.children.map((child) => child.textContent).join("");
    }

    set textContent(value) {
      this.own = String(value);
      this.children = [];
    }

    appendChild(child) {
      this.children.push(child);
      return child;
    }

    addEventListener(type, listener) {
      (this.listeners[type] ??= []).push(listener);
    }

    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }

    getAttribute(name) {
      return this.attributes[name] ?? null;
    }

    closest() {
      return null;
    }

    click() {
      for (const listener of this.listeners.click ?? []) listener({ preventDefault() {} });
    }

    find(predicate) {
      const found = [];
      const walk = (node) => {
        if (predicate(node)) found.push(node);
        node.children.forEach(walk);
      };
      walk(this);
      return found;
    }
  }

  const byId = new Map();
  const translated = [];
  for (const match of html.matchAll(/<([a-z0-9]+)\b([^>]*)>/g)) {
    const attributes = match[2];
    const id = /\bid="([^"]+)"/.exec(attributes)?.[1];
    const element = new Element(match[1]);
    const key = /\bdata-i18n="([^"]+)"/.exec(attributes)?.[1];
    const placeholder = /\bdata-i18n-placeholder="([^"]+)"/.exec(attributes)?.[1];
    if (key) element.setAttribute("data-i18n", key);
    if (placeholder) element.setAttribute("data-i18n-placeholder", placeholder);
    if (/\bclass="([^"]*)"/.test(attributes)) element.className = /\bclass="([^"]*)"/.exec(attributes)[1];
    if (id) byId.set(id, element);
    if (key || placeholder) translated.push(element);
  }
  const store = () => {
    const values = new Map();
    return { getItem: (name) => values.get(name) ?? null, setItem: (name, value) => void values.set(name, String(value)), removeItem: (name) => void values.delete(name) };
  };
  const requests = [];
  const confirms = [];
  const loaded = [];
  const document = {
    documentElement: { lang: "en" },
    visibilityState: "visible",
    activeElement: null,
    getElementById: (id) => byId.get(id) ?? null,
    createElement: (tag) => new Element(tag),
    createTextNode: (text) => Object.assign(new Element("#text"), { own: String(text) }),
    querySelectorAll: (selector) => (selector === "[data-i18n]" ? translated.filter((entry) => entry.getAttribute("data-i18n")) : translated.filter((entry) => entry.getAttribute("data-i18n-placeholder"))),
    addEventListener: (type, listener) => {
      if (type === "DOMContentLoaded") loaded.push(listener);
    },
  };
  const fetch = async (route, init = {}) => {
    requests.push({ route, method: init.method ?? "GET", body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const answer = routes(route, init) ?? { status: 404, body: { message: "not found" } };
    return { status: answer.status ?? 200, ok: (answer.status ?? 200) < 400, text: async () => JSON.stringify(answer.body ?? {}) };
  };
  const sessionStorage = store();
  sessionStorage.setItem("narrarium-admin-csrf", "csrf-token");
  const sandbox = {
    document,
    fetch,
    location: { origin: "http://127.0.0.1:24243" },
    localStorage: store(),
    sessionStorage,
    navigator: { language: "en-GB", clipboard: { writeText: async () => undefined } },
    confirm: (text) => {
      confirms.push(text);
      return true;
    },
    Date,
    Object,
    String,
    Array,
    JSON,
    Math,
    Promise,
    console,
    setInterval: () => 0,
    clearInterval: () => undefined,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(script, sandbox, { filename: "admin.js" });
  for (const listener of loaded) listener();
  return { $: (id) => byId.get(id), requests, confirms, Element };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

const status = (extra = {}) => ({
  serverId: "5b1f6f5e-7a53-4c3e-9b6e-0d6a6f4f0a11",
  label: "Studio",
  fingerprint: "ab".repeat(32),
  serverVersion: "0.1.2",
  engineVersion: "0.1.1",
  apiPort: 24242,
  adminPort: 24243,
  apiUrl: "http://127.0.0.1:24242",
  dataRoot: "/data",
  supervised: false,
  maintenance: false,
  git: true,
  defaultOrigins: ["https://narrarium.net"],
  origins: [],
  allowedAiBases: [],
  pendingAiBases: [],
  publicUrl: "",
  adminPublicUrl: "",
  allowRemoteAdmin: false,
  tunnel: { enabled: false, configured: false, process: "stopped", binaryAvailable: false, otherConnectorDetected: false },
  books: [],
  clients: [],
  pairing: null,
  ...extra,
});

async function openPanel(server, state, extraRoutes = () => undefined) {
  const html = await (await fetch(`${server.adminUrl}/`)).text();
  const script = await (await fetch(`${server.adminUrl}/admin.js`)).text();
  const browser = fakeBrowser(html, script, (route, init) => {
    const extra = extraRoutes(route, init);
    if (extra) return extra;
    if (route === "/admin/api/status") return { body: state() };
    if (route === "/admin/api/updates") return { body: { installedVersion: "0.1.2", available: false, canRequest: false, message: "up to date", reason: "up_to_date" } };
    if (route === "/admin/api/revoke" || route === "/admin/api/pairing/cancel") return { body: { revoked: true } };
    if (route === "/admin/api/pairing/approve") return { body: { approved: true } };
    return undefined;
  });
  await settle();
  return browser;
}

test("P1: the panel draws every client with its source, user agent, code, creation time and a Revoke button that needs one click", async () => {
  await withServer(async (server) => {
    const clients = [
      { id: "1", label: "Alessandro's MacBook", scopes: ["read", "write", "run"], createdAt: "2026-11-21T10:00:00.000Z", revoked: false, source: "203.0.113.9", userAgent: "Mozilla/5.0 (Macintosh) Safari/605.1.15", verification: "4821", lastSeenAt: "2026-11-21T11:00:00.000Z" },
      { id: "2", label: "Terminal", scopes: ["read"], createdAt: "2026-11-20T10:00:00.000Z", revoked: false, source: "local", verification: "0007" },
      { id: "3", label: "Old tablet", scopes: ["read"], createdAt: "2026-11-01T10:00:00.000Z", revoked: true },
    ];
    const browser = await openPanel(server, () => status({ clients }));
    const rows = browser.$("client-rows").children;
    assert.equal(rows.length, 3, "one row per client");
    const text = rows.map((row) => row.textContent);
    // Newest first, as before.
    assert.match(text[0], /Old tablet/);
    assert.match(text[1], /Terminal.*this computer.*0007/);
    assert.match(text[2], /Alessandro's MacBook.*203\.0\.113\.9.*Mozilla\/5\.0 \(Macintosh\) Safari\/605\.1\.15.*4821/);
    assert.match(text[0], /—/, "a client without source or code shows a dash, not 'undefined'");
    assert.equal(text.some((entry) => /undefined|null/.test(entry)), false);
    const buttons = (row, label) => row.find((node) => node.tagName === "BUTTON" && node.textContent === label);
    assert.equal(buttons(rows[0], "Revoke").length, 0, "a revoked client has nothing to revoke");
    const revoke = buttons(rows[2], "Revoke")[0];
    revoke.click();
    await settle();
    assert.deepEqual(browser.confirms, [], "no confirmation dialog");
    assert.deepEqual(browser.requests.filter((request) => request.route === "/admin/api/revoke").map((request) => request.body), [{ id: "1" }], "one click, one request");
  });
});

test("P1: the panel shows a waiting pairing request with its source, user agent, time and the code to compare, and Approve / Reject work", async () => {
  await withServer(async (server) => {
    const pairing = { id: "pairing-1", label: "Alessandro's MacBook Pro", expiresAt: Date.now() + 120_000, requested: true, approved: false, requestedAt: "2026-11-21T10:00:00.000Z", source: "203.0.113.9", userAgent: "curl/8.5.0", verification: "4821" };
    const browser = await openPanel(server, () => status({ pairing }));
    const box = browser.$("pairing-box").textContent;
    assert.match(box, /Alessandro's MacBook Pro asks to connect/);
    assert.match(box, /From 203\.0\.113\.9/);
    assert.match(box, /curl\/8\.5\.0/);
    assert.match(box, /4821/);
    assert.equal(/undefined|null/.test(box), false);
    const buttons = browser.$("pairing-box").find((node) => node.tagName === "BUTTON").map((node) => node.textContent);
    assert.deepEqual(buttons, ["Approve", "Reject"]);
    browser.$("pairing-box").find((node) => node.tagName === "BUTTON" && node.textContent === "Approve")[0].click();
    await settle();
    assert.deepEqual(browser.requests.find((request) => request.route === "/admin/api/pairing/approve").body, { id: "pairing-1", allowUpdate: false });
    browser.$("pairing-box").find((node) => node.tagName === "BUTTON" && node.textContent === "Reject")[0].click();
    await settle();
    assert.ok(browser.requests.some((request) => request.route === "/admin/api/pairing/cancel"));
  });
});

test("P1: a request from this computer, or from a server that sent no details, is shown without breaking the panel", async () => {
  await withServer(async (server) => {
    const browser = await openPanel(server, () => status({ pairing: { id: "p", label: "Phone", expiresAt: Date.now() + 60_000, requested: true, approved: false } }));
    const box = browser.$("pairing-box").textContent;
    assert.match(box, /Phone asks to connect/);
    assert.match(box, /From unknown/, "an older server sends no source");
    assert.equal(/undefined|null/.test(box), false);
    const local = await openPanel(server, () => status({ pairing: { id: "p", label: "Phone", expiresAt: Date.now() + 60_000, requested: true, approved: false, source: "local", verification: "0042" } }));
    assert.match(local.$("pairing-box").textContent, /From this computer.*0042/s);
  });
});

// ---------------------------------------------------------------------------------------------
// C16 / C15: the AI endpoints that wait, and the spending card
// ---------------------------------------------------------------------------------------------

const buttonsOf = (element, label) => element.find((node) => node.tagName === "BUTTON" && node.textContent === label);

test("C16: the panel lists the endpoints that wait with their path, and Approve / Dismiss send exactly the base that is shown", async () => {
  await withServer(async (server) => {
    const pending = ["https://api.openai.com/v1", "https://my-resource.openai.azure.com/openai/v1"];
    const browser = await openPanel(server, () => status({ pendingAiBases: pending, allowedAiBases: ["https://llm.example"] }), (route) => (route === "/admin/api/ai/approve" || route === "/admin/api/ai/dismiss" ? { body: { saved: true } } : undefined));
    const rows = browser.$("ai-pending").children;
    assert.equal(rows.length, 2, "one row per base");
    assert.match(rows[0].textContent, /https:\/\/api\.openai\.com\/v1/);
    assert.match(rows[1].textContent, /https:\/\/my-resource\.openai\.azure\.com\/openai\/v1/);
    assert.match(browser.$("ai-approved").textContent, /https:\/\/llm\.example/);
    buttonsOf(rows[1], "Approve")[0].click();
    await settle();
    assert.deepEqual(browser.requests.find((request) => request.route === "/admin/api/ai/approve").body, { bases: ["https://my-resource.openai.azure.com/openai/v1"] });
    buttonsOf(rows[0], "Dismiss")[0].click();
    await settle();
    assert.deepEqual(browser.requests.find((request) => request.route === "/admin/api/ai/dismiss").body, { bases: ["https://api.openai.com/v1"] });
  });
});

const spendStatus = (extra = {}) => ({
  paused: false,
  today: { day: "2026-11-22", tokens: 1234, calls: 5, cost: 0.42, currency: "USD", costUnknownCalls: 2 },
  limits: { maxTokensPerDay: 50000, maxCostPerDay: 2.5, maxTokensPerRun: 0, maxCostPerRun: 0 },
  ...extra,
});

test("C15: the panel's spending card shows today's use and the caps, switches AI spending off and on, and saves the caps", async () => {
  await withServer(async (server) => {
    let current = spendStatus();
    const saved = [];
    const browser = await openPanel(server, () => status({ spend: current }), (route, init) => {
      if (route !== "/admin/api/spend" || init.method !== "POST") return undefined;
      saved.push(JSON.parse(init.body));
      current = spendStatus(saved.at(-1).paused === undefined ? {} : { paused: saved.at(-1).paused });
      return { body: current };
    });
    assert.equal(browser.$("spend").classList.contains("hidden"), false);
    const facts = browser.$("spend-facts").textContent;
    assert.match(facts, /allowed/i, "the state of the switch");
    assert.match(facts, /2026-11-22/, "the UTC day");
    assert.match(facts, /1234 tokens/);
    assert.match(facts, /5 calls/);
    assert.match(facts, /0\.42 USD/);
    assert.match(facts, /2 calls/, "and that some of them had no known cost");
    assert.equal(/undefined|null|NaN/.test(facts), false);
    assert.equal(browser.$("spend-tokens-day").value, "50000");
    assert.equal(browser.$("spend-cost-day").value, "2.5");
    assert.equal(browser.$("spend-tokens-run").value, "0");
    assert.equal(browser.$("spend-cost-run").value, "0");
    assert.equal(browser.$("spend-toggle").textContent, "Pause AI spending");

    browser.$("spend-toggle").click();
    await settle();
    assert.match(browser.confirms.at(-1), /Pause/i, "switching off asks first: running autopilots stop at once");
    assert.deepEqual(saved.at(-1), { paused: true });
    assert.equal(browser.$("spend-toggle").textContent, "Resume AI spending");
    assert.match(browser.$("spend-facts").textContent, /paused/i, "and the card is drawn again with the switch off");

    browser.$("spend-tokens-day").value = "75000";
    browser.$("spend-cost-day").value = "";
    browser.$("spend-tokens-run").value = "20000";
    browser.$("spend-cost-run").value = "0.75";
    browser.$("spend-form").listeners.submit[0]({ preventDefault() {} });
    await settle();
    assert.deepEqual(saved.at(-1), { maxTokensPerDay: 75000, maxCostPerDay: 0, maxTokensPerRun: 20000, maxCostPerRun: 0.75 }, "a box left empty is no limit");
  });
});

test("C15: the spending card speaks Italian too, shows the warning of a damaged record, and is absent from the status of a server without it", async () => {
  await withServer(async (server) => {
    const browser = await openPanel(server, () => status({ spend: spendStatus({ paused: true, warning: "private/spend.json could not be read (bad): the totals start from zero." }) }));
    assert.match(browser.$("spend-facts").textContent, /paused/i);
    assert.match(browser.$("spend-facts").textContent, /spend\.json/, "the owner is told");
    assert.equal(browser.$("spend-toggle").textContent, "Resume AI spending");
    browser.$("lang").click();
    await settle();
    assert.equal(browser.$("spend-title").textContent, "Spesa AI");
    assert.equal(browser.$("spend-toggle").textContent, "Riattiva la spesa AI");
    assert.match(browser.$("spend-facts").textContent, /1234 token/);
    assert.match(browser.$("spend-facts").textContent, /in pausa/i);
    assert.equal(/undefined|null|NaN/.test(browser.$("spend").textContent), false);

    const older = await openPanel(server, () => status());
    assert.equal(older.$("spend").classList.contains("hidden"), true, "no `spend` in the status: nothing is drawn, nothing breaks");
    assert.equal(older.requests.filter((request) => request.route === "/admin/api/status").length > 0, true);
  });
});
