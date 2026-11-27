import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { AutopilotSession, askDirector, clipMiddle, markedChapterText, parseAutopilotState, sceneCharacterLimit } = engine;

const FAST = { readers: false, readersOnPlan: false, pauseAfterPlan: false };
const MARKER = "[…]";
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

const wordList = (count, prefix = "word") => Array.from({ length: count }, (_, index) => `${prefix}${String(index).padStart(4, "0")}`);

/** The scene `number`, of `words` words of six letters and a space: it opens with a sentence of its own and ends with another. */
const scene = (words, number) => `OPENING OF SCENE ${number}. ${Array.from({ length: words }, () => "harbor").join(" ")}. END OF SCENE ${number}.`;

function reply(json, extra = {}) {
  return { text: JSON.stringify(json), json, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }, model: "fake-model", provider: "fake", cost: 0.001, currency: "USD", ...extra };
}

/** The fake AI, with some replies replaced: `script` returns undefined (the default reply) or a response. */
function scripted(script, options = {}) {
  const base = createFakeAutopilotAi(options);
  return {
    calls: base.calls,
    async complete(request) {
      const custom = script(request);
      if (custom === undefined) return base.complete(request);
      base.calls.push(request);
      request.signal?.throwIfAborted();
      if (!request.json && typeof custom.text === "string") request.onText?.(custom.text);
      return custom;
    },
  };
}

/** The prose of every scene written by the autopilot is `proseOf(number)`; everything else is the fake's. */
function writing(proseOf, options = {}) {
  return scripted((request) => {
    const match = /^autopilot:write:\d+\.(\d+)$/.exec(request.label);
    return match ? reply({}, { text: proseOf(Number(match[1])) }) : undefined;
  }, options);
}

async function run(store, ai, brief, options = {}) {
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0 });
  await session.start({ brief, options: { ...FAST, ...options } });
  await session.waitForIdle();
  return parseAutopilotState(store.files.get("autopilot/state.json"));
}

/** The text between the marker of a scene and the marker of the next one (or the end of the prompt section). */
function sceneBlock(user, number) {
  const start = user.indexOf(`=== SCENE ${number}:`);
  assert.ok(start >= 0, `scene ${number} is not in the prompt`);
  const next = user.indexOf("=== SCENE ", start + 10);
  // The text of the chapter is followed by what changes with each round (the fixes and the findings, the details of the canon it names) and then by the end of the data.
  const ends = ["\n\nFIXES APPLIED AFTER", "\n\nFINDINGS TO DECIDE:", "\n\nCANON DETAILS:", "\n</repository_content>"].map((marker) => user.indexOf(marker, start)).filter((at) => at >= 0);
  const end = Math.min(...ends);
  return user.slice(start, next >= 0 && next < end ? next : end);
}

// ─── The cut itself ─────────────────────────────────────────────────────────────────────────────────────────────────────

test("clipMiddle keeps the start and the end of a long text with a marker between them, within the limit", () => {
  assert.equal(typeof clipMiddle, "function");
  const text = wordList(400).join(" ");
  const clipped = clipMiddle(text, 1000);
  assert.ok(clipped.length <= 1000, `${clipped.length} characters`);
  assert.ok(clipped.startsWith("word0000 word0001"), "the start is kept");
  assert.ok(clipped.endsWith("word0398 word0399"), "the end is kept");
  assert.equal(clipped.split(MARKER).length, 2, "one explicit marker");
  const [head, tail] = clipped.split(MARKER);
  const share = head.length / (head.length + tail.length);
  assert.ok(share > 0.55 && share < 0.66, `the head is about 60% of what is kept: ${share}`);
  for (const word of clipped.split(/\s+/).filter((entry) => entry !== MARKER)) assert.match(word, /^word\d{4}$/, "the cut is at a word, never inside one");
});

test("a text that fits is returned as it is, and the limit is always respected", () => {
  assert.equal(clipMiddle("short", 100), "short");
  assert.equal(clipMiddle("exactly ten", 11), "exactly ten");
  assert.equal(clipMiddle("anything", 0), "");
  assert.equal(clipMiddle("anything", -3), "");
  assert.equal(clipMiddle(undefined, 10), "");
  const text = wordList(300).join(" ");
  for (let max = 1; max <= 120; max += 1) assert.ok(clipMiddle(text, max).length <= max, `limit ${max}`);
  assert.equal(clipMiddle(clipMiddle(text, 200), 200), clipMiddle(text, 200), "clipping a clipped text changes nothing");
});

test("the share of the head can be chosen", () => {
  const text = wordList(500).join(" ");
  const shares = [0.1, 0.5, 0.9].map((head) => {
    const [first, last] = clipMiddle(text, 1200, { head }).split(MARKER);
    return first.length / (first.length + last.length);
  });
  assert.ok(shares[0] < 0.2 && shares[1] > 0.45 && shares[1] < 0.55 && shares[2] > 0.8, shares.join(" / "));
  assert.ok(clipMiddle(text, 1200, { head: 5 }).includes(MARKER), "a share that makes no sense is limited");
});

test("a text of several lines keeps the marker on a line of its own", () => {
  const paragraphs = Array.from({ length: 80 }, (_, index) => `Paragraph ${index} of the scene, with a few words in it.`).join("\n\n");
  const clipped = clipMiddle(paragraphs, 800);
  assert.match(clipped, /\n\[…\]\n/);
  assert.ok(clipped.startsWith("Paragraph 0 "));
  assert.ok(clipped.endsWith("Paragraph 79 of the scene, with a few words in it."));
});

test("a cut never splits a character, whatever the script", () => {
  const samples = {
    emoji: "😀 ".repeat(120),
    accents: "e\u0301 ".repeat(120),
    flags: "🇮🇹🇯🇵 ".repeat(60),
    hangul: "\u1112\u1161\u11ab 한국어 ".repeat(40),
    japanese: "海辺の朝、波の音が聞こえた。".repeat(30),
    family: "👨‍👩‍👧 ".repeat(60),
  };
  for (const [name, text] of Object.entries(samples)) {
    for (let max = 30; max <= 140; max += 7) {
      const clipped = clipMiddle(text, max);
      assert.ok(clipped.length <= max, `${name} ${max}`);
      assert.equal(LONE_SURROGATE.test(clipped), false, `${name} ${max}: a pair was cut in two`);
      assert.equal(/^[\p{M}\u200d]/u.test(clipped.split(MARKER)[1]?.trimStart() ?? "x"), false, `${name} ${max}: the tail starts inside a character`);
    }
  }
  const accented = clipMiddle(samples.accents, 91);
  assert.equal([...accented].filter((character) => character === "e").length, [...accented].filter((character) => character === "\u0301").length, "an accent keeps its letter");
});

test("the limit of a scene follows the length the book asks for, with room for a scene that runs over", () => {
  assert.equal(typeof sceneCharacterLimit, "function");
  assert.ok(sceneCharacterLimit(300) < sceneCharacterLimit(1400) && sceneCharacterLimit(1400) < sceneCharacterLimit(8000));
  // Ten characters is a long word with its space in any script written with spaces: a scene of the asked length, in German or Finnish, fits with half as much again.
  for (const words of [200, 1400, 4000, 8000]) assert.ok(sceneCharacterLimit(words) >= words * 10 * 1.5, `${words} words`);
  assert.equal(sceneCharacterLimit(Number.NaN), 0);
  assert.equal(sceneCharacterLimit(-5), 0);
});

test("a chapter's text keeps the end of every scene that is cut, and leaves the others as they are", () => {
  const paragraphs = [
    { number: 1, title: "Short", body: "A short scene." },
    { number: 2, title: "Long", body: `${wordList(900).join(" ")} THE END OF SCENE TWO.` },
  ];
  const text = markedChapterText(paragraphs, 2000);
  assert.ok(text.startsWith("=== SCENE 1: Short ===\nA short scene.\n\n=== SCENE 2: Long ===\nword0000 "), "the scenes are marked as ever");
  assert.ok(text.endsWith("THE END OF SCENE TWO."), "the end of the long scene is there");
  assert.ok(text.includes(MARKER));
  assert.ok(text.length < 2000 + 80);
  assert.equal(markedChapterText([paragraphs[0]], 2000), "=== SCENE 1: Short ===\nA short scene.");
});

// ─── What the model reads ───────────────────────────────────────────────────────────────────────────────────────────────

// The planner gives a chapter at most four scenes (`SCENES_PER_CHAPTER.max`): the scenes of this one are the most it can have.
const BRIEF = { idea: "x", targetChapters: 1, wordsPerScene: 1400 };

test("a scene a little longer than the book asked for reaches the specialists, the director and the consolidation whole", async () => {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 2 }));
  // 1700 words of six letters: about 11 900 characters, more than the 9000 that consolidation used to keep and than the 10 000 the director had for each of four scenes.
  const ai = writing((number) => scene(1700, number), { scenes: 4, reviewVerdict: () => "approve" });
  const state = await run(store, ai, BRIEF, { specialists: true });
  assert.equal(state.status, "completed", state.lastError?.message);
  for (const label of ["autopilot:specialists:1", "autopilot:director-review:1", "autopilot:consolidate:1"]) {
    const call = ai.calls.find((entry) => entry.label === label);
    assert.ok(call, label);
    for (let number = 1; number <= 4; number += 1) {
      const block = sceneBlock(call.user, number);
      assert.ok(block.includes(`END OF SCENE ${number}.`), `${label}: the end of scene ${number} is missing`);
      assert.equal(block.includes(MARKER), false, `${label}: scene ${number} was cut`);
      assert.ok(block.length > 11000, `${label}: scene ${number} is whole`);
    }
  }
});

test("a scene within the limit reaches the model exactly as it is written", async () => {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 2 }));
  const ai = writing((number) => scene(400, number), { scenes: 3, reviewVerdict: () => "approve" });
  const state = await run(store, ai, { ...BRIEF, scenesPerChapter: 3, wordsPerScene: 400 }, { specialists: true });
  assert.equal(state.status, "completed", state.lastError?.message);
  for (const label of ["autopilot:specialists:1", "autopilot:director-review:1", "autopilot:consolidate:1"]) {
    const call = ai.calls.find((entry) => entry.label === label);
    for (let number = 1; number <= 3; number += 1) {
      const body = engine.parseMarkdown(store.files.get(`chapters/001-chapter-title-1/00${number}-scene-${number}-title.md`)).body;
      assert.equal(body, scene(400, number), "the scene on disk is what the model wrote");
      assert.equal(sceneBlock(call.user, number), `=== SCENE ${number}: Scene ${number} Title ===\n${body}${number < 3 ? "\n\n" : ""}`, `${label}: scene ${number}`);
    }
  }
});

test("a scene far longer than the book asked for is cut in the middle: its start and its end both reach the model", async () => {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 2 }));
  // Three scenes of about 30 000 characters for a book that asks for 300 words (about 2000 characters).
  const ai = writing((number) => scene(4300, number), { scenes: 3, reviewVerdict: () => "approve" });
  const state = await run(store, ai, { ...BRIEF, scenesPerChapter: 3, wordsPerScene: 300 }, { specialists: true });
  assert.equal(state.status, "completed", state.lastError?.message);
  const limits = { "autopilot:specialists:1": 14000, "autopilot:director-review:1": 20000, "autopilot:consolidate:1": 9000 };
  for (const [label, limit] of Object.entries(limits)) {
    const call = ai.calls.find((entry) => entry.label === label);
    for (let number = 1; number <= 3; number += 1) {
      const block = sceneBlock(call.user, number);
      assert.ok(block.includes(`END OF SCENE ${number}.`), `${label}: the end of scene ${number} is missing`);
      assert.ok(block.includes(MARKER), `${label}: scene ${number} says it was cut`);
      assert.ok(block.includes(`OPENING OF SCENE ${number}.`), `${label}: the start of scene ${number} is missing`);
      assert.ok(block.length <= limit + 120, `${label}: scene ${number} takes ${block.length} characters, the limit is ${limit}`);
    }
  }
});

/** A book whose chapter 1 was written by the author, without a summary: `scenes` scenes of `words` words each. */
function importedBook(scenes, words) {
  const files = seedBookFiles({ chapters: 2 });
  files["chapters/001-part/chapter.md"] = "---\ntype: chapter\nid: chapter:001-part\nnumber: 1\ntitle: Part\n---\n\n# Part\n";
  for (let number = 1; number <= scenes; number += 1) {
    const slug = `${String(number).padStart(3, "0")}-scene`;
    files[`chapters/001-part/${slug}.md`] = `---\ntype: paragraph\nid: paragraph:001-part:${slug}\nchapter: chapter:001-part\nnumber: ${number}\ntitle: Scene ${number}\n---\n\n${scene(words, number)}`;
  }
  return files;
}

test("a chapter the author wrote is summarized from every scene whole when the scenes are of the length the book asks for", async () => {
  // Ten scenes of 1400 words of six letters (9 800 characters each): a chapter of ten scenes shares 60 000 characters, 6 000 for each, and every scene would have been cut.
  const store = new MemoryBookStore(importedBook(10, 1400));
  const ai = writing(() => scene(300, 1));
  const state = await run(store, ai, { idea: "x", targetChapters: 2, scenesPerChapter: 1, wordsPerScene: 1400 });
  assert.equal(state.status, "completed", state.lastError?.message);
  const call = ai.calls.find((entry) => entry.label === "autopilot:summarize-imported:1");
  assert.ok(call, "the chapter is summarized");
  for (let number = 1; number <= 10; number += 1) {
    const block = sceneBlock(call.user, number);
    assert.ok(block.includes(`END OF SCENE ${number}.`), `the end of scene ${number} is missing`);
    assert.equal(block.includes(MARKER), false, `scene ${number} was cut`);
    assert.ok(block.length > 9800, `scene ${number} is whole`);
  }
});

test("the scenes of a chapter the author wrote that are far longer than the book asked for keep their start and their end in its summary", async () => {
  // Three scenes of about 30 000 characters for a book that asks for 300 words (about 2000 characters): the chapter shares 60 000 characters.
  const store = new MemoryBookStore(importedBook(3, 4300));
  const ai = writing(() => scene(300, 1));
  const state = await run(store, ai, { idea: "x", targetChapters: 2, scenesPerChapter: 1, wordsPerScene: 300 });
  assert.equal(state.status, "completed", state.lastError?.message);
  const call = ai.calls.find((entry) => entry.label === "autopilot:summarize-imported:1");
  assert.ok(call, "the chapter is summarized");
  for (let number = 1; number <= 3; number += 1) {
    const block = sceneBlock(call.user, number);
    assert.ok(block.includes(`OPENING OF SCENE ${number}.`), `the start of scene ${number} is missing`);
    assert.ok(block.includes(`END OF SCENE ${number}.`), `the end of scene ${number} is missing`);
    assert.ok(block.includes(MARKER), `scene ${number} says it was cut`);
    assert.ok(block.length <= 20000 + 120, `scene ${number} takes ${block.length} characters`);
  }
});

test("the director's opinion on a scene or a chapter keeps the end of a long scene", async () => {
  const files = seedBookFiles({ chapters: 2 });
  files["chapters/001-the-arrival/chapter.md"] = "---\ntype: chapter\nid: chapter:001-the-arrival\nnumber: 1\ntitle: The Arrival\nsummary: Mira arrives.\n---\n\n# The Arrival\n";
  for (const number of [1, 2, 3]) {
    files[`chapters/001-the-arrival/00${number}-scene.md`] = `---\ntype: paragraph\nid: paragraph:001-the-arrival:00${number}-scene\nchapter: chapter:001-the-arrival\nnumber: ${number}\ntitle: Scene ${number}\n---\n\n${scene(7000, number)}`;
  }
  const store = new MemoryBookStore(files);
  const ai = createFakeAutopilotAi();
  await askDirector({ store, ai, target: { kind: "paragraph", chapter: "001-the-arrival", paragraph: "002-scene" } });
  const sceneCall = ai.calls.at(-1);
  assert.equal(sceneCall.label, "director:paragraph");
  assert.ok(sceneCall.user.includes("END OF SCENE 2."), "a scene of 49 000 characters keeps its end");
  assert.ok(sceneCall.user.includes("OPENING OF SCENE 2.") && sceneCall.user.includes(MARKER));
  await askDirector({ store, ai, target: { kind: "chapter", chapter: "001-the-arrival" } });
  const chapterCall = ai.calls.at(-1);
  for (const number of [1, 2, 3]) assert.ok(chapterCall.user.includes(`END OF SCENE ${number}.`), `chapter opinion: the end of scene ${number}`);
});

test("the ending a scene is continued from is the real one, however long the previous scene is", async () => {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 2 }));
  // 17 000 words of six letters: 119 000 characters, more than the 100 000 that were read before the ending was taken.
  const ai = writing((number) => (number === 1 ? scene(17000, 1) : scene(250, 2)), { scenes: 2, reviewVerdict: () => "approve" });
  const state = await run(store, ai, { ...BRIEF, scenesPerChapter: 2, wordsPerScene: 300 }, { specialists: false });
  assert.equal(state.status, "completed", state.lastError?.message);
  const second = ai.calls.find((entry) => entry.label === "autopilot:write:1.2");
  const section = /PREVIOUS SCENE ENDING[^\n]*\n([\s\S]*?)\n\n/.exec(second.user)?.[1] ?? "";
  assert.ok(section.endsWith("END OF SCENE 1."), section.slice(-80));
});
