import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { doctorBook, validateBook } from "narrarium";
import { slugCode, slugifyAny } from "narrarium/slug";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { AutopilotSession, TASK_EXECUTORS, createAutopilotState, defaultDirector, importedChapters, loadBookSnapshot, parseAutopilotState, parseMarkdown, serializeAutopilotState, syncBookStores } = engine;

const STATE = "autopilot/state.json";
const ACTIVITY = "autopilot/activity.json";
const FAST = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };
const GOLDEN = new URL("./fixtures/latin-golden.json", import.meta.url);

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

function stateOf(store) {
  return parseAutopilotState(store.files.get(STATE));
}

async function runSession(store, ai, { brief, options = {}, hostLabel = "test", now } = {}) {
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel, retryDelayMs: 0, ...(now ? { now } : {}) });
  session.subscribe((event) => events.push(event));
  await session.start({ brief, options: { maxReaders: 2, pauseAfterPlan: false, ...options } });
  await session.waitForIdle();
  return { session, events, state: stateOf(store) };
}

// ─── Latin books stay byte-identical ────────────────────────────────────────────────────────────────────────────────────
// A whole run of an English and of an Italian book (accents, apostrophes, hyphens, ß, Æ, ¿) is digested: every file the
// run writes and every request it sends (system, user, schema, limit, temperature). The digests were taken from the
// engine as it was before it learned non-Latin scripts: `UPDATE_LATIN_GOLDEN=1 node --test test/nonlatin.test.mjs`
// writes them again, and only an intended change of the Latin prompts may do that. The files are digested without the freeze
// records of the chapters the autopilot approves (see `withoutFreezeRecords`).

const clock = () => new Date("2026-01-01T00:00:00.000Z");
const digest = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const BOOK_OPINION = "evaluations/director/book.md";

/**
 * The files without the freeze record the autopilot writes in the chapter.md of every chapter it approves (E4b), and with the one value
 * it changes elsewhere (the hash of the chapter files in the director's judgement of the book) computed without it: the rest must be what
 * it always was, byte for byte.
 */
function withoutFreezeRecords(files) {
  const full = (text) => createHash("sha256").update(text).digest("hex");
  const plain = { ...files };
  for (const [name, content] of Object.entries(files)) {
    if (/^chapters\/[^/]+\/chapter\.md$/.test(name)) plain[name] = content.replace(/^frozen:\n(?: {2,}.*\n)+/m, "");
  }
  if (plain[BOOK_OPINION]) {
    const chapters = Object.entries(plain).filter(([name]) => name.startsWith("chapters/")).map(([name, content]) => `${name}:${full(content)}`).sort().join("\n");
    plain[BOOK_OPINION] = plain[BOOK_OPINION].replace(/^(source_hash: "?)[0-9a-f]{64}/m, `$1${full(chapters)}`);
  }
  return plain;
}

const ITALIAN_BOOK = scripted((request) => {
  switch (request.json?.name) {
    case "book_concept":
      return reply({
        logline: "Un faro spento, una città di sale.",
        premise: "Niccolò scopre perché il faro è spento.",
        themes: ["verità"],
        tone: "Malinconico",
        conflict: "Niccolò contro il consiglio.",
        storyDesign: "# Progetto\n\n## Premessa\n\nNiccolò Pérez scopre perché il faro è spento.\n\n## Conflitto\n\nIl consiglio nasconde la verità.",
        context: "# Mondo\n\nUna città di sale sul mare del nord.",
        characters: [
          { name: "Niccolò Pérez", roleTier: "main", storyRole: "protagonist", description: "Un giovane salinaro.", desire: "La verità", fear: "Il silenzio", arc: "Dal silenzio alla voce", voice: "Frasi brevi" },
          { name: "Élodie Brûlé", roleTier: "supporting", storyRole: "ally", description: "Una cartografa.", desire: "Una mappa", fear: "Il mare", arc: "Resta", voice: "Pacata" },
          { name: "Jean-Luc D'Amico", roleTier: "supporting", storyRole: "antagonist", description: "Il custode.", desire: "Controllo", fear: "Esposizione", arc: "Cade", voice: "Liscia" },
          { name: "R2-D2", roleTier: "minor", storyRole: "other", description: "Un automa.", desire: "Servire", fear: "Ruggine", arc: "Nessuno", voice: "Bip" },
        ],
        locations: [{ name: "Città del Sale", description: "Saline bianche.", atmosphere: "Luce fredda" }, { name: "Faro di Sant'Elmo", description: "Un faro spento.", atmosphere: "Silenzio" }],
        factions: [{ name: "I Fratelli d'Elmo", description: "Confraternita dei custodi.", mission: "Custodire il faro" }],
        secrets: [{ title: "Perché il faro è spento", truth: "Il faro fu spento dal consiglio.", holders: ["Jean-Luc D'Amico", "Élodie Brûlé"], stakes: "La città", revealChapter: 2 }],
      });
    case "chapter_plan": {
      const range = /numbered (\d+) to (\d+)/.exec(request.user) ?? /chapters (\d+)-(\d+)/.exec(request.user);
      const from = range ? Number(range[1]) : 1;
      const to = range ? Number(range[2]) : 3;
      const titles = ["Il porto di sale", "Perché il mare tace", "L'ultima città", "Straße ¿Qué pasa?", "Ægir e Zoë"];
      return reply({ chapters: Array.from({ length: to - from + 1 }, (_, index) => ({ number: from + index, title: titles[(from + index - 1) % titles.length], summary: `Riassunto del capitolo ${from + index}.`, goal: "Scopo.", pov: ["Niccolò Pérez"], keyEvents: ["Evento"], reveals: from + index === 2 ? ["Perché il faro è spento"] : [] })) });
    }
    case "scene_plan":
      return reply({ scenes: ["Là dove finisce la strada", "Un'ombra sul molo"].map((title, index) => ({ title, goal: `Obiettivo ${index + 1}.`, beats: ["Arrivo", "Conflitto", "Svolta"], pov: "Niccolò Pérez", location: "Città del Sale", characters: ["Niccolò Pérez", "Élodie Brûlé"], summary: `Esito ${index + 1}.` })) });
    default:
      return undefined;
  }
});

async function latinRun({ files, ai, brief }) {
  const store = new MemoryBookStore(files);
  const { state } = await runSession(store, ai, { brief, now: clock });
  const written = Object.entries(withoutFreezeRecords(store.toObject())).filter(([name]) => name !== STATE && name !== ACTIVITY);
  return {
    status: state.status,
    error: state.lastError?.message ?? null,
    files: Object.fromEntries(written.map(([name, content]) => [name, digest(content)])),
    requests: ai.calls.map((call, index) => `${String(index).padStart(3, "0")} ${call.label} ${digest(JSON.stringify({ system: call.system, user: call.user, json: call.json?.name, maxOutputTokens: call.maxOutputTokens, temperature: call.temperature }))}`),
  };
}

/** Entries the autopilot wrote and nobody touched since: they bind nothing, so the book is asked what it always was. */
async function intactEntries(count) {
  const files = {};
  const numbers = typeof count === "number" ? Array.from({ length: count }, (_, index) => index + 1) : count;
  for (const number of numbers) {
    const title = `Chapter Title ${number}`;
    const body = `Event ${number} happens and the story turns.`;
    files[engine.outlineChapterPath(number)] = `---\ntype: outline-chapter\nnumber: ${number}\ntitle: ${title}\norigin: autopilot\ndigest: ${await engine.outlineEntryDigest({ title, body })}\n---\n\n${body}\n`;
  }
  return files;
}

test("a whole run of an English and of an Italian book writes the same files and sends the same requests as it always did", async () => {
  const english = await latinRun({ files: { ...seedBookFiles(), ...(await intactEntries(2)) }, ai: createFakeAutopilotAi(), brief: { idea: "A harbor built on glass hides a lie.", targetChapters: 2, scenesPerChapter: 2, wordsPerScene: 300 } });
  const italian = await latinRun({ files: { ...seedBookFiles({ title: "Il faro di sale", language: "it" }), ...(await intactEntries(5)) }, ai: ITALIAN_BOOK, brief: { idea: "Un faro spento.", targetChapters: 5, scenesPerChapter: 2, wordsPerScene: 300 } });
  assert.equal(english.status, "completed", english.error);
  assert.equal(italian.status, "completed", italian.error);
  const runs = { english, italian };
  if (process.env.UPDATE_LATIN_GOLDEN) {
    await mkdir(new URL("./", GOLDEN), { recursive: true });
    await writeFile(GOLDEN, `${JSON.stringify(runs, null, 1)}\n`);
    return;
  }
  const golden = JSON.parse(await readFile(GOLDEN, "utf8"));
  for (const name of Object.keys(golden)) {
    assert.deepEqual(Object.keys(runs[name].files), Object.keys(golden[name].files), `${name}: the files of the book`);
    assert.deepEqual(runs[name].files, golden[name].files, `${name}: the content of a file changed`);
    assert.deepEqual(runs[name].requests, golden[name].requests, `${name}: a request to the model changed`);
    assert.deepEqual(runs[name], golden[name]);
  }
});

test("the slugs of Latin titles and names are what they always were, accents, apostrophes, ß, Æ and ¿ included", () => {
  const titles = [
    ["The Arrival", "001-the-arrival"], ["The Clockmaker's Daughter", "001-the-clockmaker-s-daughter"], ["Il porto di sale", "001-il-porto-di-sale"],
    ["Città di sale", "001-citta-di-sale"], ["Perché il mare tace", "001-perche-il-mare-tace"], ["L'ultima città", "001-l-ultima-citta"],
    ["Straße ¿Qué pasa?", "001-stra-e-que-pasa"], ["Ægir e Zoë", "001-gir-e-zoe"], ["  Spaces   everywhere  ", "001-spaces-everywhere"], ["Chapter 1: The End", "001-chapter-1-the-end"],
    ["Глава 1", "001-1"], ["Café Ünïcode", "001-cafe-unicode"],
  ];
  for (const [title, slug] of titles) {
    assert.equal(engine.chapterSlug(1, title), slug, title);
    assert.equal(engine.paragraphSlug(1, title), slug, title);
  }
  assert.equal(engine.chapterSlug(1000, "The End"), "1000-the-end");
  for (const [name, slug] of [["Mira Vale", "mira-vale"], ["Élodie Brûlé", "elodie-brule"], ["Jean-Luc D'Amico", "jean-luc-d-amico"], ["R2-D2", "r2-d2"], ["Faro di Sant'Elmo", "faro-di-sant-elmo"], ["O'Brien", "o-brien"]]) {
    assert.equal(slugifyAny(name, "character", true), slug, name);
    assert.equal(engine.slugify(name), slug, name);
  }
});

test("the limit of a scene's reply for an English, an Italian or a French book is still the number of words times 2.4, plus 800, up to 16 000", async () => {
  for (const language of ["en", "it", "fr"]) {
    for (const words of [200, 1400, 4000, 8000]) {
      const store = new MemoryBookStore(seedBookFiles({ chapters: 1, language }));
      const ai = createFakeAutopilotAi({ scenes: 1, words: 250 });
      const { state } = await runSession(store, ai, { brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: words }, options: { ...FAST, specialists: true } });
      assert.equal(state.status, "completed", state.lastError?.message);
      const write = ai.calls.find((call) => call.label === "autopilot:write:1.1");
      assert.equal(write.maxOutputTokens, Math.min(16000, Math.ceil(words * 2.4) + 800), `${language} ${words}`);
      const repair = ai.calls.find((call) => call.label === "autopilot:repair:1.1");
      assert.equal(repair.maxOutputTokens, Math.min(16000, Math.ceil(Math.max(250, 300) * 2.4) + 800), `${language} repair`);
      assert.deepEqual(fixedLimits(ai), LATIN_LIMITS, `${language}: the fixed limits do not change`);
    }
  }
});

/** The limits of the steps that are not prose, as the engine has always sent them to a Latin book. */
const LATIN_LIMITS = {
  "autopilot:concept": 9000, "autopilot:plan": 9000, "autopilot:plan-review": 4000, "autopilot:scenes": 5000, "autopilot:scene-summary": 400,
  "autopilot:specialists": 5000, "autopilot:director-review": 6000, "autopilot:consolidate": 5000, "director:book": 4000,
};

const fixedLimits = (ai) => Object.fromEntries(ai.calls.filter((call) => call.json).map((call) => [call.label.replace(/:\d+(\.\d+)?$/, ""), call.maxOutputTokens]));

// ─── N1: canon created by the concept step ──────────────────────────────────────────────────────────────────────────────

function conceptReply(extra = {}) {
  return { logline: "L", premise: "P", themes: [], tone: "T", conflict: "C", storyDesign: "# Story Design\n\nA design.", context: "# World\n\nA world.", characters: [], locations: [], factions: [], secrets: [], ...extra };
}

/** Runs the concept step alone over `files`, applies its changes, and returns what it did. */
async function concept(files, output, { language = "en", store = new MemoryBookStore({ ...seedBookFiles({ chapters: 2, language }), ...files }) } = {}) {
  const ai = scripted((request) => (request.json?.name === "book_concept" ? reply(output) : undefined));
  const insights = [];
  const context = {
    bookId: "book",
    store,
    snapshot: await loadBookSnapshot(store),
    state: createAutopilotState(new Date(0), { idea: "x", targetChapters: 2 }),
    director: defaultDirector(language),
    readerPanel: [],
    language,
    task: { kind: "concept", phase: "concept", title: "Concept", reason: "", next: "", acceptsNotes: true },
    notes: [],
    now: () => new Date(0),
    signal: new AbortController().signal,
    ai: (request) => ai.complete({ ...request, signal: undefined }),
    insight: (tone, title, detail) => insights.push({ tone, title, detail }),
  };
  const result = await TASK_EXECUTORS.concept(context);
  const created = result.changes.map((change) => change.path).filter((name) => /^(characters|locations|factions|secrets)\//.test(name));
  await store.commit(result.changes, "concept");
  return { store, result, insights, state: context.state, created };
}

function canonFiles(store, directory) {
  return [...store.files.keys()].filter((name) => name.startsWith(`${directory}/`)).map((name) => {
    const document = parseMarkdown(store.files.get(name));
    return { path: name, slug: name.slice(directory.length + 1, -3), name: document.frontmatter.name ?? document.frontmatter.title, id: document.frontmatter.id, frontmatter: document.frontmatter };
  }).sort((left, right) => (left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0));
}

const person = (name) => ({ name, roleTier: "supporting", storyRole: "other", description: `About ${name}.`, desire: "d", fear: "f", arc: "a", voice: "v" });
const place = (name) => ({ name, description: `About ${name}.`, atmosphere: "a" });

test("characters, places, factions and secrets with Russian names are created, with readable Latin file names", async () => {
  const { store, created, state } = await concept({}, conceptReply({
    characters: [person("Анна Волкова"), person("Борис Игнатьев"), person("Ёлка")],
    locations: [place("Тихая гавань"), place("Маяк на мысе")],
    factions: [{ name: "Артель рыбаков", description: "d", mission: "m" }],
    secrets: [{ title: "Почему погас маяк", truth: "Его погасили.", holders: ["Борис Игнатьев", "Анна Волкова"], stakes: "s", revealChapter: 2 }],
  }), { language: "ru" });
  // The file names are the core's: a word with a letter that carries a mark (Ё, Й, Ї) is read by the core's table, so it is derived, not typed.
  const elka = slugifyAny("Ёлка", "character", true);
  assert.match(elka, /^[a-z]+$/, "a Latin slug, whatever the table says of Ё");
  assert.deepEqual(created.sort(), ["characters/anna-volkova.md", "characters/boris-ignatev.md", `characters/${elka}.md`, "factions/artel-rybakov.md", "locations/mayak-na-myse.md", "locations/tikhaya-gavan.md", "secrets/pochemu-pogas-mayak.md"].sort());
  assert.deepEqual(canonFiles(store, "characters").map((entry) => [entry.name, entry.id]), [["Анна Волкова", "character:anna-volkova"], ["Борис Игнатьев", "character:boris-ignatev"], ["Ёлка", `character:${elka}`]].sort((left, right) => (left[1] < right[1] ? -1 : 1)));
  assert.equal(canonFiles(store, "secrets")[0].name, "Почему погас маяк");
  assert.deepEqual(canonFiles(store, "secrets")[0].frontmatter.holders, ["character:boris-ignatev", "character:anna-volkova"], "the holders point at the files that exist");
  assert.deepEqual(state.concept.secrets, [{ slug: "pochemu-pogas-mayak", title: "Почему погас маяк", revealChapter: 2 }]);
});

test("Greek names are read letter by letter, and the accents are left out", async () => {
  const { store } = await concept({}, conceptReply({ characters: [person("Ελένη Παπαδοπούλου"), person("Οδυσσέας"), person("Μπαμπάς Ούρανος")], locations: [place("Το μικρό λιμάνι")] }), { language: "el" });
  assert.deepEqual(canonFiles(store, "characters").map((entry) => entry.slug), ["eleni-papadopoulou", "mpampas-ouranos", "odysseas"]);
  assert.deepEqual(canonFiles(store, "locations").map((entry) => entry.slug), ["to-mikro-limani"]);
});

test("names in the scripts that cannot be read letter by letter get the kind of entry and a short code of the name, always the same", async () => {
  const names = { zh: ["李明", "王芳"], ja: ["田中太郎", "ミナ"], ar: ["ليلى الحسن", "يوسف"], he: ["דני כהן"], hi: ["अनिल कुमार"], th: ["สมชาย"], ko: ["김민수"] };
  const all = Object.values(names).flat();
  const first = await concept({}, conceptReply({ characters: all.map(person), locations: [place("宁静的海港"), place("静かな港")], factions: [{ name: "渔民公会", description: "d", mission: "m" }], secrets: [{ title: "灯塔为何熄灭", truth: "t", holders: ["李明"], stakes: "s", revealChapter: 1 }] }), { language: "zh" });
  const characters = canonFiles(first.store, "characters");
  assert.equal(characters.length, all.length, "no name is left out");
  assert.deepEqual(characters.map((entry) => entry.name).sort(), [...all].sort());
  for (const entry of characters) {
    assert.equal(entry.slug, slugifyAny(entry.name, "character", true), entry.name);
    assert.match(entry.slug, /^character-[0-9a-z]{6,7}$/, entry.name);
    assert.equal(entry.id, `character:${entry.slug}`);
  }
  assert.equal(characters.find((entry) => entry.name === "李明").slug, "character-0crj2m", "the code is the one the core fixed for this name");
  assert.deepEqual(canonFiles(first.store, "locations").map((entry) => entry.slug).sort(), [`location-${slugCode("宁静的海港")}`, `location-${slugCode("静かな港")}`].sort());
  assert.deepEqual(canonFiles(first.store, "factions").map((entry) => entry.slug), [`faction-${slugCode("渔民公会")}`]);
  assert.deepEqual(canonFiles(first.store, "secrets").map((entry) => [entry.slug, entry.frontmatter.holders]), [[`secret-${slugCode("灯塔为何熄灭")}`, ["character:character-0crj2m"]]]);
  assert.equal(first.state.concept.secrets[0].slug, `secret-${slugCode("灯塔为何熄灭")}`);
  assert.match(first.result.summary, /10 characters, 4 other canon entries, 1 secrets\.$/, "ten characters, then two places, a faction and a secret");

  const second = await concept({}, conceptReply({ characters: all.map(person) }), { language: "zh" });
  assert.deepEqual(canonFiles(second.store, "characters").map((entry) => entry.path), characters.map((entry) => entry.path), "another run, the same files");
});

test("a book that mixes scripts keeps every name: Latin ones as ever, Cyrillic and Greek read, the others coded", async () => {
  const { store } = await concept({}, conceptReply({ characters: [person("Mira Vale"), person("Мария"), person("Οδυσσέας"), person("李明"), person("★ The Keeper ★"), person("!!!"), person("🌊")] }));
  assert.deepEqual(canonFiles(store, "characters").map((entry) => entry.slug).sort(), ["character-1inv8mp", "character-0crj2m", "character-gntihm", "mira-vale", "mariya", "odysseas", "the-keeper"].sort());
});

test("two different names that make the same file name both get a file: the second gets -2, the third -3, and the book is told", async () => {
  const { store, insights, created, state } = await concept({}, conceptReply({
    characters: [person("Igor"), person("Игорь"), person("Игор"), person("O'Brien"), person("O Brien")],
    locations: [place("Café"), place("Cafe!")],
    secrets: [{ title: "The Lie", truth: "t", holders: ["Игорь", "Igor", "O Brien", "Игор"], stakes: "s", revealChapter: 1 }],
  }));
  assert.deepEqual(canonFiles(store, "characters").map((entry) => [entry.slug, entry.name]), [["igor", "Igor"], ["igor-2", "Игорь"], ["igor-3", "Игор"], ["o-brien", "O'Brien"], ["o-brien-2", "O Brien"]]);
  assert.deepEqual(canonFiles(store, "characters").map((entry) => entry.id), ["character:igor", "character:igor-2", "character:igor-3", "character:o-brien", "character:o-brien-2"], "every file has an identity of its own");
  assert.deepEqual(canonFiles(store, "locations").map((entry) => [entry.slug, entry.name]), [["cafe", "Café"], ["cafe-2", "Cafe!"]]);
  assert.equal(created.length, 5 + 2 + 1, "nothing is skipped");
  assert.deepEqual(canonFiles(store, "secrets")[0].frontmatter.holders, ["character:igor-2", "character:igor", "character:o-brien-2", "character:igor-3"], "a secret points at the right one of them");
  const told = insights.filter((entry) => /igor-2|igor-3|o-brien-2|cafe-2/.test(`${entry.title} ${entry.detail}`));
  assert.equal(told.length, 4, JSON.stringify(insights));
  assert.equal(insights.filter((entry) => entry.tone !== "ok").length, 4, "only the names that were told apart are reported");
  assert.ok(told.every((entry) => entry.tone === "info" || entry.tone === "warning"));
  assert.ok(told.some((entry) => /Игорь/.test(entry.title)), "the insight names the entry that was renamed");
  assert.deepEqual(state.concept.secrets, [{ slug: "the-lie", title: "The Lie", revealChapter: 1 }]);
});

test("a file name already used by the book is never taken: the new entry gets another one, and the old file is untouched", async () => {
  const old = "---\ntype: character\nid: character:mara\nname: Maria\naliases:\n  - Mary\n---\n\n# Maria\n\nThe author's own character.\n";
  const { store, insights } = await concept({ "characters/mara.md": old, "locations/cafe.md": "---\ntype: location\nid: location:cafe\nname: Caffè Centrale\n---\n\n# Caffè Centrale\n" }, conceptReply({
    characters: [person("Mara"), person("Mary"), person("Maria")],
    locations: [place("Café")],
  }));
  assert.equal(store.files.get("characters/mara.md"), old, "the author's file is not rewritten");
  assert.deepEqual(canonFiles(store, "characters").map((entry) => [entry.slug, entry.name]), [["mara", "Maria"], ["mara-2", "Mara"]], "Mary is the alias of Maria and Maria is Maria: neither is created again");
  assert.deepEqual(canonFiles(store, "locations").map((entry) => [entry.slug, entry.name]), [["cafe", "Caffè Centrale"], ["cafe-2", "Café"]]);
  assert.equal(insights.filter((entry) => /mara-2|cafe-2/.test(`${entry.title} ${entry.detail}`)).length, 2);
});

test("a name that the book already has, or has as an alias, is reused whatever its script: the autopilot never makes a second one", async () => {
  const files = {
    "characters/anna-volkova.md": "---\ntype: character\nid: character:anna-volkova\nname: Анна Волкова\naliases:\n  - Аня\n---\n\n# Анна Волкова\n",
    "characters/li-ming-file.md": "---\ntype: character\nid: character:li-ming-file\nname: 李明\naliases:\n  - 小明\n---\n\n# 李明\n",
  };
  const { store, created } = await concept(files, conceptReply({ characters: [person("Анна"), person("Аня"), person("李明"), person("小明"), person("Борис")], secrets: [{ title: "Тайна", truth: "t", holders: ["Аня", "小明"], stakes: "s", revealChapter: 1 }] }), { language: "ru" });
  assert.deepEqual(created.sort(), ["characters/boris.md", `secrets/${slugifyAny("Тайна", "secret", true)}.md`], "only the name that is new is made; the secret's file name is the core's, as «Тайна» has a Й");
  assert.deepEqual(canonFiles(store, "secrets")[0].frontmatter.holders, ["character:anna-volkova", "character:li-ming-file"]);
});

test("a name with no letters at all still becomes a file, and nothing in the concept is lost", async () => {
  const { store, created } = await concept({}, conceptReply({ characters: [person("???"), person("…"), person("1984")], locations: [place("★")], secrets: [{ title: "•", truth: "t", holders: [], stakes: "s", revealChapter: 0 }] }));
  assert.equal(created.length, 5);
  assert.deepEqual(canonFiles(store, "characters").map((entry) => entry.slug).sort(), ["1984", `character-${slugCode("???")}`, `character-${slugCode("…")}`].sort());
  assert.ok(canonFiles(store, "secrets")[0].slug.startsWith("secret-"));
});

// ─── N1: chapters and scenes ────────────────────────────────────────────────────────────────────────────────────────────

test("a chapter of the plan whose title is in another script gets a folder name that is never empty, and the planner fills a missing one the same way", () => {
  const empty = { number: 1, title: "海辺の朝", slug: "", summary: "", goal: "", pov: [], keyEvents: [], reveals: [], status: "planned", scenes: [] };
  const state = { ...createAutopilotState(new Date(0), { idea: "x", targetChapters: 3 }, FAST), concept: { done: true, generated: false, secrets: [] }, plan: { chapters: [empty, { ...empty, number: 2, title: "Тихая гавань" }, { ...empty, number: 3, title: "★★★" }], approved: false, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: false, awaitingAuthor: false } };
  const snapshot = { files: new Map(), book: { title: "B", language: "ja", description: "" }, chapters: [], canon: [], personaPaths: [], ghostwriterSlugs: [], hasDirector: false };
  const next = engine.advanceState(state, { snapshot, director: defaultDirector("ja"), readers: [], language: "ja", storyDesignThin: false });
  assert.deepEqual(next.plan.chapters.map((chapter) => chapter.slug), ["001-chapter", "002-tikhaya-gavan", "003-chapter"]);
  assert.equal(engine.paragraphSlug(1, "桟橋にて"), "001-scene", "a scene gets a name too, never `001-`");
  assert.equal(engine.paragraphSlug(2, "Σκηνή"), "002-skini");
  for (const title of ["海辺", "الميناء", "★", "🌊", "   ", "——"]) assert.match(engine.paragraphSlug(1, title), /^001-[a-z][a-z0-9-]*$/, title);
});

// ─── N1: the files of simulated readers ─────────────────────────────────────────────────────────────────────────────────

test("a reader persona named in any script gets a file name that is always the same, and a Latin name keeps the one it had", () => {
  const persona = (profile) => engine.readerPersonaPath({ ...engine.emptyReaderPersona("en"), ...profile });
  assert.equal(persona({ slug: "", name: "The Critic" }), "personas/the-critic.md");
  assert.equal(persona({ slug: "", name: "Lettore Perché" }), "personas/lettore-perche.md");
  assert.equal(persona({ slug: "mine", name: "The Critic" }), "personas/mine.md", "an explicit slug always wins");
  assert.equal(persona({ slug: "", name: "Читатель" }), "personas/chitatel.md");
  assert.equal(persona({ slug: "", name: "Έλενα" }), "personas/elena.md");
  assert.equal(persona({ slug: "", name: "读者" }), `personas/reader-${slugCode("读者")}.md`);
  assert.equal(persona({ slug: "", name: "読者" }), persona({ slug: "", name: "読者" }), "the same name, the same file");
  assert.notEqual(persona({ slug: "", name: "读者" }), persona({ slug: "", name: "作者" }), "another name, another file");
  assert.match(persona({ slug: "", name: "★★★" }), /^personas\/reader-[0-9a-z]{6,7}\.md$/);
  assert.match(persona({ slug: "", name: "   " }), /^personas\/reader-[0-9a-f]{8}\.md$/, "a blank name has nothing to be named after: it keeps the random file name");
});

// ─── N1: folders and files made by the author ───────────────────────────────────────────────────────────────────────────

const chapterFile = (number, slug, title, summary) => `---\ntype: chapter\nid: chapter:${slug}\nnumber: ${number}\ntitle: ${title}\nsummary: ${summary}\n---\n\n# ${title}\n`;
const sceneFile = (chapter, slug, number, title, body) => `---\ntype: paragraph\nid: paragraph:${chapter}:${slug}\nchapter: chapter:${chapter}\nnumber: ${number}\ntitle: ${title}\nsummary: ${title}.\n---\n\n${body}`;

function authorBook() {
  return {
    ...seedBookFiles({ chapters: 1, language: "ru" }),
    "chapters/001-глава-первая/chapter.md": chapterFile(1, "001-глава-первая", "Глава первая", "Анна возвращается домой."),
    "chapters/001-глава-первая/001-утро.md": sceneFile("001-глава-первая", "001-утро", 1, "Утро", "Анна проснулась рано."),
    "chapters/001-глава-первая/002-день.md": sceneFile("001-глава-первая", "002-день", 2, "День", "Днём на причале было тихо."),
    "chapters/002-海辺の朝/chapter.md": chapterFile(2, "002-海辺の朝", "海辺の朝", "海辺で朝を迎える。"),
    "chapters/002-海辺の朝/001-波.md": sceneFile("002-海辺の朝", "001-波", 1, "波", "波の音が聞こえた。"),
    "characters/李明.md": "---\ntype: character\nid: character:李明\nname: 李明\n---\n\n# 李明\n\nA fisherman.\n",
    "locations/Тихая гавань.md": "---\ntype: location\nid: location:Тихая гавань\nname: Тихая гавань\n---\n\n# Тихая гавань\n",
  };
}

test("the paths of folders and files named by the author in any script are read: chapters, scenes and canon", async () => {
  const { parseChapterFilePath, parseParagraphFilePath, chapterNumberFromSlug } = engine;
  assert.deepEqual(parseChapterFilePath("chapters/001-глава-первая/chapter.md"), { chapter: "001-глава-первая" });
  assert.deepEqual(parseChapterFilePath("chapters/002-海辺の朝/chapter.md"), { chapter: "002-海辺の朝" });
  assert.deepEqual(parseParagraphFilePath("chapters/002-海辺の朝/001-波.md"), { chapter: "002-海辺の朝", paragraph: "001-波", number: 1 });
  assert.deepEqual(parseParagraphFilePath("chapters/1200-глава/012-сцена-ночью.md"), { chapter: "1200-глава", paragraph: "012-сцена-ночью", number: 12 });
  assert.deepEqual(parseParagraphFilePath("chapters/003-x/004.md"), { chapter: "003-x", paragraph: "004", number: 4 });
  assert.equal(chapterNumberFromSlug("002-海辺の朝"), 2);
  assert.equal(chapterNumberFromSlug("1200-глава"), 1200);
  assert.equal(parseParagraphFilePath("chapters/001-a/chapter.md")?.paragraph, undefined, "the chapter file is not a scene");

  const store = new MemoryBookStore(authorBook());
  const snapshot = await loadBookSnapshot(store);
  assert.deepEqual(snapshot.chapters.map((chapter) => [chapter.slug, chapter.number, chapter.title, chapter.paragraphs.map((paragraph) => [paragraph.slug, paragraph.number, paragraph.title])]), [
    ["001-глава-первая", 1, "Глава первая", [["001-утро", 1, "Утро"], ["002-день", 2, "День"]]],
    ["002-海辺の朝", 2, "海辺の朝", [["001-波", 1, "波"]]],
  ]);
  assert.deepEqual(snapshot.canon.map((entry) => [entry.kind, entry.slug, entry.name]).sort(), [["character", "李明", "李明"], ["location", "Тихая гавань", "Тихая гавань"]]);
  assert.deepEqual(importedChapters(snapshot).map((chapter) => [chapter.number, chapter.slug, chapter.scenes.length]), [[1, "001-глава-первая", 2], [2, "002-海辺の朝", 1]]);
  for (const name of store.files.keys()) assert.equal(engine.isSafeBookPath(name), true, name);
});

test("a book with chapters and canon named in Cyrillic and Japanese is continued, and what the author wrote is left alone", async () => {
  const store = new MemoryBookStore({ ...authorBook(), ...(await intactEntries([1, 2, 3])) });
  const before = Object.fromEntries([...store.files].filter(([name]) => /^(chapters|characters|locations)\//.test(name)));
  const ai = scripted((request) => (request.json ? undefined : reply({}, { text: "Утро над гаванью началось медленно, как дыхание старого рыбака. Анна вышла на причал и долго смотрела на тёмную воду, а ветер приносил запах соли, дыма и далёкого дождя. ".repeat(6) })));
  const { state, events } = await runSession(store, ai, { brief: { idea: "x", targetChapters: 3, scenesPerChapter: 1, wordsPerScene: 200 }, options: FAST });
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(state.plan.chapters.map((chapter) => [chapter.number, chapter.slug, Boolean(chapter.imported)]), [[1, "001-глава-первая", true], [2, "002-海辺の朝", true], [3, "003-chapter-title-3", false]]);
  for (const [name, content] of Object.entries(before)) assert.equal(store.files.get(name), content, name);
  assert.ok(store.files.has("chapters/003-chapter-title-3/001-scene-1-title.md"));
  assert.match(store.files.get("resumes/total.md"), /## Chapter 001 Глава первая/);
  assert.match(store.files.get("resumes/total.md"), /## Chapter 002 海辺の朝/);
  assert.equal(events.filter((event) => event.type === "insight" && event.tone === "critical").length, 0);
  const sync = await syncBookStores({ local: store, remote: new MemoryBookStore(), base: new Map() });
  assert.deepEqual(sync.rejected, [], "every path, the author's included, can travel to the other side");
});

test("a book started by an older engine, whose chapter folder is `001-` and whose scene is `001-.md`, is read and finished instead of stopping at a chapter with no scenes", async () => {
  assert.deepEqual(engine.parseParagraphFilePath("chapters/001-/001-.md"), { chapter: "001-", paragraph: "001-", number: 1 });
  assert.deepEqual(engine.parseChapterFilePath("chapters/001-/chapter.md"), { chapter: "001-" });
  assert.equal(engine.chapterNumberFromSlug("001-"), 1);
  const state = createAutopilotState(new Date(0), { idea: "x", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 200 }, FAST);
  state.concept = { done: true, generated: false, secrets: [] };
  state.plan = {
    chapters: [{ number: 1, title: "海辺の朝", slug: "001-", summary: "", goal: "", pov: [], keyEvents: [], reveals: [], status: "review", scenes: [{ number: 1, title: "波", goal: "g", beats: [], characters: [], status: "written", slug: "001-", path: "chapters/001-/001-.md", words: 80, revisions: 0 }] }],
    approved: true, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false,
  };
  const prose = "波の音が聞こえた。".repeat(30);
  const store = new MemoryBookStore({
    ...seedBookFiles({ chapters: 1, language: "ja" }),
    [STATE]: serializeAutopilotState(state),
    "chapters/001-/chapter.md": chapterFile(1, "001-", "海辺の朝", "海辺の朝。"),
    "chapters/001-/001-.md": sceneFile("001-", "001-", 1, "波", prose),
  });
  const snapshot = await loadBookSnapshot(store);
  assert.deepEqual(snapshot.chapters.map((chapter) => [chapter.slug, chapter.paragraphs.map((paragraph) => paragraph.slug)]), [["001-", ["001-"]]], "the scene can be seen");
  const ai = createFakeAutopilotAi({ reviewVerdict: () => "approve" });
  const { state: done } = await runSession(store, ai, { options: FAST });
  assert.equal(done.status, "completed", done.lastError?.message);
  assert.equal(done.plan.chapters[0].status, "done");
  assert.equal(store.files.get("chapters/001-/001-.md").includes(prose), true, "the scene is still where it was");
});

// ─── B25: a ghostwriter that is not a file name ─────────────────────────────────────────────────────────────────────────

/** A store that refuses unsafe paths when read, as the personal server's does. */
class SafeStore extends MemoryBookStore {
  async read(name) {
    engine.assertSafeBookPath(name);
    return super.read(name);
  }

  async readMany(names) {
    for (const name of names) engine.assertSafeBookPath(name);
    return super.readMany(names);
  }
}

const ONE_CHAPTER = { idea: "x", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 };

test("the slugs of ghostwriters: the ones the core makes are accepted, a path or a strange character is not", () => {
  assert.equal(typeof engine.isValidGhostwriterSlug, "function");
  const accepted = ["default", "ghostwriter-0crj2m", slugifyAny("李明", "ghostwriter", true), slugifyAny("Лев Толстой", "ghostwriter", true), slugifyAny("Έλενα", "ghostwriter", true), "tolstoy", "Tolstoy", "tolstoy_style", "a.b", "толстой", "李明", "my voice", "ghostwriter-1inv8mp", "x".repeat(200)];
  for (const slug of accepted) assert.equal(engine.isValidGhostwriterSlug(slug), true, slug);
  const refused = ["", "../x", "..", ".", "...", "a/b", "/etc/passwd", "a\\b", "..\\x", "x:y", "x?y", "x*y", "x|y", "x\"y", "x<y", "x>y", "a\u0000b", "a\nb", " x", "x ", "con", "AUX", "x".repeat(300), "C:\\x"];
  for (const slug of refused) assert.equal(engine.isValidGhostwriterSlug(slug), false, JSON.stringify(slug));
});

test("a ghostwriter that is not valid is ignored with a warning and the default one writes: the run is not stopped", async () => {
  for (const bad of ["../x", "a/b", "x:y", "C:\\x"]) {
    const files = seedBookFiles({ chapters: 1 });
    files["book.md"] = files["book.md"].replace("ghostwriter: default", `ghostwriter: "${bad.replace(/\\/g, "\\\\")}"`);
    const store = new SafeStore(files);
    const ai = createFakeAutopilotAi();
    const { state, events } = await runSession(store, ai, { brief: ONE_CHAPTER, options: FAST });
    assert.equal(state.status, "completed", `${bad}: ${state.lastError?.message}`);
    const warnings = events.filter((event) => event.type === "insight" && event.tone === "warning" && /ghostwriter/i.test(event.title));
    assert.ok(warnings.length >= 1, `${bad}: the author is told`);
    assert.ok(warnings.some((event) => event.title.includes(bad)), `${bad}: and told which one`);
    const write = ai.calls.find((call) => call.label === "autopilot:write:1.1");
    assert.match(write.user, /Ghostwriter persona: Default Ghostwriter\./, `${bad}: the default profile is the one that writes`);
  }
});

test("a ghostwriter set on a chapter or on a scene that is not valid is skipped for the next one, and valid ones are used", async () => {
  const profile = (name) => `---\ntype: ghostwriter\nid: ghostwriter:x\nname: ${name}\n---\n\nStyle of ${name}.\n`;
  const files = { ...seedBookFiles({ chapters: 1 }), "ghostwriters/lev-tolstoy.md": profile("Лев Толстой"), [`ghostwriters/ghostwriter-${slugCode("李明")}.md`]: profile("李明") };
  const store = new SafeStore(files);
  const snapshot = await loadBookSnapshot(store);
  const chapter = (ghostwriter) => ({ slug: "001-x", number: 1, title: "X", pov: [], path: "chapters/001-x/chapter.md", paragraphs: [], ghostwriter });
  const scene = (ghostwriter) => ({ chapter: "001-x", slug: "001-s", number: 1, title: "S", path: "chapters/001-x/001-s.md", hash: "h", ghostwriter });
  const ignored = [];
  const load = (info, paragraph) => engine.loadGhostwriter(store, snapshot, info, paragraph, { onInvalid: (slug) => ignored.push(slug) });
  assert.equal((await load(chapter("lev-tolstoy")))?.name, "Лев Толстой");
  assert.equal((await load(chapter("lev-tolstoy"), scene(`ghostwriter-${slugCode("李明")}`)))?.name, "李明", "the scene's own ghostwriter is first");
  assert.deepEqual(ignored, []);
  assert.equal((await load(chapter("lev-tolstoy"), scene("../../x")))?.name, "Лев Толстой", "a bad scene ghostwriter falls to the chapter's");
  assert.equal((await load(chapter("..\\x"), scene("a/b")))?.name, "Default Ghostwriter", "and a bad chapter one to the book's, which is the default");
  assert.deepEqual(ignored, ["../../x", "a/b", "..\\x"]);
  assert.equal((await engine.loadGhostwriter(store, snapshot, chapter("../x")))?.name, "Default Ghostwriter", "no callback: still no failure");
  assert.equal(await engine.loadGhostwriter(store, { ...snapshot, book: { ...snapshot.book, ghostwriter: "nobody" } }, chapter(undefined)), null, "a valid slug without a file means no profile, as before");
  assert.equal((await engine.loadGhostwriter(store, { ...snapshot, book: { ...snapshot.book, ghostwriter: undefined } }, undefined))?.name, "Default Ghostwriter", "no ghostwriter at all: the default file, as before");
});

// ─── N3: whole books in other scripts ───────────────────────────────────────────────────────────────────────────────────

const RU = {
  name: "Russian", language: "ru", title: "Тихая гавань", joiner: " ", perSentence: 9,
  idea: "Маяк погас, и гавань хранит тайну.",
  characters: ["Анна Волкова", "Борис Игнатьев", "Игорь", "Мария Петровна"],
  locations: ["Тихая гавань", "Маяк на мысе"],
  factions: ["Артель рыбаков"],
  secrets: ["Почему погас маяк"],
  chapters: ["Возвращение домой", "Ночной шторм", "Последний рейс"],
  scenes: ["На причале", "Разговор у печи"],
  design: "# Замысел\n\n## Завязка\n\nАнна возвращается в гавань, где погас маяк.",
  context: "# Мир\n\nСеверная гавань, где живут рыбаки.",
  sentences: [
    "Утро над гаванью началось медленно, как дыхание старого рыбака.",
    "Анна вышла на причал и долго смотрела на тёмную воду.",
    "Борис Игнатьев молча проверял сети и не поднимал глаз.",
    "Ветер приносил запах соли, дыма и далёкого дождя.",
    "Она знала, что маяк не горел уже три ночи подряд.",
    "Никто в гавани не хотел говорить об этом вслух.",
  ],
};

const EL = {
  name: "Greek", language: "el", title: "Το μικρό λιμάνι", joiner: " ", perSentence: 11,
  idea: "Ο φάρος έσβησε και το λιμάνι κρύβει ένα μυστικό.",
  characters: ["Ελένη Παπαδοπούλου", "Οδυσσέας", "Μπαμπάς Ούρανος", "Σοφία"],
  locations: ["Το μικρό λιμάνι", "Ο φάρος του ακρωτηρίου"],
  factions: ["Σύλλογος Ψαράδων"],
  secrets: ["Γιατί έσβησε ο φάρος"],
  chapters: ["Η επιστροφή", "Η νυχτερινή καταιγίδα", "Το τελευταίο ταξίδι"],
  scenes: ["Στην αποβάθρα", "Συζήτηση δίπλα στη φωτιά"],
  design: "# Σχέδιο\n\n## Αφετηρία\n\nΗ Ελένη επιστρέφει στο λιμάνι όπου έσβησε ο φάρος.",
  context: "# Κόσμος\n\nΈνα βόρειο λιμάνι με ψαράδες.",
  sentences: [
    "Το πρωί πάνω από το λιμάνι ξεκίνησε αργά, σαν την ανάσα ενός γέρου ψαρά.",
    "Η Ελένη βγήκε στην αποβάθρα και κοίταξε για ώρα το σκοτεινό νερό.",
    "Ο Οδυσσέας έλεγχε σιωπηλός τα δίχτυα και δεν σήκωνε το βλέμμα.",
    "Ο άνεμος έφερνε μυρωδιά αλατιού, καπνού και μακρινής βροχής.",
    "Ήξερε ότι ο φάρος δεν είχε ανάψει εδώ και τρεις νύχτες.",
    "Κανείς στο λιμάνι δεν ήθελε να μιλήσει γι' αυτό φωναχτά.",
  ],
};

const ZH = {
  name: "Chinese", language: "zh", title: "宁静的海港", joiner: "", perSentence: 11,
  idea: "灯塔熄灭了，海港守着一个秘密。",
  characters: ["李明", "王芳", "陈海", "刘小梅"],
  locations: ["宁静的海港", "岬角灯塔"],
  factions: ["渔民公会"],
  secrets: ["灯塔为何熄灭"],
  chapters: ["回家", "夜里的风暴", "最后一次出海"],
  scenes: ["在码头上", "炉火旁的谈话"],
  design: "# 构思\n\n## 开端\n\n李明回到灯塔熄灭的海港。",
  context: "# 世界\n\n北方的海港，渔民在这里生活。",
  sentences: [
    "清晨的海港像老渔夫的呼吸一样缓慢地醒来。",
    "李明走到码头上，久久地望着那片漆黑的海水。",
    "王芳默默地检查着渔网，没有抬起头来。",
    "风带来了海盐、炊烟和远处雨水的气味。",
    "她知道灯塔已经连续三个晚上没有亮起来了。",
    "港口里没有人愿意大声谈论这件事。",
  ],
};

const JA = {
  name: "Japanese", language: "ja", title: "静かな港", joiner: "", perSentence: 12,
  idea: "灯台が消え、港は秘密を抱えている。",
  characters: ["田中太郎", "佐藤花子", "鈴木一郎", "ミナ"],
  locations: ["静かな港", "岬の灯台"],
  factions: ["漁師組合"],
  secrets: ["灯台はなぜ消えたのか"],
  chapters: ["帰郷", "夜の嵐", "最後の航海"],
  scenes: ["桟橋にて", "囲炉裏端の会話"],
  design: "# 構想\n\n## 発端\n\n田中太郎は灯台の消えた港に帰ってくる。",
  context: "# 世界\n\n北の港で、漁師たちが暮らしている。",
  sentences: [
    "朝の港は、年老いた漁師の呼吸のようにゆっくりと目を覚ました。",
    "田中太郎は桟橋に出て、暗い水面をいつまでも見つめていた。",
    "佐藤花子は黙って網を確かめ、顔を上げなかった。",
    "風は塩と煙と遠い雨の匂いを運んできた。",
    "彼女は灯台が三晩も続けて灯らなかったことを知っていた。",
    "港の誰も、そのことを声に出して話したがらなかった。",
  ],
};

const AR = {
  name: "Arabic", language: "ar", title: "الميناء الهادئ", joiner: " ", perSentence: 9,
  idea: "انطفأت المنارة والميناء يخفي سرا.",
  characters: ["ليلى الحسن", "يوسف المنصور", "سامي", "نور"],
  locations: ["الميناء الهادئ", "منارة الرأس"],
  factions: ["نقابة الصيادين"],
  secrets: ["لماذا انطفأت المنارة"],
  chapters: ["العودة إلى البيت", "عاصفة الليل", "الرحلة الأخيرة"],
  scenes: ["على الرصيف", "حديث قرب الموقد"],
  design: "# الفكرة\n\n## البداية\n\nتعود ليلى إلى الميناء الذي انطفأت منارته.",
  context: "# العالم\n\nميناء شمالي يعيش فيه الصيادون.",
  sentences: [
    "بدأ الصباح فوق الميناء ببطء، مثل أنفاس صياد عجوز.",
    "خرجت ليلى إلى الرصيف ونظرت طويلا إلى الماء المظلم.",
    "كان يوسف المنصور يفحص الشباك بصمت دون أن يرفع عينيه.",
    "حملت الريح رائحة الملح والدخان ومطر بعيد.",
    "كانت تعرف أن المنارة لم تضئ منذ ثلاث ليال متتالية.",
    "لم يرغب أحد في الميناء أن يتحدث عن ذلك بصوت عال.",
  ],
};

const MIXED = {
  name: "Mixed", language: "it", title: "Mare / 海 / Θάλασσα", joiner: " ", perSentence: 9,
  idea: "Un faro, tre alfabeti.",
  characters: ["Мария / Maria", "李明 (Li Ming)", "Οδυσσέας", "★ The Keeper ★", "Igor", "Игорь", "Игор", "!!!", "🌊"],
  locations: ["Порт / Harbor", "海辺の町"],
  factions: ["I Fratelli d'Elmo"],
  secrets: ["Perché il faro è spento / 灯塔为何熄灭"],
  chapters: ["Chapter 1: 海辺 Seaside", "Глава 2 — Return", "第三章", "Κεφάλαιο Δ΄", "!!!", "🌊🌊🌊"],
  scenes: ["Scene ★", "場面 ‒ Scene", "Сцена", "!!!"],
  design: "# Progetto\n\n## Premessa\n\nUn faro si spegne in una città con tre alfabeti.",
  context: "# Mondo\n\nUna città di mare dove si scrive in tre alfabeti.",
  sentences: [
    "Il porto si svegliò piano, e il vento portò un odore di sale e di fumo.",
    "Maria uscì sul molo e guardò a lungo l'acqua scura, senza dire una parola.",
    "Il custode controllava le reti in silenzio e non alzava gli occhi.",
    "Nessuno nel porto voleva parlare del faro spento, nemmeno a bassa voce.",
    "Sapeva che il faro non si accendeva da tre notti.",
    "Il mare restava immobile, come un vecchio pescatore che ha smesso di sperare.",
  ],
};

const SCRIPTS = [RU, EL, ZH, JA, AR, MIXED];

function proseOf(script, words) {
  const paragraphs = [];
  let sentences = [];
  let count = 0;
  for (let index = 0; count < words; index += 1) {
    sentences.push(script.sentences[index % script.sentences.length]);
    count += script.perSentence;
    if (sentences.length === 4) {
      paragraphs.push(sentences.join(script.joiner));
      sentences = [];
    }
  }
  if (sentences.length) paragraphs.push(sentences.join(script.joiner));
  return paragraphs.join("\n\n");
}

/** The fake AI answering in a book's own script: names, titles, scenes and prose. */
function scriptAi(script, { words = 300, latinProse = false } = {}) {
  return scripted((request) => {
    switch (request.json?.name) {
      case "book_concept":
        return reply(conceptReply({
          logline: script.idea,
          storyDesign: script.design,
          context: script.context,
          characters: script.characters.map((name, index) => ({ name, roleTier: index === 0 ? "main" : "supporting", storyRole: index === 0 ? "protagonist" : "ally", description: script.sentences[index % script.sentences.length], desire: script.sentences[1], fear: script.sentences[2], arc: script.sentences[3], voice: script.sentences[4] })),
          locations: script.locations.map((name) => ({ name, description: script.sentences[0], atmosphere: script.sentences[1] })),
          factions: script.factions.map((name) => ({ name, description: script.sentences[2], mission: script.sentences[3] })),
          secrets: script.secrets.map((title) => ({ title, truth: script.sentences[5], holders: [script.characters[1], script.characters[2]], stakes: script.sentences[0], revealChapter: 2 })),
        }));
      case "chapter_plan": {
        const range = /numbered (\d+) to (\d+)/.exec(request.user) ?? /chapters (\d+)-(\d+)/.exec(request.user);
        const from = range ? Number(range[1]) : 1;
        const to = range ? Number(range[2]) : 3;
        return reply({
          chapters: Array.from({ length: to - from + 1 }, (_, index) => ({
            number: from + index,
            title: script.chapterTitle ? script.chapterTitle(from + index) : script.chapters[(from + index - 1) % script.chapters.length],
            summary: script.sentences[(from + index) % script.sentences.length],
            goal: script.sentences[1],
            pov: [script.characters[0]],
            keyEvents: [script.sentences[2]],
            reveals: from + index === 2 ? [script.secrets[0]] : [],
          })),
        });
      }
      case "scene_plan":
        return reply({
          scenes: script.scenes.slice(0, 2).map((title, index) => ({
            title,
            goal: script.sentences[index],
            beats: [script.sentences[2], script.sentences[3], script.sentences[4]],
            pov: script.characters[0],
            location: script.locations[0],
            characters: [script.characters[0], script.characters[1]],
            summary: script.sentences[5],
          })),
        });
      case "scene_summary":
        return reply({ summary: script.sentences[0] });
      case "chapter_consolidation":
        return reply({ summary: script.sentences[0], recap: `- ${script.sentences[1]}\n- ${script.sentences[2]}`, stateChanges: {}, storySoFar: script.sentences.slice(0, 3).join(script.joiner) });
      default:
        return request.json || latinProse ? undefined : { text: proseOf(script, words), usage: { inputTokens: 100, outputTokens: 400, cachedInputTokens: 0 }, model: "fake-model", provider: "fake", cost: 0.002, currency: "USD" };
    }
  }, { words });
}

async function bookOf(script, { chapters = 3, scenes = 2, words = 300, files, ai = scriptAi(script, { words }), options = {} } = {}) {
  const store = new MemoryBookStore(files ?? { ...seedBookFiles({ title: script.title, language: script.language }), ...(await intactEntries(chapters)) });
  const { events, state } = await runSession(store, ai, { brief: { idea: script.idea, targetChapters: chapters, scenesPerChapter: scenes, wordsPerScene: words }, options });
  return { store, ai, events, state };
}

function assertNoBrokenName(store) {
  const names = [...store.files.keys()];
  for (const name of names) {
    assert.equal(engine.isSafeBookPath(name), true, `${name} is not a safe path`);
    for (const segment of name.split("/")) {
      assert.ok(segment.length > 0, `an empty name in ${name}`);
      assert.doesNotMatch(segment, /^\d{3,}-(?:\.md)?$/, `a number without a name in ${name}`);
      assert.doesNotMatch(segment, /^\.md$|^-|-\.md$|--/, `an empty slug in ${name}`);
    }
  }
  assert.equal(new Set(names.map((name) => name.toLowerCase())).size, names.length, "two files whose names differ only by case");
}

function assertCanonComplete(store, script) {
  const wanted = { characters: script.characters.slice(0, 10), locations: script.locations, factions: script.factions, secrets: script.secrets };
  for (const [directory, names] of Object.entries(wanted)) {
    const files = canonFiles(store, directory);
    for (const name of names) assert.ok(files.some((entry) => entry.name === name), `${directory}: no file for «${name}» in ${files.map((entry) => `${entry.slug}=${entry.name}`).join(", ")}`);
    assert.equal(files.length, names.length, `${directory}: ${files.length} files for ${names.length} names`);
    assert.equal(new Set(files.map((entry) => entry.slug)).size, files.length);
    for (const entry of files) assert.equal(entry.id, `${directory === "secrets" ? "secret" : directory.slice(0, -1)}:${entry.slug}`);
  }
}

async function assertPlanReadable(store, state) {
  const snapshot = await loadBookSnapshot(store);
  for (const chapter of state.plan.chapters) {
    const info = snapshot.chapters.find((entry) => entry.slug === chapter.slug);
    assert.ok(info, `chapter ${chapter.number} (${chapter.slug}) is not in the book`);
    assert.equal(info.number, chapter.number);
    assert.equal(info.title, chapter.title);
    assert.equal(info.paragraphs.length, chapter.scenes.length, `scenes of chapter ${chapter.number}`);
    for (const scene of chapter.scenes) {
      assert.ok(scene.path && snapshot.files.has(scene.path), `scene ${chapter.number}.${scene.number}: ${scene.path}`);
      assert.ok(info.paragraphs.some((paragraph) => paragraph.path === scene.path && paragraph.number === scene.number && paragraph.title === scene.title), `scene ${chapter.number}.${scene.number} is not visible`);
      assert.match(scene.slug, /^\d{3}-[a-z0-9][a-z0-9-]*$/, "the slug of a scene is never empty");
    }
  }
  assert.deepEqual(importedChapters(snapshot).map((chapter) => [chapter.number, chapter.slug, chapter.scenes.map((scene) => scene.path)]), state.plan.chapters.map((chapter) => [chapter.number, chapter.slug, chapter.scenes.map((scene) => scene.path)]), "the plan can be rebuilt from the files alone");
}

async function assertSyncIdempotent(store) {
  const remote = new MemoryBookStore();
  const first = await syncBookStores({ local: store, remote, base: new Map() });
  assert.deepEqual([first.rejected, first.conflicts, first.downloaded], [[], [], []]);
  assert.equal(first.uploaded.length, store.files.size, "every file goes to the other side");
  assert.deepEqual(remote.toObject(), store.toObject());
  const second = await syncBookStores({ local: store, remote, base: first.base });
  assert.deepEqual([second.uploaded, second.downloaded, second.conflicts, second.rejected], [[], [], [], []], "syncing again changes nothing");
  const third = new MemoryBookStore();
  const download = await syncBookStores({ local: third, remote, base: new Map() });
  assert.deepEqual(third.toObject(), store.toObject(), "a third copy is the same book");
  assert.deepEqual([download.uploaded, download.conflicts, download.rejected], [[], [], []]);
  assert.equal((await syncBookStores({ local: third, remote, base: download.base })).uploaded.length, 0);
}

function assertWordsPlausible(store, state, ai, script, words) {
  const writes = ai.calls.filter((call) => call.label.startsWith("autopilot:write:"));
  assert.equal(writes.length, state.plan.chapters.reduce((sum, chapter) => sum + chapter.scenes.length, 0), "a write call for every scene");
  const cap = Math.min(16000, Math.ceil(words * engine.tokensPerWord(script.language)) + 800);
  for (const write of writes) assert.equal(write.maxOutputTokens, cap, `${write.label} in ${script.name}`);
  const latinCap = Math.min(16000, Math.ceil(words * 2.4) + 800);
  if (script.language === "it") assert.equal(cap, latinCap);
  else assert.ok(cap > latinCap && cap <= 16000, `${script.name}: ${cap} against ${latinCap} for Latin text`);
  for (const chapter of state.plan.chapters) {
    for (const scene of chapter.scenes) {
      const body = parseMarkdown(store.files.get(scene.path)).body;
      assert.ok(scene.words >= 40, `scene ${chapter.number}.${scene.number} has ${scene.words} words`);
      assert.equal(scene.words, engine.countWords(body), "the count in the plan is the count of the text");
      if (["zh", "ja"].includes(script.language)) {
        const characters = [...body].length;
        assert.ok(scene.words < characters && scene.words > characters / 4, `${scene.words} words for ${characters} characters`);
        assert.ok(cap >= characters * 1.5, `${cap} tokens would cut ${characters} characters of ${script.name}`);
      }
    }
  }
}

for (const script of SCRIPTS) {
  test(`${script.name}: a whole book is planned, written, reviewed, closed, synced and read back, with no empty or duplicate name`, async () => {
    const { store, ai, state, events } = await bookOf(script, { options: { maxReaders: 2 } });
    assert.equal(state.status, "completed", state.lastError?.message);
    assert.equal(state.phase, "completed");
    assert.deepEqual(state.plan.chapters.map((chapter) => chapter.status), ["done", "done", "done"]);
    assert.equal(state.plan.chapters.every((chapter) => chapter.scenes.length === 2 && chapter.scenes.every((scene) => scene.status === "reviewed")), true);
    assert.equal(events.some((event) => event.type === "insight" && event.tone === "critical"), false);
    assertNoBrokenName(store);
    if (script !== MIXED) assertCanonComplete(store, script);
    await assertPlanReadable(store, state);
    await assertSyncIdempotent(store);
    assertWordsPlausible(store, state, ai, script, 300);
    const write = ai.calls.find((call) => call.label === "autopilot:write:1.1");
    assert.match(write.user, new RegExp(`LANGUAGE: ${engine.languageName(script.language)}`));
    assert.ok(write.user.includes(`${script.scenes[0]}`), "the scene title reaches the writer in its own script");
    assert.ok(store.files.get("plot.md").includes(script.chapters[0]), "and the plot");
    assert.equal(parseMarkdown(store.files.get(`chapters/${state.plan.chapters[0].slug}/chapter.md`)).frontmatter.title, script.chapters[0], "the title of the chapter is in its file as the model wrote it");
  });
}

test("Mixed: the names that make the same file name are told apart, none is dropped, and the secret points at the right ones", async () => {
  const { store, events, state } = await bookOf(MIXED, { chapters: 2, scenes: 1 });
  assert.equal(state.status, "completed", state.lastError?.message);
  const characters = canonFiles(store, "characters");
  assert.equal(characters.length, MIXED.characters.length, "every name of the book has a file");
  assert.deepEqual(characters.map((entry) => entry.name).sort(), [...MIXED.characters].sort());
  assert.deepEqual(characters.filter((entry) => /^igor(-\d+)?$/.test(entry.slug)).map((entry) => [entry.slug, entry.name]), [["igor", "Igor"], ["igor-2", "Игорь"], ["igor-3", "Игор"]]);
  assert.equal(characters.find((entry) => entry.name === "!!!").slug, `character-${slugCode("!!!")}`);
  assert.equal(characters.find((entry) => entry.name === "🌊").slug, `character-${slugCode("🌊")}`);
  const secret = canonFiles(store, "secrets")[0];
  assert.deepEqual(secret.frontmatter.holders, ["character:li-ming", "character:odysseas"]);
  assert.equal(secret.frontmatter.reveal_in, `chapter:${state.plan.chapters[1].slug}`);
  assert.ok(events.some((event) => event.type === "insight" && /igor-2/.test(`${event.title} ${event.detail}`)), "the autopilot reports the renamed entries");
  assert.deepEqual(state.plan.chapters.map((chapter) => chapter.slug), ["001-chapter-1-seaside", "002-2-return"]);
});

test("Mixed: chapter titles in every alphabet, symbols and emoji make distinct, readable folders", async () => {
  const { store, state } = await bookOf(MIXED, { chapters: 6, scenes: 1, options: { specialists: false, readers: false, readersOnPlan: false } });
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(state.plan.chapters.map((chapter) => chapter.slug), ["001-chapter-1-seaside", "002-2-return", "003-chapter", "004-kefalaio-d", "005-chapter", "006-chapter"]);
  assert.equal(new Set(state.plan.chapters.map((chapter) => chapter.slug)).size, 6);
  assertNoBrokenName(store);
  await assertPlanReadable(store, state);
  assert.deepEqual((await loadBookSnapshot(store)).chapters.map((chapter) => chapter.title), MIXED.chapters);
});

test("the relevant canon of a scene is found in a Chinese book although its names have two characters", async () => {
  const { ai, state } = await bookOf(ZH, { chapters: 1, scenes: 1 });
  assert.equal(state.status, "completed", state.lastError?.message);
  const write = ai.calls.find((call) => call.label === "autopilot:write:1.1");
  assert.match(write.user, /RELEVANT CANON:\n### Character: 李明/, "the scene's characters are looked up by name");
  assert.match(write.user, /### Character: 王芳/);
  assert.match(write.user, /### Location: 宁静的海港/);
  const specialists = ai.calls.find((call) => call.label === "autopilot:specialists:1");
  assert.match(specialists.user, /CANON DETAILS:[\s\S]*### Character: 李明/, "and the names that appear in the chapter text are found without spaces around them");
});

test("a book written in Chinese is still written, counted and read back when the platform has no Intl.Segmenter", async () => {
  const original = Intl.Segmenter;
  try {
    Intl.Segmenter = undefined;
    const { store, state } = await bookOf(ZH, { chapters: 2, scenes: 2, options: { specialists: false } });
    assert.equal(state.status, "completed", state.lastError?.message);
    assertNoBrokenName(store);
    await assertPlanReadable(store, state);
    for (const chapter of state.plan.chapters) {
      for (const scene of chapter.scenes) {
        const body = parseMarkdown(store.files.get(scene.path)).body;
        assert.equal(scene.words, engine.countWords(body), "the plan holds the estimate of the text");
        assert.ok(scene.words >= 75 && scene.words < [...body].length, `${scene.words} estimated words for ${[...body].length} characters`);
      }
    }
  } finally {
    Intl.Segmenter = original;
  }
});

test("the story design an author wrote is a design in Chinese as it is in Italian: a hundred words are not a scaffold, and the autopilot keeps them", async () => {
  const { isThinDocument, latinLength } = engine;
  const scaffold = "# Story Design\n\n## Premise\n\n## Main Conflict\n\n## Character Arcs\n";
  const chinese = "李明回到了海边的小屋，母亲正在补网。灯塔已经熄灭了三个晚上，港口里没有人愿意谈论这件事。".repeat(2);
  assert.ok(chinese.length < 160 && engine.countWords(chinese) > 40, `${chinese.length} characters, ${engine.countWords(chinese)} words`);
  assert.equal(isThinDocument(scaffold), true, "headings only");
  assert.equal(isThinDocument("# 故事设计\n\n## 前提\n\n## 冲突\n"), true, "headings only, in Chinese");
  assert.equal(isThinDocument(`${scaffold}\n${chinese}`), false, "a short paragraph in Chinese is a design");
  assert.equal(isThinDocument(`${scaffold}\nMira came back to the little house by the sea.`), true, "a sentence in English is not yet");
  assert.equal(isThinDocument(`${scaffold}\n${"Mira came back to the little house by the sea and sat down. ".repeat(3)}`), false, "three are");
  assert.equal(isThinDocument(`${scaffold}\n${"x".repeat(159)}`), true, "the limit in characters of a Latin text is the one it always was");
  assert.equal(isThinDocument(`${scaffold}\n${"x".repeat(160)}`), false);
  assert.equal(latinLength("Mira came back"), 14);
  assert.equal(latinLength(""), 0);
  assert.equal(latinLength("李明回到了海边的小屋。"), engine.countWords("李明回到了海边的小屋。") * 6, "six characters for every word of a script without spaces");

  const store = new MemoryBookStore({ ...seedBookFiles({ chapters: 1, language: "zh", title: ZH.title }), "story-design.md": `---\ntype: note\nid: note:story-design\ntitle: Story Design\n---\n\n${scaffold}\n${chinese}\n` });
  const ai = scriptAi(ZH);
  const { state } = await runSession(store, ai, { brief: { idea: ZH.idea, targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: FAST });
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.equal(ai.calls.some((call) => call.label === "autopilot:concept"), false, "no concept is generated over the author's design");
  assert.ok(store.files.get("story-design.md").includes(chinese), "and the design is still there");
});

test("a Chinese book at chapter 1200: the chapters are numbered, named and read back like any other, the run goes on and the totals add up", async () => {
  const first = 1198;
  const state = createAutopilotState(new Date(0), { idea: ZH.idea, targetChapters: 1203, scenesPerChapter: 2, wordsPerScene: 300 }, { ...FAST, chaptersPerRun: 4 });
  state.concept = { done: true, generated: false, secrets: [] };
  state.plan = {
    chapters: Array.from({ length: 6 }, (_, index) => ({ number: first + index, title: ZH.chapters[index % ZH.chapters.length], slug: "", summary: ZH.sentences[0], goal: "", pov: [ZH.characters[0]], keyEvents: [], reveals: [], status: "planned", scenes: [] })),
    approved: true, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false,
  };
  const store = new MemoryBookStore({ ...seedBookFiles({ language: "zh", title: ZH.title }), ...(await intactEntries(1203)), [STATE]: serializeAutopilotState(state) });
  const ai = scriptAi(ZH);
  const { session, state: paused } = await runSession(store, ai, { options: { ...FAST, chaptersPerRun: 4 } });
  assert.equal(paused.status, "paused", paused.lastError?.message);
  assert.deepEqual(paused.plan.chapters.map((chapter) => [chapter.number, chapter.slug, chapter.status]), [[1198, "1198-chapter", "done"], [1199, "1199-chapter", "done"], [1200, "1200-chapter", "done"], [1201, "1201-chapter", "done"], [1202, "1202-chapter", "planned"], [1203, "1203-chapter", "planned"]]);
  assert.ok(store.files.has("chapters/1200-chapter/001-scene.md") && store.files.has("chapters/1200-chapter/002-scene.md"), "the scenes of chapter 1200 are in its own folder, with names");
  assert.equal(parseMarkdown(store.files.get("chapters/1200-chapter/chapter.md")).frontmatter.title, ZH.chapters[2]);
  const resume = engine.parseTotalResume(parseMarkdown(store.files.get("resumes/total.md")).body);
  assert.deepEqual(resume.chapters.map((section) => section.number), [1198, 1199, 1200, 1201]);
  assert.equal(resume.chapters[2].heading, `## Chapter 1200 ${ZH.chapters[2]}`);
  const snapshot = await loadBookSnapshot(store);
  assert.deepEqual(snapshot.chapters.map((chapter) => [chapter.number, chapter.title, chapter.paragraphs.length]), [[1198, ZH.chapters[0], 2], [1199, ZH.chapters[1], 2], [1200, ZH.chapters[2], 2], [1201, ZH.chapters[0], 2]]);
  const scenes = ai.calls.find((call) => call.label === "autopilot:scenes:1200");
  assert.match(scenes.user, /Break chapter 1200 «最后一次出海»/);
  assert.match(scenes.user, /CHAPTER 1200: 最后一次出海/);

  await session.start({ options: { chaptersPerRun: 0 } });
  await session.waitForIdle();
  const done = stateOf(store);
  assert.equal(done.status, "completed", done.lastError?.message);
  assert.deepEqual(done.plan.chapters.map((chapter) => chapter.status), Array(6).fill("done"));
  assertNoBrokenName(store);
  await assertPlanReadable(store, done);
  await assertSyncIdempotent(store);
  assertWordsPlausible(store, done, ai, ZH, 300);
  const total = done.plan.chapters.reduce((sum, chapter) => sum + chapter.scenes.reduce((words, scene) => words + scene.words, 0), 0);
  assert.equal(engine.autopilotProgress(done).words, total);
  assert.ok(total >= 12 * 100 && total < 12 * 1000, `${total} words in 12 scenes of about 300`);
});

test("a book written in Chinese up to chapter 1200 by its author is continued with chapter 1201", async () => {
  const files = { ...seedBookFiles({ language: "zh", title: ZH.title }), ...(await intactEntries([1198, 1199, 1200, 1201])) };
  for (const number of [1198, 1199, 1200]) {
    const slug = `${number}-chapter`;
    files[`chapters/${slug}/chapter.md`] = chapterFile(number, slug, `第${number}章`, ZH.sentences[0]);
    files[`chapters/${slug}/001-scene.md`] = sceneFile(slug, "001-scene", 1, "码头", ZH.sentences[1]);
  }
  const { state } = await bookOf(ZH, { chapters: 4, scenes: 1, files, options: { specialists: false } });
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(state.plan.chapters.map((chapter) => [chapter.number, chapter.slug, Boolean(chapter.imported)]), [[1198, "1198-chapter", true], [1199, "1199-chapter", true], [1200, "1200-chapter", true], [1201, "1201-chapter", false]]);
});

test("the files of Russian and Chinese books written by the autopilot form a valid Narrarium book", async () => {
  for (const script of [RU, ZH]) {
    const { store, state } = await bookOf(script, { chapters: 2, scenes: 2 });
    assert.equal(state.status, "completed", state.lastError?.message);
    const root = await mkdtemp(path.join(os.tmpdir(), "narrarium-nonlatin-"));
    try {
      for (const [relative, content] of store.files) {
        const target = path.join(root, ...relative.split("/"));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
      }
      const validation = await validateBook(root);
      assert.deepEqual(validation.errors, [], `${script.name}: schemas and identities are valid`);
      const doctor = await doctorBook(root);
      assert.deepEqual(doctor.issues.filter((issue) => issue.severity === "error"), [], `${script.name}: doctor finds no errors`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("a book whose language is written as a name, not a code, is written in that language with room for its words", async () => {
  for (const [language, script] of [["Russian", RU], ["Japanese", JA], ["日本語", JA], ["русский", RU]]) {
    const store = new MemoryBookStore(seedBookFiles({ chapters: 1, title: script.title, language }));
    const ai = scriptAi(script);
    const { state } = await runSession(store, ai, { brief: { idea: script.idea, targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: FAST });
    assert.equal(state.status, "completed", `${language}: ${state.lastError?.message}`);
    const write = ai.calls.find((call) => call.label === "autopilot:write:1.1");
    assert.match(write.system, new RegExp(`prose in ${engine.languageName(script.language)}`), language);
    assert.equal(write.maxOutputTokens, Math.min(16000, Math.ceil(300 * engine.tokensPerWord(script.language)) + 800), language);
  }
});

test("a language the engine does not know is sized prudently, not like Italian", async () => {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1, language: "Klingon" }));
  const ai = createFakeAutopilotAi({ scenes: 1 });
  const { state } = await runSession(store, ai, { brief: { ...ONE_CHAPTER, wordsPerScene: 1000 }, options: FAST });
  assert.equal(state.status, "completed", state.lastError?.message);
  const write = ai.calls.find((call) => call.label === "autopilot:write:1.1");
  assert.equal(write.maxOutputTokens, Math.min(16000, Math.ceil(1000 * engine.UNKNOWN_TOKENS_PER_WORD) + 800));
  assert.ok(write.maxOutputTokens > Math.ceil(1000 * 2.4) + 800);
});

test("the limits of every other step of a Russian or Hindi book grow with the language, up to 16 000, and a French book's do not", async () => {
  const limitsOf = async (language, script) => {
    const store = new MemoryBookStore(seedBookFiles({ chapters: 1, language, title: script.title }));
    const ai = scriptAi(script);
    const { state } = await runSession(store, ai, { brief: { ...ONE_CHAPTER, idea: script.idea }, options: { ...FAST, specialists: true } });
    assert.equal(state.status, "completed", `${language}: ${state.lastError?.message}`);
    return fixedLimits(ai);
  };
  const french = await limitsOf("fr", { ...MIXED, language: "fr" });
  const russian = await limitsOf("ru", RU);
  const hindi = await limitsOf("hi", { ...RU, language: "hi" });
  assert.deepEqual(french, LATIN_LIMITS, "a French book is sized as ever");
  for (const [label, base] of Object.entries(LATIN_LIMITS)) {
    assert.equal(russian[label], engine.scaleOutputTokens(base, "ru"), `${label} in Russian`);
    assert.ok(russian[label] > base && russian[label] <= 16000, `${label}: ${russian[label]}`);
    assert.equal(hindi[label], engine.scaleOutputTokens(base, "hi"), `${label} in Hindi`);
    assert.ok(hindi[label] >= russian[label] && hindi[label] <= 16000, `${label}: ${hindi[label]}`);
  }
});

test("a revision of a Chinese or Russian book looks around the chapter the author names, in the author's words", async () => {
  const files = seedBookFiles({ chapters: 1, language: "ru" });
  const chapters = 1200;
  for (let number = 1; number <= chapters; number += 1) {
    const slug = engine.chapterSlug(number, `Written ${number}`);
    files[`chapters/${slug}/chapter.md`] = chapterFile(number, slug, `Written ${number}`, `What happened in written chapter ${number}.`);
    files[`chapters/${slug}/001-scene.md`] = sceneFile(slug, "001-scene", 1, "Scene", `The prose of chapter ${number}.`);
  }
  const promptFor = async (instruction) => {
    const state = createAutopilotState(new Date(0), { idea: "x", targetChapters: chapters, scenesPerChapter: 1 }, FAST);
    state.concept = { done: true, generated: false, secrets: [] };
    state.revision = { id: "r1", instruction, createdAt: "2026-01-01T00:00:00.000Z", targets: null, cursor: 0 };
    const ai = { calls: [], async complete(request) { this.calls.push(request); throw new engine.AiProviderError("Stopped by the test.", 401, false); } };
    await runSession(new MemoryBookStore({ ...files, [STATE]: serializeAutopilotState(state) }), ai, {});
    assert.equal(ai.calls[0].label, "autopilot:impact");
    return ai.calls[0].user;
  };
  const lists = (prompt, number) => prompt.includes(`- Chapter ${number}, scene 1 «Scene»: `);
  for (const [instruction, number] of [
    ["Make Orrin kinder in chapter 12.", 12], ["Rendi Orrin più gentile nel capitolo 12.", 12], ["Rewrite chapters 345 and 346.", 345],
    ["Сделай Орина добрее в главе 12.", 12], ["Измени главу 12.", 12], ["В главах 345 и 346 всё слишком быстро.", 345],
    ["在第12章里让奥林更善良。", 12], ["第12章を直してください。", 12], ["제12장을 고쳐 주세요.", 12],
    ["Κάνε τον Όριν πιο ευγενικό στο κεφάλαιο 12.", 12], ["اجعل أورين ألطف في الفصل 12.", 12], ["עשה את אורין נחמד יותר בפרק 12.", 12],
  ]) {
    const prompt = await promptFor(instruction);
    assert.ok(lists(prompt, number), `${instruction}: chapter ${number} is listed with its scenes`);
    assert.ok(!lists(prompt, 700), `${instruction}: a chapter far from it is not`);
  }
  const prompt = await promptFor("Make Orrin kinder.");
  assert.ok(lists(prompt, chapters) && !lists(prompt, 12), "without a number, the latest chapter, as before");
});
