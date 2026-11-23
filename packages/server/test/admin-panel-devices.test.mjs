import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fakeBrowser } from "./fake-browser.mjs";
import { until, withServer } from "./helpers.mjs";

// The admin panel as a person uses it (P14): signing in with "Remember this device forever", opening the panel again without a prompt, the session that ends and is renewed by the device's own
// key, the pages and their addresses, and the ways a device stops being remembered. The panel's script runs in a small fake browser against a real server: what each request carries, and what the
// server answers, is the real one. A "profile" is what the tabs of one browser share: the cookie of the session and the local storage; a tab has a session storage of its own.

const origin = (server) => server.adminUrl;
const deviceKey = (server) => `narrarium-admin-device:${origin(server)}`;
const codeOf = async (server) => (await readFile(path.join(server.data.root, "private", "admin-code.txt"), "utf8")).trim();

function storeOf(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (name) => values.get(name) ?? null, setItem: (name, value) => void values.set(name, String(value)), removeItem: (name) => void values.delete(name), dump: () => [...values.entries()] };
}

async function profileOf(server) {
  const page = { html: await (await fetch(`${origin(server)}/`)).text(), script: await (await fetch(`${origin(server)}/admin.js`)).text() };
  const jar = { cookie: undefined };
  const local = storeOf();
  const requests = [];
  const fetchFor = async (route, init = {}) => {
    const headers = { origin: origin(server), ...(init.headers ?? {}) };
    if (jar.cookie) headers.cookie = jar.cookie;
    requests.push({ route, method: init.method ?? "GET", body: init.body === undefined ? undefined : JSON.parse(init.body), cookie: jar.cookie, csrf: headers["x-csrf-token"] });
    const response = await fetch(`${origin(server)}${route}`, { method: init.method, headers, body: init.body });
    const set = response.headers.get("set-cookie");
    if (set) jar.cookie = /Max-Age=0/.test(set) ? undefined : set.split(";")[0];
    const text = await response.text();
    return { status: response.status, ok: response.ok, text: async () => text };
  };
  const tabs = [];
  /** A tab of this browser: a new one has no session storage; what its address says (`hash`) is the page it opens. */
  const open = async ({ hash = "", session = {}, confirm = () => true } = {}) => {
    const sessionStorage = storeOf(session);
    const tab = fakeBrowser(page.html, page.script, { fetch: fetchFor, location: { origin: origin(server), hash }, navigator: { language: "en-GB", clipboard: { writeText: async () => undefined } }, confirm, extra: { localStorage: local, sessionStorage }, filename: "admin.js" });
    tab.sessionStorage = sessionStorage;
    tabs.push(tab);
    await tab.ready;
    return tab;
  };
  return { ...page, jar, local, requests, open, tabs };
}

const signedIn = (tab) => !tab.$("main-view").classList.contains("hidden");
const onLogin = (tab) => !tab.$("login-view").classList.contains("hidden");
const waitSignedIn = (tab) => until(() => signedIn(tab));
const waitLogin = (tab) => until(() => onLogin(tab) && !signedIn(tab));
/** The rows of a table that are data, not the quiet "Loading…". */
const dataRows = (tab, id) => tab.$(id).children.filter((row) => row.className !== "loading-row");
const logins = (profile) => profile.requests.filter((request) => request.route === "/admin/api/login");

async function signInWith(profile, server, { remember }) {
  const tab = await profile.open();
  await waitLogin(tab);
  assert.equal(onLogin(tab), true, "a browser that knows nothing asks for the code");
  tab.$("code").value = await codeOf(server);
  tab.$("remember").checked = remember;
  await tab.$("login-form").dispatch("submit");
  await waitSignedIn(tab);
  return tab;
}

test("P14 devices: the sign-in has a box to remember this device, unticked, with its own words; ticked, the page keeps a device key and never the admin code", async () => {
  await withServer(async (server) => {
    const me = await profileOf(server);
    assert.match(me.html, /<label class="check" for="remember"><input type="checkbox" id="remember" aria-describedby="remember-help"><span data-i18n="rememberDevice">Remember this device forever<\/span><\/label>/, "a labelled box, with a description");
    assert.match(me.html, /<p class="field-help" id="remember-help" data-i18n="rememberHelp">/, "which says what it does");
    const english = await me.open();
    assert.equal(english.$("remember").checked, false, "unticked until the person decides");
    assert.equal(english.all('[data-i18n="rememberDevice"]')[0].textContent, "Remember this device forever");
    assert.match(english.all('[data-i18n="rememberHelp"]')[0].textContent, /never your admin code.*revoke it at any time in Security.*signing out forgets it/);

    const tab = await signInWith(me, server, { remember: true });
    const [login] = logins(me);
    assert.deepEqual(login.body, { code: await codeOf(server), remember: true }, "the page asks to remember");
    const saved = JSON.parse(me.local.getItem(deviceKey(server)));
    assert.deepEqual(Object.keys(saved).sort(), ["id", "token"]);
    assert.match(saved.token, /^nrd_[A-Za-z0-9_-]{43}$/);
    assert.equal(server.auth.listDevices()[0].id, saved.id, "the key belongs to a device that the server lists");
    const code = await codeOf(server);
    for (const [name, value] of [...me.local.dump(), ...tab.sessionStorage.dump()]) assert.equal(String(value).includes(code), false, `the admin code is not in ${name}`);
    assert.equal(tab.$("code").value, "", "and not left in the field");
    assert.equal(tab.$("remember").checked, false);
    assert.match(tab.$("toast").textContent, /This device is remembered/);
    await until(() => !tab.$("logout-note").classList.contains("hidden"));
    assert.equal(tab.$("logout-note").textContent, "Signing out also forgets this device.", "and the button that signs out says what it does");

    const italian = await (async () => {
      const other = await profileOf(server);
      const page = fakeBrowser(other.html, other.script, { fetch: async () => ({ status: 401, ok: false, text: async () => "{}" }), navigator: { language: "it-IT" }, location: { origin: origin(server) } });
      await page.ready;
      return page;
    })();
    assert.equal(italian.all('[data-i18n="rememberDevice"]')[0].textContent, "Ricorda questo dispositivo per sempre");
  });
});

test("P14 devices: signing in without the box makes no device; the page keeps nothing, and a new session asks for the code", async () => {
  await withServer(async (server) => {
    const stranger = await profileOf(server);
    const first = await stranger.open();
    assert.equal(onLogin(first), true, "a browser that was never in shows the sign-in at once");
    assert.deepEqual(stranger.requests, [], "and asks nothing of the server: nobody has been refused");
    const me = await profileOf(server);
    const tab = await signInWith(me, server, { remember: false });
    assert.equal(me.local.getItem(deviceKey(server)), null);
    assert.deepEqual(server.auth.listDevices(), []);
    assert.equal(tab.$("logout-note").classList.contains("hidden"), true, "nothing to say about forgetting");
    // A new tab of the same browser is in: it has the cookie of the session, though not the token of this tab.
    const sibling = await me.open();
    await waitSignedIn(sibling);
    assert.equal(logins(me).length, 1, "without signing in again");
    // Without the cookie, a token for this tab or a device, the page asks once, is told no, and shows the sign-in.
    me.jar.cookie = undefined;
    const before = me.requests.length;
    const reopened = await me.open();
    await waitLogin(reopened);
    assert.deepEqual(me.requests.slice(before).map((request) => `${request.method} ${request.route}`), ["GET /admin/api/status"], "one question, no sign-in");
    assert.equal(reopened.$("login-error").textContent, "", "and no complaint: nobody has been refused");
  });
});

test("P14 devices: a remembered device opens the panel again without a prompt, with the session or after it ended, and says its key and not the code", async () => {
  await withServer(async (server) => {
    const me = await profileOf(server);
    await signInWith(me, server, { remember: true });
    const code = await codeOf(server);
    const key = JSON.parse(me.local.getItem(deviceKey(server))).token;

    // Reloaded while the session lives: the cookie is enough, and nothing is signed in again.
    const count = logins(me).length;
    const reload = await me.open({ session: {} });
    await waitSignedIn(reload);
    assert.equal(logins(me).length, count, "no sign-in: the session was still there");

    // The session ended (it lasts half an hour): the page signs in by itself, with the device's key.
    me.jar.cookie = undefined;
    const later = await me.open();
    await waitSignedIn(later);
    const silent = logins(me).slice(count);
    assert.equal(silent.length, 1, "one silent sign-in");
    assert.deepEqual(silent[0].body, { deviceToken: key }, "with the device's key, and nothing else");
    assert.equal(JSON.stringify(silent[0]).includes(code), false, "the admin code is in no request of the page that remembers");
    assert.equal(later.$("login-error").textContent, "");
    assert.equal(onLogin(later), false);
    await until(() => dataRows(later, "health-rows").length > 0 && dataRows(later, "client-rows").length > 0);
    assert.equal(JSON.parse(me.local.getItem(deviceKey(server))).token, key, "the key stays: it is the same one");
    const [device] = server.auth.listDevices();
    assert.ok(Date.parse(device.lastUsedAt) >= Date.parse(device.createdAt), "the server noted when it was used");
  });
});

test("P14 devices: a request that finds the session over signs in with the key and goes on, once, however many ask together; and a tab that lost the token for changes asks for it, without signing in", async () => {
  await withServer(async (server) => {
    const me = await profileOf(server);
    const tab = await signInWith(me, server, { remember: true });
    await until(() => dataRows(tab, "client-rows").length > 0 || tab.$("client-rows").children.length > 0);
    const logged = logins(me).length;

    // The cookie goes (the half hour is over) and two things are asked together: they share one silent sign-in, and both go through.
    me.jar.cookie = undefined;
    const before = me.requests.length;
    await Promise.all([tab.$("pairing-start").click(), tab.$("updates-check").click()]);
    await until(() => me.requests.slice(before).some((request) => request.route === "/admin/api/pairing" && request.cookie !== undefined));
    const silent = logins(me).slice(logged);
    assert.equal(silent.length, 1, "one silent sign-in for two requests");
    assert.ok(silent[0].body.deviceToken, "with the key");
    const pairings = me.requests.slice(before).filter((request) => request.route === "/admin/api/pairing");
    assert.equal(pairings.length, 2, "the request that found the session over was sent again");
    assert.equal(pairings[0].cookie, undefined);
    assert.ok(pairings[1].cookie && pairings[1].csrf, "with the new session and its token");
    await until(() => tab.$("pairing-box").textContent.length > 0);
    assert.match(tab.$("pairing-box").textContent, /\d{3} \d{3} \d{3}/, "the code of a pairing is on the page");

    // Another tab of the same browser signs in by itself (the cookie had ended): its session replaces the cookie, and this tab's token for changes belongs to the old one.
    me.jar.cookie = undefined;
    const other = await me.open({ session: {} });
    await waitSignedIn(other);
    const mark = me.requests.length;
    await tab.$("pairing-start").click();
    await until(() => me.requests.slice(mark).filter((request) => request.route === "/admin/api/pairing").length === 2);
    const steps = me.requests.slice(mark).filter((request) => ["/admin/api/pairing", "/admin/api/session", "/admin/api/login"].includes(request.route)).map((request) => `${request.method} ${request.route}`);
    assert.deepEqual(steps, ["POST /admin/api/pairing", "GET /admin/api/session", "POST /admin/api/pairing"], "it asked for the token that goes with the cookie it has, and did not sign in again");
  });
});

test("P14 devices: a key that the server does not know is deleted by the page, and the sign-in shows with a sentence; a key that could not be tried is kept", async () => {
  await withServer(async (server) => {
    const me = await profileOf(server);
    me.local.setItem(deviceKey(server), JSON.stringify({ id: "gone", token: `nrd_${"z".repeat(43)}` }));
    const tab = await me.open();
    await waitLogin(tab);
    assert.equal(me.local.getItem(deviceKey(server)), null, "the key that does not work is gone");
    assert.equal(logins(me).length, 1, "tried once");
    assert.equal(tab.$("login-error").textContent, "This device is not remembered any more: sign in with the admin code.");
    assert.equal(tab.$("login-error").getAttribute("role"), "alert", "said to a screen reader");
    assert.equal(tab.$("main-view").classList.contains("hidden"), true);

    // Nothing the page could say: a key that cannot be tried (the server is not there) stays.
    me.local.setItem(deviceKey(server), JSON.stringify({ id: "kept", token: `nrd_${"y".repeat(43)}` }));
    const offline = fakeBrowser(me.html, me.script, { fetch: async () => { throw new Error("offline"); }, location: { origin: origin(server) }, extra: { localStorage: me.local }, filename: "admin.js" });
    await offline.ready;
    await until(() => onLogin(offline));
    assert.ok(me.local.getItem(deviceKey(server)), "a key is only deleted when the server says that it is wrong");
    // A damaged value is nothing: no key, no attempt.
    me.local.setItem(deviceKey(server), "{ not json");
    const damaged = await me.open();
    await waitLogin(damaged);
  });
});

test("P14 devices: signing out also forgets this device, on the page and on the server, and says so; the other devices stay", async () => {
  await withServer(async (server) => {
    const me = await profileOf(server);
    const tab = await signInWith(me, server, { remember: true });
    const other = await profileOf(server);
    const second = await signInWith(other, server, { remember: true });
    assert.equal(server.auth.listDevices().length, 2);
    const mine = JSON.parse(me.local.getItem(deviceKey(server)));
    await tab.$("logout").click();
    await waitLogin(tab);
    const out = me.requests.filter((request) => request.route === "/admin/api/logout");
    assert.deepEqual(out.map((request) => request.body), [{ deviceId: mine.id }], "the page says which device is signing out");
    assert.equal(me.local.getItem(deviceKey(server)), null, "the key is deleted here");
    assert.deepEqual(server.auth.listDevices().map((device) => device.id), [JSON.parse(other.local.getItem(deviceKey(server))).id], "and revoked there, the other one is left");
    assert.equal(tab.$("logout-note").classList.contains("hidden"), true);
    assert.equal(tab.$("login-error").textContent, "");
    const again = await me.open();
    await waitLogin(again);
    assert.equal(logins(me).length, 1, "the next time it asks for the code, and does not try a key it no longer has");
    assert.ok(second);
  });
});

test("P14 devices: the Security page lists the remembered devices with the one in hand marked, revokes one or all after a question, and a revoked device is signed out at once", async () => {
  await withServer(async (server) => {
    const me = await profileOf(server);
    const tab = await signInWith(me, server, { remember: true });
    const other = await profileOf(server);
    const second = await signInWith(other, server, { remember: true });
    // The list is read again when the page is opened: the device that was remembered meanwhile is there.
    tab.location.hash = "#/security";
    await tab.fire("hashchange");
    await until(() => dataRows(tab, "device-rows").length === 2);
    const rows = dataRows(tab, "device-rows");
    assert.equal(rows.length, 2);
    const text = rows.map((row) => row.textContent);
    assert.equal(text.filter((entry) => /This device/.test(entry)).length, 1, "one is marked as this device");
    assert.ok(text.every((entry) => /Remembered since/.test(entry) === false), "the labels are the column names, not text of the row");
    assert.match(text[0], /Unknown browser|Chrome|Firefox|Safari|Edge/, "a name of the browser");
    const labels = rows[0].find((node) => node.tagName === "TD").map((node) => node.getAttribute("data-label"));
    assert.deepEqual(labels, ["Remembered since", "Last used", "Actions"], "and a phone reads each value with its label");
    const revokeButtons = rows.map((row) => row.find((node) => node.tagName === "BUTTON")[0]);
    assert.ok(revokeButtons.every((button) => /^Revoke: /.test(button.getAttribute("aria-label"))), "each button says which device");
    assert.ok(revokeButtons.every((button) => button.textContent === "Revoke" && button.getAttribute("aria-label").startsWith(button.textContent)), "and its name contains what it shows");

    // A question first: no is no.
    const asked = [];
    const careful = await me.open({ hash: "#/security", confirm: (question) => { asked.push(question); return false; } });
    await waitSignedIn(careful);
    await until(() => dataRows(careful, "device-rows").length === 2);
    await careful.$("devices-revoke-all").click();
    assert.equal(asked.length, 1);
    assert.match(asked[0], /Revoke every remembered device/);
    assert.equal(server.auth.listDevices().length, 2, "nothing was revoked");

    // Revoking the other device: it is gone from the list, and its own page is signed out when it next speaks.
    const theirs = rows.find((row) => !/This device/.test(row.textContent)).find((node) => node.tagName === "BUTTON")[0];
    await theirs.click();
    await until(() => dataRows(tab, "device-rows").length === 1);
    assert.match(tab.$("toast").textContent, /Device revoked/);
    assert.equal(server.auth.listDevices().length, 1);
    other.jar.cookie = undefined;
    const theirsAgain = await other.open();
    await waitLogin(theirsAgain);
    assert.equal(other.local.getItem(deviceKey(server)), null, "its key was refused and is deleted");

    // Revoking this device is signing out of it.
    const mine = dataRows(tab, "device-rows")[0].find((node) => node.tagName === "BUTTON")[0];
    await mine.click();
    await waitLogin(tab);
    assert.equal(tab.$("login-error").textContent, "This device was revoked: sign in with the admin code.");
    assert.equal(me.local.getItem(deviceKey(server)), null);
    assert.deepEqual(server.auth.listDevices(), []);
    assert.ok(second);
  });
});

test("P14 devices: revoking all devices from a device signs it out too; from a browser that was not remembered it keeps the session", async () => {
  await withServer(async (server) => {
    const remembered = await profileOf(server);
    const first = await signInWith(remembered, server, { remember: true });
    const plain = await profileOf(server);
    const owner = await signInWith(plain, server, { remember: false });
    owner.location.hash = "#/security";
    await owner.fire("hashchange");
    await until(() => dataRows(owner, "device-rows").length === 1);
    await owner.$("devices-revoke-all").click();
    await until(() => /No device is remembered/.test(owner.$("device-rows").textContent));
    assert.equal(signedIn(owner), true, "the browser that was not remembered is still in");
    assert.match(owner.$("toast").textContent, /1 device revoked/);
    assert.equal(owner.$("devices-revoke-all").disabled, true, "nothing left to revoke");
    remembered.jar.cookie = undefined;
    const again = await remembered.open();
    await waitLogin(again);
    assert.ok(first);
  });
});

test("P14 devices: changing the admin code from the page signs it out, forgets its key, and shows the new code once; another device's key is dead too", async () => {
  await withServer(async (server) => {
    const me = await profileOf(server);
    const tab = await signInWith(me, server, { remember: true });
    const other = await profileOf(server);
    await signInWith(other, server, { remember: true });
    tab.location.hash = "#/security";
    await tab.fire("hashchange");
    await tab.$("code-rotate").click();
    await waitLogin(tab);
    assert.match(tab.$("new-code").textContent, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(tab.$("new-code-box").classList.contains("hidden"), false);
    assert.equal(me.local.getItem(deviceKey(server)), null, "its key is forgotten with the old code");
    assert.deepEqual(server.auth.listDevices(), [], "and the server revoked every device");
    other.jar.cookie = undefined;
    const theirs = await other.open();
    await waitLogin(theirs);
    assert.equal(other.local.getItem(deviceKey(server)), null);
  });
});

test("P14 pages: each page has its own address, its own title and one heading; going back and forward changes the page; an address that is no page is ignored", async () => {
  await withServer(async (server) => {
    const me = await profileOf(server);
    const tab = await signInWith(me, server, { remember: false });
    const routes = ["overview", "books", "updates", "clients", "apps", "ai", "network", "log", "security"];
    const titles = { overview: "Overview", books: "Books and runs", updates: "Updates", clients: "Clients", apps: "Connected apps", ai: "AI and spending", network: "Network", log: "Action log", security: "Security" };
    const shown = () => routes.filter((id) => !tab.$(`page-${id}`).classList.contains("hidden"));
    assert.deepEqual(shown(), ["overview"], "the first page is the overview");
    assert.equal(tab.document.title, "Overview · Narrarium server");
    assert.equal(tab.$("nav-overview").getAttribute("aria-current"), "page");
    let current = "overview";
    for (const id of routes) {
      tab.location.hash = `#/${id}`;
      await tab.fire("hashchange");
      assert.deepEqual(shown(), [id], `#/${id}: that page and no other`);
      assert.equal(tab.document.title, `${titles[id]} · Narrarium server`, `#/${id}: the title of the page`);
      assert.equal(tab.$(`title-${id}`).textContent, titles[id], `#/${id}: its heading says it`);
      assert.deepEqual(routes.filter((other) => tab.$(`nav-${other}`).getAttribute("aria-current") === "page"), [id], `#/${id}: the navigation marks the page that is open, and only it`);
      if (id !== current) assert.equal(tab.$(`title-${id}`).focused, true, `#/${id}: the heading takes the focus, so a screen reader says where it is`);
      tab.$(`title-${id}`).focused = false;
      current = id;
    }
    assert.ok(tab.scrolls.length >= routes.length, "and the page starts at its top");
    // Back and forward are the same thing: the address changes.
    tab.location.hash = "#/books";
    await tab.fire("hashchange");
    assert.deepEqual(shown(), ["books"]);
    tab.location.hash = "#/main";
    await tab.fire("hashchange");
    assert.deepEqual(shown(), ["books"], "the address of the skip link is not a page: the page stays");
    tab.location.hash = "#/nowhere";
    await tab.fire("hashchange");
    assert.deepEqual(shown(), ["books"], "neither is one that does not exist");
    // A bookmark: opened on an address, the panel shows that page once it has signed in.
    const bookmarked = await me.open({ hash: "#/log" });
    await waitSignedIn(bookmarked);
    assert.deepEqual(routes.filter((id) => !bookmarked.$(`page-${id}`).classList.contains("hidden")), ["log"], "a reload on #/log is the log");
    assert.equal(bookmarked.document.title, "Action log · Narrarium server");
    // The language follows the page, in the title too.
    await bookmarked.$("lang").click();
    assert.equal(bookmarked.document.title, "Registro delle azioni · Server Narrarium");
    assert.equal(bookmarked.$("nav-log").getAttribute("href"), "#/log");
  });
});

test("P14 pages: the navigation says what needs a look: attention, running books, an update, a client that waits, an endpoint that waits and risks, each as a number with words for a screen reader", async () => {
  await withServer(async (server, client) => {
    const me = await profileOf(server);
    const tab = await signInWith(me, server, { remember: false });
    await until(() => !tab.$("badge-security").classList.contains("hidden"), 15_000);
    const badge = (id) => tab.$(`badge-${id}`);
    assert.equal(badge("security").classList.contains("hidden"), false, "the usual test server has a client that can run and no limit: a risk to review");
    const spoken = badge("security").find((node) => node.className === "sr-only")[0].textContent;
    assert.match(spoken, /^\d+ risks? to review$/, "the number comes with words");
    assert.equal(badge("security").find((node) => node.getAttribute("aria-hidden") === "true").length, 1, "and the number itself is not read twice");
    assert.equal(badge("books").classList.contains("hidden"), true, "no book is running: no number");
    assert.ok(client);
  });
});

test("P14 pages: what was on the pages goes with the session: a token that was shown once is not in the page after signing out", async () => {
  await withServer(async (server) => {
    const me = await profileOf(server);
    const tab = await signInWith(me, server, { remember: false });
    tab.$("token-label").value = "Laptop";
    await tab.$("token-form").dispatch("submit");
    await until(() => /^nrs_/.test(tab.$("token-value").textContent));
    assert.equal(tab.$("token-box").classList.contains("hidden"), false, "shown once, with its box");
    await until(() => tab.$("client-rows").textContent.includes("Laptop"));
    await tab.$("logout").click();
    await waitLogin(tab);
    assert.equal(tab.$("token-value").textContent, "");
    assert.equal(tab.$("token-box").classList.contains("hidden"), true);
    assert.equal(tab.$("client-rows").textContent, "", "nor the clients");
    assert.equal(tab.$("facts").textContent, "", "nor the facts of the server");
  });
});
