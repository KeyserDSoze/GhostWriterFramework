import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// «Review and complete» (#125): the design run of a book whose chapters the author has written in the Synopsis. It never plans the book again and never writes an
// entry: it proposes what each chapter's design lacks, what does not hold together, and the canon the chapters need, reviewed by the readers and the director; the run
// stops once for the author, who applies what they choose in one commit.

const {
  AutopilotSession,
  AutopilotDesignError,
  designModeChoice,
  designProposalsChanges,
  estimateAutopilotRun,
  missingDesignKeys,
  normalizeAutopilotState,
  normalizeDesignStart,
  beginDesign,
  createAutopilotState,
  parseAutopilotState,
  parseMarkdown,
  readOutlineChapter,
  serializeAutopilotState,
  serializeOutlineChapter,
  summarizeAutopilotState,
  writeOutlineBrief,
} = engine;

const STATE = "autopilot/state.json";
const clock = () => new Date("2026-11-28T06:00:00.000Z");
const stateOf = (store) => parseAutopilotState(store.files.get(STATE));
const insights = (events, code) => events.filter((event) => event.type === "insight" && event.code === code);
const ended = (events) => events.filter((event) => event.type === "run-ended").at(-1);
const entryPath = (number) => `outline/chapters/${String(number).padStart(3, "0")}.md`;

/** A design the long paste gives an entry: seven of the seventeen fields. */
const PASTED = { goal: "Mira finds the crack.", pov: ["Mira Vale"], characters: ["Mira Vale", "Orrin Hale"], events: ["Mira dives under the wall"], conflicts: ["Mira against the tide"], ending: "She surfaces with a shard.", notes: "Keep it cold." };

/** A book whose `count` chapters the author wrote in the Synopsis: the odd ones with the pasted design, the even ones with none. */
async function writtenBook(count = 8, extra = {}) {
  const files = { ...seedBookFiles({ chapters: 0, title: "The Glass Harbor" }), ...extra };
  for (let number = 1; number <= count; number += 1) {
    files[entryPath(number)] = serializeOutlineChapter({ number, title: `The Tide ${number}`, body: `What happens in chapter ${number}: Mira follows the water.`, ...(number % 2 ? { design: PASTED } : {}), origin: "author" });
  }
  const store = new MemoryBookStore(files);
  await writeOutlineBrief(store, { idea: "A harbor town built on glass hides a lie.", genre: "mystery", audience: "adults", wordsPerScene: 200 });
  return store;
}

function session(store, ai) {
  const events = [];
  const created = new AutopilotSession({ bookId: "book", store, ai, host: "browser", hostLabel: "test", retryDelayMs: 0, now: clock });
  created.subscribe((event) => events.push(event));
  return { session: created, events };
}

async function run(store, ai, start) {
  const made = session(store, ai);
  await made.session.start(start);
  await made.session.waitForIdle();
  return { ...made, state: stateOf(store) };
}

const START = { design: { mode: "complete" }, options: { readersOnPlan: true, maxReaders: 2, pauseAfterPlan: false } };

test("the mode a design run is offered: «Review and complete» when every chapter is the author's with its text, the design that plans when one is missing or none is there", () => {
  const entry = (number, extra = {}) => ({ number, intact: false, body: `Text ${number}`, ...extra });
  assert.deepEqual(designModeChoice([entry(1), entry(2), entry(3)]), { mode: "complete", reason: "written", chapters: 3, written: [1, 2, 3], missing: [] });
  assert.deepEqual(designModeChoice([entry(1), entry(3), entry(4, { intact: true })]), { mode: "plan", reason: "missing", chapters: 4, written: [1, 3], missing: [2, 4] });
  assert.deepEqual(designModeChoice([entry(1, { body: " " })]), { mode: "plan", reason: "none", chapters: 1, written: [], missing: [1] });
  assert.deepEqual(designModeChoice([]), { mode: "plan", reason: "none", chapters: 0, written: [], missing: [] });
  assert.deepEqual(missingDesignKeys(PASTED), ["setting", "time", "scenes", "emotions", "reveals", "withholds", "clues", "previous", "next", "cliffhanger"]);
});

test("a start asks for «Review and complete» with its mode: plan is the design as it was, complete takes no number of chapters, and needs a chapter of the author's but no description", () => {
  assert.deepEqual(normalizeDesignStart({ mode: "complete", review: { maxRounds: 2 } }), { mode: "complete", review: { maxRounds: 2 } });
  assert.deepEqual(normalizeDesignStart({ mode: "plan", chapters: 4 }), { chapters: 4 });
  assert.throws(() => normalizeDesignStart({ mode: "rewrite" }), (error) => error instanceof AutopilotDesignError && error.code === "invalid_request");
  assert.throws(() => normalizeDesignStart({ mode: "complete", chapters: 3 }), (error) => error instanceof AutopilotDesignError && /Review and complete/.test(error.message));
  const state = createAutopilotState(clock());
  const begun = beginDesign(state, { mode: "complete" }, { now: clock().toISOString(), outlineChapters: 5, idea: "", authorChapters: [1, 2, 4] });
  assert.equal(begun.chapters, 5, "no entry is added");
  assert.equal(begun.state.design.mode, "complete");
  assert.deepEqual(begun.state.design.completion, { chapters: [1, 2, 4], entries: {}, canon: [], readings: [] });
  assert.equal(begun.state.plan, null, "nothing is planned");
  assert.throws(() => beginDesign(state, { mode: "complete" }, { now: clock().toISOString(), outlineChapters: 0, idea: "An idea", authorChapters: [] }), (error) => error.code === "design_no_chapters");
});

test("«Review and complete» proposes only what each author's chapter lacks, with the findings and the canon, writes nothing, and stops once for the author", async () => {
  const store = await writtenBook(8);
  const before = new Map([...store.files].filter(([path]) => path.startsWith("outline/chapters/")));
  const ai = createFakeAutopilotAi();
  const { state, events } = await run(store, ai, START);
  assert.equal(state.status, "paused", state.lastError?.message);
  assert.equal(ended(events).code, "designCompletionReady");
  assert.match(state.message, /^Review and complete is done: \d+ proposals wait for you in the Studio, for 8 chapters\. Choose what to apply\.$/);
  // No concept, no plan: the proposals of two batches, the two readers, the director.
  assert.deepEqual(ai.calls.map((call) => call.json?.name ?? "prose"), ["chapter_completion", "chapter_completion", "completion_reading", "completion_reading", "completion_review"]);
  assert.match(ai.calls[0].user, /Review and complete the design of chapters 1, 2, 3, 4, 5, 6 \(THE CHAPTERS TO COMPLETE/);
  assert.match(ai.calls[1].user, /chapters 7, 8 \(THE CHAPTERS TO COMPLETE/);
  assert.match(ai.calls[0].user, /MISSING FIELDS: setting, time, scenes, emotions, reveals, withholds, clues, previous, next, cliffhanger/);
  assert.match(ai.calls[0].system, /you never rewrite them/);
  assert.match(ai.calls[1].user, /THE CHAPTER BEFORE — Chapter 6 «The Tide 6»:\nWhat happens in chapter 6/);
  assert.equal(state.plan, null);
  assert.equal(state.concept.done, false);
  // Nothing of the book changed: the entries are as the author wrote them, and nothing else was created.
  for (const [path, content] of before) assert.equal(store.files.get(path), content, path);
  assert.equal([...store.files.keys()].filter((path) => /^(characters|chapters|secrets|bible)\//.test(path)).length, 0);
  // What it proposes: the missing fields only.
  const design = state.design;
  assert.equal(design.mode, "complete");
  assert.equal(design.outcome, "target");
  assert.equal(state.options.pauseAfterPlan, false, "the author's setting is given back");
  const one = design.completion.entries["1"];
  assert.deepEqual(one.fields.map((field) => field.key), missingDesignKeys(PASTED));
  assert.ok(one.fields.every((field) => field.status === "waiting"));
  assert.equal(design.completion.entries["2"].fields.length, 17, "a chapter with no design is proposed all of it");
  assert.equal(one.digest, (await readOutlineChapter(entryPath(1), 1, before.get(entryPath(1)))).entry.contentDigest);
  assert.deepEqual([...new Set(one.findings.map((finding) => finding.source))].sort(), ["architect", "director", "reader"]);
  const critical = one.findings.find((finding) => finding.source === "director");
  assert.deepEqual({ severity: critical.severity, criterion: critical.criterion, text: critical.text }, { severity: "critical", criterion: "coherence", text: "Mira knows about the wall before anyone tells her." });
  assert.deepEqual(design.completion.canon.map((entry) => [entry.kind, entry.name, entry.chapters]), [["character", "Tessa Lune", [1]]]);
  assert.deepEqual(design.completion.readings.map((reading) => [reading.round, reading.score]), [[1, 7], [1, 7]]);
  assert.deepEqual(design.rounds.map((round) => [round.round, round.score, round.verdict, round.readers, round.critical]), [[1, 8, "approve", 7, 1]]);
  assert.equal(design.completion.awaitingAuthor, true);
  const summary = summarizeAutopilotState(state).design;
  assert.equal(summary.mode, "complete");
  assert.deepEqual(summary.proposals, { waiting: summary.proposals.waiting, chapters: 8 });
  assert.ok(summary.proposals.waiting > 100);
  assert.equal(insights(events, "designCompletionReady").length, 1);
  // The state keeps it as it is.
  assert.deepEqual(normalizeAutopilotState(JSON.parse(serializeAutopilotState(state))).design, state.design);
});

test("the next start goes on past the stop, and a start that is not a design writes the book with the author's entries as they are", async () => {
  const store = await writtenBook(2);
  const ai = createFakeAutopilotAi();
  const first = await run(store, ai, START);
  assert.equal(first.state.design.completion.awaitingAuthor, true);
  const second = await run(store, ai, { options: { pauseAfterPlan: true } });
  assert.equal(second.state.design.completion.awaitingAuthor, undefined);
  assert.notEqual(ended(second.events).code, "designCompletionReady");
  assert.ok(ai.calls.some((call) => call.json?.name === "book_concept"), "the writing autopilot begins with its concept");
});

test("the director sends back the proposals that do not fit: those chapters are proposed again with the director's words, the readers read again in the reviews the policy says", async () => {
  const store = await writtenBook(8);
  const ai = createFakeAutopilotAi({
    completionReview: (round) => round === 1
      ? { verdict: "revise", score: 6, summary: "Two proposals miss.", findings: [], redo: [{ chapterNumber: 7, instruction: "The setting must be the lighthouse, as the text says." }, { chapterNumber: 99, instruction: "Not a chapter." }] }
      : { verdict: "approve", score: 8.5, summary: "Now they fit.", findings: [], redo: [] },
  });
  const { state, events } = await run(store, ai, { design: { mode: "complete", review: { targetScore: 8, maxRounds: 3, readerRounds: 2 } }, options: { readersOnPlan: true, maxReaders: 1, pauseAfterPlan: false } });
  assert.equal(state.design.outcome, "target", state.lastError?.message);
  assert.deepEqual(ai.calls.map((call) => call.json?.name), ["chapter_completion", "chapter_completion", "completion_reading", "completion_review", "chapter_completion", "completion_reading", "completion_review"]);
  const again = ai.calls[4];
  assert.match(again.user, /Review and complete the design of chapter 7 \(THE CHAPTERS TO COMPLETE/);
  assert.match(again.user, /THE DIRECTOR SENT THESE BACK:\nChapter 7 «The Tide 7»:\n- The setting must be the lighthouse, as the text says\./);
  assert.match(ai.calls[6].user, /review 2 of at most 3/);
  assert.deepEqual(state.design.rounds.map((round) => [round.score, round.verdict]), [[6, "revise"], [8.5, "approve"]]);
  assert.equal(state.design.completion.redo, undefined);
  assert.equal(insights(events, "designRound").length, 1);
});

test("applying writes only the chosen fields where the entry still lacks them, the findings as notes, the canon as drafts, and the journal by the autopilot; the author's text never changes", async () => {
  const store = await writtenBook(3);
  const ai = createFakeAutopilotAi();
  const { session: author, state } = await run(store, ai, { ...START, options: { ...START.options, readersOnPlan: false } });
  const completion = state.design.completion;
  // Meanwhile the author writes the setting of chapter 2 by hand.
  const two = (await readOutlineChapter(entryPath(2), 2, store.files.get(entryPath(2)))).entry;
  await store.commit([{ path: entryPath(2), content: serializeOutlineChapter({ number: 2, title: two.title, body: two.body, design: { setting: "The author's lighthouse" }, origin: "author", frontmatter: two.frontmatter }), expectedHash: two.hash }], "The author writes a setting");
  const director = completion.entries["1"].findings.find((finding) => finding.source === "director");
  const architect = completion.entries["3"].findings.find((finding) => finding.source === "architect");
  const chosen = ["f1-setting", "f1-cliffhanger", "f2-setting", "f2-goal", director.id, architect.id, completion.canon[0].id];
  const result = await author.applyDesignProposals({ run: state.design.startedAt, apply: chosen });
  assert.deepEqual({ applied: result.applied, outdated: result.outdated, chapters: result.chapters, created: result.created }, { applied: 6, outdated: 1, chapters: [1, 2, 3], created: ["characters/tessa-lune.md"] });
  const read = async (number) => (await readOutlineChapter(entryPath(number), number, store.files.get(entryPath(number)))).entry;
  const [first, second, third] = await Promise.all([read(1), read(2), read(3)]);
  // Chapter 1: the two fields chosen, the director's finding after the notes there; the rest of its design, its title and its text as they were.
  assert.equal(first.origin, "author");
  assert.equal(first.title, "The Tide 1");
  assert.equal(first.body, "What happens in chapter 1: Mira follows the water.");
  assert.equal(first.design.setting, "Proposed setting of chapter 1.");
  assert.equal(first.design.cliffhanger, true);
  assert.equal(first.design.time, undefined, "a field not chosen is not written");
  assert.equal(first.design.goal, PASTED.goal);
  assert.equal(first.design.notes, "Keep it cold.\nReview (the director): Mira knows about the wall before anyone tells her. — Let her overhear it first.");
  // Chapter 2: the setting the author wrote meanwhile stays; the goal is written.
  assert.equal(second.design.setting, "The author's lighthouse");
  assert.equal(second.design.goal, "Proposed goal of chapter 2.");
  assert.equal(third.design.notes, "Keep it cold.\nReview (the architect): Chapter 3 lingers before its turn. — Cut the first beat.");
  const character = parseMarkdown(store.files.get("characters/tessa-lune.md"));
  assert.deepEqual([character.frontmatter.type, character.frontmatter.name, character.frontmatter.canon], ["character", "Tessa Lune", "draft"]);
  assert.match(character.body, /The lighthouse keeper's niece, who saw the crack\./);
  // The journal of the Synopsis: one series, by the autopilot.
  const journal = store.files.get("outline/changes.yml");
  assert.match(journal, /by: autopilot/);
  assert.match(journal, /note: "Review and complete: 6 proposals applied"/);
  assert.equal([...journal.matchAll(/chapter: \d+/g)].length, 3);
  // The state: every proposal decided, the decision kept, nothing waits.
  const after = stateOf(store);
  const decided = after.design.completion;
  assert.equal(decided.decided.applied, 6);
  assert.equal(decided.decided.skipped, 36, "37 fields, 4 findings and a character proposed; 6 applied");
  assert.ok(Object.values(decided.entries).every((entry) => [...entry.fields, ...entry.findings].every((item) => item.status !== "waiting")));
  assert.equal(decided.entries["2"].fields.find((field) => field.key === "setting").status, "skipped");
  assert.equal(decided.awaitingAuthor, undefined);
  assert.deepEqual(summarizeAutopilotState(after).design.proposals, { waiting: 0, chapters: 0 });
  // Once decided, nothing waits; another run's proposals are stale.
  await assert.rejects(author.applyDesignProposals({ run: state.design.startedAt, apply: [] }), (error) => error instanceof AutopilotDesignError && error.code === "no_proposals");
});

test("a decision is checked: another run's is stale, an id that is not a proposal that waits is refused, and nothing is written", async () => {
  const store = await writtenBook(1);
  const { session: author, state } = await run(store, createFakeAutopilotAi(), { ...START, options: { ...START.options, readersOnPlan: false } });
  const files = new Map(store.files);
  await assert.rejects(author.applyDesignProposals({ run: "2020-01-01T00:00:00.000Z", apply: [] }), (error) => error.code === "stale");
  await assert.rejects(author.applyDesignProposals({ run: state.design.startedAt, apply: ["f1-unknown"] }), (error) => error.code === "invalid_request");
  await assert.rejects(author.applyDesignProposals({ run: state.design.startedAt }), (error) => error.code === "invalid_request");
  assert.deepEqual(new Map(store.files), files);
  // Leaving everything out is a decision too: nothing is written but the state.
  const result = await author.applyDesignProposals({ run: state.design.startedAt, apply: [] });
  assert.equal(result.applied, 0);
  assert.deepEqual([...store.files.keys()].filter((path) => store.files.get(path) !== files.get(path)), [STATE]);
});

test("the pure apply leaves an entry that is no longer the author's as it is, and an entity the canon has now is not created twice", async () => {
  const state = createAutopilotState(clock());
  state.design = {
    startedAt: "2026-11-28T05:00:00.000Z", chapters: 2, rounds: [], endedAt: "2026-11-28T05:30:00.000Z", outcome: "target", mode: "complete",
    completion: {
      chapters: [1, 2],
      entries: {
        1: { number: 1, title: "One", digest: "0123456789abcdef", fields: [{ id: "f1-goal", key: "goal", value: "A goal.", status: "waiting" }], findings: [] },
        2: { number: 2, title: "Two", digest: "0123456789abcdef", fields: [{ id: "f2-goal", key: "goal", value: "A goal.", status: "waiting" }], findings: [] },
      },
      canon: [{ id: "c-character-orrin-hale", kind: "character", name: "Orrin Hale", description: "x", chapters: [1], status: "waiting" }],
      readings: [],
    },
  };
  const entries = [
    { number: 1, path: entryPath(1), title: "One", body: "Text", origin: "autopilot", contentDigest: "aaaaaaaaaaaaaaaa", intact: true, frontmatter: {} },
    { number: 2, path: entryPath(2), title: "Two", body: "Text", origin: "author", contentDigest: "bbbbbbbbbbbbbbbb", intact: false, frontmatter: {}, hash: "h2" },
  ];
  const snapshot = { canon: [{ kind: "character", name: "Orrin Hale", aliases: [] }], files: new Map() };
  const { changes, result, state: next } = await designProposalsChanges({ state, decision: { run: state.design.startedAt, apply: ["f1-goal", "f2-goal", "c-character-orrin-hale"] }, entries, snapshot, journal: null, now: clock(), language: "it" });
  assert.deepEqual(changes.map((change) => change.path), [entryPath(2), "outline/changes.yml"]);
  assert.deepEqual({ applied: result.applied, outdated: result.outdated }, { applied: 1, outdated: 2 });
  assert.match(changes[1].content, /note: "Rivedi e completa: una proposta applicata"/);
  assert.equal(next.design.completion.entries["1"].fields[0].status, "skipped");
  assert.equal(next.design.endedAt, "2026-11-28T05:30:00.000Z");
});

test("the estimate of «Review and complete»: no concept and no plan, a call for each batch of the author's chapters, the readers, the director's reviews", () => {
  const input = { language: "en", outline: { entries: 37, lastChapter: 37, words: 37 * 300 }, options: { readersOnPlan: true, maxReaders: 2 }, readerPanelSize: 8, design: { mode: "complete", maxRounds: 3, readerRounds: 1 } };
  const estimate = estimateAutopilotRun(input);
  assert.deepEqual(estimate.steps.concept.calls, { min: 0, max: 0 });
  assert.deepEqual(estimate.steps.plan.calls, { min: 7, max: 21 }, "seven batches, asked again at most twice");
  assert.deepEqual(estimate.steps["plan-reader"].calls, { min: 2, max: 2 });
  assert.deepEqual(estimate.steps["plan-review"].calls, { min: 1, max: 3 });
  assert.deepEqual(estimate.steps.write.calls, { min: 0, max: 0 });
  assert.ok(estimate.assumptions.some((line) => /^Review and complete reads 37 chapters you wrote, 6 a call/.test(line)), estimate.assumptions.join("\n"));
  const plan = estimateAutopilotRun({ ...input, design: { maxRounds: 3, readerRounds: 1 } });
  assert.equal(plan.steps.concept.calls.max, 1, "a design that plans the book makes its concept");
});

test("«Review and complete» goes only to a personal server that announces autopilot-design-complete; the mode of a plan is not sent to an older one", async () => {
  assert.equal(engine.SERVER_FEATURE_AUTOPILOT_DESIGN_COMPLETE, "autopilot-design-complete");
  assert.equal(engine.serverSupportsDesignComplete({ features: ["autopilot-design-complete"] }), true);
  for (const odd of [null, undefined, {}, { features: "autopilot-design-complete" }, ["autopilot-design"]]) assert.equal(engine.serverSupportsDesignComplete(odd), false, JSON.stringify(odd));
  const serverWith = (features) => {
    const log = [];
    const fetch = async (input, init = {}) => {
      const url = new URL(input);
      log.push({ method: init.method ?? "GET", path: url.pathname, body: init.body === undefined ? undefined : JSON.parse(init.body) });
      if (url.pathname === "/api/v1/info") return Response.json({ name: "narrarium-server", apiVersion: 1, serverVersion: "0.1.24", engineVersion: "0.1.29", serverId: "s", label: "Test", git: true, features, publicKey: "k", fingerprint: "f", supervised: false });
      if (url.pathname.endsWith("/design/proposals")) return Response.json({ applied: 1, skipped: 0, outdated: 0, chapters: [1], created: [] });
      return Response.json({ bookId: "b", state: null, summary: null, activities: [], live: null, running: true, host: "server" });
    };
    return { log, client: new engine.NarrariumServerClient({ baseUrl: "http://127.0.0.1:24242", token: "nrs_me", fetch }) };
  };
  const old = serverWith(["autopilot", "autopilot-outline-brief", "autopilot-design"]);
  const refused = await old.client.startAutopilot("b", { design: { mode: "complete" } }).then(() => null, (failure) => failure);
  assert.deepEqual([refused?.status, refused?.code], [501, "feature_unavailable"]);
  const notApplied = await old.client.applyDesignProposals("b", { run: "r", apply: [] }).then(() => null, (failure) => failure);
  assert.equal(notApplied?.code, "feature_unavailable");
  assert.deepEqual(old.log.map((request) => request.path).filter((path) => path !== "/api/v1/info"), [], "nothing is sent but the question of the features");
  await old.client.startAutopilot("b", { design: { mode: "plan", chapters: 6 } });
  assert.deepEqual(old.log.at(-1).body, { design: { chapters: 6 } }, "an older server is asked the design as it always was");
  const current = serverWith(["autopilot", "autopilot-outline-brief", "autopilot-design", "autopilot-design-complete"]);
  await current.client.startAutopilot("b", { design: { mode: "complete", review: { maxRounds: 2 } } });
  assert.deepEqual(current.log.at(-1).body, { design: { mode: "complete", review: { maxRounds: 2 } } });
  const applied = await current.client.applyDesignProposals("b", { run: "r", apply: ["f1-goal"] });
  assert.equal(applied.applied, 1);
  assert.deepEqual(current.log.at(-1), { method: "POST", path: "/api/v1/books/b/autopilot/design/proposals", body: { run: "r", apply: ["f1-goal"] } });
});

test("a locked decision of the author holds what it covers when the proposals are applied: those are left out and said, the others are written, and every step is told the decision", async () => {
  const locked = engine.setDecisionStatus(engine.captureDecision(null, { decision: "Chapter 2 stays as it is.", reason: "The author's choice.", chapters: [2] }, clock()).content, "d-001", "locked");
  const store = await writtenBook(2, { [engine.BIBLE_DECISIONS_FILE]: locked });
  const ai = createFakeAutopilotAi();
  const { session: author, state } = await run(store, ai, { ...START, options: { ...START.options, readersOnPlan: false } });
  for (const call of ai.calls) assert.match(call.user + call.system, /LOCKED DECISIONS[\s\S]*d-001: Chapter 2 stays as it is\./, call.label);
  const before = store.files.get(entryPath(2));
  const result = await author.applyDesignProposals({ run: state.design.startedAt, apply: ["f1-setting", "f2-goal"] });
  assert.deepEqual({ applied: result.applied, outdated: result.outdated, chapters: result.chapters }, { applied: 1, outdated: 1, chapters: [1] });
  assert.equal(result.held.length, 1);
  assert.match(result.held[0], /Chapter 2 stays as it is/);
  assert.equal(store.files.get(entryPath(2)), before, "the entry the decision covers is not written");
  assert.equal((await readOutlineChapter(entryPath(1), 1, store.files.get(entryPath(1)))).entry.design.setting, "Proposed setting of chapter 1.");
});
