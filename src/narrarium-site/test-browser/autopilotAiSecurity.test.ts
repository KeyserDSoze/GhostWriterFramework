import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AiRequest } from "narrarium-engine";
import { localWorkspaceScope } from "@/account/deviceIdentity";
import { setFallbackAcknowledgementAccountScope } from "@/assistant/fallbackDisclosure";
import { createBrowserAi } from "@/autopilot/browserAi";
import { useCostsStore } from "@/costs/costsStore";
import { useLlmDebugStore } from "@/debug/llmDebugStore";
import { useSettingsStore } from "@/store/settingsStore";
import type { AppSettings } from "@/types/settings";
import { assertProvidersClean, createFakeProvider, data, eventStream, failReply, holdsSecret, textReply, type ProviderEndpoint, type ProviderReply } from "./helpers/fakeProvider";
import { chatModel, compatible, endpointsOf, GITHUB_TOKEN, routed, settingsOf, type Fixture } from "./helpers/aiFixtures";
import { resetCosts } from "./helpers/costs";

// The browser reaches GitHub Models through the site's proxy.
vi.mock("@/config/githubModels", () => ({
  GITHUB_MODELS_BASE: "https://models-proxy.example.test",
  GITHUB_MODELS_INFERENCE_URL: "https://models-proxy.example.test/inference",
  GITHUB_MODELS_CATALOG_URL: "https://models-proxy.example.test/catalog/models",
}));

const ASK: AiRequest = { capability: "autopilot", label: "autopilot:scene", system: "The system prompt", user: "The user prompt" };
const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: any) => error);

beforeEach(() => {
  localStorage.clear();
  useLlmDebugStore.setState({ entries: [], pending: 0, storageError: null, accountIdentity: null });
  resetCosts({ bookId: "book-1", bookName: "The Glass Harbor" });
  setFallbackAcknowledgementAccountScope(localWorkspaceScope());
});

afterEach(() => {
  vi.unstubAllGlobals();
  setFallbackAcknowledgementAccountScope(null);
  assertProvidersClean();
});

describe("the guard of the fake provider", () => {
  const a: ProviderEndpoint = { id: "a", apiKey: "sk-a-key-0123456789", base: "https://a.example.test/v1", auth: "bearer" };
  const b: ProviderEndpoint = { id: "b", apiKey: "b-api-key-0123456789", base: "https://b.example.test/v1", auth: "api-key" };
  const TOKEN = "ghp_forbidden0123456789abcdef";

  async function send(fake: { fetch: typeof fetch }, url: string, headers: Record<string, string>, body: unknown = {}) {
    await fake.fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  }

  it("lets a key go in the authorization header to its own endpoint and nowhere else", async () => {
    const fake = createFakeProvider([a, b], () => textReply(), [TOKEN]);
    await send(fake, `${a.base}/chat/completions`, { authorization: `Bearer ${a.apiKey}` });
    await send(fake, `${b.base}/chat/completions`, { "api-key": b.apiKey });
    expect(fake.violations).toEqual([]);
  });

  it("notices a key in a URL, a body, another header or another integration's request, a missing credential, an unknown endpoint and a token that belongs to no provider", async () => {
    const fake = createFakeProvider([a, b], () => textReply(), [TOKEN]);
    await send(fake, `${a.base}/chat/completions?key=${a.apiKey}`, { authorization: `Bearer ${a.apiKey}` });
    await send(fake, `${a.base}/chat/completions`, { authorization: `Bearer ${a.apiKey}` }, { echo: a.apiKey });
    await send(fake, `${a.base}/chat/completions`, { authorization: `Bearer ${a.apiKey}`, "x-debug": a.apiKey });
    await send(fake, `${a.base}/chat/completions`, { authorization: `Bearer ${a.apiKey}`, "api-key": a.apiKey });
    await send(fake, `${b.base}/chat/completions`, { "api-key": b.apiKey, authorization: `Bearer ${a.apiKey}` });
    await send(fake, `${a.base}/chat/completions`, {});
    await send(fake, "https://elsewhere.example.test/v1/chat/completions", { authorization: `Bearer ${a.apiKey}` });
    await send(fake, `${a.base}/chat/completions`, { authorization: `Bearer ${a.apiKey}`, cookie: TOKEN });
    await send(fake, `${a.base}/chat/completions`, { authorization: `Bearer ${a.apiKey}` }, { github: TOKEN });

    expect(fake.violations).toEqual([
      "the key of a is in the URL https://a.example.test/v1/chat/completions?key=***",
      "the key of a is in the body of a request to https://a.example.test/v1/chat/completions",
      "the key of a is in the x-debug header",
      "the key of a is in the api-key header",
      "the key of a was sent to b",
      "the request to a does not carry its credentials in the authorization header",
      "POST https://elsewhere.example.test/v1/chat/completions is not an endpoint of any configured integration",
      "the key of a was sent to https://elsewhere.example.test/v1/chat/completions",
      "a secret that belongs to no provider is in the cookie of a request to https://a.example.test/v1/chat/completions",
      "a secret that belongs to no provider is in the body of a request to https://a.example.test/v1/chat/completions",
    ]);
    expect(JSON.stringify(fake.violations), "the findings never repeat a secret").not.toMatch(/sk-a-key|b-api-key|ghp_forbidden/);
    fake.violations.length = 0; // provoked on purpose
  });

  it("recognizes a secret however it is written", () => {
    expect(holdsSecret(`https://x.test/?key=${encodeURIComponent("a b+c/key-0123456789")}`, "a b+c/key-0123456789")).toBe(true);
    expect(holdsSecret("nothing here", "sk-a-key-0123456789")).toBe(false);
    expect(holdsSecret("abc", "abc"), "a value too short to be a key is not looked for").toBe(false);
  });
});

describe("API keys and tokens in the autopilot's calls", () => {
  const a = compatible("a");
  const azure: Fixture = {
    integration: { id: "az", name: "AZ", provider: "azure_openai", endpoint: "https://res.openai.azure.com", apiVersion: "2024-10-21", apiKey: "azure-key-0123456789abcdef", chatModels: [chatModel("deploy-1")] },
    endpoint: { id: "az", apiKey: "azure-key-0123456789abcdef", base: "https://res.openai.azure.com", auth: "api-key" },
  };
  const github: Fixture = {
    integration: { id: "gh", name: "GH", provider: "github_models", apiKey: "github_pat_0123456789abcdefghijklmnopqrstu", chatModels: [chatModel("openai/gpt-4o")] },
    endpoint: { id: "gh", apiKey: "github_pat_0123456789abcdefghijklmnopqrstu", base: "https://models-proxy.example.test/inference", auth: "bearer" },
  };
  const chain = [a, azure, github];
  const secrets = [...chain.map((fixture) => fixture.endpoint.apiKey), GITHUB_TOKEN];

  function useProvider(fixtures: Fixture[], settings: AppSettings, reply: ProviderReply) {
    const fake = createFakeProvider(endpointsOf(fixtures), reply, [GITHUB_TOKEN]);
    vi.stubGlobal("fetch", fake.fetch);
    useSettingsStore.setState({ settings });
    return fake;
  }

  it("go only in the authorization header of the integration each attempt is for, down a whole fallback chain", async () => {
    const fake = useProvider(chain, routed(chain), (call) => (call.url.startsWith("https://models-proxy.example.test/") ? textReply("the third answered") : failReply(500, "down")));

    const response = await createBrowserAi().complete(ASK);

    expect(response.text).toBe("the third answered");
    expect(fake.calls.map((call) => new URL(call.url).hostname)).toEqual(["a.example.test", "res.openai.azure.com", "models-proxy.example.test"]);
    for (const call of fake.calls) {
      const carriers = Object.entries(call.headers).filter(([, value]) => secrets.some((secret) => holdsSecret(value, secret))).map(([name]) => name);
      expect(carriers, call.url).toHaveLength(1);
      expect(["authorization", "api-key"]).toContain(carriers[0]);
    }
    expect(fake.calls[0].headers.authorization).toBe(`Bearer ${a.endpoint.apiKey}`);
    expect(fake.calls[1].headers["api-key"]).toBe(azure.endpoint.apiKey);
    expect(fake.calls[2].headers.authorization).toBe(`Bearer ${github.endpoint.apiKey}`);
    for (const call of fake.calls) expect(secrets.some((secret) => holdsSecret(call.url + call.rawBody, secret)), "no key in a URL or a body").toBe(false);
  });

  it("the GitHub tokens of the author reach no AI provider", async () => {
    const settings = settingsOf([a], { extraGitHubTokens: [{ label: "work", token: "ghp_ExtraTokenOfTheAuthor0123456789abcdef" }], books: [{ id: "b", owner: "o", repo: "r", name: "B", tokenIndex: null, bookToken: "ghp_BookTokenOfTheAuthor0123456789abcdef0", addedAt: "2026-11-21T00:00:00.000Z" }] });
    const fake = useProvider([a], settings, () => textReply("ok"));
    await createBrowserAi().complete(ASK);
    const everything = JSON.stringify(fake.calls.map((call) => [call.url, call.headers, call.rawBody]));
    for (const token of [GITHUB_TOKEN, "ghp_ExtraTokenOfTheAuthor0123456789abcdef", "ghp_BookTokenOfTheAuthor0123456789abcdef0"]) expect(everything).not.toContain(token);
  });

  describe("a provider that echoes the key back", () => {
    const echoes: Array<[string, (key: string) => ProviderReply]> = [
      ["in the message of a refusal", (key) => () => failReply(401, `Incorrect API key provided: ${key}. Authorization: Bearer ${key}`)],
      ["in an error inside a 200 reply", (key) => () => Response.json({ error: { message: `bad credentials ${key}` } })],
      ["in an error chunk of a stream", (key) => () => eventStream([data({ error: { message: `key ${key} was rejected`, type: "server_error" } })])],
      ["in the message of a network failure", (key) => () => { throw new TypeError(`connect failed for https://a.example.test/v1?api_key=${key}`); }],
      ["in the URL it reports", (key) => () => failReply(404, `no such deployment at https://res.example.test/?key=${encodeURIComponent(key)}&token=${key}`)],
    ];

    it.each(echoes)("never lets it out: %s", async (_name, echo) => {
      const consoleCalls: unknown[][] = [];
      for (const method of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { consoleCalls.push(args); });
      const outcomes: unknown[] = [];

      for (const fixture of chain) {
        const fake = useProvider([fixture], settingsOf([fixture]), echo(fixture.endpoint.apiKey));
        const error = await failure(createBrowserAi().complete({ ...ASK, onText: () => undefined }));
        expect(error, fixture.integration.id).toBeDefined();
        expect(fake.calls.length).toBeGreaterThan(0);
        outcomes.push(error.message, String(error), error.stack, JSON.stringify(error, Object.getOwnPropertyNames(error)));
      }

      const surfaces: Record<string, string> = {
        "the errors": JSON.stringify(outcomes),
        "the debug panel": JSON.stringify(useLlmDebugStore.getState().entries),
        "the costs": JSON.stringify(useCostsStore.getState().file),
        "the storage": JSON.stringify(Object.fromEntries(Object.keys(localStorage).map((name) => [name, localStorage.getItem(name)]))),
        "the console": JSON.stringify(consoleCalls),
      };
      for (const [surface, text] of Object.entries(surfaces)) for (const secret of secrets) expect(holdsSecret(text, secret), `${surface} holds a secret`).toBe(false);
    });
  });
});
