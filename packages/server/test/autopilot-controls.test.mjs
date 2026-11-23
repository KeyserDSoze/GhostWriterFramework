import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { SERVER_FEATURE_AUTOPILOT_CONTROLS, serverSupportsAutopilotControls } from "narrarium-engine";
import * as testing from "../dist/testing.mjs";
import { until, withServer } from "./helpers.mjs";
import { finished, seededBook } from "./fake-provider.mjs";
import { FAST, HELD, STEPS, brief, fakeAi, holdingAi, startOf } from "./hold.mjs";

// The quick controls of the autopilot (S4): a pause at the end of the chapter and the way to take a pause back, the limits of one run, and the
// options that can change while a run goes on. The engine does the work; these tests are about what the server's routes accept, answer and show.

/** The wait is for the slowest system, not for a fast one: a run that git commits every step of takes longer on some. */
const held = (ai) => until(() => ai.isHeld(), 30_000);

/** Register a book, start it and wait until the AI is held in `HELD`: a step is in flight. */
async function startHeld(client, ai, bookId = "b", extra = {}, chapters = 2) {
  await seededBook(client, bookId, { chapters: 2 });
  await client.startAutopilot(bookId, startOf(chapters, extra));
  await held(ai);
}

/** Requests with full control of the body and of the headers, for what a typed client would never send. */
async function rawApi(server, scopes = ["read", "write", "run"]) {
  const { token } = await server.auth.issue("raw client", scopes);
  const call = async (method, route, body, headers = {}) => {
    const response = await fetch(`${server.url}${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined || typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, json, text, headers: response.headers };
  };
  call.token = token;
  return call;
}

/** A request that declares a body over any limit and sends none: the answer comes from the headers alone, and there is no body to race against it. */
function declareLarge(server, method, route, token, length = 3 * 1024 * 1024) {
  const target = new URL(server.url);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: target.hostname, port: target.port, path: route, method, agent: false, timeout: 15_000, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(length) } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        request.destroy();
        let json = null;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          json = null;
        }
        resolve({ status: response.statusCode, json });
      });
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
    request.flushHeaders();
  });
}

const pauseRoute = (bookId = "b") => `/api/v1/books/${bookId}/autopilot/pause`;
const startRoute = (bookId = "b") => `/api/v1/books/${bookId}/autopilot/start`;
const optionsRoute = (bookId = "b") => `/api/v1/books/${bookId}/autopilot/options`;
const stateFile = (server, bookId = "b") => path.join(server.data.bookDirectory(bookId), "autopilot", "state.json");
const readState = (server, bookId = "b") => readFile(stateFile(server, bookId), "utf8").catch(() => null);

/** The answer of a request that failed, as the typed client reports it. */
const refusal = (error) => ({ status: error.status, code: error.code, message: error.message });
const attempt = (action) => action().then(() => ({ status: 200 }), refusal);
const runEnded = async (client, bookId = "b") => (await client.events(bookId)).events.filter((event) => event.type === "run-ended");

/** Follow the live stream in the background; `stop()` ends it. Resolves once the server has said hello. */
async function followStream(client) {
  const controller = new AbortController();
  const messages = [];
  const following = client.stream((message) => messages.push(message), controller.signal).catch((error) => {
    if (error?.name !== "AbortError") throw error;
  });
  await until(() => messages.some((message) => message.event === "hello"));
  return {
    messages,
    stop: async () => {
      controller.abort();
      await following;
    },
  };
}
const stateEvents = (messages) => messages.filter((message) => message.event === "autopilot" && message.data.type === "state").map((message) => message.data.state);
const bookEvents = (messages) => messages.filter((message) => message.event === "book").map((message) => message.data);

// ---------------------------------------------------------------------------------------------
// S4-1.1: POST …/autopilot/pause
// ---------------------------------------------------------------------------------------------

test("S4-1: a pause at the end of the chapter lets chapter 1 finish, closes it and pauses there; the run can be resumed", async () => {
  const ai = holdingAi();
  try {
    await withServer(async (_server, client) => {
      await startHeld(client, ai);
      const answer = await client.pauseAutopilot("b", "after-chapter");
      assert.equal(answer.running, true, "the run goes on to the end of the chapter");
      assert.equal(answer.summary.pausePending, "after-chapter", "the answer says that a pause waits, and which");
      assert.equal((await client.autopilot("b")).summary.pausePending, "after-chapter", "a client that asks later is told as well");
      ai.release();
      const done = await finished(client, "b");
      assert.equal(done.state.status, "paused");
      assert.equal(done.state.message, "Chapter 1 completed: paused, as you asked.");
      assert.deepEqual(done.state.plan.chapters.map((chapter) => chapter.status), ["done", "planned"], "chapter 1 is closed and chapter 2 not started");
      assert.equal(done.summary.pausePending, null, "nothing waits any more");
      assert.deepEqual((await runEnded(client)).map((event) => event.code), ["chapterPause"], "the run says why it ended");
      assert.ok(!ai.calls.some((call) => /:2(\.|$)/.test(call.label)), "nothing of chapter 2 was asked of the AI");

      await client.startAutopilot("b");
      const resumed = await finished(client, "b");
      assert.equal(resumed.state.status, "completed", "the pause was for that run only");
      assert.equal(resumed.state.stats.tasks, STEPS(2), "and no step was done twice");
    }, { ai });
  } finally {
    ai.release();
  }
});

test("S4-1: `cancel` takes back the pause that waits (after the chapter or after the step) and the run goes on to the end", async () => {
  const ai = holdingAi();
  try {
    await withServer(async (_server, client) => {
      await startHeld(client, ai);
      assert.equal((await client.pauseAutopilot("b", "after-chapter")).summary.pausePending, "after-chapter");
      const cancelled = await client.pauseAutopilot("b", "cancel");
      assert.equal(cancelled.running, true);
      assert.equal(cancelled.summary.pausePending, null, "nothing waits after a cancel");
      assert.equal((await client.pauseAutopilot("b", "after-step")).summary.pausePending, "after-step");
      assert.equal((await client.pauseAutopilot("b", "cancel")).summary.pausePending, null, "a pause after the step is taken back as well");
      assert.equal((await client.pauseAutopilot("b", "cancel")).summary.pausePending, null, "a cancel when nothing waits changes nothing and is not an error");
      ai.release();
      const done = await finished(client, "b");
      assert.equal(done.state.status, "completed", "the run did not pause");
      assert.equal(done.state.stats.tasks, STEPS(2));
      assert.deepEqual((await runEnded(client)).map((event) => event.code ?? null), [null]);
    }, { ai });
  } finally {
    ai.release();
  }
});

test("S4-1: no mode means `after-step`; the stricter pause stays when a milder one follows", async () => {
  const ai = holdingAi();
  try {
    await withServer(async (server, client) => {
      await startHeld(client, ai);
      const api = await rawApi(server);
      const bare = await api("POST", pauseRoute());
      assert.equal(bare.status, 200, "a request without a body is a pause after the step, as it always was");
      assert.equal(bare.json.summary.pausePending, "after-step");
      assert.equal((await api("POST", pauseRoute(), "{}")).json.summary.pausePending, "after-step");
      assert.equal((await client.pauseAutopilot("b", "after-chapter")).summary.pausePending, "after-step", "a pause after the chapter does not weaken the one after the step");
      ai.release();
      const done = await finished(client, "b");
      assert.equal(done.state.status, "paused");
      assert.notEqual(done.state.plan.chapters[0].status, "done", "the pause came before the end of chapter 1");
      assert.equal(done.state.plan.chapters[1].status, "planned");
    }, { ai });
  } finally {
    ai.release();
  }
});

test("S4-1: `now` abandons the request in flight and nothing waits afterwards", async () => {
  const ai = holdingAi();
  try {
    await withServer(async (_server, client) => {
      await startHeld(client, ai);
      const answer = await client.pauseAutopilot("b", "now");
      assert.equal(answer.summary.pausePending, null, "a pause now is over at once: nothing waits for it");
      const done = await finished(client, "b");
      assert.equal(done.state.status, "paused");
      assert.equal(ai.calls.filter((call) => call.label === HELD).length, 0, "the request in flight was abandoned, not answered");
    }, { ai });
  } finally {
    ai.release();
  }
});

const BAD_MODES = ["", " now", "NOW", "After-Chapter", "after_chapter", "cancel ", "stop", "resume", 5, 0, true, false, null, [], {}, ["now"], { mode: "now" }];

test("S4-1: a mode that is none of the four is a 400 invalid_request that names them, and pauses nothing", async () => {
  const ai = holdingAi();
  try {
    await withServer(async (server, client) => {
      await startHeld(client, ai);
      const api = await rawApi(server);
      const before = await readState(server);
      for (const mode of BAD_MODES) {
        const answer = await api("POST", pauseRoute(), { mode });
        assert.equal(answer.status, 400, JSON.stringify(mode));
        assert.equal(answer.json.code, "invalid_request", JSON.stringify(mode));
        for (const word of ["now", "after-step", "after-chapter", "cancel"]) assert.match(answer.json.message, new RegExp(word), `the message lists ${word}`);
      }
      const snapshot = await client.autopilot("b");
      assert.equal(snapshot.running, true, "the run was not touched");
      assert.equal(snapshot.summary.pausePending, null, "and no pause waits");
      assert.equal(await readState(server), before, "nothing was written");
      ai.release();
      assert.equal((await finished(client, "b")).state.status, "completed", "the run goes on as if nothing had happened");
    }, { ai });
  } finally {
    ai.release();
  }
});

test("S4-1: with no run every mode is a quiet 200 that creates no state, a bad mode is still a 400, and stopping is not refused while the server waits for an update", async () => {
  await withServer(async (server, client) => {
    await seededBook(client, "b", { chapters: 2 });
    for (const mode of ["now", "after-step", "after-chapter", "cancel"]) {
      const answer = await client.pauseAutopilot("b", mode);
      assert.equal(answer.running, false, mode);
      assert.equal(answer.state, null, `${mode} writes nothing to a book without a state`);
    }
    assert.equal(await readState(server), null);
    const bad = await attempt(() => client.pauseAutopilot("b", "later"));
    assert.deepEqual([bad.status, bad.code], [400, "invalid_request"]);
    assert.equal((await attempt(() => client.pauseAutopilot("nope", "now"))).status, 404, "a book that is not registered");

    await server.books.requestUpdate(async () => undefined);
    assert.equal((await client.pauseAutopilot("b", "after-chapter")).running, false);
  });
});

// ---------------------------------------------------------------------------------------------
// S4-1.2: POST …/autopilot/start with `limits`
// ---------------------------------------------------------------------------------------------

test("S4-1: `limits.steps` pauses the run after that many steps; each start counts its own steps and nothing of it is saved", async () => {
  await withServer(async (server, client) => {
    await seededBook(client, "b", { chapters: 2 });
    for (const done of [1, 2, 3]) {
      await client.startAutopilot("b", done === 1 ? startOf(2, { limits: { steps: 1 } }) : { limits: { steps: 1 } });
      const snapshot = await finished(client, "b");
      assert.equal(snapshot.state.status, "paused", `after start ${done}`);
      assert.equal(snapshot.state.message, "Step done as requested: paused.");
      assert.equal(snapshot.state.stats.tasks, done, "each start did one step: the count begins again with every run");
    }
    assert.deepEqual((await runEnded(client)).map((event) => event.code), ["stepLimit", "stepLimit", "stepLimit"]);
    assert.ok(!/limits/.test(await readState(server)), "the limits are for the run, not for the book");

    await client.startAutopilot("b", { limits: { steps: 2 } });
    assert.equal((await finished(client, "b")).state.message, "2 steps done as requested: paused.");
    await client.startAutopilot("b");
    const complete = await finished(client, "b");
    assert.equal(complete.state.status, "completed", "a start without limits runs on: the earlier ones are forgotten");
    assert.equal(complete.state.stats.tasks, STEPS(2));
  }, { ai: fakeAi(2) });
});

test("S4-1: `limits.chapters` pauses the run after that many chapters; the next start is not limited", async () => {
  await withServer(async (_server, client) => {
    await seededBook(client, "b", { chapters: 2 });
    await client.startAutopilot("b", startOf(2, { limits: { chapters: 1 } }));
    const first = await finished(client, "b");
    assert.equal(first.state.status, "paused");
    assert.equal(first.state.message, "1 chapter completed in this session.");
    assert.deepEqual(first.state.plan.chapters.map((chapter) => chapter.status), ["done", "planned"]);
    assert.deepEqual((await runEnded(client)).map((event) => event.code), ["chapterLimit"]);
    await client.startAutopilot("b");
    const complete = await finished(client, "b");
    assert.equal(complete.state.status, "completed");
    assert.deepEqual(complete.state.plan.chapters.map((chapter) => chapter.status), ["done", "done"]);
  }, { ai: fakeAi(2) });
});

test("S4-1: the limits of the run in progress, and how far it got, are in the summary until the run ends", async () => {
  const ai = holdingAi();
  try {
    await withServer(async (_server, client) => {
      await seededBook(client, "b", { chapters: 2 });
      const started = await client.startAutopilot("b", startOf(2, { limits: { steps: 50, chapters: 3 } }));
      assert.ok(started.summary, "the answer of a start carries the summary");
      await held(ai);
      const snapshot = await client.autopilot("b");
      const saved = snapshot.activities.filter((activity) => activity.status === "succeeded").length;
      assert.ok(saved >= 4, "the steps before the one in flight are saved");
      assert.deepEqual(snapshot.summary.limits, { steps: 50, chapters: 3, stepsDone: saved, chaptersDone: 0 });
      ai.release();
      const done = await finished(client, "b");
      assert.equal(done.state.status, "completed", "limits that are not reached stop nothing");
      assert.equal(done.summary.limits, null, "a run that is over has none");
    }, { ai });
  } finally {
    ai.release();
  }
});

test("S4-1: `limits` that is not an object is a 400 invalid_request before anything starts: no run, no state, no AI call", async () => {
  const ai = fakeAi();
  await withServer(async (server, client) => {
    await seededBook(client, "b", { chapters: 2 });
    const api = await rawApi(server);
    for (const limits of [null, [], [1], [{ steps: 1 }], 5, 0, "steps", "{}", true, false]) {
      const answer = await api("POST", startRoute(), { brief: brief(2), options: FAST, limits });
      assert.equal(answer.status, 400, JSON.stringify(limits));
      assert.equal(answer.json.code, "invalid_request", JSON.stringify(limits));
      assert.match(answer.json.message, /limits/, "it says which field is wrong");
    }
    const snapshot = await client.autopilot("b");
    assert.equal(snapshot.running, false);
    assert.equal(snapshot.state, null, "no state was created by any of them");
    assert.equal(await readState(server), null);
    assert.equal(ai.calls.length, 0, "and the AI was not asked anything");
    assert.equal(server.books.runningCount(), 0);
  }, { ai });
});

test("S4-1: a number that is not a whole number above zero is no limit, and is not an error either", async () => {
  const variants = [{ steps: 0 }, { steps: -3 }, { steps: 1.5 }, { steps: "2" }, { steps: null }, { steps: true }, { chapters: 0 }, { chapters: -1 }, { steps: 1e21 }, {}];
  await withServer(async (_server, client) => {
    for (const [index, limits] of variants.entries()) {
      const bookId = `u${index}`;
      await seededBook(client, bookId, { chapters: 1 });
      // The run stops by itself when the plan is ready (three steps): a limit of one step would have stopped it after the first.
      await client.startAutopilot(bookId, { brief: brief(1), options: { ...FAST, pauseAfterPlan: true }, limits });
      const snapshot = await finished(client, bookId);
      assert.equal(snapshot.state.status, "paused", JSON.stringify(limits));
      assert.match(snapshot.state.message, /The plan is ready/, `${JSON.stringify(limits)}: the run was not cut short`);
      assert.equal(snapshot.state.stats.tasks, 3, JSON.stringify(limits));
    }
  }, { ai: fakeAi(1) });
});

test("S4-1: a limit that is large but real is kept, shown, never reached, and the run completes", async () => {
  await withServer(async (_server, client) => {
    await seededBook(client, "b", { chapters: 1 });
    await client.startAutopilot("b", startOf(1, { limits: { steps: Number.MAX_SAFE_INTEGER, chapters: 9_007_199_254_740 } }));
    const done = await finished(client, "b");
    assert.equal(done.state.status, "completed");
    assert.equal(done.state.stats.tasks, STEPS(1));
  }, { ai: fakeAi(1) });
});

// ---------------------------------------------------------------------------------------------
// S4-1.3: PUT …/autopilot/options
// ---------------------------------------------------------------------------------------------

test("S4-1: PUT …/autopilot/options changes where the book is published while a run goes on; the step in flight is not repeated", async () => {
  const ai = holdingAi();
  try {
    await withServer(async (_server, client) => {
      await startHeld(client, ai);
      const before = await client.autopilot("b");
      assert.equal(before.summary.publish, "step", "a server publishes after every step unless the author chose otherwise");
      const chapter = await client.updateAutopilotOptions("b", { publishEvery: "chapter" });
      assert.equal(chapter.running, true, "the run goes on");
      assert.equal(chapter.state.options.publishEvery, "chapter", "the answer is the snapshot, with the choice saved");
      assert.equal(chapter.summary.publish, "chapter");
      assert.equal((await client.updateOptions("b", { publishEvery: "off" })).summary.publish, "off", "`updateOptions` is the same call");
      assert.equal((await client.autopilot("b")).summary.publish, "off", "a client that asks later sees it");
      const handedBack = await client.updateAutopilotOptions("b", { publishEvery: null });
      assert.equal(handedBack.summary.publish, "step", "`null` takes the choice back: the server decides again");
      assert.equal(handedBack.state.options.publishEvery, undefined);
      const both = await client.updateAutopilotOptions("b", { publishEvery: "chapter", pauseAfterEachChapter: true });
      assert.equal(both.state.options.publishEvery, "chapter", "both settings can come in one request");
      assert.equal(both.state.options.pauseAfterEachChapter, true);
      ai.release();
      const done = await finished(client, "b");
      assert.equal(done.state.status, "paused");
      assert.equal(done.state.message, "Chapter 1 approved: read it and resume.", "the run read the new setting at the end of the chapter");
      assert.deepEqual(done.state.plan.chapters.map((entry) => entry.status), ["done", "planned"]);
      assert.equal(ai.calls.filter((call) => call.label === HELD).length, 1, "the step that was running when the options changed was not repeated");
      const events = (await client.events("b")).events;
      assert.ok(!events.some((event) => event.type === "insight" && event.code === "conflictRetry"), "and nothing conflicted");
    }, { ai });
  } finally {
    ai.release();
  }
});

test("S4-1: on a book with no autopilot state the options route creates it, as `configure` does", async () => {
  await withServer(async (server, client) => {
    await seededBook(client, "b", { chapters: 2 });
    await seededBook(client, "c");
    assert.equal(await readState(server, "b"), null);
    const answer = await client.updateAutopilotOptions("b", { publishEvery: "off" });
    assert.equal(answer.running, false);
    assert.equal(answer.state.status, "idle");
    assert.equal(answer.state.options.publishEvery, "off");
    assert.equal(answer.summary.publish, "off");
    assert.equal(JSON.parse(await readState(server, "b")).options.publishEvery, "off", "it is saved in the book");

    const configured = await client.configureAutopilot("c", { options: { pauseAfterPlan: false } });
    assert.equal(configured.state.status, answer.state.status, "the same kind of state as the one `configure` creates");
    assert.equal(configured.state.phase, answer.state.phase);
    const later = await client.updateAutopilotOptions("b", { pauseAfterEachChapter: true });
    assert.equal(later.state.options.publishEvery, "off", "a later change keeps what was chosen");
    assert.equal(later.state.options.pauseAfterEachChapter, true);
    const unchanged = await client.updateAutopilotOptions("b", { publishEvery: "off" });
    assert.equal(unchanged.state.version, later.state.version, "a request that changes nothing writes nothing");
  });
});

const BAD_OPTIONS = [
  {},
  { publishEvery: "weekly" },
  { publishEvery: "" },
  { publishEvery: "OFF" },
  { publishEvery: " off" },
  { publishEvery: 0 },
  { publishEvery: 1 },
  { publishEvery: true },
  { publishEvery: false },
  { publishEvery: [] },
  { publishEvery: ["off"] },
  { publishEvery: {} },
  { pauseAfterEachChapter: "true" },
  { pauseAfterEachChapter: 1 },
  { pauseAfterEachChapter: 0 },
  { pauseAfterEachChapter: null },
  { pauseAfterEachChapter: [] },
  { publishEvery: "off", pauseAfterEachChapter: "yes" },
  { publishEvery: "off", readers: false },
  { publishEvery: "off", extra: 1 },
  { readers: false },
  { chaptersPerRun: 2 },
  { budgetLimit: 1 },
  { syncAfterChapter: false },
  { options: { publishEvery: "off" } },
  { brief: { idea: "x" } },
  { limits: { steps: 1 } },
];

test("S4-1: the options route knows two settings; anything else is a 400 invalid_request that lists them, and nothing of the request is applied", async () => {
  await withServer(async (server, client) => {
    await seededBook(client, "b", { chapters: 2 });
    await client.updateAutopilotOptions("b", { publishEvery: "chapter" });
    const api = await rawApi(server);
    const before = await readState(server);
    for (const body of BAD_OPTIONS) {
      const answer = await api("PUT", optionsRoute(), body);
      assert.equal(answer.status, 400, JSON.stringify(body));
      assert.equal(answer.json.code, "invalid_request", JSON.stringify(body));
      assert.match(answer.json.message, /publishEvery/, "the message lists the settings that can change");
      assert.match(answer.json.message, /pauseAfterEachChapter/);
      assert.equal(await readState(server), before, `${JSON.stringify(body)} changed nothing, not even the part of it that was fine`);
    }
    const typed = await attempt(() => client.updateAutopilotOptions("b", { publishEvery: "bogus" }));
    assert.deepEqual([typed.status, typed.code], [400, "invalid_request"], "the typed client reports it the same way");
  });
});

test("S4-1: while a run goes on any other option is a 400 as well (not a 409), and the run is not disturbed", async () => {
  const ai = holdingAi();
  try {
    await withServer(async (server, client) => {
      await startHeld(client, ai);
      const api = await rawApi(server);
      const before = await readState(server);
      for (const body of [{ readers: true }, { publishEvery: "off", chaptersPerRun: 1 }, { budgetTokens: 10 }]) {
        const answer = await api("PUT", optionsRoute(), body);
        assert.equal(answer.status, 400, JSON.stringify(body));
        assert.equal(answer.json.code, "invalid_request");
      }
      assert.equal(await readState(server), before);
      assert.equal((await client.autopilot("b")).running, true);
      ai.release();
      assert.equal((await finished(client, "b")).state.status, "completed");
    }, { ai });
  } finally {
    ai.release();
  }
});

test("S4-1: the options route is for clients that may run the autopilot, from an origin that is allowed; an unknown book is a 404", async () => {
  await withServer(async (server, client) => {
    await seededBook(client, "b", { chapters: 2 });
    const body = { publishEvery: "off" };
    const anonymous = await fetch(`${server.url}${optionsRoute()}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(anonymous.status, 401);
    for (const scopes of [["read"], ["read", "write"], ["write"]]) {
      const api = await rawApi(server, scopes);
      const refused = await api("PUT", optionsRoute(), body);
      assert.equal(refused.status, 403, scopes.join(","));
      assert.equal(refused.json.code, "scope");
      assert.equal((await api("POST", pauseRoute(), { mode: "now" })).status, 403, "a pause is for the same clients");
    }
    assert.equal(await readState(server), null, "none of them wrote anything");
    const runner = await rawApi(server, ["read", "run"]);
    assert.equal((await runner("PUT", optionsRoute(), body)).status, 200, "the run scope is what it takes");
    assert.equal(JSON.parse(await readState(server)).options.publishEvery, "off");

    const api = await rawApi(server);
    const foreign = await api("PUT", optionsRoute(), { publishEvery: "step" }, { origin: "https://evil.example" });
    assert.equal(foreign.status, 403, "a page from another origin cannot change it");
    assert.equal(JSON.parse(await readState(server)).options.publishEvery, "off");
    const allowed = await api("PUT", optionsRoute(), { publishEvery: "step" }, { origin: "https://narrarium.net" });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://narrarium.net");
    const preflight = await fetch(`${server.url}${optionsRoute()}`, { method: "OPTIONS", headers: { origin: "https://narrarium.net", "access-control-request-method": "PUT", "access-control-request-headers": "authorization, content-type" } });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-methods"), /PUT/, "the browser may send it");

    const missing = await api("PUT", optionsRoute("nope"), body);
    assert.deepEqual([missing.status, missing.json.code], [404, "book_not_found"]);
    assert.equal((await api("POST", optionsRoute(), body)).status, 404, "PUT is the route, POST is not");
  });
});

test("S4-1: the options route reads its body as its neighbours do: JSON only, one object, small", async () => {
  await withServer(async (server, client) => {
    await seededBook(client, "b", { chapters: 2 });
    const api = await rawApi(server);
    const plain = await api("PUT", optionsRoute(), JSON.stringify({ publishEvery: "off" }), { "content-type": "text/plain" });
    assert.deepEqual([plain.status, plain.json.code], [415, "unsupported_media_type"]);
    const broken = await api("PUT", optionsRoute(), '{"publishEvery":');
    assert.deepEqual([broken.status, broken.json.code], [400, "invalid_json"]);
    for (const body of ["[]", "[1]", "5", '"off"', "true"]) {
      const answer = await api("PUT", optionsRoute(), body);
      assert.deepEqual([answer.status, answer.json.code], [400, "invalid_request"], body);
    }
    assert.equal((await api("PUT", optionsRoute(), '{"publishEvery":"off","__proto__":{"x":1}}')).status, 400);
    const large = await declareLarge(server, "PUT", optionsRoute(), api.token);
    assert.deepEqual([large.status, large.json.code], [413, "payload_too_large"]);
    assert.equal(await readState(server), null, "none of them wrote anything");
  });
});

test("S4-1: a state file that cannot be read is a 409 state_corrupt, a commit that lost a race 409 conflict, an update about to start 503; none writes anything", async () => {
  await withServer(async (server, client) => {
    await seededBook(client, "b", { chapters: 2 });
    await seededBook(client, "c");
    const api = await rawApi(server);
    await client.commitFiles("b", [{ path: "autopilot/state.json", content: "{ this is not a state" }], "damaged");
    const corrupt = await api("PUT", optionsRoute("b"), { publishEvery: "off" });
    assert.deepEqual([corrupt.status, corrupt.json.code], [409, "state_corrupt"]);
    assert.equal(await readState(server, "b"), "{ this is not a state", "the damaged file is left as it is for the author to see");
    assert.equal((await api("POST", pauseRoute("b"), { mode: "after-chapter" })).status, 200, "a pause does not read the state: it is not refused for it");

    const original = testing.FileBookStore.prototype.commit;
    let attempts = 0;
    testing.FileBookStore.prototype.commit = async function () {
      attempts += 1;
      throw Object.assign(new Error("The book changed in the meantime."), { name: "BookConflictError" });
    };
    try {
      const conflict = await api("PUT", optionsRoute("c"), { publishEvery: "off" });
      assert.deepEqual([conflict.status, conflict.json.code], [409, "conflict"]);
      assert.ok(attempts >= 1, "it tried");
    } finally {
      testing.FileBookStore.prototype.commit = original;
    }
    assert.equal(await readState(server, "c"), null, "nothing was written");
    assert.equal((await api("PUT", optionsRoute("c"), { publishEvery: "off" })).status, 200, "and the same request goes through once the conflict is gone");

    await server.books.requestUpdate(async () => undefined);
    const maintenance = await api("PUT", optionsRoute("c"), { publishEvery: "step" });
    assert.deepEqual([maintenance.status, maintenance.json.code], [503, "maintenance"]);
    assert.equal(JSON.parse(await readState(server, "c")).options.publishEvery, "off");
  });
});

// ---------------------------------------------------------------------------------------------
// S4-3: what a client sees
// ---------------------------------------------------------------------------------------------

test("S4-3: `info.features` announces `autopilot-controls`: after-chapter, cancel, limits and the options route are understood", async () => {
  await withServer(async (server) => {
    assert.equal(SERVER_FEATURE_AUTOPILOT_CONTROLS, "autopilot-controls");
    const info = await (await fetch(`${server.url}/api/v1/info`)).json();
    assert.ok(info.features.includes(SERVER_FEATURE_AUTOPILOT_CONTROLS), JSON.stringify(info.features));
    assert.equal(serverSupportsAutopilotControls(info), true);
    for (const feature of ["autopilot", "director", "sync", "pairing", "updates", "spend"]) assert.ok(info.features.includes(feature), `${feature} is still announced`);
    assert.equal(new Set(info.features).size, info.features.length, "each feature once");
  });
});

test("S4-3: the list of books says where a book is published, like the summary of its autopilot: after every step, for a server, unless the author chose", async () => {
  await withServer(async (_server, client) => {
    await seededBook(client, "b", { chapters: 2 });
    assert.equal((await client.listBooks())[0].autopilot, null, "a book that never ran has no summary");
    await client.configureAutopilot("b", { options: { pauseAfterPlan: false } });
    const idle = (await client.listBooks())[0].autopilot;
    assert.equal(idle.publish, "step", "the option of the browser (`syncAfterChapter`) does not decide for a server");
    assert.equal(idle.pausePending, null);
    assert.equal(idle.limits, null);
    assert.deepEqual(idle, (await client.autopilot("b")).summary, "the list and the snapshot say the same");

    await client.configureAutopilot("b", { options: { publishEvery: "off" } });
    assert.equal((await client.listBooks())[0].autopilot.publish, "off", "what the author chose");
    assert.equal((await client.autopilot("b")).summary.publish, "off");
  });
});

test("S4-3: the list of books shows the pause that waits and the limits of the run while it goes on", async () => {
  const ai = holdingAi();
  try {
    await withServer(async (_server, client) => {
      await seededBook(client, "b", { chapters: 2 });
      await client.startAutopilot("b", startOf(2, { limits: { steps: 40, chapters: 1 } }));
      await held(ai);
      await client.pauseAutopilot("b", "after-chapter");
      const live = (await client.listBooks())[0].autopilot;
      assert.equal(live.pausePending, "after-chapter");
      assert.equal(live.publish, "step");
      assert.equal(live.limits.steps, 40);
      assert.equal(live.limits.chapters, 1);
      assert.equal(typeof live.limits.stepsDone, "number");
      assert.deepEqual(live, (await client.autopilot("b")).summary, "the two say the same");
      ai.release();
      await finished(client, "b");
      const over = (await client.listBooks())[0].autopilot;
      assert.equal(over.pausePending, null);
      assert.equal(over.limits, null);
    }, { ai });
  } finally {
    ai.release();
  }
});

test("S4-3: the live stream says it when a pause is asked or taken back, when the options change and what the run is limited to", async () => {
  const ai = holdingAi();
  try {
    await withServer(async (_server, client) => {
      await seededBook(client, "b", { chapters: 2 });
      const stream = await followStream(client);
      try {
        await client.startAutopilot("b", startOf(2, { limits: { steps: 30 } }));
        await held(ai);
        assert.ok(stateEvents(stream.messages).some((state) => state.limits?.steps === 30 && state.limits.stepsDone >= 0), "the limits of the run are in its state events");
        assert.ok(stateEvents(stream.messages).every((state) => state.publish === "step"), "every state event says where the book is published");

        await client.pauseAutopilot("b", "after-chapter");
        await until(() => stateEvents(stream.messages).some((state) => state.pausePending === "after-chapter"));
        await until(() => bookEvents(stream.messages).some((summary) => summary.autopilot?.pausePending === "after-chapter"));
        await client.pauseAutopilot("b", "cancel");
        await until(() => stateEvents(stream.messages).at(-1)?.pausePending === null);
        await client.updateAutopilotOptions("b", { publishEvery: "off" });
        await until(() => stateEvents(stream.messages).at(-1)?.publish === "off");
        await until(() => bookEvents(stream.messages).at(-1)?.autopilot?.publish === "off");
        ai.release();
        await finished(client, "b");
        await until(() => stateEvents(stream.messages).at(-1)?.limits === null);
        assert.equal(stateEvents(stream.messages).at(-1).publish, "off");
      } finally {
        await stream.stop();
      }
    }, { ai });
  } finally {
    ai.release();
  }
});

// ---------------------------------------------------------------------------------------------
// S4-3: what the new routes do with bodies nobody sent them on purpose
// ---------------------------------------------------------------------------------------------

/** Not JSON, or not an object, or an object with a key that no route takes. */
const GARBAGE = [
  "[]", "[1,2,3]", "[[]]", "5", "-1", "0", "1e999", '"x"', '""', "true", "false", "{", "}", "{]", '{"a":', '{"a":1,}', "'single'", "nul", "undefined", "NaN", "\u0000",
  "{}garbage", "{} {}", '{"mode":}', '{"mode":"now"',
  '{"__proto__":{"polluted":true}}', '{"constructor":{"prototype":{"polluted":true}}}', '{"prototype":1}', '{"mode":"now","__proto__":{}}',
  `{"limits":${"[".repeat(5000)}${"]".repeat(5000)}}`, '{"limits":null}', '{"limits":[]}', '{"limits":5}', '{"limits":"{}"}',
];
/** An empty object, however it is written: what a route takes for "nothing said". */
const EMPTY = ["null", "{}", "\ufeff{}"];
/** Objects that are JSON and that mean nothing, or something wrong, to a route. */
const ODD_OBJECTS = [
  '{"mode":{"a":1}}', '{"mode":[1,2]}', '{"mode":null}', '{"publishEvery":{"a":1}}', '{"pauseAfterEachChapter":{"a":1}}',
  `{"mode":${"9".repeat(400)}}`, `{"mode":"${"x".repeat(200_000)}"}`, `{"publishEvery":"${"y".repeat(100_000)}"}`,
];

/** Whatever was sent, the answer is a refusal that says what is wrong, in the server's own shape: never an internal error. */
function assertCivil(answer, label) {
  assert.ok(answer.status < 500, `${label}: ${answer.status} ${answer.text.slice(0, 200)}`);
  if (answer.status >= 400) {
    assert.equal(typeof answer.json?.code, "string", `${label}: ${answer.text.slice(0, 200)}`);
    assert.equal(typeof answer.json?.message, "string", label);
    assert.notEqual(answer.json.code, "internal", label);
    assert.ok(answer.json.message.length < 600, `${label}: the message is short`);
  }
}

test("S4-3: bodies that nobody meant to send never make the new routes fail inside: every answer is a 2xx or a clear 4xx, and nothing changes", async () => {
  const lines = [];
  await withServer(async (server, client) => {
    await seededBook(client, "b", { chapters: 2 });
    await seededBook(client, "c");
    await client.updateAutopilotOptions("c", { publishEvery: "chapter" });
    const api = await rawApi(server);
    const stateOfC = await readState(server, "c");

    for (const body of [...GARBAGE, ...EMPTY, ...ODD_OBJECTS]) {
      const label = JSON.stringify(body.slice(0, 50));
      assertCivil(await api("POST", pauseRoute("b"), body), `pause ${label}`);
      const options = await api("PUT", optionsRoute("c"), body);
      assertCivil(options, `options ${label}`);
      assert.ok(options.status >= 400, `options ${label}: nothing in it is a setting, so it is refused`);
    }
    assert.equal(await readState(server, "c"), stateOfC, "no body changed the options of the book");
    assert.equal(await readState(server, "b"), null, "and a pause that was not a pause created no state");

    // A start is an object that may carry a brief, options and limits: only what is not one, or carries bad limits, is refused.
    for (const body of GARBAGE) {
      const label = JSON.stringify(body.slice(0, 50));
      const answer = await api("POST", startRoute("b"), body);
      assertCivil(answer, `start ${label}`);
      assert.ok(answer.status >= 400, `start ${label}: it is not a start`);
    }
    assert.equal((await client.autopilot("b")).running, false, "none of them started the autopilot");
    assert.equal(await readState(server, "b"), null, "or left a state behind");
    const internal = lines.filter((line) => /^Error /.test(line));
    assert.deepEqual(internal, [], "no internal error was logged");
  }, { log: (line) => lines.push(line) });
});

test("S4-3: a burst of valid and invalid control requests while a run goes on leaves the run, its book and the server healthy", async () => {
  const ai = holdingAi();
  try {
    await withServer(async (server, client) => {
      await startHeld(client, ai);
      const api = await rawApi(server);
      const requests = [];
      for (let index = 0; index < 10; index += 1) {
        requests.push(api("POST", pauseRoute(), { mode: index % 2 ? "after-chapter" : "cancel" }));
        requests.push(api("PUT", optionsRoute(), { publishEvery: ["off", "chapter", "step", null][index % 4] }));
        requests.push(api("PUT", optionsRoute(), { publishEvery: "nonsense" }));
        requests.push(api("POST", pauseRoute(), { mode: "nonsense" }));
      }
      const answers = await Promise.all(requests);
      for (const answer of answers) assertCivil(answer, "burst");
      const bad = answers.filter((answer) => answer.status >= 400);
      assert.ok(bad.every((answer) => ["invalid_request", "conflict"].includes(answer.json.code)), "a refusal is a bad request, or an honest conflict between writers of the same file");
      assert.equal(bad.filter((answer) => answer.json.code === "invalid_request").length, 20, "every request that was wrong was refused as such");
      await client.pauseAutopilot("b", "cancel");
      await client.updateAutopilotOptions("b", { publishEvery: null });
      ai.release();
      const done = await finished(client, "b");
      assert.equal(done.state.status, "completed");
      assert.equal(done.state.stats.tasks, STEPS(2));
      assert.equal(ai.calls.filter((call) => call.label === HELD).length, 1, "the step that was held ran once");
    }, { ai });
  } finally {
    ai.release();
  }
});
