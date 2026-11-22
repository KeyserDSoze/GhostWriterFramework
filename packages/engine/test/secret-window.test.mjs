import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { AutopilotSession, SECRET_RULES_MAX_CHARS, SECRET_WINDOW_CHAPTERS, loadBookSnapshot, parseAutopilotState, readBody, referencedChapterNumber, secretRules } = engine;

const FAST = { readers: false, readersOnPlan: false, pauseAfterPlan: false };
const chapterRef = (number) => `chapter:${String(number).padStart(3, "0")}-ch`;

/** The rules as the engine wrote them before they were windowed: every secret, with its truth. */
async function legacySecretRules(store, snapshot, chapterNumber, maxBody = 500) {
  const secrets = snapshot.canon.filter((entry) => entry.kind === "secret");
  if (!secrets.length) return "";
  const lines = await Promise.all(secrets.map(async (secret) => {
    const reveal = referencedChapterNumber(secret.revealIn) ?? referencedChapterNumber(secret.knownFrom);
    const truth = await readBody(store, secret.path, maxBody);
    let rule;
    if (!reveal) rule = "No reveal threshold: keep it hidden unless the chapter plan explicitly reveals it.";
    else if (chapterNumber === undefined) rule = `Reveal planned in chapter ${reveal}.`;
    else if (chapterNumber < reveal) rule = `HIDDEN until chapter ${reveal}: do not reveal it here; only subtle, deniable hints are allowed.`;
    else if (chapterNumber === reveal) rule = "The reveal is planned in THIS chapter.";
    else rule = `Already revealable (since chapter ${reveal}).`;
    return `- ${secret.name}: ${rule}${truth ? `\n  Truth: ${truth.replace(/\s+/g, " ")}` : ""}`;
  }));
  return lines.join("\n");
}

/** A secret file: `reveal` and `known` are chapter numbers, both optional. */
function secretFile(name, { reveal, known, truth = "The truth of it is known to the writer alone." } = {}) {
  const fields = ["type: secret", `id: secret:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, `title: ${name}`];
  if (reveal) fields.push(`reveal_in: ${chapterRef(reveal)}`);
  if (known) fields.push(`known_from: ${chapterRef(known)}`);
  return `---\n${fields.join("\n")}\n---\n\n# ${name}\n\n${truth}\n`;
}

const pad = (number) => String(number).padStart(4, "0");
const nameOf = (index) => `Secret ${pad(index)}`;

/** `count` secrets, the i-th revealed in chapter `chapterOf(i)` (none when it returns 0). */
function secretFiles(count, chapterOf, truthOf = () => undefined) {
  const files = {};
  for (let index = 0; index < count; index += 1) files[`secrets/s${pad(index)}.md`] = secretFile(nameOf(index), { reveal: chapterOf(index) || undefined, truth: truthOf(index) });
  return files;
}

async function book(files) {
  const store = new MemoryBookStore({ ...seedBookFiles(), ...files });
  return { store, snapshot: await loadBookSnapshot(store) };
}

const hiddenLine = (name, chapter) => new RegExp(`^- ${name}: HIDDEN until chapter ${chapter}\\b`, "m");
const listed = (text, name) => new RegExp(`^- ${name}:`, "m").test(text);

test("for a book with few secrets the rules are exactly what they have always been", async () => {
  assert.equal(SECRET_RULES_MAX_CHARS, 24000);
  assert.equal(SECRET_WINDOW_CHAPTERS, 30);
  const long = "A long truth, written for the writer alone, that goes on and on about who knew what and when. ".repeat(8);
  const cases = [
    {},
    { "secrets/a.md": secretFile("The Wall Is Failing", { reveal: 2 }) },
    { "secrets/a.md": secretFile("The Wall Is Failing", { reveal: 2 }), "secrets/b.md": secretFile("Orrin's Debt", { known: 5 }), "secrets/c.md": secretFile("Nobody Knows") },
    secretFiles(12, (index) => (index % 4 === 0 ? 0 : index * 3), (index) => (index % 2 ? long : undefined)),
    secretFiles(30, (index) => index * 2, () => long),
  ];
  for (const files of cases) {
    const { store, snapshot } = await book(files);
    for (const chapter of [undefined, 1, 2, 5, 12, 13, 40, 400]) {
      assert.equal(await secretRules(store, snapshot, chapter), await legacySecretRules(store, snapshot, chapter), `${Object.keys(files).length} secrets, chapter ${chapter}`);
    }
    assert.equal(await secretRules(store, snapshot, 7, 200), await legacySecretRules(store, snapshot, 7, 200), "another length of truth");
  }
});

test("5000 secrets give a list under the limit, with every secret the chapter must not reveal soon, and the reveal of the chapter itself", async () => {
  const files = secretFiles(5000, (index) => (index % 400) + 1, () => "The truth of this secret is told in a few plain sentences for the writer alone. ".repeat(4));
  for (let index = 1; index <= 6; index += 1) files[`secrets/unplaced${index}.md`] = secretFile(`Unplaced ${index}`);
  const { store, snapshot } = await book(files);
  let reads = 0;
  const read = store.read.bind(store);
  store.read = (path) => {
    reads += 1;
    return read(path);
  };
  const current = 200;
  const text = await secretRules(store, snapshot, current);
  assert.ok(text.length <= 24000, `${text.length} characters`);
  assert.ok(reads < 100, `${reads} files read for 5000 secrets`);
  assert.equal(text, await secretRules(store, snapshot, current), "the same book gives the same list");

  let hidden = 0;
  for (let index = 0; index < 5000; index += 1) {
    const reveal = (index % 400) + 1;
    if (reveal > current && reveal <= current + 30) {
      hidden += 1;
      assert.match(text, hiddenLine(nameOf(index), reveal), `${nameOf(index)} (chapter ${reveal}) must stay hidden and is not in the list`);
    } else if (reveal === current) {
      assert.match(text, new RegExp(`^- ${nameOf(index)}: The reveal is planned in THIS chapter`, "m"), nameOf(index));
    }
  }
  assert.equal(hidden, 360, "12 secrets for each of the 30 chapters after this one");
  for (let index = 1; index <= 6; index += 1) assert.match(text, new RegExp(`^- Unplaced ${index}: No reveal threshold`, "m"));
  assert.equal(listed(text, nameOf(399)), false, "a secret that stays hidden until chapter 400 is far from chapter 200");
  assert.equal(listed(text, nameOf(0)), false, "and one revealed in chapter 1 is long revealed");
  assert.match(text, /not listed/i, "what is left out is said");
});

test("whatever the chapter, the list stays under the limit", async () => {
  const { store, snapshot } = await book(secretFiles(3000, (index) => (index % 300) + 1, () => "Truth. ".repeat(60)));
  for (const chapter of [undefined, 1, 2, 30, 31, 150, 299, 300, 301, 330, 331, 5000]) {
    const text = await secretRules(store, snapshot, chapter);
    assert.ok(text.length <= 24000, `chapter ${chapter}: ${text.length} characters`);
    // A secret revealed more than 30 chapters before is not listed: from chapter 331 on, nothing in this book is near.
    if (chapter === undefined || chapter <= 330) assert.ok(text.length > 0, `chapter ${chapter}: an empty list`);
  }
  const small = await secretRules(store, snapshot, 150, 500, { maxChars: 3000 });
  assert.ok(small.length <= 3000, `${small.length} characters for a limit of 3000`);
  assert.match(small, /^- Secret/m);
});

test("the truths are shortened before a single secret is left out", async () => {
  // 100 secrets with long truths, all within 30 chapters of chapter 50: with their whole truth they are 60 000 characters.
  const long = "The truth of this secret is told at some length, for the writer alone, and it matters. ".repeat(8);
  const { store, snapshot } = await book(secretFiles(100, (index) => 40 + (index % 25), () => long));
  const text = await secretRules(store, snapshot, 50);
  assert.ok(text.length <= 24000, `${text.length} characters`);
  assert.ok((await legacySecretRules(store, snapshot, 50)).length > 24000);
  for (let index = 0; index < 100; index += 1) assert.match(text, new RegExp(`^- ${nameOf(index)}: [^\\n]+\\n  Truth: [^\\n]*The truth of this secret`, "m"), `${nameOf(index)} keeps the start of its truth`);
  assert.equal(/not listed/i.test(text), false, "nothing is left out");
});

test("what the chapter must not reveal is kept before what was revealed, and nearest first", async () => {
  // Chapter 100: 500 secrets revealed in 80-99 and 500 that stay hidden until 101-120. Both cannot fit, the hidden ones can.
  const files = secretFiles(1000, (index) => (index < 500 ? 80 + Math.floor(index / 25) : 101 + Math.floor((index - 500) / 25)), () => "Truth. ".repeat(80));
  const { store, snapshot } = await book(files);
  const text = await secretRules(store, snapshot, 100);
  assert.ok(text.length <= 24000, `${text.length} characters`);
  for (let index = 500; index < 1000; index += 1) assert.match(text, hiddenLine(nameOf(index), 101 + Math.floor((index - 500) / 25)), nameOf(index));
  for (let index = 0; index < 500; index += 1) assert.equal(listed(text, nameOf(index)), false, `${nameOf(index)} was revealed and is dropped first`);
});

test("when even the secrets that must stay hidden do not fit, the nearest ones are kept and the rest is said", async () => {
  // Chapter 40: 900 secrets, 30 for each of the chapters 41-70, all hidden.
  const { store, snapshot } = await book(secretFiles(900, (index) => 41 + Math.floor(index / 30)));
  const text = await secretRules(store, snapshot, 40);
  assert.ok(text.length <= 24000, `${text.length} characters`);
  for (let index = 0; index < 15 * 30; index += 1) assert.match(text, hiddenLine(nameOf(index), 41 + Math.floor(index / 30)), `${nameOf(index)}`);
  for (let index = 29 * 30; index < 900; index += 1) assert.equal(listed(text, nameOf(index)), false, `${nameOf(index)} is the farthest`);
  assert.match(text, /not listed/i);
});

test("a secret with only known_from is windowed like the others, and a nearer reveal_in is the one that counts", async () => {
  const files = {
    "secrets/a.md": secretFile("Known Only", { known: 205 }),
    "secrets/b.md": secretFile("Both", { reveal: 203, known: 150 }),
  };
  Object.assign(files, secretFiles(2500, (index) => (index % 500) + 1000, () => "Truth. ".repeat(70)));
  const { store, snapshot } = await book(files);
  const text = await secretRules(store, snapshot, 200);
  assert.ok(text.length <= 24000);
  assert.match(text, hiddenLine("Known Only", 205));
  assert.match(text, hiddenLine("Both", 203));
});

test("a long book keeps every prompt that carries the secrets under the limit, and the nearest secrets in it", async () => {
  // 1200 secrets for a book of two chapters: 20 a chapter over 60 chapters.
  const files = secretFiles(1200, (index) => (index % 60) + 1, () => "A truth for the writer alone. ".repeat(10));
  const store = new MemoryBookStore({ ...seedBookFiles(), ...files });
  const ai = createFakeAutopilotAi({ reviewVerdict: () => "approve" });
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0 });
  await session.start({ brief: { idea: "x", targetChapters: 2, scenesPerChapter: 1, wordsPerScene: 300 }, options: { ...FAST, specialists: true } });
  await session.waitForIdle();
  const state = parseAutopilotState(store.files.get("autopilot/state.json"));
  assert.equal(state.status, "completed", state.lastError?.message);
  const section = (call) => /SECRETS AND REVEAL RULES:\n([\s\S]*?)(?:\n\n|\n<\/repository_content>)/.exec(call.user)?.[1];
  let seen = 0;
  for (const label of ["autopilot:scenes:1", "autopilot:write:1.1", "autopilot:specialists:1", "autopilot:director-review:1", "autopilot:scenes:2", "autopilot:write:2.1"]) {
    const call = ai.calls.find((entry) => entry.label === label);
    assert.ok(call, label);
    const rules = section(call);
    assert.ok(rules, `${label}: no secrets section`);
    assert.ok(rules.length <= 24000, `${label}: ${rules.length} characters`);
    assert.match(rules, /^- Secret 0001: HIDDEN until chapter 2\b|^- Secret 0001: The reveal is planned in THIS chapter/m, label);
    seen += 1;
  }
  assert.equal(seen, 6);
});
