import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { AutopilotSession, parseAutopilotState } = engine;

const STATE = "autopilot/state.json";
const STYLE = "evaluation-guidelines.md";

/** The file as the site writes it (`defaultGuidelines.ts`, `EvaluationStylePage.tsx`): `criteria` is a mapping of keys to `{ description }`. */
function siteStyle({ criteria, body } = {}) {
  const entries = criteria ?? [
    ["harbor_logic", "Every harbor scene obeys the tides and the trade of glass (CRITERION-MARK-1)."],
    ["canon_coherence", "How well the text stays coherent with canon, chronology and reveals (CRITERION-MARK-2)."],
  ];
  const yaml = entries.map(([key, description]) => `  ${key}:\n    description: ${JSON.stringify(description)}`).join("\n");
  return `---\ntype: guideline\nid: guideline:evaluation-style\ntitle: Evaluation Style\nscope: evaluation-style\ncriteria:\n${yaml}\n---\n\n${body ?? "# Evaluation Style\n\nUse this file as the contract for chapter and paragraph evaluations.\nSEVERITY-MARK: be severe, exact and critical; an 8 needs sustained quality.\n\n## Discursive evaluation structure\n\nFor a chapter, use these sections:\n- `## Verdict`\n- `## Strengths`"}\n`;
}

function session(store, ai) {
  const events = [];
  const instance = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0, now: () => new Date("2026-01-01T00:00:00.000Z") });
  instance.subscribe((event) => events.push(event));
  return { session: instance, events };
}

async function runBook(files, options = {}) {
  const store = new MemoryBookStore(files);
  const ai = createFakeAutopilotAi();
  const { session: autopilot, events } = session(store, ai);
  await autopilot.start({ brief: { idea: "A harbor built on glass hides a lie.", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: { readers: false, readersOnPlan: false, pauseAfterPlan: false, ...options } });
  await autopilot.waitForIdle();
  return { store, ai, events, state: parseAutopilotState(store.files.get(STATE)) };
}

// ─── Reading the file ───────────────────────────────────────────────────────

test("the evaluation style the site writes is read: its criteria with their descriptions, then its method", () => {
  const style = engine.parseEvaluationStyle(siteStyle());
  assert.deepEqual(style.criteria, [
    { name: "harbor_logic", description: "Every harbor scene obeys the tides and the trade of glass (CRITERION-MARK-1)." },
    { name: "canon_coherence", description: "How well the text stays coherent with canon, chronology and reveals (CRITERION-MARK-2)." },
  ]);
  assert.match(style.body, /^# Evaluation Style\n\nUse this file as the contract/);
  assert.match(style.body, /SEVERITY-MARK/);
  assert.equal(style.title, "Evaluation Style");
  assert.equal(style.path, STYLE);
  assert.deepEqual(style.warnings, []);
  assert.equal(engine.EVALUATION_GUIDELINES_FILE, STYLE);
});

test("the Italian default of the site is read the same way, accents and all", () => {
  const raw = "---\ntype: guideline\nid: guideline:evaluation-style\ntitle: Stile di valutazione\nscope: evaluation-style\ncriteria:\n  chiarezza:\n    description: Quanto il testo è leggibile, comprensibile e ben articolato alla prima lettura.\n  coerenza_canone:\n    description: Quanto il testo resta coerente con canone, cronologia, reveal e continuità interna.\n---\n\n# Stile di valutazione\n\nSii severo, preciso e critico: non dare voti di cortesia.\n";
  const style = engine.parseEvaluationStyle(raw);
  assert.deepEqual(style.criteria.map((criterion) => criterion.name), ["chiarezza", "coerenza_canone"]);
  assert.equal(style.criteria[0].description, "Quanto il testo è leggibile, comprensibile e ben articolato alla prima lettura.");
  assert.match(style.body, /Sii severo/);
  assert.deepEqual(style.warnings, []);
});

test("a criterion written as text, left empty or written as a list is read; what cannot be read is a warning that names the file", () => {
  const tolerant = engine.parseEvaluationStyle("---\ncriteria:\n  clarity: Plain text works too.\n  pacing:\n  tension:\n    description: Pressure.\n---\n\nBe severe.\n");
  assert.deepEqual(tolerant.criteria, [
    { name: "clarity", description: "Plain text works too." },
    { name: "pacing", description: "" },
    { name: "tension", description: "Pressure." },
  ]);
  assert.deepEqual(tolerant.warnings, []);

  const listed = engine.parseEvaluationStyle("---\ncriteria:\n  - name: clarity\n    description: Clear.\n  - pacing: Even.\n  - Voice: the voice of the ghostwriter.\n  - tension\n---\n");
  assert.deepEqual(listed.criteria, [
    { name: "clarity", description: "Clear." },
    { name: "pacing", description: "Even." },
    { name: "Voice", description: "the voice of the ghostwriter." },
    { name: "tension", description: "" },
  ]);
  assert.deepEqual(listed.warnings, []);

  const odd = engine.parseEvaluationStyle("---\ncriteria:\n  clarity:\n    weight: 3\n  pacing:\n    description: [1, 2]\n  - broken\n---\n");
  assert.ok(odd.warnings.length >= 1, "something is wrong and the author is told");
  assert.ok(odd.warnings.every((warning) => warning.startsWith(`${STYLE}:`)), "each warning names the file");

  const strange = engine.parseEvaluationStyle("---\ncriteria:\n  clarity:\n    weight: 3\n  pacing:\n    description:\n      - one\n      - two\n  voice: Clean.\n---\n\nMethod.\n");
  assert.deepEqual(strange.criteria.map((criterion) => criterion.name), ["clarity", "pacing", "voice"], "no criterion is dropped in silence");
  assert.equal(strange.warnings.length, 2, strange.warnings.join(" | "));
  assert.match(strange.warnings.join("\n"), /clarity/);
  assert.match(strange.warnings.join("\n"), /pacing/);

  const notAList = engine.parseEvaluationStyle("---\ncriteria: 7\n---\n\nMethod.\n");
  assert.equal(notAList.criteria.length, 0);
  assert.equal(notAList.warnings.length, 1);
  assert.match(notAList.warnings[0], /criteria/);
});

test("YAML that cannot be read is a warning with its line, and the method in the body is still there", () => {
  const style = engine.parseEvaluationStyle("---\ntitle: Style\ncriteria:\n  clarity: [unclosed\n---\n\nBe severe.\n");
  assert.equal(style.warnings.length, 1);
  assert.match(style.warnings[0], /^evaluation-guidelines\.md: the frontmatter is not valid YAML \(line \d+/);
  assert.equal(style.body, "Be severe.");
});

test("a book without the file has no evaluation style; a file is read through the store", async () => {
  assert.equal(await engine.loadEvaluationStyle(new MemoryBookStore(seedBookFiles())), null);
  const store = new MemoryBookStore({ ...seedBookFiles(), [STYLE]: siteStyle() });
  const style = await engine.loadEvaluationStyle(store);
  assert.equal(style.criteria.length, 2);
});

// ─── The block a prompt carries ─────────────────────────────────────────────

test("the block of the style stays within 3000 characters, criteria first and the method clipped, even with 200 long criteria", () => {
  assert.equal(engine.EVALUATION_STYLE_MAX_CHARS, 3000);
  const criteria = Array.from({ length: 200 }, (_, index) => [`criterion_${index + 1}`, `${"A very long description of what this criterion weighs. ".repeat(8)}(${index + 1})`]);
  const style = engine.parseEvaluationStyle(siteStyle({ criteria, body: `# Style\n\nMETHOD-START ${"Be severe and exact. ".repeat(400)}` }));
  assert.equal(style.criteria.length, 200);
  const block = engine.evaluationStyleBlock(style);
  assert.ok(block.length <= 3000, `${block.length} characters`);
  assert.ok(block.indexOf("criterion_1:") > 0 && block.indexOf("criterion_1:") < block.indexOf("METHOD-START"), "the criteria come before the method");
  assert.match(block, /criteria are not listed/, "the block says that criteria were left out");
  assert.match(block, /METHOD-START/, "the method keeps a part of its own");
  assert.match(block, /END OF THE EVALUATION STYLE$/, "the block is delimited");

  const methodOnly = engine.evaluationStyleBlock(style, { criteria: false });
  assert.ok(methodOnly.length <= 3000);
  assert.doesNotMatch(methodOnly, /criterion_1/);
  assert.match(methodOnly, /METHOD-START/);

  const small = engine.evaluationStyleBlock(engine.parseEvaluationStyle(siteStyle()));
  assert.match(small, /- harbor_logic: Every harbor scene obeys the tides/);
  assert.match(small, /SEVERITY-MARK/);
  assert.doesNotMatch(small, /not listed/);
  assert.equal(engine.evaluationStyleBlock(null), "", "no style, no block");
  assert.equal(engine.evaluationStyleBlock(engine.parseEvaluationStyle("---\ntype: guideline\n---\n")), "", "a file with nothing in it says nothing");
});

// ─── The autopilot judges with it ───────────────────────────────────────────

test("the director's review, the specialists and the final judgement read the criteria; the review of the plan only the method and the severity", async () => {
  const { ai, state } = await runBook({ ...seedBookFiles(), [STYLE]: siteStyle() });
  assert.equal(state.status, "completed", state.lastError?.message);
  const call = (label) => ai.calls.find((entry) => entry.label === label);
  for (const label of ["autopilot:director-review:1", "autopilot:specialists:1", "director:book"]) {
    const user = call(label).user;
    assert.match(user, /CRITERION-MARK-1/, `${label} reads the criteria`);
    assert.match(user, /SEVERITY-MARK/, `${label} reads the method`);
    assert.match(user, /evaluation style/i, `${label} is told to judge with it`);
  }
  const plan = call("autopilot:plan-review").user;
  assert.match(plan, /SEVERITY-MARK/, "the plan is reviewed with the method and the severity");
  assert.doesNotMatch(plan, /CRITERION-MARK/, "and not with the criteria of a chapter");
  for (const label of ["autopilot:concept", "autopilot:plan", "autopilot:scenes:1", "autopilot:write:1.1"]) assert.doesNotMatch(call(label).user, /CRITERION-MARK|SEVERITY-MARK/, `${label} does not judge`);
});

test("the style guides the judgement without changing the scale or the tools", async () => {
  const withStyle = await runBook({ ...seedBookFiles(), [STYLE]: siteStyle() });
  const without = await runBook(seedBookFiles());
  for (const label of ["autopilot:director-review:1", "autopilot:specialists:1", "autopilot:plan-review", "director:book"]) {
    const a = withStyle.ai.calls.find((entry) => entry.label === label);
    const b = without.ai.calls.find((entry) => entry.label === label);
    assert.deepEqual(a.json, b.json, `${label}: the same tool`);
    assert.equal(a.maxOutputTokens, b.maxOutputTokens, `${label}: the same output limit`);
    assert.equal(a.system, b.system, `${label}: the same system prompt`);
  }
  assert.deepEqual(withStyle.state.plan.chapters.map((chapter) => chapter.score), without.state.plan.chapters.map((chapter) => chapter.score), "the score stays on its scale");
});

test("a style with nothing in it changes no request", async () => {
  const empty = await runBook({ ...seedBookFiles(), [STYLE]: "---\ntype: guideline\nid: guideline:evaluation-style\ntitle: Evaluation Style\n---\n" });
  const without = await runBook(seedBookFiles());
  assert.deepEqual(empty.ai.calls.map((entry) => [entry.label, entry.system, entry.user]), without.ai.calls.map((entry) => [entry.label, entry.system, entry.user]));
});

test("a style that cannot be read stops the run before anything is spent, with the file and the line", async () => {
  const store = new MemoryBookStore({ ...seedBookFiles(), [STYLE]: "---\ntitle: Style\ncriteria:\n  clarity: [unclosed\n---\n\nBe severe.\n" });
  const ai = createFakeAutopilotAi();
  const { session: autopilot, events } = session(store, ai);
  await autopilot.start({ brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1 }, options: { readers: false, readersOnPlan: false, pauseAfterPlan: false } });
  await autopilot.waitForIdle();
  const state = parseAutopilotState(store.files.get(STATE));
  assert.equal(ai.calls.length, 0, "nothing was asked of the model");
  assert.equal(state.status, "waiting-author");
  assert.match(state.message, /evaluation-guidelines\.md/);
  assert.match(state.message, /line \d+/);
  const insight = events.find((event) => event.type === "insight" && event.code === "profileProblems");
  assert.ok(insight, "the problem is said with its code");
  assert.match(insight.detail, /evaluation-guidelines\.md: the frontmatter is not valid YAML/);
  assert.equal(store.files.get(STYLE).includes("[unclosed"), true, "the file is never replaced");
});
