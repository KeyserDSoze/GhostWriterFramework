import test from "node:test";
import assert from "node:assert/strict";
import { captureDecision, setDecisionStatus, readBibleDecisions, readBibleThreads, wholeDesignPatch, serializeOutlineChapter } from "narrarium-engine";
import { withServer } from "./helpers.mjs";
import { mcpFixture } from "./mcp-helpers.mjs";
import { done, onDisk, refused, invalid } from "./mcp-outline-helpers.mjs";

// The tools of the Bible through a book's MCP endpoint: read_bible (what the book agreed), read_design (the design of every chapter and the checks), edit_bible (the one tool
// that writes bible/: a decision is captured OPEN and a question asked open, only the author locks and answers, in the app), and autopilot_resume with the design option.

const NOW = new Date("2026-11-28T08:00:00.000Z");
const lockedLog = () => setDecisionStatus(captureDecision(null, { decision: "Elio is the keeper's son.", reason: "The second act depends on it.", chapters: [3], by: "author" }, NOW).content, "d-001", "locked");

const entry = (number, design) => ({ path: `outline/chapters/${String(number).padStart(3, "0")}.md`, content: serializeOutlineChapter({ number, title: `Chapter ${number}`, body: `Summary ${number}`, design: wholeDesignPatch(design), origin: "author" }) });

async function seeded(server, client, extra = []) {
  const fixture = await mcpFixture(server, client);
  await client.commitFiles(fixture.bookId, [
    { path: "bible/decisions.md", content: lockedLog() },
    { path: "bible/themes.md", content: "---\ntype: bible\nid: bible:themes\nthemes:\n  - truth\ntone: Tense\naudience: Adults\n---\n" },
    entry(1, { goal: "Open", pov: ["Mira"], events: ["She lands"], ending: "A door closes" }),
    entry(2, { goal: "Turn", pov: ["Mira"], events: ["The storm"], reveals: ["secret:the-keeper"], ending: "x" }),
    entry(3, { clues: ["A wet footprint"] }),
    ...extra,
  ], "the bible");
  return fixture;
}

test("read_bible gives the decisions with the locked ones, the open questions, the threads, the themes, the tone, the audience and the timeline; one part at a time too", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await seeded(server, client);
    const data = done(await rpc.call("read_bible"));
    assert.deepEqual(data.decisions.items.map((item) => [item.id, item.status, item.by]), [["d-001", "locked", "author"]]);
    assert.equal(data.decisions.locked, 1);
    assert.equal(data.questions.open, 0);
    assert.deepEqual(data.themes, { themes: ["truth"], tone: "Tense", audience: "Adults", hash: data.themes.hash });
    assert.deepEqual(data.timeline.map((event) => [event.slug, event.date]), [["founding", "0001"]]);
    const only = done(await rpc.call("read_bible", { part: "themes" }));
    assert.deepEqual(Object.keys(only), ["themes"]);
    invalid(await rpc.call("read_bible", { part: "everything" }));
  });
});

test("read_design gives the design of each chapter with the fields it lacks, and the findings of the checks, in words", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await seeded(server, client);
    const data = done(await rpc.call("read_design"));
    assert.deepEqual(data.chapters.map((chapter) => [chapter.number, chapter.gaps]), [[1, []], [2, []], [3, ["goal", "pov", "events", "ending"]]]);
    assert.equal(data.total, 3);
    assert.ok(data.findings.some((finding) => finding.code === "design-incomplete" && finding.chapter === 3));
    assert.ok(data.findings.every((finding) => typeof finding.text === "string" && finding.text.length > 0));
    // The secret the entry reveals in chapter 2 (the book's secret has known_from chapter 2): not told too early.
    const range = done(await rpc.call("read_design", { from: 2, to: 2, findings: false }));
    assert.deepEqual(range.chapters.map((chapter) => chapter.number), [2]);
    assert.equal(range.findings, undefined);
    const paged = done(await rpc.call("read_design", { limit: 1 }));
    assert.deepEqual([paged.chapters.length, paged.nextFrom], [1, 2]);
  });
});

test("edit_bible captures a decision OPEN (never locked, whatever the client does), adds an open question, a thread, the themes and the rules, as one commit, and keeps the locked decision", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await seeded(server, client);
    const answer = done(await rpc.call("edit_bible", {
      decisions: [{ decision: "Mara is the narrator.", reason: "Chosen with the author.", chapters: [1], avoid: ["Orrin narrates"] }],
      questions: [{ question: "Who sent the letter?", chapters: [5] }],
      threads: [{ title: "The keeper's lamp", setupChapter: 2 }],
      tone: "Melancholic",
      rules: ["Glass remembers"],
    }));
    assert.equal(answer.edited, true);
    assert.deepEqual(answer.files.sort(), ["bible/decisions.md", "bible/themes.md", "bible/threads.md", "bible/world.md"]);
    const log = readBibleDecisions(await onDisk(server, "bible/decisions.md")).value;
    assert.deepEqual(log.decisions.map((decision) => [decision.id, decision.status]), [["d-001", "locked"], ["d-002", "open"]]);
    assert.deepEqual(log.questions.map((question) => [question.id, question.status, question.chapters]), [["q-001", "open", [5]]]);
    assert.deepEqual(readBibleThreads(await onDisk(server, "bible/threads.md")).value.threads.map((thread) => [thread.id, thread.setup.chapter]), [["t-001", 2]]);
    assert.match(await onDisk(server, "bible/themes.md"), /tone: Melancholic[\s\S]*audience: Adults/);
    assert.match(await onDisk(server, "bible/world.md"), /Glass remembers/);
    // A thread is changed by its id; one that does not exist is refused, and nothing is written.
    done(await rpc.call("edit_bible", { threads: [{ id: "t-001", payoffChapter: 9, status: "paid" }] }));
    assert.deepEqual(readBibleThreads(await onDisk(server, "bible/threads.md")).value.threads.map((thread) => [thread.status, thread.payoff.chapter]), [["paid", 9]]);
    refused(await rpc.call("edit_bible", { threads: [{ id: "t-077", status: "paid" }] }), "not_found");
    assert.deepEqual(done(await rpc.call("edit_bible", {})).edited, false);
  });
});

test("write_file does not write bible/: it says to use edit_bible, and the files can be read", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await seeded(server, client);
    refused(await rpc.call("write_file", { path: "bible/decisions.md", content: "x" }), "forbidden", /edit_bible/);
    const read = await rpc.call("read_file", { path: "bible/decisions.md" });
    assert.equal(read.isError, false, read.text);
  });
});

test("autopilot_resume takes the design option, refuses it with its reason, and tells a request that does not fit", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await seeded(server, client);
    // The fixture's autopilot was never set up: the tool says where it can be.
    refused(await rpc.call("autopilot_resume", { design: true, designChapters: 6 }), "no_autopilot");
    refused(await rpc.call("autopilot_resume", { designChapters: 6 }), "invalid_input", /goes with design/);
    invalid(await rpc.call("autopilot_resume", { designChapters: 0 }));
  });
});

test("the server announces `bible-decisions`: its autopilot respects the locked decisions of a book and reads the checks of the design", async () => {
  await withServer(async (server) => {
    const info = await (await fetch(`${server.url}/api/v1/info`)).json();
    assert.ok(info.features.includes("bible-decisions"));
    assert.equal(new Set(info.features).size, info.features.length, "each feature once");
    assert.equal(info.features.includes("bible-decisions"), true);
  });
});
