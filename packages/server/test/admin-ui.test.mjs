import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import * as testing from "../dist/testing.mjs";
import { fakeBrowser, settle } from "./fake-browser.mjs";
import { adminLogin, gatedAi, until, withServer } from "./helpers.mjs";
import { seededBook } from "./fake-provider.mjs";
import { holdingAi, startOf } from "./hold.mjs";
import { mcpFixture } from "./mcp-helpers.mjs";
import { connectApp, HOUR, MINUTE } from "./oauth-helpers.mjs";

// The admin panel's new views (P12): the risks, the health, the books in progress, the history of the updates and the action log. The panel is a string in the bundle that no compiler
// looks at, so this runs its own script in a small fake browser, against a real server (what the server really answers) and against fabricated answers (every state it can draw).

const { VIEW_TEXTS } = testing;

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const SECRETS_IN_PAGE = /undefined|null|NaN|\[object/;

async function pageOf(server) {
  const fetchText = async (route) => (await fetch(`${server.adminUrl}${route}`)).text();
  return { html: await fetchText("/"), script: await fetchText("/admin.js"), css: await fetchText("/admin.css") };
}

/** The part of a page from the element with an id to the end of its section. */
const sectionOf = (html, id) => {
  const start = html.indexOf(`id="${id}"`);
  assert.ok(start > 0, `the page has #${id}`);
  const open = html.lastIndexOf("<section", start);
  return html.slice(open, html.indexOf("</section>", start));
};

// ---------------------------------------------------------------------------------------------
// What the page is made of
// ---------------------------------------------------------------------------------------------

/** The pages of the panel, in the order of the navigation, with the sections each holds (what a person reads on that page, top to bottom). */
const PAGE_SECTIONS = {
  overview: ["health", "ov-books", "overview"],
  books: ["runs"],
  updates: ["updates", "history"],
  clients: ["pairing", "clients"],
  apps: ["mcp", "passkeys", "audit"],
  ai: ["ai", "spend"],
  network: ["network", "cloudflare"],
  log: ["log"],
  security: ["risks", "devices", "admin-code"],
};

test("P14 panel: the panel is nine pages, each with its own address, its own heading and the sections that belong together, and every function of the old page is still there", async () => {
  await withServer(async (server) => {
    const { html } = await pageOf(server);
    const pages = Object.keys(PAGE_SECTIONS);
    const at = pages.map((id) => html.indexOf(`id="page-${id}"`));
    assert.ok(at.every((index) => index > 0), `every page is there: ${JSON.stringify(at)}`);
    assert.deepEqual([...at].sort((left, right) => left - right), at, "in the order of the navigation");
    for (const [id, sections] of Object.entries(PAGE_SECTIONS)) {
      const start = html.indexOf(`id="page-${id}"`);
      const end = at[pages.indexOf(id) + 1] ?? html.indexOf("</main>");
      const page = html.slice(start, end);
      assert.equal((page.match(/<h1\b/g) ?? []).length, 1, `${id}: one h1`);
      assert.match(page, new RegExp(`<h1 id="title-${id}" tabindex="-1" data-i18n="nav[A-Za-z]+"`), `${id}: the heading can take the focus and is translated`);
      const places = sections.map((section) => page.indexOf(`id="${section}"`));
      assert.ok(places.every((index) => index > 0), `${id}: its sections are there: ${JSON.stringify(places)}`);
      assert.deepEqual([...places].sort((left, right) => left - right), places, `${id}: in this order`);
      assert.match(page, /<section class="panel/, `${id}: a card only where it groups something`);
    }
    for (const id of ["health", "runs", "log", "risks", "mcp", "devices"]) assert.match(sectionOf(html, id), /<h2[^>]*data-i18n="[A-Za-z]+"/, `#${id} has a heading that is translated`);
    // The elements the script draws into, every one of them still in the page.
    for (const id of ["risk-summary", "risk-list", "risk-notes", "risk-notes-summary", "risk-note-list", "health-summary", "health-rows", "health-refresh", "health-note", "runs-summary", "runs-today", "runs-rows", "runs-more", "runs-note", "history-rows", "history-note", "log-type", "log-result", "log-rows", "log-more", "log-note", "facts", "pills", "client-rows", "token-form", "pairing-box", "ai-pending", "ai-approved", "spend-form", "spend-toggle", "network-form", "net-ai", "tunnel-form", "mcp-books", "passkey-rows", "audit-rows", "audit-more", "code-form", "device-rows", "devices-revoke-all", "ov-tiles", "ov-books-list", "login-form", "code", "remember", "login-error", "lang", "logout", "main-view", "login-view", "toast", "skip", "main", "nav", "menu-button"]) {
      assert.ok(html.includes(`id="${id}"`), `#${id} is in the page`);
    }
    assert.equal(html.includes('id="book-rows"'), false, "the list of books is the table of the books in progress now");
    assert.equal((html.match(/<main\b/g) ?? []).length, 1, "one main");
    assert.equal((html.match(/<nav\b/g) ?? []).length, 1, "one navigation");
    assert.match(html, /<nav class="nav" id="nav" aria-label="[^"]+">/, "which has a name");
    assert.match(html, /<a class="skip" id="skip" href="#main"/, "and a link to skip it comes first");
    assert.ok(html.indexOf('class="skip"') < html.indexOf("<header"), "before anything else");
    const links = [...html.matchAll(/<a href="#\/([a-z]+)" id="nav-([a-z]+)" data-route="([a-z]+)"/g)].map((match) => match[1]);
    assert.deepEqual(links, pages, "each page is reached from the navigation, at its own address");
  });
});

test("P12 panel: every table has headers with a scope, and a table that scrolls can be reached and named for the keyboard and for a screen reader", async () => {
  await withServer(async (server) => {
    const { html } = await pageOf(server);
    const tables = html.match(/<table\b[\s\S]*?<\/table>/g) ?? [];
    assert.equal(tables.length, 7, `the tables of the page: health, books in progress, history of the updates, action log, clients, calls of the MCP and remembered devices`);
    for (const table of tables) {
      assert.match(table, /<table[^>]*aria-labelledby="[a-z-]+"/, "a table is named by its heading");
      for (const header of table.match(/<th\b[^>]*>/g) ?? []) assert.match(header, /scope="col"/, `a header has a scope: ${header}`);
      assert.doesNotMatch(table, /<th\b[^>]*scope="col"[^>]*><\/th>/, "and a header that is empty has no place in a table");
    }
    const wrappers = html.match(/<div class="table-wrap(?: long)?"[^>]*>/g) ?? [];
    assert.equal(wrappers.length, tables.length, "every table is in a wrapper");
    for (const wrapper of wrappers) {
      assert.match(wrapper, /tabindex="0"/, `a scrolling region can be focused: ${wrapper}`);
      assert.match(wrapper, /role="region"/, `and is a region: ${wrapper}`);
      assert.match(wrapper, /aria-labelledby="[a-z-]+"/, `and has a name: ${wrapper}`);
    }
    const labelled = [...html.matchAll(/aria-labelledby="([a-z-]+)"/g)].map((match) => match[1]);
    for (const id of new Set(labelled)) assert.ok(html.includes(`id="${id}"`), `what is named by #${id} is there`);
  });
});

test("P12 panel: on a phone the tables of the new views become one card for each row; the headers stay for a screen reader, and the table keeps its roles whatever the style does to it", async () => {
  await withServer(async (server) => {
    const { html, css } = await pageOf(server);
    const stacked = (html.match(/<table\b[^>]*class="stack(?: [a-z]+)?"[^>]*>[\s\S]*?<\/table>/g) ?? []);
    assert.equal(stacked.length, 7, "health, books in progress, history of the updates, action log, remembered devices, and the clients and the calls of the MCP that were there before");
    assert.equal((html.match(/<table\b/g) ?? []).length, 7, "and no table is left that a narrow box must scroll");
    for (const table of stacked) {
      assert.match(table, /<table[^>]*role="table"/, "a table that is made of blocks is still a table");
      assert.match(table, /<thead role="rowgroup"><tr role="row">/);
      assert.match(table, /<tbody role="rowgroup" id="[a-z-]+">/);
      for (const header of table.match(/<th\b[^>]*>/g)) assert.match(header, /role="columnheader"/);
    }
    // A table turns into one block for each row when its own box is narrow (a container query), whatever the size of the window: with the sidebar open a wide window can still be a narrow box.
    assert.match(css, /\.table-wrap\{[^}]*container-type:inline-size/, "the box of a table is what is measured");
    const narrow = css.slice(css.indexOf("@container (max-width:42rem){"));
    assert.match(narrow, /table\.stack tr\{display:block/, "a row is a card");
    assert.match(narrow, /table\.stack td::before\{content:attr\(data-label\)/, "and each value has its label");
    assert.match(narrow, /table\.stack thead\{position:absolute/, "the headers are not drawn...");
    assert.doesNotMatch(css, /thead\{[^}]*display:none/, "...but they are not taken away either: a screen reader needs them");
    assert.match(narrow, /td\.empty\{display:none/, "a value that is only a dash takes no line");
    assert.match(css, /thead th\{position:sticky;top:0/, "and the header of a long table stays in view while it is read");
  });
});

test("P12 panel: the clients and the calls of the MCP, which were there before, are cards on a phone too, and their rows read as they did", async () => {
  await withServer(async (server) => {
    const clients = [
      { id: "1", label: "Alessandro's MacBook", scopes: ["read", "write", "run", "update"], createdAt: "2026-11-21T10:00:00.000Z", revoked: false, source: "203.0.113.9", userAgent: "Mozilla/5.0", verification: "4821", lastSeenAt: "2026-11-21T11:00:00.000Z" },
      { id: "2", label: "Old tablet", scopes: ["read"], createdAt: "2026-11-01T10:00:00.000Z", revoked: true },
    ];
    const audit = { entries: [{ at: "2026-11-22T09:00:00.000Z", client: "Claude", bookId: "glass", tool: "read_chapter", ok: true }, { at: "2026-11-22T08:00:00.000Z", client: "Claude", bookId: "glass", tool: "write_chapter", ok: false, code: "forbidden" }], nextBefore: null };
    const panel = await openStub(server, { "/admin/api/status": { body: baseStatus({ clients }) }, "/admin/api/mcp/audit": { body: audit } });
    const rows = rowsOf(panel, "client-rows");
    assert.equal(rows.length, 2);
    const labelsOf = (row) => row.find((node) => node.tagName === "TD").map((node) => node.getAttribute("data-label"));
    assert.deepEqual(labelsOf(rows[1]), ["Permissions", "Source", "Code", "Created", "Last seen", "Actions"], "the clients are newest first, and every value has its label");
    assert.ok(rows.every((row) => row.getAttribute("role") === "row" && row.find((node) => node.tagName === "TH")[0].getAttribute("role") === "rowheader" && row.find((node) => node.tagName === "TH")[0].getAttribute("scope") === "row"));
    assert.match(rows[1].textContent, /Alessandro's MacBook.*203\.0\.113\.9.*Mozilla\/5\.0.*4821/, "a row says what it said");
    assert.equal(rows[1].find((node) => node.tagName === "BUTTON").map((node) => node.textContent).join(","), "New token,Revoke");
    const calls = rowsOf(panel, "audit-rows");
    assert.equal(calls.length, 2);
    assert.deepEqual(labelsOf(calls[0]), ["Caller", "Book", "Tool", "Result"].map((label) => label), "the first value of a call is its time: a header of the row");
    assert.match(calls[1].textContent, /write_chapter.*failed: forbidden/);
  });
});

test("P12 panel: no two landmarks share a name: a section is not a region of its own, and the scrolling region of a table has the name of its table", async () => {
  await withServer(async (server) => {
    const { html } = await pageOf(server);
    const named = [...html.matchAll(/<(section|div)\b([^>]*\baria-labelledby="([a-z-]+)"[^>]*)>/g)].filter((match) => match[1] === "section" || /role="region"/.test(match[2])).map((match) => match[3]);
    assert.ok(named.length >= 6, `the regions that are named: ${named.join(", ")}`);
    assert.deepEqual([...new Set(named)].sort(), [...named].sort(), "each name is used once");
    assert.equal((html.match(/<section\b[^>]*aria-labelledby=/g) ?? []).length, 0, "a section is not a landmark: its heading says what it is");
  });
});

test("P12 panel: the language button has a name that contains what it shows (WCAG 2.5.3), in both languages, and says what it does", async () => {
  await withServer(async (server) => {
    const english = await openStub(server, {});
    assert.equal(english.text("lang"), "IT");
    assert.equal(english.browser.$("lang").getAttribute("aria-label"), "IT: change language to Italian");
    const italian = await openStub(server, {}, { language: "it-IT" });
    assert.equal(italian.text("lang"), "EN");
    assert.equal(italian.browser.$("lang").getAttribute("aria-label"), "EN: cambia lingua in inglese");
    await italian.browser.$("lang").click();
    await settle();
    assert.equal(italian.browser.$("lang").getAttribute("aria-label"), "IT: change language to Italian", "and it follows the language");
  });
});

test("P12 panel: the page, its script and its style stay inside the strict content security policy: nothing inline, nothing from outside, no markup made from text", async () => {
  await withServer(async (server) => {
    const { html, script, css } = await pageOf(server);
    for (const route of ["/", "/admin.js", "/admin.css"]) {
      const policy = (await fetch(`${server.adminUrl}${route}`)).headers.get("content-security-policy");
      assert.match(policy, /script-src 'self'/);
      assert.match(policy, /style-src 'self'/);
      assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|https?:/, route);
    }
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>\s*\S/, "no script in the page");
    assert.doesNotMatch(html, /<style/i, "no style element");
    assert.doesNotMatch(html, /\sstyle=/i, "no style attribute");
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "no inline handler");
    assert.doesNotMatch(html, /(?:src|href|action|data)="(?:https?:)?\/\//i, "nothing the page loads from outside");
    assert.doesNotMatch(html, /<(?:img|iframe|object|embed|link)\b[^>]*(?:src|href)="(?!\/admin\.css)/i, "no resource but the style and the script");
    assert.doesNotMatch(css, /@import|url\(|https?:\/\/|expression\(/i, "the style loads nothing");
    for (const forbidden of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "javascript:", "srcdoc"]) {
      assert.equal(script.includes(forbidden), false, `the script never uses ${forbidden}: text is put in as text`);
    }
    // A style is a class in the style sheet: the script never sets one on an element (the policy would refuse it), and no element of the page carries one.
    for (const forbidden of [".style.", ".style[", "cssText", 'setAttribute("style"', "setAttribute('style'", "adoptedStyleSheets", "insertRule", "createElement(\"style\")", "createElement(\"script\")"]) {
      assert.equal(script.includes(forbidden), false, `the script never uses ${forbidden}`);
    }
    assert.doesNotMatch(css, /(?<![-\w])behavior:|-moz-binding/i, "and no old way of running a script from a style");
    assert.doesNotThrow(() => new vm.Script(script, { filename: "admin.js" }));
  });
});

/** The texts of the script's own table (`var T = {...}`), read the way the page reads them. */
function inlineTexts(script) {
  const start = script.indexOf("var T = ");
  const end = script.indexOf("\n  };\n", start);
  assert.ok(start > 0 && end > start, "the table of texts is in the script");
  return vm.runInNewContext(`(${script.slice(start + "var T = ".length, end + 4)})`);
}
const placeholders = (text) => [...String(text).matchAll(/\{([A-Za-z]+)\}/g)].map((match) => match[1]).sort();
/** The key of the form for a count of one (`client-update-one`, `runsSummaryOne`): a language that needs it has it, so it is not what the two languages are compared by. */
const isOneForm = (key) => /(?:-one|One)$/.test(key);
function sameShape(left, right, where) {
  const base = (object) => Object.keys(object).filter((key) => !isOneForm(key)).sort();
  assert.deepEqual(base(left), base(right), `the same texts in both languages (${where})`);
  for (const language of [left, right]) {
    for (const key of Object.keys(language).filter(isOneForm)) assert.ok(key.replace(/(?:-one|One)$/, "") in language, `${where}.${key} is the form of a text that exists`);
  }
  for (const key of Object.keys(left).filter((candidate) => !isOneForm(candidate))) {
    if (typeof left[key] === "object") sameShape(left[key], right[key], `${where}.${key}`);
    else {
      assert.equal(typeof right[key], "string", `${where}.${key} is a text in both`);
      assert.deepEqual(placeholders(left[key]), placeholders(right[key]), `${where}.${key} has the same placeholders in both languages`);
      assert.ok(String(left[key]).trim() && String(right[key]).trim(), `${where}.${key} is not empty`);
    }
  }
}

test("P12 panel: every text exists in English and in Italian with the same placeholders, and the page and the script only ask for texts that exist", async () => {
  await withServer(async (server) => {
    const { html, script } = await pageOf(server);
    assert.ok(VIEW_TEXTS && VIEW_TEXTS.en && VIEW_TEXTS.it, "the new texts are a table of their own");
    const inline = inlineTexts(script);
    sameShape(inline.en, inline.it, "T");
    sameShape(VIEW_TEXTS.en, VIEW_TEXTS.it, "views");
    const overlap = Object.keys(VIEW_TEXTS.en).filter((key) => key in inline.en);
    assert.deepEqual(overlap, [], "a new text never replaces an old one");
    const all = { en: { ...inline.en, ...VIEW_TEXTS.en }, it: { ...inline.it, ...VIEW_TEXTS.it } };
    const wanted = new Set([...html.matchAll(/data-i18n(?:-placeholder)?="([^"]+)"/g)].map((match) => match[1]));
    for (const match of script.matchAll(/\bt\("([A-Za-z0-9_.-]+)"/g)) wanted.add(match[1]);
    assert.ok(wanted.size > 60, `a page of many texts: ${wanted.size}`);
    for (const language of ["en", "it"]) for (const key of wanted) assert.equal(typeof all[language][key] === "string" || typeof all[language][key] === "object", true, `${language}: text "${key}" exists`);
    for (const match of script.matchAll(/\bpick\("([A-Za-z0-9_.-]+)"/g)) for (const language of ["en", "it"]) assert.equal(typeof all[language][match[1]], "object", `${language}: the group "${match[1]}" exists`);
    assert.ok(script.includes(VIEW_TEXTS.en.riskNone) && script.includes(VIEW_TEXTS.it.riskNone), "and the new texts are in the script");
  });
});

// ---------------------------------------------------------------------------------------------
// Colours: WCAG 2.2 AA, in the light and in the dark scheme
// ---------------------------------------------------------------------------------------------

function channels(hex) {
  const value = hex.length === 4 ? hex.replace(/[0-9a-f]/gi, (digit) => digit + digit).slice(1) : hex.slice(1);
  return [0, 2, 4].map((at) => Number.parseInt(value.slice(at, at + 2), 16) / 255);
}
const luminance = (hex) => {
  const [red, green, blue] = channels(hex).map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
};
const contrast = (one, other) => {
  const [high, low] = [luminance(one), luminance(other)].sort((left, right) => right - left);
  return (high + 0.05) / (low + 0.05);
};
function tokensOf(css, scheme) {
  const read = (block) => Object.fromEntries([...block.matchAll(/--([a-z-]+):(#[0-9a-fA-F]{3,6})(?![0-9a-fA-F])/g)].map((match) => [match[1], match[2]]));
  const light = read(/:root\{([^}]*)\}/.exec(css)[1]);
  if (scheme === "light") return light;
  return { ...light, ...read(/@media \(prefers-color-scheme:dark\)\{:root\{([^}]*)\}\}/.exec(css)[1]) };
}

test("P12 panel: text, controls and the focus ring keep the contrast WCAG 2.2 AA asks for, in the light and in the dark scheme, and what is new uses the colours of the page and no others", async () => {
  await withServer(async (server) => {
    const { css } = await pageOf(server);
    for (const scheme of ["light", "dark"]) {
      const token = tokensOf(css, scheme);
      for (const name of ["bg", "card", "fg", "muted", "line", "accent", "accent-fg", "warn", "bad", "ok", "control", "focus", "soft", "accent-soft"]) assert.ok(token[name], `${scheme}: the colour --${name} is defined`);
      // The grounds that the panel draws on: the page, a card, the header of a table and the item of the navigation that is open (the last two only carry text).
      for (const ground of ["card", "bg", "soft", "accent-soft"]) {
        for (const name of ["fg", "muted", "accent", "warn", "bad", "ok"]) assert.ok(contrast(token[name], token[ground]) >= 4.5, `${scheme}: text --${name} on --${ground} is ${contrast(token[name], token[ground]).toFixed(2)}:1, under 4.5:1`);
        for (const name of ["control", "focus"]) assert.ok(contrast(token[name], token[ground]) >= 3, `${scheme}: --${name} on --${ground} is ${contrast(token[name], token[ground]).toFixed(2)}:1, under 3:1`);
      }
      assert.ok(contrast(token["accent-fg"], token.accent) >= 4.5, `${scheme}: the text of a button`);
      assert.ok(contrast(token.accent, token.line) >= 3, `${scheme}: the bar of a progress against its track is ${contrast(token.accent, token.line).toFixed(2)}:1, under 3:1`);
    }
    assert.match(css, /:focus-visible\{[^}]*outline:[^}]*var\(--focus\)/, "a focus ring on what has the focus, in its own colour");
    assert.match(css, /input,textarea,select\{[^}]*border:1px solid var\(--control\)/, "a box of the form has a border that can be seen");
    assert.match(css, /\.topbar\{position:sticky;top:0/, "the bar of the page stays in view...");
    assert.match(css, /html\{scroll-padding-top:5rem/, "...and what has the focus is never under it");
    assert.match(css, /prefers-reduced-motion/, "and nothing moves for who does not want it");
    const added = css.slice(css.indexOf("/* views */"));
    assert.ok(added.length > 5000, "everything after the colours is marked");
    assert.doesNotMatch(added, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, "nothing after the colours spells a colour of its own: what is drawn uses the colours whose contrast is checked here");
  });
});

// ---------------------------------------------------------------------------------------------
// A panel that runs against answers made up for it: every state it can draw
// ---------------------------------------------------------------------------------------------

const baseStatus = (extra = {}) => ({
  serverId: "5b1f6f5e-7a53-4c3e-9b6e-0d6a6f4f0a11",
  label: "Studio",
  fingerprint: "ab".repeat(32),
  serverVersion: "0.1.9",
  engineVersion: "0.1.9",
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
const NO_RISKS = { risks: [], counts: { high: 0, medium: 0, note: 0 } };
const HEALTHY = {
  at: "2026-11-22T10:00:00.000Z",
  overall: "ok",
  attention: [],
  checks: [
    { id: "server", status: "ok", facts: { startedAt: "2026-11-22T06:55:00.000Z", uptimeMs: 3 * HOUR + 5 * MINUTE, maintenance: false } },
    { id: "versions", status: "ok", facts: { server: "0.1.9", engine: "0.1.9", update: "none" } },
    { id: "disk", status: "ok", facts: { freeBytes: 38 * GIB, totalBytes: 100 * GIB, warnBelowBytes: GIB, badBelowBytes: 256 * MIB } },
    { id: "git", status: "ok", facts: { available: true, githubBooks: 1 } },
    { id: "tunnel", status: "off", facts: { enabled: false, process: "stopped", binaryAvailable: false } },
    { id: "runs", status: "ok", facts: { running: 1, max: 2, refused24h: 0 } },
    { id: "spend", status: "ok", facts: { paused: false, damaged: false } },
    { id: "books", status: "ok", facts: { total: 3, unreadable: 0, error: 0, stalled: 0 } },
    { id: "error", status: "ok", facts: {} },
  ],
};
const withChecks = (changes, overall = "attention") => {
  const checks = HEALTHY.checks.map((check) => (changes[check.id] ? { ...check, ...changes[check.id] } : check));
  return { ...HEALTHY, overall, attention: checks.filter((check) => check.status === "warn" || check.status === "bad").map((check) => check.id), checks };
};
const board = (books, extra = {}) => ({ now: "2026-11-22T10:00:00.000Z", maxConcurrentRuns: 2, running: books.filter((book) => book.live).length, spendToday: { day: "2026-11-22", tokens: 0, calls: 0 }, total: books.length, counts: {}, books, nextOffset: null, ...extra });
const run = (extra = {}) => ({
  bookId: "b", title: "The Glass Harbor", storage: "local", state: "idle", status: "idle", phase: null, live: false, runner: null, chapter: null, step: null, sinceMs: null, heartbeatAgeMs: null, updatedAt: null,
  retry: null, question: false, pausePending: null, spend: null, lastError: null, error: null, ...extra,
});

/** Open the panel with answers for each route: a function of the query, or a value; routes without one answer 404 (what an old server, or a failure, looks like). */
async function openStub(server, routes = {}, { language = "en-GB", confirm = () => true } = {}) {
  const { html, script } = await pageOf(server);
  const requests = [];
  const ticks = [];
  const answer = (route, init) => {
    const [pathname, query = ""] = route.split("?");
    const key = Object.keys(routes).find((candidate) => candidate === pathname);
    if (key !== undefined) {
      const value = typeof routes[key] === "function" ? routes[key](new URLSearchParams(query), init) : routes[key];
      if (value !== undefined) return value;
    }
    if (pathname === "/admin/api/status") return { body: baseStatus() };
    if (pathname === "/admin/api/updates") return { body: { installedVersion: "0.1.9", available: false, canRequest: false, message: "up to date", reason: "up_to_date" } };
    return { status: 404, body: { message: "not found" } };
  };
  const fetchStub = async (route, init = {}) => {
    requests.push({ route, method: init.method ?? "GET", body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const hit = answer(route, init);
    const status = hit.status ?? 200;
    return { status, ok: status < 400, text: async () => JSON.stringify(hit.body ?? {}) };
  };
  const browser = fakeBrowser(html, script, {
    fetch: fetchStub,
    location: { origin: server.adminUrl },
    navigator: { language, clipboard: { writeText: async () => undefined } },
    storage: { "narrarium-admin-csrf": "csrf" },
    confirm,
    extra: { setInterval: (callback) => ticks.push(callback) },
    filename: "admin.js",
  });
  await browser.ready;
  await until(() => !browser.$("main-view").classList.contains("hidden"));
  await settle(120);
  const poll = async () => {
    await ticks[0]();
    await settle(120);
  };
  const text = (id) => browser.$(id).textContent;
  return { browser, requests, ticks, poll, text, html, script, requested: (pathname) => requests.filter((request) => request.route.split("?")[0] === pathname) };
}
/**
 * What the panel has drawn in a view, from the elements it draws into: a section of the page has no text of its own in the fake browser (its parts are elements of their own),
 * so the text of a section is the text of those.
 */
const DRAWN = {
  risks: ["risks-title", "risk-summary", "risk-list", "risk-notes-summary", "risk-note-list"],
  health: ["health-title", "health-summary", "health-rows", "health-note"],
  runs: ["runs-title", "runs-summary", "runs-today", "runs-rows", "runs-note"],
  updates: ["history-title", "history-rows", "history-note"],
  log: ["log-title", "log-rows", "log-note"],
};
const drawn = (panel, view) => DRAWN[view].map((id) => panel.text(id)).join("\n");
const rowsOf = (panel, id) => panel.browser.$(id).children;
const rowsOfText = (panel, id) => rowsOf(panel, id).map((row) => row.textContent);

const RISKS = {
  risks: [
    { id: "remote-admin", level: "high", facts: { address: "https://admin.example.test" } },
    { id: "client-update", level: "medium", facts: { count: 2, labels: ["Phone", "Laptop"] } },
    { id: "oauth-write", level: "medium", facts: { count: 1, apps: [{ name: "Claude", bookId: "glass", scopes: ["read", "write"] }] } },
    { id: "no-passkey", level: "medium", facts: { books: 2, publicUrl: "https://api.example.test", canAddPasskey: true } },
    { id: "client-run", level: "note", facts: { count: 1, labels: ["Narrarium"] } },
    { id: "ai-remote", level: "note", facts: { count: 2, hosts: ["api.openai.com", "my-resource.openai.azure.com"] } },
  ],
  counts: { high: 1, medium: 3, note: 2 },
};

test("P12 panel risks: what matters is on top with its level in words, why and what to do, a link to the place where it is changed, and the notes are folded", async () => {
  await withServer(async (server) => {
    const panel = await openStub(server, { "/admin/api/risks": { body: RISKS } });
    const items = rowsOf(panel, "risk-list");
    assert.equal(items.length, 4, "a high risk and three medium ones are open");
    const [remote, update, app, passkey] = items.map((item) => item.textContent);
    assert.match(remote, /High risk/);
    assert.match(remote, /This panel is reachable from the internet/);
    assert.match(remote, /https:\/\/admin\.example\.test/, "at which address");
    assert.match(remote, /Go to Network/, "and where to change it");
    assert.match(update, /Medium risk/);
    assert.match(update, /2 clients may update this server: Phone, Laptop/);
    assert.match(app, /1 connected app can change a book or run the autopilot: Claude \(glass\)/);
    assert.match(passkey, /2 books accept apps from the internet/);
    assert.match(passkey, /Add a passkey/, "a passkey can be added here, so that is what to do");
    const links = items.map((item) => item.find((node) => node.tagName === "A").map((node) => node.getAttribute("href")));
    assert.deepEqual(links, [["#/network"], ["#/clients"], ["#/apps"], ["#/apps"]], "each goes to the page where it is changed");
    assert.equal(items[0].find((node) => node.tagName === "A")[0].textContent, "Go to Network");
    assert.match(panel.text("risk-summary"), /1 high, 3 medium, 2 notes/);
    assert.equal(panel.browser.$("risk-notes").classList.contains("hidden"), false);
    assert.equal(panel.text("risk-notes-summary"), "Notes (2)");
    const notes = rowsOf(panel, "risk-note-list").map((item) => item.textContent);
    assert.equal(notes.length, 2);
    assert.match(notes[0], /Note/);
    assert.match(notes[0], /1 client can start autopilot runs: Narrarium/);
    assert.match(notes[1], /2 approved AI endpoints are not on this computer: api\.openai\.com, my-resource\.openai\.azure\.com/);
    assert.ok(drawn(panel, "risks").length > 300, "there is text to look through");
    assert.equal(SECRETS_IN_PAGE.test(drawn(panel, "risks")), false, "no undefined, null or NaN");
    assert.equal(panel.browser.$("risks").classList.contains("hidden"), false);
  });
});

test("P14 panel risks: a remembered device is a note with its count, a stronger one when the panel is on the internet, and no link to the page it is already on", async () => {
  await withServer(async (server) => {
    const risks = (facts, level = "note") => ({ body: { risks: [{ id: "device-remember", level, facts }], counts: { high: 0, medium: 0, note: 1 } } });
    const panel = await openStub(server, { "/admin/api/risks": risks({ count: 3, remote: false }) });
    await until(() => rowsOf(panel, "risk-note-list").length === 1);
    const [note] = rowsOf(panel, "risk-note-list");
    assert.match(note.textContent, /3 devices are remembered by this panel/);
    assert.match(note.textContent, /signs in without the admin code until you revoke it/);
    assert.doesNotMatch(note.textContent, /reachable from the internet/);
    assert.equal(note.find((node) => node.tagName === "A").length, 0, "nothing to go to: the devices are on this page");
    const remote = await openStub(server, { "/admin/api/risks": risks({ count: 1, remote: true }) });
    await until(() => rowsOf(remote, "risk-note-list").length === 1);
    assert.match(rowsOf(remote, "risk-note-list")[0].textContent, /1 device is remembered by this panel/);
    assert.match(rowsOf(remote, "risk-note-list")[0].textContent, /reachable from the internet: whoever gets into one of those browsers can change this server from anywhere/);
    const italian = await openStub(server, { "/admin/api/risks": risks({ count: 2, remote: true }) }, { language: "it-IT" });
    await until(() => rowsOf(italian, "risk-note-list").length === 1);
    assert.match(rowsOf(italian, "risk-note-list")[0].textContent, /2 dispositivi sono ricordati da questo pannello.*raggiungibile da internet/);
  });
});

test("P12 panel risks: the no-passkey risk says what to do when there is nothing to put a passkey on, a count of one reads as one, and a risk a newer server knows is not a break", async () => {
  await withServer(async (server) => {
    const risks = { risks: [
      { id: "no-passkey", level: "medium", facts: { books: 1, publicUrl: "http://203.0.113.7:24242", canAddPasskey: false } },
      { id: "a-risk-of-the-future", level: "high", facts: { count: 3 } },
      { id: "client-update", level: "medium", facts: { count: 9, labels: ["A", "B", "C", "D", "E"] } },
      { id: "spend-unlimited", level: "medium", facts: { clients: 1, apps: 0 } },
    ], counts: { high: 1, medium: 3, note: 0 } };
    const panel = await openStub(server, { "/admin/api/risks": { body: risks } });
    const texts = rowsOf(panel, "risk-list").map((item) => item.textContent);
    assert.equal(texts.length, 3, "what the panel does not know is left out, not drawn as a blank");
    const passkey = texts.find((text) => /passkey/.test(text));
    assert.match(passkey, /1 book accepts apps from the internet/);
    assert.match(passkey, /public address with a name/, "an address without a name cannot hold a passkey: that is what to do first");
    assert.deepEqual(rowsOf(panel, "risk-list").find((item) => /public address with a name/.test(item.textContent)).find((node) => node.tagName === "A").map((node) => node.getAttribute("href")), ["#/network"]);
    assert.match(texts.find((text) => /may update/.test(text)), /9 clients may update this server: A, B, C, D, E, …/, "five names, and that there are more");
    assert.match(texts.find((text) => /no limit/i.test(text)), /AI spending has no limit/);
    assert.equal(panel.browser.$("risk-notes").classList.contains("hidden"), true, "no notes: nothing is folded");
  });
});

test("P12 panel risks: with nothing to flag the banner says so in one calm line; and in Italian it is all Italian", async () => {
  await withServer(async (server) => {
    const panel = await openStub(server, { "/admin/api/risks": { body: NO_RISKS } });
    assert.equal(panel.text("risk-summary"), "Nothing to flag in this server's set-up.");
    assert.equal(rowsOf(panel, "risk-list").length, 0);
    assert.equal(panel.browser.$("risk-notes").classList.contains("hidden"), true);
    const italian = await openStub(server, { "/admin/api/risks": { body: RISKS } }, { language: "it-IT" });
    const [remote, update] = rowsOf(italian, "risk-list").map((item) => item.textContent);
    assert.match(remote, /Rischio alto/);
    assert.match(remote, /Questo pannello è raggiungibile da internet/);
    assert.match(remote, /Vai a Rete/);
    assert.match(update, /Rischio medio/);
    assert.match(update, /2 client possono aggiornare questo server: Phone, Laptop/);
    assert.match(italian.text("risk-summary"), /Trovati: 1 rischio alto, 3 rischi medi, 2 note\./);
    assert.equal(italian.text("risk-notes-summary"), "Note (2)");
    assert.ok(drawn(italian, "risks").includes("Rischi nella configurazione"), "the heading is Italian too");
    assert.equal(/\b(?:High risk|Medium risk|Go to|Found)\b/.test(drawn(italian, "risks")), false, "nothing is left in English");
    italian.browser.$("lang").click();
    await settle();
    assert.match(italian.text("risk-list"), /High risk/, "the language button redraws what is on the page");
  });
});

test("P12 panel health: one line for the whole, and a row for each check with its status in words and glyphs, never in colour alone", async () => {
  await withServer(async (server) => {
    const healthy = await openStub(server, { "/admin/api/health": { body: HEALTHY } });
    assert.equal(healthy.text("health-summary"), "All is well.");
    const rows = rowsOf(healthy, "health-rows");
    assert.deepEqual(rows.map((row) => row.find((node) => node.tagName === "TH")[0].textContent), ["Server", "Versions", "Disk space", "git", "Cloudflare connector", "Runs", "AI spending", "Books", "Last error"]);
    assert.ok(rows.every((row) => row.find((node) => node.tagName === "TH")[0].getAttribute("scope") === "row"), "the name of a check is the header of its row");
    const byName = Object.fromEntries(rows.map((row) => [row.find((node) => node.tagName === "TH")[0].textContent, row.textContent]));
    assert.deepEqual(rows[0].find((node) => node.tagName === "TD").map((node) => node.getAttribute("data-label")), ["Status", "Details"]);
    assert.match(byName.Server, /Running for 3 h 5 min, since /);
    assert.match(byName.Versions, /Server 0\.1\.9, engine 0\.1\.9: up to date/);
    assert.match(byName["Disk space"], /38 GiB free of 100 GiB/);
    assert.match(byName["Cloudflare connector"], /Off.*Not in use/s);
    assert.match(byName.Runs, /1 of 2 places in use/);
    assert.match(byName["Last error"], /No unexpected error since this server started/);
    for (const row of rows) {
      const badge = row.find((node) => node.tagName === "SPAN" && node.className.split(" ").includes("badge"))[0];
      assert.ok(badge && /\S/.test(badge.textContent), "a status is a word");
      assert.ok(badge.find((node) => node.getAttribute("aria-hidden") === "true").length >= 1, "with a glyph that a screen reader skips");
    }
    assert.match(rows[0].textContent, /OK/);
    assert.ok(drawn(healthy, "health").length > 300, "there is text to look through");
    assert.equal(SECRETS_IN_PAGE.test(drawn(healthy, "health")), false);
    assert.equal(healthy.browser.$("health-summary").getAttribute("aria-live"), "polite", "once the first answer is there, a change is announced");
  });
});

test("P12 panel health: what needs a look is named in the line and in its row, with the facts that say why", async () => {
  await withServer(async (server) => {
    const health = withChecks({
      disk: { status: "bad", facts: { freeBytes: 200 * MIB, totalBytes: 100 * GIB, warnBelowBytes: GIB, badBelowBytes: 256 * MIB } },
      tunnel: { status: "warn", facts: { enabled: true, process: "stopped", binaryAvailable: true } },
      runs: { status: "warn", facts: { running: 2, max: 2, refused24h: 3 } },
      spend: { status: "warn", facts: { paused: true, capReached: "tokens-per-day", damaged: false } },
      books: { status: "warn", facts: { total: 5, unreadable: 1, error: 2, stalled: 1 } },
      versions: { status: "warn", facts: { server: "0.1.9", engine: "0.1.9", update: "refused" } },
      error: { status: "warn", facts: { at: "2026-11-22T08:00:00.000Z", requestId: "a1b2c3d4", where: "api", route: "POST /api/v1/books/:id/director/ask", name: "TypeError" } },
      git: { status: "warn", facts: { available: false, githubBooks: 1 } },
    });
    const panel = await openStub(server, { "/admin/api/health": { body: health } });
    assert.equal(panel.text("health-summary"), "Needs a look: Versions, Disk space, git, Cloudflare connector, Runs, AI spending, Books, Last error.");
    const row = Object.fromEntries(rowsOf(panel, "health-rows").map((entry) => [entry.find((node) => node.tagName === "TH")[0].textContent, entry.textContent]));
    assert.match(row["Disk space"], /Problem/);
    assert.match(row["Disk space"], /Only 200 MiB free of 100 GiB: saving a book may fail now/);
    assert.match(row["Cloudflare connector"], /Look at this.*Switched on, but not running/s);
    assert.match(row.Runs, /3 starts were refused in the last 24 hours: all 2 places were in use/);
    assert.match(row["AI spending"], /AI calls are paused by you/);
    assert.match(row["AI spending"], /daily token cap was reached/);
    assert.match(row.Books, /5 books: 1 cannot be read, 2 stopped by an error, 1 looks stalled/);
    assert.match(row.Versions, /does not offer it/);
    assert.match(row.git, /git is missing, and 1 book is on GitHub/);
    assert.match(row["Last error"], /TypeError on POST \/api\/v1\/books\/:id\/director\/ask/);
    assert.match(row["Last error"], /a1b2c3d4/, "the request id that finds it in the log");
    assert.doesNotMatch(row["Last error"], /message|stack/i, "and not a word of what it said");
    const italian = await openStub(server, { "/admin/api/health": { body: health } }, { language: "it-IT" });
    assert.match(italian.text("health-summary"), /^Da controllare: Versioni, Spazio su disco, git, Connettore Cloudflare, Esecuzioni, Spesa AI, Libri, Ultimo errore\.$/);
    assert.match(italian.text("health-rows"), /Problema/);
    assert.match(italian.text("health-rows"), /Da controllare/);
    assert.ok(drawn(italian, "health").includes("Stato del server"), "the heading is Italian too");
    assert.equal(/\b(?:Problem|Look at this|Disk space|free of|Needs a look)\b/.test(drawn(italian, "health")), false, "nothing is left in English");
  });
});

test("P12 panel health: maintenance, an update that waits, a connector that stopped with an error, the day's cap and a spending record that was damaged are each said", async () => {
  await withServer(async (server) => {
    const health = withChecks({
      server: { status: "info", facts: { uptimeMs: 40_000, maintenance: true } },
      versions: { status: "info", facts: { server: "0.1.9", engine: "0.1.9", update: "pending", latest: "0.2.0" } },
      tunnel: { status: "bad", facts: { enabled: true, process: "failed", binaryAvailable: false, errorCode: "missing" } },
      spend: { status: "warn", facts: { paused: false, capReached: "cost-per-day", damaged: true } },
      runs: { status: "info", facts: { running: 2, max: 2, refused24h: 0 } },
    });
    const panel = await openStub(server, { "/admin/api/health": { body: health } });
    const row = Object.fromEntries(rowsOf(panel, "health-rows").map((entry) => [entry.find((node) => node.tagName === "TH")[0].textContent, entry.textContent]));
    assert.match(row.Server, /Restarting for an update/);
    assert.match(row.Versions, /Update to 0\.2\.0 requested: waiting for the supervisor/);
    assert.match(row["Cloudflare connector"], /Problem.*Stopped with an error: cloudflared is not installed/s);
    assert.match(row["AI spending"], /daily cost cap was reached/);
    assert.match(row["AI spending"], /spending record was damaged/);
    assert.match(row.Runs, /All 2 places are in use\. Nothing was turned away/);
    assert.equal(panel.text("health-summary"), "Needs a look: Cloudflare connector, AI spending.");
  });
});

test("P12 panel health: a check that a newer server adds, or a status it does not know, is drawn plainly and breaks nothing", async () => {
  await withServer(async (server) => {
    const health = { ...HEALTHY, checks: [...HEALTHY.checks, { id: "a-check-of-the-future", status: "warn", facts: { n: 1 } }, { id: "disk", status: "strange", facts: {} }] };
    const panel = await openStub(server, { "/admin/api/health": { body: health } });
    assert.equal(panel.text("health-summary"), "All is well.");
    assert.ok(rowsOf(panel, "health-rows").length >= 9);
    assert.equal(SECRETS_IN_PAGE.test(panel.text("health-rows")), false);
  });
});

test("P12 panel: what a screen reader is told changes only when it changes: the lines of risks and health are written again only when their words are not the same", async () => {
  await withServer(async (server) => {
    let health = HEALTHY;
    let risks = NO_RISKS;
    const panel = await openStub(server, { "/admin/api/health": () => ({ body: health }), "/admin/api/risks": () => ({ body: risks }) });
    const writes = { "health-summary": [], "risk-summary": [] };
    for (const id of Object.keys(writes)) {
      const element = panel.browser.$(id);
      let current = element.textContent;
      Object.defineProperty(element, "textContent", { configurable: true, get: () => current, set: (value) => { writes[id].push(String(value)); current = String(value); } });
    }
    await panel.poll();
    await panel.poll();
    assert.deepEqual(writes, { "health-summary": [], "risk-summary": [] }, "the same answer, three times: nothing written");
    health = withChecks({ disk: { status: "warn", facts: { freeBytes: 500 * MIB, totalBytes: 100 * GIB, warnBelowBytes: GIB, badBelowBytes: 256 * MIB } } });
    await panel.poll();
    assert.deepEqual(writes["health-summary"], ["Needs a look: Disk space."], "a change is written once");
    await panel.poll();
    assert.equal(writes["health-summary"].length, 1);
    risks = RISKS;
    await panel.poll();
    assert.equal(writes["risk-summary"].length, 1);
    assert.match(writes["risk-summary"][0], /1 high, 3 medium, 2 notes/);
    health = HEALTHY;
    await panel.poll();
    assert.deepEqual(writes["health-summary"], ["Needs a look: Disk space.", "All is well."]);
    for (const id of ["health-summary", "risk-summary"]) assert.equal(panel.browser.$(id).getAttribute("role"), "status", `${id} is a polite live region`);
    assert.equal(panel.html.match(/aria-live="assertive"/g), null, "nothing interrupts");
  });
});

test("P12 panel: a view that cannot be loaded says so quietly and tries again; it does not shout, and it keeps what it had", async () => {
  await withServer(async (server) => {
    let working = true;
    const panel = await openStub(server, {
      "/admin/api/health": () => (working ? { body: HEALTHY } : { status: 500, body: { message: "boom" } }),
      "/admin/api/runs": () => (working ? { body: board([run({ title: "Kept" })]) } : { status: 500, body: { message: "boom" } }),
    });
    assert.equal(panel.text("health-summary"), "All is well.");
    assert.match(panel.text("runs-rows"), /Kept/);
    working = false;
    await panel.poll();
    assert.equal(panel.text("health-summary"), "All is well.", "what was known stays");
    assert.match(panel.text("runs-rows"), /Kept/);
    assert.match(panel.text("runs-note"), /Could not load this section/);
    assert.equal(panel.browser.$("toast").classList.contains("hidden"), true, "no toast for what runs by itself");
    working = true;
    await panel.poll();
    assert.equal(panel.text("runs-note"), "", "and the note goes when it works again");
  });
});

test("P12 panel: a server that does not have the new routes (404) leaves the old panel as it was: no toast, no break, no banner", async () => {
  await withServer(async (server) => {
    const panel = await openStub(server, {});
    assert.equal(panel.browser.$("toast").classList.contains("hidden"), true);
    assert.equal(panel.browser.$("risks").classList.contains("hidden"), true, "no banner when nothing was said");
    assert.ok(panel.text("facts").includes("Studio"), "the rest of the panel is drawn");
    assert.equal(panel.requested("/admin/api/risks").length >= 1 && panel.requested("/admin/api/health").length >= 1 && panel.requested("/admin/api/runs").length >= 1 && panel.requested("/admin/api/updates/history").length >= 1 && panel.requested("/admin/api/log").length >= 1, true, "each view asked");
  });
});

// ---------------------------------------------------------------------------------------------
// The books in progress
// ---------------------------------------------------------------------------------------------

const ALL_STATES = [
  run({ bookId: "stalled", title: "Stalled Book", state: "stalled", status: "running", live: true, runner: { host: "server", thisServer: true }, chapter: { current: 2, total: 5, done: 1 }, sinceMs: 40 * MINUTE, heartbeatAgeMs: 14 * MINUTE, step: "write", stepChapter: 2, stepSinceMs: 14 * MINUTE }),
  run({ bookId: "retry", title: "Retry Book", state: "retrying", status: "running", live: true, runner: { host: "server", thisServer: true }, chapter: { current: 3, total: 5, done: 2 }, sinceMs: 12 * MINUTE, retry: { at: "2026-11-22T10:00:30.000Z", attempt: 2, retries: 3, inMs: 30_000 } }),
  run({ bookId: "go", title: "Running Book", state: "running", status: "running", phase: "writing", live: true, runner: { host: "server", thisServer: true }, chapter: { current: 2, total: 5, done: 1 }, sinceMs: 12 * MINUTE, heartbeatAgeMs: 4000, step: "write", stepChapter: 2, stepScene: 1, stepSinceMs: 3 * MINUTE, pausePending: "after-step", spend: { tokens: 1234, calls: 7, cost: 0.42, currency: "USD", startedAt: "2026-11-22T09:48:00.000Z", active: true } }),
  run({ bookId: "ask", title: "Asking Book", state: "waiting", status: "waiting-author", question: true, runner: { host: "server", thisServer: true }, chapter: { current: 1, total: 5, done: 0 }, updatedAt: "2026-11-22T09:00:00.000Z" }),
  run({ bookId: "err", title: "Failed Book", state: "error", status: "error", runner: { host: "server", thisServer: true }, chapter: { current: 4, total: 5, done: 3 }, lastError: { kind: "rate_limit", task: "write", status: 429, at: "2026-11-22T09:30:00.000Z" }, spend: { tokens: 90_000, calls: 40, startedAt: "2026-11-21T09:00:00.000Z", active: false } }),
  run({ bookId: "broken", title: "Broken Book", storage: "github", state: "unreadable", status: null, error: "autopilot/state.json cannot be read" }),
  run({ bookId: "paused", title: "Paused Book", state: "paused", status: "paused", chapter: { current: 2, total: 5, done: 1 }, runner: { host: "browser", label: "Narrarium on Safari", thisServer: false } }),
  run({ bookId: "other", title: "Elsewhere Book", state: "paused", status: "paused", chapter: { current: 1, total: 3, done: 0 }, runner: { host: "server", thisServer: false } }),
  run({ bookId: "done", title: "Finished Book", state: "completed", status: "completed", chapter: { current: 5, total: 5, done: 5 }, spend: { tokens: 400_000, calls: 150, cost: 3.1, currency: "EUR", costUnknownCalls: 2, startedAt: "2026-11-20T09:00:00.000Z", active: false } }),
  run({ bookId: "new", title: "New Book", state: "none", status: null }),
];

test("P12 panel books: every state a book can be in is said in words, with what a person acts on (why, since when, how long without a sign, when the next try is)", async () => {
  await withServer(async (server) => {
    const panel = await openStub(server, { "/admin/api/runs": { body: board(ALL_STATES, { running: 3, maxConcurrentRuns: 4, total: 10 }) } });
    const rows = rowsOf(panel, "runs-rows");
    assert.equal(rows.length, 10);
    const byBook = Object.fromEntries(rows.map((row) => [row.find((node) => node.tagName === "TH")[0].textContent.replace(/(?:local|GitHub)$/, "").trim(), row]));
    assert.ok(rows.every((row) => row.find((node) => node.tagName === "TD").length === 4), "a book, its state, its progress, the run and the spending: five columns, the first a header");
    const said = (title) => byBook[title].textContent;
    assert.match(said("Stalled Book"), /Looks stalled/);
    assert.match(said("Stalled Book"), /No sign of life for 14 min/);
    assert.match(said("Retry Book"), /Waiting to try again/);
    assert.match(said("Retry Book"), /Retry 2 of 3 in 30 s/);
    assert.match(said("Running Book"), /Running/);
    assert.match(said("Running Book"), /chapter 2 of 5/);
    assert.match(said("Running Book"), /Now: writing/);
    assert.match(said("Running Book"), /chapter 2, scene 1/);
    assert.match(said("Running Book"), /for 3 min/, "the step");
    assert.match(said("Running Book"), /This server.*12 min/s, "and the run");
    assert.match(said("Running Book"), /Will pause after this step/);
    assert.match(said("Running Book"), /1,234 tokens · 7 calls · 0\.42 USD/);
    assert.match(said("Asking Book"), /Waiting for you/);
    assert.match(said("Asking Book"), /A question needs your answer/);
    assert.match(said("Failed Book"), /Stopped by an error/);
    assert.match(said("Failed Book"), /rate limit/);
    assert.match(said("Failed Book"), /writing/);
    assert.match(said("Failed Book"), /HTTP 429/);
    assert.match(said("Failed Book"), /90,000 tokens · 40 calls.*last run/s, "the spending of a run that is over is said to be the last one");
    assert.match(said("Broken Book"), /State cannot be read/);
    assert.match(said("Broken Book"), /autopilot\/state\.json cannot be read/);
    assert.match(said("Broken Book"), /GitHub/);
    assert.match(said("Paused Book"), /Paused/);
    assert.match(said("Paused Book"), /Browser: Narrarium on Safari/);
    assert.match(said("Elsewhere Book"), /Another server/);
    assert.match(said("Finished Book"), /Completed/);
    assert.match(said("Finished Book"), /chapter 5 of 5/);
    assert.match(said("Finished Book"), /400,000 tokens · 150 calls · 3\.1 EUR · 2 calls with no known cost/);
    assert.match(said("New Book"), /Not started/);
    assert.ok(drawn(panel, "runs").length > 800, "there is text to look through");
    assert.equal(SECRETS_IN_PAGE.test(drawn(panel, "runs")), false, "no undefined, null or NaN");
    for (const [title, row] of Object.entries(byBook)) {
      const badge = row.find((node) => node.tagName === "SPAN" && node.className.split(" ").includes("badge"));
      assert.ok(badge.length >= 1, `${title}: the state is a labelled badge, not a colour`);
    }
    const labels = (row) => row.find((node) => node.tagName === "TD").map((node) => node.getAttribute("data-label"));
    assert.deepEqual(labels(byBook["Running Book"]), ["State", "Progress", "Run", "Spent"], "every value is labelled, for the card that a phone makes of the row");
    assert.ok(rows.every((row) => row.getAttribute("role") === "row" && row.find((node) => node.tagName === "TD").every((node) => node.getAttribute("role") === "cell") && row.find((node) => node.tagName === "TH")[0].getAttribute("role") === "rowheader"), "and the row keeps its roles");
    const empty = byBook["New Book"].find((node) => node.tagName === "TD").filter((node) => node.classList.contains("empty")).map((node) => node.getAttribute("data-label"));
    assert.deepEqual(empty, ["Progress", "Run", "Spent"], "what has nothing to say is marked, and a phone does not draw it");
    const bars = byBook["Running Book"].find((node) => node.tagName === "PROGRESS");
    assert.equal(bars.length, 1);
    assert.deepEqual([bars[0].getAttribute("value"), bars[0].getAttribute("max")], ["1", "5"], "done chapters of all of them");
    assert.match(bars[0].getAttribute("aria-label"), /chapter 2 of 5/);
    assert.equal(byBook["New Book"].find((node) => node.tagName === "PROGRESS").length, 0, "a book with no plan has no bar");
    assert.equal(panel.text("runs-summary"), "3 of 4 places in use · 10 books", "the line above the table");
  });
});

test("P12 panel books: the line above the table says how many runs are going and how many places there are, and the totals by state", async () => {
  await withServer(async (server) => {
    const today = { day: "2026-11-22", tokens: 91_000, calls: 5, cost: 1.84, currency: "USD", costUnknownCalls: 2 };
    const panel = await openStub(server, { "/admin/api/runs": { body: board(ALL_STATES.slice(0, 3), { running: 1, maxConcurrentRuns: 2, total: 3, counts: { stalled: 1, retrying: 1, running: 1 }, spendToday: today }) } });
    assert.equal(panel.text("runs-summary"), "1 of 2 places in use · 3 books");
    assert.equal(panel.text("runs-today"), "Today (UTC 2026-11-22): 91,000 tokens · 5 calls · 1.84 USD · 2 calls with no known cost", "what the server spent today, next to what each run spent");
    const quiet = await openStub(server, { "/admin/api/runs": { body: board([], { total: 0, spendToday: { day: "2026-11-22", tokens: 0, calls: 0 } }) } });
    assert.equal(quiet.text("runs-today"), "Today (UTC 2026-11-22): 0 tokens · 0 calls");
    const older = await openStub(server, { "/admin/api/runs": { body: { ...board([]), spendToday: undefined } } });
    assert.equal(older.text("runs-today"), "", "a server that does not say: nothing is drawn, nothing breaks");
    const empty = await openStub(server, { "/admin/api/runs": { body: board([], { running: 0, total: 0 }) } });
    assert.match(empty.text("runs-rows"), /No books yet/);
    assert.equal(empty.text("runs-summary"), "0 of 2 places in use · 0 books");
    const italian = await openStub(server, { "/admin/api/runs": { body: board(ALL_STATES, { running: 3, total: 10, spendToday: today }) } }, { language: "it-IT" });
    assert.equal(italian.text("runs-today"), "Oggi (UTC 2026-11-22): 91.000 token · 5 chiamate · 1.84 USD · 2 chiamate senza costo noto");
    const text = drawn(italian, "runs");
    assert.match(text, /Libri in corso/);
    assert.match(text, /Sembra bloccato/);
    assert.match(text, /Nessun segnale di vita da 14 min/);
    assert.match(text, /In attesa di riprovare/);
    assert.match(text, /Tentativo 2 di 3 tra 30 s/);
    assert.match(text, /Aspetta una tua risposta/);
    assert.match(text, /capitolo 2 di 5/);
    assert.match(text, /Adesso: scrittura/);
    assert.match(text, /Questo server/);
    assert.match(text, /Un altro server/);
    assert.match(text, /Browser: Narrarium on Safari/);
    assert.match(text, /1234 token · 7 chiamate · 0\.42 USD/, "Italian writes four digits without a point");
    assert.match(text, /400\.000 token · 150 chiamate · 3\.1 EUR/);
    assert.match(text, /Mai avviato/);
    const withoutTitles = text.replace(/[A-Z][a-z]+ Book/g, "");
    assert.equal(withoutTitles.match(/\b(?:Looks stalled|Running|Waiting|Paused|Completed|chapter \d|Show all|Last error|for \d+ min)\b/g), null, "nothing is left in English");
  });
});

test("P12 panel books: ten at first, all of them on request, and back to ten; the button says how many there are", async () => {
  await withServer(async (server) => {
    const many = Array.from({ length: 23 }, (_, index) => run({ bookId: `book-${index}`, title: `Book ${String(index + 1).padStart(2, "0")}`, state: "none" }));
    const panel = await openStub(server, { "/admin/api/runs": (query) => ({ body: board(many.slice(0, Number(query.get("limit"))), { total: many.length }) }) });
    assert.equal(rowsOf(panel, "runs-rows").length, 10);
    assert.equal(panel.requested("/admin/api/runs")[0].route, "/admin/api/runs?limit=10");
    const more = panel.browser.$("runs-more");
    assert.equal(more.classList.contains("hidden"), false);
    assert.equal(more.textContent, "Show all 23 books");
    await more.click();
    await settle(120);
    assert.equal(rowsOf(panel, "runs-rows").length, 23);
    assert.ok(panel.requested("/admin/api/runs").some((request) => request.route === "/admin/api/runs?limit=200"));
    assert.equal(more.textContent, "Show fewer");
    await panel.poll();
    assert.equal(rowsOf(panel, "runs-rows").length, 23, "the poll keeps what the owner chose to see");
    await more.click();
    await settle(120);
    assert.equal(rowsOf(panel, "runs-rows").length, 10);
    assert.equal(more.textContent, "Show all 23 books");
    const few = await openStub(server, { "/admin/api/runs": { body: board(many.slice(0, 8), { total: 8 }) } });
    assert.equal(few.browser.$("runs-more").classList.contains("hidden"), true, "eight fit: no button");
    const huge = await openStub(server, { "/admin/api/runs": (query) => ({ body: board(many.slice(0, Number(query.get("limit"))), { total: 300 }) }) });
    await huge.browser.$("runs-more").click();
    await settle(120);
    assert.match(huge.text("runs-note"), /Showing 23 of 300/);
  });
});

// ---------------------------------------------------------------------------------------------
// The history of the updates
// ---------------------------------------------------------------------------------------------

const CHECKS = (results = {}) => ["rollback", "metadata", "provenance", "registry-signature", "install", "integrity", "audit-signatures", "package"].map((check) => ({ check, result: results[check] ?? "passed", ...(results[`${check}Reason`] ? { reason: results[`${check}Reason`] } : {}), ...(results[`${check}Code`] ? { code: results[`${check}Code`] } : {}) }));
const HISTORY = {
  max: 20,
  entries: [
    { id: "r5", kind: "update", state: "requested", at: "2026-11-22T09:55:00.000Z", requestedAt: "2026-11-22T09:55:00.000Z", by: "admin", from: "0.1.9", to: "0.2.0" },
    { id: "r4", kind: "update", state: "completed", at: "2026-11-21T10:00:00.000Z", requestedAt: "2026-11-21T09:59:00.000Z", by: "client", actor: "Alessandro's MacBook", from: "0.1.8", to: "0.1.9", checks: CHECKS() },
    { id: "r3", kind: "update", state: "completed", at: "2026-11-20T10:00:00.000Z", by: "admin", from: "0.1.7", to: "0.1.8", checks: CHECKS({ "audit-signatures": "tolerated", "audit-signaturesCode": "EMISSINGSIGNATUREKEY" }) },
    { id: "r2", kind: "update", state: "failed", at: "2026-11-19T10:00:00.000Z", by: "admin", from: "0.1.6", to: "0.1.7", checks: CHECKS({ integrity: "refused", integrityReason: "The files npm installed do not match the registry's digest." }).slice(0, 6), refusal: { check: "integrity", kind: "refused", reason: "The files npm installed do not match the registry's digest." } },
    { id: "r1", kind: "update", state: "failed", at: "2026-11-18T10:00:00.000Z", by: "admin", from: "0.1.5", to: "0.1.6", checks: CHECKS({ install: "failed", installCode: "ENOTFOUND" }).slice(0, 5), refusal: { check: "install", kind: "failed", code: "ENOTFOUND" } },
    { id: "o2", kind: "offer", state: "refused", at: "2026-11-17T10:00:00.000Z", to: "0.1.5", refusal: { check: "provenance", kind: "refused", reason: "Version 0.1.5 is not offered: its provenance was rejected, the signing certificate names another workflow." } },
    { id: "r0", kind: "update", state: "limited", at: "2026-11-16T10:00:00.000Z", by: "client", actor: "Terminal", from: "0.1.4", to: "0.1.5" },
    { id: "rz", kind: "update", state: "stopping", at: "2026-11-15T10:00:00.000Z", by: "admin", from: "0.1.3", to: "0.1.4" },
    { id: "r6", kind: "update", state: "completed", at: "2026-11-14T10:00:00.000Z", by: "admin", from: "0.1.2", to: "0.1.3" },
  ],
};

test("P12 panel updates: the history says for each update when, from which version to which, who asked, how it ended, what was checked, and for a refusal which check stopped it and why", async () => {
  await withServer(async (server) => {
    const panel = await openStub(server, { "/admin/api/updates/history": { body: HISTORY } });
    const rows = rowsOf(panel, "history-rows");
    assert.equal(rows.length, 9);
    const text = rows.map((row) => row.textContent);
    assert.ok(rows.every((row) => row.find((node) => node.tagName === "TD").length === 5), "when, version, asked by, result, checks");
    assert.deepEqual(rows[1].find((node) => node.tagName === "TD").map((node) => node.getAttribute("data-label")), ["When", "Version", "Asked by", "Result", "Checks"]);
    assert.match(text[0], /0\.1\.9 → 0\.2\.0/);
    assert.match(text[0], /You, in the panel/);
    assert.match(text[0], /Waiting for the supervisor/);
    assert.match(text[1], /0\.1\.8 → 0\.1\.9/);
    assert.match(text[1], /Client Alessandro's MacBook/);
    assert.match(text[1], /Installed/);
    assert.match(text[1], /All 8 checks passed/);
    assert.match(text[2], /7 checks passed, 1 tolerated/);
    assert.match(text[2], /npm audit signatures: tolerated \(EMISSINGSIGNATUREKEY\)/, "what was let through is said, with npm's code");
    assert.match(text[3], /Not installed \(the previous version stays\)/);
    assert.match(text[3], /Stopped at: Integrity of the files — refused/);
    assert.match(text[3], /The files npm installed do not match the registry's digest\./, "the reason, in the server's own words");
    assert.match(text[4], /Stopped at: npm install — failed \(ENOTFOUND\)/);
    assert.match(text[5], /Not offered/);
    assert.match(text[5], /Stopped at: Publisher \(provenance\) — refused/);
    assert.match(text[5], /its provenance was rejected/);
    assert.match(text[5], /0\.1\.5/);
    assert.match(text[6], /Cancelled: limit of three updates an hour/);
    assert.match(text[7], /Cancelled: the server did not stop in time/);
    assert.match(text[6] + text[7], /No check was made: the update did not start/, "an update that was cancelled never checked anything, and says so");
    assert.match(text[8], /Installed/);
    assert.match(text[8], /The supervisor did not report what it checked/, "an update with no record of checks says that nothing was recorded, and does not say it was fine");
    assert.equal(/All \d+ checks passed/.test(text[6] + text[7] + text[8] + text[0]), false);
    assert.ok(drawn(panel, "updates").length > 800, "there is text to look through");
    assert.equal(SECRETS_IN_PAGE.test(drawn(panel, "updates")), false);
    const detail = rows[1].find((node) => node.tagName === "DETAILS");
    assert.equal(detail.length, 1, "the full list of checks is one click away");
    assert.equal(detail[0].find((node) => node.tagName === "LI").length, 8);
    assert.match(detail[0].textContent, /Not older than the installed version: passed/);
    assert.match(detail[0].textContent, /Registry signature: passed/);
    assert.match(detail[0].textContent, /Installed package: passed/);
  });
});

test("P12 panel updates: the history is in Italian too, and an empty one says so", async () => {
  await withServer(async (server) => {
    const italian = await openStub(server, { "/admin/api/updates/history": { body: HISTORY } }, { language: "it-IT" });
    const text = italian.text("history-rows");
    assert.ok(text.length > 400);
    assert.match(text, /Tu, dal pannello/);
    assert.match(text, /Client Alessandro's MacBook/);
    assert.match(text, /Installato/);
    assert.match(text, /Tutti i controlli superati \(8\)|8 controlli superati/);
    assert.match(text, /Fermato a: Integrità dei file — rifiutato/);
    assert.match(text, /Non proposto/);
    assert.match(text, /Annullato: limite di tre aggiornamenti all'ora/);
    assert.match(text, /Nessun controllo eseguito: l'aggiornamento non è partito/);
    assert.match(text, /Il supervisore non ha riferito cosa ha controllato/);
    assert.equal(/\b(?:Installed|Stopped at|Not offered|Cancelled|passed)\b/.test(text), false, "nothing is left in English");
    const empty = await openStub(server, { "/admin/api/updates/history": { body: { max: 20, entries: [] } } });
    assert.match(empty.text("history-rows"), /No update yet/);
  });
});

// ---------------------------------------------------------------------------------------------
// The action log
// ---------------------------------------------------------------------------------------------

const entry = (seq, extra = {}) => ({ seq, at: `2026-11-22T09:${String(60 - seq).padStart(2, "0")}:00.000Z`, actor: { kind: "admin" }, action: "token.issue", type: "clients", ok: true, ...extra });
const LOG_PAGE = {
  entries: [
    entry(9, { action: "token.revoke", object: "c1", label: "Phone", source: "local" }),
    entry(8, { action: "admin.login", type: "access", actor: { kind: "anonymous" }, ok: false, code: "invalid_code", count: 4, last: "2026-11-22T09:52:00.000Z", source: "203.0.113.9" }),
    entry(7, { action: "run.start", type: "books", actor: { kind: "client", id: "k1", label: "Narrarium" }, ok: false, code: "too_many_runs", object: "glass" }),
    entry(6, { action: "pairing.request", type: "clients", actor: { kind: "device", label: "Alessandro's MacBook" }, source: "203.0.113.9" }),
    entry(5, { action: "update.finish", type: "updates", actor: { kind: "system" }, object: "0.1.9", detail: "0.1.8" }),
    entry(4, { action: "spend.limits", type: "spend", detail: "maxTokensPerDay 0->1000" }),
    entry(3, { action: "an-action-of-the-future", type: "other", actor: { kind: "admin" } }),
  ],
  nextBefore: 3,
};

test("P12 panel log: every entry says when, who, what it was done to, and whether it worked, in words; a failure says why, and a repeat says how many times", async () => {
  await withServer(async (server) => {
    const panel = await openStub(server, { "/admin/api/log": { body: LOG_PAGE } });
    const rows = rowsOf(panel, "log-rows");
    assert.equal(rows.length, 7);
    assert.ok(rows.every((row) => row.find((node) => node.tagName === "TD").length === 5), "when, who, what, on, result");
    assert.deepEqual(rows[0].find((node) => node.tagName === "TD").map((node) => node.getAttribute("data-label")), ["When", "Who", "What", "On", "Result"]);
    assert.ok(rows.every((row) => row.getAttribute("role") === "row"), "and the rows keep their roles");
    const text = rows.map((row) => row.textContent);
    assert.match(text[0], /Revoked a client/);
    assert.match(text[0], /You \(panel\)/);
    assert.match(text[0], /Phone/);
    assert.match(text[0], /Done/);
    assert.match(text[1], /Signed in to the panel/);
    assert.match(text[1], /Unknown \(not signed in\)/);
    assert.match(text[1], /Failed: invalid_code/);
    assert.match(text[1], /×4, last /, "four wrong codes are one line");
    assert.match(text[1], /203\.0\.113\.9/, "from where");
    assert.match(text[2], /Started the autopilot/);
    assert.match(text[2], /Client Narrarium/);
    assert.match(text[2], /glass/);
    assert.match(text[2], /Failed: too_many_runs/);
    assert.match(text[3], /A device asked to pair/);
    assert.match(text[3], /Device Alessandro's MacBook/);
    assert.match(text[4], /An update ended/);
    assert.match(text[4], /The server/);
    assert.match(text[4], /0\.1\.9/);
    assert.match(text[5], /Changed the AI spending limits/);
    assert.match(text[5], /maxTokensPerDay 0->1000/);
    assert.match(text[6], /an-action-of-the-future/, "an action that this panel does not know is shown as the server wrote it");
    assert.ok(drawn(panel, "log").length > 500, "there is text to look through");
    assert.equal(SECRETS_IN_PAGE.test(drawn(panel, "log")), false);
    assert.equal(panel.browser.$("log-more").classList.contains("hidden"), false, "there are older entries");
    const italian = await openStub(server, { "/admin/api/log": { body: LOG_PAGE } }, { language: "it-IT" });
    const it = italian.text("log-rows");
    assert.match(it, /Revocato un client/);
    assert.match(it, /Tu \(pannello\)/);
    assert.match(it, /Sconosciuto \(non autenticato\)/);
    assert.match(it, /Non riuscito: invalid_code/);
    assert.match(it, /×4, ultima /);
    assert.match(it, /Accesso al pannello/);
    assert.match(it, /Il server/);
    assert.match(it, /Dispositivo Alessandro's MacBook/);
    assert.equal(/\b(?:Revoked|Signed in|Failed:|Started the|Changed the)\b/.test(it), false, "nothing is left in English");
  });
});

test("P12 panel log: it can be filtered by the kind of action and by what worked or failed; the filters are labelled, ask the server and start again from the newest", async () => {
  await withServer(async (server) => {
    const panel = await openStub(server, { "/admin/api/log": (query) => ({ body: query.get("type") === "clients" ? { entries: [entry(2), entry(1)], nextBefore: null } : LOG_PAGE }) });
    assert.equal(panel.requested("/admin/api/log")[0].route, "/admin/api/log?limit=20");
    const type = panel.browser.$("log-type");
    const result = panel.browser.$("log-result");
    assert.ok(panel.html.includes('for="log-type"') && panel.html.includes('for="log-result"'), "each filter has a label");
    const options = (id) => panel.html.match(new RegExp(`<select[^>]*id="${id}"[\\s\\S]*?</select>`))[0].match(/<option\b[^>]*value="([^"]*)"/g).map((match) => /value="([^"]*)"/.exec(match)[1]);
    assert.deepEqual(options("log-type"), ["", ...testing.ADMIN_ACTION_TYPES], "the kinds the server knows");
    assert.deepEqual(options("log-result"), ["", "true", "false"]);
    type.value = "clients";
    await type.dispatch("change");
    await settle(120);
    assert.equal(panel.requested("/admin/api/log").at(-1).route, "/admin/api/log?limit=20&type=clients");
    assert.equal(rowsOf(panel, "log-rows").length, 2);
    assert.equal(panel.browser.$("log-more").classList.contains("hidden"), true, "nothing older under this filter");
    result.value = "false";
    await result.dispatch("change");
    await settle(120);
    assert.equal(panel.requested("/admin/api/log").at(-1).route, "/admin/api/log?limit=20&type=clients&ok=false");
    type.value = "";
    result.value = "";
    await type.dispatch("change");
    await settle(120);
    assert.equal(panel.requested("/admin/api/log").at(-1).route, "/admin/api/log?limit=20");
    assert.equal(rowsOf(panel, "log-rows").length, 7);
  });
});

test("P12 panel log: older entries are fetched from where the page ended and added below, and the poll leaves them alone; an empty log, and a filter that matches nothing, say so", async () => {
  await withServer(async (server) => {
    const panel = await openStub(server, { "/admin/api/log": (query) => ({ body: query.get("before") === "3" ? { entries: [entry(2, { action: "token.issue" }), entry(1, { action: "pairing.start" })], nextBefore: null } : LOG_PAGE }) });
    assert.equal(rowsOf(panel, "log-rows").length, 7);
    await panel.browser.$("log-more").click();
    await settle(120);
    assert.equal(panel.requested("/admin/api/log").at(-1).route, "/admin/api/log?limit=20&before=3");
    assert.equal(rowsOf(panel, "log-rows").length, 9);
    assert.match(rowsOf(panel, "log-rows")[8].textContent, /Started pairing a client/);
    assert.equal(panel.browser.$("log-more").classList.contains("hidden"), true);
    await panel.poll();
    assert.equal(rowsOf(panel, "log-rows").length, 9, "the poll does not throw away what was asked for");
    const empty = await openStub(server, { "/admin/api/log": { body: { entries: [], nextBefore: null } } });
    assert.match(empty.text("log-rows"), /Nothing recorded yet/);
    const filtered = await openStub(server, { "/admin/api/log": (query) => ({ body: { entries: [], nextBefore: null } }) });
    filtered.browser.$("log-type").value = "spend";
    await filtered.browser.$("log-type").dispatch("change");
    await settle(120);
    assert.match(filtered.text("log-rows"), /Nothing matches this filter/);
  });
});

test("P12 panel: the poll that runs by itself asks again for the risks, the health, the books in progress and the newest of the log", async () => {
  await withServer(async (server) => {
    const panel = await openStub(server, { "/admin/api/risks": { body: NO_RISKS }, "/admin/api/health": { body: HEALTHY }, "/admin/api/runs": { body: board([]) }, "/admin/api/log": { body: LOG_PAGE }, "/admin/api/updates/history": { body: HISTORY } });
    const before = Object.fromEntries(["risks", "health", "runs", "log", "updates/history"].map((name) => [name, panel.requested(`/admin/api/${name}`).length]));
    await panel.poll();
    for (const name of Object.keys(before)) assert.ok(panel.requested(`/admin/api/${name}`).length > before[name], `the poll asked for ${name}`);
    assert.equal(panel.ticks.length, 1, "one timer");
  });
});

// ---------------------------------------------------------------------------------------------
// The panel against a real server: what the server answers is what the panel reads
// ---------------------------------------------------------------------------------------------

async function openPanel(server, { language = "en-GB" } = {}) {
  const admin = await adminLogin(server);
  const { html, script } = await pageOf(server);
  const requests = [];
  const ticks = [];
  const fetchThroughSession = async (route, init = {}) => {
    requests.push({ route, method: init.method ?? "GET", body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const response = await fetch(`${server.adminUrl}${route}`, { method: init.method, headers: { ...init.headers, origin: server.adminUrl, cookie: admin.cookie }, body: init.body });
    const text = await response.text();
    return { status: response.status, ok: response.ok, text: async () => text };
  };
  const browser = fakeBrowser(html, script, {
    fetch: fetchThroughSession,
    location: { origin: server.adminUrl },
    navigator: { language, clipboard: { writeText: async () => undefined } },
    storage: { "narrarium-admin-csrf": admin.csrf },
    extra: { setInterval: (callback) => ticks.push(callback) },
    filename: "admin.js",
  });
  await browser.ready;
  await until(() => browser.$("main-view") && !browser.$("main-view").classList.contains("hidden"));
  return { browser, html, script, requests, admin, ticks, text: (id) => browser.$(id).textContent, poll: async () => { await ticks[0](); await settle(150); } };
}

test("P12 panel (real server): a server that is set up with some risk shows them, and each goes when its fact does", async () => {
  await withServer(async (server) => {
    const panel = await openPanel(server);
    await until(() => panel.text("risk-summary") !== "");
    assert.match(panel.text("risk-list"), /AI spending has no limit/, "the usual test server: a client that can run, and no limit");
    const issued = await panel.admin.call("POST", "/admin/api/token", { label: "Phone", scopes: ["read", "update"] });
    await panel.admin.call("POST", "/admin/api/network", { allowedAiBases: [], origins: [], publicUrl: "", adminPublicUrl: "https://admin.example.test", allowRemoteAdmin: true });
    await panel.poll();
    const text = panel.text("risk-list");
    assert.match(text, /High risk/);
    assert.match(text, /reachable from the internet/);
    assert.match(text, /https:\/\/admin\.example\.test/);
    assert.match(text, /1 client may update this server: Phone/);
    assert.equal(text.includes(issued.body.token), false);
    await panel.admin.call("POST", "/admin/api/revoke", { id: issued.body.clientId });
    await panel.admin.call("POST", "/admin/api/network", { allowedAiBases: [], origins: [], publicUrl: "", adminPublicUrl: "", allowRemoteAdmin: false });
    await panel.poll();
    assert.doesNotMatch(panel.text("risk-list"), /reachable from the internet|may update this server/);
    assert.match(panel.text("risk-list"), /AI spending has no limit/);
  });
});

test("P12 panel (real server): the health is read from the server: a low disk and a stopped connector come, and go", async () => {
  const disk = { free: 40 * GIB };
  await withServer(async (server) => {
    const panel = await openPanel(server);
    await until(() => panel.text("health-summary") !== "");
    assert.equal(panel.text("health-summary"), "All is well.");
    assert.match(panel.text("health-rows"), /40 GiB free of 100 GiB/);
    disk.free = 100 * MIB;
    await panel.poll();
    assert.equal(panel.text("health-summary"), "Needs a look: Disk space.");
    assert.match(panel.text("health-rows"), /Only 100 MiB free of 100 GiB: saving a book may fail now/);
    disk.free = 40 * GIB;
    await panel.poll();
    assert.equal(panel.text("health-summary"), "All is well.");
  }, { admin: { disk: async () => ({ free: disk.free, total: 100 * GIB }) } });
});

test("P12 panel (real server): a book that runs is drawn with its chapter and step, one that waits with its state; the books are the ones of the server", async () => {
  const ai = holdingAi();
  try {
    await withServer(async (server, client) => {
      await seededBook(client, "going");
      await seededBook(client, "idle");
      await client.startAutopilot("going", startOf(2));
      await until(() => ai.isHeld());
      const panel = await openPanel(server);
      await until(() => rowsOfText(panel, "runs-rows").length === 2);
      const rows = rowsOfText(panel, "runs-rows");
      const going = rows.find((row) => /Running/.test(row));
      assert.ok(going, rows.join("\n"));
      assert.match(going, /chapter 1 of 2/);
      assert.match(going, /Now: writing · chapter 1, scene 1 · for \d+ s/);
      assert.match(going, /This server/);
      assert.match(going, /0 tokens · 0 calls|\d[\d,]* tokens · \d+ calls/);
      const idle = rows.find((row) => /Not started/.test(row));
      assert.ok(idle, rows.join("\n"));
      assert.match(idle, /—/);
      assert.equal(SECRETS_IN_PAGE.test(drawn(panel, "runs")), false);
      assert.match(panel.text("runs-summary"), /^1 of 2 places in use · 2 books$/);
      const board = (await panel.admin.call("GET", "/admin/api/runs")).body;
      assert.deepEqual(board.books.map((book) => book.bookId).sort(), ["going", "idle"], "the books of the server");
    }, { ai });
  } finally {
    ai.release();
  }
});

test("P12 panel (real server): a release that the server refuses to offer is a row of the history with the check that stopped it and the server's own words", async () => {
  const message = "Version 0.2.0 is not offered: its provenance was rejected, the signing certificate names another workflow.";
  await withServer(async (server) => {
    const panel = await openPanel(server);
    await panel.admin.call("GET", "/admin/api/updates");
    await panel.poll();
    await until(() => /Not offered/.test(panel.text("history-rows")));
    const row = rowsOfText(panel, "history-rows")[0];
    assert.match(row, /0\.2\.0/);
    assert.match(row, /Stopped at: Publisher \(provenance\) — refused/);
    assert.match(row, /its provenance was rejected/);
  }, { checkRelease: async (installedVersion) => ({ packageName: "narrarium-server", installedVersion, available: false, signed: false, reason: "no_trusted_release", message }) });
});

test("P12 panel (real server): the log shows what the owner and the clients did, and a click on the filters asks the server", async () => {
  await withServer(async (server) => {
    const panel = await openPanel(server);
    const issued = await panel.admin.call("POST", "/admin/api/token", { label: "Phone", scopes: ["read"] });
    await panel.admin.call("POST", "/admin/api/revoke", { id: issued.body.clientId });
    await panel.admin.call("POST", "/admin/api/spend", { maxTokensPerDay: 1000 });
    await fetch(`${server.adminUrl}/admin/api/login`, { method: "POST", headers: { origin: server.adminUrl, "content-type": "application/json" }, body: JSON.stringify({ code: "x".repeat(40) }) });
    await panel.poll();
    const text = panel.text("log-rows");
    assert.match(text, /Created a client token/);
    assert.match(text, /Revoked a client/);
    assert.match(text, /Changed the AI spending limits/);
    assert.match(text, /Phone/);
    assert.match(text, /Failed: /, "the wrong code");
    assert.match(text, /Unknown \(not signed in\)/);
    const type = panel.browser.$("log-type");
    type.value = "spend";
    await type.dispatch("change");
    await until(() => rowsOfText(panel, "log-rows").length === 1);
    assert.match(rowsOfText(panel, "log-rows")[0], /Changed the AI spending limits/);
    type.value = "";
    panel.browser.$("log-result").value = "false";
    await panel.browser.$("log-result").dispatch("change");
    await until(() => rowsOfText(panel, "log-rows").length >= 1 && rowsOfText(panel, "log-rows").every((row) => /Failed: /.test(row)));
  });
});

// ---------------------------------------------------------------------------------------------
// Nothing that is secret in the panel, in the files or in the answers
// ---------------------------------------------------------------------------------------------

test("P12 secrets: the panel's new views, their answers and the files they come from hold no admin code, token, verifier, prompt or text of a book", async () => {
  const slow = gatedAi();
  const BRIEF = "SECRET-PROMPT: the harbor master is secretly an octopus (PLANTED-BRIEF-8841)";
  await withServer(async (server, client, dataDir) => {
    try {
      const { slug } = await mcpFixture(server, client);
      const panel = await openPanel(server);
      const issued = await panel.admin.call("POST", "/admin/api/token", { label: "Phone", scopes: ["read", "write", "run", "update"] });
      const pairing = await panel.admin.call("POST", "/admin/api/pairing", {});
      const connected = await connectApp(server, { slug, name: "Claude", scopes: ["read", "write", "run"] });
      await client.commitFiles("glass", [{ path: "chapters/001/PLANTED-BOOK-TEXT.md", content: "PLANTED-BOOK-TEXT-5513: the lighthouse keeper hides the key" }], "planted");
      await client.startAutopilot("glass", startOf(1, { brief: { ...startOf(1).brief, idea: BRIEF } }));
      await slow.started;
      const raw = await server.auth.issue("raw", ["read", "update"]);
      await panel.admin.call("POST", "/admin/api/ai/approve", { bases: ["https://api.openai.com/v1"] });
      await panel.admin.call("GET", "/admin/api/updates");
      await panel.poll();

      const answers = await Promise.all(["risks", "health", "runs", "updates/history", "log?limit=200"].map(async (name) => JSON.stringify((await panel.admin.call("GET", `/admin/api/${name}`)).body)));
      const rendered = ["risks", "health", "runs", "updates", "log"].map((view) => drawn(panel, view));
      const files = await Promise.all(["admin-log.jsonl", "update-history.json"].map((name) => readFile(path.join(dataDir, name), "utf8").catch(() => "")));
      const secrets = [panel.admin.code, issued.body.token, raw.token, pairing.body.code, connected.tokens.access_token, connected.tokens.refresh_token, connected.verifier, connected.app.client_id, "code_verifier", "PLANTED-BRIEF-8841", "SECRET-PROMPT", "PLANTED-BOOK-TEXT", "octopus", "lighthouse keeper"].filter(Boolean);
      for (const [where, text] of Object.entries({ answers: answers.join("\n"), rendered: rendered.join("\n"), files: files.join("\n") })) {
        for (const secret of secrets) assert.equal(text.includes(secret), false, `${where} hold "${secret.slice(0, 24)}"`);
      }
      assert.ok(answers.join("").length > 1000 && rendered.join("").length > 500, "and there was something to search");
    } finally {
      slow.release();
    }
  }, { ai: slow.ai });
});
