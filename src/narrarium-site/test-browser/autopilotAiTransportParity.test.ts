import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFetchAi,
  DEFAULT_IDLE_TIMEOUT_MS,
  MAX_IDLE_TIMEOUT_MS,
  MIN_IDLE_TIMEOUT_MS,
  MIN_REQUEST_TIMEOUT_MS,
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
import i18n from "@/i18n";
import { useLlmDebugStore } from "@/debug/llmDebugStore";
import { putLocalRepository, removeLocalRepository } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import type { AIIntegration, AppSettings, BookEntry, ChatModel } from "@/types/settings";
import {
  answer,
  assertProvidersClean,
  createFakeProvider,
  data,
  failReply,
  hang,
  textReply,
  type ProviderCall,
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
const encoder = new TextEncoder();

// ─── The two hosts (the same adapters as autopilotAiParity.test.ts) ─────────

type Outcome = { response: AiResponse } | { error: any };

interface HostRun {
  calls: ProviderCall[];
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

const wire = (calls: ProviderCall[]) => calls.map(({ method, url, headers, rawBody, body }) => ({ method, url, headers, rawBody, body }));

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

function expectSameRun(browser: Finished, server: Finished): void {
  expect(wire(browser.calls)).toEqual(wire(server.calls));
  expect(observed(browser.outcome)).toEqual(observed(server.outcome));
  expect(browser.progress).toEqual(server.progress);
}

/** The names a message quotes: `the "Provider timeout" of the integration "A"` gives `Provider timeout` and `A`. */
const quoted = (message: string) => Array.from(message.matchAll(/"([^"]+)"/g), (match) => match[1]);

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

// ─── Streaming: the integration's choice, the same in both hosts ────────────

const SHAPES = [
  { name: "text", request: {}, tools: true },
  { name: "text, with a listener for the text as it comes", request: { onText: () => undefined }, tools: true },
  { name: "structured, by a forced function call", request: { json: SCHEMA }, tools: true },
  { name: "structured, by a forced function call, with a progress listener", request: { json: SCHEMA, onProgress: () => undefined }, tools: true },
  { name: "structured, asked in the prompt (the model has no tools)", request: { json: SCHEMA }, tools: false },
] as const;

type Make = (extra: Partial<AIIntegration>, models: ChatModel[]) => Fixture;

function single(id: string, integration: Omit<AIIntegration, "id" | "name" | "apiKey" | "chatModels">, apiKey: string, base: string, auth: Fixture["endpoint"]["auth"]): Make {
  return (extra, models) => ({ integration: { id, name: id.toUpperCase(), apiKey, chatModels: models, ...integration, ...extra }, endpoint: { id, apiKey, base, auth } });
}

const PROVIDERS: Array<{ name: string; make: Make }> = [
  { name: "openai", make: single("oa", { provider: "openai" }, "sk-openai-0123456789abcdef", "https://api.openai.com/v1", "bearer") },
  { name: "an OpenAI-compatible server at its own endpoint", make: single("lm", { provider: "openai", endpoint: "http://127.0.0.1:1234/v1/" }, "sk-local-0123456789abcdef", "http://127.0.0.1:1234/v1", "bearer") },
  { name: "azure openai", make: single("az", { provider: "azure_openai", endpoint: "https://res.openai.azure.com/", apiVersion: "2024-10-21" }, "azure-key-0123456789abcdef", "https://res.openai.azure.com", "api-key") },
  { name: "github models through the proxy", make: single("gh", { provider: "github_models" }, "github_pat_0123456789abcdefghijklmnopqrstu", `${PROXY}/inference`, "bearer") },
];

describe("an integration with streaming off asks for a whole reply, in both hosts", () => {
  describe.each(PROVIDERS)("$name", (provider) => {
    it.each(SHAPES)("$name", async (shape) => {
      const models = [chatModel("gpt-4o", { supportsToolCalls: shape.tools })];
      const streaming = provider.make({}, models);
      const whole = provider.make({ streamMode: "off" }, models);
      const request: AiRequest = { ...ASK, maxOutputTokens: 1000, temperature: 0.4, ...shape.request };

      const asked = await runBoth([streaming], settingsOf([streaming]), request);
      const refused = await runBoth([whole], settingsOf([whole]), request);

      expectSameRun(asked.browser, asked.server);
      expectSameRun(refused.browser, refused.server);
      expect(refused.browser.calls).toHaveLength(1);
      const [call] = refused.browser.calls;
      expect(call.headers.accept).toBe("application/json");
      expect(call.body).not.toHaveProperty("stream");
      expect(call.body).not.toHaveProperty("stream_options");
      expect(call.rawBody).not.toMatch(/stream/);

      const [streamed] = asked.browser.calls;
      expect(streamed.headers.accept).toBe("text/event-stream");
      const { stream, stream_options, ...rest } = streamed.body;
      expect(stream).toBe(true);
      expect(stream_options).toEqual({ include_usage: true });
      expect(call.body, "streaming is the only thing that differs").toEqual(rest);

      expect(observed(refused.browser.outcome), "what the author gets does not change, only how it travels").toEqual(observed(asked.browser.outcome));
      const response = responseOf(refused.browser.outcome);
      const structured = "json" in shape.request;
      expect(response.text).toBe(structured ? JSON.stringify({ ok: true }) : "The scene.");
      if (structured) expect(response.json).toEqual({ ok: true });
      if ("onText" in shape.request) expect(refused.browser.progress, "a whole reply gives its text once").toEqual(["The scene."]);
    });
  });

  it.each([[undefined], ["auto"], ["turbo"]] as const)("streams when the integration says %s: only off switches it off", async (mode) => {
    const fixture = compatible("a", undefined, mode === undefined ? {} : { streamMode: mode as never });
    const { browser, server } = await runBoth([fixture], settingsOf([fixture]), ASK);
    expectSameRun(browser, server);
    expect(browser.calls[0].body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(browser.calls[0].headers.accept).toBe("text/event-stream");
  });

  it("is the choice of each integration: a fallback that does not say off still streams", async () => {
    const whole = compatible("a", undefined, { streamMode: "off" });
    const streaming = compatible("b");
    const { browser, server } = await runBoth([whole, streaming], routed([whole, streaming]), ASK, (call) => (call.url.includes("a.example.test") ? failReply(500, "a is down") : answer(call)));
    expectSameRun(browser, server);
    expect(hostsOf(browser)).toEqual(["a", "b"]);
    expect(browser.calls.map((call) => call.headers.accept)).toEqual(["application/json", "text/event-stream"]);
    expect(browser.calls.map((call) => "stream" in call.body)).toEqual([false, true]);
    expect(responseOf(browser.outcome).text).toBe("The scene.");
  });

  it("names Streaming in the error of a provider that refuses streamed replies, in both hosts", async () => {
    const fixture = compatible("a");
    const refuse: ProviderReply = (call) => (call.body.stream ? failReply(400, "stream_options is not supported by this proxy") : textReply("A whole scene."));
    const { browser, server } = await runBoth([fixture], settingsOf([fixture]), ASK, refuse);
    expectSameRun(browser, server);
    const error = errorOf(browser.outcome);
    expect(error).toMatchObject({ status: 400, retryable: false });
    expect(error.message).toMatch(/set "Streaming" of the integration "A" to "off"/);
    expect(quoted(error.message).slice(-3)).toEqual(["Streaming", "A", "off"]);
    expect(i18n.t("settings.streamMode", { lng: "en" })).toBe("Streaming");
    expect(i18n.t("settings.streamMode", { lng: "it" })).toBe("Streaming");

    const off = compatible("a", undefined, { streamMode: "off" });
    const after = await runBoth([off], settingsOf([off]), ASK, refuse);
    expectSameRun(after.browser, after.server);
    expect(responseOf(after.browser.outcome).text).toBe("A whole scene.");
  });
});

// ─── The deadlines the author sets, the same in both hosts ──────────────────

describe("the time a slow model is given", () => {
  const piece = (value: unknown) => encoder.encode(data(value));
  /** The headers, one piece of the reply, and then silence: the connection stays open and nothing more comes. */
  const goesSilent: ProviderReply = (call) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(piece({ choices: [{ delta: { content: "Half a sc" } }] }));
      call.signal?.addEventListener("abort", () => controller.error(call.signal?.reason), { once: true });
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });

  beforeEach(() => vi.useFakeTimers());

  it.each(["browser", "server"] as const)("%s: a provider timeout of 6000 ms, as the owner had it, is raised to 30 s, and the error names the setting", async (host) => {
    const fixture = compatible("a", undefined, { requestTimeoutMs: 6000 });
    const run = startHost(host, [fixture], settingsOf([fixture]), ASK, (call) => hang(call.signal));
    await vi.advanceTimersByTimeAsync(MIN_REQUEST_TIMEOUT_MS - 1000);
    expect(run.done, "not given up at 6 s, nor at 29 s").toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    const error = errorOf(await run.outcome);
    expect(error).toMatchObject({ timedOut: true, retryable: true, transient: true });
    expect(error.message).toMatch(/did not start answering within 30 s/);
    expect(error.message).toMatch(/"Provider timeout" of the integration "A" was 6 s and was raised to the 30 s minimum/);
    expect(quoted(error.message)[0], "the English label of the page starts with the name the error quotes").toBe("Provider timeout");
    expect(i18n.t("settings.requestTimeoutMs", { lng: "en" })).toMatch(/^Provider timeout\b/);
  });

  it.each(["browser", "server"] as const)("%s: the idle timeout of the integration is the longest silence in a stream, and the error names the setting", async (host) => {
    const fixture = compatible("a", undefined, { idleTimeoutMs: 45_000 });
    const run = startHost(host, [fixture], settingsOf([fixture]), { ...ASK, onText: () => undefined }, goesSilent);
    await vi.advanceTimersByTimeAsync(44_000);
    expect(run.done, "a stream that has been quiet for 44 s is alive").toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    const error = errorOf(await run.outcome);
    expect(error).toMatchObject({ timedOut: true, retryable: true, transient: true });
    expect(error.message).toMatch(/the provider sent nothing for 45 s while answering/);
    expect(error.message).toMatch(/the "Idle timeout" of the integration "A"/);
    expect(quoted(error.message)[0]).toBe("Idle timeout");
    expect(i18n.t("settings.idleTimeoutMs", { lng: "en" })).toMatch(/^Idle timeout\b/);
  });

  it.each(["browser", "server"] as const)("%s: an integration with no idle timeout waits ten minutes of silence", async (host) => {
    const fixture = compatible("a");
    const run = startHost(host, [fixture], settingsOf([fixture]), ASK, goesSilent);
    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_TIMEOUT_MS - 1000);
    expect(run.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    const error = errorOf(await run.outcome);
    expect(error.message).toMatch(/the provider sent nothing for 600 s while answering/);
  });

  it.each([
    ["a value under the minimum", 5, MIN_IDLE_TIMEOUT_MS, "30 s"],
    ["a value over the maximum", 99_999_999, MAX_IDLE_TIMEOUT_MS, "1 h"],
  ])("keeps %s of a hand-edited settings file within the limits the page shows, in both hosts", async (_name, written, kept, said) => {
    for (const host of ["browser", "server"] as const) {
      const fixture = compatible("a", undefined, { idleTimeoutMs: written });
      const run = startHost(host, [fixture], settingsOf([fixture]), ASK, goesSilent);
      await vi.advanceTimersByTimeAsync(kept - 1000);
      expect(run.done, `${host}: still waiting a second before ${kept} ms`).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(errorOf(await run.outcome).message, host).toContain(`the provider sent nothing for ${said} while answering`);
    }
  });
});

// ─── The configuration the personal server receives ─────────────────────────

describe("the router configuration carries the request settings of every integration", () => {
  const settings = (): AppSettings => {
    const slow = compatible("slow", undefined, { requestTimeoutMs: 6000, idleTimeoutMs: 45_000, streamMode: "off" });
    const plain = compatible("plain");
    return routed([slow, plain]);
  };

  it("pickAiRuntimeConfig keeps streamMode, idleTimeoutMs and requestTimeoutMs, and adds nothing to an integration that has none", () => {
    const config = pickAiRuntimeConfig(settings());
    expect(config.aiIntegrations[0]).toMatchObject({ id: "slow", requestTimeoutMs: 6000, idleTimeoutMs: 45_000, streamMode: "off" });
    expect(config.aiIntegrations[1]).toMatchObject({ id: "plain" });
    expect(config.aiIntegrations[1]).not.toHaveProperty("idleTimeoutMs");
    expect(config.aiIntegrations[1]).not.toHaveProperty("streamMode");
    expect(pickAiRuntimeConfig(JSON.parse(JSON.stringify(config))), "what the server picks again from the JSON it received is the same").toEqual(config);
  });

  it("keeps a value inside the limits the page shows and drops one it does not understand", () => {
    const pick = (extra: Record<string, unknown>) => pickAiRuntimeConfig(settingsOf([compatible("a", undefined, extra as Partial<AIIntegration>)])).aiIntegrations[0];
    expect(pick({ idleTimeoutMs: 5 }).idleTimeoutMs).toBe(MIN_IDLE_TIMEOUT_MS);
    expect(pick({ idleTimeoutMs: 99_999_999 }).idleTimeoutMs).toBe(MAX_IDLE_TIMEOUT_MS);
    expect(pick({ idleTimeoutMs: 45_000.4 }).idleTimeoutMs).toBe(45_000);
    expect(pick({ idleTimeoutMs: "soon" })).not.toHaveProperty("idleTimeoutMs");
    expect(pick({ streamMode: "auto" }).streamMode).toBe("auto");
    expect(pick({ streamMode: "turbo" })).not.toHaveProperty("streamMode");
  });

  describe("moving a book to the personal server", () => {
    const ORIGIN = "http://127.0.0.1:24244";
    const TOKEN = "nrs_client_token_for_the_request_settings_test";
    const BOOK: BookEntry = { id: "book-request-settings", owner: "local", repo: "book-request-settings", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };

    async function move(forSettings: AppSettings) {
      const identity = await createFakeIdentity();
      const server = { identity, token: TOKEN, registered: [] as Array<{ bookId: string; body: unknown }>, aiConfig: undefined as unknown };
      const network = createFakeNetwork({ [ORIGIN]: server });
      vi.stubGlobal("fetch", network.fetch);
      forgetServerVerification();
      useAutopilotStore.setState({ views: {} });
      useSettingsStore.setState({ settings: { ...forSettings, books: [BOOK], personalServer: { url: ORIGIN, token: TOKEN, serverId: identity.serverId, fingerprint: identity.fingerprint } } });
      const repo = await putLocalRepository({ bookId: BOOK.id, owner: BOOK.owner, repo: BOOK.repo, branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: "2026-11-21T00:00:00.000Z", cloneComplete: true }, captureRepositoryOperationScope());
      try {
        await autopilotRuntime.moveToServer(BOOK.id, { sendAiConfiguration: true, sendGitHubToken: false });
      } finally {
        await removeLocalRepository(repo.id, captureRepositoryOperationScope());
        useSettingsStore.setState({ settings: { ...forSettings, personalServer: undefined, books: [] } });
        autopilotRuntime.ensureServerStream();
      }
      return { server, network };
    }

    it("sends the settings of each integration to the server, which then asks for whole replies where the author said so", async () => {
      const sent = settings();
      const { server, network } = await move(sent);

      const puts = network.requests.filter((request) => request.method === "PUT" && request.path === "/api/v1/ai");
      expect(puts).toHaveLength(1);
      const received = (puts[0].body as { config: { aiIntegrations: Array<Record<string, unknown>> } }).config;
      expect(received).toEqual(pickAiRuntimeConfig(sent));
      expect(received.aiIntegrations[0]).toMatchObject({ id: "slow", requestTimeoutMs: 6000, idleTimeoutMs: 45_000, streamMode: "off" });
      expect(server.aiConfig).toEqual(received);

      const slow = compatible("slow", undefined, { requestTimeoutMs: 6000, idleTimeoutMs: 45_000, streamMode: "off" });
      const plain = compatible("plain");
      const provider = createFakeProvider(endpointsOf([slow, plain]), answer);
      const ai = createFetchAi(pickAiRuntimeConfig(server.aiConfig), { fetch: provider.fetch });
      await ai.complete(ASK);
      expect(provider.calls[0].headers.accept, "the first route target is the integration that says off").toBe("application/json");
      expect(provider.calls[0].body).not.toHaveProperty("stream");
    });
  });
});
