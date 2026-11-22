import test from "node:test";
import assert from "node:assert/strict";
import { adminLogin, withServer } from "./helpers.mjs";
import { ONE_CHAPTER, aiConfigFor, approve, fakeProvider, finished, seededBook } from "./fake-provider.mjs";

/** A server whose AI is a fake provider on 127.0.0.1 (approved by the owner), with a seeded book: the configuration is each test's to send. */
async function withProvider(run, providerOptions) {
  const provider = await fakeProvider(providerOptions);
  try {
    await withServer(async (server, client) => {
      const admin = await adminLogin(server);
      await approve(admin, provider.origin);
      await run({ server, client, provider, bookId: await seededBook(client) });
    }, { ai: undefined });
  } finally {
    await provider.close();
  }
}

/** The configuration of the fake provider whose only model is marked as unable to call a function; `extra` goes next to `aiIntegrations`. */
function withoutTools(provider, extra = {}) {
  const config = aiConfigFor(provider, { extra });
  config.aiIntegrations[0].chatModels[0].supportsToolCalls = false;
  return config;
}

// ─── «Tools only» ───────────────────────────────────────────────────────────

test("Tools only is on when nothing says otherwise: a book whose only model cannot call a function stops as a configuration problem, and the provider is never asked", async () => {
  await withProvider(async ({ client, provider, bookId }) => {
    await client.putAiConfig(withoutTools(provider));
    await client.startAutopilot(bookId, ONE_CHAPTER);
    const stopped = await finished(client, bookId);
    assert.equal(stopped.state.status, "error");
    assert.equal(stopped.state.lastError.errorKind, "config");
    assert.equal(stopped.summary.lastError.kind, "config", "the live summary says it too");
    assert.match(stopped.state.lastError.message, /Turn on "Forced tool calls" for the model in AI Integrations/);
    assert.match(stopped.state.lastError.message, /turn off "Tools only" in the AI Router/);
    assert.equal(provider.requests.length, 0, "nothing was sent");
    assert.equal(stopped.state.stats.failures, 1, "and it was not retried");
  });
});

test("Tools only off: the switch a client sends is kept by PUT /ai and by the copy the server reads back, and the same model is used with the schema in the message", async () => {
  // The first request is answered with a refusal that no retry follows: the run ends there, and the request is all there is to look at.
  await withProvider(async ({ client, provider, bookId }) => {
    await client.putAiConfig(withoutTools(provider, { toolsOnly: false }));
    await client.startAutopilot(bookId, ONE_CHAPTER);
    await finished(client, bookId);
    assert.ok(provider.requests.length > 0, "the provider was asked: the model is not skipped");
    const [first] = provider.requests;
    assert.equal("tools" in first.body, false, "no function: the model cannot call one");
    assert.match(first.body.messages[0].content, /Reply with ONLY one JSON object/, "the schema is in the message, as it always was");
  }, { respond: () => ({ status: 400, body: { error: { message: "that is all" } } }) });
});

test("a configuration saved before these fields existed runs a whole book as it did: a function for every structured step, no thinking level sent", async () => {
  await withProvider(async ({ client, provider, bookId }) => {
    await client.putAiConfig(aiConfigFor(provider));
    await client.startAutopilot(bookId, ONE_CHAPTER);
    const done = await finished(client, bookId);
    assert.equal(done.state.status, "completed", done.state.lastError?.message);
    assert.ok(provider.requests.some((request) => request.body.tools), "the structured steps ask for a function");
    assert.ok(provider.requests.every((request) => !("reasoning_effort" in request.body)), "nobody chose a level");
  });
});

// ─── Thinking ───────────────────────────────────────────────────────────────

test("thinking: the level of an integration and the level of a route target are kept by PUT /ai and reach the provider as reasoning_effort: the target's first, automatic as nothing", async () => {
  await withProvider(async ({ client, provider, bookId }) => {
    const base = aiConfigFor(provider);
    const integration = (thinking) => ({ ...base.aiIntegrations[0], ...(thinking ? { thinking } : {}) });
    const route = (thinking) => ({ director: { primary: { integrationId: "p", model: "gpt-test", ...(thinking ? { thinking } : {}) }, fallbacks: [] } });
    /** Save `config`, ask the director one question, and say what the provider was sent for it. */
    const ask = async (config) => {
      await client.putAiConfig(config);
      const before = provider.requests.length;
      await client.askDirector(bookId, { target: { kind: "book" } });
      assert.equal(provider.requests.length, before + 1, "one question, one request");
      return provider.requests.at(-1).body.reasoning_effort;
    };
    assert.equal(await ask({ ...base, aiIntegrations: [integration()] }), undefined, "nothing said, nothing sent");
    assert.equal(await ask({ ...base, aiIntegrations: [integration("high")] }), "high", "the integration's level");
    assert.equal(await ask({ ...base, aiIntegrations: [integration("high")], taskRouting: route("xhigh") }), "xhigh", "the route target's level wins");
    assert.equal(await ask({ ...base, aiIntegrations: [integration("high")], taskRouting: route("automatic") }), undefined, "automatic is no level, even when the integration has one");
    assert.equal(await ask({ ...base, aiIntegrations: [integration("low")], taskRouting: route() }), "low", "a target without a level inherits the integration's");
    assert.equal(await ask({ ...base, aiIntegrations: [integration("max")] }), undefined, "a level the engine does not know is dropped on the way in, not sent");
    const status = await client.aiStatus();
    assert.equal("thinking" in status.integrations[0], false, "and it is not kept");
    await client.putAiConfig({ ...base, aiIntegrations: [integration("medium")] });
    const shown = await client.aiStatus();
    assert.equal(shown.integrations[0].thinking, "medium", "the safe status shows the level of an integration");
    assert.equal(JSON.stringify(shown).includes("sk-test-key-0123456789"), false, "and still no key");
  });
});

// ─── What the status says of it ─────────────────────────────────────────────

test("the AI status says whether Tools only is on and the route of every task with the thinking level of each target, and still no key", async () => {
  await withProvider(async ({ client, provider }) => {
    const config = aiConfigFor(provider);
    assert.equal((await client.aiStatus()).toolsOnly, true);
    assert.deepEqual((await client.aiStatus()).taskRouting, {});
    const route = { director: { primary: { integrationId: "p", model: "gpt-test", thinking: "xhigh" }, fallbacks: [] } };
    const status = await client.putAiConfig({ ...config, toolsOnly: false, taskRouting: route });
    assert.equal(status.toolsOnly, false);
    assert.deepEqual(status.taskRouting, route);
    assert.deepEqual(await client.aiStatus(), status);
    assert.equal(JSON.stringify(status).includes("sk-test-key-0123456789"), false);
  });
});
