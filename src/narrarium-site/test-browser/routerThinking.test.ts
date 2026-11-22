import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("openai", () => {
  class MockOpenAI {
    chat = { completions: { create: mocks.create } };
  }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI };
});

import { classifyConfirmationWith, completeText, completeToolWith } from "@/assistant/llm";
import { classifyConfirmationRouted, completeTextRouted, completeToolRouted, reconcileTaskRouting, sanitizeTaskRouting } from "@/assistant/router";
import { migrateSettings } from "@/drive/cloudSettingsClient";
import { projectSafeSettings } from "@/drive/settingsCache";
import { THINKING_LEVELS, effectiveThinking, isThinkingLevel, normalizeThinking, reasoningEffortFor, reasoningParams } from "@/router/thinking";
import { DEFAULT_SETTINGS, type AIIntegration, type AppSettings, type ReasoningParameter, type RoutingTarget, type TaskRoute, type ThinkingLevel } from "@/types/settings";

const tool = { name: "score", description: "Score", parameters: { type: "object", properties: { score: { type: "number" } }, required: ["score"] } };
const ok = { choices: [{ message: { content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } };
const toolOk = { choices: [{ message: { tool_calls: [{ function: { arguments: "{\"score\":8}" } }] }, finish_reason: "tool_calls" }] };
const yes = { choices: [{ message: { tool_calls: [{ function: { arguments: "{\"decision\":\"yes\"}" } }] } }] };
const sent = (index: number) => mocks.create.mock.calls[index][0] as Record<string, unknown>;

function integration(id: string, extra: Partial<AIIntegration> = {}): AIIntegration {
  return { id, name: id, provider: "openai", apiKey: "key", endpoint: `https://${id}.test/v1`, chatModels: [{ id: `m-${id}`, name: `model-${id}`, capabilities: ["default", "review", "director", "simple-tasks"] }], ...extra };
}
const target = (id: string, thinking?: RoutingTarget["thinking"]): RoutingTarget => ({ integrationId: id, model: `model-${id}`, ...(thinking ? { thinking } : {}) });
const route = (primary: RoutingTarget, ...fallbacks: RoutingTarget[]): TaskRoute => ({ primary, fallbacks });
const settingsOf = (integrations: AIIntegration[], taskRouting?: AppSettings["taskRouting"]): AppSettings => ({ ...DEFAULT_SETTINGS, aiIntegrations: integrations, taskRouting });

describe("the levels of thinking", () => {
  it("knows the five values the router stores, in the order the table lists them", () => {
    expect(THINKING_LEVELS).toEqual(["automatic", "low", "medium", "high", "xhigh"]);
    for (const level of THINKING_LEVELS) expect(isThinkingLevel(level)).toBe(true);
    for (const wrong of ["", "extreme", "High", null, undefined, 3, {}]) expect(isThinkingLevel(wrong)).toBe(false);
  });

  it("keeps a valid value and drops everything else", () => {
    expect(normalizeThinking("high")).toBe("high");
    expect(normalizeThinking("automatic")).toBe("automatic");
    expect(normalizeThinking("")).toBeUndefined();
    expect(normalizeThinking("extreme")).toBeUndefined();
    expect(normalizeThinking(undefined)).toBeUndefined();
  });

  it("sends a level to the provider only when it is explicit: low, medium, high or xhigh; never automatic, blank or anything else", () => {
    expect(["low", "medium", "high", "xhigh"].map((level) => reasoningEffortFor(level as never))).toEqual(["low", "medium", "high", "xhigh"]);
    expect(reasoningEffortFor("automatic")).toBeUndefined();
    expect(reasoningEffortFor(undefined)).toBeUndefined();
    expect(reasoningEffortFor("extreme" as never)).toBeUndefined();
  });

  it("takes the level of the target first, then the one of the integration, and lets \"automatic\" on the target win over the integration", () => {
    expect(effectiveThinking({ thinking: "low" }, { thinking: "high" })).toBe("low");
    expect(effectiveThinking({}, { thinking: "high" })).toBe("high");
    expect(effectiveThinking(undefined, { thinking: "medium" })).toBe("medium");
    expect(effectiveThinking({ thinking: "automatic" }, { thinking: "high" })).toBe("automatic");
    expect(effectiveThinking({}, {})).toBeUndefined();
    expect(effectiveThinking(undefined, undefined)).toBeUndefined();
  });
});

describe("a request of the site's own (the Copilot) carries reasoning_effort only for an explicit level", () => {
  beforeEach(() => mocks.create.mockReset());
  const openai = integration("local");
  const azure = integration("cloud", { provider: "azure_openai", endpoint: "https://x.openai.azure.com", apiVersion: "2024-10-21" });

  it.each(["low", "medium", "high", "xhigh"] as const)("completeText sends %s, in a reply that arrives at once and in one that streams", async (level) => {
    mocks.create.mockResolvedValueOnce(ok);
    await completeText(openai, [{ role: "user", content: "x" }], "writing", { accountScope: null, modelName: "muse", thinking: level });
    expect(sent(0)).toMatchObject({ model: "muse", reasoning_effort: level });
    mocks.create.mockResolvedValueOnce({ async *[Symbol.asyncIterator]() { yield { choices: [{ delta: { content: "a" } }] }; yield { choices: [{ delta: {}, finish_reason: "stop" }] }; } });
    await completeText(azure, [{ role: "user", content: "x" }], "writing", { accountScope: null, modelName: "dep", thinking: level, onText: () => undefined });
    expect(sent(1)).toMatchObject({ stream: true, reasoning_effort: level });
  });

  it("completeText leaves the parameter out for automatic, for no level, and for a value it does not know", async () => {
    for (const thinking of ["automatic", undefined, "extreme"] as Array<ThinkingLevel | undefined>) {
      mocks.create.mockResolvedValueOnce(ok);
      await completeText(openai, [{ role: "user", content: "x" }], "writing", { accountScope: null, modelName: "muse", thinking });
    }
    for (let index = 0; index < 3; index += 1) expect(Object.keys(sent(index))).not.toContain("reasoning_effort");
  });

  it("the forced tool call and the confirmation carry it too", async () => {
    mocks.create.mockResolvedValueOnce(toolOk);
    await completeToolWith(openai, "muse", undefined, [{ role: "user", content: "score" }], "review", tool, { accountScope: null, thinking: "xhigh" });
    expect(sent(0)).toMatchObject({ tool_choice: "required", reasoning_effort: "xhigh" });
    mocks.create.mockResolvedValueOnce(yes);
    await expect(classifyConfirmationWith(openai, "muse", undefined, "yes", { accountScope: null, thinking: "low" })).resolves.toBe("yes");
    expect(sent(1)).toMatchObject({ reasoning_effort: "low" });
    mocks.create.mockResolvedValueOnce(toolOk);
    await completeToolWith(openai, "muse", undefined, [{ role: "user", content: "score" }], "review", tool, { accountScope: null, thinking: "automatic" });
    expect(Object.keys(sent(2))).not.toContain("reasoning_effort");
    mocks.create.mockResolvedValueOnce(yes);
    await classifyConfirmationWith(openai, "muse", undefined, "yes", { accountScope: null });
    expect(Object.keys(sent(3))).not.toContain("reasoning_effort");
  });
});

describe("the thinking parameter of the model decides where the level goes, in a request of the site's own", () => {
  beforeEach(() => mocks.create.mockReset());
  const TEMPLATE = "chat_template_kwargs.reasoning_strength";
  const openai = integration("local");
  const messages = [{ role: "user" as const, content: "x" }];
  const stream = () => ({ async *[Symbol.asyncIterator]() { yield { choices: [{ delta: { content: "a" } }] }; yield { choices: [{ delta: {}, finish_reason: "stop" }] }; } });
  /** What a request carries of the level: the OpenAI field, the argument of the chat template, both or none. */
  const carried = (index: number) => ({ effort: sent(index).reasoning_effort, template: sent(index).chat_template_kwargs });

  it("builds the field of the level by the parameter: reasoning_effort unless the model says otherwise, the argument of the chat template, or nothing", () => {
    expect(reasoningParams("high")).toEqual({ reasoning_effort: "high" });
    expect(reasoningParams("high", "reasoning_effort")).toEqual({ reasoning_effort: "high" });
    expect(reasoningParams("xhigh", TEMPLATE)).toEqual({ chat_template_kwargs: { reasoning_strength: "xhigh" } });
    expect(reasoningParams("high", "none")).toEqual({});
  });

  it.each(["automatic", undefined, "extreme"] as Array<ThinkingLevel | undefined>)("sends no level in any form when the level is %s, whatever the parameter is", (level) => {
    for (const parameter of [undefined, "reasoning_effort", TEMPLATE, "none"] as Array<ReasoningParameter | undefined>) expect(reasoningParams(level, parameter)).toEqual({});
  });

  it("goes on as reasoning_effort for a parameter it does not know: the engine drops it, and so does the site", () => {
    expect(reasoningParams("low", "chat_template_kwargs.enable_thinking" as ReasoningParameter)).toEqual({ reasoning_effort: "low" });
    expect(reasoningParams("low", 3 as unknown as ReasoningParameter)).toEqual({ reasoning_effort: "low" });
  });

  it.each([undefined, "reasoning_effort"] as const)("completeText sends reasoning_effort when the model says %s, in a reply that arrives at once and in one that streams", async (parameter) => {
    mocks.create.mockResolvedValueOnce(ok);
    await completeText(openai, messages, "writing", { accountScope: null, modelName: "muse", thinking: "high", reasoningParameter: parameter });
    expect(carried(0)).toEqual({ effort: "high", template: undefined });
    mocks.create.mockResolvedValueOnce(stream());
    await completeText(openai, messages, "writing", { accountScope: null, modelName: "muse", thinking: "high", onText: () => undefined, reasoningParameter: parameter });
    expect(carried(1)).toEqual({ effort: "high", template: undefined });
  });

  it("completeText sends the argument of the chat template, and no reasoning_effort, when the model says so: at once and streamed", async () => {
    mocks.create.mockResolvedValueOnce(ok);
    await completeText(openai, messages, "writing", { accountScope: null, modelName: "muse-glimmer-30b", thinking: "medium", reasoningParameter: TEMPLATE });
    expect(carried(0)).toEqual({ effort: undefined, template: { reasoning_strength: "medium" } });
    expect(Object.keys(sent(0))).not.toContain("reasoning_effort");
    mocks.create.mockResolvedValueOnce(stream());
    await completeText(openai, messages, "writing", { accountScope: null, modelName: "muse-glimmer-30b", thinking: "medium", onText: () => undefined, reasoningParameter: TEMPLATE });
    expect(sent(1)).toMatchObject({ stream: true, chat_template_kwargs: { reasoning_strength: "medium" } });
    expect(Object.keys(sent(1))).not.toContain("reasoning_effort");
  });

  it("the forced tool call and the confirmation carry it the same way", async () => {
    mocks.create.mockResolvedValueOnce(toolOk);
    await completeToolWith(openai, "muse", undefined, [{ role: "user", content: "score" }], "review", tool, { accountScope: null, thinking: "xhigh", reasoningParameter: TEMPLATE });
    expect(sent(0)).toMatchObject({ tool_choice: "required", chat_template_kwargs: { reasoning_strength: "xhigh" } });
    expect(Object.keys(sent(0))).not.toContain("reasoning_effort");
    mocks.create.mockResolvedValueOnce(yes);
    await expect(classifyConfirmationWith(openai, "muse", undefined, "yes", { accountScope: null, thinking: "low", reasoningParameter: TEMPLATE })).resolves.toBe("yes");
    expect(carried(1)).toEqual({ effort: undefined, template: { reasoning_strength: "low" } });
  });

  it("sends no level at all for none, even when a level is asked for: it is no level, and it does not turn thinking off", async () => {
    mocks.create.mockResolvedValueOnce(ok);
    await completeText(openai, messages, "writing", { accountScope: null, modelName: "muse", thinking: "high", reasoningParameter: "none" });
    mocks.create.mockResolvedValueOnce(toolOk);
    await completeToolWith(openai, "muse", undefined, [{ role: "user", content: "score" }], "review", tool, { accountScope: null, thinking: "high", reasoningParameter: "none" });
    mocks.create.mockResolvedValueOnce(yes);
    await classifyConfirmationWith(openai, "muse", undefined, "yes", { accountScope: null, thinking: "high", reasoningParameter: "none" });
    for (let index = 0; index < 3; index += 1) {
      expect(Object.keys(sent(index))).not.toContain("reasoning_effort");
      expect(Object.keys(sent(index))).not.toContain("chat_template_kwargs");
    }
  });

  it("takes the word of the model through the router: the candidate carries it from the model, and a fallback has the word of its own model", async () => {
    const a = integration("a", { thinking: "medium", chatModels: [{ id: "m-a", name: "model-a", capabilities: ["director"], reasoningParameter: TEMPLATE }] });
    const b = integration("b", { thinking: "low" });
    mocks.create.mockRejectedValueOnce(new Error("rate limited")).mockResolvedValueOnce(ok);
    await expect(completeTextRouted(settingsOf([a, b], { director: route(target("a"), target("b")) }), messages, "director", { accountScope: null })).resolves.toBe("done");
    expect(carried(0)).toEqual({ effort: undefined, template: { reasoning_strength: "medium" } });
    expect(carried(1)).toEqual({ effort: "low", template: undefined });
  });

  it("takes it from the model for a task that has no route of its own, which goes to the Default route's integration", async () => {
    const a = integration("a", { thinking: "high", chatModels: [{ id: "m-a", name: "model-a", capabilities: ["default"], reasoningParameter: "none" }] });
    mocks.create.mockResolvedValueOnce(ok);
    await completeTextRouted(settingsOf([a], { default: route(target("a")) }), messages, "editor-actions", { accountScope: null });
    expect(carried(0)).toEqual({ effort: undefined, template: undefined });
  });

  it("reaches the forced tool call and the confirmation of the routed paths too", async () => {
    const a = integration("a", { thinking: "high", chatModels: [{ id: "m-a", name: "model-a", capabilities: ["review", "simple-tasks"], reasoningParameter: TEMPLATE }] });
    const settings = settingsOf([a], { review: route(target("a")), "simple-tasks": route(target("a")) });
    mocks.create.mockResolvedValueOnce(toolOk);
    await completeToolRouted(settings, [{ role: "user", content: "score" }], "review", tool, { accountScope: null });
    expect(sent(0)).toMatchObject({ chat_template_kwargs: { reasoning_strength: "high" } });
    mocks.create.mockResolvedValueOnce(yes);
    await classifyConfirmationRouted(settings, "yes", undefined, null);
    expect(sent(1)).toMatchObject({ chat_template_kwargs: { reasoning_strength: "high" } });
    expect(Object.keys(sent(1))).not.toContain("reasoning_effort");
  });
});

describe("the router hands each candidate its own level", () => {
  beforeEach(() => mocks.create.mockReset());
  const messages = [{ role: "user" as const, content: "write" }];

  it("sends the primary its level and, when it fails, the fallback its own", async () => {
    const routing = { director: route(target("a", "high"), target("b", "low")) };
    mocks.create.mockRejectedValueOnce(new Error("rate limited")).mockResolvedValueOnce(ok);
    await expect(completeTextRouted(settingsOf([integration("a"), integration("b")], routing), messages, "director", { accountScope: null })).resolves.toBe("done");
    expect(sent(0)).toMatchObject({ model: "model-a", reasoning_effort: "high" });
    expect(sent(1)).toMatchObject({ model: "model-b", reasoning_effort: "low" });
  });

  it("falls back to the level of the integration when the target has none, and lets the target's \"automatic\" switch it off", async () => {
    mocks.create.mockResolvedValue(ok);
    const inherited = settingsOf([integration("a", { thinking: "medium" })], { director: route(target("a")) });
    await completeTextRouted(inherited, messages, "director", { accountScope: null });
    expect(sent(0)).toMatchObject({ reasoning_effort: "medium" });
    const off = settingsOf([integration("a", { thinking: "medium" })], { director: route(target("a", "automatic")) });
    await completeTextRouted(off, messages, "director", { accountScope: null });
    expect(Object.keys(sent(1))).not.toContain("reasoning_effort");
    const own = settingsOf([integration("a", { thinking: "medium" })], { director: route(target("a", "xhigh")) });
    await completeTextRouted(own, messages, "director", { accountScope: null });
    expect(sent(2)).toMatchObject({ reasoning_effort: "xhigh" });
  });

  it("sends nothing when neither the target nor the integration names a level", async () => {
    mocks.create.mockResolvedValue(ok);
    await completeTextRouted(settingsOf([integration("a")], { director: route(target("a")) }), messages, "director", { accountScope: null });
    expect(Object.keys(sent(0))).not.toContain("reasoning_effort");
  });

  it("gives a task without a route of its own the level of the integration it is resolved to", async () => {
    mocks.create.mockResolvedValue(ok);
    await completeTextRouted(settingsOf([integration("a", { thinking: "high" })]), messages, "director", { accountScope: null });
    expect(sent(0)).toMatchObject({ reasoning_effort: "high" });
  });

  it("gives a model picked by hand (an override) the level of its integration", async () => {
    mocks.create.mockResolvedValue(ok);
    const configured = settingsOf([integration("a", { thinking: "low" }), integration("b", { thinking: "high" })], { default: route(target("a", "xhigh")) });
    await completeTextRouted(configured, messages, "default", { accountScope: null, preferred: { integrationId: "b", model: "model-b" } });
    expect(sent(0)).toMatchObject({ model: "model-b", reasoning_effort: "high" });
  });

  it("does not give the tasks that inherit the Default route the thinking of that route: it only chooses the endpoint, and the level is the integration's, as in the engine", async () => {
    mocks.create.mockResolvedValue(ok);
    const configured = settingsOf([integration("a", { thinking: "low" })], { default: route(target("a", "xhigh")) });
    await completeTextRouted(configured, messages, "editor-actions", { accountScope: null });
    expect(sent(0)).toMatchObject({ model: "model-a", reasoning_effort: "low" });
    await completeTextRouted(configured, messages, "default", { accountScope: null });
    expect(sent(1)).toMatchObject({ model: "model-a", reasoning_effort: "low" });
    const bare = settingsOf([integration("a")], { default: route(target("a", "xhigh")) });
    await completeTextRouted(bare, messages, "editor-actions", { accountScope: null });
    expect(Object.keys(sent(2))).not.toContain("reasoning_effort");
  });

  it("still gives a task with a route of its own the level of that route, whatever the Default route says", async () => {
    mocks.create.mockResolvedValue(ok);
    const configured = settingsOf([integration("a", { thinking: "low" })], { default: route(target("a", "xhigh")), "editor-actions": route(target("a", "medium")) });
    await completeTextRouted(configured, messages, "editor-actions", { accountScope: null });
    expect(sent(0)).toMatchObject({ reasoning_effort: "medium" });
  });

  it("reaches the forced tool call and the confirmation of the routed paths", async () => {
    const routing = { review: route(target("a", "medium")), "simple-tasks": route(target("a", "low")) };
    const configured = settingsOf([integration("a")], routing);
    mocks.create.mockResolvedValueOnce(toolOk);
    await completeToolRouted(configured, messages, "review", tool, { accountScope: null });
    expect(sent(0)).toMatchObject({ reasoning_effort: "medium" });
    mocks.create.mockResolvedValueOnce(yes);
    await expect(classifyConfirmationRouted(configured, "go on?", undefined, null)).resolves.toBe("yes");
    expect(sent(1)).toMatchObject({ reasoning_effort: "low" });
  });
});

describe("saving, syncing and importing the settings keeps the thinking", () => {
  const chat = integration("a", { thinking: "medium" });
  const withRouting = (taskRouting: unknown, integrations: unknown[] = [chat]) => ({ ...DEFAULT_SETTINGS, books: [], aiIntegrations: integrations, taskRouting } as unknown);

  it("keeps the thinking of every target, primary and fallbacks, and the one of the integration, when the settings are loaded", () => {
    const routing = { director: route(target("a", "high"), { ...target("a"), thinking: "automatic" }, target("a")) };
    const loaded = migrateSettings(withRouting(routing));
    expect(loaded.taskRouting?.director).toEqual({ primary: target("a", "high"), fallbacks: [target("a", "automatic"), target("a")] });
    expect(loaded.aiIntegrations[0].thinking).toBe("medium");
  });

  it("survives a trip through JSON, which is how the settings are written to the cloud and exported", () => {
    const routing = { director: route(target("a", "xhigh"), target("a", "low")) };
    const settings = migrateSettings(withRouting(routing));
    const again = migrateSettings(JSON.parse(JSON.stringify(settings)));
    expect(again.taskRouting).toEqual(settings.taskRouting);
    expect(again.taskRouting?.director?.fallbacks[0].thinking).toBe("low");
    expect(again.aiIntegrations[0].thinking).toBe("medium");
  });

  it("drops a value that is not a level, in a target and in an integration, instead of sending it to a provider", () => {
    const routing = { director: route({ ...target("a"), thinking: "extreme" } as never, { ...target("a"), thinking: 4 } as never) };
    const loaded = migrateSettings(withRouting(routing, [{ ...chat, thinking: "ultra" }]));
    expect(loaded.taskRouting?.director).toEqual({ primary: target("a"), fallbacks: [target("a")] });
    expect(loaded.aiIntegrations[0].thinking).toBeUndefined();
  });

  it("does not keep a thinking on a media target or on the browser: they have none", () => {
    const media = integration("m", { modelTextToSpeech: "tts-1" });
    const routing = { tts: route({ integrationId: "m", model: "tts-1", thinking: "high" } as never, { integrationId: "__browser__", model: "x", thinking: "low" } as never) };
    const loaded = migrateSettings(withRouting(routing, [media]));
    expect(loaded.taskRouting?.tts).toEqual({ primary: { integrationId: "m", model: "tts-1" }, fallbacks: [{ integrationId: "__browser__", model: "browser" }] });
  });

  it("keeps it in the copy the offline cache holds", () => {
    const routing = { director: route(target("a", "high")) };
    const projected = projectSafeSettings(migrateSettings(withRouting(routing)));
    expect(projected.taskRouting?.director?.primary?.thinking).toBe("high");
    expect(projected.aiIntegrations[0].thinking).toBe("medium");
  });

  it("keeps it when integrations are edited: a renamed model, a removed fallback", () => {
    const before = { ...chat, chatModels: [{ id: "m-a", name: "model-a", capabilities: ["default" as const, "director" as const] }] };
    const renamed = { ...before, chatModels: [{ id: "m-a", name: "model-a2", capabilities: ["default" as const, "director" as const] }] };
    const routing = { director: route(target("a", "high"), target("a", "low")) };
    const reconciled = reconcileTaskRouting(routing, [before], [renamed]);
    expect(reconciled?.director?.primary).toEqual({ integrationId: "a", model: "model-a2", thinking: "high" });
    expect(reconciled?.director?.fallbacks[0].thinking).toBe("low");
    const sanitized = sanitizeTaskRouting({ director: route(target("a", "high"), { integrationId: "gone", model: "x", thinking: "low" }) }, [before]);
    expect(sanitized?.director).toEqual({ primary: target("a", "high"), fallbacks: [] });
  });
});
