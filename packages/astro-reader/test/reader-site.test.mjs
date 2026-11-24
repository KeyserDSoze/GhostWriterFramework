import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapContentKey, openBundle } from "../cli-dist/lib/reader-unlock.js";
import { appendFile } from "node:fs/promises";
import { MARKERS, buildReaderSite, createSampleBook, launchChromium, serveSite, startDevServer } from "./helpers/reader-site.mjs";

/**
 * Real builds of the reader (astro build, in a process of its own) for a sample book: public, protected by two passwords, and protected
 * again after one of the two was removed. The published files are checked, then opened in Chromium through a server that behaves like
 * GitHub Pages for a project site.
 */

const PASSWORDS = { first: "Zebra-Ocelot-9431", second: "piano verde 77" };
const SECRETS_JSON = JSON.stringify({ github_token: "ghs_RUN_TOKEN_SHOULD_NEVER_APPEAR_123", READER_PASSWORD_001: PASSWORDS.first, READER_PASSWORD_002: PASSWORDS.second, OTHER_SECRET: "other-secret-value-xyz" });

let bookRoot;
const builds = {};

async function filesOf(dir, prefix = "") {
  const entries = await readdir(path.join(dir, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await filesOf(dir, relative)));
    else files.push(relative);
  }
  return files.sort();
}

async function readAll(dir) {
  return Promise.all((await filesOf(dir)).map(async (file) => ({ file, bytes: await readFile(path.join(dir, file)) })));
}

test.before(async () => {
  bookRoot = await mkdtemp(path.join(os.tmpdir(), "narrarium-reader-site-"));
  await createSampleBook(bookRoot);
  builds.public = await buildReaderSite({ bookRoot, name: "public" });
  builds.protected = await buildReaderSite({ bookRoot, name: "protected", env: { READER_PASSWORD_SECRETS: "READER_PASSWORD_001,READER_PASSWORD_002", NARRARIUM_READER_SECRETS: SECRETS_JSON } });
  builds.revoked = await buildReaderSite({ bookRoot, name: "revoked", env: { READER_PASSWORD_SECRETS: "READER_PASSWORD_001", NARRARIUM_READER_SECRETS: SECRETS_JSON } });
  for (const [name, build] of Object.entries(builds)) assert.equal(build.code, 0, `${name} build failed:\n${build.output}`);
});

test.after(async () => {
  if (bookRoot) await rm(bookRoot, { recursive: true, force: true });
  for (const build of Object.values(builds)) await rm(build.outDir, { recursive: true, force: true });
});

test("the shell of a public build holds no content: no line, no chapter and no scene title, no service worker", async () => {
  const dir = builds.public.outDir;
  const shell = await readFile(path.join(dir, "index.html"), "utf8");
  for (const marker of [MARKERS.firstScene, MARKERS.secondScene, MARKERS.thirdScene, ...MARKERS.chapterTitles, ...MARKERS.sceneTitles]) {
    assert.ok(!shell.includes(marker), `the shell holds «${marker}»`);
  }
  assert.ok(shell.includes("The Glass Harbor"), "the title is the shell's");
  for (const { file, bytes } of await readAll(dir)) {
    if (!file.startsWith("_astro/")) continue;
    const text = bytes.toString("utf8");
    for (const marker of [MARKERS.firstScene, ...MARKERS.chapterTitles]) assert.ok(!text.includes(marker), `${file} holds «${marker}»`);
    assert.doesNotMatch(text, /serviceWorker\s*\.\s*register/, `${file} registers a service worker`);
  }
  const version = JSON.parse(await readFile(path.join(dir, "version.json"), "utf8"));
  assert.equal(version.protected, false);
  assert.match(version.bundle.path, /^content\/book-[0-9a-f]{16}\.json$/);
  const bundle = await readFile(path.join(dir, version.bundle.path), "utf8");
  assert.ok(bundle.includes("QUAYMARKER"), "the content is in the hashed bundle");
  assert.ok(shell.includes(`data-reader-version="${version.version}"`), "the shell knows its own version");
  const files = await filesOf(dir);
  assert.ok(files.includes("book/index.html") && files.includes("characters/index.html"), "a public book keeps its canon pages");
});

test("a protected build publishes only the shell, version.json and encrypted files: no line, title, name, password or secret in clear", async () => {
  const dir = builds.protected.outDir;
  const files = await filesOf(dir);
  for (const file of files) assert.match(file, /^(index\.html|version\.json|_astro\/[^/]+\.(js|css)|content\/[a-z]+-[0-9a-f]{16}\.bin)$/, `${file} is published`);
  assert.ok(!files.some((file) => file.startsWith("downloads/")), "no EPUB in clear");
  const forbidden = [
    MARKERS.firstScene, MARKERS.secondScene, MARKERS.thirdScene, "QUAYMARKER", "TIDEMARKER", "GATEMARKER", ...MARKERS.chapterTitles, ...MARKERS.sceneTitles, MARKERS.character,
    PASSWORDS.first, PASSWORDS.second, "ghs_RUN_TOKEN", "other-secret-value",
    Buffer.from(PASSWORDS.first).toString("base64"), Buffer.from(PASSWORDS.second).toString("base64"), Buffer.from(PASSWORDS.first).toString("hex"),
  ];
  for (const { file, bytes } of await readAll(dir)) {
    for (const needle of forbidden) assert.ok(bytes.indexOf(Buffer.from(needle)) < 0, `${file} holds «${needle}»`);
  }
  const version = JSON.parse(await readFile(path.join(dir, "version.json"), "utf8"));
  assert.equal(version.protected, true);
  assert.equal(version.protection.slots.length, 2);
  assert.ok(version.protection.iterations >= 600_000);
  // The build log names the secrets it used, never a value.
  assert.match(builds.protected.output, /Protected with 2 passwords \(READER_PASSWORD_001, READER_PASSWORD_002\)/);
  for (const needle of [PASSWORDS.first, PASSWORDS.second, "ghs_RUN_TOKEN", "other-secret-value"]) assert.ok(!builds.protected.output.includes(needle), `the log holds «${needle}»`);
  // Both passwords open what was published, with the browser's own code.
  for (const password of Object.values(PASSWORDS)) {
    const unlocked = await unwrapContentKey(password, version.protection);
    assert.ok(unlocked, password);
    const json = JSON.parse(await openBundle(unlocked.key, await readFile(path.join(dir, version.bundle.path))));
    assert.equal(json.chapters[0].scenes[0].title, MARKERS.sceneTitles[0]);
  }
});

test("a password removed from the list does not open the next build", async () => {
  const before = JSON.parse(await readFile(path.join(builds.protected.outDir, "version.json"), "utf8"));
  const after = JSON.parse(await readFile(path.join(builds.revoked.outDir, "version.json"), "utf8"));
  assert.notEqual(before.version, after.version);
  assert.equal(after.protection.slots.length, 1);
  assert.equal(await unwrapContentKey(PASSWORDS.second, after.protection), null);
  assert.ok(await unwrapContentKey(PASSWORDS.first, after.protection));
});

test("a list of passwords without the secrets stops the build: the book is never published in clear by mistake", async () => {
  const failed = await buildReaderSite({ bookRoot, name: "missing-secrets", env: { READER_PASSWORD_SECRETS: "READER_PASSWORD_001" } });
  try {
    assert.notEqual(failed.code, 0);
    assert.match(failed.output, /READER_PASSWORD_001/);
    assert.match(failed.output, /NARRARIUM_READER_SECRETS/);
  } finally {
    await rm(failed.outDir, { recursive: true, force: true });
  }
});

test("astro dev serves the shell, version.json and the hashed bundle, and a new bundle when the book changes", async () => {
  const devRoot = await mkdtemp(path.join(os.tmpdir(), "narrarium-reader-dev-"));
  await createSampleBook(devRoot, { extraParagraphs: 1 });
  const dev = await startDevServer({ bookRoot: devRoot });
  try {
    const shell = await (await fetch(dev.url)).text();
    assert.match(shell, /data-reader-version="[0-9a-f]{16}"/);
    const first = await (await fetch(`${dev.url}version.json`)).json();
    const bundle = await fetch(`${dev.url}${first.bundle.path}`);
    assert.equal(bundle.status, 200, `${first.bundle.path}: ${dev.output()}`);
    assert.match(await bundle.text(), /QUAYMARKER/);
    assert.equal((await fetch(`${dev.url}${first.epub.path}`)).status, 200);
    assert.equal((await fetch(`${dev.url}book/`)).status, 200, "the canon pages are there in dev");

    await appendFile(path.join(devRoot, "chapters", "001-lanterns-over-water", "001-the-quay-at-dusk.md"), "\nDEVMARKER a line written while the server runs.\n");
    let next = first;
    for (let attempt = 0; attempt < 60 && next.version === first.version; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      next = await (await fetch(`${dev.url}version.json`)).json();
    }
    assert.notEqual(next.version, first.version);
    const changed = await fetch(`${dev.url}${next.bundle.path}`);
    assert.equal(changed.status, 200, "the new name is served (the dev route cache was cleared)");
    assert.match(await changed.text(), /DEVMARKER/);
  } finally {
    await dev.stop();
    await rm(devRoot, { recursive: true, force: true });
  }
});

// ── In the browser ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

let browser;
let server;

test.describe("in Chromium", () => {
  test.before(async () => {
    browser = await launchChromium();
    server = await serveSite();
  });
  test.after(async () => {
    if (browser && !browser.unavailable) await browser.close();
    if (server) await server.close();
  });

  async function newPage(t, viewport = { width: 390, height: 844 }) {
    if (browser.unavailable) {
      t.skip(`Chromium is not installed here (${browser.unavailable}); run npm run e2e:install at the root.`);
      return null;
    }
    const context = await browser.newContext({ viewport });
    await context.addInitScript(() => {
      const original = window.fetch.bind(window);
      window.__fetches = [];
      window.fetch = (input, init) => {
        window.__fetches.push({ url: String(input), cache: init?.cache ?? null });
        return original(input, init);
      };
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    return { context, page, errors };
  }

  test("a public book opens straight into the text, asking version.json with no-store and a fresh query", async (t) => {
    const opened = await newPage(t);
    if (!opened) return;
    const { page, context, errors } = opened;
    try {
      server.publish(builds.public.outDir);
      await page.goto(server.url);
      await page.waitForSelector("#reader-app:not([hidden])");
      assert.match(await page.textContent("#reader-text"), /QUAYMARKER/);
      const fetches = await page.evaluate(() => window.__fetches);
      const check = fetches.find((entry) => entry.url.includes("version.json"));
      assert.equal(check.cache, "no-store");
      assert.match(check.url, /version\.json\?t=\d+$/);
      assert.equal(await page.evaluate(async () => (await navigator.serviceWorker?.getRegistrations?.())?.length ?? 0), 0);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  test("a protected book: wrong password refused, right one opens and is remembered; once revoked, the reader is told and asked again", async (t) => {
    const opened = await newPage(t);
    if (!opened) return;
    const { page, context, errors } = opened;
    try {
      server.publish(builds.protected.outDir);
      await page.goto(server.url);
      await page.waitForSelector("#reader-lock:not([hidden])");
      assert.ok(await page.isHidden("#reader-app"));
      await page.fill("#reader-password", "not the password");
      await page.click("#reader-unlock");
      await page.waitForSelector("#reader-lock-message:not([hidden])");
      assert.match(await page.textContent("#reader-lock-message"), /does not open this book/);
      await page.fill("#reader-password", PASSWORDS.second);
      await page.click("#reader-unlock");
      await page.waitForSelector("#reader-app:not([hidden])");
      assert.match(await page.textContent("#reader-text"), /QUAYMARKER/);
      const stored = await page.evaluate(() => localStorage.getItem("narrarium-reader:test-book:password"));
      assert.equal(stored, PASSWORDS.second);

      await page.reload();
      await page.waitForSelector("#reader-app:not([hidden])");
      assert.ok(await page.isHidden("#reader-lock"), "the remembered password opened it without asking");

      // The owner removes the second password: the site is published again without its slot.
      server.publish(builds.revoked.outDir);
      await page.goto(server.url);
      await page.waitForSelector("#reader-lock:not([hidden])");
      assert.match(await page.textContent("#reader-lock-message"), /no longer valid/);
      assert.equal(await page.evaluate(() => localStorage.getItem("narrarium-reader:test-book:password")), null, "the revoked password is forgotten");
      await page.fill("#reader-password", PASSWORDS.first);
      await page.click("#reader-unlock");
      await page.waitForSelector("#reader-app:not([hidden])");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  test("an old shell kept by the cache reloads once onto the new version, then drops the query from the address", async (t) => {
    const opened = await newPage(t);
    if (!opened) return;
    const { page, context, errors } = opened;
    try {
      // A reader who knows the current password opens the book while only the previous HTML is served (a cache that kept it).
      await context.addInitScript((password) => localStorage.setItem("narrarium-reader:test-book:password", password), PASSWORDS.first);
      server.publish(builds.revoked.outDir);
      server.keepShellFrom(builds.protected.outDir);
      const navigations = [];
      page.on("framenavigated", (frame) => frame === page.mainFrame() && navigations.push(frame.url()));
      await page.goto(server.url);
      await page.waitForSelector("#reader-app:not([hidden])");
      const newVersion = JSON.parse(await readFile(path.join(builds.revoked.outDir, "version.json"), "utf8")).version;
      assert.ok(navigations.some((url) => url.includes(`nrv=${newVersion}`)), `reloaded onto ${newVersion}: ${navigations.join(", ")}`);
      assert.equal(navigations.filter((url) => url.includes("nrv=")).length, 1, "exactly one reload");
      assert.ok(!page.url().includes("nrv="), "the address is clean again");
      assert.match(await page.textContent("#reader-status"), /newer version of the reader/, "the old HTML came back even after the reload: said, and the current text is read anyway");
      assert.match(await page.textContent("#reader-text"), /QUAYMARKER/);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
});
