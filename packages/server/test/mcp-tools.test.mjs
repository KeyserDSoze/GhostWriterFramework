import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseMarkdown } from "narrarium-engine";
import { createFakeAutopilotAi, seedBookFiles } from "narrarium-engine/testing";
import * as testing from "../dist/testing.mjs";
import { adminLogin, until, withServer } from "./helpers.mjs";
import { ONE_CHAPTER, finished, seededBook } from "./fake-provider.mjs";
import { holdingAi, startOf } from "./hold.mjs";
import { TITLE, commitCount, enableMcp, issueToken, lastCommit, mcpClient, mcpFixture } from "./mcp-helpers.mjs";

// The tools of the per-book MCP endpoint (S7, phase A): what each reads, what each changes and how (one commit, never over what changed meanwhile),
// what no tool may touch, and what a client of each permission can do. The tools answer in text blocks: the first is JSON (`data`), a text that is
// long (a scene, a file) follows as a block of its own.

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const onDisk = (server, file, bookId = "glass") => readFile(path.join(server.data.bookDirectory(bookId), file), "utf8");
/** A call that worked: its first block, parsed. */
const done = (answer, label = "") => {
  assert.equal(answer.status, 200, `${label} ${answer.text}`);
  assert.equal(answer.error, undefined, `${label} ${JSON.stringify(answer.error)}`);
  assert.equal(answer.isError, false, `${label} ${answer.text}`);
  return answer.data;
};
/** A call that the tool refused: an error result whose text starts with `[code]`. */
const refused = (answer, code, pattern) => {
  assert.equal(answer.status, 200, answer.text);
  assert.equal(answer.error, undefined, `a tool error was expected, not a protocol error: ${JSON.stringify(answer.error)}`);
  assert.equal(answer.isError, true, `an error was expected: ${answer.text}`);
  assert.ok(answer.text.startsWith(`[${code}]`), `[${code}] was expected, got: ${answer.text.slice(0, 200)}`);
  if (pattern) assert.match(answer.text, pattern);
};

// ─── Reading ─────────────────────────────────────────────────────────────────

test("S7: book_info says what the book is: title, language, counts, the default ghostwriter and the autopilot in a few words", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    const answer = await rpc.call("book_info");
    assert.equal(answer.blocks.length, 1);
    const info = done(answer);
    assert.deepEqual([info.bookId, info.title, info.language, info.ghostwriter, info.storage, info.author], ["glass", TITLE, "en", "default", "local", undefined]);
    assert.deepEqual(info.counts, { chapters: 2, scenes: 3, characters: 1, locations: 1, factions: 1, items: 1, secrets: 1, timelineEvents: 1 });
    assert.deepEqual(info.autopilot, { configured: false, status: "idle", running: false, pendingQuestion: false, lastError: null });
    assert.deepEqual(info.access, { client: "Claude Code", scopes: ["read", "write", "run"] });
    assert.equal(typeof info.description, "string");
  });
});

test("S7: list_chapters pages through the chapters in order, with their scenes counted and the hash of each chapter file", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    const all = done(await rpc.call("list_chapters"));
    assert.deepEqual([all.total, all.offset, all.nextOffset], [2, 0, null]);
    assert.deepEqual(all.chapters.map((chapter) => [chapter.slug, chapter.number, chapter.title, chapter.scenes, chapter.pov]), [["001-arrival", 1, "Arrival", 2, ["mira"]], ["002-the-storm", 2, "The Storm", 1, ["mira"]]]);
    assert.equal(all.chapters[0].summary, "Mira reaches the harbor.");
    assert.equal(all.chapters[0].hash, sha(await onDisk(server, "chapters/001-arrival/chapter.md")));
    const first = done(await rpc.call("list_chapters", { limit: 1 }));
    assert.deepEqual([first.chapters.length, first.nextOffset, first.total], [1, 1, 2]);
    const second = done(await rpc.call("list_chapters", { limit: 1, offset: first.nextOffset }));
    assert.deepEqual([second.chapters[0].slug, second.nextOffset], ["002-the-storm", null]);
    assert.deepEqual(done(await rpc.call("list_chapters", { offset: 50 })).chapters, [], "past the end there is nothing, and no error");
  });
});

test("S7: read_chapter gives the chapter's frontmatter and its scenes, and with includeText the prose page by page; a chapter is found by slug, number or id", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    const overview = done(await rpc.call("read_chapter", { chapter: "1" }));
    assert.deepEqual([overview.slug, overview.number, overview.title, overview.path], ["001-arrival", 1, "Arrival", "chapters/001-arrival/chapter.md"]);
    assert.equal(overview.hash, sha(await onDisk(server, "chapters/001-arrival/chapter.md")));
    assert.deepEqual(overview.frontmatter.pov, ["mira"]);
    assert.equal(overview.body, "# Arrival\n\nMira comes home.");
    assert.deepEqual(overview.scenes.map((scene) => [scene.slug, scene.number, scene.title, scene.viewpoint, scene.path]), [
      ["001-the-quay", 1, "The Quay", "mira", "chapters/001-arrival/001-the-quay.md"],
      ["002-the-letter", 2, "The Letter", "mira", "chapters/001-arrival/002-the-letter.md"],
    ]);
    assert.match(overview.scenes[0].hash, /^[0-9a-f]{64}$/);
    assert.equal(overview.text, undefined, "no text unless it is asked for");
    for (const ref of ["001-arrival", "chapter:001-arrival", "chapters/001-arrival/chapter.md"]) assert.equal(done(await rpc.call("read_chapter", { chapter: ref })).slug, "001-arrival", ref);
    refused(await rpc.call("read_chapter", { chapter: "no-such-chapter" }), "not_found", /list_chapters/);
    refused(await rpc.call("read_chapter", { chapter: "9" }), "not_found");

    const whole = await rpc.call("read_chapter", { chapter: "001-arrival", includeText: true });
    assert.equal(whole.blocks.length, 2, "the information, then the text");
    assert.match(whole.blocks[1].text, /The Quay[^]*Mira stepped onto the quay[^]*A gull screamed twice[^]*The Letter[^]*brass key/);
    assert.equal(whole.data.text.offset, 0);
    assert.equal(whole.data.text.total, whole.blocks[1].text.length);
    assert.equal(whole.data.text.nextOffset, null);
    let assembled = "";
    let offset = 0;
    let pages = 0;
    for (;;) {
      const page = await rpc.call("read_chapter", { chapter: "001-arrival", includeText: true, offset, limit: 50 });
      assembled += page.blocks[1].text;
      pages += 1;
      assert.ok(page.blocks[1].text.length <= 50);
      if (page.data.text.nextOffset === null) break;
      assert.equal(page.data.text.nextOffset, offset + page.blocks[1].text.length, "the next page starts where this one stopped");
      offset = page.data.text.nextOffset;
    }
    assert.ok(pages > 3);
    assert.equal(assembled, whole.blocks[1].text, "the pages are the text, whole");
  });
});

test("S7: read_paragraph gives a scene with its frontmatter, hash and text, paged; the keys the tools do not know are shown too, and so is a frontmatter that cannot be read", async () => {
  await withServer(async (server, client) => {
    const { rpc, bookId } = await mcpFixture(server, client);
    const scene = await rpc.call("read_paragraph", { chapter: "001-arrival", paragraph: "001-the-quay" });
    const data = done(scene);
    assert.deepEqual([data.chapter, data.slug, data.number, data.title, data.path], ["001-arrival", "001-the-quay", 1, "The Quay", "chapters/001-arrival/001-the-quay.md"]);
    assert.equal(data.hash, sha(await onDisk(server, "chapters/001-arrival/001-the-quay.md")));
    assert.equal(data.frontmatter.mood, "tense");
    assert.equal(scene.blocks[1].text, "Mira stepped onto the quay. The lantern light shook on the water.\n\nA gull screamed twice.");
    assert.deepEqual(data.text, { offset: 0, returned: scene.blocks[1].text.length, total: scene.blocks[1].text.length, nextOffset: null });
    const part = await rpc.call("read_paragraph", { chapter: "1", paragraph: "1", offset: 5, limit: 10 });
    assert.equal(part.blocks[1].text, "stepped on");
    assert.deepEqual([part.data.text.offset, part.data.text.nextOffset], [5, 15]);
    refused(await rpc.call("read_paragraph", { chapter: "001-arrival", paragraph: "009-nothing" }), "not_found");
    refused(await rpc.call("read_paragraph", { chapter: "nope", paragraph: "1" }), "not_found");

    await client.commitFiles(bookId, [{ path: "chapters/001-arrival/003-broken.md", content: "---\ntitle: [unclosed\n---\n\nThe text is still there.\n" }], "a file with a broken frontmatter");
    const broken = await rpc.call("read_paragraph", { chapter: "001-arrival", paragraph: "003-broken" });
    assert.equal(broken.blocks[1].text, "The text is still there.");
    assert.equal(typeof broken.data.frontmatterError, "string", "the reader is told that the keys could not be read");
  });
});

test("S7: search_book finds text in the scenes and in the canon, ranked, with an excerpt and a limit, ignoring case and accents; a secret is found only when it is asked for", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    const key = done(await rpc.call("search_book", { query: "brass key" }));
    assert.equal(key.results[0].path, "chapters/001-arrival/002-the-letter.md");
    assert.deepEqual([key.results[0].kind, key.results[0].title], ["scene", "The Letter"]);
    assert.match(key.results[0].excerpt, /brass key/i);
    assert.equal(key.results.some((result) => result.path === "notes.md"), false, "what is neither a scene nor canon is read with read_file");
    assert.equal(done(await rpc.call("search_book", { query: '"salt wind"' })).results[0].path, "chapters/001-arrival/002-the-letter.md");
    assert.equal(done(await rpc.call("search_book", { query: "MIRÀ", where: "canon" })).results[0].path, "characters/mira.md", "case and accents do not matter");
    const scenes = done(await rpc.call("search_book", { query: "mira", where: "scenes" }));
    assert.ok(scenes.results.length > 0 && scenes.results.every((result) => result.kind === "scene"));
    const canon = done(await rpc.call("search_book", { query: "mira", where: "canon" }));
    assert.ok(canon.results.length > 0 && canon.results.every((result) => result.kind !== "scene" && result.kind !== "chapter"));
    const limited = done(await rpc.call("search_book", { query: "mira", limit: 2 }));
    assert.equal(limited.results.length, 2);
    assert.ok(limited.total >= 3 && limited.returned === 2, JSON.stringify([limited.total, limited.returned]));
    assert.deepEqual(done(await rpc.call("search_book", { query: "zzzxqj" })).results, []);
    assert.equal(done(await rpc.call("search_book", { query: "   " })).total, 0, "a query with nothing to look for finds nothing");

    for (const query of ["SECRET-TRUTH-7731", "SUMMARY-LEAK-5520"]) {
      assert.equal(done(await rpc.call("search_book", { query })).total, 0, `${query} is not found unless asked for`);
      const asked = done(await rpc.call("search_book", { query, includeSecrets: true }));
      assert.deepEqual([asked.results[0].path, asked.results[0].kind], ["secrets/the-keeper.md", "secret"], query);
    }
  });
});

test("S7: list_canon lists characters, locations, factions, items, secrets and events; a secret is listed by its name and the chapters it opens at, never by what it says", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    const all = await rpc.call("list_canon");
    const listing = done(all);
    assert.equal(listing.total, 6);
    const byKind = Object.fromEntries(listing.entries.map((entry) => [entry.kind, entry]));
    assert.deepEqual(Object.keys(byKind).sort(), ["character", "faction", "item", "location", "secret", "timeline-event"]);
    assert.deepEqual([byKind.character.slug, byKind.character.name, byKind.character.aliases, byKind.character.path], ["mira", "Mira", ["Mirabel"], "characters/mira.md"]);
    assert.equal(byKind.character.summary, "The glassmaker's daughter who comes home.");
    assert.match(byKind.character.hash, /^[0-9a-f]{64}$/);
    assert.deepEqual([byKind.secret.name, byKind.secret.knownFrom, byKind.secret.revealIn, byKind.secret.summary], ["The Keeper's Debt", "chapter:002-the-storm", "chapter:002-the-storm", undefined]);
    assert.equal(byKind["timeline-event"].name, "The Founding");
    assert.equal(all.text.includes("SECRET-TRUTH-7731") || all.text.includes("SUMMARY-LEAK-5520"), false, "the list never says what a secret is");
    assert.equal(done(await rpc.call("list_canon", { kind: "character" })).total, 1);
    const page = done(await rpc.call("list_canon", { limit: 2, offset: 1 }));
    assert.deepEqual([page.entries.length, page.nextOffset, page.total], [2, 3, 6]);
    assert.deepEqual(done(await rpc.call("list_canon", { kind: "faction", offset: 5 })).entries, [], "past the end there is nothing");
  });
});

test("S7: read_canon_entry reads an entry by slug, name or alias; a secret is read only when it is asked for by name, and says so", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    for (const entry of ["mira", "Mira", "MIRABEL", "mirabel"]) {
      const mira = await rpc.call("read_canon_entry", { kind: "character", entry });
      assert.equal(done(mira, entry).slug, "mira", entry);
    }
    const mira = await rpc.call("read_canon_entry", { kind: "character", entry: "mira" });
    assert.deepEqual([mira.data.kind, mira.data.name, mira.data.path, mira.data.secret], ["character", "Mira", "characters/mira.md", undefined]);
    assert.equal(mira.data.hash, sha(await onDisk(server, "characters/mira.md")));
    assert.equal(mira.data.frontmatter.role_tier, "main");
    assert.equal(mira.blocks[1].text, "# Mira\n\nA glassmaker's daughter.");
    refused(await rpc.call("read_canon_entry", { kind: "location", entry: "mira" }), "not_found");

    const secret = await rpc.call("read_canon_entry", { kind: "secret", entry: "The Keeper's Debt" });
    assert.equal(done(secret).secret, true);
    assert.match(secret.data.notice, /reveal/i, "it says that this is not for the prose before its chapter");
    assert.equal(secret.data.frontmatter.reveal_in, "chapter:002-the-storm");
    assert.match(secret.blocks[1].text, /SECRET-TRUTH-7731/, "asked for by name, it is read");
  });
});

test("S7: list_files lists what a client may read and says what it may write; read_file reads a file, paged, with its hash; nothing outside the book's own files can be read", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    const listing = done(await rpc.call("list_files"));
    const byPath = Object.fromEntries(listing.files.map((file) => [file.path, file]));
    for (const file of ["book.md", "notes.md", "plot.md", "chapters/001-arrival/chapter.md", "characters/mira.md", "secrets/the-keeper.md", "outline/act-one.md", "autopilot/plan.md"]) assert.ok(byPath[file], `${file} is listed`);
    assert.equal(listing.files.some((file) => file.path.startsWith(".")), false, "hidden files and folders (.github, .vscode…) are not the book's");
    assert.deepEqual([byPath["notes.md"].writable, byPath["outline/act-one.md"].writable, byPath["autopilot/plan.md"].writable], [true, false, false], "the outline is changed with edit_outline, not as a file");
    assert.equal(byPath["notes.md"].hash, sha(await onDisk(server, "notes.md")));
    assert.equal(listing.total, listing.files.length);
    const page = done(await rpc.call("list_files", { limit: 5, offset: 2 }));
    assert.deepEqual([page.files.length, page.nextOffset, page.total], [5, 7, listing.total]);
    const inChapter = done(await rpc.call("list_files", { directory: "chapters/001-arrival/" }));
    assert.deepEqual(inChapter.files.map((file) => file.path).sort(), ["chapters/001-arrival/001-the-quay.md", "chapters/001-arrival/002-the-letter.md", "chapters/001-arrival/chapter.md"]);
    assert.equal(done(await rpc.call("list_files", { directory: "outline/nothing" })).total, 0);
    refused(await rpc.call("list_files", { directory: ".github" }), "forbidden");
    refused(await rpc.call("list_files", { directory: "../" }), "invalid_path");

    const notes = await rpc.call("read_file", { path: "notes.md" });
    assert.deepEqual([notes.data.path, notes.data.hash, notes.data.writable], ["notes.md", sha(await onDisk(server, "notes.md")), true]);
    assert.equal(notes.blocks[1].text, "# Notes\n\nRemember the brass key.\n", "a file is given as it is, not trimmed");
    assert.equal((await rpc.call("read_file", { path: "notes.md", offset: 2, limit: 5 })).blocks[1].text, "Notes");
    assert.equal(done(await rpc.call("read_file", { path: "autopilot/plan.md" })).writable, false, "the autopilot's files can be read");
    const secretFile = done(await rpc.call("read_file", { path: "secrets/the-keeper.md" }));
    assert.deepEqual([secretFile.secret, /reveal/i.test(secretFile.notice)], [true, true], "a secret read as a file is still said to be one");

    for (const forbidden of [".github/workflows/ci.yml", ".vscode/tasks.json", "README.md", "package.json", "src/index.md", ".gitignore"]) refused(await rpc.call("read_file", { path: forbidden }), "forbidden");
    for (const unsafe of ["../outside.md", "/etc/passwd", "C:/Windows/win.ini", "chapters//x.md", ".git/HEAD", "con.md", "chapters/001-arrival/cover.png"]) refused(await rpc.call("read_file", { path: unsafe }), "invalid_path");
    refused(await rpc.call("read_file", { path: "chapters/001-arrival/999-none.md" }), "not_found");
    refused(await rpc.call("read_file", { path: "chapters" }), "invalid_path", /folder/);
  });
});

test("S7: autopilot_status says what the autopilot is doing, and that it was never set up", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    const status = done(await rpc.call("autopilot_status"));
    assert.deepEqual([status.configured, status.status, status.running, status.question ?? null, status.lastError ?? null], [false, "idle", false, null, null]);
  });
});

// ─── Writing ─────────────────────────────────────────────────────────────────

test("S7: create_chapter and create_paragraph add a chapter and its scenes in the book's own format, one commit each, with the commit message `MCP (client): what`", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    const before = commitCount(server);
    const chapter = done(await rpc.call("create_chapter", { title: "The Tide", summary: "The water goes out.", pov: ["mira"] }));
    assert.deepEqual([chapter.created, chapter.path, chapter.slug, chapter.number], [true, "chapters/003-the-tide/chapter.md", "003-the-tide", 3]);
    const file = await onDisk(server, chapter.path);
    assert.equal(chapter.hash, sha(file));
    assert.deepEqual(parseMarkdown(file).frontmatter, { type: "chapter", id: "chapter:003-the-tide", number: 3, title: "The Tide", summary: "The water goes out.", pov: ["mira"], canon: "draft" });
    assert.equal(parseMarkdown(file).body, "# The Tide");
    assert.equal(lastCommit(server), "MCP (Claude Code): create chapter 003-the-tide");
    assert.equal(commitCount(server), before + 1, "one commit");
    assert.match(chapter.commit, /^[0-9a-f]{7,64}$/);

    const scene = done(await rpc.call("create_paragraph", { chapter: "003-the-tide", title: "Low Water", body: "The tide went out.\n\nBoats leaned on the mud.", summary: "The tide leaves.", viewpoint: "mira" }));
    assert.deepEqual([scene.created, scene.path, scene.slug, scene.number], [true, "chapters/003-the-tide/001-low-water.md", "001-low-water", 1]);
    const sceneFile = await onDisk(server, scene.path);
    assert.deepEqual(parseMarkdown(sceneFile).frontmatter, { type: "paragraph", id: "paragraph:003-the-tide:001-low-water", chapter: "chapter:003-the-tide", number: 1, title: "Low Water", summary: "The tide leaves.", viewpoint: "mira", canon: "draft" });
    assert.equal(parseMarkdown(sceneFile).body, "The tide went out.\n\nBoats leaned on the mud.");
    assert.equal(lastCommit(server), "MCP (Claude Code): create scene 003-the-tide/001-low-water");
    const next = done(await rpc.call("create_paragraph", { chapter: "3", title: "High Water", body: "It came back." }));
    assert.deepEqual([next.number, next.path], [2, "chapters/003-the-tide/002-high-water.md"], "the next number, and the chapter by its number");
    assert.equal(done(await rpc.call("create_chapter", { title: "Another" })).slug, "004-another", "the next number again");
    assert.equal(done(await rpc.call("book_info")).counts.chapters, 4);
    assert.equal(done(await rpc.call("read_paragraph", { chapter: "003-the-tide", paragraph: "001-low-water" })).hash, scene.hash, "the hash it answers is the one the next read finds");

    refused(await rpc.call("create_chapter", { title: "Clash", number: 2 }), "already_exists", /002-the-storm/);
    refused(await rpc.call("create_paragraph", { chapter: "003-the-tide", title: "Clash", body: "x", number: 1 }), "already_exists");
    refused(await rpc.call("create_paragraph", { chapter: "no-chapter", title: "Lost", body: "x" }), "not_found", /create_chapter/);
    refused(await rpc.call("create_chapter", { title: "Ghost", ghostwriter: "nobody" }), "invalid_input", /default/);
    assert.equal(commitCount(server), before + 4, "a refused call commits nothing");
  });
});

test("S7: update_paragraph replaces a whole text only with the hash of the text that was read, and never over a change made meanwhile (by the app, by the autopilot, by anyone)", async () => {
  await withServer(async (server, client) => {
    const { rpc, bookId } = await mcpFixture(server, client);
    const file = "chapters/001-arrival/001-the-quay.md";
    const read = done(await rpc.call("read_paragraph", { chapter: "001-arrival", paragraph: "001-the-quay" }));
    const before = commitCount(server);

    refused(await rpc.call("update_paragraph", { chapter: "001-arrival", paragraph: "001-the-quay", body: "Rewritten." }), "expected_hash_required", /read_paragraph/);
    assert.equal(parseMarkdown(await onDisk(server, file)).body, "Mira stepped onto the quay. The lantern light shook on the water.\n\nA gull screamed twice.", "nothing was replaced");

    const updated = done(await rpc.call("update_paragraph", { chapter: "001-arrival", paragraph: "001-the-quay", body: "Rewritten.\n\nSecond paragraph.", expectedHash: read.hash }));
    assert.deepEqual([updated.updated, updated.path, updated.previousHash], [true, file, read.hash]);
    const after = await onDisk(server, file);
    assert.equal(updated.hash, sha(after));
    assert.equal(parseMarkdown(after).body, "Rewritten.\n\nSecond paragraph.");
    assert.equal(parseMarkdown(after).frontmatter.mood, "tense", "the keys of the file that the tool does not know are kept");
    assert.equal(parseMarkdown(after).frontmatter.number, 1);
    assert.equal(lastCommit(server), "MCP (Claude Code): update scene 001-arrival/001-the-quay");
    assert.equal(commitCount(server), before + 1);

    const stale = await rpc.call("update_paragraph", { chapter: "001-arrival", paragraph: "001-the-quay", body: "From an old copy.", expectedHash: read.hash });
    refused(stale, "conflict", /read it again/i);
    assert.equal(await onDisk(server, file), after, "the file that changed is never overwritten");
    assert.equal(commitCount(server), before + 1);

    await client.commitFiles(bookId, [{ path: file, content: "APP VERSION\n" }], "the author edits in the app");
    refused(await rpc.call("update_paragraph", { chapter: "001-arrival", paragraph: "001-the-quay", body: "Mine.", expectedHash: updated.hash }), "conflict");
    refused(await rpc.call("update_paragraph", { chapter: "001-arrival", paragraph: "001-the-quay", summary: "x", body: "y", expectedHash: "f".repeat(64) }), "conflict");
    assert.equal(await onDisk(server, file), "APP VERSION\n", "what the app wrote is what is there");
    refused(await rpc.call("update_paragraph", { chapter: "001-arrival", paragraph: "001-the-quay", body: "x", expectedHash: "not-a-hash" }), "invalid_input");
    refused(await rpc.call("update_paragraph", { chapter: "001-arrival", paragraph: "009-nothing", summary: "x" }), "not_found");
  });
});

test("S7: two calls that start from the same text cannot both win: one is written and the other is a conflict, whichever comes first", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    const file = "chapters/001-arrival/001-the-quay.md";
    const { hash } = done(await rpc.call("read_paragraph", { chapter: "001-arrival", paragraph: "001-the-quay" }));
    const before = commitCount(server);
    const answers = await Promise.all(["First version.", "Second version."].map((body) => rpc.call("update_paragraph", { chapter: "001-arrival", paragraph: "001-the-quay", body, expectedHash: hash })));
    const written = answers.filter((answer) => !answer.isError);
    const lost = answers.filter((answer) => answer.isError);
    assert.deepEqual([written.length, lost.length], [1, 1], answers.map((answer) => answer.text.slice(0, 60)).join(" | "));
    refused(lost[0], "conflict");
    assert.equal(parseMarkdown(await onDisk(server, file)).body, written[0] === answers[0] ? "First version." : "Second version.", "what is there is what the winner wrote, whole");
    assert.equal(commitCount(server), before + 1, "one commit");
  });
});

test("S7: update_paragraph can replace one passage, which must be in the scene exactly once; with a title, summary or viewpoint it changes the frontmatter and leaves the text as it is", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    const file = "chapters/001-arrival/002-the-letter.md";
    const scene = { chapter: "001-arrival", paragraph: "002-the-letter" };
    const before = commitCount(server);
    const original = parseMarkdown(await onDisk(server, file));

    const replaced = done(await rpc.call("update_paragraph", { ...scene, replace: { find: "A brass key slid out of the fold.", with: "A silver key slid out of the fold." } }));
    assert.equal(replaced.updated, true);
    const changed = parseMarkdown(await onDisk(server, file));
    assert.equal(changed.body, original.body.replace("brass", "silver"));
    assert.deepEqual(changed.frontmatter, original.frontmatter, "only the text changed");
    assert.equal(lastCommit(server), "MCP (Claude Code): update scene 001-arrival/002-the-letter");

    refused(await rpc.call("update_paragraph", { ...scene, replace: { find: "no such passage", with: "x" } }), "not_found", /not found/i);
    refused(await rpc.call("update_paragraph", { ...scene, replace: { find: "salt wind", with: "sea wind" } }), "ambiguous", /2 times/);
    refused(await rpc.call("update_paragraph", { ...scene, replace: { find: "silver", with: "gold" }, expectedHash: "a".repeat(64) }), "conflict");
    refused(await rpc.call("update_paragraph", { ...scene, replace: { find: "silver", with: "gold" }, body: "all of it" }), "invalid_input", /body or replace/i);
    refused(await rpc.call("update_paragraph", { ...scene }), "invalid_input", /nothing/i);
    assert.equal(commitCount(server), before + 1, "only the replacement that was clear was done");
    const matching = done(await rpc.call("update_paragraph", { ...scene, replace: { find: "silver", with: "gold" }, expectedHash: sha(await onDisk(server, file)) }));
    assert.equal(matching.updated, true, "with the hash of what is there, the replacement goes through");
    assert.equal(done(await rpc.call("update_paragraph", { ...scene, replace: { find: "gold key", with: "" } })).updated, true, "a passage may be taken out");
    assert.doesNotMatch(parseMarkdown(await onDisk(server, file)).body, /gold/);

    const quay = { chapter: "001-arrival", paragraph: "001-the-quay" };
    const quayBefore = parseMarkdown(await onDisk(server, "chapters/001-arrival/001-the-quay.md"));
    const meta = done(await rpc.call("update_paragraph", { ...quay, title: "The Old Quay", summary: "A new summary.", viewpoint: "tomas" }));
    assert.equal(meta.updated, true);
    const quayAfter = parseMarkdown(await onDisk(server, "chapters/001-arrival/001-the-quay.md"));
    assert.deepEqual(quayAfter.frontmatter, { ...quayBefore.frontmatter, title: "The Old Quay", summary: "A new summary.", viewpoint: "tomas" });
    assert.equal(quayAfter.body, quayBefore.body, "the text is untouched");
    const count = commitCount(server);
    const again = done(await rpc.call("update_paragraph", { ...quay, summary: "A new summary." }));
    assert.deepEqual([again.updated, commitCount(server)], [false, count], "a change that changes nothing is no commit");

    const crlf = "chapters/001-arrival/004-windows.md";
    await client.commitFiles("glass", [{ path: crlf, content: "---\r\ntitle: Windows\r\nnumber: 4\r\n---\r\n\r\nOne line.\r\nTwo lines.\r\n" }], "a scene written on Windows");
    done(await rpc.call("update_paragraph", { chapter: "001-arrival", paragraph: "004-windows", replace: { find: "One line.\nTwo lines.", with: "One line.\nThree lines." } }));
    assert.match(await onDisk(server, crlf), /One line\.\r\nThree lines\./, "a passage written with line feeds is found in a file written with carriage returns, and the text keeps its own line endings");
  });
});

test("S7: update_paragraph and update_chapter refuse a file whose frontmatter cannot be read, instead of dropping the keys it holds", async () => {
  await withServer(async (server, client) => {
    const { rpc, bookId } = await mcpFixture(server, client);
    const broken = "---\ntitle: [unclosed\nmood: tense\n---\n\nThe text.\n";
    await client.commitFiles(bookId, [{ path: "chapters/001-arrival/003-broken.md", content: broken }, { path: "chapters/002-the-storm/chapter.md", content: "---\nnumber: [1\n---\n\n# The Storm\n" }], "files with a broken frontmatter");
    refused(await rpc.call("update_paragraph", { chapter: "001-arrival", paragraph: "003-broken", summary: "x" }), "frontmatter_invalid", /003-broken\.md/);
    refused(await rpc.call("update_chapter", { chapter: "002-the-storm", summary: "x" }), "frontmatter_invalid", /chapter\.md/);
    assert.equal(await onDisk(server, "chapters/001-arrival/003-broken.md"), broken, "nothing was rewritten");
  });
});

test("S7: update_chapter changes a chapter's title, summary, point of view, ghostwriter or text and keeps its folder; the text needs the hash of the one that was read", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    const file = "chapters/001-arrival/chapter.md";
    const before = parseMarkdown(await onDisk(server, file));
    const updated = done(await rpc.call("update_chapter", { chapter: "1", title: "Coming Home", summary: "Mira comes home.", pov: ["mira", "tomas"], ghostwriter: "default" }));
    assert.deepEqual([updated.updated, updated.path], [true, file]);
    const after = parseMarkdown(await onDisk(server, file));
    assert.deepEqual(after.frontmatter, { ...before.frontmatter, title: "Coming Home", summary: "Mira comes home.", pov: ["mira", "tomas"], ghostwriter: "default" });
    assert.equal(after.body, before.body, "the text is untouched");
    assert.equal(done(await rpc.call("list_chapters")).chapters[0].slug, "001-arrival", "the folder keeps its name: nothing is renamed");
    assert.equal(lastCommit(server), "MCP (Claude Code): update chapter 001-arrival");

    refused(await rpc.call("update_chapter", { chapter: "1", body: "# New text" }), "expected_hash_required");
    const hash = done(await rpc.call("read_chapter", { chapter: "1" })).hash;
    assert.equal(done(await rpc.call("update_chapter", { chapter: "1", body: "# Coming Home\n\nA new opening.", expectedHash: hash })).updated, true);
    assert.equal(parseMarkdown(await onDisk(server, file)).body, "# Coming Home\n\nA new opening.");
    refused(await rpc.call("update_chapter", { chapter: "1", body: "# Old", expectedHash: hash }), "conflict");
    refused(await rpc.call("update_chapter", { chapter: "1", ghostwriter: "nobody" }), "invalid_input", /default/);
    refused(await rpc.call("update_chapter", { chapter: "1" }), "invalid_input", /nothing/i);
    refused(await rpc.call("update_chapter", { chapter: "7", title: "x" }), "not_found");
  });
});

test("S7: create_canon_entry makes an entry of each kind in the book's own format, from the fields of that kind, and refuses a name that is taken, a field that does not exist and a value of the wrong kind", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    const character = done(await rpc.call("create_canon_entry", { kind: "character", name: "Tomás Rivera", summary: "A pilot.", fields: { role_tier: "supporting", traits: ["calm"], age: 41, aliases: ["Tom"] } }));
    assert.deepEqual([character.created, character.path, character.slug], [true, "characters/tomas-rivera.md", "tomas-rivera"]);
    const file = parseMarkdown(await onDisk(server, character.path));
    assert.deepEqual(file.frontmatter, { type: "character", id: "character:tomas-rivera", name: "Tomás Rivera", summary: "A pilot.", role_tier: "supporting", traits: ["calm"], age: 41, aliases: ["Tom"], canon: "draft" });
    assert.equal(file.body, "# Tomás Rivera\n\nA pilot.");
    assert.equal(lastCommit(server), "MCP (Claude Code): create character tomas-rivera");

    const secret = done(await rpc.call("create_canon_entry", { kind: "secret", name: "The Lamp's Price", body: "# The Lamp's Price\n\nIt was paid in names.", fields: { known_from: "chapter:002-the-storm", holders: ["character:mira"], stakes: "Her name." } }));
    assert.equal(secret.path, "secrets/the-lamp-s-price.md");
    assert.deepEqual(parseMarkdown(await onDisk(server, secret.path)).frontmatter, { type: "secret", id: "secret:the-lamp-s-price", title: "The Lamp's Price", known_from: "chapter:002-the-storm", holders: ["character:mira"], stakes: "Her name.", canon: "draft" }, "a secret has a title, not a name");
    const event = done(await rpc.call("create_canon_entry", { kind: "timeline-event", name: "The Flood", fields: { date: "0042", participants: ["character:mira"] } }));
    assert.equal(event.path, "timelines/events/the-flood.md");
    assert.equal(parseMarkdown(await onDisk(server, event.path)).frontmatter.date, "0042");
    for (const [kind, directory] of [["location", "locations"], ["faction", "factions"], ["item", "items"]]) assert.equal(done(await rpc.call("create_canon_entry", { kind, name: `New ${kind}` })).path, `${directory}/new-${kind}.md`);

    refused(await rpc.call("create_canon_entry", { kind: "character", name: "Mira" }), "already_exists", /characters\/mira\.md/);
    refused(await rpc.call("create_canon_entry", { kind: "character", name: "Nobody", fields: { nope: "x" } }), "invalid_fields", /role_tier/);
    refused(await rpc.call("create_canon_entry", { kind: "character", name: "Nobody", fields: { age: "old" } }), "invalid_fields", /age/);
    refused(await rpc.call("create_canon_entry", { kind: "character", name: "Nobody", fields: { role_tier: "king" } }), "invalid_fields", /role_tier/);
    refused(await rpc.call("create_canon_entry", { kind: "location", name: "Nowhere", fields: { speaking_style: "loud" } }), "invalid_fields", /atmosphere/);
    refused(await rpc.call("create_canon_entry", { kind: "character", name: "Nobody", fields: { type: "item" } }), "invalid_fields", /type/);
    assert.equal(done(await rpc.call("list_canon")).total, 6 + 6, "the refused ones were not made");
  });
});

test("S7: update_canon_entry changes the fields it is given and keeps the rest, takes a field out with null, and replaces the text only with the hash of the one that was read", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    const file = "characters/mira.md";
    const before = parseMarkdown(await onDisk(server, file));
    const updated = done(await rpc.call("update_canon_entry", { kind: "character", entry: "Mirabel", summary: "The one who comes home.", fields: { age: 30, traits: ["brave"] } }));
    assert.deepEqual([updated.updated, updated.path], [true, file]);
    const after = parseMarkdown(await onDisk(server, file));
    assert.deepEqual(after.frontmatter, { ...before.frontmatter, summary: "The one who comes home.", age: 30, traits: ["brave"] }, "aliases and the rest are kept");
    assert.equal(after.body, before.body);
    assert.equal(lastCommit(server), "MCP (Claude Code): update character mira");
    const taken = done(await rpc.call("update_canon_entry", { kind: "character", entry: "mira", fields: { traits: null }, name: "Mira Vance" }));
    assert.equal(taken.updated, true);
    const renamed = parseMarkdown(await onDisk(server, file));
    assert.equal("traits" in renamed.frontmatter, false, "null takes a field out");
    assert.equal(renamed.frontmatter.name, "Mira Vance");
    assert.equal(done(await rpc.call("list_canon", { kind: "character" })).entries[0].slug, "mira", "the file keeps its name");

    refused(await rpc.call("update_canon_entry", { kind: "character", entry: "mira", body: "New text" }), "expected_hash_required");
    const hash = done(await rpc.call("read_canon_entry", { kind: "character", entry: "mira" })).hash;
    assert.equal(done(await rpc.call("update_canon_entry", { kind: "character", entry: "mira", body: "# Mira\n\nNew text.", expectedHash: hash })).updated, true);
    refused(await rpc.call("update_canon_entry", { kind: "character", entry: "mira", body: "x", expectedHash: hash }), "conflict");
    refused(await rpc.call("update_canon_entry", { kind: "character", entry: "mira", fields: { nope: 1 } }), "invalid_fields");
    refused(await rpc.call("update_canon_entry", { kind: "character", entry: "mira", fields: { id: "character:other" } }), "invalid_fields", /id/);
    refused(await rpc.call("update_canon_entry", { kind: "character", entry: "nobody", summary: "x" }), "not_found");
    refused(await rpc.call("update_canon_entry", { kind: "character", entry: "mira" }), "invalid_input", /nothing/i);
  });
});

test("S7: write_file writes a text file of the book that no other tool is for: an existing file only with its hash, a new one without, and never a path that is not the book's to give", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    const before = commitCount(server);
    const notes = done(await rpc.call("read_file", { path: "notes.md" }));
    refused(await rpc.call("write_file", { path: "notes.md", content: "# New\n" }), "expected_hash_required", /read_file/);
    const written = done(await rpc.call("write_file", { path: "notes.md", content: "# New notes\n", expectedHash: notes.hash }));
    assert.deepEqual([written.written, written.created, written.path, written.hash], [true, false, "notes.md", sha("# New notes\n")]);
    assert.equal(await onDisk(server, "notes.md"), "# New notes\n");
    assert.equal(lastCommit(server), "MCP (Claude Code): write notes.md");
    refused(await rpc.call("write_file", { path: "notes.md", content: "# Old\n", expectedHash: notes.hash }), "conflict");
    assert.equal(await onDisk(server, "notes.md"), "# New notes\n");

    const created = done(await rpc.call("write_file", { path: "drafts/act-two.md", content: "# Act two\n" }));
    assert.deepEqual([created.written, created.created], [true, true]);
    assert.equal(await onDisk(server, "drafts/act-two.md"), "# Act two\n");
    refused(await rpc.call("write_file", { path: "drafts/act-two.md", content: "x" }), "expected_hash_required", /exists/);
    refused(await rpc.call("write_file", { path: "drafts/ghost.md", content: "x", expectedHash: "a".repeat(64) }), "conflict");
    assert.equal(commitCount(server), before + 2, "two writes, two commits");

    const kept = commitCount(server);
    for (const path_ of ["autopilot/state.json", "autopilot/activity.json", "autopilot/plan.md", "outline/act-one.md", "outline/chapters/001.md", "conversations/chat.md", ".github/workflows/ci.yml", ".github/workflows/new.yml", ".vscode/tasks.json", ".opencode/plugins/x.json", ".claude/agents/x.md", ".gitignore", ".hidden/notes.md", "README.md", "package.json", "src/x.md", "node_modules/x.md"]) {
      refused(await rpc.call("write_file", { path: path_, content: "x" }), "forbidden");
    }
    for (const unsafe of ["../outside.md", "/etc/cron.d/job.md", "C:/x.md", "chapters//x.md", ".git/config", ".GIT/hooks/post-commit.md", "chapters/.git/x.md", "con.md", "a:b.md", "chapters/001-arrival/cover.png"]) {
      refused(await rpc.call("write_file", { path: unsafe, content: "x" }), "invalid_path");
    }
    assert.equal(commitCount(server), kept, "no refused path left a commit behind");
    await assert.rejects(onDisk(server, "README.md"), "and no file was made");
    await assert.rejects(onDisk(server, ".github/workflows/new.yml"));
  });
});

test("S7: write_file keeps the freeze of a chapter: chapter.md written whole keeps the record it holds, and gets none it does not hold", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    const frozen = await client.freezeChapter("glass", "001-arrival");
    const file = "chapters/001-arrival/chapter.md";
    const record = parseMarkdown(await onDisk(server, file)).frontmatter.frozen;
    assert.equal(record.by, "author");

    // A model rewrote the frozen chapter and left the record out: the record stays, and the change is noticed as one of a frozen chapter.
    const current = done(await rpc.call("read_file", { path: file }));
    const rewritten = "---\ntype: chapter\nid: chapter:001-arrival\nnumber: 1\ntitle: Arrival\nsummary: Mira reaches the harbor at night.\n---\n\n# Arrival\n\nMira comes back at night.\n";
    const written = done(await rpc.call("write_file", { path: file, content: rewritten, expectedHash: current.hash }));
    const after = await onDisk(server, file);
    assert.equal(written.hash, sha(after), "the hash is the one of the file as written");
    assert.deepEqual(parseMarkdown(after).frontmatter, { ...parseMarkdown(rewritten).frontmatter, frozen: record });
    assert.equal(parseMarkdown(after).body, "# Arrival\n\nMira comes back at night.");
    const status = await client.frozenStatus("glass");
    assert.deepEqual(status.changes.map((change) => [change.slug, change.changed.body]), [["001-arrival", true]], `${JSON.stringify(frozen)}`);

    // A record written into a chapter that is not frozen is not the model's to give.
    const storm = "chapters/002-the-storm/chapter.md";
    const stormNow = done(await rpc.call("read_file", { path: storm }));
    const forged = (await onDisk(server, storm)).replace("\n---\n", `\nfrozen:\n  at: ${record.at}\n  by: author\n  digest: ${record.digest}\n  files: {}\n---\n`);
    assert.ok(parseMarkdown(forged).frontmatter.frozen, "the forged record is in the text the model sends");
    done(await rpc.call("write_file", { path: storm, content: forged, expectedHash: stormNow.hash }));
    assert.equal(Object.hasOwn(parseMarkdown(await onDisk(server, storm)).frontmatter, "frozen"), false);
  });
});

// ─── Who may do what ─────────────────────────────────────────────────────────

test("S7: a client may call only the tools of its permissions: another permission's tool is refused as an error of the tool, before its arguments are looked at, and nothing is written", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    const reader = mcpClient(server, slug, await issueToken(server, "reader", ["read"]));
    const writer = mcpClient(server, slug, await issueToken(server, "writer", ["read", "write"]));
    const runner = mcpClient(server, slug, await issueToken(server, "runner", ["read", "run"]));
    const before = commitCount(server);
    refused(await reader.call("create_chapter", { title: "No" }), "scope", /write/);
    refused(await reader.call("write_file", {}), "scope", /write/);
    refused(await reader.call("autopilot_pause", {}), "scope", /run/);
    refused(await writer.call("autopilot_note", { text: "x" }), "scope", /run/);
    refused(await runner.call("update_paragraph", { chapter: "1", paragraph: "1", summary: "x" }), "scope", /write/);
    assert.equal(commitCount(server), before, "nothing was written");
    done(await reader.call("book_info"));
    done(await writer.call("create_chapter", { title: "Yes" }));
    done(await runner.call("autopilot_pause", {}));
    assert.equal(commitCount(server), before + 1);
  });
});

test("S7: every call of a tool is written to an audit log that says who, when, which tool and which files, and never what the text was; the server's log has neither text nor token", async () => {
  const lines = [];
  await withServer(async (server, client) => {
    const { rpc, token } = await mcpFixture(server, client);
    const marker = "AUDIT-MARKER-91827";
    done(await rpc.call("read_paragraph", { chapter: "001-arrival", paragraph: "001-the-quay" }));
    const notes = done(await rpc.call("read_file", { path: "notes.md" }));
    done(await rpc.call("write_file", { path: "notes.md", content: `# ${marker}\n`, expectedHash: notes.hash }));
    refused(await rpc.call("write_file", { path: "notes.md", content: `${marker} again`, expectedHash: "0".repeat(64) }), "conflict");
    refused(await rpc.call("read_file", { path: ".github/workflows/ci.yml" }), "forbidden");
    refused(await rpc.call("update_paragraph", { chapter: "001-arrival", paragraph: "002-the-letter", replace: { find: marker, with: marker } }), "not_found");
    await rpc.request("tools/list", {});
    const entries = (await server.mcp.audit.recent(20)).reverse();
    assert.deepEqual(entries.map((entry) => [entry.tool, entry.ok, entry.code ?? null, entry.paths ?? []]), [
      ["read_paragraph", true, null, ["chapters/001-arrival/001-the-quay.md"]],
      ["read_file", true, null, ["notes.md"]],
      ["write_file", true, null, ["notes.md"]],
      ["write_file", false, "conflict", ["notes.md"]],
      ["read_file", false, "forbidden", [".github/workflows/ci.yml"]],
      ["update_paragraph", false, "not_found", ["chapters/001-arrival/002-the-letter.md"]],
    ], "tools/list and the like are not calls of a tool");
    for (const entry of entries) {
      assert.deepEqual([entry.bookId, entry.client, typeof entry.clientId, Number.isNaN(Date.parse(entry.at))], ["glass", "Claude Code", "string", false]);
    }
    assert.equal((await server.mcp.audit.recent(2)).length, 2);
    assert.equal((await server.mcp.audit.recent(20, "other-book")).length, 0);
    const file = await readFile(path.join(server.data.root, "mcp-audit.jsonl"), "utf8");
    for (const secret of [marker, token, "Remember the brass key"]) {
      assert.equal(file.includes(secret), false, `the audit file does not hold ${secret}`);
      assert.equal(lines.join("\n").includes(secret), false, `the log does not hold ${secret}`);
    }
    assert.equal(file.trim().split("\n").length, 6);
  }, { log: (line) => lines.push(line) });
});

test("S7: while the server waits to restart for an update, the tools that change the book or the autopilot are refused (the ones that read go on), as the routes are", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    const before = commitCount(server);
    await server.books.requestUpdate(async () => undefined);
    try {
      refused(await rpc.call("write_file", { path: "notes2.md", content: "x" }), "maintenance", /restart/);
      refused(await rpc.call("create_chapter", { title: "Later" }), "maintenance");
      refused(await rpc.call("autopilot_note", { text: "x" }), "maintenance");
      done(await rpc.call("book_info"));
      done(await rpc.call("read_file", { path: "notes.md" }));
    } finally {
      server.books.leaveMaintenance();
    }
    assert.equal(commitCount(server), before, "nothing was written");
    done(await rpc.call("write_file", { path: "drafts/after.md", content: "x" }));
  });
});

// ─── Publishing ──────────────────────────────────────────────────────────────

const GITHUB = { kind: "github", owner: "me", repo: "remote", branch: "main" };
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-C", cwd, ...args], { encoding: "utf8" }).trim();

/** A bare repository with one commit on `main`, standing in for GitHub. */
async function seedOrigin() {
  const origin = await mkdtemp(path.join(os.tmpdir(), "narrarium-mcp-origin-"));
  const seed = await mkdtemp(path.join(os.tmpdir(), "narrarium-mcp-seed-"));
  execFileSync("git", ["init", "--quiet", "--bare", origin]);
  execFileSync("git", ["init", "--quiet", "-b", "main", seed]);
  for (const [file, content] of Object.entries(seedBookFiles())) {
    await mkdir(path.dirname(path.join(seed, file)), { recursive: true });
    await writeFile(path.join(seed, file), content);
  }
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "seed");
  git(seed, "push", "--quiet", origin, "main");
  return { origin, seed };
}

test("S7: a write to a book on GitHub is published as a commit from the app is: the server pulls and pushes it at once while no run publishes it", async () => {
  const seeded = await seedOrigin();
  try {
    await withServer(async (server, client) => {
      await client.registerBook("gh", { title: "Remote", storage: GITHUB, githubToken: "ghp_mcpPublishTestToken0123456789" });
      const { slug } = await enableMcp(server, "gh");
      const rpc = mcpClient(server, slug, await issueToken(server));
      done(await rpc.call("write_file", { path: "notes.md", content: "# From the MCP\n" }));
      assert.equal(git(seeded.origin, "log", "-1", "--format=%s", "main"), "MCP (Claude Code): write notes.md", "GitHub has the commit");
      assert.equal(git(seeded.origin, "show", "main:notes.md"), "# From the MCP");
      assert.equal(done(await rpc.call("book_info")).storage, "github");
    }, { githubRemoteUrl: () => seeded.origin });
  } finally {
    await Promise.all([seeded.origin, seeded.seed].map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
  }
});

// ─── The autopilot ───────────────────────────────────────────────────────────

test("S7: the autopilot tools read and steer a run while it goes on, the owner's switch and caps still apply, and the book can be edited meanwhile", async () => {
  const ai = holdingAi();
  try {
    await withServer(async (server, client) => {
      await seededBook(client, "b");
      const { slug } = await enableMcp(server, "b");
      const rpc = mcpClient(server, slug, await issueToken(server));
      refused(await rpc.call("autopilot_resume", {}), "no_autopilot", /Narrarium app/);
      done(await rpc.call("autopilot_pause", {}));

      await client.startAutopilot("b", startOf(2));
      await until(() => ai.isHeld(), 30_000);
      const running = done(await rpc.call("autopilot_status"));
      assert.deepEqual([running.running, running.status, running.configured], [true, "running", true]);
      assert.equal(done(await rpc.call("book_info")).autopilot.running, true);

      const written = done(await rpc.call("write_file", { path: "notes.md", content: "# Notes from the MCP\n" }));
      assert.equal(written.created, true, "the book can be edited while the autopilot runs");
      assert.equal(done(await rpc.call("read_file", { path: "notes.md" })).path, "notes.md");

      assert.equal(done(await rpc.call("autopilot_pause", { when: "after-step" })).pausePending, "after-step");
      assert.equal(done(await rpc.call("autopilot_pause", { when: "cancel" })).pausePending ?? null, null, "a pause that waits can be taken back");
      done(await rpc.call("autopilot_note", { text: "Keep the harbor foggy." }));
      assert.equal(done(await rpc.call("autopilot_status")).pendingNotes, 1);
      refused(await rpc.call("autopilot_note", { text: "x".repeat(900), scope: "from_now" }), "rule_too_long");
      refused(await rpc.call("autopilot_resume", {}), "busy");
      refused(await rpc.call("autopilot_answer", { questionId: "q-none", answer: "yes" }), "busy");

      done(await rpc.call("autopilot_pause", { when: "now" }));
      const stopped = await finished(client, "b");
      assert.equal(stopped.state.status, "paused");
      const paused = done(await rpc.call("autopilot_status"));
      assert.deepEqual([paused.running, paused.status], [false, "paused"]);
      refused(await rpc.call("autopilot_answer", { questionId: "q-none", answer: "yes" }), "question_closed");
      done(await rpc.call("autopilot_note", { text: "Rule for the rest of the book: no storms.", scope: "from_now" }));
      assert.equal(done(await rpc.call("autopilot_status")).rules, 1);

      done(await rpc.call("autopilot_resume", { steps: 1 }));
      await finished(client, "b");
      assert.equal((await client.events("b")).events.filter((event) => event.type === "run-started").length, 2, "it ran again");
      assert.equal(done(await rpc.call("autopilot_status")).status, "paused", "and stopped after the one step it was allowed");

      // The owner's switch: nothing the MCP does can run the autopilot while AI spending is off.
      const admin = await adminLogin(server);
      assert.equal((await admin.call("POST", "/admin/api/spend", { paused: true })).status, 200);
      refused(await rpc.call("autopilot_resume", {}), "spend_limit");
    }, { ai });
  } finally {
    ai.release();
  }
});

test("S7: a page of text is counted in characters and never ends in the middle of one that takes two code units (an emoji)", () => {
  const { pageText } = testing;
  const text = "a😀b😀c😀";
  assert.deepEqual(pageText(text, 0, 3), { slice: "a😀", page: { offset: 0, returned: 3, total: 9, nextOffset: 3 } });
  assert.deepEqual(pageText(text, 1, 1), { slice: "😀", page: { offset: 1, returned: 2, total: 9, nextOffset: 3 } }, "a page too small for a character takes it whole");
  assert.equal(pageText(text, 1, 2).slice, "😀");
  let assembled = "";
  for (let page = pageText(text, 0, 2); ; page = pageText(text, page.page.nextOffset, 2)) {
    assembled += page.slice;
    if (page.page.nextOffset === null) break;
  }
  assert.equal(assembled, text, "pages of any size put the text back together");
  assert.deepEqual(pageText("abc", 10, 5), { slice: "", page: { offset: 3, returned: 0, total: 3, nextOffset: null } }, "past the end there is nothing");
});

/** The director's reply to the plan asks the author a question: the run then waits for the answer. */
function askingAi() {
  const base = createFakeAutopilotAi();
  return {
    calls: base.calls,
    async complete(request) {
      if (request.json?.name !== "plan_review") return base.complete(request);
      base.calls.push(request);
      const json = { verdict: "approve", score: 8, summary: "Good plan.", strengths: [], changes: [], guidance: [], questionForAuthor: { question: "Should Orrin be redeemed?", options: ["Yes", "No"] } };
      return { text: JSON.stringify(json), json, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }, model: "fake-model", provider: "fake", cost: 0.001, currency: "USD" };
    },
  };
}

test("S7: autopilot_status says what the question is that the autopilot waits on, and autopilot_answer answers it, as a note or a permanent rule, once", async () => {
  await withServer(async (server, client) => {
    await seededBook(client, "b");
    const { slug } = await enableMcp(server, "b");
    const rpc = mcpClient(server, slug, await issueToken(server));
    await client.startAutopilot("b", ONE_CHAPTER);
    await finished(client, "b");
    const waiting = done(await rpc.call("autopilot_status"));
    assert.deepEqual([waiting.status, waiting.running, waiting.pendingQuestion], ["waiting-author", false, true]);
    assert.deepEqual([waiting.question.question, waiting.question.options], ["Should Orrin be redeemed?", ["Yes", "No"]]);
    assert.equal(typeof waiting.question.id, "string");
    assert.equal(done(await rpc.call("book_info")).autopilot.pendingQuestion, true);

    refused(await rpc.call("autopilot_answer", { questionId: "q-wrong", answer: "Yes" }), "question_closed");
    refused(await rpc.call("autopilot_answer", { questionId: waiting.question.id, answer: "n".repeat(900), asRule: true }), "rule_too_long");
    assert.equal(done(await rpc.call("autopilot_status")).question.id, waiting.question.id, "a refused answer leaves the question open");

    const answered = done(await rpc.call("autopilot_answer", { questionId: waiting.question.id, answer: "No, never.", asRule: true }));
    assert.deepEqual([answered.question, answered.rules, answered.pendingQuestion], [null, 1, false]);
    assert.deepEqual((await client.autopilot("b")).state.constraints, ["Answer to the director's question «Should Orrin be redeemed?»: No, never."], "the answer became a rule of the book");
    refused(await rpc.call("autopilot_answer", { questionId: waiting.question.id, answer: "again" }), "question_closed");
  }, { ai: askingAi() });
});
