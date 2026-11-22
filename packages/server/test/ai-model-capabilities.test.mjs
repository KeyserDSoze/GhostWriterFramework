import test from "node:test";
import assert from "node:assert/strict";
import { adminLogin, withServer } from "./helpers.mjs";
import { aiConfigFor, approve, fakeProvider, seededBook } from "./fake-provider.mjs";

/** A server whose AI is a fake provider on 127.0.0.1 (approved by the owner), with a seeded book: the configuration is each test's to send. */
async function withProvider(run) {
  const provider = await fakeProvider();
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

/** The configuration of the fake provider whose only model declares `flags`, in an integration that says `integrationExtra`. */
function declaring(provider, flags = {}, integrationExtra = {}) {
  const config = aiConfigFor(provider);
  Object.assign(config.aiIntegrations[0].chatModels[0], flags);
  Object.assign(config.aiIntegrations[0], integrationExtra);
  return config;
}

/** Save `config`, ask the director one question, and say what the provider was sent for it. */
async function asked({ client, provider, bookId }, config) {
  await client.putAiConfig(config);
  const before = provider.requests.length;
  await client.askDirector(bookId, { target: { kind: "book" } });
  assert.equal(provider.requests.length, before + 1, "one question, one request");
  return provider.requests.at(-1).body;
}

const DECLARED = { supportsToolCalls: true, supportsStreaming: false, supportsReasoning: true, supportsVision: true, maxInputTokens: 131072, maxOutputTokens: 8192 };

test("what a model declares is kept by PUT /ai and by the copy the server reads back, and the status shows it, without a key", async () => {
  await withProvider(async ({ client, provider }) => {
    const status = await client.putAiConfig(declaring(provider, DECLARED));
    assert.deepEqual(status.integrations[0].models, [{ name: "gpt-test", capabilities: ["default"], ...DECLARED }]);
    assert.deepEqual((await client.aiStatus()).integrations[0].models, status.integrations[0].models, "and so it does when it is read again");
    assert.equal(JSON.stringify(status).includes("sk-test-key-0123456789"), false);

    const old = await client.putAiConfig(declaring(provider));
    assert.deepEqual(old.integrations[0].models, [{ name: "gpt-test", capabilities: ["default"] }], "a model that declares nothing is shown as it always was");
    const junk = await client.putAiConfig(declaring(provider, { supportsStreaming: "no", supportsReasoning: 1, supportsVision: null, maxInputTokens: "big" }));
    assert.deepEqual(junk.integrations[0].models, [{ name: "gpt-test", capabilities: ["default"] }], "what is not a boolean or a number is dropped on the way in");
  });
});

test("a model that declares it does not stream is called without a stream, and one that declares it does not reason is sent no level of thinking: through the real server", async () => {
  await withProvider(async (context) => {
    const plain = await asked(context, declaring(context.provider, {}, { thinking: "high" }));
    assert.equal(plain.stream, true, "a model that declares nothing streams, as it always did");
    assert.equal(plain.reasoning_effort, "high");

    const declared = await asked(context, declaring(context.provider, { supportsStreaming: false, supportsReasoning: false }, { thinking: "high" }));
    assert.equal("stream" in declared, false);
    assert.equal("stream_options" in declared, false);
    assert.equal("reasoning_effort" in declared, false);

    const reasons = await asked(context, declaring(context.provider, { supportsStreaming: true, supportsReasoning: true }, { thinking: "high" }));
    assert.equal(reasons.stream, true);
    assert.equal(reasons.reasoning_effort, "high");
  });
});

test("a model that declares it reasons gets the margin of output for its reasoning, up to the answer it declared", async () => {
  await withProvider(async (context) => {
    const plain = await asked(context, declaring(context.provider));
    const reasons = await asked(context, declaring(context.provider, { supportsReasoning: true }));
    assert.equal(reasons.max_tokens - plain.max_tokens, 12000);
    const capped = await asked(context, declaring(context.provider, { supportsReasoning: true, maxOutputTokens: 8192 }));
    assert.equal(capped.max_tokens, 8192);
    assert.equal("max_completion_tokens" in capped, false, "the parameter is the one the model's name takes");
  });
});
