import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AiPromptTooLargeError,
  AiProviderError,
  AiRoutingBudgetError,
  createFetchAi,
  pickAiRuntimeConfig,
  type AiPort,
  type AiRequest,
  type AiResponse,
} from "narrarium-engine";
import { localWorkspaceScope } from "@/account/deviceIdentity";
import { setFallbackAcknowledgementAccountScope } from "@/assistant/fallbackDisclosure";
import { createBrowserAi } from "@/autopilot/browserAi";
import { autopilotRuntime } from "@/autopilot/runtime";
import { forgetServerVerification } from "@/autopilot/serverIdentity";
import { useAutopilotStore } from "@/autopilot/store";
import { useLlmDebugStore } from "@/debug/llmDebugStore";
import { putLocalRepository, removeLocalRepository } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type AIIntegration, type AppSettings, type BookEntry, type ChatModel } from "@/types/settings";
import {
  answer,
  assertProvidersClean,
  createFakeProvider,
  data,
  DONE,
  eventStream,
  failReply,
  hang,
  textReply,
  type ProviderCall,
  type ProviderEndpoint,
  type ProviderReply,
} from "./helpers/fakeProvider";
import { chatModel, compatible, endpointsOf, GITHUB_TOKEN, routed, SCHEMA, settingsOf, type Fixture } from "./helpers/aiFixtures";
import { createFakeIdentity, createFakeNetwork } from "./helpers/fakePersonalServer";

// GitHub Models has no CORS: the browser reaches it through the site's proxy, and only the origin differs from the server's.
vi.mock("@/config/githubModels", () => ({
  GITHUB_MODELS_BASE: "https://models-proxy.example.test",
  GITHUB_MODELS_INFERENCE_URL: "https://models-proxy.example.test/inference",
  GITHUB_MODELS_CATALOG_URL: "https://models-proxy.example.test/catalog/models",
}));

const PROXY = "https://models-proxy.example.test";
const ASK: AiRequest = { capability: "autopilot", label: "autopilot:scene", system: "SYS", user: "USR" };

// ─── The two hosts ──────────────────────────────────────────────────────────

type Outcome = { response: AiResponse } | { error: any };

interface HostRun {
  calls: ProviderCall[];
  /** What the progress listener was given. */
  progress: string[];
  outcome: Promise<Outcome>;
  done: boolean;
}

/** What the personal server does with the configuration it receives: JSON over the wire, picked again, one shared client. */
function serverAi(settings: AppSettings, fetchImpl: typeof fetch): AiPort {
  const received = JSON.parse(JSON.stringify(pickAiRuntimeConfig(settings)));
  return createFetchAi(pickAiRuntimeConfig(received), { fetch: fetchImpl, githubModelsBaseUrl: PROXY });
}

const settled = (promise: Promise<AiResponse>): Promise<Outcome> => promise.then((response) => ({ response }), (error) => ({ error }));

/** Starts one call on a host against a fake provider: the browser's adapter reads the settings store and the global fetch. */
function startHost(host: "browser" | "server", fixtures: Fixture[], settings: AppSettings, request: AiRequest, reply: ProviderReply = answer): HostRun {
  const fake = createFakeProvider(endpointsOf(fixtures), reply, [GITHUB_TOKEN]);
  vi.stubGlobal("fetch", fake.fetch);
  const progress: string[] = [];
  const ask = request.onText ? { ...request, onText: (text: string) => progress.push(text) } : request;
  let port: AiPort;
  if (host === "browser") {
    useSettingsStore.setState({ settings });
    port = createBrowserAi();
  } else {
    port = serverAi(settings, fake.fetch);
  }
  const run: HostRun = { calls: fake.calls, progress, done: false, outcome: undefined as never };
  run.outcome = settled(port.complete(ask)).then((outcome) => { run.done = true; return outcome; });
  return run;
}

async function runHost(host: "browser" | "server", fixtures: Fixture[], settings: AppSettings, request: AiRequest, reply: ProviderReply = answer) {
  const run = startHost(host, fixtures, settings, request, reply);
  return { calls: run.calls, progress: run.progress, outcome: await run.outcome };
}

type Finished = Awaited<ReturnType<typeof runHost>>;

async function runBoth(fixtures: Fixture[], settings: AppSettings, request: AiRequest, reply: ProviderReply = answer) {
  const browser = await runHost("browser", fixtures, settings, request, reply);
  const server = await runHost("server", fixtures, settings, request, reply);
  return { browser, server };
}

/** The request as it went on the wire: where, how, with which headers and body. */
const wire = (calls: ProviderCall[]) => calls.map(({ method, url, headers, rawBody, body }) => ({ method, url, headers, rawBody, body }));

/** What a caller can tell of an outcome. */
function observed(outcome: Outcome) {
  if ("response" in outcome) {
    const { text, json, usage, usageKnown, cost, costKnown, currency, model, provider, integrationId, truncated } = outcome.response;
    return { text, json, usage, usageKnown, cost, costKnown, currency, model, provider, integrationId, truncated };
  }
  const { name, message, status, retryable, transient, retryAfterMs, timedOut, truncated, usage, cost } = outcome.error ?? {};
  return { name, message, status, retryable, transient, retryAfterMs, timedOut, truncated, usage, cost };
}

const errorOf = (outcome: Outcome): any => ("error" in outcome ? outcome.error : undefined);
const responseOf = (outcome: Outcome): AiResponse => (outcome as { response: AiResponse }).response;
const hostsOf = (run: { calls: ProviderCall[] }) => run.calls.map((call) => new URL(call.url).hostname.replace(".example.test", ""));

/** Same settings, same request, same provider: the two hosts must send the same calls and end the same way. */
function expectSameRun(browser: Finished, server: Finished): void {
  expect(wire(browser.calls)).toEqual(wire(server.calls));
  expect(observed(browser.outcome)).toEqual(observed(server.outcome));
  expect(browser.progress).toEqual(server.progress);
}

beforeAll(() => {
  useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });
});

beforeEach(() => {
  localStorage.clear();
  useLlmDebugStore.setState({ entries: [], pending: 0, storageError: null, accountIdentity: null });
  setFallbackAcknowledgementAccountScope(localWorkspaceScope());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setFallbackAcknowledgementAccountScope(null);
  assertProvidersClean();
});

// ─── The same requests on the wire ──────────────────────────────────────────

const FAMILIES = [
  { name: "a normal model", model: "gpt-4o", limit: "max_tokens", temperature: true, margin: 0 },
  { name: "a reasoning model", model: "o3-mini", limit: "max_completion_tokens", temperature: false, margin: 12_000 },
] as const;
type Family = (typeof FAMILIES)[number];

const SHAPES = [
  { name: "text", json: false, tools: true, stream: false },
  { name: "text, streamed", json: false, tools: true, stream: true },
  { name: "json by a forced function call", json: true, tools: true, stream: false },
  { name: "json by a forced function call, with a progress listener", json: true, tools: true, stream: true },
  { name: "json asked in the prompt (the model has no tools)", json: true, tools: false, stream: false },
  { name: "json asked in the prompt, with a progress listener", json: true, tools: false, stream: true },
] as const;
type Shape = (typeof SHAPES)[number];

interface ProviderCase {
  name: string;
  /** The model name the integration is called with. */
  model: (family: Family) => string;
  fixture: (family: Family, models: ChatModel[]) => Fixture;
  url: (model: string) => string;
}

const KEY = { openai: "sk-openai-0123456789abcdef", local: "sk-local-0123456789abcdef", azure: "azure-key-0123456789abcdef", azureV1: "azure-v1-key-0123456789abcdef", github: "github_pat_0123456789abcdefghijklmnopqrstu" };

function single(id: string, integration: Omit<AIIntegration, "id" | "name" | "apiKey" | "chatModels">, apiKey: string, base: string, auth: ProviderEndpoint["auth"], models: ChatModel[]): Fixture {
  return { integration: { id, name: id.toUpperCase(), apiKey, chatModels: models, ...integration }, endpoint: { id, apiKey, base, auth } };
}

const PROVIDERS: ProviderCase[] = [
  {
    name: "openai",
    model: (family) => family.model,
    fixture: (_family, models) => single("oa", { provider: "openai" }, KEY.openai, "https://api.openai.com/v1", "bearer", models),
    url: () => "https://api.openai.com/v1/chat/completions",
  },
  {
    name: "an OpenAI-compatible server at its own endpoint",
    model: (family) => family.model,
    fixture: (_family, models) => single("lm", { provider: "openai", endpoint: "http://127.0.0.1:1234/v1/" }, KEY.local, "http://127.0.0.1:1234/v1", "bearer", models),
    url: () => "http://127.0.0.1:1234/v1/chat/completions",
  },
  {
    name: "azure openai (deployments route)",
    model: () => "deploy-1",
    fixture: (family, models) => single("az", { provider: "azure_openai", endpoint: "https://res.openai.azure.com/", apiVersion: "2024-10-21" }, KEY.azure, "https://res.openai.azure.com", "api-key", models.map((model) => ({ ...model, underlyingModel: family.model }))),
    url: (model) => `https://res.openai.azure.com/openai/deployments/${model}/chat/completions?api-version=2024-10-21`,
  },
  {
    name: "azure openai (/openai/v1)",
    model: () => "deploy-1",
    fixture: (family, models) => single("azv1", { provider: "azure_openai", endpoint: "https://res.openai.azure.com/openai/v1/" }, KEY.azureV1, "https://res.openai.azure.com/openai/v1", "api-key", models.map((model) => ({ ...model, underlyingModel: family.model }))),
    url: () => "https://res.openai.azure.com/openai/v1/chat/completions",
  },
  {
    name: "github models through the proxy",
    model: (family) => `openai/${family.model}`,
    fixture: (_family, models) => single("gh", { provider: "github_models" }, KEY.github, `${PROXY}/inference`, "bearer", models),
    url: () => `${PROXY}/inference/chat/completions`,
  },
];

function expectedBody(family: Family, shape: Shape, model: string) {
  const streamed = shape.stream && !shape.json;
  const asksInThePrompt = shape.json && !shape.tools;
  return {
    model,
    messages: [
      { role: "system", content: asksInThePrompt ? expect.stringMatching(/^SYS\n\nReply with ONLY one JSON object, without code fences or commentary, matching this JSON schema \(result: A result\):\n/) : "SYS" },
      { role: "user", content: "USR" },
    ],
    [family.limit]: (shape.json ? 4096 : 1000) + family.margin,
    ...(family.temperature ? { temperature: 0.4 } : {}),
    ...(shape.json && shape.tools ? { tools: [{ type: "function", function: SCHEMA }], tool_choice: "required" } : {}),
    ...(streamed ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
}

describe("autopilot calls reach the provider exactly as the personal server's do", () => {
  describe.each(PROVIDERS)("$name", (provider) => {
    describe.each(FAMILIES)("with $name", (family) => {
      it.each(SHAPES)("$name", async (shape) => {
        const model = provider.model(family);
        const fixture = provider.fixture(family, [chatModel(model, { supportsToolCalls: shape.tools })]);
        const settings = settingsOf([fixture]);
        const request: AiRequest = { ...ASK, maxOutputTokens: 1000, temperature: 0.4, ...(shape.json ? { json: SCHEMA } : {}), ...(shape.stream ? { onText: () => undefined } : {}) };

        const { browser, server } = await runBoth([fixture], settings, request);

        expectSameRun(browser, server);
        expect(browser.calls).toHaveLength(1);
        const [call] = browser.calls;
        const streamed = shape.stream && !shape.json;
        expect(call.method).toBe("POST");
        expect(call.url).toBe(provider.url(model));
        expect(call.headers).toEqual({
          "content-type": "application/json",
          accept: streamed ? "text/event-stream" : "application/json",
          ...(fixture.endpoint.auth === "api-key" ? { "api-key": fixture.endpoint.apiKey } : { authorization: `Bearer ${fixture.endpoint.apiKey}` }),
        });
        expect(call.body).toEqual(expectedBody(family, shape, model));
        if (shape.json && !shape.tools) expect(call.body.messages[0].content).toContain(JSON.stringify(SCHEMA.parameters));

        const response = responseOf(browser.outcome);
        expect(response.text).toBe(shape.json ? JSON.stringify({ ok: true }) : "The scene.");
        if (shape.json) expect(response.json).toEqual({ ok: true });
        expect(response.model).toBe(model);
        expect(response.provider).toBe(fixture.integration.provider);
        expect(response.usage).toEqual({ inputTokens: 120, outputTokens: 30, cachedInputTokens: 20 });
        expect(response.cost).toBeCloseTo((100 * 2 + 20 * 1 + 30 * 8) / 1_000_000, 10);
        if (streamed) expect(browser.progress[browser.progress.length - 1]).toBe("The scene.");
      });
    });
  });

  it("goes through the site's proxy for GitHub Models where the server uses the provider directly: only the origin differs", async () => {
    const fixture = single("gh", { provider: "github_models" }, KEY.github, `${PROXY}/inference`, "bearer", [chatModel("openai/gpt-4o")]);
    const settings = settingsOf([fixture]);
    const browser = await runHost("browser", [fixture], settings, ASK);
    const direct = createFakeProvider([{ ...fixture.endpoint, base: "https://models.github.ai/inference" }], answer);
    // The personal server builds its client from the configuration alone, without the browser's proxy.
    await createFetchAi(pickAiRuntimeConfig(JSON.parse(JSON.stringify(pickAiRuntimeConfig(settings)))), { fetch: direct.fetch }).complete(ASK);

    expect(browser.calls[0].url).toBe(`${PROXY}/inference/chat/completions`);
    expect(direct.calls[0].url).toBe("https://models.github.ai/inference/chat/completions");
    expect(browser.calls[0].headers).toEqual(direct.calls[0].headers);
    expect(browser.calls[0].rawBody).toBe(direct.calls[0].rawBody);
  });
});

// ─── The same outcomes ──────────────────────────────────────────────────────

describe("autopilot calls end as they do on the personal server", () => {
  it("sends the temperature the task asks for, except to a reasoning model", async () => {
    for (const [model, expected] of [["gpt-4o", 0.7], ["o3-mini", undefined]] as const) {
      const fixture = compatible("a", [chatModel(model)]);
      const { browser, server } = await runBoth([fixture], settingsOf([fixture]), { ...ASK, temperature: 0.7 });
      expectSameRun(browser, server);
      expect(browser.calls[0].body.temperature).toBe(expected);
      expect("temperature" in browser.calls[0].body).toBe(expected !== undefined);
    }
    const fixture = compatible("a", [chatModel("gpt-4o")]);
    const { browser } = await runBoth([fixture], settingsOf([fixture]), ASK);
    expect("temperature" in browser.calls[0].body, "no temperature when the task sets none").toBe(false);
  });

  it.each([
    ["a normal model, text", "gpt-4o", {}, {}, "max_tokens", 1_000],
    ["a normal model, structured reply: the floor", "gpt-4o", { json: SCHEMA }, {}, "max_tokens", 4_096],
    ["a reasoning model, text: its reasoning margin on top", "o3-mini", {}, {}, "max_completion_tokens", 13_000],
    ["a reasoning model, structured reply: floor and margin", "o3-mini", { json: SCHEMA }, {}, "max_completion_tokens", 16_096],
    ["the second try after a reply cut while reasoning: three times the limit", "o3-mini", { outputBoost: 3 }, {}, "max_completion_tokens", 39_000],
    ["never above the model's own maximum", "o3-mini", {}, { maxOutputTokens: 8_000 }, "max_completion_tokens", 8_000],
  ] as const)("limits the output: %s", async (_name, model, extraRequest, extraModel, key, expected) => {
    const fixture = compatible("a", [chatModel(model, extraModel as Partial<ChatModel>)]);
    const { browser, server } = await runBoth([fixture], settingsOf([fixture]), { ...ASK, maxOutputTokens: 1_000, ...extraRequest });
    expectSameRun(browser, server);
    expect(browser.calls[0].body[key]).toBe(expected);
    expect(Object.keys(browser.calls[0].body).filter((name) => name === "max_tokens" || name === "max_completion_tokens")).toEqual([key]);
  });

  it("asks once per candidate: no hidden retries before the runner decides", async () => {
    const a = compatible("a");
    const b = compatible("b");
    const { browser, server } = await runBoth([a, b], routed([a, b]), ASK, () => failReply(500, "the model is down"));
    expectSameRun(browser, server);
    expect(hostsOf(browser)).toEqual(["a", "b"]);
    expect(errorOf(browser.outcome)).toBeInstanceOf(AiProviderError);
    expect(errorOf(browser.outcome).retryable).toBe(true);
    expect(errorOf(browser.outcome).message).toMatch(/HTTP 500/);
  });

  it("hands the runner the provider's Retry-After on a rate limit or an overload, and asks only once", async () => {
    const fixture = compatible("a");
    for (const [status, header, expected] of [[429, "7", 7_000], [503, "120", 120_000], [429, "3600", 300_000]] as const) {
      const { browser, server } = await runBoth([fixture], settingsOf([fixture]), ASK, () => failReply(status, "slow down", { "retry-after": header }));
      expectSameRun(browser, server);
      expect(browser.calls).toHaveLength(1);
      const error = errorOf(browser.outcome);
      expect(error).toBeInstanceOf(AiProviderError);
      expect(error).toMatchObject({ status, retryable: true, transient: true, retryAfterMs: expected });
    }
    const { browser } = await runBoth([fixture], settingsOf([fixture]), ASK, () => failReply(500, "oops", { "retry-after": "10" }));
    expect(errorOf(browser.outcome).retryAfterMs, "Retry-After counts on a 429 or a 503 only").toBeUndefined();
  });

  it("does not repeat a request the provider refused for good", async () => {
    const fixture = compatible("a");
    const { browser, server } = await runBoth([fixture], settingsOf([fixture]), ASK, () => failReply(401, "Incorrect API key provided"));
    expectSameRun(browser, server);
    expect(browser.calls).toHaveLength(1);
    expect(errorOf(browser.outcome)).toMatchObject({ status: 401, retryable: false });
  });

  describe("the privacy policy for fallbacks", () => {
    const local = compatible("local", [chatModel("qwen")]);
    const cloud = compatible("cloud", [chatModel("gpt-4o")]);
    const reply: ProviderReply = (call) => (call.url.includes("local.example.test") ? failReply(500, "local model crashed") : textReply("the manuscript was sent here"));

    it("without a policy a failing primary still falls back to the other account", async () => {
      const { browser, server } = await runBoth([local, cloud], routed([local, cloud]), ASK, reply);
      expectSameRun(browser, server);
      expect(hostsOf(browser)).toEqual(["local", "cloud"]);
      expect(responseOf(browser.outcome).text).toBe("the manuscript was sent here");
    });

    it("sameBoundaryOnly: the manuscript never leaves the primary's account, and the error says why", async () => {
      const settings = routed([local, cloud], { fallbackDisclosure: { sameBoundaryOnly: true, requireAcknowledgement: false } });
      const { browser, server } = await runBoth([local, cloud], settings, ASK, reply);
      expectSameRun(browser, server);
      expect(hostsOf(browser)).toEqual(["local"]);
      const error = errorOf(browser.outcome);
      expect(error).toBeInstanceOf(AiProviderError);
      expect(error.message).toMatch(/local model crashed/);
      expect(error.message).toMatch(/sameBoundaryOnly/);
    });

    it("requireAcknowledgement without the author's confirmation: nothing is sent to the other account, in either host", async () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      const settings = routed([local, cloud], { fallbackDisclosure: { sameBoundaryOnly: false, requireAcknowledgement: true } });
      const { browser, server } = await runBoth([local, cloud], settings, ASK, reply);

      expect(wire(browser.calls)).toEqual(wire(server.calls));
      expect(hostsOf(browser)).toEqual(["local"]);
      expect(hostsOf(server)).toEqual(["local"]);
      // The browser can ask: the author said no, so the run is cancelled (a pause) rather than failed.
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(String(confirm.mock.calls[0][0])).toContain("LOCAL");
      expect(String(confirm.mock.calls[0][0])).toContain("CLOUD");
      expect(errorOf(browser.outcome).name).toBe("AbortError");
      // The server cannot ask: it keeps the content where it is (fail closed) and names the setting.
      expect(errorOf(server.outcome)).toBeInstanceOf(AiProviderError);
      expect(errorOf(server.outcome).message).toMatch(/requireAcknowledgement/);
    });

    it("a fallback in the same account never asks anything", async () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      const same = compatible("same", [chatModel("big"), chatModel("small")]);
      const settings = settingsOf([same], {
        taskRouting: { autopilot: { primary: { integrationId: "same", model: "big" }, fallbacks: [{ integrationId: "same", model: "small" }] } },
        fallbackDisclosure: { sameBoundaryOnly: true, requireAcknowledgement: true },
      });
      const { browser, server } = await runBoth([same], settings, ASK, (call) => (call.body.model === "big" ? failReply(500, "big failed") : textReply("small answered")));
      expectSameRun(browser, server);
      expect(browser.calls.map((call) => call.body.model)).toEqual(["big", "small"]);
      expect(confirm).not.toHaveBeenCalled();
    });
  });

  describe("limits of one routed call", () => {
    it("keeps estimated attempts while they fit maxTokenAttempts", async () => {
      const chain = ["n0", "n1", "n2"].map((id) => compatible(id));
      const settings = routed(chain, { routingExecution: { ...DEFAULT_SETTINGS.routingExecution, maxTokenAttempts: 1_500 } });
      const { browser, server } = await runBoth(chain, settings, { ...ASK, maxOutputTokens: 500 }, () => failReply(503, "down"));
      expectSameRun(browser, server);
      expect(hostsOf(browser), "two attempts of about 510 tokens fit in 1500, a third does not").toEqual(["n0", "n1"]);
    });

    it("refuses a first attempt that alone exceeds maxTokenAttempts, before anything is sent", async () => {
      const chain = ["n0", "n1"].map((id) => compatible(id));
      const settings = routed(chain, { routingExecution: { ...DEFAULT_SETTINGS.routingExecution, maxTokenAttempts: 1_000 } });
      const { browser, server } = await runBoth(chain, settings, { ...ASK, maxOutputTokens: 4_000 });
      expectSameRun(browser, server);
      expect(browser.calls).toHaveLength(0);
      expect(errorOf(browser.outcome)).toBeInstanceOf(AiRoutingBudgetError);
      expect(errorOf(browser.outcome)).toMatchObject({ retryable: false });
      expect(errorOf(browser.outcome).message).toMatch(/first routing candidate exceeds/);
    });

    it("refuses a first attempt that alone would cost more than maxEstimatedCost", async () => {
      const dear = compatible("dear", [chatModel("model-dear", { pricing: { inputPerMTok: 1_000, outputPerMTok: 1_000 } })]);
      const settings = settingsOf([dear], { routingExecution: { ...DEFAULT_SETTINGS.routingExecution, maxEstimatedCost: 0.01 } });
      const { browser, server } = await runBoth([dear], settings, { ...ASK, maxOutputTokens: 400 });
      expectSameRun(browser, server);
      expect(browser.calls).toHaveLength(0);
      expect(errorOf(browser.outcome)).toBeInstanceOf(AiRoutingBudgetError);
    });

    it("skips a candidate whose context window cannot hold the prompt and sends the whole prompt to the next", async () => {
      const small = compatible("small", [chatModel("tiny", { maxInputTokens: 1_000 })]);
      const big = compatible("big", [chatModel("roomy", { maxInputTokens: 128_000 })]);
      const prompt = "x".repeat(20_000);
      const { browser, server } = await runBoth([small, big], routed([small, big]), { ...ASK, user: prompt, maxOutputTokens: 500 });
      expectSameRun(browser, server);
      expect(hostsOf(browser)).toEqual(["big"]);
      expect(browser.calls[0].body.messages[1].content, "the prompt is never cut").toBe(prompt);
    });

    it("refuses a prompt no window holds, with the estimate and the roomiest budget, and sends nothing", async () => {
      const only = compatible("only", [chatModel("tiny", { maxInputTokens: 1_000 })]);
      const { browser, server } = await runBoth([only], settingsOf([only]), { ...ASK, user: "x".repeat(20_000), maxOutputTokens: 500 });
      expectSameRun(browser, server);
      expect(browser.calls).toHaveLength(0);
      const error = errorOf(browser.outcome);
      expect(error).toBeInstanceOf(AiPromptTooLargeError);
      expect(error.retryable).toBe(false);
      expect(error.largestBudget).toBe(1_000 - 50 - 500);
      expect(error.message).toMatch(/about \d+ tokens/);
    });

    it("gives the whole prompt to a model with no configured window", async () => {
      const open = compatible("open");
      const prompt = "x".repeat(400_000);
      const { browser, server } = await runBoth([open], settingsOf([open]), { ...ASK, user: prompt });
      expectSameRun(browser, server);
      expect(browser.calls[0].body.messages[1].content).toBe(prompt);
    });
  });

  describe("time limits", () => {
    beforeEach(() => vi.useFakeTimers());

    it.each(["browser", "server"] as const)("%s: a request has 600 s by default, not the 60 s or 180 s the browser used to allow", async (host) => {
      const fixture = compatible("a");
      const run = startHost(host, [fixture], settingsOf([fixture]), ASK, (call) => hang(call.signal));
      await vi.advanceTimersByTimeAsync(599_000);
      expect(run.done, "still waiting after 599 s").toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      const outcome = await run.outcome;
      expect(errorOf(outcome)).toBeInstanceOf(AiProviderError);
      expect(errorOf(outcome)).toMatchObject({ timedOut: true, retryable: true, transient: true });
      expect(errorOf(outcome).message).toMatch(/timed out/);
    });

    it.each(["browser", "server"] as const)("%s: the integration's own timeout wins", async (host) => {
      const fixture = compatible("a", undefined, { requestTimeoutMs: 45_000 });
      const run = startHost(host, [fixture], settingsOf([fixture]), ASK, (call) => hang(call.signal));
      await vi.advanceTimersByTimeAsync(44_000);
      expect(run.done).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(errorOf(await run.outcome)).toMatchObject({ timedOut: true });
    });

    it.each(["browser", "server"] as const)("%s: the total time never interrupts the first candidate before its own timeout", async (host) => {
      const chain = [compatible("a"), compatible("b")];
      const settings = routed(chain, { routingExecution: { ...DEFAULT_SETTINGS.routingExecution, maxTotalDurationMs: 1_000 } });
      const run = startHost(host, chain, settings, ASK, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        return textReply("a slow, long scene");
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(responseOf(await run.outcome).text, "five times the total, and the first candidate still finishes").toBe("a slow, long scene");
      expect(run.calls).toHaveLength(1);
    });

    it.each(["browser", "server"] as const)("%s: a fallback starts only while time remains in the total, and the error says so", async (host) => {
      const chain = [compatible("a"), compatible("b")];
      const settings = routed(chain, { routingExecution: { ...DEFAULT_SETTINGS.routingExecution, maxTotalDurationMs: 1_000 } });
      const run = startHost(host, chain, settings, ASK, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        return failReply(503, "first down");
      });
      await vi.advanceTimersByTimeAsync(1_500);
      const outcome = await run.outcome;
      expect(run.calls).toHaveLength(1);
      expect(errorOf(outcome).message).toMatch(/first down/);
      expect(errorOf(outcome).message).toMatch(/maxTotalDurationMs/);
    });

    it.each(["browser", "server"] as const)("%s: a fallback runs only for the time that remains", async (host) => {
      const chain = [compatible("a"), compatible("b")];
      const settings = routed(chain, { routingExecution: { ...DEFAULT_SETTINGS.routingExecution, maxTotalDurationMs: 2_000 } });
      const run = startHost(host, chain, settings, ASK, (call) => (call.url.includes("a.example.test") ? failReply(503, "first down") : hang(call.signal)));
      await vi.advanceTimersByTimeAsync(1_999);
      expect(run.done).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      const outcome = await run.outcome;
      expect(run.calls).toHaveLength(2);
      expect(errorOf(outcome).message).toMatch(/timed out/);
    });
  });

  describe("streamed replies", () => {
    const ask: AiRequest = { ...ASK, onText: () => undefined };
    const fixture = compatible("a");

    it("an error the provider reports inside the stream is a retryable provider error and the partial text is dropped", async () => {
      const broken: ProviderReply = () => eventStream([data({ choices: [{ delta: { content: "Half a sc" } }] }), data({ error: { message: "The server had an error while processing your request", type: "server_error" } })]);
      const { browser, server } = await runBoth([fixture], settingsOf([fixture]), ask, broken);
      expectSameRun(browser, server);
      expect(errorOf(browser.outcome)).toBeInstanceOf(AiProviderError);
      expect(errorOf(browser.outcome).retryable).toBe(true);
      expect(browser.progress[browser.progress.length - 1], "the partial text is cleared when the attempt is given up").toBe("");
    });

    it("a stream that ends before [DONE] is not a finished scene", async () => {
      const noEnd: ProviderReply = () => eventStream([data({ choices: [{ delta: { content: "A scene without an end" } }] })]);
      const { browser, server } = await runBoth([fixture], settingsOf([fixture]), ask, noEnd);
      expectSameRun(browser, server);
      expect(errorOf(browser.outcome)).toBeInstanceOf(AiProviderError);
      expect(errorOf(browser.outcome).message).toMatch(/ended before the reply was complete/);
    });

    it("a finish reason nobody knows, without [DONE], is not trusted", async () => {
      const unknown: ProviderReply = () => eventStream([data({ choices: [{ delta: { content: "Some text" }, finish_reason: "mystery" }] })]);
      const { browser, server } = await runBoth([fixture], settingsOf([fixture]), ask, unknown);
      expectSameRun(browser, server);
      expect(errorOf(browser.outcome).message).toMatch(/unexpected finish reason/);
    });

    it("a stream that finishes properly gives its text", async () => {
      const fine: ProviderReply = () => eventStream([data({ choices: [{ delta: { content: "Finished." }, finish_reason: "stop" }] }), DONE]);
      const { browser, server } = await runBoth([fixture], settingsOf([fixture]), ask, fine);
      expectSameRun(browser, server);
      expect(responseOf(browser.outcome).text).toBe("Finished.");
    });
  });
});

// ─── The configuration the personal server receives ─────────────────────────

describe("moving a book to the personal server sends the router configuration with its privacy and routing rules", () => {
  const ORIGIN = "http://127.0.0.1:24243";
  const TOKEN = "nrs_client_token_for_the_ai_parity_test";
  const BOOK: BookEntry = { id: "book-ai-parity", owner: "local", repo: "book-ai-parity", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };
  const EXECUTION = { maxCandidates: 3, maxTotalDurationMs: 120_000, maxTokenAttempts: 150_000, maxEstimatedCost: 2 };
  const DISCLOSURE = { sameBoundaryOnly: true, requireAcknowledgement: true };

  async function move(settings: AppSettings, consent: { sendAiConfiguration: boolean }) {
    const identity = await createFakeIdentity();
    const server = { identity, token: TOKEN, registered: [] as Array<{ bookId: string; body: unknown }>, aiConfig: undefined as unknown };
    const network = createFakeNetwork({ [ORIGIN]: server });
    vi.stubGlobal("fetch", network.fetch);
    forgetServerVerification();
    useAutopilotStore.setState({ views: {} });
    useSettingsStore.setState({ settings: { ...settings, books: [BOOK], personalServer: { url: ORIGIN, token: TOKEN, serverId: identity.serverId, fingerprint: identity.fingerprint } } });
    const repo = await putLocalRepository({ bookId: BOOK.id, owner: BOOK.owner, repo: BOOK.repo, branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: "2026-11-21T00:00:00.000Z", cloneComplete: true }, captureRepositoryOperationScope());
    try {
      await autopilotRuntime.moveToServer(BOOK.id, { sendAiConfiguration: consent.sendAiConfiguration, sendGitHubToken: false });
    } finally {
      await removeLocalRepository(repo.id, captureRepositoryOperationScope());
      useSettingsStore.setState({ settings: { ...settings, personalServer: undefined, books: [] } });
      autopilotRuntime.ensureServerStream();
    }
    return { server, network };
  }

  const local = compatible("local", [chatModel("qwen")]);
  const cloud = compatible("cloud", [chatModel("gpt-4o")]);

  it("sends exactly pickAiRuntimeConfig(settings), with fallbackDisclosure and routingExecution", async () => {
    const settings = routed([local, cloud], { fallbackDisclosure: DISCLOSURE, routingExecution: EXECUTION });
    const { server, network } = await move(settings, { sendAiConfiguration: true });

    const sent = network.requests.filter((request) => request.method === "PUT" && request.path === "/api/v1/ai");
    expect(sent).toHaveLength(1);
    const received = (sent[0].body as { config: unknown }).config;
    expect(received).toEqual(pickAiRuntimeConfig(settings));
    expect(server.aiConfig).toEqual(received);
    expect(received).toMatchObject({ fallbackDisclosure: DISCLOSURE, routingExecution: EXECUTION, maxCandidates: 3 });
    expect(pickAiRuntimeConfig(received), "the server picks it again before storing it: nothing changes").toEqual(received);
    expect(JSON.stringify(sent[0].body), "the AI keys go to the server the author chose; the rest of the settings does not").not.toContain(GITHUB_TOKEN);
  });

  it("sends nothing about the AI when the author did not agree to it", async () => {
    const { network } = await move(routed([local, cloud], { fallbackDisclosure: DISCLOSURE, routingExecution: EXECUTION }), { sendAiConfiguration: false });
    expect(network.requests.filter((request) => request.path === "/api/v1/ai" && request.method === "PUT")).toHaveLength(0);
  });

  it("the server applies the same rules as the browser: a fallback in another account is not used", async () => {
    const settings = routed([local, cloud], { fallbackDisclosure: DISCLOSURE, routingExecution: EXECUTION });
    const { server } = await move(settings, { sendAiConfiguration: true });
    const reply: ProviderReply = (call) => (call.url.includes("local.example.test") ? failReply(500, "local model crashed") : textReply("the manuscript was sent here"));

    const asServer = createFakeProvider(endpointsOf([local, cloud]), reply);
    const viaServer = await settled(createFetchAi(pickAiRuntimeConfig(server.aiConfig), { fetch: asServer.fetch }).complete(ASK));
    expect(asServer.calls.map((call) => new URL(call.url).hostname)).toEqual(["local.example.test"]);
    expect(errorOf(viaServer).message).toMatch(/sameBoundaryOnly/);

    const withoutRules = createFakeProvider(endpointsOf([local, cloud]), reply);
    const config = { ...pickAiRuntimeConfig(server.aiConfig), fallbackDisclosure: undefined, routingExecution: undefined };
    await createFetchAi(config, { fetch: withoutRules.fetch }).complete(ASK);
    expect(withoutRules.calls.map((call) => new URL(call.url).hostname), "without the rules in the configuration the fallback would have been used").toEqual(["local.example.test", "cloud.example.test"]);
  });
});
