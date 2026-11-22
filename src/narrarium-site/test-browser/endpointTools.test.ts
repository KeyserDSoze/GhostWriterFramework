import { afterEach, describe, expect, it, vi } from "vitest";
import { AiCatalogError } from "narrarium-engine";
import { checkEndpoint, engineIntegration, readCatalog } from "@/ai/endpointTools";
import type { AIIntegration } from "@/types/settings";
import { compatible } from "./helpers/aiFixtures";
import { assertProvidersClean } from "./helpers/fakeProvider";
import { OWNER_IDS, gateway, pathsAsked } from "./helpers/llmProxyFakes";

const fixture = compatible("gw", []);
const KEY = fixture.integration.apiKey;
const AZURE: AIIntegration = { id: "az", name: "Azure", provider: "azure_openai", endpoint: "https://x.openai.azure.com", apiKey: "k", apiVersion: "2024-10-21" };

afterEach(() => {
  vi.useRealTimers();
  assertProvidersClean();
});

/** What the rejection of a promise is, so that a test can look at it. */
async function failure(promise: Promise<unknown>): Promise<AiCatalogError> {
  const error = await promise.then(() => undefined, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(AiCatalogError);
  return error as AiCatalogError;
}

describe("the integration as the engine is given it", () => {
  it("is the one the author wrote, with its real key and address: the engine reads them from its configuration, and nothing else of the card is needed", () => {
    expect(engineIntegration(fixture.integration)).toMatchObject({ id: "gw", provider: "openai", endpoint: fixture.endpoint.base, apiKey: KEY });
  });

  it("is made for the integration the author is still writing too, which has no id yet: the engine skips an integration that has none", () => {
    const draft = engineIntegration({ ...fixture.integration, id: "" });
    expect(draft.id).not.toBe("");
    expect(draft).toMatchObject({ provider: "openai", endpoint: fixture.endpoint.base, apiKey: KEY });
  });
});

describe("reading the models of an endpoint", () => {
  it("asks the list first and then what the gateway declares and offers, with the key in the authorization header and nowhere else", async () => {
    const gw = gateway(fixture);
    const catalog = await readCatalog(fixture.integration, { fetch: gw.fetch });
    expect(pathsAsked(gw, fixture)[0]).toBe("/models");
    expect(pathsAsked(gw, fixture).sort()).toEqual(["/modalities", "/models", "/models/details"]);
    for (const call of gw.calls) {
      expect(call.method).toBe("GET");
      expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    }
    expect(catalog.source).toEqual({ models: true, details: true, modalities: true });
    expect(catalog.models.map((model) => model.id)).toEqual([...OWNER_IDS].sort());
    expect(catalog.models.find((model) => model.id === "muse-glimmer-30b")).toMatchObject({ type: "chat", contextWindow: 131072, maxOutputTokens: 8192, capabilities: { tools: true, streaming: true, vision: true, reasoning: true } });
    expect(catalog.models.find((model) => model.id === "flux-schnell")?.type).toBe("image");
  });

  it("is the list alone when the gateway has none of the companions: every model is of no kind, and the source says so", async () => {
    const gw = gateway(fixture, { details: null, modalities: null });
    const catalog = await readCatalog(fixture.integration, { fetch: gw.fetch });
    expect(catalog.source).toEqual({ models: true, details: false, modalities: false });
    expect(catalog.models.map((model) => model.type)).toEqual(OWNER_IDS.map(() => "unknown"));
  });

  it("is told why when it cannot be read, in the words of the engine and with a reason to translate: never the key, and never the address", async () => {
    const cases: Array<[Parameters<typeof gateway>[1], string]> = [
      [{ status: 401 }, "unauthorized"], [{ status: 403 }, "unauthorized"], [{ status: 404 }, "not-found"], [{ status: 429 }, "rate-limited"],
      [{ status: 503 }, "server-error"], [{ status: 418 }, "http-error"], [{ unreachable: true }, "unreachable"],
      [{ models: { data: "nope" } }, "invalid"], [{ models: { data: [] } }, "empty"],
    ];
    for (const [behavior, reason] of cases) {
      const gw = gateway(fixture, behavior);
      const error = await failure(readCatalog(fixture.integration, { fetch: gw.fetch }));
      expect(error.reason, JSON.stringify(behavior)).toBe(reason);
      expect(error.message).not.toContain(KEY);
      expect(error.message).not.toContain("gw.example.test");
      expect(error.message.length).toBeGreaterThan(20);
    }
  });

  it("says that an integration with no list has none, and sends nothing: Azure OpenAI, GitHub Models and Microsoft 365 are not asked", async () => {
    const gw = gateway(fixture);
    for (const provider of ["azure_openai", "github_models", "m365_copilot"] as const) {
      const error = await failure(readCatalog({ ...AZURE, provider }, { fetch: gw.fetch }));
      expect(error.reason).toBe("unsupported");
    }
    expect(gw.calls).toEqual([]);
  });

  it("stops when the author cancels, with an abort and not a catalog, and does not ask at all when it was cancelled already", async () => {
    const gw = gateway(fixture, { hang: true });
    const controller = new AbortController();
    const reading = readCatalog(fixture.integration, { fetch: gw.fetch, signal: controller.signal });
    const outcome = reading.then(() => "read", (error: unknown) => (error as Error).name);
    await vi.waitFor(() => expect(gw.calls).toHaveLength(1));
    controller.abort();
    expect(await outcome).toBe("AbortError");
    expect(gw.calls[0].signal?.aborted).toBe(true);

    const none = gateway(fixture);
    const already = new AbortController();
    already.abort();
    await expect(readCatalog(fixture.integration, { fetch: none.fetch, signal: already.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(none.calls).toEqual([]);
  });
});

describe("the fetch of the page", () => {
  /** What a browser's own `fetch` is: it refuses to be called as a method of another object («Illegal invocation»), which a fake that is a plain function never does. */
  function browserFetch(gw: ReturnType<typeof gateway>) {
    const calledOn: unknown[] = [];
    const strict = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      calledOn.push(this);
      if (this !== undefined && this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      return gw.fetch(input, init);
    } as typeof fetch;
    return { strict, calledOn };
  }

  it("is the one the engine is given when nobody gives another: it is called as a plain function, because a browser refuses a bare fetch called as the method of an engine object", async () => {
    const gw = gateway(fixture);
    const { strict, calledOn } = browserFetch(gw);
    vi.stubGlobal("fetch", strict);
    const catalog = await readCatalog(fixture.integration);
    expect(catalog.models).toHaveLength(OWNER_IDS.length);
    expect(catalog.source).toEqual({ models: true, details: true, modalities: true });
    const probe = await checkEndpoint(fixture.integration);
    expect(probe.outcome).toBe("ok");
    expect(calledOn.length).toBeGreaterThanOrEqual(4);
    for (const receiver of calledOn) expect(receiver === undefined || receiver === globalThis).toBe(true);
    vi.unstubAllGlobals();
  });

  it("is looked up when the call is made and not when the page loads, so that a fetch that is replaced afterwards (a test, a service worker's wrapper) is the one that is used", async () => {
    const first = gateway(fixture, { status: 503 });
    vi.stubGlobal("fetch", first.fetch);
    const second = gateway(fixture);
    vi.stubGlobal("fetch", second.fetch);
    await readCatalog(fixture.integration);
    expect(first.calls).toEqual([]);
    expect(second.calls.length).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });

  it("gives way to the fetch that a caller passes", async () => {
    const mine = gateway(fixture);
    const other = gateway(fixture, { status: 500 });
    vi.stubGlobal("fetch", other.fetch);
    await readCatalog(fixture.integration, { fetch: mine.fetch });
    expect(other.calls).toEqual([]);
    expect(mine.calls.length).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });
});

describe("checking the connection to an endpoint", () => {
  it("asks only for the list of models, with the key, and says how many there are and that it answered", async () => {
    const gw = gateway(fixture);
    const probe = await checkEndpoint(fixture.integration, { fetch: gw.fetch });
    expect(pathsAsked(gw, fixture)).toEqual(["/models"]);
    expect(gw.calls[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(probe).toMatchObject({ outcome: "ok", httpStatus: 200, models: OWNER_IDS.length, cors: "ok" });
    expect(probe.message).not.toContain(KEY);
  });

  it("says how long the endpoint took to answer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const gw = gateway(fixture, { elapse: 120 });
    const probe = await checkEndpoint(fixture.integration, { fetch: gw.fetch });
    expect(probe.latencyMs).toBe(120);
  });

  it("is an answer when the endpoint refuses, and the status says what to correct: it is reachable", async () => {
    for (const status of [401, 403, 404, 429, 500, 503, 418]) {
      const gw = gateway(fixture, { status });
      const probe = await checkEndpoint(fixture.integration, { fetch: gw.fetch });
      expect(probe, String(status)).toMatchObject({ outcome: "http-error", httpStatus: status, cors: "ok" });
      expect(probe.message).not.toContain(KEY);
    }
  });

  it("says that it could not reach the endpoint, and that a browser cannot tell why", async () => {
    const gw = gateway(fixture, { unreachable: true });
    const probe = await checkEndpoint(fixture.integration, { fetch: gw.fetch });
    expect(probe).toMatchObject({ outcome: "unreachable", cors: "blocked-or-unreachable" });
    expect(probe.httpStatus).toBeUndefined();
    expect(probe.message).toMatch(/CORS/);
    expect(probe.message).not.toContain(KEY);
  });

  it("is still an answer when it is not a list, or a list with nothing in it, and does not count what it cannot read", async () => {
    const empty = await checkEndpoint(fixture.integration, { fetch: gateway(fixture, { models: { data: [] } }).fetch });
    expect(empty).toMatchObject({ outcome: "ok", models: 0 });
    const page = await checkEndpoint(fixture.integration, { fetch: gateway(fixture, { models: { html: "<p>hello</p>" } }).fetch });
    expect(page.outcome).toBe("ok");
    expect(page.models).toBeUndefined();
  });

  it("stops when the author cancels, with an abort and not a result", async () => {
    const gw = gateway(fixture, { hang: true });
    const controller = new AbortController();
    const checking = checkEndpoint(fixture.integration, { fetch: gw.fetch, signal: controller.signal });
    const outcome = checking.then(() => "answered", (error: unknown) => (error as Error).name);
    await vi.waitFor(() => expect(gw.calls).toHaveLength(1));
    controller.abort();
    expect(await outcome).toBe("AbortError");
  });

  it("sends nothing for an integration that has no such list to ask", async () => {
    const gw = gateway(fixture);
    expect((await failure(checkEndpoint(AZURE, { fetch: gw.fetch }))).reason).toBe("unsupported");
    expect(gw.calls).toEqual([]);
  });
});
