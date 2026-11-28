import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { designArchitectSystem } from "../dist/autopilot/prompts.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// The Brainstormer of a design run (`brainstormer.md`): a profile like the director's (a personality, a boldness, what it refuses), read softly, kept by the author, and used by
// the steps of a design run that generate and revise (the foundation, the design of the chapters); a file that cannot be read stops a design run, and no other.

const {
  AutopilotSession,
  BRAINSTORMER_FILE,
  brainstormerBoldnessBand,
  brainstormerBoldnessText,
  brainstormerPrompt,
  defaultBrainstormer,
  loadBrainstormerProfile,
  parseAutopilotState,
  parseBrainstormer,
  serializeBrainstormer,
  writeOutlineBrief,
} = engine;

const clock = () => new Date("2026-11-28T09:00:00.000Z");
const IDEA = "A harbor town built on glass hides a lie that the tide will tell.";

test("the default brainstormer speaks the language of the book and has a middle boldness", () => {
  const english = defaultBrainstormer("en");
  const italian = defaultBrainstormer("it");
  assert.equal(BRAINSTORMER_FILE, "brainstormer.md");
  assert.deepEqual([english.name, english.language, english.boldness, english.path], ["The Brainstormer", "en", 6, "brainstormer.md"]);
  assert.deepEqual([italian.name, italian.language], ["Il Brainstormer", "it"]);
  assert.match(italian.persona, /co-autore/);
  assert.ok(english.priorities.length > 0 && english.avoid.length > 0 && english.body.includes("# Method"));
  assert.equal(defaultBrainstormer().language, "en");
});

test("the profile is read from its file: every field, a decimal comma, a boldness kept in range, and nothing to warn about", () => {
  const profile = parseBrainstormer([
    "---",
    "type: brainstormer",
    "name: Ada",
    "language: it",
    "persona: Un'autrice di gialli che odia i colpi di scena gratuiti.",
    "boldness: 8,4",
    "priorities:",
    "  - Un delitto che si spiega da solo",
    "  - Un detective che sbaglia",
    "avoid:",
    "  - Il maggiordomo",
    "---",
    "",
    "# Metodo",
    "",
    "Prima l'assassino, poi il delitto.",
  ].join("\n"));
  assert.deepEqual(profile.warnings, []);
  assert.deepEqual([profile.name, profile.language, profile.boldness], ["Ada", "it", 8]);
  assert.deepEqual(profile.priorities, ["Un delitto che si spiega da solo", "Un detective che sbaglia"]);
  assert.deepEqual(profile.avoid, ["Il maggiordomo"]);
  assert.match(profile.body, /Prima l'assassino/);
  assert.equal(parseBrainstormer("---\nboldness: 40\n---\n").boldness, 10, "kept in range");
  assert.equal(parseBrainstormer("---\nboldness: -3\n---\n").boldness, 1);
});

test("a file with a value that is not understood is read with the default for it, and the warning names the file and the field", () => {
  const profile = parseBrainstormer("---\nboldness: very\nname: [a, b]\npriorities: {a: 1}\navoid:\n  - ok\n  - {a: {b: 1}}\n---\n\nNotes");
  const warnings = profile.warnings.join("\n");
  assert.match(warnings, /brainstormer\.md: boldness «very» is not a number from 1 to 10: 6 is used/);
  assert.match(warnings, /brainstormer\.md: name is not text \(a list\): the default is used/);
  assert.match(warnings, /brainstormer\.md: priorities must be a list of lines \(a mapping is not one\)/);
  assert.match(warnings, /one entry of avoid cannot be read as a line of text and was left out/);
  assert.equal(profile.boldness, 6);
  assert.equal(profile.name, "The Brainstormer");
  assert.deepEqual(profile.avoid, ["ok"]);
  assert.equal(profile.body, "Notes");
});

test("YAML that cannot be read is one warning, and an empty file is the default profile", () => {
  const broken = parseBrainstormer("---\nname: [unclosed\n---\n\nBody");
  assert.equal(broken.warnings.length, 1);
  assert.match(broken.warnings[0], /brainstormer\.md: the frontmatter is not valid YAML/);
  assert.deepEqual(parseBrainstormer("").warnings, []);
  assert.equal(parseBrainstormer("").name, "The Brainstormer");
  assert.equal(parseBrainstormer("", "it").name, "Il Brainstormer");
});

test("a profile serializes to a file that reads back as the same profile", () => {
  const original = { ...defaultBrainstormer("en"), name: "Ada", boldness: 9, avoid: ["The butler"], priorities: ["One clue per chapter"] };
  const again = parseBrainstormer(serializeBrainstormer(original));
  assert.deepEqual({ ...again, warnings: undefined }, { ...original, warnings: undefined });
  assert.match(serializeBrainstormer(original), /^---\ntype: brainstormer\nid: brainstormer:main\nname: Ada\n/);
});

test("the prompt says who the brainstormer is, how bold, what it prefers and what it refuses, and the boldness is said in four bands", () => {
  const prompt = brainstormerPrompt({ ...defaultBrainstormer("en"), name: "Ada", boldness: 9 });
  assert.match(prompt, /^Brainstormer: Ada\. A curious and daring co-author/);
  assert.match(prompt, /Boldness: 9\/10 — break the expected/);
  assert.match(prompt, /Priorities, in order:\n- A premise that can be said in one sentence/);
  assert.match(prompt, /Never \(clichés and devices you refuse\):\n- Coincidences that solve problems/);
  assert.match(prompt, /Method:\n# Method/);
  // The band a host says of a boldness is the one the prompt asks for: one table.
  assert.deepEqual([1, 3, 4, 6, 7, 8, 9, 10].map(brainstormerBoldnessBand), ["prudent", "prudent", "balanced", "balanced", "daring", "daring", "breaking", "breaking"]);
  assert.deepEqual([1, 3, 4, 6, 7, 8, 9, 10].map((value) => brainstormerBoldnessText(value).split(":")[0]), ["keep to what the genre and the author's idea expect", "keep to what the genre and the author's idea expect", "balance", "balance", "dare", "dare", "break the expected", "break the expected"]);
});

test("the system prompt of a design run's architect has the role of the brainstormer and, when there is one, its profile; a book without the file has the default profile", async () => {
  assert.match(designArchitectSystem("en", null), /you are the brainstormer of a writers' room/);
  assert.doesNotMatch(designArchitectSystem("en", null), /Boldness/);
  assert.match(designArchitectSystem("it", "Brainstormer: Ada. Audace."), /Brainstormer: Ada\. Audace\.$/);
  const store = new MemoryBookStore(seedBookFiles({ chapters: 0 }));
  assert.equal((await loadBrainstormerProfile(store, "en")).name, "The Brainstormer");
  await store.commit([{ path: "brainstormer.md", content: "---\nname: Ada\nboldness: 9\n---\n\nNotes", expectedHash: null }], "profile");
  const loaded = await loadBrainstormerProfile(store, "en");
  assert.deepEqual([loaded.name, loaded.boldness], ["Ada", 9]);
});

async function describedBook(files = {}) {
  const store = new MemoryBookStore({ ...seedBookFiles({ chapters: 0, title: "The Glass Harbor" }), ...files });
  await writeOutlineBrief(store, { idea: IDEA, genre: "mystery", audience: "adults", wordsPerScene: 200 });
  return store;
}

async function design(store, ai, start = { design: { chapters: 2 }, options: { readersOnPlan: false, pauseAfterPlan: false } }) {
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "browser", hostLabel: "test", retryDelayMs: 0, now: clock });
  session.subscribe((event) => events.push(event));
  await session.start(start);
  await session.waitForIdle();
  return { events, state: parseAutopilotState(store.files.get("autopilot/state.json")) };
}

test("a design run writes the foundation and the chapters in the voice of the brainstormer of the book", async () => {
  const store = await describedBook({ "brainstormer.md": "---\nname: Ada\npersona: A noir novelist with no patience for the obvious.\nboldness: 9\navoid:\n  - The butler\n---\n\nStart from the ending." });
  const ai = createFakeAutopilotAi();
  const { state } = await design(store, ai);
  assert.equal(state.status, "paused", state.lastError?.message);
  const asked = ai.calls.filter((call) => call.json?.name === "design_concept" || call.json?.name === "chapter_design");
  assert.deepEqual(asked.map((call) => call.json.name), ["design_concept", "chapter_design"]);
  for (const call of asked) {
    assert.match(call.system, /you are the brainstormer of a writers' room/);
    assert.match(call.system, /Brainstormer: Ada\. A noir novelist with no patience for the obvious\./);
    assert.match(call.system, /Boldness: 9\/10 — break the expected/);
    assert.match(call.system, /- The butler/);
    assert.match(call.system, /Start from the ending\./);
  }
  // The director and the readers keep their own voices.
  const review = ai.calls.find((call) => call.json?.name === "design_review");
  assert.doesNotMatch(review.system, /Brainstormer: Ada/);
});

test("without a brainstormer.md the default profile writes the design, and a run that does not design never reads the file", async () => {
  const store = await describedBook();
  const ai = createFakeAutopilotAi();
  await design(store, ai);
  assert.match(ai.calls[0].system, /Brainstormer: The Brainstormer\. A curious and daring co-author/);
  assert.match(ai.calls[0].system, /Boldness: 6\/10 — balance/);

  // A run that writes: even a broken file stops nothing, and no prompt of it mentions the brainstormer.
  const plain = await describedBook({ "brainstormer.md": "---\nboldness: [x\n---\n" });
  const quiet = createFakeAutopilotAi({ chapters: 1, scenes: 1, words: 40 });
  const { state } = await design(plain, quiet, { options: { readers: false, readersOnPlan: false, pauseAfterPlan: false, specialists: false } });
  assert.notEqual(state.status, "waiting-author", state.message);
  assert.ok(quiet.calls.every((call) => !/Brainstormer:/.test(call.system)));
});

test("a brainstormer.md that cannot be read as written stops a design run before anything is spent, and the message names the file", async () => {
  const store = await describedBook({ "brainstormer.md": "---\nboldness: very bold\n---\n\nNotes" });
  const ai = createFakeAutopilotAi();
  const { state, events } = await design(store, ai);
  assert.equal(state.status, "waiting-author");
  assert.equal(ai.calls.length, 0, "nothing was spent");
  assert.match(state.message, /Correct this profile before resuming/);
  assert.match(state.message, /brainstormer\.md: boldness «very bold» is not a number from 1 to 10/);
  const problems = events.find((event) => event.type === "insight" && event.code === "profileProblems");
  assert.match(problems.detail, /brainstormer\.md/);
  assert.equal(store.files.get("brainstormer.md").includes("very bold"), true, "the file is never replaced by the defaults");
});
