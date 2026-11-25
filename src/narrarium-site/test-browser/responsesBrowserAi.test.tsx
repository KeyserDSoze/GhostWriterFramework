import "fake-indexeddb/auto";
import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiRequest } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ toast: vi.fn() }));

vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));
vi.mock("@/drive/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/drive/useSettings")>()),
  useSettings: () => ({ load: async () => undefined, save: async () => undefined, resolveOfflineConflict: async () => undefined, syncStatus: "idle", lastSynced: null }),
}));

import { closeAccountLocalStoreForTests } from "@/account/accountLocalStore";
import { localWorkspaceScope, resetLocalWorkspaceIdentityForTests } from "@/account/deviceIdentity";
import { setFallbackAcknowledgementAccountScope } from "@/assistant/fallbackDisclosure";
import { createBrowserAi } from "@/autopilot/browserAi";
import { useLearnedModelsStore } from "@/autopilot/learnedModels";
import { useLlmDebugStore } from "@/debug/llmDebugStore";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { assertProvidersClean, createFakeProvider, eventStream, failReply, type ProviderCall, type ProviderReply } from "./helpers/fakeProvider";
import { GITHUB_TOKEN, SCHEMA, chatModel, endpointsOf, settingsOf, type Fixture } from "./helpers/aiFixtures";

// What the page does with a model that is asked through the Responses API, from its settings to the debug panel, against a fake provider that plays the Azure OpenAI of the owner's gateway: the request it builds, the
// key that goes in its header and nowhere else, the reply it reads (text, a forced function, the tokens), and what the panel keeps of it: the protocol, and no address.

const KEY = "az-key-0123456789abcdef";
const ASK: AiRequest = { capability: "autopilot", label: "autopilot:scene", system: "You are an AI assistant that helps people find information.", user: "rispondi solo con ok" };
const STRUCTURED: AiRequest = { ...ASK, json: SCHEMA };

const frame = (value: { type: string; [key: string]: unknown }) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
const USAGE = { input_tokens: 120, input_tokens_details: { cached_tokens: 20 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 10 }, total_tokens: 150 };
const REASONING = { id: "rs_1", type: "reasoning", content: [], encrypted_content: "<ENCRYPTED>", summary: [] };
const response = (extra: Record<string, unknown> = {}) => ({ id: "resp_1", object: "response", status: "in_progress", model: "gpt-5.2", output: [], usage: null, ...extra });

/** What the Azure portal streams for a short answer: a reasoning item that shows nothing, then the text in two pieces, then the tokens. */
function textStream(text = "ok"): Response {
  const half = Math.max(1, Math.floor(text.length / 2));
  const message = { id: "msg_1", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text }] };
  return eventStream([
    frame({ type: "response.in_progress", response: response() }),
    frame({ type: "response.output_item.added", output_index: 0, item: REASONING }),
    frame({ type: "response.output_item.done", output_index: 0, item: REASONING }),
    frame({ type: "response.output_item.added", output_index: 1, item: { ...message, status: "in_progress", content: [] } }),
    frame({ type: "response.output_text.delta", output_index: 1, content_index: 0, delta: text.slice(0, half) }),
    frame({ type: "response.output_text.delta", output_index: 1, content_index: 0, delta: text.slice(half) }),
    frame({ type: "response.output_text.done", output_index: 1, content_index: 0, text }),
    frame({ type: "response.output_item.done", output_index: 1, item: message }),
    frame({ type: "response.completed", response: response({ status: "completed", output: [REASONING, message], usage: USAGE }) }),
  ]);
}

/** A forced function whose arguments stream in pieces, after a reasoning item. */
function callStream(value: unknown): Response {
  const args = JSON.stringify(value);
  const middle = Math.floor(args.length / 2);
  const item = { id: "fc_1", type: "function_call", status: "completed", call_id: "call_1", name: "result", arguments: args };
  return eventStream([
    frame({ type: "response.in_progress", response: response() }),
    frame({ type: "response.output_item.added", output_index: 0, item: REASONING }),
    frame({ type: "response.output_item.done", output_index: 0, item: REASONING }),
    frame({ type: "response.output_item.added", output_index: 1, item: { ...item, status: "in_progress", arguments: "" } }),
    frame({ type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_1", delta: args.slice(0, middle) }),
    frame({ type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_1", delta: args.slice(middle) }),
    frame({ type: "response.function_call_arguments.done", output_index: 1, item_id: "fc_1", arguments: args }),
    frame({ type: "response.output_item.done", output_index: 1, item }),
    frame({ type: "response.completed", response: response({ status: "completed", output: [REASONING, item], usage: USAGE }) }),
  ]);
}

/** The gateway of the owner: Azure OpenAI at `oai-gw-002`, a key in the `api-key` header, the integration's API version the one that predates the Responses API. */
function gateway(models = [chatModel("gpt-5.2", { apiProtocol: "responses" })]): Fixture {
  return {
    integration: { id: "az", name: "oai-gw-002", provider: "azure_openai", endpoint: "https://oai-gw-002.example.test", apiKey: KEY, apiVersion: "2024-10-21", thinking: "high", chatModels: models },
    endpoint: { id: "az", apiKey: KEY, base: "https://oai-gw-002.example.test/openai", auth: "api-key" },
  };
}

function useProvider(fixture: Fixture, reply: ProviderReply, model = fixture.integration.chatModels![0].name) {
  const fake = createFakeProvider(endpointsOf([fixture]), reply, [GITHUB_TOKEN]);
  vi.stubGlobal("fetch", fake.fetch);
  useSettingsStore.setState({ settings: settingsOf([fixture], { taskRouting: { autopilot: { primary: { integrationId: "az", model }, fallbacks: [] } } }) });
  return fake;
}

const entries = () => useLlmDebugStore.getState().entries;
const requestOf = (call: ProviderCall) => ({ path: new URL(call.url).pathname, version: new URL(call.url).searchParams.get("api-version") });

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  closeAccountLocalStoreForTests();
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase("narrarium-local-account");
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
  });
  localStorage.clear();
  resetLocalWorkspaceIdentityForTests();
  mocks.toast.mockReset();
  await i18n.changeLanguage("en");
  useLlmDebugStore.setState({ entries: [], pending: 0, storageError: null, accountIdentity: null });
  useLearnedModelsStore.setState({ notices: [] });
  setFallbackAcknowledgementAccountScope(localWorkspaceScope());
});

afterEach(async () => {
  cleanup();
  await waitFor(() => expect(useSettingsStore.getState().syncStatus).not.toBe("saving"));
  vi.unstubAllGlobals();
  setFallbackAcknowledgementAccountScope(null);
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  assertProvidersClean();
});

describe("a model on the Responses API, through the page", () => {
  it("is asked at the address built from its integration, with its key in the header and nowhere else, and its stream is read: the text, the tokens and the costs; the panel says the protocol and keeps no address", async () => {
    const fixture = gateway();
    const fake = useProvider(fixture, () => textStream("ok"));
    const result = await createBrowserAi().complete(ASK);
    expect(result.text).toBe("ok");
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 30, cachedInputTokens: 20 });
    expect(result.usageKnown).toBe(true);
    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    expect(requestOf(call)).toEqual({ path: "/openai/responses", version: "2025-04-01-preview" });
    expect(call.headers["api-key"]).toBe(KEY);
    expect(call.headers.authorization).toBeUndefined();
    expect(call.body).toMatchObject({ model: "gpt-5.2", stream: true, store: false, reasoning: { effort: "high" }, input: [{ role: "developer" }, { role: "user" }] });
    expect(call.body.messages).toBeUndefined();
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ status: "done", provider: "azure_openai", model: "gpt-5.2", protocol: "responses", stream: true, streamed: true, apiVersion: "2025-04-01-preview", thinking: "high" });
    expect(JSON.stringify(entries()[0])).not.toMatch(/oai-gw-002\.example\.test|api-version=|openai\/responses|az-key/);
  });

  it("reads a forced function together with a thinking level, which Chat Completions refuses for some models: the request has both, the model's setting for Chat Completions is not used, and nothing is learned", async () => {
    const fixture = gateway([chatModel("gpt-6-luna", { apiProtocol: "responses", noThinkingWithTools: "none" })]);
    const fake = useProvider(fixture, (call) => (call.body.tools ? callStream({ ok: true }) : textStream()));
    const result = await createBrowserAi().complete(STRUCTURED);
    expect(result.json).toEqual({ ok: true });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].body.reasoning).toEqual({ effort: "high" });
    expect(fake.calls[0].body.tools).toEqual([{ type: "function", name: "result", description: "A result", parameters: SCHEMA.parameters, strict: false }]);
    expect(fake.calls[0].body.tool_choice).toBe("required");
    expect(entries()[0]).toMatchObject({ status: "done", tools: true, thinking: "high", protocol: "responses" });
    expect(entries()[0].thinkingWhy).toBeUndefined();
    expect(useLearnedModelsStore.getState().notices).toHaveLength(0);
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("uses the address that the model has of its own exactly as it was written, with the key of its integration, and the debug panel keeps neither the address nor its query", async () => {
    const own = "https://oai-gw-002.example.test/openai/responses?api-version=2025-03-01-preview&trace=1";
    const fixture = gateway([chatModel("gpt-5.2", { apiProtocol: "responses", endpointUrl: own, apiVersion: "2023-05-15" })]);
    const fake = useProvider(fixture, () => textStream());
    await createBrowserAi().complete(ASK);
    expect(fake.calls[0].url).toBe(own);
    expect(fake.calls[0].headers["api-key"]).toBe(KEY);
    expect(entries()[0].apiVersion, "no version of ours is said for an address of its own").toBeUndefined();
    expect(JSON.stringify(entries()[0])).not.toMatch(/trace=1|oai-gw-002\.example\.test/);
  });

  it("fails with the provider's own words when its stream reports an error, and the panel keeps the protocol and the few words of the error", async () => {
    const fixture = gateway();
    useProvider(fixture, () => eventStream([frame({ type: "response.in_progress", response: response() }), frame({ type: "error", error: { type: "forbidden", code: "forbidden", message: "Access denied." } })]));
    const failure = await createBrowserAi().complete(ASK).then(() => null, (error: { message: string }) => error);
    expect(failure?.message).toMatch(/Access denied\./);
    expect(entries()[0]).toMatchObject({ status: "error", protocol: "responses" });
  });

  it("is asked through Chat Completions as ever when it says nothing of the protocol, and the panel has no protocol for it", async () => {
    const fixture = gateway([chatModel("gpt-5.2")]);
    const fake = useProvider(fixture, () => new Response(JSON.stringify({ choices: [{ message: { content: "plain" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await createBrowserAi().complete(ASK);
    expect(result.text).toBe("plain");
    expect(requestOf(fake.calls[0]).path).toBe("/openai/deployments/gpt-5.2/chat/completions");
    expect(fake.calls[0].body.messages).toBeDefined();
    expect("protocol" in entries()[0]).toBe(false);
  });
});
