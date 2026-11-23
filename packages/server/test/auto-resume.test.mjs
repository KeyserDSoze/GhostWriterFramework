import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NarrariumServerClient, SERVER_FEATURE_AUTOPILOT_AUTO_RESUME, serverSupportsAutopilotAutoResume } from "narrarium-engine";
import { createFakeAutopilotAi } from "narrarium-engine/testing";
import { startNarrariumServer } from "../dist/testing.mjs";
import { noRelease, until, withServer } from "./helpers.mjs";
import { seededBook } from "./fake-provider.mjs";
import { FAST, HELD, brief, holdingAi } from "./hold.mjs";
import { rawApi } from "./api-helpers.mjs";
import { enableMcp, issueToken, mcpClient } from "./mcp-helpers.mjs";

// «Resume after a restart» (`options.resumeAfterRestart`): the server's stop pauses every run with its own word in the state, and a server that starts again
// resumes the runs of the books whose author asked for it, one at a time, at most three times a day each. Every test stops and starts a real server on the
// same data folder, as a restart does; the AI holds the run in a step, so that it is still going on when the server stops.

const ON = { ...FAST, resumeAfterRestart: true };
const temporary = () => mkdtemp(path.join(os.tmpdir(), "narrarium-auto-resume-"));
const remove = (dataDir) => rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

/** Start a server on `dataDir`, with a client of every permission a start needs; `lines` is what it logged. */
async function boot(dataDir, extra = {}) {
  const lines = [];
  const ai = "ai" in extra ? extra.ai : holdingAi();
  const server = await startNarrariumServer({
    dataDir, port: 0, adminPort: 0, supervised: false, checkRelease: noRelease, tunnel: { findBinary: () => undefined, detectOtherConnectors: async () => [] },
    autoResumeGapMs: 0, log: (line) => lines.push(line), ...extra, ai,
  });
  const { token } = await server.auth.issue("test client", ["read", "write", "run"]);
  return { server, ai, lines, client: new NarrariumServerClient({ baseUrl: server.url, token }) };
}

const stateFile = (dataDir, bookId = "b") => path.join(dataDir, "books", bookId, "repo", "autopilot", "state.json");
const readState = async (dataDir, bookId = "b") => JSON.parse(await readFile(stateFile(dataDir, bookId), "utf8"));
const ledgerFile = (dataDir) => path.join(dataDir, "private", "auto-resume.json");
const readLedger = async (dataDir) => JSON.parse(await readFile(ledgerFile(dataDir), "utf8"));
const exists = (file) => readFile(file).then(() => true, () => false);
const autoResumes = async (dataDir) => (await readFile(path.join(dataDir, "admin-log.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.action === "run.autoResume");
const insightsOf = (server, bookId, code) => server.books.get(bookId).session.recentEvents().filter((event) => event.type === "insight" && event.code === code);

/** An AI that holds every request until the run abandons it (one abandoned before it was asked ends at once): the runs it serves stay in their first step until the server stops them. */
function blockingAi() {
  const base = createFakeAutopilotAi({ chapters: 2, scenes: 1, reviewVerdict: () => "approve" });
  let held = 0;
  return {
    calls: base.calls,
    held: () => held,
    complete: (request) => new Promise((_resolve, reject) => {
      const { signal } = request;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      held += 1;
      signal?.addEventListener("abort", () => {
        held -= 1;
        reject(signal.reason);
      }, { once: true });
    }),
  };
}

/** A server on `dataDir` where the books `ids` run with «Resume after a restart» on, held in a step, and stop with the server: their state says so. */
async function stoppedWhileRunning(dataDir, ids = ["b"], options = ON) {
  const { server, client, ai } = await boot(dataDir, { ai: blockingAi() });
  for (const id of ids) {
    await seededBook(client, id);
    await client.startAutopilot(id, { brief: brief(2), options });
  }
  await until(() => ai.held() === ids.length);
  await server.close();
  for (const id of ids) {
    const state = await readState(dataDir, id);
    assert.deepEqual([state.status, state.stoppedBy, state.message], ["paused", "server-shutdown", "Paused because the server stopped."], `${id} was paused by the server's stop`);
  }
}

test("R1: the server's stop pauses a run with its own word; started again, the server resumes it by itself, once, twice, three times a day, and the fourth time the run waits for the author with the reason", async () => {
  const dataDir = await temporary();
  try {
    let { server, client, ai } = await boot(dataDir);
    await seededBook(client, "b");
    await client.startAutopilot("b", { brief: brief(2), options: ON });
    await until(() => ai.isHeld());
    assert.deepEqual(await server.autoResumed, [], "nothing to resume at the first start");
    await server.close();
    assert.equal((await readState(dataDir)).stoppedBy, "server-shutdown");

    for (const count of [1, 2, 3]) {
      ({ server, ai } = await boot(dataDir));
      assert.deepEqual(await server.autoResumed, [{ bookId: "b", cause: "server-shutdown", result: "resumed", count }], `restart ${count}`);
      assert.equal(server.books.get("b").session.running, true, "the run goes on");
      await until(() => ai.isHeld());
      const running = await readState(dataDir);
      assert.deepEqual([running.status, "stoppedBy" in running], ["running", false], "the server's word went with the start");
      assert.equal(insightsOf(server, "b", "resumedAfterRestart").length, 1, "the run says it was resumed after a restart");
      assert.equal(insightsOf(server, "b", "resumedAfterRestart")[0].title, "Resumed by itself after the server restarted.");
      assert.deepEqual((await readLedger(dataDir)).resumes.map((entry) => entry.bookId), Array(count).fill("b"), "counted, in the server's private record");
      await server.close();
      assert.equal((await readState(dataDir)).stoppedBy, "server-shutdown", "and stopped again with the server");
    }

    ({ server, ai } = await boot(dataDir));
    assert.deepEqual(await server.autoResumed, [{ bookId: "b", cause: "server-shutdown", result: "held", count: 3, code: "auto_resume_limit" }], "the fourth restart of the day");
    assert.equal(server.books.get("b").session.running, false, "nothing starts");
    assert.equal(ai.calls.length, 0, "and nothing is asked of the AI");
    const held = await readState(dataDir);
    assert.equal(held.status, "paused");
    assert.equal("stoppedBy" in held, false, "only the author resumes it now");
    assert.equal(held.message, "Not resumed after the server restart: the autopilot already resumed by itself 3 times in the last 24 hours. Resume it when you are ready.");
    assert.equal((await readLedger(dataDir)).resumes.length, 3, "a resume that did not happen is not counted");
    const logged = await autoResumes(dataDir);
    assert.deepEqual(logged.map((entry) => [entry.actor.kind, entry.object, entry.ok, entry.detail, entry.code]), [
      ["system", "b", true, "server-shutdown 1/3", undefined],
      ["system", "b", true, "server-shutdown 2/3", undefined],
      ["system", "b", true, "server-shutdown 3/3", undefined],
      ["system", "b", false, "server-shutdown 3/3", "auto_resume_limit"],
    ], "every resume, and the one that was not, is in the admin log");
    await server.close();

    ({ server } = await boot(dataDir));
    assert.deepEqual(await server.autoResumed, [], "the run waits for the author: a fifth start does nothing");
    await server.close();
  } finally {
    await remove(dataDir);
  }
});

test("R2: a run left running by a process that ended without pausing it is resumed (this server's runner, or one silent for too long); a live run of another host is not", async () => {
  const dataDir = await temporary();
  try {
    let { server, client } = await boot(dataDir);
    const serverId = server.data.config.serverId;
    for (const id of ["own", "stale", "alive"]) {
      await seededBook(client, id);
      await client.configureAutopilot(id, { brief: brief(2), options: ON });
    }
    await server.close();
    const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
    const runners = {
      own: { host: "server", label: "Narrarium server", hostId: serverId, runId: "run_killed", startedAt: ago(5), heartbeatAt: ago(1) },
      stale: { host: "browser", label: "Laptop", hostId: "device-1", runId: "run_gone", startedAt: ago(90), heartbeatAt: ago(40) },
      alive: { host: "browser", label: "Laptop", hostId: "device-1", runId: "run_live", startedAt: ago(5), heartbeatAt: ago(1) },
    };
    for (const [id, runner] of Object.entries(runners)) {
      const state = await readState(dataDir, id);
      await writeFile(stateFile(dataDir, id), JSON.stringify({ ...state, status: "running", runner }));
    }
    const alive = await readFile(stateFile(dataDir, "alive"), "utf8");

    let ai;
    ({ server, ai } = await boot(dataDir, { ai: blockingAi() }));
    assert.deepEqual(await server.autoResumed, [
      { bookId: "own", cause: "interrupted", result: "resumed", count: 1 },
      { bookId: "stale", cause: "interrupted", result: "resumed", count: 1 },
    ]);
    await until(() => ai.held() === 2);
    assert.equal(server.books.get("own").session.running, true);
    assert.equal(server.books.get("stale").session.running, true);
    assert.equal(server.books.get("alive").session.running, false, "another host's run that is alive is its own");
    assert.equal(await readFile(stateFile(dataDir, "alive"), "utf8"), alive, "and nothing is written to it");
    await server.close();
  } finally {
    await remove(dataDir);
  }
});

test("R3: a run the author paused is never resumed, nor one that paused by itself, nor one with the option off; nothing is written to them", async () => {
  const dataDir = await temporary();
  try {
    // The option off: the server's stop says so in the state, but nothing resumes it.
    await stoppedWhileRunning(dataDir, ["off"], FAST);
    let { server, client, ai } = await boot(dataDir);
    assert.deepEqual(await server.autoResumed, [], "the option is off");
    // The author pauses a run with the option on: then the server stops.
    await seededBook(client, "paused");
    await client.startAutopilot("paused", { brief: brief(2), options: ON });
    await until(() => ai.isHeld());
    await client.pauseAutopilot("paused", "now");
    await until(async () => !(await client.autopilot("paused")).running);
    // A run that paused by itself (one step, as asked).
    await seededBook(client, "step");
    await client.startAutopilot("step", { brief: brief(2), options: ON, limits: { steps: 1 } });
    await until(async () => !(await client.autopilot("step")).running);
    await server.close();
    const before = Object.fromEntries(await Promise.all(["off", "paused", "step"].map(async (id) => [id, await readFile(stateFile(dataDir, id), "utf8")])));
    for (const id of ["paused", "step"]) assert.equal("stoppedBy" in JSON.parse(before[id]), false, `${id}: the server did not stop it`);

    ({ server } = await boot(dataDir));
    assert.deepEqual(await server.autoResumed, []);
    for (const id of ["off", "paused", "step"]) {
      assert.equal(server.books.get(id).session.running, false, id);
      assert.equal(await readFile(stateFile(dataDir, id), "utf8"), before[id], `${id}: nothing is written`);
    }
    assert.equal(await exists(ledgerFile(dataDir)), false, "nothing is counted");
    assert.deepEqual(await autoResumes(dataDir), []);
    await server.close();
  } finally {
    await remove(dataDir);
  }
});

test("R3: a pause of the author after the server's stop takes the server's word away: the next start does not resume the run", async () => {
  const dataDir = await temporary();
  try {
    await stoppedWhileRunning(dataDir);
    let { server, client } = await boot(dataDir, { ai: undefined });
    // No AI configuration: the run is not resumed, and the author pauses it.
    assert.equal((await server.autoResumed)[0].result, "refused");
    const answer = await client.pauseAutopilot("b", "now");
    assert.equal(answer.state.status, "paused");
    assert.equal("stoppedBy" in answer.state, false, "the answer of the pause already says so");
    assert.equal("stoppedBy" in await readState(dataDir), false);
    await server.close();
    ({ server } = await boot(dataDir));
    assert.deepEqual(await server.autoResumed, []);
    await server.close();
  } finally {
    await remove(dataDir);
  }
});

test("R3: the MCP tool autopilot_pause, with nothing running, takes the server's word away as the app's pause does", async () => {
  const dataDir = await temporary();
  try {
    await stoppedWhileRunning(dataDir);
    let { server } = await boot(dataDir, { ai: undefined });
    assert.equal((await server.autoResumed)[0].result, "refused");
    const { slug } = await enableMcp(server, "b");
    const rpc = mcpClient(server, slug, await issueToken(server, "Claude Code", ["read", "run"]));
    const answer = await rpc.call("autopilot_pause", { when: "now" });
    assert.equal(answer.isError, false, answer.text);
    assert.equal("stoppedBy" in await readState(dataDir), false);
    await server.close();
    ({ server } = await boot(dataDir));
    assert.deepEqual(await server.autoResumed, [], "the next start does not resume it");
    await server.close();
  } finally {
    await remove(dataDir);
  }
});

test("R4: a start that is refused (no AI configuration, the spending switch) leaves the book as it is, is said in the logs, is not counted and is not tried again until the next start", async () => {
  const dataDir = await temporary();
  try {
    await stoppedWhileRunning(dataDir);
    const before = await readFile(stateFile(dataDir), "utf8");
    let { server, lines } = await boot(dataDir, { ai: undefined });
    assert.deepEqual(await server.autoResumed, [{ bookId: "b", cause: "server-shutdown", result: "refused", code: "ai_not_configured" }]);
    assert.equal(server.books.get("b").session.running, false);
    assert.equal(await readFile(stateFile(dataDir), "utf8"), before, "nothing is written to the book");
    assert.equal(await exists(ledgerFile(dataDir)), false, "a refusal found before the attempt does not use up a resume");
    assert.ok(lines.some((line) => line.startsWith("Autopilot of book b") && line.includes("not resumed after the restart") && line.includes("ai_not_configured")), lines.join("\n"));
    await server.close();

    let ai;
    ({ server, lines, ai } = await boot(dataDir));
    assert.equal((await server.autoResumed)[0].result, "resumed");
    await until(() => ai.isHeld());
    // The owner switches the spending off: the run is stopped with the server, and the next start may not resume it.
    await server.data.updateConfig((config) => {
      config.spend = { paused: true, maxTokensPerDay: 0, maxCostPerDay: 0, maxTokensPerRun: 0, maxCostPerRun: 0 };
    });
    await server.close();
    ({ server, lines } = await boot(dataDir));
    assert.deepEqual(await server.autoResumed, [{ bookId: "b", cause: "server-shutdown", result: "refused", code: "spend_limit" }]);
    assert.equal((await readState(dataDir)).stoppedBy, "server-shutdown", "the run is left as it is, for the next start");
    assert.equal((await readLedger(dataDir)).resumes.length, 1, "only the resume that happened is counted");
    assert.deepEqual((await autoResumes(dataDir)).map((entry) => [entry.ok, entry.code ?? null]), [[false, "ai_not_configured"], [true, null], [false, "spend_limit"]]);
    await server.close();
  } finally {
    await remove(dataDir);
  }
});

test("R5: one book at a time, the gap apart; a stop of the server ends the pass at once, and what it did not reach stays for the next start", async () => {
  const dataDir = await temporary();
  try {
    await stoppedWhileRunning(dataDir, ["b", "c"]);
    let { server, ai } = await boot(dataDir, { ai: blockingAi(), autoResumeGapMs: 400 });
    const outcomes = await server.autoResumed;
    await until(() => ai.held() === 2);
    assert.deepEqual(outcomes.map((entry) => [entry.bookId, entry.result]), [["b", "resumed"], ["c", "resumed"]]);
    const [first, second] = await Promise.all(["b", "c"].map(async (id) => Date.parse((await readState(dataDir, id)).runner.startedAt)));
    assert.ok(second - first >= 350, `the second run started ${second - first} ms after the first`);
    await server.close();

    ({ server } = await boot(dataDir, { ai: blockingAi(), autoResumeGapMs: 60_000 }));
    await until(() => server.books.get("b").session.running);
    const stopping = Date.now();
    await server.close();
    assert.ok(Date.now() - stopping < 20_000, "the server does not wait for the gap to stop");
    assert.deepEqual((await server.autoResumed).map((entry) => entry.bookId), ["b"], "the pass ended with the server");
    assert.equal((await readState(dataDir, "c")).stoppedBy, "server-shutdown", "the book it did not reach is left for the next start");
  } finally {
    await remove(dataDir);
  }
});

test("R6: the window is rolling: resumes older than 24 hours do not count, and are forgotten; a record that cannot be read resumes nothing that time and starts again from zero", async () => {
  const dataDir = await temporary();
  try {
    await stoppedWhileRunning(dataDir);
    const old = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    await writeFile(ledgerFile(dataDir), JSON.stringify({ version: 1, resumes: [{ bookId: "b", at: old }, { bookId: "b", at: old }, { bookId: "b", at: old }, { bookId: "gone", at: old }] }), { mode: 0o600 });
    let { server, lines } = await boot(dataDir, { ai: blockingAi() });
    assert.deepEqual(await server.autoResumed, [{ bookId: "b", cause: "server-shutdown", result: "resumed", count: 1 }]);
    assert.deepEqual((await readLedger(dataDir)).resumes.map((entry) => entry.bookId), ["b"], "only the last 24 hours are kept");
    await server.close();

    await writeFile(ledgerFile(dataDir), "{ not json", { mode: 0o600 });
    const before = await readFile(stateFile(dataDir), "utf8");
    ({ server, lines } = await boot(dataDir, { ai: blockingAi() }));
    assert.deepEqual(await server.autoResumed, []);
    assert.equal(await readFile(stateFile(dataDir), "utf8"), before, "nothing is written to the book");
    assert.ok(lines.some((line) => line.startsWith("Autopilot: the record of the automatic resumes") && line.includes("auto-resume.json.damaged")), lines.join("\n"));
    assert.equal(await readFile(`${ledgerFile(dataDir)}.damaged`, "utf8"), "{ not json", "the unreadable record is kept for the owner");
    await server.close();

    ({ server } = await boot(dataDir, { ai: blockingAi() }));
    assert.deepEqual(await server.autoResumed, [{ bookId: "b", cause: "server-shutdown", result: "resumed", count: 1 }], "the count starts again from zero");
    await server.close();
  } finally {
    await remove(dataDir);
  }
});

test("R7: info announces autopilot-auto-resume; PUT …/autopilot/options takes resumeAfterRestart true or false, also while a run goes on, and refuses anything else", async () => {
  const ai = holdingAi(HELD);
  await withServer(async (server, client) => {
    const info = await (await fetch(`${server.url}/api/v1/info`)).json();
    assert.equal(SERVER_FEATURE_AUTOPILOT_AUTO_RESUME, "autopilot-auto-resume");
    assert.ok(info.features.includes(SERVER_FEATURE_AUTOPILOT_AUTO_RESUME), JSON.stringify(info.features));
    assert.equal(serverSupportsAutopilotAutoResume(info), true);
    assert.equal(new Set(info.features).size, info.features.length, "each feature once");

    await seededBook(client, "b");
    await client.startAutopilot("b", { brief: brief(2), options: FAST });
    await until(() => ai.isHeld());
    const on = await client.updateAutopilotOptions("b", { resumeAfterRestart: true });
    assert.equal(on.state.options.resumeAfterRestart, true, "saved while the run goes on");
    const api = await rawApi(server);
    const before = await readFile(path.join(server.data.bookDirectory("b"), "autopilot", "state.json"), "utf8");
    for (const value of ["true", 1, null, {}, [], "yes"]) {
      const answer = await api("PUT", "/api/v1/books/b/autopilot/options", { resumeAfterRestart: value });
      assert.deepEqual([answer.status, answer.json.code], [400, "invalid_request"], JSON.stringify(value));
      assert.match(answer.json.message, /resumeAfterRestart must be true or false/);
    }
    assert.equal(await readFile(path.join(server.data.bookDirectory("b"), "autopilot", "state.json"), "utf8"), before, "nothing is written");
    const other = await api("PUT", "/api/v1/books/b/autopilot/options", { readers: false });
    assert.match(other.json.message, /resumeAfterRestart \(true or false\)/, "the settings that can change here include it");
    const off = await client.updateAutopilotOptions("b", { resumeAfterRestart: false });
    assert.equal("resumeAfterRestart" in off.state.options, false, "false turns it off");
    await client.pauseAutopilot("b", "now");
    await until(() => !server.books.get("b").session.running);
    const configured = await client.configureAutopilot("b", { options: { resumeAfterRestart: true } });
    assert.equal(configured.state.options.resumeAfterRestart, true, "configure hands it to the engine with the other options");
  }, { ai });
});
