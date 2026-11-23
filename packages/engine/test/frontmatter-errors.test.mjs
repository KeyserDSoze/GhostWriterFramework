import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const {
  AutopilotSession,
  askDirector,
  chapterReaderText,
  defaultDirector,
  defaultGhostwriter,
  directorPrompt,
  mergeReaderPersonas,
  normalizeDirectorOpinionOutput,
  parseAutopilotState,
  parseDirector,
  parseGhostwriter,
  parseMarkdown,
  parseReaderPersona,
  renderMarkdown,
  serializeDirector,
  stripFrontmatter,
  withFrontmatter,
} = engine;

const FAST = { readers: false, readersOnPlan: false, pauseAfterPlan: false };
const ONE = { brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: FAST };
const BOM = "\uFEFF";

// ─── One splitter, a byte order mark, and errors that are reported ─────────────────────────────────────────────────────

const SCENE_WITH_BOM = `${BOM}---\r\ntype: paragraph\r\nid: paragraph:001-a:001-b\r\ntitle: Dawn\r\nnumber: 1\r\n---\r\n\r\nThe author's scene.\r\n`;

test("a byte order mark before the frontmatter is ignored by parseMarkdown and stripFrontmatter", () => {
  const document = parseMarkdown(SCENE_WITH_BOM);
  assert.equal(document.hasFrontmatter, true);
  assert.deepEqual(document.frontmatter, { type: "paragraph", id: "paragraph:001-a:001-b", title: "Dawn", number: 1 });
  assert.equal(document.body, "The author's scene.");
  assert.equal(document.error, undefined);
  assert.equal(stripFrontmatter(SCENE_WITH_BOM), "The author's scene.");
  assert.equal(chapterReaderText([{ title: "Dawn", raw: SCENE_WITH_BOM }]), "## Dawn\n\nThe author's scene.");
  assert.equal(parseMarkdown(`${BOM}Just text`).body, "Just text");
  assert.equal(parseMarkdown(`${BOM}Just text`).hasFrontmatter, false);
});

test("a file with a byte order mark keeps its type and its id when it is rewritten", () => {
  const rewritten = parseMarkdown(withFrontmatter(SCENE_WITH_BOM, { summary: "S" }));
  assert.deepEqual(rewritten.frontmatter, { type: "paragraph", id: "paragraph:001-a:001-b", title: "Dawn", number: 1, summary: "S" });
  assert.equal(rewritten.body, "The author's scene.");
});

test("parseMarkdown and stripFrontmatter cut a file in the same place", () => {
  const files = [
    "---\ntitle: A\n---\n\nBody",
    "---\r\ntitle: A\r\n---\r\n\r\nBody\r\n",
    SCENE_WITH_BOM,
    "---\ntitle: a --- b\nsummary: s\n---\n\nBody",
    "---\ntitle: A\n---\n\nText\n\n---\n\nMore",
    "Text\n\n---\n\nMore",
    "No frontmatter at all.",
    "---\ntitle: A\n---",
  ];
  for (const raw of files) assert.equal(stripFrontmatter(raw), parseMarkdown(raw).body, JSON.stringify(raw));
  assert.equal(stripFrontmatter("---\ntitle: a --- b\nsummary: s\n---\n\nBody"), "Body", "a --- inside a value does not end the frontmatter");
  assert.equal(stripFrontmatter("Text\n\n---\n\nMore"), "Text\n\n---\n\nMore", "a rule in a file without frontmatter is text");
});

const BROKEN = [
  ["a colon inside a value", "title: Chapter: One\nnumber: 1", 2],
  ["an unclosed bracket", "title: [unclosed\nnumber: 1", 3],
  ["an unclosed list of tags", "tags: [a, b\nnumber: 3", 3],
  ["a tab used as indentation", "title: 'ok'\n\tnumber: 1", 3],
  ["a key twice", "number: 1\nnumber: 2", 3],
  ["a colon inside a summary", "summary: 50% of it: yes\nnumber: 3", 2],
  ["a quote that is never closed", "key: \"unterminated\nnumber: 1", 3],
];

test("parseMarkdown says that the frontmatter is not valid YAML, and on which line", () => {
  for (const [name, yaml, line] of BROKEN) {
    const document = parseMarkdown(`---\n${yaml}\n---\n\nbody`);
    assert.equal(document.hasFrontmatter, true, name);
    assert.equal(typeof document.error, "string", `${name}: no error`);
    assert.ok(document.error.length > 0, name);
    assert.equal(document.errorLine, line, `${name}: the line of the file`);
    assert.equal(document.body, "body", name);
  }
  const withBom = parseMarkdown(`${BOM}---\r\ntitle: A: B\r\n---\r\nbody`);
  assert.equal(withBom.errorLine, 2, "a byte order mark does not count as a line");
});

test("a frontmatter that is not a mapping of keys and values is an error, and an empty one is not", () => {
  for (const yaml of ["just text", "- a\n- b"]) {
    const document = parseMarkdown(`---\n${yaml}\n---\n\nbody`);
    assert.equal(document.hasFrontmatter, true, yaml);
    assert.match(document.error ?? "", /mapping|keys/i, yaml);
  }
  for (const raw of ["---\n\n---\nbody", "---\n# only a comment\n---\nbody", "---\n---\nbody"]) {
    const document = parseMarkdown(raw);
    assert.equal(document.error, undefined, JSON.stringify(raw));
    assert.deepEqual(document.frontmatter, {}, JSON.stringify(raw));
    assert.equal(document.body, "body", JSON.stringify(raw));
  }
});

test("an alias bomb is an error, not an exception, and good frontmatter has none", () => {
  const document = parseMarkdown(`---\n${aliasBomb()}---\nbody`);
  assert.equal(typeof document.error, "string");
  assert.equal(document.hasFrontmatter, true);
  const hostile = [
    "Chapter: One", "# Heading", "- list", "null", "true", "123", "2024-01-01", "a: b: c", "He said \"hi\"", "line1\nline2", "---", "...", "* alias", "&anchor x", "!!str x", "@at", "`tick", "%dir", "{a: 1}", "[1,2]",
    "é日本語😀", "tab\there", "trailing space ", " leading", "multi\n---\nline", "'quoted'", "yes", "~", "0x1F", "1e3", "NaN", ".inf",
  ];
  for (const title of hostile) {
    const rendered = parseMarkdown(renderMarkdown({ type: "chapter", title, summary: title }, "body"));
    assert.equal(rendered.error, undefined, JSON.stringify(title));
    assert.equal(rendered.frontmatter.title, title);
    assert.equal(rendered.frontmatter.summary, title);
    assert.equal(rendered.frontmatter.type, "chapter");
    assert.equal(Object.keys(rendered.frontmatter).length, 3, JSON.stringify(title));
  }
  for (const yaml of ["title: Mara & Orrin\nnumber: 1", "a: &x [1,2]\nb: *x", "title: 'ok'\nnumber: 1", "tags: [a, b]\nnumber: 3", "summary: >\n  A folded summary that\n  continues here.\npov:\n  - Mira\n  - Orrin"]) {
    assert.equal(parseMarkdown(`---\n${yaml}\n---\n\nbody`).error, undefined, yaml);
  }
});

test("a file without frontmatter is what it always was: no frontmatter, no error", () => {
  for (const raw of ["Just a scene.", "Text\n\n---\n\nMore", "", "---not frontmatter---"]) {
    const document = parseMarkdown(raw);
    assert.equal(document.hasFrontmatter, false, JSON.stringify(raw));
    assert.equal(document.error, undefined, JSON.stringify(raw));
    assert.deepEqual(document.frontmatter, {});
    assert.equal(document.body, raw.trim());
  }
  assert.equal(withFrontmatter("Plain text", { summary: "S" }), "---\nsummary: S\n---\n\nPlain text\n");
});

test("a FrontmatterError names the file, the line and the reason, in the language it is given", () => {
  const english = new engine.FrontmatterError("chapters/001-a/chapter.md", "Map keys must be unique", 5, "en");
  assert.deepEqual([english.name, english.code, english.path, english.line, english.reason], ["FrontmatterError", "frontmatter_invalid", "chapters/001-a/chapter.md", 5, "Map keys must be unique"]);
  assert.match(english.message, /^Correct the frontmatter of chapters\/001-a\/chapter\.md \(line 5: Map keys must be unique\)/);
  assert.ok(english instanceof Error);
  const italian = new engine.FrontmatterError("chapters/001-a/chapter.md", "Map keys must be unique", 5, "it");
  assert.match(italian.message, /^Correggi il frontmatter di chapters\/001-a\/chapter\.md \(riga 5: Map keys must be unique\)/);
  assert.match(new engine.FrontmatterError(undefined, "reason").message, /^Correct the frontmatter of this file \(reason\)/);
  assert.doesNotThrow(() => engine.assertFrontmatterReadable("a.md", parseMarkdown("---\ntitle: A\n---\nbody")));
  assert.throws(() => engine.assertFrontmatterReadable("a.md", parseMarkdown("---\ntitle: A: B\n---\nbody")), (error) => error instanceof engine.FrontmatterError && error.path === "a.md" && error.line === 2);
});

test("withFrontmatter refuses to rewrite a file whose frontmatter it cannot read", () => {
  assert.equal(typeof engine.FrontmatterError, "function");
  assert.throws(() => withFrontmatter("---\ntitle: A: B\nnumber: 1\n---\n\nBody", { summary: "S" }), engine.FrontmatterError);
  assert.throws(() => withFrontmatter("---\n\nA scene that starts with a rule.\n\n---\n\nSecond part", { summary: "S" }), engine.FrontmatterError, "the first part is not lost");
  assert.equal(parseMarkdown(withFrontmatter("---\ntitle: A\n---\n\nBody", { summary: "S" })).frontmatter.summary, "S");
});

function aliasBomb() {
  let yaml = "a: &a [x,x,x,x,x,x,x,x,x,x]\n";
  for (let index = 0; index < 12; index += 1) {
    const name = String.fromCharCode(98 + index);
    const previous = String.fromCharCode(97 + index);
    yaml += `${name}: &${name} [*${previous},*${previous},*${previous},*${previous}]\n`;
  }
  return yaml;
}

// ─── Profiles: no silent defaults ───────────────────────────────────────────────────────────────────────────────────────

const frontmatter = (yaml, body = "Vision") => `---\n${yaml}\n---\n\n${body}`;

test("a typo in director.md is reported, with its line, and never swallowed", () => {
  const profile = parseDirector("---\nname: Ada: the strict\nstrictness: 9\nred_lines:\n  - No gore\n---\nVision");
  assert.ok(Array.isArray(profile.warnings));
  assert.equal(profile.warnings.length, 1, profile.warnings.join(" | "));
  assert.match(profile.warnings[0], /director\.md/);
  assert.match(profile.warnings[0], /YAML/);
  assert.match(profile.warnings[0], /line 2/);
  assert.doesNotThrow(() => parseDirector(`---\n${aliasBomb()}---\nbody`));
  assert.ok(parseDirector(`---\n${aliasBomb()}---\nbody`).warnings.length >= 1);
});

test("a director whose persona and name are hostile to YAML, or whose vision starts with a rule, survives a round trip", () => {
  const profile = { ...defaultDirector("en"), persona: "He said: \"stop\" # not a comment\n---\nnext", name: "- Ada", body: "---\nVision after a rule" };
  const back = parseDirector(serializeDirector(profile));
  assert.equal(back.persona, profile.persona);
  assert.equal(back.name, profile.name);
  assert.equal(back.body, profile.body);
  assert.deepEqual(back.warnings, []);
});

test("the autonomy of the director is read whatever its case or spacing, and a value nobody knows is reported", () => {
  for (const [value, expected] of [["Full", "full"], [" FULL ", "full"], ["ask-always", "ask-always"], ["Ask-Always", "ask-always"], ["ASK-ON-CRITICAL", "ask-on-critical"], ["ask on critical", "ask-on-critical"], ["ask_on_critical", "ask-on-critical"]]) {
    const profile = parseDirector(frontmatter(`autonomy: ${JSON.stringify(value)}`));
    assert.equal(profile.autonomy, expected, value);
    assert.deepEqual(profile.warnings, [], value);
  }
  assert.equal(parseDirector(frontmatter("autonomy: Full")).autonomy, "full", "unquoted too");
  const unknown = parseDirector(frontmatter("autonomy: nonsense"));
  assert.equal(unknown.autonomy, "ask-on-critical");
  assert.equal(unknown.warnings.length, 1);
  assert.match(unknown.warnings[0], /autonomy/);
  assert.match(unknown.warnings[0], /nonsense/);
});

test("the weights of the readers keep their decimals", () => {
  const profile = parseDirector(frontmatter("reader_weights:\n  standard-critical: 0.4\n  standard-style: 2.5\n  standard-plot: '0.25'\n  standard-emotional: 7\n  standard-general: -1\n  standard-worldbuilding:"));
  assert.deepEqual(profile.readerWeights, { "standard-critical": 0.4, "standard-style": 2.5, "standard-plot": 0.25, "standard-emotional": 3, "standard-general": 0, "standard-worldbuilding": 1 });
  assert.deepEqual(profile.warnings, [], "a weight left empty is the normal one, without a warning");
  const odd = parseDirector(frontmatter("reader_weights:\n  standard-plot: heavy"));
  assert.equal(odd.readerWeights["standard-plot"], 1);
  assert.equal(odd.warnings.length, 1);
  assert.match(odd.warnings[0], /standard-plot/);
  const notWeights = parseDirector(frontmatter("reader_weights: 3"));
  assert.deepEqual(notWeights.readerWeights, {});
  assert.equal(notWeights.warnings.length, 1);
});

test("the scores of the director keep their decimals, accept a decimal comma, and report what is not a number", () => {
  const profile = parseDirector(frontmatter("approval_score: 7.5\nstrictness: '9,5'\nmax_review_rounds: 2"));
  assert.equal(profile.approvalScore, 7.5);
  assert.equal(profile.strictness, 9.5);
  assert.deepEqual(profile.warnings, []);
  assert.match(directorPrompt(profile), /Strictness: 9\.5\/10/);
  assert.match(directorPrompt(profile), /at least 7\.5\/10/);
  const round = parseDirector(serializeDirector({ ...defaultDirector("en"), approvalScore: 7.5, strictness: 8.5 }));
  assert.deepEqual([round.approvalScore, round.strictness], [7.5, 8.5], "saving the profile does not round it");
  const clamped = parseDirector(frontmatter("strictness: 42\napproval_score: 0\nmax_review_rounds: 9"));
  assert.deepEqual([clamped.strictness, clamped.approvalScore, clamped.maxReviewRounds], [10, 1, 3]);
  assert.deepEqual(clamped.warnings, [], "a number outside the scale is limited, as it has always been");
  assert.equal(parseDirector(frontmatter("strictness: '9'")).strictness, 9, "a number written as text");
  const word = parseDirector(frontmatter("strictness: high"));
  assert.equal(word.strictness, 7);
  assert.equal(word.warnings.length, 1);
  assert.match(word.warnings[0], /strictness/);
});

test("the lists of the director keep every line, and what cannot be a list is reported", () => {
  assert.deepEqual(parseDirector(frontmatter("red_lines: Never kill the dog")).redLines, ["Never kill the dog"]);
  assert.deepEqual(parseDirector(frontmatter("red_lines:")).redLines, [], "an empty key is an empty list, as before");
  const colon = parseDirector(frontmatter("red_lines:\n  - No gore: at all\n  - 42\n  - Never kill the dog"));
  assert.deepEqual(colon.redLines, ["No gore: at all", "42", "Never kill the dog"]);
  assert.deepEqual(colon.warnings, []);
  const number = parseDirector(frontmatter("red_lines: 5"));
  assert.deepEqual(number.redLines, defaultDirector("en").redLines, "the lines are not silently emptied");
  assert.equal(number.warnings.length, 1);
  assert.match(number.warnings[0], /red_lines/);
  const nested = parseDirector(frontmatter("taste:\n  - Subtext\n  - [a, b]"));
  assert.deepEqual(nested.taste, ["Subtext"]);
  assert.equal(nested.warnings.length, 1);
});

test("a byte order mark does not hide the profile", () => {
  const director = parseDirector(`${BOM}---\nname: Ada\nstrictness: 9\n---\nVision`);
  assert.deepEqual([director.name, director.strictness, director.warnings], ["Ada", 9, []]);
  const ghostwriter = parseGhostwriter("x", `${BOM}---\nname: A\ntone: warm\n---\nbody`);
  assert.deepEqual([ghostwriter.name, ghostwriter.tone, ghostwriter.warnings], ["A", "warm", []]);
  const persona = parseReaderPersona("x", `${BOM}---\nname: Anna\ndescription: d\n---\nbody`);
  assert.deepEqual([persona.name, persona.description, persona.warnings], ["Anna", "d", []]);
});

test("a valid profile has no warnings, and the defaults have none either", () => {
  const director = defaultDirector("it");
  assert.deepEqual(parseDirector(serializeDirector(director), "it"), director);
  assert.deepEqual(parseDirector(serializeDirector(director), "it").warnings, []);
  assert.deepEqual(parseDirector("Just a vision, no frontmatter.").warnings, []);
  assert.deepEqual(parseGhostwriter("x", "---\n\n---\nbody").warnings, []);
  assert.equal(parseGhostwriter("x", "---\n\n---\nbody").name, "x");
  assert.deepEqual(parseGhostwriter("x", "Just instructions.").warnings, []);
  assert.deepEqual(parseReaderPersona("x", "---\nname: Anna\n---\nbody").warnings, []);
  assert.deepEqual(defaultGhostwriter("en").warnings, []);
});

test("a ghostwriter with a typo, or with frontmatter that is not a mapping, is reported and does not throw", () => {
  const typo = parseGhostwriter("anna", "---\nname: Anna: the reader\ntone: warm\n---\nbody");
  assert.equal(typo.slug, "anna");
  assert.equal(typo.warnings.length, 1, typo.warnings.join(" | "));
  assert.match(typo.warnings[0], /ghostwriters\/anna\.md/);
  assert.match(typo.warnings[0], /line 2/);
  for (const raw of ["---\njust text\n---\nbody", "---\n- a\n- b\n---\nbody"]) {
    const profile = parseGhostwriter("x", raw);
    assert.equal(profile.name, "x");
    assert.equal(profile.warnings.length, 1, raw);
  }
  assert.ok(parseGhostwriter("x", `---\n${aliasBomb()}---\nbody`).warnings.length >= 1, "an alias bomb no longer throws");
});

test("the values of a ghostwriter are read as the author wrote them, and the ones that cannot be read are reported", () => {
  for (const [value, expected] of [["0.7", 0.7], ["'0.7'", 0.7], ["'0,7'", 0.7], ["1", 1]]) {
    const profile = parseGhostwriter("x", frontmatter(`temperature: ${value}`));
    assert.equal(profile.temperature, expected, value);
    assert.deepEqual(profile.warnings, [], value);
  }
  assert.equal(parseGhostwriter("x", frontmatter("tone: warm")).temperature, 0.8);
  const hot = parseGhostwriter("x", frontmatter("temperature: hot"));
  assert.equal(hot.temperature, 0.8);
  assert.equal(hot.warnings.length, 1);
  assert.match(hot.warnings[0], /temperature/);
  const list = parseGhostwriter("x", frontmatter("tone: [warm, sharp]\navoid: warm, tense\nstrengths: 5"));
  assert.equal(list.tone, "");
  assert.deepEqual(list.avoid, ["warm", "tense"]);
  assert.deepEqual(list.strengths, []);
  assert.equal(list.warnings.length, 2);
  assert.match(list.warnings.join(" "), /tone/);
  assert.match(list.warnings.join(" "), /strengths/);
});

test("the type, the severity and the switches of a reader are read whatever their case, and what is not understood is reported", () => {
  for (const [value, expected] of [["Genre", "genre"], [" STANDARD ", "standard"], ["custom", "custom"]]) {
    const persona = parseReaderPersona("x", frontmatter(`reader_type: ${JSON.stringify(value)}`));
    assert.equal(persona.readerType, expected, value);
    assert.deepEqual(persona.warnings, [], value);
  }
  const typo = parseReaderPersona("x", frontmatter("reader_type: gnere"));
  assert.equal(typo.readerType, "custom");
  assert.equal(typo.warnings.length, 1);
  assert.match(typo.warnings[0], /personas\/x\.md/);
  assert.match(typo.warnings[0], /reader_type/);
  assert.equal(parseReaderPersona("x", frontmatter("severity: '7'")).severity, 7);
  assert.equal(parseReaderPersona("x", frontmatter("severity: 7.5")).severity, 7.5);
  const loud = parseReaderPersona("x", frontmatter("severity: loud\norder: soon"));
  assert.deepEqual([loud.severity, loud.order], [5, 1000]);
  assert.equal(loud.warnings.length, 2);
  for (const value of ["false", "\"false\"", "no", "off", "\"No\""]) assert.equal(parseReaderPersona("x", frontmatter(`enabled: ${value}`)).enabled, false, value);
  for (const value of ["true", "yes", "\"ON\""]) assert.equal(parseReaderPersona("x", frontmatter(`enabled: ${value}`)).enabled, true, value);
  const maybe = parseReaderPersona("x", frontmatter("enabled: maybe"));
  assert.equal(maybe.enabled, true);
  assert.equal(maybe.warnings.length, 1);
  assert.deepEqual(parseReaderPersona("x", frontmatter("aspects: pacing, voice")).aspects, ["pacing", "voice"]);
  assert.ok(parseReaderPersona("x", `---\n${aliasBomb()}---\nbody`).warnings.length >= 1, "an alias bomb no longer throws");
});

test("a reader with a typo, or with frontmatter that is not a mapping, is reported and does not throw", () => {
  const typo = parseReaderPersona("anna", "---\nname: Anna: the reader\ndescription: d\n---\nbody");
  assert.equal(typo.slug, "anna");
  assert.equal(typo.warnings.length, 1, typo.warnings.join(" | "));
  assert.match(typo.warnings[0], /personas\/anna\.md/);
  assert.match(typo.warnings[0], /line 2/);
  for (const raw of ["---\n- a\n- b\n---\nbody", "---\njust text\n---\nbody"]) {
    const persona = parseReaderPersona("x", raw);
    assert.equal(persona.name, "x", raw);
    assert.equal(persona.warnings.length, 1, raw);
  }
});

test("the warnings of a reader file travel with it into the panel", () => {
  const broken = parseReaderPersona("standard-critical", "---\nid: reader:standard.critical\nenabled: false\nname: A: B\n---\nbody");
  assert.equal(broken.warnings.length, 1);
  const panel = mergeReaderPersonas("en", [broken]);
  assert.equal(panel.find((persona) => persona.id === "reader:standard.critical").warnings.length, 1);
  assert.deepEqual(panel.find((persona) => persona.id === "reader:standard.general").warnings, []);
});

// ─── What dir1.mjs proved: the director's opinion ───────────────────────────────────────────────────────────────────────

function opinionAi(json) {
  const calls = [];
  return {
    calls,
    async complete(request) {
      calls.push(request);
      return { text: "", json, usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }, model: "m", provider: "p" };
    },
  };
}

test("the director's verdict is read whatever its case, its score may have a decimal comma, and an opinion without a score is refused", async () => {
  const output = normalizeDirectorOpinionOutput({ verdict: "Approved", score: "7,5", summary: "Great", strengths: "a\nb", concerns: [{ severity: "High", issue: "x", suggestion: "y" }] });
  assert.deepEqual(output, { verdict: "approve", score: 7.5, summary: "Great", strengths: ["a", "b"], concerns: [{ severity: "minor", issue: "x", suggestion: "y" }], decisions: [], nextSteps: [], questionsForAuthor: [] });
  const store = new MemoryBookStore(seedBookFiles({ chapters: 2 }));
  await assert.rejects(() => askDirector({ store, ai: opinionAi({ verdict: "approved", summary: "Wonderful." }), target: { kind: "book" }, save: true }), /score/);
  assert.equal(store.files.has("evaluations/director/book.md"), false, "nothing is saved for a reply without a score");
});

test("askDirector reports the problems of director.md next to the opinion, and leaves the file alone", async () => {
  const typo = "---\nname: Ada: the strict\nstrictness: 9\n---\nVision";
  const store = new MemoryBookStore({ ...seedBookFiles({ chapters: 2 }), "director.md": typo });
  const ai = opinionAi({ verdict: "approve", score: 8, summary: "Fine.", strengths: [], concerns: [], decisions: [], nextSteps: [] });
  const result = await askDirector({ store, ai, target: { kind: "book" }, save: true });
  assert.equal(result.opinion.verdict, "approve");
  assert.equal(result.saved, true);
  assert.ok(Array.isArray(result.warnings));
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /director\.md/);
  assert.equal(store.files.get("director.md"), typo, "the file is never replaced by the defaults");
  const fine = await askDirector({ store: new MemoryBookStore(seedBookFiles({ chapters: 2 })), ai, target: { kind: "book" } });
  assert.deepEqual(fine.warnings, []);
});

// ─── The autopilot: it stops at a profile it cannot read, and rewrites nothing it cannot read ───────────────────────────

function reply(json, extra = {}) {
  return { text: JSON.stringify(json), json, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }, model: "fake-model", provider: "fake", cost: 0.001, currency: "USD", ...extra };
}

async function run(files, ai, start = ONE) {
  const store = new MemoryBookStore(files);
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0 });
  session.subscribe((event) => events.push(event));
  await session.start(start);
  await session.waitForIdle();
  return { store, session, events, state: parseAutopilotState(store.files.get("autopilot/state.json")) };
}

async function resume(context, start) {
  await context.session.start(start);
  await context.session.waitForIdle();
  return parseAutopilotState(context.store.files.get("autopilot/state.json"));
}

const labels = (ai) => ai.calls.map((call) => call.label);

test("a typo in director.md stops the autopilot before it asks the model anything, lists the problem, and leaves the file as it is", async () => {
  const typo = "---\nname: Ada: the strict\nstrictness: 9\nred_lines:\n  - No gore\n---\nVision";
  const ai = createFakeAutopilotAi();
  const context = await run({ ...seedBookFiles({ chapters: 2 }), "director.md": typo }, ai);
  assert.equal(ai.calls.length, 0, "nothing was spent");
  assert.equal(context.state.status, "waiting-author");
  assert.match(context.state.message, /director\.md/);
  assert.match(context.state.message, /YAML/);
  assert.match(context.state.message, /line 2/);
  assert.equal(context.store.files.get("director.md"), typo, "the defaults do not replace the file");
  assert.ok(context.events.some((event) => event.type === "run-ended" && event.status === "waiting-author"));
  const insight = context.events.find((event) => event.type === "insight" && event.code === "profileProblems");
  assert.ok(insight, "the live feed says it too, with a code a host can translate");
  assert.equal(insight.tone, "warning");
  assert.match(insight.detail, /director\.md/);
  const fixed = await (async () => {
    context.store.write("director.md", "---\nname: Ada\nstrictness: 9\nred_lines:\n  - No gore\n---\nVision");
    return resume(context);
  })();
  assert.equal(fixed.status, "completed", fixed.lastError?.message);
});

test("the message lists the problems of a profile that has many, and says how many more there are", async () => {
  const weights = Array.from({ length: 12 }, (_, index) => `  standard-r${index}: heavy`).join("\n");
  const context = await run({ ...seedBookFiles({ chapters: 2 }), "director.md": `---\nname: Ada\nreader_weights:\n${weights}\n---\nVision` }, createFakeAutopilotAi());
  assert.equal(context.state.status, "waiting-author");
  assert.match(context.state.message, /standard-r0\b/);
  assert.match(context.state.message, /\(and 4 more\)/);
  assert.ok(context.state.message.length < 3500, `${context.state.message.length} characters`);
});

test("the message to an author who writes in Italian is in Italian", async () => {
  const typo = "---\nname: Ada: la severa\n---\nVisione";
  const ai = createFakeAutopilotAi();
  const context = await run({ ...seedBookFiles({ chapters: 2, language: "it" }), "director.md": typo }, ai);
  assert.equal(context.state.status, "waiting-author");
  assert.match(context.state.message, /correggi/i);
  assert.match(context.state.message, /director\.md/);
});

test("autonomy: Full is the autonomy full, and a reader weighted 0.4 is not ignored", async () => {
  const ai = createFakeAutopilotAi({ reviewVerdict: () => "approve" });
  const files = { ...seedBookFiles({ chapters: 2 }), "director.md": "---\nautonomy: Full\nreader_weights:\n  standard-general: 0.4\n---\nVision" };
  const { state } = await run(files, ai, { brief: ONE.brief, options: { ...FAST, readers: true, maxReaders: 2 } });
  assert.equal(state.status, "completed", state.lastError?.message);
  const review = ai.calls.find((call) => call.label === "autopilot:plan-review");
  assert.match(review.user, /Never ask the author: decide\./, "the director decides everything");
  assert.ok(labels(ai).includes("reader-evaluation:standard-general"), "the reader with weight 0.4 reads the chapter");
});

test("a ghostwriter the autopilot cannot read stops it before it writes, and names the file", async () => {
  const broken = "---\nname: Default: Ghost\ntone: Natural\n---\n\nWrite well.\n";
  const ai = createFakeAutopilotAi();
  const context = await run({ ...seedBookFiles({ chapters: 2 }), "ghostwriters/default.md": broken }, ai);
  assert.equal(context.state.status, "waiting-author");
  assert.match(context.state.message, /ghostwriters\/default\.md/);
  assert.equal(labels(ai).some((label) => label.startsWith("autopilot:write")), false, "no scene was written with a profile that was not read");
  assert.equal(context.store.files.get("ghostwriters/default.md"), broken);
  context.store.write("ghostwriters/default.md", "---\nname: Default Ghost\ntone: Natural\n---\n\nWrite well.\n");
  assert.equal((await resume(context)).status, "completed");
});

test("a reader file the autopilot cannot read stops it only when readers are used", async () => {
  const broken = "---\nid: reader:standard.general\nenabled: false\nname: General: reader\n---\nbody";
  const files = { ...seedBookFiles({ chapters: 2 }), "personas/standard-general.md": broken };
  const ai = createFakeAutopilotAi();
  const withReaders = await run(files, ai, { brief: ONE.brief, options: { ...FAST, readers: true, maxReaders: 2 } });
  assert.equal(withReaders.state.status, "waiting-author");
  assert.match(withReaders.state.message, /personas\/standard-general\.md/);
  assert.equal(ai.calls.length, 0);
  const without = await run(files, createFakeAutopilotAi(), ONE);
  assert.equal(without.state.status, "completed", "the readers are not used, so their files do not matter");
});

// The rewrite of a scene the author damaged by hand (t15 of the review): the summary has a colon in it.
async function bookWithScene(files = seedBookFiles({ chapters: 2 })) {
  const ai = createFakeAutopilotAi({ reviewVerdict: () => "approve" });
  const context = await run(files, ai);
  assert.equal(context.state.status, "completed", context.state.lastError?.message);
  return { ...context, ai };
}

const SCENE = "chapters/001-chapter-title-1/001-scene-1-title.md";

test("a step that would rewrite a file with frontmatter it cannot read refuses, names the file and the line, and keeps every key", async () => {
  const context = await bookWithScene();
  const damaged = context.store.files.get(SCENE).replace(/summary: .*/, "summary: Mira argues with Orrin: the wall is failing");
  context.store.write(SCENE, damaged);
  const line = damaged.split("\n").findIndex((entry) => entry.startsWith("summary:")) + 1;
  const before = context.ai.calls.length;
  await context.session.intervene({ scope: "rewrite", text: "Make Orrin kinder." });
  const state = await resume(context);
  assert.equal(state.status, "error");
  assert.ok(state.lastError.message.includes(SCENE), state.lastError.message);
  assert.match(state.lastError.message, new RegExp(`line ${line}\\b`));
  assert.match(state.lastError.message, /frontmatter/i);
  assert.equal(context.store.files.get(SCENE), damaged, "the file is exactly as the author left it");
  const asked = context.ai.calls.slice(before).map((call) => call.label);
  assert.equal(asked.some((label) => label.startsWith("autopilot:revise") || label.startsWith("autopilot:scene-summary")), false, `the model was asked to rewrite a file that cannot be written: ${asked.join(", ")}`);
  assert.equal(context.events.some((event) => event.type === "run-ended" && event.status === "error"), true);
  // The author corrects the line: the same run goes on and rewrites the scene.
  context.store.write(SCENE, damaged.replace(/summary: .*/, "summary: \"Mira argues with Orrin: the wall is failing\""));
  const fixed = await resume(context);
  assert.equal(fixed.status, "completed", fixed.lastError?.message);
  assert.equal(parseMarkdown(context.store.files.get(SCENE)).frontmatter.type, "paragraph");
});

test("the message to an author who writes in Italian names the file and the line in Italian", async () => {
  const context = await bookWithScene(seedBookFiles({ chapters: 2, language: "it" }));
  const damaged = context.store.files.get(SCENE).replace(/summary: .*/, "summary: Mira litiga con Orrin: il muro cede");
  context.store.write(SCENE, damaged);
  await context.session.intervene({ scope: "rewrite", text: "Rendi Orrin più gentile." });
  const state = await resume(context);
  assert.equal(state.status, "error");
  assert.match(state.lastError.message, /Correggi il frontmatter/);
  assert.ok(state.lastError.message.includes(SCENE));
  assert.match(state.lastError.message, /riga \d+/);
});

test("a scene with a byte order mark keeps its type, its id and its chapter when the autopilot rewrites it", async () => {
  const context = await bookWithScene();
  const original = parseMarkdown(context.store.files.get(SCENE)).frontmatter;
  context.store.write(SCENE, `${BOM}${context.store.files.get(SCENE)}`);
  await context.session.intervene({ scope: "rewrite", text: "Make Orrin kinder." });
  const state = await resume(context);
  assert.equal(state.status, "completed", state.lastError?.message);
  const rewritten = parseMarkdown(context.store.files.get(SCENE));
  assert.equal(rewritten.error, undefined);
  for (const key of ["type", "id", "chapter", "number", "title"]) assert.equal(rewritten.frontmatter[key], original[key], key);
  assert.ok(context.ai.calls.some((call) => call.label === "autopilot:revise:1.1"), "the scene was rewritten");
});

test("a scene without any frontmatter is rewritten as it always was", async () => {
  const context = await bookWithScene();
  const plain = "The author's own scene, with no frontmatter at all. ".repeat(12);
  context.store.write(SCENE, plain);
  await context.session.intervene({ scope: "rewrite", text: "Make Orrin kinder." });
  const state = await resume(context);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.ok(context.ai.calls.some((call) => call.label === "autopilot:revise:1.1"));
  assert.notEqual(context.store.files.get(SCENE), plain);
});

test("closing a chapter refuses a chapter.md it cannot read, before it asks the model to consolidate", async () => {
  const chapter = "chapters/001-chapter-title-1/chapter.md";
  const damaged = "---\ntype: chapter\nid: chapter:001-chapter-title-1\nnumber: 1\ntitle: Chapter Title 1\nsummary: One: two\n---\n\n# Chapter Title 1\n";
  const ai = createFakeAutopilotAi({ reviewVerdict: () => "approve" });
  const { state, store } = await run({ ...seedBookFiles({ chapters: 2 }), [chapter]: damaged }, ai);
  assert.equal(state.status, "error");
  assert.ok(state.lastError.message.includes(chapter), state.lastError.message);
  assert.match(state.lastError.message, /line 6\b/);
  assert.equal(store.files.get(chapter), damaged);
  assert.equal(labels(ai).includes("autopilot:consolidate:1"), false, "no call was spent on a step that cannot be saved");
});

test("the concept refuses a story design whose frontmatter it cannot read instead of replacing it", async () => {
  const design = "---\ntype: note\ntitle: Story: Design\nscope: story-design\n---\n\n# Story Design\n\n## Premise\n";
  const ai = createFakeAutopilotAi();
  const { state, store } = await run({ ...seedBookFiles({ chapters: 2 }), "story-design.md": design }, ai);
  assert.equal(state.status, "error");
  assert.ok(state.lastError.message.includes("story-design.md"), state.lastError.message);
  assert.match(state.lastError.message, /line 3\b/);
  assert.equal(store.files.get("story-design.md"), design);
  assert.equal(labels(ai).includes("autopilot:concept"), false);
});

test("approving the plan refuses a secret whose frontmatter it cannot read instead of rewriting its reveal", async () => {
  const secret = "secrets/the-wall-is-failing.md";
  const damaged = "---\ntype: secret\nid: secret:the-wall-is-failing\ntitle: The Wall Is Failing\nnotes: kept: for later\n---\n\n# The Wall Is Failing\n\nThe sea wall cracked years ago.\n";
  const ai = createFakeAutopilotAi();
  const { state, store } = await run({ ...seedBookFiles({ chapters: 2 }), [secret]: damaged }, ai, { brief: { ...ONE.brief, targetChapters: 2 }, options: FAST });
  assert.equal(state.status, "error");
  assert.ok(state.lastError.message.includes(secret), state.lastError.message);
  assert.equal(store.files.get(secret), damaged);
  assert.equal(labels(ai).includes("autopilot:plan-review"), false);
});

test("a file that has nothing to be rewritten is not refused for the YAML it holds", async () => {
  const secret = "secrets/the-wall-is-failing.md";
  const untouched = "---\ntype: secret\nid: secret:the-wall-is-failing\ntitle: The Wall Is Failing\nreveal_in: chapter:002-chapter-title-2\nnotes: kept: for later\n---\n\n# The Wall Is Failing\n\nThe sea wall cracked years ago.\n";
  const ai = createFakeAutopilotAi({ reviewVerdict: () => "approve" });
  const { state, store } = await run({ ...seedBookFiles({ chapters: 2 }), [secret]: untouched }, ai, { brief: { ...ONE.brief, targetChapters: 2 }, options: FAST });
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.equal(store.files.get(secret), untouched, "its reveal was already there: nothing was written, so nothing was refused");
});
