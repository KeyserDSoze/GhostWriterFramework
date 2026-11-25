import "fake-indexeddb/auto";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pickAiRuntimeConfig, redactAiRuntimeConfig, type AiErrorBody, type AiRequest, type AutopilotEvent } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ toast: vi.fn() }));

vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));
vi.mock("@/drive/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/drive/useSettings")>()),
  useSettings: () => ({ load: async () => undefined, save: async () => undefined, resolveOfflineConflict: async () => undefined, syncStatus: "idle", lastSynced: null }),
}));

import { closeAccountLocalStoreForTests, loadLocalAccountSnapshot } from "@/account/accountLocalStore";
import { localWorkspaceScope, resetLocalWorkspaceIdentityForTests } from "@/account/deviceIdentity";
import { setFallbackAcknowledgementAccountScope } from "@/assistant/fallbackDisclosure";
import { describeAiFailure } from "@/assistant/aiFailure";
import { createBrowserAi } from "@/autopilot/browserAi";
import { LearnedModelNotices } from "@/components/autopilot/LearnedModelNotices";
import { learnedKey, rememberLearnedModel, useLearnedModelsStore, withNoThinkingWithTools } from "@/autopilot/learnedModels";
import { autopilotRuntime } from "@/autopilot/runtime";
import { presentFeedEvent } from "@/autopilot/format";
import { migrateSettings } from "@/drive/cloudSettingsClient";
import { useLlmDebugStore } from "@/debug/llmDebugStore";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type AppSettings } from "@/types/settings";
import { assertProvidersClean, createFakeProvider, failReply, textReply, toolReply, type ProviderReply } from "./helpers/fakeProvider";
import { chatModel, compatible, endpointsOf, GITHUB_TOKEN, SCHEMA, settingsOf, type Fixture } from "./helpers/aiFixtures";
import { LANGUAGES, cardOf, showIntegrations, stored, t, type Language } from "./helpers/integrationPage";

// A model that refuses a thinking level only because the request carries tools is asked again, once, without the level; the page remembers it as the model's setting («Do not use thinking when tools are
// used»), says it with the provider's words and the two ways out, and sends no level with tools to that model again, while a request without tools keeps its own. The author can change it in the model's row.

const MESSAGE = (model: string) => `Function tools with reasoning_effort are not supported for ${model} in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.`;
const refusal = (model: string) => new Response(JSON.stringify({ error: { message: MESSAGE(model), type: "invalid_request_error", param: "reasoning_effort", code: null } }), { status: 400, headers: { "content-type": "application/json" } });
const OWNER_BODY: AiErrorBody = { status: 400, shape: "openai", message: MESSAGE("gpt-6-luna"), type: "invalid_request_error", param: "reasoning_effort" };
const SOL_BODY: AiErrorBody = { ...OWNER_BODY, message: MESSAGE("gpt-5.6-sol") };

const ASK: AiRequest = { capability: "autopilot", label: "autopilot:scene", system: "The system prompt", user: "The user prompt" };
const STRUCTURED: AiRequest = { ...ASK, json: SCHEMA };

const noneRefusal = () => new Response(JSON.stringify({ error: { message: "Unsupported value: 'reasoning_effort' does not support 'none' with this model.", type: "invalid_request_error", param: "reasoning_effort", code: "unsupported_value" } }), { status: 400, headers: { "content-type": "application/json" } });

/**
 * The providers as the documentation of Azure OpenAI describes the models that refuse a thinking level with function tools on Chat Completions, by family: `omit` (gpt-5.6-sol) takes the tools with the
 * level left out, and with none; `none` (gpt-6-luna) takes them with none only, a request that leaves the level out is refused as well; `responses` (gpt-6.2-sol) never takes them, and refuses none for its value.
 * A request without tools is answered.
 */
const FAMILY: Record<string, "omit" | "none" | "responses"> = { "gpt-6-luna": "none", "gpt-6.2-sol": "responses", "gpt-5.6-sol": "omit" };
function refusing(families: Record<string, "omit" | "none" | "responses"> = FAMILY): ProviderReply {
  return (call) => {
    if (!call.body.tools) return textReply("prose");
    const family = families[call.body.model] ?? "omit";
    const level = call.body.reasoning_effort;
    if (family === "omit") return level && level !== "none" ? refusal(call.body.model) : toolReply({ ok: true });
    if (family === "none") return level === "none" ? toolReply({ ok: true }) : refusal(call.body.model);
    return level === "none" ? noneRefusal() : refusal(call.body.model);
  };
}

const gateway = () => compatible("gw", [chatModel("gpt-6-luna"), chatModel("gpt-6.2-sol"), chatModel("gpt-5.6-sol")], { thinking: "high", name: "AzureOpenAi-GW" });

/** The settings with `model` as the primary of the autopilot. */
function settingsFor(fixture: Fixture, model: string, extra: Partial<AppSettings> = {}): AppSettings {
  return settingsOf([fixture], { taskRouting: { autopilot: { primary: { integrationId: fixture.integration.id, model }, fallbacks: [] } }, ...extra });
}

function useProvider(fixture: Fixture, settings: AppSettings, reply: ProviderReply) {
  const fake = createFakeProvider(endpointsOf([fixture]), reply, [GITHUB_TOKEN]);
  vi.stubGlobal("fetch", fake.fetch);
  useSettingsStore.setState({ settings });
  return fake;
}

const modelsOf = () => useSettingsStore.getState().settings.aiIntegrations[0].chatModels!;
const flagOf = (name: string) => modelsOf().find((model) => model.name === name)?.noThinkingWithTools;
const entries = () => useLlmDebugStore.getState().entries;
const levelOf = (call: { body: Record<string, unknown> }) => call.body.reasoning_effort;
const last = <T,>(list: T[]): T => list[list.length - 1];

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
  // A save that the page began is let to end before the device store is closed under it.
  await waitFor(() => expect(useSettingsStore.getState().syncStatus).not.toBe("saving"));
  vi.unstubAllGlobals();
  setFallbackAcknowledgementAccountScope(null);
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useLearnedModelsStore.setState({ notices: [] });
  closeAccountLocalStoreForTests();
  assertProvidersClean();
  await i18n.changeLanguage("en");
});

describe("gpt-5.6-sol, which takes function tools with the level left out", () => {
  const model = "gpt-5.6-sol";

  it("is asked again once without the level, is remembered as the model's setting, and the next request with tools carries no level while a request without tools keeps its own", async () => {
    const fixture = gateway();
    const fake = useProvider(fixture, settingsFor(fixture, model), refusing());
    const ai = createBrowserAi();

    const first = await ai.complete(STRUCTURED);
    expect(first.json).toEqual({ ok: true });
    expect(fake.calls.map(levelOf)).toEqual(["high", undefined]);
    expect(fake.calls.every((call) => call.body.model === model)).toBe(true);
    expect(flagOf(model)).toBe(true);
    expect(flagOf("gpt-6-luna"), "only the model the provider refused").toBeUndefined();

    await ai.complete(STRUCTURED);
    expect(fake.calls.map(levelOf)).toEqual(["high", undefined, undefined]);
    expect(fake.calls, "one request, no refusal").toHaveLength(3);

    const prose = await ai.complete(ASK);
    expect(prose.text).toBe("prose");
    expect(levelOf(fake.calls[3]), "a request without tools to the same model keeps the level").toBe("high");
  });

  it("is told in the debug panel as the attempt that was refused (its status, type and param, never its message) and the one that worked (thinking not sent, because of the tools)", async () => {
    const fixture = gateway();
    useProvider(fixture, settingsFor(fixture, model), refusing());
    await createBrowserAi().complete(STRUCTURED);
    const [second, first] = entries();
    expect(first).toMatchObject({ status: "error", failureKind: "provider", providerError: { status: 400, type: "invalid_request_error", param: "reasoning_effort" }, thinking: "high" });
    expect(first.error).toBe("[Error details redacted]");
    expect(first.thinkingWhy).toBeUndefined();
    expect(second).toMatchObject({ status: "done", thinkingWhy: "tools" });
    expect(second.thinking).toBeUndefined();
    expect(JSON.stringify(entries())).not.toContain("Function tools");
  });
});

describe("gpt-6-luna, which takes function tools only with none", () => {
  const model = "gpt-6-luna";

  it("is asked without the level and then with none, is remembered as a model that takes none, and the next request with tools carries none at once while a request without tools keeps its own level", async () => {
    const fixture = gateway();
    const fake = useProvider(fixture, settingsFor(fixture, model), refusing());
    const ai = createBrowserAi();

    expect((await ai.complete(STRUCTURED)).json).toEqual({ ok: true });
    expect(fake.calls.map(levelOf)).toEqual(["high", undefined, "none"]);
    expect(flagOf(model)).toBe("none");
    expect(flagOf("gpt-6.2-sol")).toBeUndefined();

    await ai.complete(STRUCTURED);
    expect(fake.calls.map(levelOf)).toEqual(["high", undefined, "none", "none"]);
    expect((await ai.complete(ASK)).text).toBe("prose");
    expect(levelOf(fake.calls[4]), "a request without tools to the same model keeps the level").toBe("high");
  });

  it("is told in the debug panel: two attempts that were refused, with their status, type and param, and the one that worked, which was sent none because of the tools", async () => {
    const fixture = gateway();
    useProvider(fixture, settingsFor(fixture, model), refusing());
    await createBrowserAi().complete(STRUCTURED);
    const [third, second, first] = entries();
    expect([first.status, second.status, third.status]).toEqual(["error", "error", "done"]);
    expect(first).toMatchObject({ thinking: "high", providerError: { status: 400, param: "reasoning_effort" } });
    expect(second).toMatchObject({ thinkingWhy: "tools", providerError: { status: 400, param: "reasoning_effort" } });
    expect(second.thinking).toBeUndefined();
    expect(third).toMatchObject({ thinking: "none", thinkingWhy: "tools" });
  });

  it("makes the notice say that it asks with none, and keeps the setting as none: the box of the model's row is ticked for it", async () => {
    const fixture = gateway();
    useProvider(fixture, settingsFor(fixture, model), refusing());
    await createBrowserAi().complete(STRUCTURED);
    expect(useLearnedModelsStore.getState().notices[0]).toMatchObject({ model, off: "none", responses: true });
    cleanup();
    render(<MemoryRouter><LearnedModelNotices /></MemoryRouter>);
    expect(document.querySelector("[data-learned-way=\"no-thinking\"]")).toHaveTextContent(t("autopilot.learned.wayOffNone"));
  });
});

describe("gpt-6.2-sol, which takes function tools on the Responses API only", () => {
  const model = "gpt-6.2-sol";

  it("is asked three ways and refused each time: the call fails with the provider's last words and what was tried, nothing is learned, and a request without tools is answered with its level", async () => {
    const fixture = gateway();
    const fake = useProvider(fixture, settingsFor(fixture, model), refusing());
    const ai = createBrowserAi();
    const failure = await ai.complete(STRUCTURED).then(() => null, (error: { body?: AiErrorBody; message: string }) => error);
    expect(fake.calls.map(levelOf)).toEqual(["high", undefined, "none"]);
    expect(failure?.body).toMatchObject({ status: 400, message: "Unsupported value: 'reasoning_effort' does not support 'none' with this model.", param: "reasoning_effort" });
    expect(failure?.message).toMatch(/Narrarium asked again without a thinking level and with "none", and the model still refuses function tools on this endpoint: the provider says to use \/v1\/responses for them\.$/);
    expect(flagOf(model)).toBeUndefined();
    expect(useLearnedModelsStore.getState().notices).toHaveLength(0);
    expect(mocks.toast).not.toHaveBeenCalled();
    expect((await ai.complete(ASK)).text).toBe("prose");
    expect(levelOf(last(fake.calls))).toBe("high");
  });

  it("says in the debug panel that every request was refused, and the Copilot tells the provider's words as fields above the sentence", async () => {
    const fixture = gateway();
    useProvider(fixture, settingsFor(fixture, model), refusing());
    const failure = await createBrowserAi().complete(STRUCTURED).then(() => null, (error: unknown) => error);
    expect(entries().map((entry) => entry.status)).toEqual(["error", "error", "error"]);
    expect(entries()[0]).toMatchObject({ thinking: "none", thinkingWhy: "tools", providerError: { status: 400, type: "invalid_request_error", param: "reasoning_effort", code: "unsupported_value" } });
    const reply = describeAiFailure(failure, i18n.t.bind(i18n) as never);
    expect(reply?.text).toContain("- **Message:** Unsupported value: 'reasoning_effort' does not support 'none' with this model.");
    expect(reply?.text).toContain("- **Code:** unsupported_value");
    expect(reply?.text).toContain("the provider says to use /v1/responses for them");
  });
});

describe("what the page does when a model is learned", () => {
  it("keeps the notice once, with the provider's own words and the Responses API first, and says it in a message that stays, since a call of the Copilot has no page for the notice", async () => {
    const fixture = gateway();
    useProvider(fixture, settingsFor(fixture, "gpt-5.6-sol"), refusing());
    const ai = createBrowserAi();
    await ai.complete(STRUCTURED);
    await ai.complete(STRUCTURED);
    const { notices } = useLearnedModelsStore.getState();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ key: learnedKey("gw", "gpt-5.6-sol"), integrationName: "AzureOpenAi-GW", model: "gpt-5.6-sol", responses: true, off: "omit", body: SOL_BODY });
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1));
    const [message] = mocks.toast.mock.calls[0] as [{ title: string; description: string; duration: number }];
    expect(message.title).toBe("gpt-5.6-sol: thinking is turned off when tools are used; the provider said so");
    expect(message.description).toContain("AzureOpenAi-GW says to use the Responses API for this model, or to turn thinking off when tools are used.");
    expect(message.description).toContain("requests without tools keep their thinking");
    expect(message.duration).toBeGreaterThanOrEqual(20_000);
  });

  it.each([["gpt-5.6-sol", true], ["gpt-6-luna", "none"]] as const)("saves %s on the device with the rest of the settings (%j): read back, migrated and sent to a personal server, the model still has it", async (name, way) => {
    const fixture = gateway();
    useProvider(fixture, settingsFor(fixture, name), refusing());
    await createBrowserAi().complete(STRUCTURED);
    await waitFor(async () => {
      const snapshot = await loadLocalAccountSnapshot();
      expect(snapshot?.data.settings.aiIntegrations[0].chatModels?.find((model) => model.name === name)?.noThinkingWithTools).toBe(way);
    });
    const saved = (await loadLocalAccountSnapshot())!.data.settings;
    const wire = JSON.parse(JSON.stringify(saved));
    const loaded = migrateSettings(wire);
    expect(loaded.aiIntegrations[0].chatModels?.find((model) => model.name === name)?.noThinkingWithTools).toBe(way);
    expect("noThinkingWithTools" in (loaded.aiIntegrations[0].chatModels?.find((model) => model.name === "gpt-6.2-sol") ?? {})).toBe(false);
    const config = pickAiRuntimeConfig(loaded);
    expect(config.aiIntegrations[0].chatModels?.find((model) => model.name === name)?.noThinkingWithTools).toBe(way);
    expect(redactAiRuntimeConfig(pickAiRuntimeConfig(JSON.parse(JSON.stringify(config)))).integrations[0].models.find((model) => model.name === name)?.noThinkingWithTools).toBe(way);
  });

  it.each([["gpt-5.6-sol", true, undefined], ["gpt-6-luna", "none", "none"]] as const)("is already known after a reload: the settings read back make the first request of %s what it takes (%j), and nothing is refused", async (name, flag, level) => {
    const fixture = gateway();
    const flagged = settingsFor(fixture, name);
    flagged.aiIntegrations[0].chatModels!.find((entry) => entry.name === name)!.noThinkingWithTools = flag;
    const fake = useProvider(fixture, flagged, refusing());
    const result = await createBrowserAi().complete(STRUCTURED);
    expect(result.json).toEqual({ ok: true });
    expect(fake.calls.map(levelOf)).toEqual([level]);
    expect(useLearnedModelsStore.getState().notices, "nothing was learned: the author said it").toHaveLength(0);
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("does not swallow another 400: it fails at once with its own words, and nothing is learned", async () => {
    const fixture = gateway();
    const fake = useProvider(fixture, settingsFor(fixture, "gpt-6-luna"), () => new Response(JSON.stringify({ error: { message: "Invalid schema for function 'result'.", type: "invalid_request_error", param: "tools[0].function.parameters", code: "invalid_function_parameters" } }), { status: 400, headers: { "content-type": "application/json" } }));
    const failure = await createBrowserAi().complete(STRUCTURED).then(() => null, (error: { body?: AiErrorBody; message: string }) => error);
    expect(fake.calls).toHaveLength(1);
    expect(failure?.body).toMatchObject({ status: 400, message: "Invalid schema for function 'result'.", type: "invalid_request_error", param: "tools[0].function.parameters", code: "invalid_function_parameters" });
    expect(flagOf("gpt-6-luna")).toBeUndefined();
    expect(useLearnedModelsStore.getState().notices).toHaveLength(0);
    expect(last(entries())).toMatchObject({ status: "error", providerError: { status: 400, type: "invalid_request_error", param: "tools[0].function.parameters", code: "invalid_function_parameters" } });
  });

  it("learns it from a fallback: the primary that is down is not the model that refused, and only the fallback gets the setting", async () => {
    const fixture = gateway();
    const settings = settingsOf([fixture], { taskRouting: { autopilot: { primary: { integrationId: "gw", model: "gpt-6-luna" }, fallbacks: [{ integrationId: "gw", model: "gpt-5.6-sol" }] } } });
    const fake = useProvider(fixture, settings, (call) => (call.body.model === "gpt-6-luna" ? failReply(500, "The primary is down.") : refusing()(call)));
    const result = await createBrowserAi().complete(STRUCTURED);
    expect(result.json).toEqual({ ok: true });
    expect(fake.calls.map((call) => [call.body.model, levelOf(call)])).toEqual([["gpt-6-luna", "high"], ["gpt-5.6-sol", "high"], ["gpt-5.6-sol", undefined]]);
    expect(flagOf("gpt-5.6-sol")).toBe(true);
    expect(flagOf("gpt-6-luna")).toBeUndefined();
  });
});

describe("the model's own API version and the setting that was learned", () => {
  const KEY = "az-key-0123456789abcdef";
  const azure: Fixture = {
    integration: { id: "az", name: "Studio Azure", provider: "azure_openai", endpoint: "https://res.openai.azure.com", apiKey: KEY, apiVersion: "2025-01-01-preview", thinking: "high", chatModels: [chatModel("gpt-6-luna", { apiVersion: "2025-04-01-preview" }), chatModel("gpt-5.6-sol")] },
    endpoint: { id: "az", apiKey: KEY, base: "https://res.openai.azure.com", auth: "api-key" },
  };
  const versionOf = (url: string) => new URL(url).searchParams.get("api-version");

  it("do not touch each other: the refused request and the one asked again carry the model's version, the setting does not take it away, and the model next to it keeps its level and the integration's version", async () => {
    const fake = createFakeProvider([azure.endpoint], refusing(), [GITHUB_TOKEN]);
    vi.stubGlobal("fetch", fake.fetch);
    useSettingsStore.setState({ settings: settingsOf([azure], { taskRouting: { autopilot: { primary: { integrationId: "az", model: "gpt-6-luna" }, fallbacks: [] } } }) });
    await createBrowserAi().complete(STRUCTURED);
    expect(fake.calls.map((call) => [versionOf(call.url), levelOf(call)])).toEqual([["2025-04-01-preview", "high"], ["2025-04-01-preview", undefined], ["2025-04-01-preview", "none"]]);
    expect(modelsOf().map((model) => [model.name, model.apiVersion, model.noThinkingWithTools])).toEqual([["gpt-6-luna", "2025-04-01-preview", "none"], ["gpt-5.6-sol", undefined, undefined]]);
    expect(entries().map((entry) => entry.apiVersion)).toEqual(Array(3).fill("2025-04-01-preview"));

    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, taskRouting: { autopilot: { primary: { integrationId: "az", model: "gpt-5.6-sol" }, fallbacks: [] } } } });
    await createBrowserAi().complete(STRUCTURED);
    expect(fake.calls.slice(3).map((call) => [versionOf(call.url), levelOf(call)])).toEqual([["2025-01-01-preview", "high"], ["2025-01-01-preview", undefined]]);
    expect(last(fake.calls).url).toContain("/gpt-5.6-sol/");
  });

  it("travel together to the personal server: the configuration says the model's version and its setting, and the settings read back say them too", () => {
    const settings = settingsOf([azure]);
    settings.aiIntegrations[0].chatModels![0].noThinkingWithTools = "none";
    const sent = JSON.parse(JSON.stringify(pickAiRuntimeConfig(settings)));
    const luna = sent.aiIntegrations[0].chatModels.find((model: { name: string }) => model.name === "gpt-6-luna");
    expect([luna.apiVersion, luna.noThinkingWithTools]).toEqual(["2025-04-01-preview", "none"]);
    const safe = redactAiRuntimeConfig(pickAiRuntimeConfig(sent)).integrations[0].models.find((model) => model.name === "gpt-6-luna");
    expect([safe?.apiVersion, safe?.noThinkingWithTools]).toEqual(["2025-04-01-preview", "none"]);
  });
});

describe("rememberLearnedModel", () => {
  const input = { integrationId: "gw", integrationName: "AzureOpenAi-GW", model: "gpt-6-luna", body: OWNER_BODY, off: "omit" as const };

  it("says it once for a model: a second time, or a model that has the setting already, is no news", () => {
    const fixture = gateway();
    useSettingsStore.setState({ settings: settingsFor(fixture, "gpt-6-luna") });
    rememberLearnedModel(input);
    rememberLearnedModel(input, { announce: true });
    expect(useLearnedModelsStore.getState().notices).toHaveLength(1);
    expect(mocks.toast, "the run said it first as an event: the call that taught it says nothing more").not.toHaveBeenCalled();
    expect(flagOf("gpt-6-luna")).toBe(true);
    useLearnedModelsStore.getState().dismiss(learnedKey("gw", "gpt-6-luna"));
    rememberLearnedModel(input, { announce: true });
    expect(useLearnedModelsStore.getState().notices, "the model had the setting already").toHaveLength(0);
  });

  it("learns that a model takes none better than the setting it had: the setting becomes none, the notice says it, and a model that takes none is not made to leave the level out again", () => {
    const fixture = gateway();
    useSettingsStore.setState({ settings: settingsFor(fixture, "gpt-6-luna") });
    rememberLearnedModel(input);
    expect(flagOf("gpt-6-luna")).toBe(true);
    rememberLearnedModel({ ...input, off: "none" });
    expect(flagOf("gpt-6-luna")).toBe("none");
    expect(useLearnedModelsStore.getState().notices.map((notice) => [notice.model, notice.off])).toEqual([["gpt-6-luna", "none"]]);
    rememberLearnedModel(input);
    expect(flagOf("gpt-6-luna"), "what takes none is not asked without a level again").toBe("none");
  });

  it("keeps the notice for a model this browser does not list (a run of the server with its own configuration) and changes nothing of the settings", () => {
    const fixture = gateway();
    const settings = settingsFor(fixture, "gpt-6-luna");
    useSettingsStore.setState({ settings });
    rememberLearnedModel({ ...input, integrationId: "elsewhere", model: "another-model" });
    expect(useLearnedModelsStore.getState().notices.map((notice) => notice.model)).toEqual(["another-model"]);
    expect(useSettingsStore.getState().settings.aiIntegrations).toEqual(settings.aiIntegrations);
  });

  it("does not stop the call that taught it when the settings cannot be changed (the browser is offline): the notice is there, the engine remembers the model", () => {
    const fixture = gateway();
    useSettingsStore.setState({ settings: settingsFor(fixture, "gpt-6-luna") });
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    expect(() => rememberLearnedModel(input)).not.toThrow();
    online.mockRestore();
    expect(useLearnedModelsStore.getState().notices).toHaveLength(1);
    expect(flagOf("gpt-6-luna")).toBeUndefined();
  });

  it("sets and clears the flag on the model of that name in that integration only", () => {
    const fixture = gateway();
    const settings = settingsFor(fixture, "gpt-6-luna");
    const on = withNoThinkingWithTools(settings, "gw", "gpt-6.2-sol", true)!;
    expect(on.aiIntegrations[0].chatModels!.map((model) => model.noThinkingWithTools)).toEqual([undefined, true, undefined]);
    expect(withNoThinkingWithTools(on, "gw", "gpt-6.2-sol", true), "it has it already").toBeNull();
    expect(withNoThinkingWithTools(on, "gw", "gpt-6.2-sol", "none")!.aiIntegrations[0].chatModels![1].noThinkingWithTools).toBe("none");
    const off = withNoThinkingWithTools(on, "gw", "gpt-6.2-sol", false)!;
    expect("noThinkingWithTools" in off.aiIntegrations[0].chatModels![1]).toBe(false);
    expect(withNoThinkingWithTools(settings, "other", "gpt-6.2-sol", true)).toBeNull();
    expect(withNoThinkingWithTools(settings, "gw", "no-such-model", true)).toBeNull();
  });
});

describe.each(LANGUAGES)("the feed of the autopilot [%s]", (language: Language) => {
  it("says the notice of the engine in the language of the app with the name of the model, with the engine's detail under it, and keeps the engine's words for a host that does not name the model", async () => {
    await i18n.changeLanguage(language);
    const event = { type: "insight", bookId: "book-1", at: "2026-11-25T10:00:00.000Z", seq: 1, tone: "warning", code: "modelLearned", model: "gpt-6-luna", title: "The engine's title", detail: "The provider answered: …" } as AutopilotEvent;
    const say = i18n.t.bind(i18n) as never;
    const shown = presentFeedEvent(say, event)!;
    expect(shown.text).toBe(t("autopilot.learned.title", { model: "gpt-6-luna" }));
    expect(shown.detail).toBe("The provider answered: …");
    expect(shown.tone).toBe("warning");
    expect(presentFeedEvent(say, { ...event, model: undefined } as AutopilotEvent)!.text).toBe("The engine's title");
  });
});

describe("what a run on the personal server learned", () => {
  it("is kept by the page that hears it: the model's setting, and the notice, with the words of the provider", async () => {
    const fixture = gateway();
    useSettingsStore.setState({ settings: settingsFor(fixture, "gpt-6-luna") });
    const runtime = autopilotRuntime as unknown as { onServerMessage(message: { event: "autopilot"; data: AutopilotEvent }): void };
    runtime.onServerMessage({ event: "autopilot", data: { type: "model-learned", bookId: "book-1", at: new Date().toISOString(), seq: 1, learned: "no-thinking-with-tools", integrationId: "gw", integrationName: "AzureOpenAi-GW", model: "gpt-6-luna", off: "none", body: OWNER_BODY, responses: true } });
    expect(flagOf("gpt-6-luna")).toBe("none");
    expect(useLearnedModelsStore.getState().notices.map((notice) => [notice.model, notice.responses, notice.body.param])).toEqual([["gpt-6-luna", true, "reasoning_effort"]]);
    expect(mocks.toast, "a run says it in its own feed and in the page, not in a message").not.toHaveBeenCalled();
  });
});

describe.each(LANGUAGES)("the notice [%s]", (language: Language) => {
  const notice = (responses: boolean) => useLearnedModelsStore.setState({ notices: [{ key: learnedKey("gw", "gpt-6-luna"), integrationId: "gw", integrationName: "AzureOpenAi-GW", model: "gpt-6-luna", body: OWNER_BODY, responses, off: "omit", at: 1 }] });
  const show = async () => {
    await i18n.changeLanguage(language);
    return render(<MemoryRouter><LearnedModelNotices /></MemoryRouter>);
  };

  it("says what was done, the provider's own words as fields, and the two ways out in plain words, the Responses API first", async () => {
    notice(true);
    await show();
    const card = document.querySelector("[data-learned-model]") as HTMLElement;
    expect(card).toHaveAttribute("role", "status");
    expect(within(card).getByRole("heading")).toHaveTextContent(t("autopilot.learned.title", { model: "gpt-6-luna" }));
    expect(within(card).getByText(t("autopilot.learned.said", { name: "AzureOpenAi-GW" }))).toBeInTheDocument();
    const words = card.querySelector("[data-provider-words]") as HTMLElement;
    expect(words.querySelector("[data-provider-field=\"status\"]")?.nextElementSibling).toHaveTextContent("400");
    expect(words.querySelector("[data-provider-field=\"message\"]")?.nextElementSibling?.textContent).toBe(MESSAGE("gpt-6-luna"));
    expect(words.querySelector("[data-provider-field=\"param\"]")?.nextElementSibling).toHaveTextContent("reasoning_effort");
    expect(within(card).getByText(t("autopilot.learned.waysTitle"))).toBeInTheDocument();
    const ways = Array.from(card.querySelectorAll("[data-learned-way]")).map((way) => [way.getAttribute("data-learned-way"), way.textContent]);
    expect(ways).toEqual([["responses", t("autopilot.learned.wayResponses")], ["no-thinking", t("autopilot.learned.wayOff")]]);
    expect(within(card).getByRole("link", { name: t("autopilot.learned.openSettings") })).toHaveAttribute("href", "/app/settings/ai-integrations");
  });

  it("says only what was done when the provider's words do not tell to use the Responses API", async () => {
    notice(false);
    await show();
    const card = document.querySelector("[data-learned-model]") as HTMLElement;
    expect(card).not.toHaveAttribute("data-learned-responses");
    expect(within(card).getByText(t("autopilot.learned.doneTitle"))).toBeInTheDocument();
    expect(Array.from(card.querySelectorAll("[data-learned-way]")).map((way) => way.getAttribute("data-learned-way"))).toEqual(["no-thinking"]);
  });

  it("goes away when it is dismissed, and is not there when there is nothing to say", async () => {
    notice(true);
    const view = await show();
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.learned.dismiss") }));
    expect(document.querySelector("[data-learned-model]")).toBeNull();
    expect(view.container).toBeEmptyDOMElement();
  });
});

describe.each(LANGUAGES)("the model editor [%s]", (language: Language) => {
  const azure = (models: Array<Record<string, unknown>>) => ({ id: "az", name: "AzureOpenAi-GW", provider: "azure_openai", endpoint: "https://x.openai.azure.com", apiKey: "k", apiVersion: "2025-01-01-preview", chatModels: models.map((model) => ({ capabilities: ["default"], ...model })) }) as never;
  const boxes = (card: HTMLElement) => Array.from(card.querySelectorAll<HTMLInputElement>("[data-no-thinking-with-tools] input[type=\"checkbox\"]"));

  it("has the checkbox in the row of each model, ticked for the ones that have the setting, named after the word and the model, and described by the help of the card", async () => {
    await showIntegrations([azure([{ id: "m1", name: "gpt-6-luna", noThinkingWithTools: "none" }, { id: "m2", name: "gpt-6.2-sol" }, { id: "m3", name: "gpt-5.6-sol", noThinkingWithTools: true }])], language);
    const card = cardOf("AzureOpenAi-GW");
    const [luna, sol, mid] = boxes(card);
    expect(luna, "learned as a model that takes none").toBeChecked();
    expect(mid, "ticked by hand").toBeChecked();
    expect(sol).not.toBeChecked();
    expect(luna).toHaveAccessibleName(`${t("settings.noThinkingWithTools")} — gpt-6-luna`);
    expect(sol).toHaveAccessibleName(`${t("settings.noThinkingWithTools")} — gpt-6.2-sol`);
    expect(luna).toHaveAccessibleDescription(t("settings.noThinkingWithToolsHint"));
    expect(card.querySelector("[data-no-thinking-with-tools]")).toHaveAttribute("data-no-thinking-with-tools", "on");
  });

  it("stores true when it is ticked and nothing when it is cleared, for that model only", async () => {
    await showIntegrations([azure([{ id: "m1", name: "gpt-6-luna" }, { id: "m2", name: "gpt-6.2-sol" }])], language);
    const card = cardOf("AzureOpenAi-GW");
    fireEvent.click(boxes(card)[1]);
    expect(stored().chatModels!.map((model) => model.noThinkingWithTools)).toEqual([undefined, true]);
    fireEvent.click(boxes(cardOf("AzureOpenAi-GW"))[1]);
    expect(stored().chatModels!.map((model) => model.noThinkingWithTools)).toEqual([undefined, undefined]);
    const saved = JSON.parse(JSON.stringify(useSettingsStore.getState().settings));
    expect(saved.aiIntegrations[0].chatModels.some((model: Record<string, unknown>) => "noThinkingWithTools" in model), "off is no key in what is saved: the settings of before and a model that never had it are the same").toBe(false);
  });

  it("is there for a model that has just been added, unticked, and ticking it is stored with the model", async () => {
    await showIntegrations([azure([{ id: "m1", name: "gpt-6-luna" }])], language);
    fireEvent.click(within(cardOf("AzureOpenAi-GW")).getByRole("button", { name: t("settings.addChatModel") }));
    const added = boxes(cardOf("AzureOpenAi-GW"));
    expect(added).toHaveLength(2);
    expect(added[1]).not.toBeChecked();
    fireEvent.click(added[1]);
    expect(stored().chatModels!.map((model) => model.noThinkingWithTools)).toEqual([undefined, true]);
  });

  it("shows a setting that the page learned while the editor is open", async () => {
    await showIntegrations([azure([{ id: "m1", name: "gpt-6-luna" }])], language);
    expect(boxes(cardOf("AzureOpenAi-GW"))[0]).not.toBeChecked();
    act(() => rememberLearnedModel({ integrationId: "az", integrationName: "AzureOpenAi-GW", model: "gpt-6-luna", body: OWNER_BODY, off: "none" }));
    await waitFor(() => expect(boxes(cardOf("AzureOpenAi-GW"))[0]).toBeChecked());
  });
});
