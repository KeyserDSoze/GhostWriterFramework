import test from "node:test";
import assert from "node:assert/strict";
import { OUTLINE_BRIEF_FILE, parseMarkdown } from "narrarium-engine";
import { withServer } from "./helpers.mjs";
import { finished, seededBook } from "./fake-provider.mjs";
import { done, entryFile, invalid, onDisk, outlineFixture, refused, sha } from "./mcp-outline-helpers.mjs";

// The brief of a book lives in the Scaletta, in `outline/_brief.md`: the HTTP routes that set it write that file, the MCP tools show it, and
// no tool counts it as a chapter. These tests are about the routes, the MCP reads, and what the outline tools leave of the file.

const BRIEF = { idea: "A glassmaker's daughter exposes the harbor's lie.", genre: "Mystery", audience: "Adults", wordsPerScene: 900, synopsis: "1. Mira arrives.\n2. The storm breaks the wall." };

test("the configure route writes the brief into outline/_brief.md, and the state takes what the file has", async () => {
  await withServer(async (server, client) => {
    const bookId = await seededBook(client, "b");
    const configured = await client.configureAutopilot(bookId, { brief: { ...BRIEF, targetChapters: 12, scenesPerChapter: 3 } });
    assert.equal(configured.state.brief.idea, BRIEF.idea);
    assert.equal(configured.state.brief.wordsPerScene, 900);
    assert.equal(configured.state.brief.targetChapters, undefined, "the number of chapters is not a brief's field any more");

    const file = parseMarkdown(await onDisk(server, OUTLINE_BRIEF_FILE, bookId));
    assert.equal(file.frontmatter.type, "outline-brief");
    assert.equal("idea" in file.frontmatter, false, "the idea is the description of the book, not a key of the brief");
    assert.equal(parseMarkdown(await onDisk(server, "outline/book.md", bookId)).body, BRIEF.idea, "the idea is the body of outline/book.md");
    assert.equal(file.frontmatter.genre, "Mystery");
    assert.equal(file.frontmatter.audience, "Adults");
    assert.equal(file.frontmatter.wordsPerScene, 900);
    assert.equal(file.body, BRIEF.synopsis, "the synopsis is the body of the file");
  });
});

test("the configure route without a brief keeps the brief the file has, and a second brief is merged with the fields it gives", async () => {
  await withServer(async (server, client) => {
    const bookId = await seededBook(client, "b");
    await client.configureAutopilot(bookId, { brief: BRIEF });
    const kept = await client.configureAutopilot(bookId, { options: { pauseAfterPlan: false } });
    assert.equal(kept.state.brief.idea, BRIEF.idea);
    const merged = await client.configureAutopilot(bookId, { brief: { genre: "Thriller" } });
    assert.equal(merged.state.brief.genre, "Thriller");
    assert.equal(merged.state.brief.idea, BRIEF.idea, "the other fields are what they were");
    assert.equal(merged.state.brief.synopsis, BRIEF.synopsis);
  });
});

test("read_outline shows the brief and the chapters of the Scaletta, and never lists the brief as a chapter", async () => {
  await withServer(async (server, client) => {
    const { rpc, bookId } = await outlineFixture(server, client);
    await client.configureAutopilot(bookId, { brief: BRIEF });
    const data = done(await rpc.call("read_outline"));
    assert.equal(data.brief.path, OUTLINE_BRIEF_FILE);
    assert.equal(data.brief.present, true);
    assert.equal(data.brief.idea, BRIEF.idea);
    assert.equal(data.brief.genre, "Mystery");
    assert.equal(data.brief.audience, "Adults");
    assert.equal(data.brief.wordsPerScene, 900);
    assert.equal(data.brief.synopsisExcerpt, BRIEF.synopsis);
    assert.equal(data.brief.synopsisLength, BRIEF.synopsis.length);
    assert.equal(data.brief.chapters, 5, "the chapters are the entries of the Scaletta");
    assert.equal(data.outline.entries, 5, "the brief is not one of the entries");
    assert.equal(data.total, 5);
    assert.ok(data.entries.every((entry) => !entry.path.endsWith("_brief.md")), "no entry is the brief");
    assert.equal(data.warnings.some((warning) => (warning.path ?? "").includes("_brief")), false, "the brief is not a file the outline says is odd");
  });
});

test("read_outline of a book with no brief file says so, with the defaults, and counts no chapter for it", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await outlineFixture(server, client);
    const answer = await rpc.call("read_outline");
    const data = done(answer);
    assert.equal(data.brief.present, false);
    assert.equal(data.brief.idea, answer.blocks[1].text, "the description of the book is the idea, though there is no brief file");
    assert.equal(data.brief.wordsPerScene, 1400);
    assert.equal(data.brief.chapters, 5);
  });
});

test("autopilot_status shows the brief next to the state of the run", async () => {
  await withServer(async (server, client) => {
    const { rpc, bookId } = await outlineFixture(server, client);
    await client.configureAutopilot(bookId, { brief: BRIEF });
    const status = done(await rpc.call("autopilot_status"));
    assert.equal(status.brief.idea, BRIEF.idea);
    assert.equal(status.brief.genre, "Mystery");
    assert.equal(status.brief.wordsPerScene, 900);
    assert.equal(status.brief.synopsisExcerpt, BRIEF.synopsis);
    assert.equal(status.brief.chapters, 5);
    assert.equal(status.running, false, "the run itself is as it was: nothing has been started");
  });
});

test("write_file refuses the brief, and edit_outline never deletes, renumbers or moves it", async () => {
  await withServer(async (server, client) => {
    const { rpc, bookId } = await outlineFixture(server, client);
    await client.configureAutopilot(bookId, { brief: BRIEF });
    const before = sha(await onDisk(server, OUTLINE_BRIEF_FILE, bookId));

    refused(await rpc.call("write_file", { path: OUTLINE_BRIEF_FILE, content: "---\ntype: outline-brief\nidea: by hand\n---\n\nx\n" }), "forbidden", /edit_outline/);
    assert.equal(sha(await onDisk(server, OUTLINE_BRIEF_FILE, bookId)), before, "a file written by hand is refused: the brief is as it was");

    const first = done(await rpc.call("read_outline_entry", { number: 1 }));
    const answer = await rpc.call("edit_outline", { edits: [
      { kind: "remove", number: 1, renumber: true, expectedHash: first.hash },
      { kind: "insert", at: 1, title: "Prologue" },
      { kind: "move", from: 2, to: 4 },
      { kind: "append", title: "Coda" },
    ] });
    done(answer);
    assert.equal(sha(await onDisk(server, OUTLINE_BRIEF_FILE, bookId)), before, "the brief survives every edit of the Scaletta");
    const again = done(await rpc.call("read_outline"));
    assert.equal(again.brief.idea, BRIEF.idea);
    assert.equal(again.brief.present, true);
    assert.ok(again.entries.every((entry) => !entry.path.endsWith("_brief.md")));
  });
});

test("search_book never finds the brief: its words are not a chapter, a scene or canon", async () => {
  await withServer(async (server, client) => {
    const { rpc, bookId } = await outlineFixture(server, client);
    await client.configureAutopilot(bookId, { brief: { ...BRIEF, idea: "zebrafish wreck" } });
    const answer = done(await rpc.call("search_book", { query: "zebrafish wreck" }));
    assert.equal(answer.results.some((result) => String(result.path ?? "").includes("_brief")), false);
    assert.equal(answer.total, 0, JSON.stringify(answer.results.map((result) => result.path)));
  });
});

test("the start route accepts the brief too, and writes it before the run starts", async () => {
  await withServer(async (server, client) => {
    const bookId = await seededBook(client, "b");
    await client.commitFiles(bookId, [entryFile(1, { title: "Arrival", body: "Mira arrives at dusk." })], "the outline");
    await client.startAutopilot(bookId, { brief: { ...BRIEF }, options: { readers: false, readersOnPlan: false, pauseAfterPlan: true, specialists: false } });
    await finished(client, bookId);
    assert.equal(parseMarkdown(await onDisk(server, "outline/book.md", bookId)).body, BRIEF.idea, "the idea is in the description of the book, not only in the state");
  });
});

test("a 12 000-character idea sent to the configure route is the description of the book, whole", async () => {
  await withServer(async (server, client) => {
    const bookId = await seededBook(client, "b");
    const idea = `Idea, promise or pitch.\n\n${"Mira keeps the light alive while the harbor forgets the storm. ".repeat(200)}`.slice(0, 12_000).trimEnd();
    assert.equal(idea.length >= 11_990, true);
    const configured = await client.configureAutopilot(bookId, { brief: { idea } });
    assert.equal(configured.state.brief.idea, idea);
    assert.equal(parseMarkdown(await onDisk(server, "outline/book.md", bookId)).body, idea);
  });
});

test("an idea over the limit sent to the configure route is refused with 413 text_too_long, and nothing is written", async () => {
  await withServer(async (server, client) => {
    const bookId = await seededBook(client, "b");
    await client.configureAutopilot(bookId, { brief: { idea: "The first idea.", genre: "Thriller" } });
    const before = await onDisk(server, "outline/book.md", bookId);
    const briefBefore = await onDisk(server, OUTLINE_BRIEF_FILE, bookId);
    const tooLong = "x".repeat(1_000_001);
    await assert.rejects(() => client.configureAutopilot(bookId, { brief: { idea: tooLong, genre: "Noir" } }), (error) => {
      assert.equal(error.status, 413);
      assert.equal(error.code, "text_too_long");
      assert.match(error.message, /1000001 characters/);
      return true;
    });
    assert.equal(await onDisk(server, "outline/book.md", bookId), before, "the description is as it was");
    assert.equal(await onDisk(server, OUTLINE_BRIEF_FILE, bookId), briefBefore, "the brief is as it was: not even the genre of the refused request");
  });
});

test("edit_outline refuses a description over the text limit of the MCP tools, as a schema error, and writes nothing", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await outlineFixture(server, client);
    const before = await onDisk(server, "outline/book.md");
    invalid(await rpc.call("edit_outline", { edits: [{ kind: "book", body: "y".repeat(400_001) }] }));
    assert.equal(await onDisk(server, "outline/book.md"), before, "the description is as it was");
  });
});
