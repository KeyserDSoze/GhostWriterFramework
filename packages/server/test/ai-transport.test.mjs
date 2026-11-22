import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MIN_REQUEST_TIMEOUT_MS, NarrariumServerClient } from "narrarium-engine";
import { createFakeAutopilotAi } from "narrarium-engine/testing";
// New exports are read through the namespace, so a missing one fails the test that needs it and nothing else.
import * as testing from "../dist/testing.mjs";
import { adminLogin, noRelease, until, withServer } from "./helpers.mjs";
import { ONE_CHAPTER, aiConfigFor, approve, finished, seededBook } from "./fake-provider.mjs";

// What can cut a call to an AI provider, and what must not. The engine's own deadlines (start, idle and total: the engine's README, "Timeouts and
// streaming") are the only limits of the time a call takes. In the server's process `fetch` is the outbound guard's (`installOutboundNetwork`, built
// on node:http and node:https), which limits the connection and nothing after it. Node's own `fetch` (undici) would cut a response whose headers
// take 300 s, and a body that is silent for 300 s, whatever the engine says: these tests lower those two limits to a moment to show it, and show
// that the server is not cut by them, that the author's cancel is, at once, and that the server as it is published wears the guard.

const serverEntry = fileURLToPath(new URL("../dist/server.mjs", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const remove = (...directories) => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
/** What the slow providers wait: long for the limits that are lowered below, a moment for a machine that is slow. */
const SLOW_MS = 2000;
const LOWERED_MS = 300;

/**
 * An OpenAI-compatible provider on 127.0.0.1 that answers as slowly as it is told, in the shape the engine asks for (every reply streams, the
 * function of a structured one included), with the replies of the engine's fake AI and the usage of `fakeProvider` (100 in, 50 out).
 * `headersDelayMs`: how long before it sends the headers; `gapMs`: how long it is silent after its first piece; `hold`: it never answers.
 * `requests` is how many came, `streaming` how many it began to answer, `closed` how many connections it saw closed by the other side.
 */
async function slowProvider({ headersDelayMs = 0, gapMs = 0, hold = false } = {}) {
  const fake = createFakeAutopilotAi();
  const seen = { requests: 0, streaming: 0, closed: 0 };
  /** The waits of the provider: the ones that are still running when it is closed are dropped, so that a long silence never keeps the process from ending. */
  const timers = new Set();
  const wait = (ms) => new Promise((resolve) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      resolve();
    }, ms);
    timers.add(timer);
  });
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    seen.requests += 1;
    request.socket.once("close", () => {
      seen.closed += 1;
    });
    if (hold) return;
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const tool = body.tools?.[0]?.function;
    const reply = await fake.complete({ capability: "autopilot", label: "http", system: body.messages?.[0]?.content ?? "", user: body.messages?.[1]?.content ?? "", ...(tool ? { json: tool } : {}) });
    if (headersDelayMs) await wait(headersDelayMs);
    if (request.socket.destroyed) return;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const piece = (value) => response.write(`data: ${JSON.stringify(value)}\n\n`);
    const text = tool ? JSON.stringify(reply.json) : reply.text;
    const half = Math.floor(text.length / 2);
    if (tool) piece({ choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: tool.name, arguments: "" } }] } }] });
    else piece({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] });
    seen.streaming += 1;
    if (gapMs) await wait(gapMs);
    if (request.socket.destroyed) return;
    if (tool) {
      piece({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: text.slice(0, half) } }] } }] });
      piece({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: text.slice(half) } }] } }] });
    } else {
      piece({ choices: [{ index: 0, delta: { content: text.slice(0, half) } }] });
      piece({ choices: [{ index: 0, delta: { content: text.slice(half) } }] });
    }
    piece({ choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    seen,
    origin: `http://127.0.0.1:${port}`,
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

/**
 * Node's own `fetch` with its two limits, `headersTimeout` and `bodyTimeout` (300 s each), lowered to `ms`: what it does to a slow provider in five
 * minutes it then does in a moment. It goes through the dispatcher that Node keeps for its `fetch` (the one place both Node 22 and 24 keep it), and
 * answers how to put it back. The control that uses it is part of the test: a Node that keeps it elsewhere fails here, loudly, instead of passing without a control.
 */
function lowerPlatformLimits(ms) {
  const key = Symbol.for("undici.globalDispatcher.1");
  void globalThis.fetch;
  const original = globalThis[key];
  assert.ok(typeof original?.constructor === "function" && typeof original.close === "function", "this Node keeps the dispatcher of its fetch somewhere else: lowerPlatformLimits has to learn where");
  const lowered = new original.constructor({ headersTimeout: ms, bodyTimeout: ms });
  globalThis[key] = lowered;
  return async () => {
    globalThis[key] = original;
    await lowered.close();
  };
}

/** A server whose AI is `provider` (approved by the owner), with a seeded book; a client that talks to the server with the real `fetch`, whatever the process wears. */
async function withProviderServer(provider, run) {
  const realFetch = globalThis.fetch;
  await withServer(async (server, client) => {
    const bookId = await seededBook(client);
    await approve(await adminLogin(server), provider.origin);
    await client.putAiConfig(aiConfigFor(provider));
    const direct = new NarrariumServerClient({ baseUrl: server.url, token: (await server.auth.issue("direct", ["read", "write", "run"])).token, fetch: (input, init) => realFetch(input, init) });
    await run({ server, client, direct, bookId, session: server.books.get(bookId).session });
  }, { ai: undefined });
}

// ---------------------------------------------------------------------------------------------
// The server's AI calls are cut by the engine's deadlines, and by nothing under them
// ---------------------------------------------------------------------------------------------

for (const [name, options] of [["sends its headers late", { headersDelayMs: SLOW_MS }], ["goes silent in the middle of a stream", { gapMs: SLOW_MS }]]) {
  test(`S6: a provider that ${name} is answered through the outbound guard the server wears, where Node's own fetch (its limits lowered to a moment) gives up`, async () => {
    const provider = await slowProvider(options);
    try {
      await withProviderServer(provider, async ({ server, direct, session }) => {
        const ask = () => session.askDirector({ target: { kind: "book" } });
        const tokensBefore = (await direct.aiStatus()).spend.today.tokens;

        // The control: without the guard, in a process whose `fetch` is the platform's, the call is cut by the platform's own limit before the provider answers.
        const restoreLimits = lowerPlatformLimits(LOWERED_MS);
        try {
          await assert.rejects(ask(), "the platform's fetch is cut by its own limit, before the provider answers");
        } finally {
          await restoreLimits();
        }
        assert.equal(provider.seen.requests, 1, "the provider was asked once");

        const asked = provider.seen.requests;
        const restore = testing.installOutboundNetwork(server.allowedBases);
        try {
          const started = Date.now();
          const answer = await ask();
          assert.equal(answer.opinion.verdict, "revise", "the director's reply came whole");
          assert.ok(Date.now() - started >= SLOW_MS - 100, "after the whole wait: nothing cut it");
        } finally {
          restore();
        }
        assert.equal(provider.seen.requests, asked + 1);
        assert.equal((await direct.aiStatus()).spend.today.tokens, tokensBefore + 150, "and the call was counted, with the tokens the provider reported");
      });
    } finally {
      await provider.close();
    }
  });
}

test("S6: the author's cancel cuts a call at once and lets the connection go, whether the provider has not begun to answer or has gone silent in the middle of a stream", async () => {
  for (const [name, options] of [["has not begun to answer", { hold: true }], ["is silent in the middle of a stream", { gapMs: 600_000 }]]) {
    const provider = await slowProvider(options);
    try {
      await withProviderServer(provider, async ({ server, direct, bookId }) => {
        const restore = testing.installOutboundNetwork(server.allowedBases);
        try {
          await direct.startAutopilot(bookId, ONE_CHAPTER);
          await until(() => provider.seen.requests === 1 && (!options.gapMs || provider.seen.streaming === 1), 30_000);
          await sleep(200);
          const before = (await direct.aiStatus()).spend.today.calls;
          const started = Date.now();
          await direct.pauseAutopilot(bookId, "now");
          const stopped = await finished(direct, bookId, 30_000);
          await until(() => provider.seen.closed >= 1, 30_000);
          assert.ok(Date.now() - started < 10_000, `${name}: the call was cut in ${Date.now() - started} ms, not when a deadline of the engine (30 s or more) ran out`);
          assert.equal(stopped.state.status, "paused", name);
          assert.deepEqual(stopped.activities.filter((activity) => activity.status === "failed"), [], `${name}: a call that the author cancelled is no failure`);
          assert.equal(stopped.activities.at(-1).status, "cancelled");
          assert.equal(stopped.activities.at(-1).errorKind, undefined);
          assert.equal(stopped.state.lastError, null);
          assert.equal((await direct.aiStatus()).spend.today.calls, before + 1, `${name}: the attempt that was cut is counted as a call that used nothing`);
        } finally {
          restore();
        }
      });
    } finally {
      await provider.close();
    }
  }
});

// ---------------------------------------------------------------------------------------------
// The server as it is published wears the guard
// ---------------------------------------------------------------------------------------------

/** `dist/server.mjs` in a child process, as the supervisor starts it, with the data folder the test prepared; answers where its API is and how to stop it. */
async function startPublishedServer(dataDir) {
  const home = await mkdtemp(path.join(os.tmpdir(), "narrarium-ai-home-"));
  const child = spawn(process.execPath, [serverEntry, "--data-root", dataDir], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: home, USERPROFILE: home, NARRARIUM_SUPERVISED: "" }, windowsHide: true });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
    output += chunk;
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    await remove(home);
  };
  try {
    const api = await until(() => /API:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1], 30_000);
    return { api, stop };
  } catch (error) {
    await stop();
    throw new Error(`${error.message}: ${output}`);
  }
}

test("S6: the server as it is published (dist/server.mjs, a process of its own) wears the outbound guard for its AI calls: a provider's redirect is not followed, where the platform's fetch follows it", async () => {
  const hits = { chat: 0, moved: 0 };
  const provider = http.createServer((request, response) => {
    request.resume();
    if (request.url === "/v1/chat/completions") {
      hits.chat += 1;
      response.writeHead(307, { location: "/v1/moved/chat/completions" });
    } else {
      hits.moved += 1;
      response.writeHead(200, { "content-type": "application/json" });
    }
    response.end("{}");
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${provider.address().port}`;
  const asked = (client, bookId) => client.askDirector(bookId, { target: { kind: "book" } }).then(() => "answered", (error) => error);
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "narrarium-ai-transport-"));
  try {
    // A process that wears nothing: the redirect is followed, and the request reaches the other address.
    await withServer(async (server, client) => {
      const bookId = await seededBook(client);
      await approve(await adminLogin(server), origin);
      await client.putAiConfig(aiConfigFor({ url: `${origin}/v1` }));
      await asked(client, bookId);
    }, { ai: undefined });
    assert.deepEqual(hits, { chat: 1, moved: 1 }, "the platform's fetch followed it");

    // The server as it is published: a token and the owner's approval are in its data folder, and then it is started like the supervisor starts it.
    const first = await testing.startNarrariumServer({ dataDir, port: 0, adminPort: 0, supervised: false, checkRelease: noRelease, tunnel: { findBinary: () => undefined, detectOtherConnectors: async () => [] } });
    const { token } = await first.auth.issue("published server", ["read", "write", "run"]);
    await first.data.updateConfig((config) => {
      config.allowedAiBases = [origin];
    });
    await first.close();
    await testing.loadServerConfig(dataDir, { apiPort: 0, adminPort: 0 });
    Object.assign(hits, { chat: 0, moved: 0 });
    const published = await startPublishedServer(dataDir);
    try {
      const client = new NarrariumServerClient({ baseUrl: published.api, token });
      const bookId = await seededBook(client);
      await client.putAiConfig(aiConfigFor({ url: `${origin}/v1` }));
      const refused = await asked(client, bookId);
      assert.equal(refused.status, 502, "the call failed");
      assert.equal(refused.code, "ai_provider");
      assert.match(refused.message, /redirect/i, "and says why");
      assert.deepEqual(hits, { chat: 1, moved: 0 }, "the provider was asked, and the redirect was not followed");
    } finally {
      await published.stop();
    }
  } finally {
    await new Promise((resolve) => {
      provider.close(() => resolve());
      provider.closeAllConnections();
    });
    await remove(dataDir);
  }
});

// ---------------------------------------------------------------------------------------------
// The guard's own limit: the connection, and nothing after it
// ---------------------------------------------------------------------------------------------

test("S6: the guard's connect timeout is as long as the engine's shortest start deadline, so that the connection is never cut before the engine would cut the call", () => {
  assert.equal(testing.DEFAULT_CONNECT_TIMEOUT_MS, 30_000);
  assert.ok(testing.DEFAULT_CONNECT_TIMEOUT_MS >= MIN_REQUEST_TIMEOUT_MS);
});

test("S6: the connect timeout is for the connection only: an answer that takes several times as long, headers or body, is not cut by it", async () => {
  const target = http.createServer(async (request, response) => {
    request.resume();
    await sleep(request.url === "/late" ? 4 * LOWERED_MS : 0);
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("one ");
    await sleep(request.url === "/silent" ? 4 * LOWERED_MS : 0);
    response.end("two");
  });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${target.address().port}`;
  const restore = testing.installOutboundNetwork(() => [`${base}/v1`], { connectTimeoutMs: LOWERED_MS });
  try {
    for (const route of ["/late", "/silent", "/quick"]) {
      const response = await fetch(`${base}${route}`);
      assert.equal(response.status, 200, route);
      assert.equal(await response.text(), "one two", route);
    }
  } finally {
    restore();
    await new Promise((resolve) => {
      target.close(() => resolve());
      target.closeAllConnections();
    });
  }
});

test("S6: a proxy that takes the connection and says nothing is given up at the connect timeout, with a message that says why; nothing is left open", async () => {
  const sockets = new Set();
  const proxy = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
    // Read and say nothing: a connection that nobody reads from would not be seen to close.
    socket.resume();
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const restore = testing.installOutboundNetwork(() => ["https://api.approved.test"], {
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}` },
    connectTimeoutMs: LOWERED_MS,
  });
  const controller = new AbortController();
  try {
    const pending = fetch("https://api.approved.test/v1/chat", { signal: controller.signal }).then(() => "answered", (error) => error);
    const outcome = await Promise.race([pending, sleep(5_000).then(() => "still waiting")]);
    assert.notEqual(outcome, "still waiting", "the connect timeout of 300 ms was not the one in force");
    assert.equal(outcome.code, "connection");
    assert.match(outcome.message, /Could not connect to https:\/\/api\.approved\.test through the proxy/);
    assert.match(outcome.message, /it took too long/);
    await until(() => sockets.size === 0, 5_000);
  } finally {
    controller.abort();
    restore();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => proxy.close(resolve));
  }
});
