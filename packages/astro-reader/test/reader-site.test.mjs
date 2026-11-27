import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
let italianRoot;
const builds = {};

/**
 * The annotations of the in-app reader are saved in the book (annotations/, the site's format): they are the author's notes, and the online reader
 * never publishes them, in a public build or in a protected one.
 */
const ANNOTATION_MARKER = "ANNOTATIONMARKER";
async function addAnnotations(root) {
  await mkdir(path.join(root, "annotations", "chapters"), { recursive: true });
  await writeFile(path.join(root, "annotations", "chapters", "001-lanterns-over-water.yml"), [
    "version: 1",
    "chapter: chapter:001-lanterns-over-water",
    "annotations:",
    "  - id: a-mi4k2x1a-7f3k9q",
    "    paragraph: paragraph:001-lanterns-over-water:001-the-quay-at-dusk",
    "    quote: the lanterns of the quay burned green",
    "    prefix: 'QUAYMARKER '",
    "    suffix: ' and nobody looked up.'",
    "    offset: 11",
    "    tag: rewrite",
    `    comment: ${ANNOTATION_MARKER} the colour is too easy`,
    "    status: open",
    "    createdAt: 2026-11-25T10:00:00.000Z",
    "    updatedAt: 2026-11-25T10:00:00.000Z",
    "    createdOnDevice: d-1a2b3c4d",
    "",
  ].join("\n"));
  await writeFile(path.join(root, "annotations", "tags.yml"), ["version: 1", "tags:", "  - id: pace-k3x9", `    name: ${ANNOTATION_MARKER} pace`, "    description: The pace slows here.", "    mark: { underline: dotted, color: sky, icon: clock }", ""].join("\n"));
}

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
  await createSampleBook(bookRoot, { extraParagraphs: 10 });
  await addAnnotations(bookRoot);
  builds.public = await buildReaderSite({ bookRoot, name: "public" });
  builds.protected = await buildReaderSite({ bookRoot, name: "protected", env: { READER_PASSWORD_SECRETS: "READER_PASSWORD_001,READER_PASSWORD_002", NARRARIUM_READER_SECRETS: SECRETS_JSON } });
  // Workflow version 3: no JSON of the secrets, one variable for each slot, and the other secrets of the repository are not in the environment at all.
  builds.slots = await buildReaderSite({ bookRoot, name: "slots", env: { READER_PASSWORD_SECRETS: "READER_PASSWORD_001,READER_PASSWORD_002", READER_PASSWORD_001: PASSWORDS.first, READER_PASSWORD_002: PASSWORDS.second, READER_PASSWORD_003: "a slot nobody listed" } });
  builds.revoked = await buildReaderSite({ bookRoot, name: "revoked", env: { READER_PASSWORD_SECRETS: "READER_PASSWORD_001", NARRARIUM_READER_SECRETS: SECRETS_JSON } });
  italianRoot = await mkdtemp(path.join(os.tmpdir(), "narrarium-reader-site-it-"));
  await createSampleBook(italianRoot, { title: "Il Porto di Vetro", language: "it", extraParagraphs: 2 });
  builds.italian = await buildReaderSite({ bookRoot: italianRoot, name: "italian", base: "/porto/", env: { NARRARIUM_READER_PASSWORD: "aperto" } });
  for (const [name, build] of Object.entries(builds)) assert.equal(build.code, 0, `${name} build failed:\n${build.output}`);
});

test.after(async () => {
  if (bookRoot) await rm(bookRoot, { recursive: true, force: true });
  if (italianRoot) await rm(italianRoot, { recursive: true, force: true });
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

test("the annotations of the book are never published: no file of a public build holds them, nor the bundle of a protected one", async () => {
  for (const { file, bytes } of await readAll(builds.public.outDir)) assert.ok(bytes.indexOf(Buffer.from(ANNOTATION_MARKER)) < 0, `${file} holds an annotation`);
  const files = await filesOf(builds.public.outDir);
  assert.ok(!files.some((file) => /annotation/i.test(file)), "no published path is about annotations");
  const version = JSON.parse(await readFile(path.join(builds.protected.outDir, "version.json"), "utf8"));
  const unlocked = await unwrapContentKey(PASSWORDS.first, version.protection);
  const bundle = await openBundle(unlocked.key, await readFile(path.join(builds.protected.outDir, version.bundle.path)));
  assert.ok(bundle.includes("QUAYMARKER"), "the bundle was opened");
  assert.ok(!bundle.includes(ANNOTATION_MARKER), "the protected bundle holds an annotation");
});

test("a password removed from the list does not open the next build", async () => {
  const before = JSON.parse(await readFile(path.join(builds.protected.outDir, "version.json"), "utf8"));
  const after = JSON.parse(await readFile(path.join(builds.revoked.outDir, "version.json"), "utf8"));
  assert.notEqual(before.version, after.version);
  assert.equal(after.protection.slots.length, 1);
  assert.equal(await unwrapContentKey(PASSWORDS.second, after.protection), null);
  assert.ok(await unwrapContentKey(PASSWORDS.first, after.protection));
});

test("a build with the slots of workflow version 3 protects the book exactly as one with the JSON of version 2 does", async () => {
  const version = JSON.parse(await readFile(path.join(builds.slots.outDir, "version.json"), "utf8"));
  assert.equal(version.protected, true);
  assert.equal(version.protection.slots.length, 2);
  assert.match(builds.slots.output, /Protected with 2 passwords \(READER_PASSWORD_001, READER_PASSWORD_002\)/);
  for (const needle of [PASSWORDS.first, PASSWORDS.second, "a slot nobody listed"]) assert.ok(!builds.slots.output.includes(needle), `the log holds «${needle}»`);
  assert.ok(await unwrapContentKey(PASSWORDS.first, version.protection));
  assert.ok(await unwrapContentKey(PASSWORDS.second, version.protection));
  assert.equal(await unwrapContentKey("a slot nobody listed", version.protection), null);
  // No clear EPUB, as for the other protected build.
  await assert.rejects(readFile(path.join(builds.slots.outDir, "downloads", "book.epub")));
});

test("a list of passwords without the secrets stops the build: the book is never published in clear by mistake", async () => {
  const failed = await buildReaderSite({ bookRoot, name: "missing-secrets", env: { READER_PASSWORD_SECRETS: "READER_PASSWORD_001" } });
  try {
    assert.notEqual(failed.code, 0);
    assert.match(failed.output, /READER_PASSWORD_001/);
    assert.match(failed.output, /NARRARIUM_READER_SECRETS/);
    assert.match(failed.output, /READER_PASSWORD_001: \$\{\{ secrets\.READER_PASSWORD_001 \}\}/);
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

  /** Select characters [from, to) of a block of a scene, as a reader would with the mouse or a finger. */
  async function select(page, scene, block, from, to) {
    await page.evaluate(({ scene, block, from, to }) => {
      const element = document.querySelector(`[data-scene="${scene}"] [data-block="${block}"]`);
      element.scrollIntoView({ block: "center" });
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let offset = 0;
      const range = document.createRange();
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const end = offset + node.data.length;
        if (from >= offset && from <= end) range.setStart(node, from - offset);
        if (to >= offset && to <= end) {
          range.setEnd(node, to - offset);
          break;
        }
        offset = end;
      }
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }, { scene, block, from, to });
    await page.waitForSelector("#er-selection:not([hidden])");
  }

  test("several bookmarks are added, listed in book order, opened and deleted, and kept on the device", async (t) => {
    const opened = await newPage(t);
    if (!opened) return;
    const { page, context, errors } = opened;
    try {
      server.publish(builds.public.outDir);
      await page.goto(server.url);
      await page.waitForSelector("#reader-app:not([hidden])");
      assert.match(await page.textContent("#er-progress-text"), /Chapter 1 of 2 · 0%/);

      // A bookmark in chapter 2, then one at the top of chapter 1: the list puts chapter 1 first.
      await page.click("#er-next");
      await page.waitForFunction(() => document.querySelector("#er-chapter-title").textContent.includes("The Long Tide"));
      assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("ereader-chapter__title")), true, "the new chapter's title has the focus");
      await page.click("#er-bookmark");
      assert.equal(await page.getAttribute("#er-bookmark", "aria-pressed"), "true");
      await page.click("#er-open-contents");
      await page.waitForSelector("#er-contents[open]");
      assert.equal(await page.getAttribute("#er-toc button[aria-current='page']", "aria-current"), "page");
      await page.click("#er-toc > li:first-child > button");
      await page.waitForFunction(() => document.querySelector("#er-chapter-title").textContent.includes("Lanterns"));
      await page.evaluate(() => document.querySelector('[data-scene="002-low-water"] [data-block="0"]').scrollIntoView({ block: "start" }));
      await page.waitForTimeout(100);
      await page.click("#er-bookmark");
      const percent = Number((await page.textContent("#er-progress-text")).match(/(\d+)%/)[1]);
      assert.ok(percent > 0 && percent < 100, `progress ${percent}%`);
      assert.equal(await page.getAttribute("#er-progress", "aria-valuenow"), String(percent));

      await page.click("#er-open-notes");
      await page.waitForSelector("#er-notes[open]");
      const items = await page.locator("#er-bookmark-list .ereader-item__where").allTextContents();
      assert.deepEqual(items, ["Chapter 1 · Lanterns Over Water", "Chapter 2 · The Long Tide"]);
      assert.match(await page.locator("#er-bookmark-list .ereader-item__quote").first().textContent(), /TIDEMARKER/);
      // Open the chapter 2 bookmark from the list.
      await page.locator("#er-bookmark-list .ereader-item__go").nth(1).click();
      await page.waitForFunction(() => document.querySelector("#er-chapter-title").textContent.includes("The Long Tide"));
      assert.equal(await page.isVisible("#er-notes"), false);

      await page.reload();
      await page.waitForSelector("#reader-app:not([hidden])");
      assert.match(await page.textContent("#er-chapter-title"), /The Long Tide/, "the reading position is kept");
      await page.click("#er-open-notes");
      await page.waitForSelector("#er-notes[open]");
      assert.equal(await page.locator("#er-bookmark-list > li").count(), 2, "the bookmarks are kept");
      const deleteLabel = await page.locator("#er-bookmark-list > li").first().locator("button.ereader-text-button").getAttribute("aria-label");
      assert.match(deleteLabel, /^Delete the bookmark: Chapter 1/);
      await page.locator("#er-bookmark-list > li").first().locator("button.ereader-text-button").click();
      assert.equal(await page.locator("#er-bookmark-list > li").count(), 1);
      assert.equal(await page.evaluate(() => document.activeElement?.closest("#er-bookmark-list") !== null), true, "the focus stays in the list");
      const stored = JSON.parse(await page.evaluate(() => localStorage.getItem("narrarium-reader:test-book:bookmarks")));
      assert.equal(stored.items.length, 1);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  test("highlights and notes are anchored to a chapter, a scene and a paragraph, edited and deleted, and kept after a reload", async (t) => {
    const opened = await newPage(t);
    if (!opened) return;
    const { page, context, errors } = opened;
    try {
      server.publish(builds.public.outDir);
      await page.goto(server.url);
      await page.waitForSelector("#reader-app:not([hidden])");
      await select(page, "001-the-quay-at-dusk", 0, 11, 23);
      await page.click("#er-highlight");
      await page.waitForSelector("mark.ereader-mark");
      assert.equal(await page.textContent("mark.ereader-mark"), "the lanterns");

      await select(page, "002-low-water", 1, 0, 11);
      await page.click("#er-note");
      await page.waitForSelector("#er-note-dialog[open]");
      assert.equal(await page.textContent("#er-note-quote"), "Paragraph 1");
      assert.equal(await page.evaluate(() => document.activeElement?.id), "er-note-text");
      await page.fill("#er-note-text", "Why the gulls?");
      await page.click("#er-note-save");
      await page.waitForSelector('mark.ereader-mark[data-kind="note"]');

      const stored = JSON.parse(await page.evaluate(() => localStorage.getItem("narrarium-reader:test-book:annotations")));
      assert.deepEqual(stored.items.map((item) => ({ kind: item.kind, chapter: item.chapter, scene: item.scene, block: item.startBlock, quote: item.quote, note: item.note })), [
        { kind: "highlight", chapter: "001-lanterns-over-water", scene: "001-the-quay-at-dusk", block: 0, quote: "the lanterns", note: undefined },
        { kind: "note", chapter: "001-lanterns-over-water", scene: "002-low-water", block: 1, quote: "Paragraph 1", note: "Why the gulls?" },
      ]);

      await page.reload();
      await page.waitForSelector("#reader-app:not([hidden])");
      assert.equal(await page.locator("mark.ereader-mark").count(), 2, "both are drawn again");

      // Edit the note from the list, then delete the highlight from the text.
      await page.click("#er-open-notes");
      await page.waitForSelector("#er-notes[open]");
      assert.match(await page.textContent("#er-annotation-list"), /Why the gulls\?/);
      await page.locator("#er-annotation-list > li").nth(1).getByRole("button", { name: "Edit the note" }).click();
      await page.waitForSelector("#er-note-dialog[open]");
      await page.fill("#er-note-text", "The gulls write nothing down.");
      await page.click("#er-note-save");
      await page.waitForSelector("#er-notes[open]");
      assert.match(await page.textContent("#er-annotation-list"), /The gulls write nothing down\./);
      await page.keyboard.press("Escape");
      await page.click("mark.ereader-mark[data-kind='highlight']");
      await page.waitForSelector("#er-note-dialog[open]");
      await page.click("#er-note-delete");
      await page.waitForFunction(() => document.querySelectorAll("mark.ereader-mark").length === 1);

      // A note without selecting anything, from the keyboard: on the paragraph where the reader is.
      await page.click("#er-open-notes");
      await page.waitForSelector("#er-notes[open]");
      await page.click("#er-note-here");
      await page.waitForSelector("#er-note-dialog[open]");
      await page.keyboard.type("A note from the keyboard.");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
      await page.waitForSelector("#er-notes[open]");
      assert.match(await page.textContent("#er-annotation-list"), /A note from the keyboard\./);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  test("settings: theme, text and pages; the keyboard and a swipe turn the pages; everything is kept", async (t) => {
    const opened = await newPage(t, { width: 390, height: 700 });
    if (!opened) return;
    const { page, context, errors } = opened;
    try {
      server.publish(builds.public.outDir);
      await page.goto(server.url);
      await page.waitForSelector("#reader-app:not([hidden])");
      const size = () => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".ereader-scene__text p")).fontSize));
      const before = await size();
      await page.click("#er-open-settings");
      await page.waitForSelector("#er-settings[open]");
      await page.check("#er-theme-sepia");
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "sepia");
      await page.click("[data-step='size'][data-direction='1']");
      await page.click("[data-step='size'][data-direction='1']");
      assert.equal(await page.textContent("#er-size-value"), "125%");
      assert.ok((await size()) > before);
      await page.check("#er-font-sans");
      await page.check("#er-mode-paged");
      await page.keyboard.press("Escape");
      assert.equal(await page.evaluate(() => document.activeElement?.id), "er-open-settings", "the focus goes back to the button that opened the settings");
      assert.equal(await page.getAttribute("#reader-app", "data-mode"), "paged");
      const pageText = () => page.textContent("#er-page-text");
      assert.match(await pageText(), /Page 1 of (\d+)/);
      const pages = Number((await pageText()).match(/of (\d+)/)[1]);
      assert.ok(pages >= 3, `${pages} pages`);
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(() => /Page 2 of/.test(document.querySelector("#er-page-text").textContent));
      await page.keyboard.press("End");
      await page.waitForFunction((count) => document.querySelector("#er-page-text").textContent.includes(`Page ${count} of`), pages);
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(() => document.querySelector("#er-chapter-title").textContent.includes("The Long Tide"));
      await page.keyboard.press("ArrowLeft");
      await page.waitForFunction(() => document.querySelector("#er-chapter-title").textContent.includes("Lanterns"));
      assert.match(await pageText(), new RegExp(`Page ${pages} of ${pages}`), "back from chapter 2 lands on the last page of chapter 1");
      // A swipe of a finger to the left turns the page forward, to the right backward.
      const swipe = (from, to) => page.evaluate(({ from, to }) => {
        const viewport = document.querySelector("#reader-text");
        viewport.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch", clientX: from, clientY: 300, bubbles: true }));
        viewport.dispatchEvent(new PointerEvent("pointerup", { pointerType: "touch", clientX: to, clientY: 310, bubbles: true }));
      }, { from, to });
      await swipe(80, 320);
      await page.waitForFunction((count) => document.querySelector("#er-page-text").textContent.includes(`Page ${count - 1} of`), pages);
      await swipe(320, 80);
      await page.waitForFunction((count) => document.querySelector("#er-page-text").textContent.includes(`Page ${count} of`), pages);

      await page.reload();
      await page.waitForSelector("#reader-app:not([hidden])");
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "sepia");
      assert.equal(await page.getAttribute("#reader-app", "data-mode"), "paged");
      assert.match(await pageText(), new RegExp(`Page ${pages} of ${pages}`), "the page is kept");
      const prefs = JSON.parse(await page.evaluate(() => localStorage.getItem("narrarium-reader:test-book:prefs")));
      assert.deepEqual({ theme: prefs.theme, font: prefs.font, mode: prefs.mode, size: prefs.size }, { theme: "sepia", font: "sans", mode: "paged", size: 4 });
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  test("accessibility: names, languages, focus, reduced motion, and no sideways scrolling at 320 CSS px with the largest text", async (t) => {
    if (browser.unavailable) return t.skip("Chromium is not installed here.");
    const context = await browser.newContext({ viewport: { width: 320, height: 640 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      server.publish(builds.public.outDir);
      await page.addInitScript(() => localStorage.setItem("narrarium-reader:test-book:prefs", JSON.stringify({ v: 1, size: 8, leading: 5 })));
      await page.goto(server.url);
      await page.waitForSelector("#reader-app:not([hidden])");
      const report = await page.evaluate(() => {
        const visible = (element) => element.offsetParent !== null || getComputedStyle(element).position === "fixed";
        const unnamed = [...document.querySelectorAll("button, a[href], input, select, textarea, [role='progressbar']")]
          .filter((element) => visible(element) || element.closest("dialog"))
          .filter((element) => {
            const label = element.getAttribute("aria-label") || element.textContent.trim() || (element.id && document.querySelector(`label[for="${element.id}"]`)?.textContent.trim()) || element.closest("label")?.textContent.trim();
            return !label;
          })
          .map((element) => element.outerHTML.slice(0, 80));
        const dialogs = [...document.querySelectorAll("dialog")].filter((dialog) => !document.getElementById(dialog.getAttribute("aria-labelledby") ?? "")?.textContent.trim()).map((dialog) => dialog.id);
        return {
          unnamed,
          dialogs,
          lang: document.documentElement.lang,
          textLang: document.querySelector("main").lang,
          sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          fontSize: getComputedStyle(document.querySelector(".ereader-scene__text p")).fontSize,
          reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
          smallTargets: [...document.querySelectorAll(".ereader-bar button")].filter((button) => { const box = button.getBoundingClientRect(); return box.width < 24 || box.height < 24; }).length,
        };
      });
      assert.deepEqual(report.unnamed, [], "every control has a name");
      assert.deepEqual(report.dialogs, [], "every dialog has a title");
      assert.equal(report.lang, "en");
      assert.equal(report.textLang, "en");
      assert.equal(report.fontSize, "36px", "the largest text: 200%");
      assert.ok(report.sideways <= 0, `the page scrolls sideways by ${report.sideways}px`);
      assert.equal(report.reduced, true);
      assert.equal(report.smallTargets, 0, "targets of at least 24 by 24 CSS px");
      // Keyboard: Tab reaches the bar, a dialog opens and closes with the keyboard and gives the focus back.
      await page.focus("#er-open-contents");
      await page.keyboard.press("Enter");
      await page.waitForSelector("#er-contents[open]");
      await page.keyboard.press("Escape");
      assert.equal(await page.evaluate(() => document.activeElement?.id), "er-open-contents");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  test("an Italian book speaks Italian: the lock, the bars and the dialogs", async (t) => {
    if (browser.unavailable) return t.skip("Chromium is not installed here.");
    const italianServer = await serveSite("/porto/");
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    try {
      italianServer.publish(builds.italian.outDir);
      await page.goto(italianServer.url);
      await page.waitForSelector("#reader-lock:not([hidden])");
      assert.equal(await page.evaluate(() => document.documentElement.lang), "it");
      assert.equal(await page.textContent("#reader-lock-title"), "Questo libro è protetto");
      await page.fill("#reader-password", "aperto");
      await page.click("#reader-unlock");
      await page.waitForSelector("#reader-app:not([hidden])");
      assert.match(await page.textContent("#er-progress-text"), /Capitolo 1 di 2/);
      assert.equal(await page.getAttribute("#er-open-contents .ereader-button__label", "class"), "ereader-button__label");
      assert.equal(await page.textContent("#er-open-contents .ereader-button__label"), "Indice");
      await page.click("#er-open-settings");
      assert.equal(await page.textContent("#er-settings-title"), "Impostazioni di lettura");
      assert.equal(await page.textContent("#reader-forget"), "Dimentica la password su questo dispositivo");
    } finally {
      await context.close();
      await italianServer.close();
    }
  });
});
