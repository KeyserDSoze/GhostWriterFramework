import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createChapter, createParagraph, initializeBookRepo } from "narrarium";
import { buildReaderOutput } from "../cli-dist/lib/reader-build.js";
import { READER_RELOAD_PARAM, decideFreshness, versionCheckUrl, withoutReloadParam } from "../cli-dist/lib/reader-freshness.js";
import { openReaderSession, readerStorageKeys } from "../cli-dist/lib/reader-session.js";

const BASE = "https://ada.github.io/glass-harbor/";

test("version.json is asked under an address no cache has seen, relative to the site", () => {
  const first = versionCheckUrl(BASE, 1000);
  const second = versionCheckUrl(BASE, 1001);
  assert.equal(first, "https://ada.github.io/glass-harbor/version.json?t=1000");
  assert.notEqual(first, second);
});

test("the shell reloads once for a new version, never twice, and never for its own", () => {
  assert.deepEqual(decideFreshness({ shellVersion: "a", latestVersion: "a", reloadedFor: null, href: BASE }), { action: "current" });
  const reload = decideFreshness({ shellVersion: "a", latestVersion: "b", reloadedFor: null, href: `${BASE}#chapter-2` });
  assert.equal(reload.action, "reload");
  assert.equal(reload.url, `${BASE}?${READER_RELOAD_PARAM}=b#chapter-2`);
  assert.deepEqual(decideFreshness({ shellVersion: "a", latestVersion: "b", reloadedFor: "b", href: BASE }), { action: "stale-shell" });
  assert.equal(decideFreshness({ shellVersion: "a", latestVersion: "c", reloadedFor: "b", href: BASE }).action, "reload", "a newer version again earns one reload");
  assert.equal(withoutReloadParam(`${BASE}?${READER_RELOAD_PARAM}=b#x`), `${BASE}#x`);
  assert.equal(withoutReloadParam(BASE), null);
});

function memoryStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

/** A site that serves one build; `online: false` makes version.json unreachable. */
function site(build, options = {}) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    const address = new URL(String(url));
    const relative = address.pathname.replace(/^\/glass-harbor\//, "");
    if (relative === "version.json") {
      if (options.online === false) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(options.versionFile ?? build.versionFile), { status: 200 });
    }
    const bytes = (options.files ?? build.files).get(relative);
    return bytes ? new Response(bytes, { status: 200 }) : new Response("missing", { status: 404 });
  };
  return { fetch, requests };
}

function deps(fetch, local, session, href = BASE) {
  const replaced = [];
  return { fetch, local, session, href, baseHref: BASE, replaceLocation: (url) => replaced.push(url), replaced, now: () => 42 };
}

function boot(build) {
  return { version: build.version, bookId: build.bookId, fallback: build.versionFile };
}

/** A prompt that answers from a list and records why it was shown. */
function promptFrom(answers) {
  const reasons = [];
  const prompt = async (reason) => {
    reasons.push(reason);
    const next = answers.shift();
    if (!next) throw new Error(`no answer left for «${reason}»`);
    return next;
  };
  return { prompt, reasons };
}

let bookRoot;
test.before(async () => {
  bookRoot = await mkdtemp(path.join(os.tmpdir(), "narrarium-reader-session-"));
  await initializeBookRepo(bookRoot, { title: "The Glass Harbor", language: "en" });
  await createChapter(bookRoot, { number: 1, title: "Lanterns" });
  await createParagraph(bookRoot, { chapter: "001-lanterns", number: 1, title: "The Quay", body: "The lanterns of the quay burned green." });
});
test.after(async () => {
  if (bookRoot) await rm(bookRoot, { recursive: true, force: true });
});

const build = (passwords) => buildReaderOutput({ bookRoot, bookId: "github-7", includeEpub: false, passwords: passwords.map((password, index) => ({ name: `P${index}`, password })) });

test("a public book opens without a prompt; version.json is fetched with no-store", async () => {
  const published = await build([]);
  const { fetch, requests } = site(published);
  const { prompt, reasons } = promptFrom([]);
  const result = await openReaderSession(boot(published), deps(fetch, memoryStorage(), memoryStorage()), prompt);
  assert.equal(result.kind, "open");
  assert.equal(result.bundle.chapters[0].scenes[0].title, "The Quay");
  assert.deepEqual(reasons, []);
  const check = requests.find((request) => request.url.includes("version.json"));
  assert.equal(check.init.cache, "no-store");
  assert.match(check.url, /version\.json\?t=42$/);
  assert.ok(requests.some((request) => request.url.endsWith(published.versionFile.bundle.path)), "the bundle is fetched by its hashed name");
});

test("the first open asks the password, keeps asking on a wrong one, and remembers the right one with its slot", async () => {
  const published = await build(["first one", "second one"]);
  const local = memoryStorage();
  const { prompt, reasons } = promptFrom([{ password: "nope", remember: true }, { password: "second one", remember: true }]);
  const result = await openReaderSession(boot(published), deps(site(published).fetch, local, memoryStorage()), prompt);
  assert.equal(result.kind, "open");
  assert.deepEqual(reasons, ["first", "wrong"]);
  const keys = readerStorageKeys("github-7");
  assert.equal(local.getItem(keys.password), "second one", "the password is kept in plain text, as the owner asked");
  assert.equal(local.getItem(keys.slot), "1");
});

test("a password the reader chose not to remember is not kept", async () => {
  const published = await build(["only one"]);
  const local = memoryStorage();
  const { prompt } = promptFrom([{ password: "only one", remember: false }]);
  assert.equal((await openReaderSession(boot(published), deps(site(published).fetch, local, memoryStorage()), prompt)).kind, "open");
  assert.equal(local.map.size, 0);
});

test("the remembered password is checked against the CURRENT slots on every open: valid, it opens without a prompt", async () => {
  const published = await build(["first one", "second one"]);
  const keys = readerStorageKeys("github-7");
  const local = memoryStorage({ [keys.password]: "first one", [keys.slot]: "0" });
  const { prompt, reasons } = promptFrom([]);
  const result = await openReaderSession(boot(published), deps(site(published).fetch, local, memoryStorage()), prompt);
  assert.equal(result.kind, "open");
  assert.deepEqual(reasons, []);
});

test("a remembered password removed from the list is forgotten and the reader is told it is no longer valid", async () => {
  const before = await build(["first one", "second one"]);
  const after = await build(["first one"]);
  const keys = readerStorageKeys("github-7");
  const local = memoryStorage({ [keys.password]: "second one", [keys.slot]: "1", "narrarium-reader-aes-key": "old" });
  const { prompt, reasons } = promptFrom([{ password: "first one", remember: true }]);
  const result = await openReaderSession(boot(after), deps(site(after).fetch, local, memoryStorage()), prompt);
  assert.equal(result.kind, "open");
  assert.deepEqual(reasons, ["revoked"]);
  assert.equal(local.getItem(keys.password), "first one");
  assert.equal(local.getItem("narrarium-reader-aes-key"), null, "the old reader's stored key is removed");
  assert.ok(before.version !== after.version);
});

test("offline, a remembered password the shell's own slots refuse is kept: it cannot be checked against the current ones", async () => {
  const published = await build(["current one"]);
  const keys = readerStorageKeys("github-7");
  const local = memoryStorage({ [keys.password]: "maybe newer" });
  const { prompt, reasons } = promptFrom([{ password: "current one", remember: false }]);
  const result = await openReaderSession(boot(published), deps(site(published, { online: false }).fetch, local, memoryStorage()), prompt);
  assert.equal(result.kind, "open");
  assert.equal(result.online, false);
  assert.deepEqual(reasons, ["unverified"]);
  assert.equal(local.getItem(keys.password), null, "answering without «remember» replaces it with nothing");
});

test("an old shell reloads ONCE under a new address, then reads the current book even if the HTML is still old", async () => {
  const oldBuild = await build([]);
  await createParagraph(bookRoot, { chapter: "001-lanterns", number: 2, title: "The Gate", body: "A new scene." });
  const newBuild = await build([]);
  assert.notEqual(oldBuild.version, newBuild.version);
  const session = memoryStorage();
  const first = deps(site(newBuild).fetch, memoryStorage(), session);
  const result = await openReaderSession(boot(oldBuild), first, promptFrom([]).prompt);
  assert.equal(result.kind, "reloading");
  assert.deepEqual(first.replaced, [`${BASE}?${READER_RELOAD_PARAM}=${newBuild.version}`]);

  // The reload came back with the old HTML again (a cache that ignores the query): no second reload, the new bundle all the same.
  const second = deps(site(newBuild).fetch, memoryStorage(), session, first.replaced[0]);
  const again = await openReaderSession(boot(oldBuild), second, promptFrom([]).prompt);
  assert.equal(again.kind, "open");
  assert.equal(again.staleShell, true);
  assert.deepEqual(second.replaced, []);
  assert.equal(again.bundle.chapters[0].scenes.length, 2, "the current content");
});
