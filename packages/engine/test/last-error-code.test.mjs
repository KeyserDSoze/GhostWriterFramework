import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// A run that «Retry later» stopped says so in its state, not only in the `run-ended` event: a page opened after the run, or another device,
// reads `state.lastError.code` (and `summary.lastError.code`) and can say that the retries were used up, or turned off. The code is optional, read
// tolerantly, and only the two codes that end a run with an error are kept. And `StartOptions.options.longRetry` takes `null`, which the engine
// has always read as «off»: its type says so.

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { AiProviderError, AutopilotSession, LAST_ERROR_CODES, normalizeAutopilotState, parseAutopilotState, summarizeAutopilotState } = engine;

const STATE = "autopilot/state.json";
const FAST = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };
const BRIEF = { idea: "x", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 };

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

const down = (message = "openai m: HTTP 503 — overloaded") => new AiProviderError(message, 503, true, { transient: true });
/** A failure that says the same words every time and does not depend on the moment. */
const crashed = () => new AiProviderError("openai m: HTTP 500 — the node crashed", 500, true);
const conceptFails = (times, error = () => down()) => scripted((request, seen) => (request.label === "autopilot:concept" && seen < times ? error(seen) : undefined));

function newSession(store, ai, extra = {}) {
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0, random: () => 0.5, ...extra });
  session.subscribe((event) => events.push(event));
  return { session, events };
}

const runEnded = (events) => events.filter((event) => event.type === "run-ended");
const insights = (events, code) => events.filter((event) => event.type === "insight" && event.code === code);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition, what, timeoutMs = 8_000) {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) assert.fail(`Timed out waiting for ${what}.`);
    await sleep(4);
  }
}

// ─── The state says why «Retry later» stopped the run ───────────────────────

test("when the cycles of «Retry later» are used up, the state and the summary say so with the code longRetryExhausted, as the run-ended event does", async () => {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  const { session, events } = newSession(store, conceptFails(Number.POSITIVE_INFINITY, () => down("openai m: HTTP 503 — still down")));
  await session.start({ brief: BRIEF, options: { ...FAST, longRetry: { everyMinutes: 1, cycles: 2 } } });
  await session.waitForIdle();
  const state = parseAutopilotState(store.files.get(STATE));
  assert.equal(state.status, "error");
  assert.equal(runEnded(events).at(-1).code, "longRetryExhausted");
  assert.equal(state.lastError.code, "longRetryExhausted", "the saved state says it too");
  assert.match(state.lastError.message, /still down/, "next to the error that ended the run");
  const { summary } = await session.snapshot();
  assert.equal(summary.lastError.code, "longRetryExhausted", "and so does the summary a page opens after the run");
  assert.equal(summarizeAutopilotState(state).lastError.code, "longRetryExhausted", "also made from the file alone, as another device reads it");
  const last = events.filter((event) => event.type === "state").at(-1);
  assert.equal(last.state.lastError.code, "longRetryExhausted", "and the last state event of the stream, which a device that follows the run reads");
});

test("when «Retry later» is turned off while the run waits, the state and the summary say so with the code longRetryOff", async () => {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  const { session, events } = newSession(store, conceptFails(Number.POSITIVE_INFINITY, () => crashed()), { retryDelayMs: 40 });
  await session.start({ brief: BRIEF, options: { ...FAST, longRetry: { everyMinutes: 60, cycles: 3 } } });
  await waitFor(() => insights(events, "longRetryWait").length === 1, "the long wait");
  await session.updateOptions({ longRetry: null });
  await session.waitForIdle();
  const state = parseAutopilotState(store.files.get(STATE));
  assert.equal(state.status, "error");
  assert.equal(runEnded(events).at(-1).code, "longRetryOff");
  assert.equal(state.lastError.code, "longRetryOff");
  assert.match(state.lastError.message, /node crashed/);
  assert.equal((await session.snapshot()).summary.lastError.code, "longRetryOff");
});

test("a failure that «Retry later» did not stop has no code, and a run that goes on clears the error with its code", async () => {
  // «Retry later» is off: the run ends with the failure as it always did.
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  const { session } = newSession(store, conceptFails(Number.POSITIVE_INFINITY, () => crashed()));
  await session.start({ brief: BRIEF, options: FAST });
  await session.waitForIdle();
  const failed = parseAutopilotState(store.files.get(STATE));
  assert.equal(failed.status, "error");
  assert.match(failed.lastError.message, /node crashed/);
  assert.equal("code" in failed.lastError, false, "no code: nothing waited for the retries");
  assert.equal("code" in (await session.snapshot()).summary.lastError, false);

  // The same book, the cycles used up, and then a run that works: the error (and its code) is gone.
  const stopped = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  const first = newSession(stopped, conceptFails(Number.POSITIVE_INFINITY, () => down()));
  await first.session.start({ brief: BRIEF, options: { ...FAST, longRetry: { everyMinutes: 1, cycles: 1 } } });
  await first.session.waitForIdle();
  assert.equal(parseAutopilotState(stopped.files.get(STATE)).lastError.code, "longRetryExhausted");
  const second = newSession(stopped, createFakeAutopilotAi());
  await second.session.start({ brief: BRIEF, options: FAST });
  await second.session.waitForIdle();
  const done = parseAutopilotState(stopped.files.get(STATE));
  assert.equal(done.status, "completed");
  assert.equal(done.lastError, null);
});

// ─── Read tolerantly ────────────────────────────────────────────────────────

test("the code of the last error is read tolerantly: the two codes that end a run are kept, anything else is dropped, never made up", () => {
  assert.deepEqual([...LAST_ERROR_CODES], ["longRetryExhausted", "longRetryOff"]);
  const read = (code) => normalizeAutopilotState({ lastError: { message: "boom", at: "2026-01-01T00:00:00.000Z", code } }).lastError;
  assert.equal(read("longRetryExhausted").code, "longRetryExhausted");
  assert.equal(read("longRetryOff").code, "longRetryOff");
  assert.equal(read(" LongRetryOff ").code, undefined, "exactly as written: a code is not a word the author typed");
  for (const odd of ["takenOver", "someNewCode", "", 7, null, true, ["longRetryOff"], { code: "longRetryOff" }]) {
    assert.equal("code" in read(odd), false, `not a code: ${JSON.stringify(odd)}`);
    assert.equal(read(odd).message, "boom", "and the rest of the error is read as always");
  }
  // A file from before the code: an error with no code, as it always was.
  assert.deepEqual(normalizeAutopilotState({ lastError: { message: "boom", at: "2026-01-01T00:00:00.000Z", task: "concept" } }).lastError, { message: "boom", at: "2026-01-01T00:00:00.000Z", task: "concept" });
  // The code says nothing without an error: no message, no last error.
  assert.equal(normalizeAutopilotState({ lastError: { code: "longRetryOff" } }).lastError, null);
  // It keeps company with the kind and the detail the error already had, and the summary says all of them.
  const full = normalizeAutopilotState({ lastError: { message: "m", at: "2026-01-01T00:00:00.000Z", errorKind: "rate_limit", errorDetail: { status: 429 }, code: "longRetryExhausted", activityId: "act_1" } });
  assert.deepEqual([full.lastError.errorKind, full.lastError.code, full.lastError.activityId], ["rate_limit", "longRetryExhausted", "act_1"]);
  const summary = summarizeAutopilotState(full).lastError;
  assert.deepEqual([summary.kind, summary.detail, summary.code], ["rate_limit", { status: 429 }, "longRetryExhausted"]);
});

// ─── The type of the option ─────────────────────────────────────────────────

const declarations = fileURLToPath(new URL("../dist/index.d.ts", import.meta.url));

/** The problems TypeScript finds in `code`, written as a module that imports from the engine as a package does. */
function problemsOf(code) {
  const file = path.join(path.dirname(declarations), "..", "test", "type-check-input.ts");
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, skipLibCheck: true, noEmit: true, types: [] };
  const host = ts.createCompilerHost(options);
  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = (name) => name === file || fileExists.call(host, name);
  host.readFile = (name) => (name === file ? code : readFile.call(host, name));
  host.getSourceFile = (name, languageVersion, ...rest) => (name === file ? ts.createSourceFile(name, code, languageVersion, true, ts.ScriptKind.TS) : getSourceFile.call(host, name, languageVersion, ...rest));
  const program = ts.createProgram([file], { ...options, paths: { "narrarium-engine": [declarations] }, baseUrl: "/" }, host);
  return ts.getPreEmitDiagnostics(program).filter((diagnostic) => diagnostic.file?.fileName === file).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

test("StartOptions.options.longRetry accepts null, which turns «Retry later» off: the type says what the engine reads", { timeout: 120_000 }, () => {
  assert.deepEqual(problemsOf(`import type { StartOptions } from "narrarium-engine";\nexport const off: StartOptions = { options: { longRetry: null } };\nexport const on: StartOptions = { options: { longRetry: { everyMinutes: 5, cycles: "unlimited" } } };\nexport const none: StartOptions = { options: {} };\n`), []);
  // The check is a real one: the engine is found, and a value that is not a policy is still refused.
  const refused = problemsOf(`import type { StartOptions } from "narrarium-engine";\nexport const odd: StartOptions = { options: { longRetry: "yes" } };\n`);
  assert.ok(refused.some((problem) => /not assignable/.test(problem)), refused.join("\n"));
  assert.ok(!refused.some((problem) => /Cannot find module/.test(problem)));
});

test("a run started with longRetry: null runs with «Retry later» off, and turns off the policy the book had", async () => {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  const first = newSession(store, createFakeAutopilotAi());
  await first.session.configure({ brief: BRIEF, options: { ...FAST, longRetry: { everyMinutes: 5, cycles: 2 } } });
  assert.deepEqual(parseAutopilotState(store.files.get(STATE)).options.longRetry, { everyMinutes: 5, cycles: 2 });
  const second = newSession(store, conceptFails(Number.POSITIVE_INFINITY, () => down()));
  await second.session.start({ options: { ...FAST, longRetry: null } });
  await second.session.waitForIdle();
  const state = parseAutopilotState(store.files.get(STATE));
  assert.equal(state.options.longRetry, undefined, "off");
  assert.equal(state.status, "error");
  assert.equal("code" in state.lastError, false, "the failure ended the run as it does with «Retry later» off");
});
