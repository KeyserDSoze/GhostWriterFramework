import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { NarrariumServerClient } from "narrarium-engine";
// New exports are read through the namespace, so a missing one fails the test that needs it and nothing else.
import * as testing from "../dist/testing.mjs";
import { adminLogin, noRelease, withServer } from "./helpers.mjs";
import { ONE_CHAPTER, aiConfigFor, approve, fakeProvider, finished, seededBook } from "./fake-provider.mjs";

/** An OpenAI integration (no endpoint: the engine's default base) for the cases that must not reach a real provider. */
const openai = (extra = {}) => ({ id: "a", name: "OpenAI", provider: "openai", apiKey: "sk-secret-value", chatModels: [{ id: "m", name: "gpt-4o", capabilities: ["default"] }], ...extra });

/**
 * Everything that is not this computer: what the engine tries to reach is kept and refused with a 400 (an answer that no retry
 * follows). The tests talk to the server and to their own fake providers on 127.0.0.1, which pass through.
 */
function spyOnOutsideWorld() {
  const original = globalThis.fetch;
  const reached = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return original(input, init);
    reached.push({ url: url.href, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return new Response(JSON.stringify({ error: { message: "spy: nobody is there" } }), { status: 400, headers: { "content-type": "application/json" } });
  };
  return { reached, restore: () => void (globalThis.fetch = original) };
}

// ---------------------------------------------------------------------------------------------
// The comparison of a base with the owner's approvals
// ---------------------------------------------------------------------------------------------

test("C16: a base is compared as `new URL` writes it: host in lower case, no trailing slash, no query, and never with credentials", () => {
  const { canonicalAiBase } = testing;
  assert.equal(canonicalAiBase("https://API.OpenAI.com/v1/"), "https://api.openai.com/v1");
  assert.equal(canonicalAiBase("  https://api.openai.com/v1  "), "https://api.openai.com/v1");
  assert.equal(canonicalAiBase("https://api.openai.com"), "https://api.openai.com");
  assert.equal(canonicalAiBase("https://api.openai.com/"), "https://api.openai.com");
  assert.equal(canonicalAiBase("https://api.openai.com:443/v1"), "https://api.openai.com/v1", "the default port is no difference");
  assert.equal(canonicalAiBase("https://api.openai.com:8443/v1"), "https://api.openai.com:8443/v1");
  assert.equal(canonicalAiBase("https://x.example/v1/?api-version=1#top"), "https://x.example/v1", "what is not part of the base is not compared");
  assert.equal(canonicalAiBase("https://x.example/a/../v1"), "https://x.example/v1", "dot segments are resolved the way fetch resolves them");
  assert.equal(canonicalAiBase("http://127.0.0.1:1234/v1"), "http://127.0.0.1:1234/v1");
  assert.equal(canonicalAiBase("https://user:secret@x.example/v1"), null, "an address with credentials is nothing that can be approved");
  assert.equal(canonicalAiBase("ftp://x.example/v1"), null);
  assert.equal(canonicalAiBase("not an address"), null);
  assert.equal(canonicalAiBase(undefined), null);
  assert.equal(canonicalAiBase(""), null);
});

test("C16: an approval of an origin covers every base on it, one with a path covers that path and what is under it, and nothing else", () => {
  const { approvalCovers, baseIsApproved } = testing;
  // The entries saved so far are origins: they keep covering what they covered (nobody approves again).
  assert.equal(approvalCovers("https://api.openai.com", "https://api.openai.com/v1"), true);
  assert.equal(approvalCovers("https://api.openai.com", "https://api.openai.com"), true);
  assert.equal(approvalCovers("https://api.openai.com/", "https://api.openai.com/v1/"), true, "slashes make no difference");
  assert.equal(approvalCovers("HTTPS://API.OPENAI.COM", "https://api.openai.com/v1"), true, "nor does the case of the host");
  assert.equal(approvalCovers("https://api.openai.com", "https://api.openai.com.evil.example/v1"), false, "an origin is not a prefix of text");
  assert.equal(approvalCovers("https://api.openai.com", "https://api.openai.com:8443/v1"), false, "another port is another origin");
  assert.equal(approvalCovers("https://api.openai.com", "http://api.openai.com/v1"), false, "another scheme too");
  // An entry with a path.
  assert.equal(approvalCovers("https://x.example/openai/v1", "https://x.example/openai/v1"), true);
  assert.equal(approvalCovers("https://x.example/openai/v1/", "https://x.example/openai/v1"), true);
  assert.equal(approvalCovers("https://x.example/openai", "https://x.example/openai/v1"), true, "a parent path covers what is under it");
  assert.equal(approvalCovers("https://x.example/openai/v1", "https://x.example/openai"), false, "a narrower entry does not cover the wider base");
  assert.equal(approvalCovers("https://x.example/openai/v1", "https://x.example/openai/v10"), false, "a path is compared by its segments, not by its characters");
  assert.equal(approvalCovers("https://x.example/openai/v1", "https://x.example/other"), false);
  assert.equal(approvalCovers("https://x.example/Openai/v1", "https://x.example/openai/v1"), false, "paths are case sensitive");
  assert.equal(approvalCovers("garbage", "https://x.example"), false);
  assert.equal(approvalCovers("https://x.example", "garbage"), false);
  assert.equal(baseIsApproved("https://x.example/v1", []), false);
  assert.equal(baseIsApproved("https://x.example/v1", ["https://y.example", "https://x.example"]), true);
});

test("C16: every integration has a base, the providers' defaults included; what no approval covers is what waits", () => {
  const { aiDestinations, unapprovedAiBases } = testing;
  const config = {
    aiIntegrations: [
      { id: "o", name: "OpenAI", provider: "openai", apiKey: "k", chatModels: [] },
      { id: "c", name: "Compatible", provider: "openai", endpoint: "https://Llm.Example.com/v1/", apiKey: "k", chatModels: [] },
      { id: "g", name: "GitHub", provider: "github_models", apiKey: "k", chatModels: [] },
      { id: "z", name: "Azure", provider: "azure_openai", endpoint: "https://Res.openai.azure.com/openai/v1", apiKey: "k", chatModels: [] },
      { id: "z2", name: "Azure again", provider: "azure_openai", endpoint: "https://res.openai.azure.com/openai/v1/", apiKey: "k", chatModels: [] },
      { id: "n", name: "Azure without an address", provider: "azure_openai", apiKey: "k", chatModels: [] },
      { id: "m", name: "Microsoft 365", provider: "m365_copilot", apiKey: "", chatModels: [] },
    ],
  };
  assert.deepEqual(aiDestinations(config).map((entry) => [entry.integrationId, entry.base]), [
    ["o", "https://api.openai.com/v1"],
    ["c", "https://llm.example.com/v1"],
    ["g", "https://models.github.ai/inference"],
    ["z", "https://res.openai.azure.com/openai/v1"],
    ["z2", "https://res.openai.azure.com/openai/v1"],
  ], "an integration that cannot be called (no address, no chat) has nothing to approve");
  assert.deepEqual(unapprovedAiBases(config, []), ["https://api.openai.com/v1", "https://llm.example.com/v1", "https://models.github.ai/inference", "https://res.openai.azure.com/openai/v1"], "each base once");
  assert.deepEqual(unapprovedAiBases(config, ["https://api.openai.com", "https://llm.example.com/v1", "https://res.openai.azure.com/openai"]), ["https://models.github.ai/inference"]);
  assert.deepEqual(unapprovedAiBases(config, ["https://res.openai.azure.com/openai/v2", "https://llm.example.com/v2"]).slice(0, 2), ["https://api.openai.com/v1", "https://llm.example.com/v1"], "a path next to the one that is used covers nothing");
  assert.deepEqual(unapprovedAiBases({ aiIntegrations: [] }, []), []);
});

test("a model with an address of its own is a destination of its own: the key goes there, so its origin and path (never its query) wait for approval, and a call for it is refused until they are approved", () => {
  const { aiDestinations, unapprovedAiBases, assertAiApproved, AiNotApprovedError } = testing;
  const secret = "SECRET-QUERY-VALUE-123456";
  const config = {
    aiIntegrations: [{
      id: "z", name: "Azure", provider: "azure_openai", endpoint: "https://res.openai.azure.com", apiKey: "k",
      chatModels: [
        { id: "a", name: "gpt-5.2", capabilities: ["default"], apiProtocol: "responses", endpointUrl: `https://Gateway.Example.com/openai/responses?api-version=2025-04-01-preview&key=${secret}` },
        { id: "b", name: "plain", capabilities: ["default"] },
        { id: "c", name: "unsafe", capabilities: ["default"], endpointUrl: "https://user:pass@gateway.example.com/x" },
      ],
    }],
    taskRouting: { autopilot: { primary: { integrationId: "z", model: "gpt-5.2" }, fallbacks: [] } },
  };
  assert.deepEqual(aiDestinations(config).map((entry) => [entry.integrationId, entry.model, entry.base]), [
    ["z", undefined, "https://res.openai.azure.com"],
    ["z", "gpt-5.2", "https://gateway.example.com/openai/responses"],
  ], "the base of the integration, and the address of the model without its query; an address with credentials is nothing to approve");
  assert.deepEqual(unapprovedAiBases(config, []), ["https://res.openai.azure.com", "https://gateway.example.com/openai/responses"]);
  assert.deepEqual(unapprovedAiBases(config, ["https://res.openai.azure.com"]), ["https://gateway.example.com/openai/responses"], "the approval of the integration's origin does not cover another origin");
  assert.deepEqual(unapprovedAiBases(config, ["https://res.openai.azure.com", "https://gateway.example.com"]), [], "the origin of the address covers it");
  assert.deepEqual(unapprovedAiBases(config, ["https://res.openai.azure.com", "https://gateway.example.com/openai"]), [], "so does a path above it");
  assert.equal(JSON.stringify(unapprovedAiBases(config, [])).includes(secret), false, "the query never reaches the list the owner reads");

  // The model's own address is where its call goes: it is what must be approved for it, not the integration's base.
  const own = (error) => error instanceof AiNotApprovedError && error.bases.length === 1 && error.bases[0] === "https://gateway.example.com/openai/responses" && !error.message.includes(secret) && /\(gpt-5\.2\)/.test(error.message);
  assert.throws(() => assertAiApproved(config, "autopilot", ["https://res.openai.azure.com"]), own);
  assert.doesNotThrow(() => assertAiApproved(config, "autopilot", ["https://gateway.example.com"]), "the integration's own base is not asked for a model that does not use it");
  const plain = { ...config, taskRouting: { autopilot: { primary: { integrationId: "z", model: "plain" }, fallbacks: [] } } };
  assert.throws(() => assertAiApproved(plain, "autopilot", ["https://gateway.example.com"]), (error) => error instanceof AiNotApprovedError && error.bases[0] === "https://res.openai.azure.com", "a model without one still needs its integration's base");
  assert.doesNotThrow(() => assertAiApproved(plain, "autopilot", ["https://res.openai.azure.com"]));
});

// ---------------------------------------------------------------------------------------------
// Waiting for approval, and a run that stops instead of calling
// ---------------------------------------------------------------------------------------------

test("C16: an OpenAI integration without an endpoint waits for approval with its real base, and the run says which base to approve instead of calling it", async () => {
  const outside = spyOnOutsideWorld();
  try {
    await withServer(async (server, client) => {
      const bookId = await seededBook(client);
      const status = await client.putAiConfig({ aiIntegrations: [openai()] });
      assert.deepEqual(status.pendingApproval, ["https://api.openai.com/v1"], "the default provider waits too, with the base requests start with");
      assert.deepEqual(server.data.config.pendingAiBases, ["https://api.openai.com/v1"]);
      assert.deepEqual((await client.aiStatus()).pendingApproval, ["https://api.openai.com/v1"]);
      const admin = await adminLogin(server);
      assert.deepEqual((await admin.call("GET", "/admin/api/status")).body.pendingAiBases, ["https://api.openai.com/v1"], "and the panel lists it");

      await client.startAutopilot(bookId, ONE_CHAPTER);
      const snapshot = await finished(client, bookId);
      assert.equal(snapshot.state.status, "error", "the run stops");
      assert.match(snapshot.state.message, /https:\/\/api\.openai\.com\/v1/, "and names the base to approve");
      assert.match(snapshot.state.message, /approve/i);
      assert.match(snapshot.state.message, /admin panel/i, "and where");
      assert.equal(snapshot.state.stats.aiCalls, 0, "no call was made");
      assert.equal(snapshot.activities.at(-1).status, "failed");
      assert.doesNotMatch(snapshot.state.message, /retry|network|ENOTFOUND|fetch failed/i, "it is not an obscure network error");
      assert.deepEqual(outside.reached, [], "nothing was sent to anybody, so no key either");
      assert.equal(JSON.stringify(snapshot).includes("sk-secret-value"), false);
    }, { ai: undefined });
  } finally {
    outside.restore();
  }
});

test("C16: approving the ORIGIN (what the owners of the earlier versions saved) is enough: the run starts and the key is sent there", async () => {
  const provider = await fakeProvider();
  try {
    await withServer(async (server, client) => {
      const bookId = await seededBook(client);
      const status = await client.putAiConfig(aiConfigFor(provider));
      assert.deepEqual(status.pendingApproval, [provider.url], "before the approval the endpoint waits, with its path");
      await client.startAutopilot(bookId, ONE_CHAPTER);
      const blocked = await finished(client, bookId);
      assert.equal(blocked.state.status, "error");
      assert.match(blocked.state.message, new RegExp(provider.url.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")));
      assert.equal(provider.requests.length, 0, "the provider was not called before the owner approved");

      const admin = await adminLogin(server);
      await approve(admin, provider.origin);
      assert.deepEqual(server.data.config.allowedAiBases, [provider.origin], "the owner approved an origin, and that is what is kept");
      assert.equal((await client.aiStatus()).pendingApproval, undefined, "nothing waits any more");
      assert.deepEqual(server.data.config.pendingAiBases, [], "the entry that waited is gone (the origin covers it)");
      assert.deepEqual((await admin.call("GET", "/admin/api/status")).body.pendingAiBases, []);

      await client.startAutopilot(bookId, ONE_CHAPTER);
      const done = await finished(client, bookId);
      assert.equal(done.state.status, "completed", done.state.message ?? "");
      assert.ok(provider.requests.length > 5, "the provider answered the whole run");
      assert.equal(provider.requests[0].headers.authorization, "Bearer sk-test-key-0123456789", "the key went to the approved endpoint");
    }, { ai: undefined });
  } finally {
    await provider.close();
  }
});

test("C16: an owner who approved the origin before the update needs no new approval for the integrations that were already working", async () => {
  const provider = await fakeProvider();
  try {
    await withServer(async (server, client) => {
      await server.data.updateConfig((config) => {
        config.allowedAiBases = [provider.origin];
      });
      const status = await client.putAiConfig(aiConfigFor(provider));
      assert.equal(status.pendingApproval, undefined);
      assert.deepEqual(server.data.config.pendingAiBases, []);
      const bookId = await seededBook(client);
      const opinion = await client.askDirector(bookId, { target: { kind: "book" }, question: "Does it work?" });
      assert.equal(opinion.opinion.verdict, "revise");
      assert.equal(provider.requests.length, 1);
    }, { ai: undefined });
  } finally {
    await provider.close();
  }
});

test("C16: an approval with a path covers that base and what is under it, not the paths next to it; the origin's other paths wait", async () => {
  const provider = await fakeProvider();
  try {
    await withServer(async (server, client) => {
      const bookId = await seededBook(client);
      const admin = await adminLogin(server);
      await client.putAiConfig(aiConfigFor(provider));
      // A path next to the one the integration uses: it is no approval of this base.
      await approve(admin, `${provider.origin}/other`);
      assert.deepEqual(server.data.config.allowedAiBases, [`${provider.origin}/other`], "the path is kept, not cut to the origin");
      assert.deepEqual((await client.aiStatus()).pendingApproval, [provider.url]);
      await assert.rejects(
        () => client.askDirector(bookId, { target: { kind: "book" } }),
        (error) => error.status === 412 && error.code === "ai_not_approved" && error.message.includes(provider.url),
      );
      assert.equal(provider.requests.length, 0);
      // The base itself.
      await approve(admin, provider.url);
      assert.deepEqual(server.data.config.allowedAiBases, [`${provider.origin}/other`, provider.url]);
      assert.equal((await client.aiStatus()).pendingApproval, undefined);
      assert.equal((await client.askDirector(bookId, { target: { kind: "book" } })).opinion.verdict, "revise");
      assert.equal(provider.requests.length, 1);
      // The integration moves to a path that the approval does not cover: waiting again, and the call is refused.
      const moved = aiConfigFor(provider);
      moved.aiIntegrations[0].endpoint = `${provider.origin}/v10`;
      assert.deepEqual((await client.putAiConfig(moved)).pendingApproval, [`${provider.origin}/v10`], "/v1 does not cover /v10");
      await assert.rejects(() => client.askDirector(bookId, { target: { kind: "book" } }), (error) => error.code === "ai_not_approved");
      assert.equal(provider.requests.length, 1);
      // A parent path covers it.
      await approve(admin, `${provider.origin}/`);
      assert.deepEqual(server.data.config.allowedAiBases.at(-1), provider.origin, "a trailing slash is not kept");
      assert.equal((await client.aiStatus()).pendingApproval, undefined);
    }, { ai: undefined });
  } finally {
    await provider.close();
  }
});

test("C16: Azure OpenAI waits with the endpoint the owner will see, path included, in the case the URL parser writes", async () => {
  await withServer(async (server, client) => {
    const azure = { id: "z", name: "Azure", provider: "azure_openai", endpoint: "https://My-Resource.openai.azure.com/openai/v1/", apiKey: "az-key", chatModels: [{ id: "m", name: "gpt-4o", capabilities: ["default"] }] };
    assert.deepEqual((await client.putAiConfig({ aiIntegrations: [azure] })).pendingApproval, ["https://my-resource.openai.azure.com/openai/v1"]);
    const admin = await adminLogin(server);
    await approve(admin, "https://my-resource.openai.azure.com/openai/v2");
    assert.deepEqual((await client.aiStatus()).pendingApproval, ["https://my-resource.openai.azure.com/openai/v1"], "another path of the resource is no approval of this one");
    await approve(admin, "https://my-resource.openai.azure.com");
    assert.equal((await client.aiStatus()).pendingApproval, undefined, "the origin of the resource covers its paths");
    assert.deepEqual(server.data.config.pendingAiBases, [], "and clears the entry that waited");

    // A plain endpoint (no path) is its own origin; an Azure integration without an endpoint cannot be called and waits for nothing.
    const plain = { ...azure, id: "p", endpoint: "https://other-resource.openai.azure.com" };
    const none = { ...azure, id: "n", endpoint: undefined };
    assert.deepEqual((await client.putAiConfig({ aiIntegrations: [plain, none] })).pendingApproval, ["https://other-resource.openai.azure.com"]);
  }, { ai: undefined });
});

test("C16: GitHub Models waits with its default base, and once approved the server calls that base (it needs no proxy: there is no CORS here)", async () => {
  const outside = spyOnOutsideWorld();
  try {
    await withServer(async (server, client) => {
      const bookId = await seededBook(client);
      const github = { id: "g", name: "GitHub Models", provider: "github_models", apiKey: "ghp_models_key", chatModels: [{ id: "m", name: "openai/gpt-4.1", capabilities: ["default"] }] };
      assert.deepEqual((await client.putAiConfig({ aiIntegrations: [github] })).pendingApproval, ["https://models.github.ai/inference"]);
      await assert.rejects(() => client.askDirector(bookId, { target: { kind: "book" } }), (error) => error.status === 412 && error.code === "ai_not_approved" && /https:\/\/models\.github\.ai\/inference/.test(error.message));
      assert.deepEqual(outside.reached, []);
      await approve(await adminLogin(server), "https://models.github.ai");
      await assert.rejects(() => client.askDirector(bookId, { target: { kind: "book" } }), (error) => error.status === 502 && /spy: nobody is there/.test(error.message), "the call is made now (the spy refuses it)");
      assert.equal(outside.reached.length, 1);
      assert.equal(outside.reached[0].url, "https://models.github.ai/inference/chat/completions", "the engine's own default, as for every host");
      assert.equal(outside.reached[0].headers.authorization, "Bearer ghp_models_key");
    }, { ai: undefined });
  } finally {
    outside.restore();
  }
});

test("C16: the call is refused for any endpoint its route can reach that is not approved, and only for those", async () => {
  const provider = await fakeProvider();
  const outside = spyOnOutsideWorld();
  try {
    await withServer(async (server, client) => {
      const bookId = await seededBook(client);
      const admin = await adminLogin(server);
      await approve(admin, provider.origin);
      const config = aiConfigFor(provider);
      config.aiIntegrations.push({ id: "b", name: "Backup", provider: "openai", endpoint: "https://backup.example/v1", apiKey: "backup-key", chatModels: [{ id: "m", name: "gpt-test", capabilities: ["default"] }] });
      // Only the autopilot's own route reaches the backup; the director's route does not.
      config.taskRouting = {
        autopilot: { primary: { integrationId: "p", model: "gpt-test" }, fallbacks: [{ integrationId: "b", model: "gpt-test" }] },
        director: { primary: { integrationId: "p", model: "gpt-test" } },
      };
      assert.deepEqual((await client.putAiConfig(config)).pendingApproval, ["https://backup.example/v1"]);
      assert.equal((await client.askDirector(bookId, { target: { kind: "book" } })).opinion.verdict, "revise", "the director never reaches the backup, so its call goes");
      assert.equal(provider.requests.length, 1);

      await client.startAutopilot(bookId, ONE_CHAPTER);
      const snapshot = await finished(client, bookId);
      assert.equal(snapshot.state.status, "error", "the autopilot's route has a fallback that is not approved: nothing is attempted");
      assert.match(snapshot.state.message, /https:\/\/backup\.example\/v1/);
      assert.equal(provider.requests.length, 1, "not even the approved primary was called");
      assert.deepEqual(outside.reached, []);

      await approve(admin, "https://backup.example/v1");
      await client.startAutopilot(bookId, ONE_CHAPTER);
      assert.equal((await finished(client, bookId)).state.status, "completed");
    }, { ai: undefined });
  } finally {
    outside.restore();
    await provider.close();
  }
});

test("C16: a fallback in another account that this host cannot acknowledge is never called, so it needs no approval either", async () => {
  const provider = await fakeProvider();
  const outside = spyOnOutsideWorld();
  try {
    await withServer(async (server, client) => {
      const bookId = await seededBook(client);
      await approve(await adminLogin(server), provider.origin);
      const config = aiConfigFor(provider);
      config.aiIntegrations.push({ id: "b", name: "Backup", provider: "openai", endpoint: "https://backup.example/v1", apiKey: "backup-key", chatModels: [{ id: "m", name: "gpt-test", capabilities: ["default"] }] });
      config.taskRouting = { director: { primary: { integrationId: "p", model: "gpt-test" }, fallbacks: [{ integrationId: "b", model: "gpt-test" }] } };
      config.fallbackDisclosure = { sameBoundaryOnly: false, requireAcknowledgement: true };
      await client.putAiConfig(config);
      assert.equal((await client.askDirector(bookId, { target: { kind: "book" } })).opinion.verdict, "revise");
      assert.equal(provider.requests.length, 1);
      assert.deepEqual(outside.reached, []);
      config.fallbackDisclosure = { sameBoundaryOnly: true, requireAcknowledgement: false };
      await client.putAiConfig(config);
      assert.equal((await client.askDirector(bookId, { target: { kind: "book" } })).opinion.verdict, "revise", "with sameBoundaryOnly the other account is never a candidate");
      config.fallbackDisclosure = { sameBoundaryOnly: false, requireAcknowledgement: false };
      await client.putAiConfig(config);
      await assert.rejects(() => client.askDirector(bookId, { target: { kind: "book" } }), (error) => error.code === "ai_not_approved" && /backup\.example/.test(error.message), "without a policy the fallback is a candidate, and it is not approved");
    }, { ai: undefined });
  } finally {
    outside.restore();
    await provider.close();
  }
});

test("C16: the endpoints that wait are the ones of the configuration sent, and an unconfigured server or an injected AI has none", async () => {
  await withServer(async (_server, client) => {
    assert.equal((await client.aiStatus()).pendingApproval, undefined, "an injected AI port calls nothing");
  });
  await withServer(async (_server, client) => {
    assert.equal((await client.aiStatus()).configured, false);
    assert.equal((await client.aiStatus()).pendingApproval, undefined);
    const status = await client.putAiConfig({ aiIntegrations: [openai({ id: "a" }), openai({ id: "b", name: "Again" })] });
    assert.deepEqual(status.pendingApproval, ["https://api.openai.com/v1"], "two integrations on one base wait once");
  }, { ai: undefined });
});

// ---------------------------------------------------------------------------------------------
// What the owner types and approves
// ---------------------------------------------------------------------------------------------

test("C16: the owner's approvals are kept as typed (origin, or origin and path) in a canonical spelling, and refused when they cannot be one", async () => {
  await withServer(async (server) => {
    const admin = await adminLogin(server);
    const saved = await admin.call("POST", "/admin/api/network", { allowedAiBases: ["https://API.openai.com/v1/", "https://llm.example", "https://llm.example/", "http://127.0.0.1:11434/v1?x=1#y"] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual((await admin.call("GET", "/admin/api/status")).body.allowedAiBases, ["https://api.openai.com/v1", "https://llm.example", "http://127.0.0.1:11434/v1"]);
    for (const wrong of ["http://example.com/v1", "https://user:pass@example.com/v1", "ftp://example.com", "not a url"]) {
      const refused = await admin.call("POST", "/admin/api/network", { allowedAiBases: [wrong] });
      assert.equal(refused.status, 422, wrong);
    }
    assert.deepEqual((await admin.call("GET", "/admin/api/status")).body.allowedAiBases, ["https://api.openai.com/v1", "https://llm.example", "http://127.0.0.1:11434/v1"], "a refusal changes nothing");
    const approved = await admin.call("POST", "/admin/api/ai/approve", { bases: ["https://x.example/v1/"] });
    assert.equal(approved.status, 200);
    assert.equal(server.data.config.allowedAiBases.at(-1), "https://x.example/v1");
    assert.equal((await admin.call("POST", "/admin/api/ai/approve", { bases: ["http://example.com"] })).status, 422);
  });
});

test("C16: dismissing an endpoint that waits removes it from the panel, whatever form the owner sends", async () => {
  await withServer(async (server, client) => {
    await client.putAiConfig({ aiIntegrations: [openai()] });
    const admin = await adminLogin(server);
    assert.deepEqual((await admin.call("GET", "/admin/api/status")).body.pendingAiBases, ["https://api.openai.com/v1"]);
    assert.equal((await admin.call("POST", "/admin/api/ai/dismiss", { bases: ["https://API.openai.com/v1/"] })).status, 200);
    assert.deepEqual((await admin.call("GET", "/admin/api/status")).body.pendingAiBases, []);
    assert.deepEqual(server.data.config.allowedAiBases, [], "dismissing is not approving");
    assert.deepEqual((await client.aiStatus()).pendingApproval, ["https://api.openai.com/v1"], "the API still says what the configuration needs");
  }, { ai: undefined });
});

test("C16: removing an approval puts the bases it covered back among those that wait, so the panel says what the next run will stop on", async () => {
  await withServer(async (server, client) => {
    await client.putAiConfig({ aiIntegrations: [openai()] });
    const admin = await adminLogin(server);
    await approve(admin, "https://api.openai.com");
    assert.deepEqual((await admin.call("GET", "/admin/api/status")).body.pendingAiBases, []);
    assert.equal((await admin.call("POST", "/admin/api/network", { allowedAiBases: [] })).status, 200);
    assert.deepEqual((await admin.call("GET", "/admin/api/status")).body.pendingAiBases, ["https://api.openai.com/v1"]);
    assert.deepEqual(server.data.config.pendingAiBases, ["https://api.openai.com/v1"]);
    assert.deepEqual((await client.aiStatus()).pendingApproval, ["https://api.openai.com/v1"]);
    // Keeping it, or approving something else, leaves nothing waiting for it.
    assert.equal((await admin.call("POST", "/admin/api/network", { allowedAiBases: ["https://api.openai.com/v1/"] })).status, 200);
    assert.deepEqual((await admin.call("GET", "/admin/api/status")).body.pendingAiBases, []);
  }, { ai: undefined });
});

test("C16: a configuration saved by an earlier version (default provider, nothing waiting) is listed for approval when the server starts", async () => {
  await withServer(async (server, client, dataDir) => {
    // What 0.1.3 left behind: an AI configuration whose default provider never reached the waiting list.
    await server.data.saveAiConfig({ aiIntegrations: [openai()] });
    await server.data.updateConfig((config) => {
      config.pendingAiBases = ["https://api.openai.com", "https://old.example"];
    });
    await server.close();
    const again = await testing.startNarrariumServer({ dataDir, port: 0, adminPort: 0, supervised: false, checkRelease: noRelease, tunnel: { findBinary: () => undefined, detectOtherConnectors: async () => [] } });
    try {
      assert.deepEqual(again.data.config.pendingAiBases, ["https://old.example", "https://api.openai.com/v1"], "the old origin that the precise base replaces is gone; an unrelated one stays");
      const admin = await adminLogin(again);
      assert.deepEqual((await admin.call("GET", "/admin/api/status")).body.pendingAiBases, ["https://old.example", "https://api.openai.com/v1"]);
    } finally {
      await again.close();
    }
  }, { ai: undefined });
});

// ---------------------------------------------------------------------------------------------
// The guard in the network layer is what it was
// ---------------------------------------------------------------------------------------------

test("C16: the outbound guard still decides by origin: an approval with a path opens its origin, and no other", async () => {
  const hit = [];
  const target = http.createServer((request, response) => {
    hit.push(request.url);
    request.resume();
    response.end("ok");
  });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  const { port } = target.address();
  const original = globalThis.fetch;
  const restore = testing.installOutboundNetwork(() => [`http://127.0.0.1:${port}/v1`]);
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/chat/completions`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/elsewhere`)).status, 200, "the guard compares origins, as it always did");
    await assert.rejects(() => fetch("https://other.example/v1"), (error) => error.code === "not_approved");
    assert.deepEqual(hit, ["/v1/chat/completions", "/elsewhere"]);
  } finally {
    restore();
    assert.equal(globalThis.fetch, original);
    await new Promise((resolve) => {
      target.close(() => resolve());
      target.closeAllConnections();
    });
  }
});

test("C16: both layers agree in production: with the outbound guard installed, an approval with a path lets the call through both, and an endpoint that is not approved never gets as far as the guard", async () => {
  const provider = await fakeProvider();
  try {
    await withServer(async (server) => {
      const realFetch = globalThis.fetch;
      // The test's own requests to the server must not go through the guard that the server's process wears.
      const direct = new NarrariumServerClient({ baseUrl: server.url, token: (await server.auth.issue("direct", ["read", "write", "run"])).token, fetch: (input, init) => realFetch(input, init) });
      const bookId = await seededBook(direct);
      await direct.putAiConfig(aiConfigFor(provider));
      const guarded = async (action) => {
        const restore = testing.installOutboundNetwork(server.allowedBases);
        try {
          return await action();
        } finally {
          restore();
        }
      };
      await guarded(() => assert.rejects(() => direct.askDirector(bookId, { target: { kind: "book" } }), (error) => error.status === 412 && error.code === "ai_not_approved", "refused before the network is asked"));
      assert.equal(provider.requests.length, 0);
      await approve(await adminLogin(server), provider.url);
      const opinion = await guarded(() => direct.askDirector(bookId, { target: { kind: "book" } }));
      assert.equal(opinion.opinion.verdict, "revise", "approved with its path: the guard opens the origin, and the call is made");
      assert.equal(provider.requests.length, 1);
      assert.equal(provider.requests[0].headers.authorization, "Bearer sk-test-key-0123456789");
    }, { ai: undefined });
  } finally {
    await provider.close();
  }
});

test("S3: the server announces that it keeps a spending record, for clients that want to know before they ask", async () => {
  await withServer(async (server) => {
    const info = await (await fetch(`${server.url}/api/v1/info`)).json();
    assert.ok(info.features.includes("spend"));
    assert.ok(info.features.includes("autopilot"), "and nothing else was taken away");
  });
});

test("C16: the panel's box of approved endpoints says that a path may follow the origin, in both languages", async () => {
  await withServer(async (server, client) => {
    await client.putAiConfig({ aiIntegrations: [openai()] });
    const html = await (await fetch(`${server.adminUrl}/`)).text();
    const script = await (await fetch(`${server.adminUrl}/admin.js`)).text();
    assert.match(html, /id="net-ai"/);
    assert.match(script, /one address per line/, "the box of approved endpoints says that a path may follow the origin");
    assert.match(script, /un indirizzo per riga/, "in Italian too");
    assert.doesNotMatch(script, /one origin per line/);
  }, { ai: undefined });
});
