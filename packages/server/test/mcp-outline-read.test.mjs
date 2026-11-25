import test from "node:test";
import assert from "node:assert/strict";
import { outlineEntryFiles } from "narrarium-engine/testing";
import { autopilotEntry } from "./mcp-outline-helpers.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as testing from "../dist/testing.mjs";
import { withServer } from "./helpers.mjs";
import { finished, seededBook } from "./fake-provider.mjs";
import { startOf } from "./hold.mjs";
import { enableMcp, issueToken, mcpClient, mcpFixture, mcpRoute } from "./mcp-helpers.mjs";
import { bookFile, brokenEntry, bulkOutline, countReads, done, entryFile, invalid, onDisk, outlineFixture, refused, sha } from "./mcp-outline-helpers.mjs";

// The tools that read the outline (the Scaletta) of a book through its MCP endpoint (S9): read_outline, a page of its entries and the description of the book, and
// read_outline_entry, one entry whole with the hash that edit_outline needs. An outline has no maximum number of chapters: a call reads the files of the entries
// it shows, and no others.

const { OUTLINE_SCAN_MAX_ENTRIES } = testing;

const ARRIVAL = "Mira reaches the harbor at dusk and finds the quay empty.";
const DESCRIPTION = "A glassmaker's daughter comes home.\n\nThe harbor hides a debt.";

// ─── The list ──────────────────────────────────────────────────────────────

test("S9: read_outline gives the description of the book and the entries with who wrote each, whether it is intact, how long its text is and whether its chapter is written or frozen; the warnings of the engine come with them", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await outlineFixture(server, client);
    const answer = await rpc.call("read_outline");
    const data = done(answer);
    assert.equal(answer.blocks.length, 2, "the list, then the text of the description of the book");
    assert.equal(answer.blocks[1].text, DESCRIPTION, "a text is a block of its own, as it is");
    assert.deepEqual(data.outline, { entries: 5, lastNumber: 6 });
    assert.deepEqual([data.total, data.offset, data.limit, data.nextOffset], [5, 0, 50, null]);
    assert.deepEqual(data.book, {
      path: "outline/book.md",
      hash: sha(await onDisk(server, "outline/book.md")),
      title: "The Glass Harbor, working title",
      origin: "author",
      intact: false,
      textLength: DESCRIPTION.length,
    });

    assert.deepEqual(data.entries.map((entry) => [entry.number, entry.title, entry.origin, entry.intact, entry.binds, entry.written, entry.frozen]), [
      [1, "Arrival", "author", false, true, true, true],
      [2, "The Storm", "autopilot", true, false, true, false],
      [3, "The Keeper", "autopilot", false, true, false, false],
      [4, "", "author", false, true, false, false],
      [6, "The Glass Road", "author", false, true, false, false],
    ]);
    assert.deepEqual(data.entries.map((entry) => entry.ghostwriter), ["default", undefined, undefined, undefined, "ghost-one"]);
    assert.deepEqual(data.entries.map((entry) => entry.path), [1, 2, 3, 4, 6].map((number) => `outline/chapters/${String(number).padStart(3, "0")}.md`));
    assert.equal(data.entries[0].textLength, ARRIVAL.length);
    assert.deepEqual(data.entries.map((entry) => entry.unreadable), [undefined, undefined, undefined, true, undefined], "the entry whose frontmatter cannot be read says so");
    assert.equal(data.entries.some((entry) => "hash" in entry || "text" in entry || "body" in entry), false, "the text and the hash are read_outline_entry's");

    const byCode = Object.fromEntries(data.warnings.map((warning) => [warning.code, warning]));
    assert.deepEqual(Object.keys(byCode).sort(), ["gap", "ghostwriter-missing", "not-an-entry", "unreadable"]);
    assert.match(byCode.gap.message, /chapters 5 have no entry/);
    assert.equal(byCode["not-an-entry"].path, "outline/act-one.md");
    assert.deepEqual([byCode.unreadable.path, byCode.unreadable.number], ["outline/chapters/004.md", 4]);
    assert.match(byCode.unreadable.message, /not valid YAML/);
    assert.deepEqual([byCode["ghostwriter-missing"].number, /ghost-one/.test(byCode["ghostwriter-missing"].message)], [6, true], "a ghostwriter the book does not have is said, as edit_outline says it");
    assert.equal(data.warningsTotal, undefined, "nothing was left out");
  });
});

test("S9: read_outline pages through the entries, the first page alone has the description of the book and the warnings of the whole outline, and a page past the end is empty, not an error", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await outlineFixture(server, client);
    const first = await rpc.call("read_outline", { limit: 2 });
    assert.deepEqual([done(first).entries.map((entry) => entry.number), first.data.nextOffset, first.data.total, first.data.limit], [[1, 2], 2, 5, 2]);
    assert.ok(first.data.book && first.data.warnings.some((warning) => warning.code === "gap"));
    const second = await rpc.call("read_outline", { limit: 2, offset: first.data.nextOffset });
    assert.deepEqual([done(second).entries.map((entry) => entry.number), second.data.nextOffset], [[3, 4], 4]);
    assert.equal("book" in second.data, false, "the description was in the first page");
    assert.equal(second.blocks.length, 1, "and so is its text");
    assert.equal(second.data.warnings.some((warning) => warning.code === "gap" || warning.code === "not-an-entry"), false, "and so are the warnings about the outline as a whole");
    assert.deepEqual(second.data.warnings.map((warning) => warning.code), ["unreadable"], "while the warnings of the entries on the page are with the page");
    const third = await rpc.call("read_outline", { limit: 2, offset: 4 });
    assert.deepEqual([done(third).entries.map((entry) => entry.number), third.data.nextOffset], [[6], null]);
    assert.deepEqual(third.data.warnings.map((warning) => warning.code), ["ghostwriter-missing"]);
    const past = done(await rpc.call("read_outline", { offset: 500 }));
    assert.deepEqual([past.entries, past.nextOffset, past.total], [[], null, 5]);
    invalid(await rpc.call("read_outline", { limit: 0 }), /limit/);
    invalid(await rpc.call("read_outline", { limit: 201 }), /limit/);
    invalid(await rpc.call("read_outline", { offset: -1 }), /offset/);
    invalid(await rpc.call("read_outline", { limit: "ten" }), /limit/);
    invalid(await rpc.call("read_outline", { number: 3 }), /not a property/);
  });
});

test("S9: from and to list a range of chapter numbers, and query keeps the entries whose number it is or whose title or text has its words, whatever the case and the accents", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await outlineFixture(server, client);
    const numbers = async (args) => done(await rpc.call("read_outline", args)).entries.map((entry) => entry.number);
    assert.deepEqual(await numbers({ from: 3, to: 4 }), [3, 4]);
    assert.deepEqual(await numbers({ from: 5 }), [6], "a number without an entry is just not there");
    assert.deepEqual(await numbers({ to: 2 }), [1, 2]);
    assert.deepEqual(await numbers({ from: 4, to: 3 }), []);
    assert.equal(done(await rpc.call("read_outline", { from: 3, to: 4 })).total, 2);
    assert.deepEqual(await numbers({ query: "3" }), [3], "a number is the chapter's number");
    assert.deepEqual(await numbers({ query: "5" }), []);
    assert.deepEqual(await numbers({ query: "quay" }), [1, 2], "a word of the text");
    assert.deepEqual(await numbers({ query: "KEEPER" }), [3, 4], "case does not matter, and the text of an entry whose frontmatter cannot be read is read");
    assert.deepEqual(await numbers({ query: "MÍRA" }), [1, 3], "nor do accents");
    assert.deepEqual(await numbers({ query: "glass road" }), [6], "a word of the title; every word has to be there");
    assert.deepEqual(await numbers({ query: "mira keeper" }), [3], "every word, in the title or in the text");
    assert.deepEqual(await numbers({ query: "\"the quay\"" }), [1, 2], "a phrase is matched as it is");
    assert.deepEqual(await numbers({ query: "\"harbor at dusk\"" }), [1]);
    assert.deepEqual(await numbers({ query: "\"dusk at harbor\"" }), []);
    assert.deepEqual(await numbers({ query: "lighthouse" }), []);
    assert.deepEqual(await numbers({ query: "quay", from: 2 }), [2], "a query inside a range");
    assert.deepEqual(await numbers({ query: "quay", limit: 1, offset: 1 }), [2], "paged over what matches");

    const found = done(await rpc.call("read_outline", { query: "quay" }));
    assert.deepEqual([found.total, found.scanned, found.complete], [2, 5, true], "it says how many entries it read for the words, and that it read them all");
    assert.equal(found.outline.entries, 5, "the size of the outline is the whole outline's");
    const nothing = done(await rpc.call("read_outline", { query: "the of" }));
    assert.deepEqual([nothing.entries, nothing.total], [[], 0]);
    assert.match(nothing.message, /no word/i, "a query of words that are in every text says so instead of listing nothing");
    invalid(await rpc.call("read_outline", { query: "" }), /query/);
    invalid(await rpc.call("read_outline", { query: "x".repeat(301) }), /query/);
  });
});

test("S9: a long list of warnings is cut and counted, and a book without an outline has an empty list that says how it begins", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await outlineFixture(server, client, { files: [...Array.from({ length: 70 }, (_, index) => brokenEntry(index + 1, `text ${index + 1}`))], freeze: false });
    const data = done(await rpc.call("read_outline", { limit: 100 }));
    assert.equal(data.entries.length, 70);
    assert.equal(data.warnings.length, 50, "the first fifty");
    assert.ok(data.warningsTotal >= 71, `the number of all of them: ${data.warningsTotal}`);
  });

  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    const stray = done(await rpc.call("read_outline"));
    assert.deepEqual([stray.entries, stray.total, stray.book, stray.outline], [[], 0, null, { entries: 0, lastNumber: 0 }]);
    assert.deepEqual(stray.warnings.map((warning) => [warning.code, warning.path]), [["not-an-entry", "outline/act-one.md"]], "the old file the fixture has is not an entry, and is said");
    assert.match(stray.message, /no synopsis yet[^]*edit_outline/);
    await client.commitFiles("glass", [{ path: "outline/act-one.md", content: null }], "no outline at all");
    const empty = done(await rpc.call("read_outline"));
    assert.deepEqual([empty.entries, empty.book, empty.warnings, empty.nextOffset], [[], null, [], null]);
    refused(await rpc.call("read_outline_entry", { number: 1 }), "not_found", /no entry/);
  });
});

test("S9: a description of the book that is longer than an entry may be is given up to 20,000 characters, with its real length and a way to read the rest", async () => {
  await withServer(async (server, client) => {
    const long = "The description goes on. ".repeat(1200).trim();
    const { rpc } = await outlineFixture(server, client, { files: [bookFile({ title: "Long", body: long }), entryFile(1, { title: "One", body: "x" })], freeze: false });
    const answer = await rpc.call("read_outline");
    const data = done(answer);
    assert.deepEqual([data.book.textLength, data.book.truncated, answer.blocks[1].text.length], [long.length, true, 20_000]);
    assert.equal(answer.blocks[1].text, long.slice(0, 20_000));
    const rest = await rpc.call("read_file", { path: "outline/book.md", offset: 20_000 });
    assert.ok(rest.blocks[1].text.includes("The description goes on."), "read_file reads the rest, with the hash of the whole file");
    assert.equal(data.book.hash, rest.data.hash);
  });
});

// ─── One entry ─────────────────────────────────────────────────────────────

test("S9: read_outline_entry gives an entry whole with the hash of its file, who wrote it, the state of its chapter and, for a chapter that is written, what the autopilot does when the entry changes", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await outlineFixture(server, client);
    const arrival = await rpc.call("read_outline_entry", { number: 1 });
    const data = done(arrival);
    assert.equal(arrival.blocks[1].text, ARRIVAL, "the text is a block of its own, as it is");
    assert.deepEqual([data.number, data.path, data.title, data.ghostwriter, data.origin, data.intact, data.binds], [1, "outline/chapters/001.md", "Arrival", "default", "author", false, true]);
    assert.equal(data.hash, sha(await onDisk(server, "outline/chapters/001.md")), "the hash edit_outline needs as expectedHash");
    assert.deepEqual(data.text, { offset: 0, returned: ARRIVAL.length, total: ARRIVAL.length, nextOffset: null });
    assert.deepEqual(data.chapter, { written: true, frozen: true, slug: "001-arrival" });
    assert.match(data.afterChange, /already written/);
    assert.match(data.afterChange, /no plan/i, "the autopilot has not planned this book, so nothing follows the entry");
    assert.deepEqual(data.warnings, []);

    const storm = done(await rpc.call("read_outline_entry", { number: 2 }));
    assert.deepEqual([storm.origin, storm.intact, storm.binds, storm.chapter], ["autopilot", true, false, { written: true, frozen: false, slug: "002-the-storm" }]);
    assert.equal(storm.ghostwriter, undefined);

    const keeper = done(await rpc.call("read_outline_entry", { number: 3 }));
    assert.deepEqual([keeper.origin, keeper.intact, keeper.binds, keeper.chapter], ["autopilot", false, true, { written: false, frozen: false }], "written by the autopilot and changed since: it binds");
    assert.equal(keeper.afterChange, undefined, "a chapter that is not written has nothing to be told about: its entry is just planned again");

    const broken = await rpc.call("read_outline_entry", { number: 4 });
    assert.equal(done(broken).unreadable, true);
    assert.equal(broken.blocks[1].text, "The keeper's debt comes out.", "its text is all there");
    assert.deepEqual(broken.data.warnings.map((warning) => warning.code), ["unreadable"]);

    const road = done(await rpc.call("read_outline_entry", { number: 6 }));
    assert.deepEqual(road.warnings.map((warning) => warning.code), ["ghostwriter-missing"]);
  });
});

test("S9: what the autopilot does when the entry of a chapter it closed changes is what its settings say: it asks, rewrites the chapter or only reports it; and a chapter the author wrote is never rewritten for its decision", async () => {
  await withServer(async (server, client) => {
    await seededBook(client, "b", { chapters: 0 });
    // The entry of chapter 1 is one the autopilot wrote earlier and nobody touched: it binds nothing, and the run writes it again.
    await client.commitFiles("b", [await autopilotEntry(1, { title: "Chapter Title 1", body: "Event 1 happens and the story turns." })], "an entry the autopilot wrote");
    // No idea is sent: the description of the book is then the one the autopilot writes from its concept.
    await client.startAutopilot("b", { ...startOf(1), brief: { targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 } });
    assert.equal((await finished(client, "b")).state.status, "completed");
    const status = await enableMcp(server, "b");
    const rpc = mcpClient(server, status.slug, await issueToken(server));
    const entry = async () => done(await rpc.call("read_outline_entry", { number: 1 }));

    const written = await entry();
    assert.deepEqual([written.origin, written.intact, written.binds, written.chapter.written, written.chapter.frozen], ["autopilot", true, false, true, true], "the autopilot wrote the entry, the chapter, and froze the chapter it closed");
    assert.match(written.afterChange, /ask the author whether to rewrite the chapter/);
    const overview = done(await rpc.call("read_outline"));
    assert.deepEqual(overview.entries.map((item) => [item.number, item.origin, item.intact, item.written, item.frozen]), [[1, "autopilot", true, true, true]]);
    assert.equal(overview.book.origin, "autopilot", "and the description of the book, from its concept");

    await client.updateAutopilotOptions("b", { frozenEdits: "auto" });
    assert.match((await entry()).afterChange, /rewrite the chapter to follow it, without asking/);
    await client.updateAutopilotOptions("b", { frozenEdits: "notify" });
    assert.match((await entry()).afterChange, /only report it[^]*not rewritten/);
    await client.updateAutopilotOptions("b", { frozenEdits: "ask" });
    assert.match((await entry()).afterChange, /ask the author/);
  });
});

test("S9: a chapter the author wrote before the autopilot took over is never rewritten for the autopilot's decision: with the setting that rewrites, its entry says that the autopilot only reports the change, and a chapter the autopilot wrote itself is rewritten", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    // The book has two chapters of the author; the autopilot takes it over to make a third, and writes the entries of the three.
    await client.commitFiles("glass", Object.entries(outlineEntryFiles(3)).map(([path, content]) => ({ path, content })), "the chapter entries of the three");
    await client.startAutopilot("glass", startOf(3));
    assert.equal((await finished(client, "glass")).state.status, "completed");
    const ask = /ask the author whether to rewrite the chapter/;
    const report = /only report it[^]*not rewritten/;
    const rewrite = /rewrite the chapter to follow it, without asking/;
    const after = async (label, patterns) => {
      for (const [index, pattern] of patterns.entries()) assert.match((await rpc.call("read_outline_entry", { number: index + 1 })).data.afterChange, pattern, `${label}: chapter ${index + 1}`);
    };
    await after("ask", [ask, ask, ask]);
    await client.updateAutopilotOptions("glass", { frozenEdits: "auto" });
    await after("auto", [report, report, rewrite]);
    await client.updateAutopilotOptions("glass", { frozenEdits: "notify" });
    await after("notify", [report, report, report]);
  });
});

test("S9: a long entry is read in pages of characters, like every text, with the warning of the engine for what is past its limit; the entry that is not there is a not_found that says where to look", async () => {
  await withServer(async (server, client) => {
    const long = `${"A long plan. ".repeat(2000)}`;
    const { rpc } = await outlineFixture(server, client, { files: [entryFile(1, { title: "Long", body: long })], freeze: false });
    const whole = await rpc.call("read_outline_entry", { number: 1 });
    assert.equal(done(whole).text.total, long.trim().length);
    assert.equal(whole.blocks[1].text.length, 20_000, "a page is 20,000 characters unless the call asks for another size");
    assert.equal(whole.data.text.nextOffset, 20_000);
    assert.deepEqual(whole.data.warnings.map((warning) => warning.code), ["text-too-long"], "past the 20,000 characters the autopilot reads, and it is said");
    let assembled = "";
    let offset = 0;
    for (let pages = 0; pages < 10; pages += 1) {
      const page = await rpc.call("read_outline_entry", { number: 1, offset, limit: 7000 });
      assembled += page.blocks[1].text;
      if (page.data.text.nextOffset === null) break;
      offset = page.data.text.nextOffset;
    }
    assert.equal(assembled, long.trim(), "the pages are the text, whole");

    refused(await rpc.call("read_outline_entry", { number: 2 }), "not_found", /no entry for chapter 2[^]*read_outline/);
    refused(await rpc.call("read_outline_entry", { number: 999999 }), "not_found");
    invalid(await rpc.call("read_outline_entry", {}), /number/);
    invalid(await rpc.call("read_outline_entry", { number: 0 }), /number/);
    invalid(await rpc.call("read_outline_entry", { number: "1" }), /number/);
    invalid(await rpc.call("read_outline_entry", { number: 1.5 }), /number/);
    invalid(await rpc.call("read_outline_entry", { number: 1, chapter: "x" }), /not a property/);
  });
});

// ─── An outline of any length ──────────────────────────────────────────────

test("S9: an outline of 5000 chapters is read a page at a time: a call reads the files of the entries it shows and no others, whatever the page, the range or the number", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    await bulkOutline(server, "glass", 5000, { gaps: [100, 2500] });
    const reads = countReads(server);
    try {
      const first = done(await rpc.call("read_outline", { limit: 50 }));
      assert.deepEqual([first.total, first.entries.length, first.nextOffset, first.outline], [4998, 50, 50, { entries: 4998, lastNumber: 5000 }]);
      assert.equal(reads.outline.length, 50, `the 50 entries of the page: ${reads.outline.length} files read`);
      assert.match(first.warnings.find((warning) => warning.code === "gap").message, /chapters 100, 2500 have no entry/, "the gaps are known from the names of the files");

      reads.reset();
      const last = done(await rpc.call("read_outline", { limit: 200, offset: 4900 }));
      assert.deepEqual([last.entries.length, last.entries.at(-1).number, last.nextOffset], [98, 5000, null]);
      assert.equal(reads.outline.length, 98, "the entries of the last page");

      reads.reset();
      const range = done(await rpc.call("read_outline", { from: 4000, limit: 3 }));
      assert.deepEqual(range.entries.map((entry) => entry.number), [4000, 4001, 4002]);
      assert.equal(reads.outline.length, 3, "a range is found in the list of files: none of the 3999 before it is read");

      reads.reset();
      assert.deepEqual(done(await rpc.call("read_outline", { query: "4321" })).entries.map((entry) => entry.number), [4321]);
      assert.deepEqual(done(await rpc.call("read_outline", { query: "2500" })).entries, [], "an entry that is not there is not there");
      assert.deepEqual(done(await rpc.call("read_outline", { query: "43" })).entries.map((entry) => entry.number), [43], "a number is the chapter's number: not the ones whose number starts with it");
      assert.equal(reads.outline.length, 2, "a number is looked for in the list of files: one entry is read for each that is there");

      reads.reset();
      const entry = done(await rpc.call("read_outline_entry", { number: 4321 }));
      assert.equal(entry.title, "Chapter 4321");
      assert.deepEqual(reads.outline, ["outline/chapters/4321.md"], "one file");
    } finally {
      reads.stop();
    }
  });
});

test("S9: the words of a query are looked for in a bounded part of a long outline, which the answer says, and the next call goes on from where the last one stopped", async () => {
  assert.equal(OUTLINE_SCAN_MAX_ENTRIES, 2000);
  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    await bulkOutline(server, "glass", 5000);
    const reads = countReads(server);
    try {
      // "The lantern goes out" is in chapters 997, 1994, 2991, 3988 and 4985.
      const first = done(await rpc.call("read_outline", { query: "lantern" }));
      assert.deepEqual(first.entries.map((entry) => entry.number), [997, 1994]);
      assert.deepEqual([first.total, first.scanned, first.complete, first.nextFrom], [2, 2000, false, 2001]);
      assert.match(first.message, /first 2000 entries[^]*from/);
      assert.ok(reads.outline.length <= 2000, `at most ${OUTLINE_SCAN_MAX_ENTRIES} files: ${reads.outline.length}`);

      reads.reset();
      const second = done(await rpc.call("read_outline", { query: "lantern", from: first.nextFrom }));
      assert.deepEqual([second.entries.map((entry) => entry.number), second.scanned, second.complete, second.nextFrom], [[2991, 3988], 2000, false, 4001]);
      const third = done(await rpc.call("read_outline", { query: "lantern", from: second.nextFrom }));
      assert.deepEqual([third.entries.map((entry) => entry.number), third.scanned, third.complete, third.nextFrom], [[4985], 1000, true, undefined]);

      reads.reset();
      const narrow = done(await rpc.call("read_outline", { query: "lantern", from: 3900, to: 4100 }));
      assert.deepEqual([narrow.entries.map((entry) => entry.number), narrow.scanned, narrow.complete], [[3988], 201, true]);
      assert.equal(reads.outline.length, 201, "a range keeps the reading to the range");
    } finally {
      reads.stop();
    }
  });
});

// ─── Who may read, and what is recorded ────────────────────────────────────

test("S9: a client that may only read reads the outline, whatever else it may or may not do; the book's MCP being off ends it for the outline too", async () => {
  await withServer(async (server, client) => {
    const { slug, bookId } = await outlineFixture(server, client);
    const reader = mcpClient(server, slug, await issueToken(server, "reader", ["read"]));
    assert.equal(done(await reader.call("read_outline")).total, 5);
    assert.equal(done(await reader.call("read_outline_entry", { number: 2 })).title, "The Storm");
    const runner = mcpClient(server, slug, await issueToken(server, "runner", ["read", "run"]));
    assert.equal(done(await runner.call("read_outline")).total, 5);
    assert.equal((await (await mcpRoute(server, bookId)).put({ enabled: false })).status, 200);
    assert.equal((await reader.call("read_outline")).status, 404, "the same 404 as for every tool");
    assert.equal((await reader.call("read_outline_entry", { number: 1 })).status, 404);
  });
});

test("S9: the audit says which tool read which files, also when the answer was no, and never what the outline says", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await outlineFixture(server, client);
    done(await rpc.call("read_outline", { limit: 2 }));
    done(await rpc.call("read_outline_entry", { number: 2 }));
    refused(await rpc.call("read_outline_entry", { number: 5 }), "not_found");
    done(await rpc.call("read_outline", { query: "keeper" }));
    const entries = (await server.mcp.audit.recent(10)).reverse();
    assert.deepEqual(entries.map((entry) => [entry.tool, entry.ok, entry.code ?? null, entry.paths ?? []]), [
      ["read_outline", true, null, ["outline/book.md", "outline/chapters/001.md", "outline/chapters/002.md"]],
      ["read_outline_entry", true, null, ["outline/chapters/002.md"]],
      ["read_outline_entry", false, "not_found", ["outline/chapters/005.md"]],
      ["read_outline", true, null, ["outline/book.md", "outline/chapters/003.md", "outline/chapters/004.md"]],
    ]);
    const log = await readFile(path.join(server.data.root, "mcp-audit.jsonl"), "utf8");
    for (const text of ["Mira meets the keeper", "A wave takes the quay", "keeper"]) assert.equal(log.includes(text), false, `the audit does not hold ${text}`);
  });
});
