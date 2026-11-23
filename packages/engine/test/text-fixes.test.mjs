import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";
import { JSON_ASK, integration, recording } from "./transport-fakes.mjs";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { AutopilotSession, parseAutopilotState } = engine;

// ─── Small fixes of what the engine says: dates the author can read, the models Tools only left out, a count that began late ──────

const STATE = "autopilot/state.json";
const FAST = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };
const BRIEF = { idea: "x", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 };
const SCENE = "chapters/001-chapter-title-1/001-scene-1-title.md";
const DIST = new URL("../dist/index.js", import.meta.url).href;

test("formatBookDate says a moment as the author reads it, in the language of the book, on its day in UTC", () => {
  const { formatBookDate } = engine;
  assert.equal(formatBookDate("2026-11-21T10:00:00.000Z", "it"), "21 novembre 2026");
  assert.equal(formatBookDate("2026-11-21T10:00:00.000Z", "en"), "21 November 2026");
  assert.equal(formatBookDate("2026-11-21T10:00:00.000Z", "it-IT"), "21 novembre 2026");
  assert.equal(formatBookDate("2026-11-21T10:00:00.000Z", "Italian"), "21 novembre 2026", "a language named in words");
  assert.equal(formatBookDate("2026-11-21T10:00:00.000Z", "fr"), "21 November 2026", "the words around a date are English for every language but Italian");
  assert.equal(formatBookDate("2026-01-01", "it"), "1 gennaio 2026");
  assert.equal(formatBookDate("2026-11-21T23:30:00-05:00", "en"), "22 November 2026", "the day in UTC");
  assert.equal(formatBookDate("2026-11-22T00:30:00+02:00", "it"), "21 novembre 2026");
  for (const nothing of ["not a date", "", undefined, null, "2026-13-40"]) assert.equal(formatBookDate(nothing, "en"), "", String(nothing));
});

test("the same words whatever the time zone and the language of the machine", () => {
  const script = `import(${JSON.stringify(DIST)}).then((engine) => process.stdout.write(JSON.stringify([engine.formatBookDate("2026-11-21T23:30:00Z", "it"), engine.formatBookDate("2026-11-21T00:30:00Z", "en")])))`;
  for (const env of [{ TZ: "Pacific/Kiritimati", LANG: "ar_SA.UTF-8", LC_ALL: "ar_SA.UTF-8" }, { TZ: "America/Adak", LANG: "ja_JP.UTF-8", LC_ALL: "ja_JP.UTF-8" }]) {
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, ...env }, encoding: "utf8" });
    assert.deepEqual(JSON.parse(out), ["21 novembre 2026", "21 November 2026"], JSON.stringify(env));
  }
});

/** A book of one chapter that the autopilot wrote and froze on 1 January 2026, whose scene the author then changed. */
async function changedFrozenBook(language, options = {}) {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1, language }));
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai: createFakeAutopilotAi({ reviewVerdict: () => "approve" }), host: "server", hostLabel: "test", retryDelayMs: 0, now: () => new Date("2026-01-01T00:00:00.000Z") });
  session.subscribe((event) => events.push(event));
  await session.start({ brief: BRIEF, options: { ...FAST, ...options } });
  await session.waitForIdle();
  store.write(SCENE, `${store.files.get(SCENE).trimEnd()}\n\nThe author's own new line.\n`);
  await session.start();
  await session.waitForIdle();
  return { state: parseAutopilotState(store.files.get(STATE)), events };
}

test("the question about a frozen chapter, and the message of the stop, say the day it was frozen as the author reads it", async () => {
  const italian = await changedFrozenBook("it");
  assert.match(italian.state.question.question, /congelato il 1 gennaio 2026\. Cosa faccio\?$/);
  assert.match(italian.state.message, /congelato il 1 gennaio 2026: scegli/);
  const english = await changedFrozenBook("en");
  assert.match(english.state.question.question, /frozen on 1 January 2026\. What should I do\?$/);
  assert.match(english.state.message, /frozen on 1 January 2026: choose/);
  for (const { state } of [italian, english]) assert.doesNotMatch(`${state.question.question} ${state.message}`, /2026-01-01/, "no ISO date in what the author reads");
});

test("the notice of a frozen chapter that changed, when it is only noticed, says the day as well", async () => {
  const { events } = await changedFrozenBook("it", { frozenEdits: "notify" });
  const notice = events.find((event) => event.type === "insight" && event.code === "frozenChanged");
  assert.match(notice.title, /congelato il 1 gennaio 2026: non viene rivisto/);
});

test("AiToolsRequiredError lists the models it left out by name and as { integration, model }", async () => {
  const noTools = { supportsToolCalls: false };
  const config = {
    aiIntegrations: [
      integration({ id: "a", name: "Alpha", endpoint: "http://a.test/v1", chatModels: [{ id: "a1", name: "alpha-model", capabilities: ["default"], ...noTools }] }),
      integration({ id: "b", name: "Beta", endpoint: "http://b.test/v1", chatModels: [{ id: "b1", name: "beta-model", capabilities: ["default"], ...noTools }] }),
    ],
  };
  const { fetch, calls } = recording(() => Response.json({}));
  const error = await engine.createFetchAi(config, { fetch }).complete(JSON_ASK).then(() => null, (failure) => failure);
  assert.ok(error instanceof engine.AiToolsRequiredError, String(error));
  assert.deepEqual(error.models, ["alpha-model", "beta-model"], "the names, as before");
  assert.deepEqual(error.skippedModels, [{ integration: "a", model: "alpha-model" }, { integration: "b", model: "beta-model" }], "and which integration each is in, by its id");
  assert.equal(calls.length, 0);
  assert.deepEqual(new engine.AiToolsRequiredError("no models").skippedModels, [], "an error made by a host without the list has an empty one");
});

test("stats.workedMsPartial says that the count of the working time began on a book that had already worked", async () => {
  // A book an older engine wrote: five steps saved, and no time counted.
  const older = engine.createAutopilotState(new Date("2025-12-01T00:00:00.000Z"), BRIEF, FAST);
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  store.write(STATE, engine.serializeAutopilotState({ ...older, stats: { ...older.stats, tasks: 5 } }));
  const resumed = new AutopilotSession({ bookId: "book", store, ai: createFakeAutopilotAi(), host: "server", hostLabel: "test", retryDelayMs: 0 });
  await resumed.start();
  await resumed.waitForIdle();
  const stats = parseAutopilotState(store.files.get(STATE)).stats;
  assert.ok(stats.workedMs >= 0 && stats.workedMsSince, "the count began");
  assert.equal(stats.workedMsPartial, true, "after five steps it did not see");

  const fresh = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  const session = new AutopilotSession({ bookId: "book", store: fresh, ai: createFakeAutopilotAi(), host: "server", hostLabel: "test", retryDelayMs: 0 });
  await session.start({ brief: BRIEF, options: FAST });
  await session.waitForIdle();
  assert.equal(parseAutopilotState(fresh.files.get(STATE)).stats.workedMsPartial, undefined, "a count born with the book is whole");

  const read = (stats) => parseAutopilotState(JSON.stringify({ stats })).stats.workedMsPartial;
  assert.equal(read({ workedMs: 10, workedMsSince: "2026-01-01T00:00:00.000Z", workedMsPartial: true }), true);
  assert.equal(read({ workedMs: 10, workedMsSince: "2026-01-01T00:00:00.000Z", workedMsPartial: "yes" }), undefined, "only true");
  assert.equal(read({ workedMsPartial: true }), undefined, "only next to the count");
});
