import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiRequest, AiRuntimeConfig } from "narrarium-engine";
import { setFallbackAcknowledgementAccountScope } from "@/assistant/fallbackDisclosure";
import { createBrowserAi } from "@/autopilot/browserAi";
import { LLM_DEBUG_REDACTED, useLlmDebugStore } from "@/debug/llmDebugStore";
import { useSettingsStore } from "@/store/settingsStore";
import { assertProvidersClean, createFakeProvider, textReply } from "./helpers/fakeProvider";
import { compatible, endpointsOf, GITHUB_TOKEN, routed, settingsOf, type Fixture } from "./helpers/aiFixtures";
import { entries, failure, resetStores } from "./helpers/copilotHarness";

const ASK: AiRequest = { capability: "autopilot", label: "autopilot:scene", system: "The system prompt", user: "The user prompt" };
const hostOf = (url: string) => new URL(url).hostname.replace(".example.test", "");

function provide(fixtures: Fixture[]) {
  const fake = createFakeProvider(endpointsOf(fixtures), () => textReply("A scene."), [GITHUB_TOKEN]);
  vi.stubGlobal("fetch", fake.fetch);
  return fake;
}

beforeEach(() => {
  resetStores();
  useSettingsStore.setState({ settings: settingsOf([]) });
});
afterEach(() => {
  vi.unstubAllGlobals();
  assertProvidersClean();
});

describe("the settings that the browser's AI port is made with", () => {
  it("are the author's, read when the call is made, unless the caller brings its own", async () => {
    const a = compatible("a");
    const b = compatible("b");
    const fake = provide([a, b]);
    setFallbackAcknowledgementAccountScope(null);

    useSettingsStore.setState({ settings: routed([a]) });
    await createBrowserAi({ accountScope: null }).complete(ASK);
    const port = createBrowserAi({ accountScope: null });
    useSettingsStore.setState({ settings: routed([b]) });
    await port.complete(ASK);
    await createBrowserAi({ accountScope: null, settings: routed([a]) }).complete(ASK);

    expect(fake.calls.map((call) => hostOf(call.url))).toEqual(["a", "b", "a"]);
  });
});

describe("the account that a call of the browser's AI port belongs to", () => {
  it("is the local workspace when nobody says: a call of the run, as it always was", async () => {
    const a = compatible("a");
    const fake = provide([a]);
    useSettingsStore.setState({ settings: routed([a]) });
    setFallbackAcknowledgementAccountScope("google:someone@example.com");

    const error = await failure(createBrowserAi().complete(ASK));

    expect(error.name).toBe("AbortError");
    expect(error.message).toBe("The local workspace changed.");
    expect(fake.calls).toHaveLength(0);
  });

  it("is the account that the caller names, and the call is made only while that is the account that is signed in", async () => {
    const a = compatible("a");
    const fake = provide([a]);
    const settings = routed([a]);

    setFallbackAcknowledgementAccountScope("google:first@example.com");
    await createBrowserAi({ settings, accountScope: "google:first@example.com" }).complete(ASK);
    await createBrowserAi({ settings, accountScope: "  Google:First@Example.com " }).complete(ASK);
    expect(fake.calls).toHaveLength(2);

    const other = await failure(createBrowserAi({ settings, accountScope: "google:second@example.com" }).complete(ASK));
    expect(other.name).toBe("AbortError");
    expect(other.message).toBe("The local workspace changed.");
    const none = await failure(createBrowserAi({ settings, accountScope: null }).complete(ASK));
    expect(none.name).toBe("AbortError");
    expect(fake.calls, "the two that were refused sent nothing").toHaveLength(2);
  });

  it("is no account when the caller says null, and then it is the call of a browser that is not signed in", async () => {
    const a = compatible("a");
    const fake = provide([a]);
    setFallbackAcknowledgementAccountScope(null);

    await createBrowserAi({ settings: routed([a]), accountScope: null }).complete(ASK);

    expect(fake.calls).toHaveLength(1);
  });

  it("is whichever account is signed in when the caller says it does not know (undefined, as for beginAccountScopedAiOperation)", async () => {
    const a = compatible("a");
    const fake = provide([a]);
    setFallbackAcknowledgementAccountScope("google:anyone@example.com");

    await createBrowserAi({ settings: routed([a]), accountScope: undefined }).complete(ASK);

    expect(fake.calls).toHaveLength(1);
  });

  it("stops a call that is in flight when the signed-in account changes", async () => {
    const a = compatible("a");
    const fake = createFakeProvider(endpointsOf([a]), (call) => new Promise((_resolve, reject) => call.signal?.addEventListener("abort", () => reject(call.signal?.reason), { once: true })), [GITHUB_TOKEN]);
    vi.stubGlobal("fetch", fake.fetch);
    setFallbackAcknowledgementAccountScope("google:first@example.com");

    const pending = failure(createBrowserAi({ settings: routed([a]), accountScope: "google:first@example.com" }).complete(ASK));
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    setFallbackAcknowledgementAccountScope("google:second@example.com");

    expect((await pending).name).toBe("AbortError");
    expect(fake.calls[0].signal?.aborted).toBe(true);
  });
});

describe("what a caller can say about the attempts of a call", () => {
  it("changes the configuration of one call, and the engine goes by the one it is given", async () => {
    const a = compatible("a");
    const b = compatible("b");
    const fake = provide([a, b]);
    const seen: Array<{ capability: string; integrations: number }> = [];

    await createBrowserAi({
      settings: routed([a, b]),
      accountScope: null,
      configure: (config: AiRuntimeConfig, request: AiRequest) => {
        seen.push({ capability: request.capability, integrations: config.aiIntegrations.length });
        return { ...config, taskRouting: { autopilot: { primary: { integrationId: "b", model: "model-b" }, fallbacks: [] } } };
      },
    }).complete(ASK);

    expect(seen).toEqual([{ capability: "autopilot", integrations: 2 }]);
    expect(fake.calls.map((call) => hostOf(call.url))).toEqual(["b"]);
  });

  it("tells the debug panel the place of the attempt in the route that the caller resolved, and what it left out", async () => {
    const a = compatible("a");
    provide([a]);

    await createBrowserAi({ settings: routed([a]), accountScope: null, route: { index: 2, skipped: [{ model: "model-x", reason: "no-tool-calls" }] } }).complete(ASK);

    expect(entries()[0]).toMatchObject({ routeCandidateIndex: 2, usedFallback: true, skipped: [{ model: "model-x", reason: "no-tool-calls" }] });
  });

  it("says nothing of a route that the caller did not resolve: the position is the engine's", async () => {
    const a = compatible("a");
    provide([a]);

    await createBrowserAi({ settings: routed([a]), accountScope: null }).complete(ASK);

    expect(entries()[0]).toMatchObject({ routeCandidateIndex: 0, usedFallback: false });
    expect(entries()[0].skipped).toBeUndefined();
  });

  it("tells the caller how each attempt ended and which entry of the debug panel it is, once the entry is closed", async () => {
    const a = compatible("a");
    provide([a]);
    const ends: Array<{ id: string | undefined; outcome: string; text?: string; finishReason?: string; status: string | undefined }> = [];

    await createBrowserAi({
      settings: routed([a]),
      accountScope: null,
      onEnd: (end, debugId) => ends.push({ id: debugId, outcome: end.outcome, text: end.text, finishReason: end.finishReason, status: entries().find((entry) => entry.id === debugId)?.status }),
    }).complete(ASK);

    expect(ends).toEqual([{ id: entries()[0].id, outcome: "ok", text: "A scene.", finishReason: "stop", status: "done" }]);
  });

  it("never lets a listener that throws break the call", async () => {
    const a = compatible("a");
    provide([a]);

    await expect(createBrowserAi({ settings: routed([a]), accountScope: null, onEnd: () => { throw new Error("a listener that fails"); } }).complete(ASK)).resolves.toMatchObject({ text: "A scene." });
  });
});

describe("a conversation with images through the browser's AI port", () => {
  it("is sent with its images, and the debug panel says that there was an image without keeping it", async () => {
    const a = compatible("a");
    const fake = provide([a]);

    await createBrowserAi({ settings: routed([a]), accountScope: null }).complete({
      capability: "autopilot",
      label: "copilot:chat",
      system: "",
      user: "",
      messages: [
        { role: "system", content: "You are the Copilot." },
        { role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image", dataUrl: "data:image/png;base64,AAAA" }] },
      ],
    });

    expect(fake.calls[0].body.messages).toEqual([
      { role: "system", content: "You are the Copilot." },
      { role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
    ]);
    expect(entries()[0].contentKinds).toEqual(["text", "image"]);
    expect(entries()[0].messages?.map((message) => message.content)).toEqual([LLM_DEBUG_REDACTED, LLM_DEBUG_REDACTED]);
    expect(JSON.stringify(entries())).not.toContain("AAAA");
    expect(useLlmDebugStore.getState().pending).toBe(0);
  });
});
