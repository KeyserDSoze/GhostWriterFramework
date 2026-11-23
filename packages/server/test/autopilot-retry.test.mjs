import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { SERVER_FEATURE_AUTOPILOT_CONTROLS, SERVER_FEATURE_AUTOPILOT_FROZEN, SERVER_FEATURE_AUTOPILOT_RETRY, SERVER_FEATURE_AUTOPILOT_RULES, serverSupportsAutopilotRetry } from "narrarium-engine";
import { createFakeAutopilotAi } from "narrarium-engine/testing";
// The engine's copy inside the server, the one its `instanceof` checks see.
import { AiProviderError } from "../dist/testing.mjs";
import { until, withServer } from "./helpers.mjs";
import { finished, seededBook } from "./fake-provider.mjs";
import { FAST, brief } from "./hold.mjs";
import { attempt, autopilotEvents, bookEvents, followStream, rawApi, stateEvents } from "./api-helpers.mjs";
import { issueToken, mcpClient, mcpFixture } from "./mcp-helpers.mjs";

// «Retry later» (`options.longRetry`, the engine's long-term retry) and «Retry now» (`POST …/autopilot/retry-now`) on the server. The engine does
// the work; these tests are about what the routes accept, answer and pass on. They are light: two short runs, and the rest without any run.

const optionsRoute = (bookId = "b") => `/api/v1/books/${bookId}/autopilot/options`;
const retryRoute = (bookId = "b") => `/api/v1/books/${bookId}/autopilot/retry-now`;
const stateFile = (server, bookId = "b") => path.join(server.data.bookDirectory(bookId), "autopilot", "state.json");
const readState = (server, bookId = "b") => readFile(stateFile(server, bookId), "utf8").catch(() => null);
const POLICY = { everyMinutes: 15, cycles: 3 };

/** The fake AI, whose concept fails its first `times` calls like a crashed node (the same words every time). */
function failingAi(times) {
  const base = createFakeAutopilotAi({ chapters: 1, scenes: 1, reviewVerdict: () => "approve" });
  let failed = 0;
  return {
    calls: base.calls,
    async complete(request) {
      if (request.label === "autopilot:concept" && failed < times) {
        failed += 1;
        base.calls.push(request);
        throw new AiProviderError("openai m: HTTP 500 — the node crashed", 500, true);
      }
      return base.complete(request);
    },
  };
}

test("A1: `info.features` announces `autopilot-retry`, next to what it announced before", async () => {
  await withServer(async (server) => {
    assert.equal(SERVER_FEATURE_AUTOPILOT_RETRY, "autopilot-retry");
    const info = await (await fetch(`${server.url}/api/v1/info`)).json();
    assert.ok(info.features.includes(SERVER_FEATURE_AUTOPILOT_RETRY), JSON.stringify(info.features));
    assert.equal(serverSupportsAutopilotRetry(info), true);
    for (const feature of [SERVER_FEATURE_AUTOPILOT_CONTROLS, SERVER_FEATURE_AUTOPILOT_RULES, SERVER_FEATURE_AUTOPILOT_FROZEN, "autopilot", "mcp"]) assert.ok(info.features.includes(feature), `${feature} is still announced`);
    assert.equal(new Set(info.features).size, info.features.length, "each feature once");
  });
});

test("A1: PUT …/autopilot/options turns «Retry later» on, changes it and turns it off (null); a value that is not a policy is a 400 that says why, and nothing is written", async () => {
  await withServer(async (server, client) => {
    await seededBook(client, "b");
    const on = await client.updateAutopilotOptions("b", { longRetry: POLICY });
    assert.deepEqual(on.state.options.longRetry, POLICY, "the answer is the snapshot, with the setting saved");
    assert.deepEqual(JSON.parse(await readState(server)).options.longRetry, POLICY, "and it is in the book");
    const unlimited = await client.updateAutopilotOptions("b", { longRetry: { everyMinutes: 60, cycles: "unlimited" }, publishEvery: "chapter" });
    assert.deepEqual(unlimited.state.options.longRetry, { everyMinutes: 60, cycles: "unlimited" }, "with another setting in the same request");
    const off = await client.updateAutopilotOptions("b", { longRetry: null });
    assert.equal(off.state.options.longRetry, undefined, "null turns it off");
    await client.updateAutopilotOptions("b", { longRetry: POLICY });

    const api = await rawApi(server);
    const before = await readState(server);
    const refused = [
      [{ everyMinutes: 0, cycles: 3 }, /everyMinutes/], [{ everyMinutes: -5, cycles: 3 }, /everyMinutes/], [{ everyMinutes: 15.5, cycles: 3 }, /everyMinutes/],
      [{ everyMinutes: "15", cycles: 3 }, /everyMinutes/], [{ everyMinutes: 10_081, cycles: 3 }, /everyMinutes/],
      [{ everyMinutes: 15, cycles: 0 }, /cycles/], [{ everyMinutes: 15, cycles: 1001 }, /cycles/], [{ everyMinutes: 15, cycles: "forever" }, /cycles/],
      [{ everyMinutes: 15, cycles: "Unlimited" }, /cycles/], [{ everyMinutes: 15 }, /cycles/], [{ cycles: 3 }, /everyMinutes/],
      [{ everyMinutes: 15, cycles: 3, extra: 1 }, /extra/], ["often", /object/], [[15, 3], /object/], [true, /object/], [15, /object/],
    ];
    for (const [value, problem] of refused) {
      const answer = await api("PUT", optionsRoute(), { longRetry: value });
      assert.deepEqual([answer.status, answer.json.code], [400, "invalid_request"], JSON.stringify(value));
      assert.match(answer.json.message, problem, JSON.stringify(value));
      assert.match(answer.json.message, /longRetry/, "the message names the setting");
      assert.equal(await readState(server), before, `${JSON.stringify(value)} changed nothing`);
    }
    const other = await api("PUT", optionsRoute(), { readers: false });
    assert.match(other.json.message, /longRetry \(/, "the settings that can change here include longRetry");
  });
});

test("A1: configure and start hand longRetry to the engine with the other options", async () => {
  await withServer(async (server, client) => {
    await seededBook(client, "b");
    const configured = await client.configureAutopilot("b", { options: { longRetry: { everyMinutes: 30, cycles: 2 } } });
    assert.deepEqual(configured.state.options.longRetry, { everyMinutes: 30, cycles: 2 });
    await seededBook(client, "c");
    await client.startAutopilot("c", { brief: brief(1), options: { ...FAST, longRetry: { everyMinutes: 5, cycles: "unlimited" } } });
    const done = await finished(client, "c");
    assert.equal(done.state.status, "completed", done.state.lastError?.message);
    assert.deepEqual(done.state.options.longRetry, { everyMinutes: 5, cycles: "unlimited" });
  }, { ai: createFakeAutopilotAi({ chapters: 1, scenes: 1, reviewVerdict: () => "approve" }) });
});

test("A2: a run that waits for a long cycle: the cycle is in the snapshot, the list of books and the stream; «Retry now» ends the wait, answers skipped, and the run goes on", async () => {
  await withServer(async (server, client) => {
    await seededBook(client, "b");
    const stream = await followStream(client);
    await client.startAutopilot("b", { brief: brief(1), options: { ...FAST, longRetry: { everyMinutes: 60, cycles: 3 } } });
    // Two attempts (the same words twice end the short level), then a long wait of 60 minutes × 40 / 4000: 36 seconds.
    await until(async () => (await client.autopilot("b")).summary?.retry?.longTerm, 30_000);
    const waiting = await client.autopilot("b");
    assert.deepEqual(waiting.summary.retry.longTerm, { cycle: 1, cycles: 3 });
    assert.equal(waiting.running, true);
    assert.equal(server.books.runningCount(), 1, "a run that waits keeps its place among the runs of the server");
    assert.deepEqual((await client.listBooks()).find((book) => book.bookId === "b").autopilot.retry.longTerm, { cycle: 1, cycles: 3 });
    await until(() => stateEvents(stream.messages).some((summary) => summary.retry?.longTerm?.cycle === 1), 30_000);
    const wait = autopilotEvents(stream.messages).find((event) => event.type === "insight" && event.code === "longRetryWait");
    assert.deepEqual([wait.cycle, wait.cycles, wait.waitMs], [1, 3, 36_000]);

    const answer = await client.retryNow("b");
    assert.equal(answer.skipped, true);
    assert.equal(answer.summary.retry, undefined, "nothing waits any more");
    const done = await finished(client, "b");
    assert.equal(done.state.status, "completed", done.state.lastError?.message);
    await until(() => autopilotEvents(stream.messages).some((event) => event.type === "insight" && event.code === "retrySkipped"), 30_000);
    assert.equal((await client.retryNow("b")).skipped, false, "with nothing waiting it changes nothing");
    await until(() => bookEvents(stream.messages).some((book) => book.bookId === "b" && book.autopilot?.status === "completed"), 30_000);
    await stream.stop();
  }, { ai: failingAi(2), autopilot: { retryDelayMs: 40 } });
});

test("A2: POST …/autopilot/retry-now is for the clients that may run the autopilot; an update about to start is a 503 and an unknown book a 404; the body is empty", async () => {
  const lines = [];
  await withServer(async (server, client) => {
    await seededBook(client, "b");
    const anonymous = await fetch(`${server.url}${retryRoute()}`, { method: "POST" });
    assert.equal(anonymous.status, 401);
    for (const scopes of [["read"], ["write"], ["read", "write"]]) {
      const refused = await (await rawApi(server, scopes))("POST", retryRoute());
      assert.deepEqual([refused.status, refused.json.code], [403, "scope"], scopes.join(","));
    }
    const runner = await rawApi(server, ["run"]);
    const answer = await runner("POST", retryRoute());
    assert.equal(answer.status, 200, answer.text);
    assert.equal(answer.json.skipped, false, "nothing waits");
    assert.equal(answer.json.bookId, "b", "the answer is the snapshot");
    assert.equal((await runner("POST", retryRoute(), {})).status, 200, "an empty object is an empty body");

    const api = await rawApi(server);
    assert.deepEqual([(await api("POST", retryRoute("nope"))).status, (await api("POST", retryRoute("nope"))).json.code], [404, "book_not_found"]);
    assert.equal((await api("GET", retryRoute())).status, 404, "POST is the route");
    const typed = await attempt(() => client.retryNow("nope"));
    assert.deepEqual([typed.status, typed.code], [404, "book_not_found"]);
    // (`null` is read as no body at all, as on every route of the server.)
    assert.equal((await runner("POST", retryRoute(), "null")).status, 200);
    for (const body of [{ now: true }, { skipped: true }, "[]", "5", "true", "{", "\u0000", '{"__proto__":{}}', `{"x":"${"y".repeat(100_000)}"}`, "nul"]) {
      const response = await api("POST", retryRoute(), body);
      assert.ok(response.status >= 400 && response.status < 500, `${JSON.stringify(String(body).slice(0, 40))}: ${response.status} ${response.text.slice(0, 200)}`);
      assert.notEqual(response.json?.code, "internal");
    }
    assert.equal((await api("POST", retryRoute(), { now: true })).json.code, "invalid_request");

    await server.books.requestUpdate(async () => undefined);
    for (const route of [retryRoute(), retryRoute("nope")]) {
      const response = await api("POST", route);
      assert.deepEqual([response.status, response.json.code], [503, "maintenance"], route);
    }
  }, { log: (line) => lines.push(line) });
  assert.deepEqual(lines.filter((line) => /^Error /.test(line)), [], "no internal error was logged");
});

test("A2: the MCP tool autopilot_retry_now is a tool of the run permission, and answers the status with skipped; autopilot_status says how «Retry later» is set", async () => {
  await withServer(async (server, client) => {
    const { rpc, slug, bookId } = await mcpFixture(server, client);
    const answer = await rpc.call("autopilot_retry_now", {});
    assert.equal(answer.isError, false, answer.text);
    assert.equal(answer.data.skipped, false);
    assert.equal(typeof answer.data.status, "string", "the autopilot's status");
    await client.updateAutopilotOptions(bookId, { pauseAfterEachChapter: true });
    assert.equal((await rpc.call("autopilot_status", {})).data.longRetry, null, "autopilot_status says that «Retry later» is off");
    await client.updateAutopilotOptions(bookId, { longRetry: POLICY });
    assert.deepEqual((await rpc.call("autopilot_status", {})).data.longRetry, POLICY, "and how it is set");
    const reader = mcpClient(server, slug, await issueToken(server, "reader", ["read"]));
    const refused = await reader.call("autopilot_retry_now", {});
    assert.equal(refused.isError, true);
    assert.ok(refused.text.startsWith("[scope]"), refused.text);
  });
});
