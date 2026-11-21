import test from "node:test";
import assert from "node:assert/strict";
import {
  AiProviderError,
  AiReplyRejectedError,
  AutopilotSession,
  advanceState,
  applyIntervention,
  askDirector,
  containsName,
  createAutopilotState,
  defaultDirector,
  mentionedCanon,
  normalizeAutopilotState,
  parseAutopilotState,
  parseMarkdown,
  parseTotalResume,
  pruneStorySnapshots,
  readStorySoFar,
  readStoredAutopilot,
  renderTotalResumeBody,
  retryNoteFor,
  sameCanonEntity,
  storySoFarBefore,
} from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

const FAST = { readers: false, readersOnPlan: false, pauseAfterPlan: false };

function reply(json, extra = {}) {
  return { text: JSON.stringify(json), json, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }, model: "fake-model", provider: "fake", cost: 0.001, currency: "USD", ...extra };
}

/** The fake AI, with some replies replaced: `script` returns undefined (default reply), an Error, or a response. */
function scripted(script, options = {}) {
  const base = createFakeAutopilotAi(options);
  return {
    calls: base.calls,
    async complete(request) {
      const seen = base.calls.filter((call) => call.label === request.label).length;
      const custom = script(request, seen);
      if (custom === undefined) return base.complete(request);
      base.calls.push(request);
      if (custom instanceof Error) throw custom;
      return custom;
    },
  };
}

async function run(store, ai, start) {
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0 });
  session.subscribe((event) => events.push(event));
  await session.start(start);
  await session.waitForIdle();
  return { state: (await session.snapshot()).state, events, session };
}

const ONE_CHAPTER = { brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: FAST };

test("a director review without decisions is rejected and retried with the reason, never approved by default", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = scripted((request, seen) => request.label === "autopilot:director-review:1" && seen === 0
    ? reply({ verdict: "approve", score: 9, summary: "Fine.", strengths: [], decisions: [], extraFixes: [], guidance: [] })
    : undefined);
  const { state, events } = await run(store, ai, ONE_CHAPTER);
  assert.equal(state.status, "completed");
  const reviews = ai.calls.filter((call) => call.label === "autopilot:director-review:1");
  assert.ok(reviews.length >= 2);
  assert.doesNotMatch(reviews[0].user, /previous reply/);
  assert.match(reviews[1].user, /The previous reply to this request was rejected because: The director's chapter review was rejected: the field "decisions" is missing or empty, but 1 findings need a decision \(S1-1\)/);
  assert.ok(events.some((event) => event.type === "insight" && event.code === "failureRetry"));
  const { activities } = await readStoredAutopilot(store);
  const failed = activities.find((activity) => activity.status === "failed");
  assert.equal(failed.task, "director-review");
  assert.equal(failed.model, "fake-model", "the rejected reply's usage is recorded on the failed activity");
  assert.equal(failed.cost, 0.001);
});

test("a director review that keeps omitting decisions stops the autopilot instead of approving the chapter", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = scripted((request) => request.label.startsWith("autopilot:director-review")
    ? reply({ verdict: "approve", score: 9, summary: "Fine." })
    : undefined);
  const { state } = await run(store, ai, ONE_CHAPTER);
  assert.equal(state.status, "error");
  assert.equal(state.lastError.task, "director-review");
  assert.match(state.lastError.message, /"decisions" is missing/);
  assert.notEqual(state.plan.chapters[0].status, "done");
});

test("specialists without a findings list, a plan review without verdict and a final review without verdict are rejected", async () => {
  const cases = [
    ["chapter_findings", { summary: "No problems." }, "specialists", /"findings" is missing/],
    ["plan_review", { score: 9, summary: "Great." }, "plan-review", /"verdict" is missing/],
    ["director_opinion", { score: 9, summary: "Great book." }, "final", /"verdict" is missing/],
  ];
  for (const [tool, json, task, pattern] of cases) {
    const store = new MemoryBookStore(seedBookFiles());
    const ai = scripted((request) => request.json?.name === tool ? reply(json) : undefined);
    const { state } = await run(store, ai, ONE_CHAPTER);
    assert.equal(state.status, "error", tool);
    assert.equal(state.lastError.task, task, tool);
    assert.match(state.lastError.message, pattern, tool);
    if (tool === "plan_review") assert.equal(state.plan.approved, false);
    if (tool === "director_opinion") assert.equal(state.finalDone, false, "the book is not marked done");
    if (tool === "chapter_findings") assert.equal(state.plan.chapters[0].status, "review");
  }
});

test("an impact analysis without targets never drops the author's rewrite", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const done = await run(store, createFakeAutopilotAi({ reviewVerdict: () => "approve" }), ONE_CHAPTER);
  assert.equal(done.state.status, "completed");
  await done.session.intervene({ scope: "rewrite", text: "Make Orrin kinder." });
  const ai = scripted((request) => request.json?.name === "revision_impact" ? reply({ summary: "Nothing to change." }) : undefined);
  const { state } = await run(store, ai, {});
  assert.equal(state.status, "error");
  assert.match(state.lastError.message, /"targets" is missing/);
  assert.equal(state.revision.targets, null, "the revision is still waiting for its impact analysis");

  const invalid = scripted((request) => request.json?.name === "revision_impact" ? reply({ summary: "x", targets: [{ chapterNumber: 9, sceneNumber: 9, instruction: "?" }] }) : undefined);
  const again = await run(store, invalid, {});
  assert.match(again.state.lastError.message, /none of its 1 targets is a written scene/);
});

test("a reply cut by the output limit never becomes a scene and is not retried", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = scripted((request) => request.label === "autopilot:write:1.1"
    ? { text: "The harbor light ".repeat(200), truncated: true, usage: { inputTokens: 900, outputTokens: 4000, cachedInputTokens: 0 }, model: "local-model", provider: "openai", cost: 0.25 }
    : undefined);
  const { state, events } = await run(store, ai, ONE_CHAPTER);
  assert.equal(state.status, "error");
  assert.match(state.lastError.message, /cut by the output token limit/);
  assert.ok(!events.some((event) => event.type === "insight" && event.code === "failureRetry"));
  assert.ok(![...store.files.keys()].some((path) => /^chapters\/001-[^/]+\/001-/.test(path)), "no scene file");
  assert.ok(state.stats.cost >= 0.25, "the truncated reply is still counted");
  assert.ok(state.stats.outputTokens >= 4000);
});

test("what failed steps cost is saved with the failure and counts toward the budget", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const failure = new AiProviderError("HTTP 400 — context too long", 400, false, { usage: { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 0 }, cost: 0.5, model: "big-model", provider: "openai" });
  const { state } = await run(store, scripted((request) => request.label === "autopilot:concept" ? failure : undefined), { brief: { idea: "x" }, options: { ...FAST, budgetLimit: 0.4 } });
  assert.equal(state.status, "error");
  assert.equal(state.stats.cost, 0.5);
  assert.equal(state.stats.inputTokens, 1000);
  assert.equal(state.stats.aiCalls, 1);
  const stored = parseAutopilotState(store.files.get("autopilot/state.json"));
  assert.equal(stored.stats.cost, 0.5, "saved, not only in memory");
  const { activities } = await readStoredAutopilot(store);
  assert.deepEqual([activities.at(-1).model, activities.at(-1).cost, activities.at(-1).usage.outputTokens], ["big-model", 0.5, 500]);

  const ai = createFakeAutopilotAi();
  const resumed = await run(store, ai, {});
  assert.equal(resumed.state.status, "paused");
  assert.match(resumed.state.message, /Budget reached/);
  assert.equal(ai.calls.length, 0);
});

test("a plan with fewer chapters than requested is rejected with both numbers", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = createFakeAutopilotAi({ chapters: 2 });
  const { state } = await run(store, ai, { brief: { idea: "x", targetChapters: 3 }, options: FAST });
  assert.equal(state.status, "error");
  assert.match(state.lastError.message, /has 2 chapters with a title, but 3 were requested/);
  const plans = ai.calls.filter((call) => call.label === "autopilot:plan");
  assert.equal(plans.length, 2);
  assert.match(plans[1].user, /previous reply to this request was rejected because: The chapter plan has 2 chapters/);
});

test("the story so far before a chapter never contains that chapter or later ones, even after a revision", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  let version = 0;
  const ai = scripted((request) => {
    const closing = /^autopilot:consolidate:(\d+)$/.exec(request.label);
    if (closing) {
      version += 1;
      return reply({ summary: `Summary of closed chapter ${closing[1]} (v${version}).`, recap: "- recap", stateChanges: {}, storySoFar: `Through chapter ${closing[1]} (v${version}).` });
    }
    if (request.json?.name === "revision_impact") return reply({ summary: "Chapter 2 changes.", targets: [{ chapterNumber: 2, sceneNumber: 1, instruction: "Kinder Orrin." }] });
    return undefined;
  }, { reviewVerdict: () => "approve" });
  const first = await run(store, ai, { brief: { idea: "x", targetChapters: 3, scenesPerChapter: 1, wordsPerScene: 300 }, options: FAST });
  assert.equal(first.state.status, "completed");
  const consolidations = () => ai.calls.filter((call) => call.label.startsWith("autopilot:consolidate:"));
  const [one, two, three] = consolidations();
  assert.match(one.user, /this is the first chapter/);
  assert.match(two.user, /Through chapter 1 \(v1\)/);
  assert.doesNotMatch(two.user, /Through chapter 2/);
  assert.match(three.user, /Through chapter 2 \(v2\)/);
  assert.match(ai.calls.find((call) => call.label === "autopilot:write:3.1").user, /STORY SO FAR \(before this chapter\):\n?.*Through chapter 2 \(v2\)/s);

  const total = parseTotalResume(parseMarkdown(store.files.get("resumes/total.md")).body);
  assert.deepEqual(total.chapters.map((section) => section.number), [1, 2, 3]);
  assert.match(total.chapters[1].text, /closed chapter 2 \(v2\)/);

  await first.session.intervene({ scope: "rewrite", text: "Make Orrin kinder." });
  const second = await run(store, ai, {});
  assert.equal(second.state.status, "completed");
  const again = consolidations().at(-1);
  assert.equal(again.label, "autopilot:consolidate:2");
  const before = /STORY SO FAR \(before this chapter\):\n([\s\S]*?)\n\nCHAPTER TEXT:/.exec(again.user)[1];
  assert.equal(before, "Through chapter 1 (v1).", "neither the old chapter 2 nor chapter 3 is 'before chapter 2'");
  const chapters = second.state.plan.chapters;
  assert.match(chapters[1].storySoFarAtClose, /Through chapter 2 \(v4\)/);
  assert.equal(chapters[2].storySoFarAtClose, undefined, "chapter 3's synopsis included the old chapter 2");
  const resume = parseTotalResume(parseMarkdown(store.files.get("resumes/total.md")).body);
  assert.match(resume.chapters[1].text, /closed chapter 2 \(v4\)/, "only chapter 2's section changed");
  assert.match(resume.chapters[2].text, /closed chapter 3 \(v3\)/);
  const finals = ai.calls.filter((call) => call.label === "director:book");
  assert.match(finals.at(-1).user, /Through chapter 2 \(v4\)[\s\S]*3\. Chapter Title 3: Summary of closed chapter 3 \(v3\)/);
});

test("a story so far over the hard limit is rejected with the excess, then rewritten", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = scripted((request, seen) => request.label === "autopilot:consolidate:1" && seen === 0
    ? reply({ summary: "S.", recap: "R.", stateChanges: {}, storySoFar: "word ".repeat(1300) })
    : undefined);
  const { state } = await run(store, ai, ONE_CHAPTER);
  assert.equal(state.status, "completed");
  const retried = ai.calls.filter((call) => call.label === "autopilot:consolidate:1")[1];
  assert.match(retried.user, /"storySoFar" is 1300 words long, 100 words over the 1200-word limit/);
});

test("story so far helpers: per-chapter sections, a guarded single-block resume, the most recent part kept", async () => {
  const chapters = [1, 2, 3].map((number) => ({ number, title: `T${number}`, slug: `00${number}-t`, summary: `S${number}`, goal: "", pov: [], keyEvents: [], reveals: [], status: "done", scenes: [{ number: 1, title: "s", goal: "", beats: [], characters: [], status: "reviewed", revisions: 0 }] }));
  const sections = "# Book So Far\n\n## Chapter 001 T1\n\nOne.\n\n## Chapter 002 T2\n\nTwo.\n\n## Chapter 003 T3\n\nThree.\n\n# Story State Overview\n\n- Status: clean";
  assert.equal(storySoFarBefore(chapters, 3, sections), "1. T1: One.\n\n2. T2: Two.");
  const single = `# Book So Far\n\n${"Everything up to chapter three, in one block. ".repeat(10)}`;
  assert.equal(storySoFarBefore(chapters, 3, single), "1. T1: S1\n2. T2: S2", "a single block that may include chapter 3 is not used");
  assert.match(storySoFarBefore([], 4, single), /Everything up to chapter three/, "usable when nothing from this chapter on was closed");
  assert.match(storySoFarBefore([{ ...chapters[0], storySoFarAtClose: "Synopsis 1" }, chapters[1]], 3, single), /^Synopsis 1\n\n2\. T2: S2$/);

  const rendered = renderTotalResumeBody(sections, chapters, { number: 2, title: "T2 new", summary: "Two again." });
  const parsed = parseTotalResume(rendered);
  assert.deepEqual(parsed.chapters.map((section) => [section.heading, section.text]), [["## Chapter 001 T1", "One."], ["## Chapter 002 T2 new", "Two again."], ["## Chapter 003 T3", "Three."]]);
  assert.match(parsed.trailing, /# Story State Overview/);
  assert.equal(parseTotalResume("# Book So Far\n\nKeep an up-to-date summary of the entire book here.").chapters.length, 0);

  const store = new MemoryBookStore({ "resumes/total.md": `---\ntype: resume\n---\n\n${"old ".repeat(3000)}RECENT ENDING` });
  const read = await readStorySoFar(store, { chapters: [], max: 200 });
  assert.ok(read.length <= 201);
  assert.match(read, /RECENT ENDING$/, "the most recent part survives the cut");

  const many = Array.from({ length: 7 }, (_, index) => ({ ...chapters[0], number: index + 1, storySoFarAtClose: `Synopsis ${index + 1}` }));
  pruneStorySnapshots(many);
  assert.deepEqual(many.map((entry) => entry.storySoFarAtClose ?? null), [null, null, null, "Synopsis 4", "Synopsis 5", "Synopsis 6", "Synopsis 7"], "state.json keeps only the newest synopses");
  assert.match(storySoFarBefore(many, 3), /^1\. T1: S1\n2\. T1: S1$/, "older chapters fall back to their summaries");
});

test("canon relevance: whole words, any case, explicit scene references first", () => {
  assert.equal(containsName("Lei aveva paura del mare.", "Eva"), false);
  assert.equal(containsName("Poi EVA rise.", "Eva"), true);
  assert.equal(containsName("Il porto di Vétra si svegliò", "vétra"), true);
  const canon = ["Eva", "Orrin Hale", "Glass Harbor", "Mira Vale"].map((name, index) => ({ kind: index === 2 ? "location" : "character", slug: `c${index}`, name, aliases: [], path: `x/${index}.md`, hash: "" }));
  const snapshot = { canon };
  assert.deepEqual(mentionedCanon(snapshot, "Lei aveva visto Orrin Hale e Mira Vale").map((entry) => entry.name), ["Orrin Hale", "Mira Vale"]);
  assert.deepEqual(mentionedCanon(snapshot, "Orrin Hale meets Mira Vale", 2, ["Glass Harbor", "Eva"]).map((entry) => entry.name), ["Glass Harbor", "Eva"]);
  assert.deepEqual(mentionedCanon(snapshot, "", 5, ["Mira"]).map((entry) => entry.name), ["Mira Vale"], "a first name finds the full name");
});

test("a new canon entity matching an existing name, alias or first name reuses it", async () => {
  assert.equal(sameCanonEntity("character", "Mara", ["Mara Venturi"]), true);
  assert.equal(sameCanonEntity("character", "mára venturi", ["Mara Venturi"]), true);
  assert.equal(sameCanonEntity("character", "Mara Rossi", ["Mara Venturi"]), false);
  assert.equal(sameCanonEntity("character", "Venturi", ["Mara Venturi"]), false, "a lone surname may be a relative");
  assert.equal(sameCanonEntity("character", "Mara Venturi", ["Mara"]), true);
  assert.equal(sameCanonEntity("location", "Harbor", ["Glass Harbor"]), false);
  assert.equal(sameCanonEntity("character", "The Keeper", ["Orrin Hale", "The Keeper"]), true);

  const files = seedBookFiles();
  files["characters/mara-venturi.md"] = "---\ntype: character\nid: character:mara-venturi\nname: Mara Venturi\n---\n\n# Mara Venturi\n";
  const store = new MemoryBookStore(files);
  const ai = scripted((request) => request.json?.name === "book_concept"
    ? reply({ storyDesign: "# Story Design\n\nA design.", logline: "L", characters: [{ name: "Mara", description: "Again" }, { name: "Orrin Hale", description: "New" }, { name: "Orrin", description: "Dup" }], locations: [], factions: [], secrets: [{ title: "The Lie", truth: "t", holders: ["Mara", "Orrin"], revealChapter: 1 }] })
    : undefined);
  await run(store, ai, { brief: { idea: "x", targetChapters: 1 }, options: { ...FAST, pauseAfterPlan: true } });
  assert.ok(!store.files.has("characters/mara.md"));
  assert.ok(!store.files.has("characters/orrin.md"));
  assert.ok(store.files.has("characters/orrin-hale.md"));
  assert.deepEqual(parseMarkdown(store.files.get("secrets/the-lie.md")).frontmatter.holders, ["character:mara-venturi", "character:orrin-hale"]);
});

test("a rewritten scene gets a new summary", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = scripted((request, seen) => request.label === "autopilot:scene-summary:1.1" ? reply({ summary: `Summary ${seen + 1}.` }) : undefined);
  const { state } = await run(store, ai, ONE_CHAPTER);
  assert.equal(state.status, "completed");
  assert.ok(ai.calls.some((call) => call.label === "autopilot:repair:1.1"));
  const scene = parseMarkdown(store.files.get("chapters/001-chapter-title-1/001-scene-1-title.md"));
  assert.equal(scene.frontmatter.summary, "Summary 2.");
  assert.equal(state.plan.chapters[0].scenes[0].summary, "Summary 2.");
});

test("accepted fixes that cannot be applied are reported, not dropped silently", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = scripted((request, seen) => request.label === "autopilot:director-review:1" && seen === 0
    ? reply({ verdict: "revise", score: 5, summary: "Fix it.", strengths: [], decisions: [{ findingId: "[s1-1]", action: "accept", rationale: "Yes.", remediation: "Do it.", sceneNumber: 99 }], extraFixes: [], guidance: [] })
    : undefined);
  const { events } = await run(store, ai, ONE_CHAPTER);
  assert.ok(events.some((event) => event.type === "insight" && /Fixes accepted without an applicable remediation or written scene, rejected: S1-1/.test(event.title)));
  assert.ok(events.some((event) => event.type === "insight" && /revision without any applicable fix/.test(event.title)));
});

test("director notes are de-duplicated and bounded; the newest author rules survive the cap", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = scripted((request) => request.label === "autopilot:director-review:1"
    ? reply({ verdict: "approve", score: 8, summary: "Good.", strengths: [], decisions: [...request.user.matchAll(/\[([A-Z]\d+-\d+)\]/g)].map((match) => ({ findingId: match[1], action: "reject", rationale: "No.", remediation: "", sceneNumber: 1 })), extraFixes: [], guidance: ["KEEP every chapter ending on a turn!", "y".repeat(1000)] })
    : undefined);
  const { state } = await run(store, ai, ONE_CHAPTER);
  assert.equal(state.directorNotes.filter((note) => /ending on a turn/i.test(note)).length, 1);
  assert.ok(state.directorNotes.every((note) => note.length <= 400));

  let rules = createAutopilotState(new Date());
  for (let index = 1; index <= 85; index += 1) rules = applyIntervention(rules, { scope: "from_now", text: `Rule ${index}` }, new Date(), "test");
  assert.equal(rules.constraints.length, 80);
  assert.equal(rules.constraints.at(-1), "Rule 85");
  assert.equal(rules.constraints[0], "Rule 6");
  const reloaded = normalizeAutopilotState({ ...rules, constraints: Array.from({ length: 90 }, (_, index) => `R${index}`) });
  assert.equal(reloaded.constraints.at(-1), "R89");
});

function plannerContext(chapters) {
  const files = new Map(chapters.flatMap((chapter) => chapter.scenes.filter((scene) => scene.path).map((scene) => [scene.path, "hash"])));
  return { snapshot: { files, book: { title: "B", language: "en", description: "" }, chapters: [], canon: [], personaPaths: [], ghostwriterSlugs: [], hasDirector: false }, director: defaultDirector("en"), readers: [], language: "en", storyDesignThin: false };
}

function chapter(number, scenes, status = "done") {
  return { number, title: `C${number}`, slug: `00${number}-c${number}`, summary: "", goal: "", pov: [], keyEvents: [], reveals: [], status, scenes: scenes.map((written, index) => ({ number: index + 1, title: `S${index + 1}`, goal: "", beats: [], characters: [], status: written ? "reviewed" : "planned", revisions: 0, ...(written ? { path: `chapters/00${number}-c${number}/00${index + 1}-s.md` } : {}) })) };
}

test("revisions: chapters already rewritten survive a new rewrite request, and only complete chapters are reviewed", () => {
  const base = createAutopilotState(new Date());
  const state = {
    ...base,
    concept: { done: true, generated: true, secrets: [] },
    plan: { chapters: [chapter(1, [true]), chapter(2, [true]), chapter(3, [true, false])], approved: true, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false },
    revision: { id: "r1", instruction: "First", createdAt: "x", targets: [{ chapterNumber: 1, sceneNumber: 1, instruction: "a" }, { chapterNumber: 2, sceneNumber: 1, instruction: "b" }], cursor: 1 },
  };
  const next = applyIntervention(state, { scope: "rewrite", text: "Second" }, new Date(), "test");
  assert.equal(next.revision.targets, null);
  assert.deepEqual(next.revision.revisedChapters, [1]);
  assert.deepEqual(normalizeAutopilotState(next).revision.revisedChapters, [1], "survives a reload");

  const finished = { ...next, revision: { ...next.revision, targets: [{ chapterNumber: 3, sceneNumber: 1, instruction: "c" }], cursor: 1 } };
  const advanced = advanceState(finished, plannerContext(finished.plan.chapters));
  assert.deepEqual(advanced.plan.chapters.map((entry) => entry.status), ["review", "done", "writing"]);
  assert.equal(advanced.revision, null);

  const stuck = { ...base, concept: { done: true, generated: true, secrets: [] }, plan: { ...state.plan, chapters: [chapter(1, [true, false], "review")] } };
  assert.equal(advanceState(stuck, plannerContext(stuck.plan.chapters)).plan.chapters[0].status, "writing", "a chapter under review with a missing scene goes back to writing");
});

test("an on-demand director opinion is never built from a truncated or verdict-less reply", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const truncated = { calls: [], async complete() { return { ...reply({ verdict: "approve", score: 9, summary: "Great." }), truncated: true }; } };
  await assert.rejects(askDirector({ store, ai: truncated, target: { kind: "book" }, save: true }), (error) => error instanceof AiProviderError && error.truncated === true && error.retryable === false);
  const verdictless = { calls: [], async complete() { return reply({ score: 9, summary: "Great." }); } };
  await assert.rejects(askDirector({ store, ai: verdictless, target: { kind: "book" }, save: true }), /"verdict" is missing/);
  assert.ok(!store.files.has("evaluations/director/book.md"), "nothing was saved");
});

test("the corrective note of a retried request is bounded and only follows rejected replies", () => {
  const note = retryNoteFor(new AiReplyRejectedError(`The reply was rejected: ${"x".repeat(2000)}`));
  assert.ok(note.length <= 500);
  assert.match(note, /^The previous reply to this request was rejected because: The reply was rejected: x+/);
  assert.equal(retryNoteFor(new AiProviderError("HTTP 503", 503, true)), null);
  assert.equal(retryNoteFor(new Error("x")), null);
});
