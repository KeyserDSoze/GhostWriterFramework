import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";

// The ledger of a secret (who knows it and from when, what the reader knows, clues, red herrings, consequences), the deterministic checks of a design, and the
// `bible/` files: read softly, written in order, and the findings said in English and in Italian.

const {
  designChecks,
  designFindingText,
  emptySecretLedger,
  mergeSecretLedger,
  readBibleThemes,
  readBibleWorld,
  readSecretLedger,
  secretLedgerDigest,
  secretLedgerFrontmatter,
  serializeBibleThemes,
  serializeBibleWorld,
} = engine;

test("a ledger is read softly: chapters as numbers or references, items without a chapter or a note said and left out, the lists in order", () => {
  const { ledger, problems } = readSecretLedger({
    learned_by: [{ character: "character:elio", chapter: 7 }, { character: "Mara" }],
    reader_knows: [{ chapter: "chapter:005-the-boots", note: "The keeper lied." }, { chapter: 1, note: "Something happened." }],
    clues: [{ chapter: 3, note: "Wet boots" }, "not a clue"],
    red_herrings: "wrong",
    consequences: "Mara leaves the island.",
  });
  assert.deepEqual(ledger.learnedBy, [{ character: "character:elio", chapter: 7 }]);
  assert.deepEqual(ledger.readerKnows.map((item) => item.chapter), [1, 5], "in order, a reference read as its number");
  assert.deepEqual(ledger.clues, [{ chapter: 3, note: "Wet boots" }]);
  assert.deepEqual(ledger.redHerrings, []);
  assert.deepEqual(ledger.consequences, ["Mara leaves the island."]);
  assert.equal(problems.length, 3);
  assert.deepEqual(readSecretLedger({}), { ledger: emptySecretLedger(), problems: [] }, "a secret of an older book has an empty ledger");
});

test("a ledger is written as snake_case keys, empty lists left out, and its fingerprint follows only the keys of the ledger", async () => {
  const ledger = { ...emptySecretLedger(), clues: [{ chapter: 4, note: " Late " }, { chapter: 2, note: "Early" }], consequences: ["Exile"] };
  const keys = secretLedgerFrontmatter(ledger);
  assert.deepEqual(keys, { learned_by: undefined, reader_knows: undefined, clues: [{ chapter: 2, note: "Early" }, { chapter: 4, note: "Late" }], red_herrings: undefined, consequences: ["Exile"] });
  const one = await secretLedgerDigest({ title: "A", clues: keys.clues });
  assert.equal(await secretLedgerDigest({ title: "B", status: "hidden", clues: keys.clues }), one, "the other keys do not count");
  assert.notEqual(await secretLedgerDigest({ clues: [{ chapter: 2, note: "Early" }] }), one);
});

test("the ledger of a batch replaces what falls in its chapters and keeps the rest", () => {
  const base = { ...emptySecretLedger(), clues: [{ chapter: 2, note: "old 2" }, { chapter: 8, note: "old 8" }], consequences: ["old"] };
  const merged = mergeSecretLedger(base, { clues: [{ chapter: 3, note: "new 3" }, { chapter: 9, note: "outside" }] }, 1, 6);
  assert.deepEqual(merged.clues, [{ chapter: 3, note: "new 3" }, { chapter: 8, note: "old 8" }]);
  assert.deepEqual(merged.consequences, ["old"]);
});

const characters = [{ slug: "mira-vale", name: "Mira Vale", aliases: [] }, { slug: "orrin-hale", name: "Orrin Hale", aliases: ["The Harbor Master"] }];
const locations = [{ slug: "glass-harbor", name: "Glass Harbor", aliases: [] }];
const secret = (overrides = {}) => ({ slug: "the-wall", title: "The Wall Is Failing", holders: ["character:orrin-hale"], ledger: { ...emptySecretLedger(), clues: [{ chapter: 1, note: "Salt water" }] }, revealChapter: 3, ...overrides });

test("the deterministic checks of a design: a mystery without a resolution, a reveal out of the book or before it may be known, a clue after the reveal, a payoff without a setup", () => {
  const chapters = [1, 2, 3, 4].map((number) => ({ number, design: { goal: "g" } }));
  const findings = designChecks({
    chapters,
    secrets: [
      secret({ slug: "none", title: "Nowhere", revealChapter: undefined }),
      secret({ slug: "far", title: "Too far", revealChapter: 9 }),
      secret({ slug: "early", title: "Early", revealChapter: 2, knownFromChapter: 3 }),
      secret({ slug: "late-clue", title: "Late clue", revealChapter: 3, ledger: { ...emptySecretLedger(), clues: [{ chapter: 1, note: "fine" }, { chapter: 4, note: "too late" }] } }),
      secret({ slug: "bare", title: "Bare", revealChapter: 4, ledger: emptySecretLedger() }),
      secret({ slug: "beyond", title: "Beyond", ledger: { ...emptySecretLedger(), clues: [{ chapter: 1, note: "x" }], redHerrings: [{ chapter: 7, note: "y" }] } }),
    ],
    characters,
    locations,
  });
  const codes = findings.map((finding) => `${finding.code}:${finding.secret?.slug ?? finding.chapter}`);
  assert.deepEqual(codes, [
    "reveal-missing:none",
    "reveal-out-of-range:far",
    "reveal-before-known:early",
    "clue-after-reveal:late-clue",
    "secret-without-clue:bare",
    "chapter-out-of-range:beyond",
  ]);
  const texts = Object.fromEntries(findings.map((finding) => [finding.code + ":" + finding.secret.slug, designFindingText(finding, "en")]));
  assert.equal(texts["reveal-missing:none"], "The secret «Nowhere» has no chapter that reveals it: a mystery without a resolution.");
  assert.equal(texts["clue-after-reveal:late-clue"], "A clue of the secret «Late clue» is in chapter 4, when the reader already knows the truth (from chapter 3): it reveals nothing any more.");
  assert.equal(designFindingText(findings[4], "it"), "Il segreto «Bare» si rivela nel capitolo 4 senza alcun indizio prima: la rivelazione arriva senza preparazione.");
});

test("a point of view cannot reveal what that character learns later; a character or a place the canon does not have is said, generic names and longer descriptions of a known place are not", () => {
  const findings = designChecks({
    chapters: [
      { number: 2, design: { pov: ["Mira"], characters: ["Mira Vale", "the harbor master", "Everyone", "Tobias"], reveals: ["The Wall Is Failing"], setting: "The quays of Glass Harbor at dawn" } },
      { number: 3, design: { pov: ["Orrin Hale"], reveals: ["secret:the-wall"], setting: "A ship at sea" } },
      { number: 5, design: { pov: ["Mira Vale"], reveals: ["The Wall Is Failing"] } },
    ],
    secrets: [secret({ revealChapter: 2, ledger: { ...emptySecretLedger(), clues: [{ chapter: 1, note: "Salt" }], learnedBy: [{ character: "character:mira-vale", chapter: 4 }] } })],
    characters,
    locations,
  });
  const told = findings.map((finding) => [finding.code, finding.chapter, finding.name]);
  assert.deepEqual(told, [
    ["knowledge-before-learning", 2, "Mira Vale"],
    ["unknown-character", 2, "Tobias"],
    ["unknown-location", 3, "A ship at sea"],
  ], "Orrin knows it from the start; chapter 5 is after Mira learns it; a first name and an alias (whatever its case) are the character");
  assert.equal(designFindingText(findings[0], "en"), "In chapter 2 the point of view of Mira Vale reveals the secret «The Wall Is Failing», which Mira Vale only learns in chapter 4.");
});

test("the bible files: themes and tone, rules of the world, read softly and written with the keys they had", () => {
  const themes = serializeBibleThemes({ themes: ["truth", " inheritance "], tone: "Melancholic" });
  assert.match(themes, /^---\ntype: bible\nid: bible:themes\ntitle: Themes and tone\nthemes:\n  - truth\n  - inheritance\ntone: Melancholic\n---/);
  assert.deepEqual(readBibleThemes(themes), { themes: ["truth", "inheritance"], tone: "Melancholic", audience: "", notes: "" });
  const custom = serializeBibleThemes({ themes: ["grief"] }, "---\ntype: bible\nid: bible:themes\ntitle: Temi\nowner: me\n---\n\nMy notes.");
  assert.deepEqual(readBibleThemes(custom), { themes: ["grief"], tone: "", audience: "", notes: "My notes." });
  const audience = serializeBibleThemes({ themes: ["grief"], audience: "Adults who read slow mysteries" }, custom);
  assert.equal(readBibleThemes(audience).audience, "Adults who read slow mysteries");
  assert.equal(readBibleThemes(serializeBibleThemes({ themes: ["grief"] }, audience)).audience, "Adults who read slow mysteries", "a caller that does not say the audience keeps it");
  assert.match(custom, /owner: me/);
  assert.match(custom, /title: Temi/);
  const world = serializeBibleWorld({ rules: ["Glass remembers", ""] });
  assert.deepEqual(readBibleWorld(world).rules, ["Glass remembers"]);
  assert.deepEqual(readBibleWorld("---\nrules: |\n  - One\n  - Two\n---\n").rules, ["One", "Two"], "a block of lines is a list");
  assert.deepEqual(readBibleWorld(null), { rules: [], notes: "" });
});
