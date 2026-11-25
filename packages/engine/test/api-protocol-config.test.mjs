import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";

// A model may be asked through the Responses API instead of Chat Completions (`apiProtocol`), and may have an address of its own (`endpointUrl`) that is used exactly as it was written. Both are the
// author's words for the model: the configuration keeps them (and the settings of before, which say neither, are what they were), the candidate that the router resolves carries them, and the safe
// view that a personal server shows says where the requests go without ever saying what the query of the address holds.

const {
  DEFAULT_AZURE_API_VERSION,
  buildChatRequest,
  effectiveApiProtocol,
  modelRequestTarget,
  DEFAULT_AZURE_RESPONSES_API_VERSION,
  azureVersionHasResponses,
  describeUrl,
  effectiveApiVersion,
  effectiveResponsesApiVersion,
  endpointUrlHasSecret,
  endpointUrlProblem,
  endpointUrlSecretKeys,
  looksLikeResponsesUrl,
  normalizeApiProtocol,
  normalizeEndpointUrl,
  pickAiRuntimeConfig,
  redactAiRuntimeConfig,
  resolveAiCandidates,
} = engine;

const azure = (extra = {}) => ({ id: "az", name: "Azure GW", provider: "azure_openai", endpoint: "https://res.openai.azure.com", apiKey: "k-azure-secret-123456", ...extra });
const model = (name, extra = {}) => ({ id: name, name, capabilities: ["default"], ...extra });
const configOf = (models, integration = {}) => pickAiRuntimeConfig({ aiIntegrations: [azure({ chatModels: models, ...integration })], taskRouting: { autopilot: { primary: { integrationId: "az", model: models[0].name }, fallbacks: [] } } });

test("the protocol is `responses` exactly, and nothing for any other word: what no value means is Chat Completions, so the settings of before are what they were", () => {
  assert.equal(normalizeApiProtocol("responses"), "responses");
  for (const value of ["chat-completions", "Responses", "response", "", 1, null, undefined, true, {}]) assert.equal(normalizeApiProtocol(value), undefined, String(value));
  assert.deepEqual(engine.AI_API_PROTOCOLS, ["chat-completions", "responses"]);
  const config = configOf([model("a"), model("b", { apiProtocol: "chat-completions" }), model("c", { apiProtocol: "responses" })]);
  assert.deepEqual(config.aiIntegrations[0].chatModels.map((entry) => "apiProtocol" in entry), [false, false, true]);
  assert.equal(config.aiIntegrations[0].chatModels[2].apiProtocol, "responses");
});

test("an address of a model is kept exactly as it was written, trimmed, when it is an http or https address with no credentials; anything else is no value", () => {
  const written = "  https://oai-gw-002.openai.azure.com/openai/responses?api-version=2025-04-01-preview  ";
  assert.equal(normalizeEndpointUrl(written), "https://oai-gw-002.openai.azure.com/openai/responses?api-version=2025-04-01-preview");
  assert.equal(normalizeEndpointUrl("http://127.0.0.1:11434/v1/responses"), "http://127.0.0.1:11434/v1/responses");
  assert.equal(normalizeEndpointUrl("https://x.test/a%20b/c?x=1&y=%2F#frag"), "https://x.test/a%20b/c?x=1&y=%2F#frag", "nothing is rewritten");
  for (const value of ["", "   ", "not a url", "ftp://x.test/responses", "javascript:alert(1)", "https://user:pass@x.test/responses", "https://user@x.test/responses", "//x.test/responses", 5, null, undefined, {}]) assert.equal(normalizeEndpointUrl(value), undefined, String(value));
  assert.equal(endpointUrlProblem("not a url"), "invalid");
  assert.equal(endpointUrlProblem("ftp://x.test/responses"), "scheme");
  assert.equal(endpointUrlProblem("https://user:pass@x.test/responses"), "credentials");
  assert.equal(endpointUrlProblem(""), undefined, "no address is no problem: the model has none of its own");
  assert.equal(endpointUrlProblem("https://x.test/responses"), undefined);
  const config = configOf([model("a", { endpointUrl: written }), model("b", { endpointUrl: "https://user:pass@x.test/r" }), model("c")]);
  assert.deepEqual(config.aiIntegrations[0].chatModels.map((entry) => entry.endpointUrl), ["https://oai-gw-002.openai.azure.com/openai/responses?api-version=2025-04-01-preview", undefined, undefined]);
  assert.ok(config.aiIntegrations[0].chatModels.slice(1).every((entry) => !("endpointUrl" in entry)));
});

test("the settings of before round trip: a model that says neither has neither key, through the JSON a configuration is saved as", () => {
  const config = configOf([model("a"), model("b", { apiProtocol: "responses", endpointUrl: "https://x.test/v1/responses" })]);
  const saved = JSON.parse(JSON.stringify(config));
  const again = pickAiRuntimeConfig(saved);
  assert.deepEqual(again.aiIntegrations[0].chatModels.map((entry) => [entry.apiProtocol, entry.endpointUrl]), [[undefined, undefined], ["responses", "https://x.test/v1/responses"]]);
  assert.ok(!("apiProtocol" in again.aiIntegrations[0].chatModels[0]) && !("endpointUrl" in again.aiIntegrations[0].chatModels[0]));
});

test("what an address says, and nothing else: its host and its path, never its query or the credentials; it is how an address is shown", () => {
  assert.equal(describeUrl("https://oai-gw-002.openai.azure.com/openai/responses?api-version=2025-04-01-preview"), "oai-gw-002.openai.azure.com/openai/responses");
  assert.equal(describeUrl("http://127.0.0.1:11434/v1/responses/"), "127.0.0.1:11434/v1/responses", "the port is part of the host; a closing slash is not part of the path");
  assert.equal(describeUrl("https://x.test/v1/responses?key=SECRET&sig=ALSO#f"), "x.test/v1/responses");
  assert.equal(describeUrl("https://x.test"), "x.test");
  for (const value of ["", "nope", "ftp://x.test/a", "https://u:p@x.test/a", null, undefined, 3]) assert.equal(describeUrl(value), undefined, String(value));
});

test("an address that ends with /responses is the Responses API's, and a query with a key in it is said before it is saved", () => {
  for (const value of ["https://x.test/v1/responses", "https://x.test/openai/responses?api-version=2025-04-01-preview", "https://x.test/openai/v1/responses/", "http://localhost:1234/v1/RESPONSES"]) assert.equal(looksLikeResponsesUrl(value), true, value);
  for (const value of ["https://x.test/v1/chat/completions", "https://x.test/v1/responses/abc", "https://x.test/responses.json", "", "nope", null]) assert.equal(looksLikeResponsesUrl(value), false, String(value));
  for (const value of ["https://x.test/r?key=abc", "https://x.test/r?api-key=abc", "https://x.test/r?API_KEY=abc", "https://x.test/r?a=1&sig=abc", "https://x.test/r?code=abc", "https://x.test/r?token=abc", "https://x.test/r?access_token=abc"]) assert.equal(endpointUrlHasSecret(value), true, value);
  for (const value of ["https://x.test/r?api-version=2025-04-01-preview", "https://x.test/r", "https://x.test/r?model=a&stream=1", "nope", null]) assert.equal(endpointUrlHasSecret(value), false, String(value));
  assert.deepEqual(endpointUrlSecretKeys("https://x.test/r?a=1&key=abc&sig=2&key=3&Code=4&api-version=v1"), ["key", "sig", "Code"], "the names as they are written, in order, each once");
  assert.deepEqual(endpointUrlSecretKeys("https://user:pass@x.test/r?key=abc"), [], "an address that is no address has none");
  assert.deepEqual(endpointUrlSecretKeys("https://x.test/r"), []);
});

test("the version of a request to the Responses API: the v1 API, the model's own word, the integration's when it has the Responses API, else the one of the portal's playground", () => {
  assert.equal(DEFAULT_AZURE_RESPONSES_API_VERSION, "2025-04-01-preview");
  assert.deepEqual(["v1", "preview", "2025-03-01-preview", "2025-04-01-preview", "2026-01-01", "V1"].map(azureVersionHasResponses), [true, true, true, true, true, true]);
  assert.deepEqual(["2024-10-21", "2025-01-01-preview", "2025-02-28", "", "  ", "x", undefined].map(azureVersionHasResponses), [false, false, false, false, false, false, false]);
  assert.equal(effectiveResponsesApiVersion(azure({ endpoint: "https://res.openai.azure.com/openai/v1/", apiVersion: "2024-10-21" }), { apiVersion: "2025-01-01" }), "v1");
  assert.equal(effectiveResponsesApiVersion(azure(), { apiVersion: " 2025-03-01-preview " }), "2025-03-01-preview", "the model's own, whatever it is");
  assert.equal(effectiveResponsesApiVersion(azure(), { apiVersion: "2024-10-21" }), "2024-10-21", "the author's word for the model is obeyed, even one that predates the API");
  assert.equal(effectiveResponsesApiVersion(azure({ apiVersion: "2025-05-01-preview" }), {}), "2025-05-01-preview", "an integration whose version has the Responses API");
  assert.equal(effectiveResponsesApiVersion(azure({ apiVersion: "2024-10-21" }), {}), DEFAULT_AZURE_RESPONSES_API_VERSION, "an integration that keeps an older version for its chat models is not made to ask the Responses API with it");
  assert.equal(effectiveResponsesApiVersion(azure(), null), DEFAULT_AZURE_RESPONSES_API_VERSION);
  assert.equal(effectiveResponsesApiVersion(azure(), { endpointUrl: "https://x.test/r" }), undefined, "an address of its own has no version of ours");
  assert.equal(effectiveResponsesApiVersion({ provider: "openai", endpoint: "https://x.test/v1" }, { apiVersion: "2025-05-01" }), undefined);
  // The version of Chat Completions is not changed by any of it, except that an address of its own has none.
  assert.equal(effectiveApiVersion(azure(), {}), DEFAULT_AZURE_API_VERSION);
  assert.equal(effectiveApiVersion(azure(), { endpointUrl: "https://x.test/r" }), undefined);
});

test("the candidate that the router resolves carries the protocol and the address, and one that says neither has neither", () => {
  const config = configOf([model("a", { apiProtocol: "responses", endpointUrl: "https://x.test/openai/responses?api-version=2025-04-01-preview" }), model("b")]);
  const [first] = resolveAiCandidates(config, "autopilot");
  assert.equal(first.apiProtocol, "responses");
  assert.equal(first.endpointUrl, "https://x.test/openai/responses?api-version=2025-04-01-preview");
  const plain = resolveAiCandidates({ ...config, taskRouting: { autopilot: { primary: { integrationId: "az", model: "b" }, fallbacks: [] } } }, "autopilot")[0];
  assert.ok(!("apiProtocol" in plain) && !("endpointUrl" in plain));
});

test("the safe view says the protocol and where a model's requests go (host and path), and never the query of its address or a key", () => {
  const secret = "SUPER-SECRET-QUERY-KEY-987654";
  const config = configOf([model("a", { apiProtocol: "responses", endpointUrl: `https://oai.test/openai/responses?api-version=2025-04-01-preview&key=${secret}` }), model("b")]);
  const view = redactAiRuntimeConfig(config);
  assert.deepEqual(view.integrations[0].models.map((entry) => [entry.apiProtocol, entry.endpointUrl]), [["responses", "oai.test/openai/responses"], [undefined, undefined]]);
  assert.ok(!JSON.stringify(view).includes(secret), "no secret in what a server shows");
  assert.ok(!JSON.stringify(view).includes("k-azure-secret-123456"), "nor the key of the integration");
});

const ask = { system: "Be brief.", user: "Say ok." };

test("a model with an address of its own is sent exactly there, query included, with the key of its integration, whatever the endpoint and the API versions of the model and of its integration say", () => {
  const own = "https://oai-gw-002.openai.azure.com/openai/responses?api-version=2025-04-01-preview";
  const built = buildChatRequest({ integration: azure({ apiVersion: "2024-10-21" }), model: "gpt-5.2", apiVersion: "2023-05-15", endpointUrl: own }, ask);
  assert.equal(built.url, own, "not one character of it is changed");
  assert.equal(built.headers["api-key"], "k-azure-secret-123456", "Azure takes its key in the api-key header, whatever the address");
  assert.equal(built.apiVersion, undefined, "the versions are not used for an address of the model's own");
  assert.equal(buildChatRequest({ integration: azure(), model: "gpt-5.2" }, ask).url, "https://res.openai.azure.com/openai/deployments/gpt-5.2/chat/completions?api-version=2024-10-21", "a model without one is built as it always was");
  const openai = buildChatRequest({ integration: { id: "o", name: "OpenAI gateway", provider: "openai", endpoint: "https://api.openai.com/v1", apiKey: "sk-openai-secret-987654" }, model: "gpt-4.1", endpointUrl: "http://127.0.0.1:8080/custom/chat?x=1" }, ask);
  assert.equal(openai.url, "http://127.0.0.1:8080/custom/chat?x=1");
  assert.equal(openai.headers.authorization, "Bearer sk-openai-secret-987654");
  assert.ok(!("api-key" in openai.headers));
  const keyless = buildChatRequest({ integration: { id: "l", name: "Local", provider: "openai", endpoint: "http://127.0.0.1:1234/v1" }, model: "local", endpointUrl: "http://127.0.0.1:1234/v1/chat/completions" }, ask);
  assert.ok(!("authorization" in keyless.headers) && !("api-key" in keyless.headers), "an integration without a key sends none");
  const refused = buildChatRequest({ integration: azure(), model: "gpt-5.2", endpointUrl: "https://user:pass@x.test/r" }, ask);
  assert.equal(refused.url, "https://res.openai.azure.com/openai/deployments/gpt-5.2/chat/completions?api-version=2024-10-21", "an address with credentials is no address: the request is built from the integration, version included");
});

test("where the requests of a model go, for an editor: the address, the protocol and the version it carries, or why there is none", () => {
  const target = (integration, entry) => modelRequestTarget(integration, { name: "gpt-5.2", ...entry });
  assert.deepEqual(target(azure(), {}), { protocol: "chat-completions", url: "https://res.openai.azure.com/openai/deployments/gpt-5.2/chat/completions?api-version=2024-10-21", apiVersion: "2024-10-21", own: false });
  assert.deepEqual(target(azure({ apiVersion: "2024-10-21" }), { apiProtocol: "responses" }), { protocol: "responses", url: "https://res.openai.azure.com/openai/responses?api-version=2025-04-01-preview", apiVersion: "2025-04-01-preview", own: false }, "the version of an integration that predates the Responses API is not used for it");
  assert.deepEqual(target(azure({ apiVersion: "2025-05-01-preview" }), { apiProtocol: "responses" }), { protocol: "responses", url: "https://res.openai.azure.com/openai/responses?api-version=2025-05-01-preview", apiVersion: "2025-05-01-preview", own: false });
  assert.deepEqual(target(azure({ apiVersion: "2024-10-21" }), { apiProtocol: "responses", apiVersion: "preview" }), { protocol: "responses", url: "https://res.openai.azure.com/openai/responses?api-version=preview", apiVersion: "preview", own: false });
  assert.deepEqual(target(azure({ endpoint: "https://res.openai.azure.com/openai/v1/" }), { apiProtocol: "responses" }), { protocol: "responses", url: "https://res.openai.azure.com/openai/v1/responses", apiVersion: "v1", own: false }, "the v1 API has one address for every model and no version in it");
  assert.deepEqual(target(azure({ endpoint: "https://res.openai.azure.com/openai/v1/" }), {}), { protocol: "chat-completions", url: "https://res.openai.azure.com/openai/v1/chat/completions", apiVersion: "v1", own: false });
  assert.deepEqual(target({ id: "o", name: "OpenAI", provider: "openai" }, { apiProtocol: "responses" }), { protocol: "responses", url: "https://api.openai.com/v1/responses", own: false });
  assert.deepEqual(target({ id: "o", name: "OpenAI", provider: "openai", endpoint: "http://127.0.0.1:1234/v1/" }, { apiProtocol: "responses" }), { protocol: "responses", url: "http://127.0.0.1:1234/v1/responses", own: false });
  const own = "https://gw.test/openai/responses?api-version=2025-04-01-preview";
  assert.deepEqual(target(azure(), { apiProtocol: "responses", apiVersion: "2025-03-01-preview", endpointUrl: own }), { protocol: "responses", url: own, own: true }, "an address of its own has no version of ours");
  assert.deepEqual(target(azure({ endpoint: "" }), { apiProtocol: "responses" }), { problem: "no-endpoint" });
  assert.deepEqual(target(azure({ endpoint: "" }), { apiProtocol: "responses", endpointUrl: own }), { protocol: "responses", url: own, own: true }, "an address of its own needs no endpoint of the integration");
  const github = { id: "g", name: "GitHub Models", provider: "github_models", apiKey: "ghp_secret_token_123456" };
  assert.equal(target(github, {}).url, "https://models.github.ai/inference/chat/completions");
  assert.deepEqual(target(github, { apiProtocol: "responses" }), { problem: "no-responses-api" }, "GitHub Models has no Responses API");
  assert.equal(target(github, { apiProtocol: "responses", endpointUrl: "https://proxy.test/inference/responses" }).url, "https://proxy.test/inference/responses", "unless the model has an address of its own");
  assert.deepEqual(target({ id: "m", name: "M365", provider: "microsoft365" }, {}), { problem: "provider-unsupported" });
  assert.equal(effectiveApiProtocol({ apiProtocol: "responses" }), "responses");
  assert.equal(effectiveApiProtocol({}), "chat-completions");
  assert.equal(effectiveApiProtocol(null), "chat-completions");
});
