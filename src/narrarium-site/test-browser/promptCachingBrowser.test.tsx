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
import { createBrowserAi, resetPageAiMemory } from "@/autopilot/browserAi";
import { useLearnedModelsStore } from "@/autopilot/learnedModels";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import "@/costs/applyUsage";
import { onUsageRecorded, resetUsageRecorder, type RecordedUsage } from "@/costs/recordUsage";
import { useLlmDebugStore } from "@/debug/llmDebugStore";
import i18n from "@/i18n";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type AppSettings } from "@/types/settings";
import { assertProvidersClean, createFakeProvider, failReply, textReply, type ProviderReply } from "./helpers/fakeProvider";
import { chatModel, compatible, endpointsOf, GITHUB_TOKEN, settingsOf, type Fixture } from "./helpers/aiFixtures";

// A provider that reports tokens served from its cache: the call says it (its share of the input, and what it saved at the prices of the model), the page remembers that the model caches for as long as it lives
// and changes no setting for it (the ledger keeps it), an author's word is never replaced, and a provider that refuses the hint that helps it find its cache is asked again without it and not sent it again.

const SCOPE = "book/autopilot:specialists";
const ASK: AiRequest = { capability: "autopilot", label: "autopilot:specialists:1", system: "The system prompt", user: "The user prompt", cacheKey: SCOPE };
const HINT_REFUSAL = "Unrecognized request argument supplied: prompt_cache_key";

const usage = (cached: number, input = 2000) => ({ prompt_tokens: input, completion_tokens: 5, prompt_tokens_details: { cached_tokens: cached } });
/** The first request of a prompt is not served from the cache; every one after it is, for the first 1,280 tokens. */
const cachingProvider = (): ProviderReply => {
  let seen = 0;
  return () => textReply("answer", usage((seen += 1) > 1 ? 1280 : 0));
};

const modelsOf = () => useSettingsStore.getState().settings.aiIntegrations[0].chatModels!;
const keyOf = (call: { body: Record<string, unknown> }) => call.body.prompt_cache_key;

function setup(fixture: Fixture, reply: ProviderReply, extra: Partial<AppSettings> = {}) {
  const fake = createFakeProvider(endpointsOf([fixture]), reply, [GITHUB_TOKEN]);
  vi.stubGlobal("fetch", fake.fetch);
  useSettingsStore.setState({ settings: settingsOf([fixture], { taskRouting: { autopilot: { primary: { integrationId: fixture.integration.id, model: fixture.integration.chatModels![0].name }, fallbacks: [] } }, ...extra }) });
  return fake;
}

let recorded: RecordedUsage[] = [];
let stop: (() => void) | null = null;

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
  resetUsageRecorder();
  resetPageAiMemory();
  mocks.toast.mockReset();
  await i18n.changeLanguage("en");
  useLlmDebugStore.setState({ entries: [], pending: 0, storageError: null, accountIdentity: null });
  useLearnedModelsStore.setState({ notices: [] });
  setFallbackAcknowledgementAccountScope(localWorkspaceScope());
  recorded = [];
  stop = onUsageRecorded((entry) => recorded.push(entry));
});

afterEach(async () => {
  stop?.();
  cleanup();
  await waitFor(() => expect(useSettingsStore.getState().syncStatus).not.toBe("saving"));
  vi.unstubAllGlobals();
  setFallbackAcknowledgementAccountScope(null);
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useLearnedModelsStore.setState({ notices: [] });
  closeAccountLocalStoreForTests();
  assertProvidersClean();
});

describe("a provider that serves the second call from its cache", () => {
  it("is recorded with the tokens it served and what that saved at the prices of the model: 1,280 of 2,000 tokens at 2 instead of 1 per million", async () => {
    const fixture = compatible("gw", [chatModel("gpt-5")]);
    setup(fixture, cachingProvider());
    const ai = createBrowserAi();
    await ai.complete(ASK);
    await ai.complete(ASK);
    expect(recorded).toHaveLength(2);
    expect(recorded[0].delta.counters).toMatchObject({ inputTokens: 2000, cachedTokens: 0 });
    expect(recorded[0].delta.counters.cachedSavings).toBeUndefined();
    expect(recorded[1].delta.counters).toMatchObject({ inputTokens: 2000, cachedTokens: 1280 });
    expect(recorded[1].delta.counters.cachedSavings).toBeCloseTo(0.00128, 12);
    // What was paid is the engine's price: 720 tokens as input, 1,280 as cached, 5 out (PRICE: 2 / 1 / 8).
    expect(recorded[1].delta.counters.cost).toBeCloseTo((720 * 2 + 1280 * 1 + 5 * 8) / 1e6, 12);
  });

  it("changes no setting for it, and says nothing: no notice, no message, and the author's other settings stay as they were (the ledger is what keeps that a model cached)", async () => {
    const fixture = compatible("gw", [chatModel("gpt-5", { noThinkingWithTools: true })]);
    setup(fixture, cachingProvider());
    const before = useSettingsStore.getState().settings;
    const ai = createBrowserAi();
    await ai.complete(ASK);
    await ai.complete(ASK);
    expect(useSettingsStore.getState().settings, "not one setting was touched").toBe(before);
    expect(modelsOf()[0].promptCaching).toBeUndefined();
    expect(useLearnedModelsStore.getState().notices).toEqual([]);
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(recorded[1].delta.counters.cachedTokens).toBe(1280);
  });

  it("is sent the key that helps the provider find the cache once the page knows it caches, at a gateway that nobody said took one, and not before", async () => {
    const fixture = compatible("gw", [chatModel("gpt-5")]);
    const fake = setup(fixture, cachingProvider());
    const ai = createBrowserAi();
    await ai.complete(ASK);
    await ai.complete(ASK);
    await ai.complete(ASK);
    expect(fake.calls.map(keyOf)).toEqual([undefined, undefined, expect.stringMatching(/^narrarium-[0-9a-f]{16}$/)]);
    expect(String(keyOf(fake.calls[2])), "the key is a hash: it names neither the book nor the task").not.toContain("book");
  });

  it("never replaces what the author said: a model declared as not caching stays so, and is sent no key even when its provider serves its cache", async () => {
    const fixture = compatible("gw", [chatModel("gpt-5", { promptCaching: "unsupported" })]);
    const fake = setup(fixture, cachingProvider());
    const ai = createBrowserAi();
    await ai.complete(ASK);
    await ai.complete(ASK);
    await ai.complete(ASK);
    expect(modelsOf()[0].promptCaching).toBe("unsupported");
    expect(fake.calls.map(keyOf)).toEqual([undefined, undefined, undefined]);
    expect(recorded[1].delta.counters.cachedTokens, "what the provider reported is still recorded").toBe(1280);
  });

  it("makes no saving of a model with no cached price: the tokens are counted, and nothing is said to have been saved", async () => {
    const fixture = compatible("gw", [chatModel("gpt-5", { pricing: { inputPerMTok: 2, outputPerMTok: 8 } })]);
    setup(fixture, cachingProvider());
    const ai = createBrowserAi();
    await ai.complete(ASK);
    await ai.complete(ASK);
    expect(recorded[1].delta.counters.cachedTokens).toBe(1280);
    expect(recorded[1].delta.counters.cachedSavings).toBeUndefined();
  });
});

describe("a provider that refuses the key that helps it find its cache", () => {
  const refusing = (): ProviderReply => (call) => (call.body.prompt_cache_key ? failReply(400, HINT_REFUSAL) : textReply("answer", usage(0)));

  it("is asked again without it, and the call does not fail; the next call carries none, and the author's word for the model is left as it is", async () => {
    const fixture = compatible("gw", [chatModel("gpt-5", { promptCaching: "supported" })]);
    const fake = setup(fixture, refusing());
    const ai = createBrowserAi();
    expect((await ai.complete(ASK)).text).toBe("answer");
    expect(fake.calls.map(keyOf)).toEqual([expect.any(String), undefined]);
    expect((await ai.complete(ASK)).text).toBe("answer");
    expect(fake.calls.map(keyOf), "this page remembers it: one request, no refusal").toHaveLength(3);
    expect(keyOf(fake.calls[2])).toBeUndefined();
    expect(modelsOf()[0].promptCaching).toBe("supported");
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});
