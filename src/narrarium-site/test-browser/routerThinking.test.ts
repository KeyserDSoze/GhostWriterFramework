import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyConfirmationRouted, completeTextRouted, completeToolRouted, reconcileTaskRouting, sanitizeTaskRouting } from "@/assistant/router";
import { migrateSettings } from "@/drive/cloudSettingsClient";
import { projectSafeSettings } from "@/drive/settingsCache";
import { THINKING_LEVELS, effectiveThinking, isThinkingLevel, normalizeThinking } from "@/router/thinking";
import { DEFAULT_SETTINGS, type AIIntegration, type AppSettings, type ReasoningParameter, type RoutingTarget, type TaskRoute, type ThinkingLevel } from "@/types/settings";
import { assertProvidersClean, failReply } from "./helpers/fakeProvider";
import { chatModel, compatible, settingsOf as fixtureSettings, type Fixture } from "./helpers/aiFixtures";
import { provide, resetStores, speak, speakCall } from "./helpers/copilotHarness";

const tool = { name: "score", description: "Score", parameters: { type: "object", properties: { score: { type: "number" } }, required: ["score"] } };
const CAPABILITIES = ["default", "review", "director", "simple-tasks"] as const;

/** An integration for the saving and loading of the settings, which no request is made through. */
function integration(id: string, extra: Partial<AIIntegration> = {}): AIIntegration {
  return { id, name: id, provider: "openai", apiKey: "key", endpoint: `https://${id}.test/v1`, chatModels: [{ id: `m-${id}`, name: `model-${id}`, capabilities: [...CAPABILITIES] }], ...extra };
}
const target = (id: string, thinking?: RoutingTarget["thinking"]): RoutingTarget => ({ integrationId: id, model: `model-${id}`, ...(thinking ? { thinking } : {}) });
const route = (primary: RoutingTarget, ...fallbacks: RoutingTarget[]): TaskRoute => ({ primary, fallbacks });
const settingsOf = (integrations: AIIntegration[], taskRouting?: AppSettings["taskRouting"]): AppSettings => ({ ...DEFAULT_SETTINGS, aiIntegrations: integrations, taskRouting });

/** An integration that the Copilot calls: its host and its key are its own, so that the requests can be told apart. */
function served(id: string, extra: Partial<AIIntegration> = {}, model: Parameters<typeof chatModel>[1] = {}): Fixture {
  return compatible(id, [chatModel(`model-${id}`, { capabilities: [...CAPABILITIES], ...model })], extra);
}
function azure(id: string, apiVersion = "2024-10-21"): Fixture {
  const fixture = compatible(id, [chatModel(`model-${id}`, { capabilities: [...CAPABILITIES] })], { provider: "azure_openai", endpoint: "https://x.example.test", apiVersion });
  return { ...fixture, endpoint: { ...fixture.endpoint, base: "https://x.example.test/openai", auth: "api-key" } };
}
const routed = (fixtures: Fixture[], taskRouting?: AppSettings["taskRouting"]): AppSettings => fixtureSettings(fixtures, { taskRouting });
const bodyAt = (fake: ReturnType<typeof provide>, index: number) => fake.calls[index].body as Record<string, unknown>;
const messages = [{ role: "user" as const, content: "x" }];

beforeEach(resetStores);
afterEach(() => {
  vi.unstubAllGlobals();
  assertProvidersClean();
});

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
  it.each(["low", "medium", "high", "xhigh"] as const)("completeText sends %s, to an integration that is called as the others and to Azure OpenAI", async (level) => {
    const local = served("local");
    const fake = provide([local], speak("done"));
    await completeTextRouted(routed([local], { copilot: route(target("local", level)) }), messages, "copilot", { accountScope: null });
    expect(bodyAt(fake, 0)).toMatchObject({ model: "model-local", stream: true, reasoning_effort: level });

    const cloud = azure("cloud");
    const cloudFake = provide([cloud], speak("done"));
    await completeTextRouted(routed([cloud], { copilot: route(target("cloud", level)) }), messages, "copilot", { accountScope: null, onText: () => undefined });
    expect(bodyAt(cloudFake, 0)).toMatchObject({ stream: true, reasoning_effort: level });
  });

  it("completeText leaves the parameter out for automatic, for no level, and for a value it does not know", async () => {
    const local = served("local");
    for (const thinking of ["automatic", undefined, "extreme"] as Array<ThinkingLevel | undefined>) {
      const fake = provide([local], speak("done"));
      await completeTextRouted(routed([local], { copilot: route({ integrationId: "local", model: "model-local", ...(thinking ? { thinking } : {}) }) }), messages, "copilot", { accountScope: null });
      expect(Object.keys(bodyAt(fake, 0))).not.toContain("reasoning_effort");
    }
  });

  it("the forced tool call and the confirmation carry it too", async () => {
    const local = served("local");
    const toolFake = provide([local], speakCall({ score: 8 }, undefined, "score"));
    await completeToolRouted(routed([local], { review: route(target("local", "xhigh")) }), [{ role: "user", content: "score" }], "review", tool, { accountScope: null });
    expect(bodyAt(toolFake, 0)).toMatchObject({ tool_choice: "required", reasoning_effort: "xhigh" });

    const confirmFake = provide([local], speakCall({ decision: "yes" }, undefined, "confirm"));
    await expect(classifyConfirmationRouted(routed([local], { "simple-tasks": route(target("local", "low")) }), "yes", undefined, null)).resolves.toBe("yes");
    expect(bodyAt(confirmFake, 0)).toMatchObject({ reasoning_effort: "low" });

    const automatic = provide([local], speakCall({ score: 8 }, undefined, "score"));
    await completeToolRouted(routed([local], { review: route(target("local", "automatic")) }), [{ role: "user", content: "score" }], "review", tool, { accountScope: null });
    expect(Object.keys(bodyAt(automatic, 0))).not.toContain("reasoning_effort");
    const unset = provide([local], speakCall({ decision: "yes" }, undefined, "confirm"));
    await classifyConfirmationRouted(routed([local], { "simple-tasks": route(target("local")) }), "yes", undefined, null);
    expect(Object.keys(bodyAt(unset, 0))).not.toContain("reasoning_effort");
  });
});

describe("the thinking parameter of the model decides where the level goes, in a request of the site's own", () => {
  const TEMPLATE = "chat_template_kwargs.reasoning_strength";
  /** What a request carries of the level: the OpenAI field, the argument of the chat template, both or none. */
  const carried = (fake: ReturnType<typeof provide>, index: number) => ({ effort: bodyAt(fake, index).reasoning_effort, template: bodyAt(fake, index).chat_template_kwargs });
  const withParameter = (parameter: ReasoningParameter | undefined, level?: ThinkingLevel) => {
    const fixture = served("local", {}, parameter ? { reasoningParameter: parameter } : {});
    return { fixture, settings: routed([fixture], { copilot: route(target("local", level)) }) };
  };

  it.each([undefined, "reasoning_effort"] as const)("completeText sends reasoning_effort when the model says %s", async (parameter) => {
    const { fixture, settings } = withParameter(parameter, "high");
    const fake = provide([fixture], speak("done"));
    await completeTextRouted(settings, messages, "copilot", { accountScope: null });
    expect(carried(fake, 0)).toEqual({ effort: "high", template: undefined });
  });

  it("completeText sends the argument of the chat template, and no reasoning_effort, when the model says so", async () => {
    const { fixture, settings } = withParameter(TEMPLATE, "medium");
    const fake = provide([fixture], speak("done"));
    await completeTextRouted(settings, messages, "copilot", { accountScope: null });
    expect(carried(fake, 0)).toEqual({ effort: undefined, template: { reasoning_strength: "medium" } });
    expect(bodyAt(fake, 0)).toMatchObject({ stream: true });
    expect(Object.keys(bodyAt(fake, 0))).not.toContain("reasoning_effort");
  });

  it("goes on as reasoning_effort for a parameter it does not know: the engine drops it, and so does the site", async () => {
    const fixture = served("local", {}, { reasoningParameter: "chat_template_kwargs.enable_thinking" as ReasoningParameter });
    const fake = provide([fixture], speak("done"));
    await completeTextRouted(routed([fixture], { copilot: route(target("local", "low")) }), messages, "copilot", { accountScope: null });
    expect(carried(fake, 0)).toEqual({ effort: "low", template: undefined });
  });

  it("the forced tool call and the confirmation carry it the same way", async () => {
    const fixture = served("local", {}, { reasoningParameter: TEMPLATE });
    const toolFake = provide([fixture], speakCall({ score: 8 }, undefined, "score"));
    await completeToolRouted(routed([fixture], { review: route(target("local", "xhigh")) }), [{ role: "user", content: "score" }], "review", tool, { accountScope: null });
    expect(bodyAt(toolFake, 0)).toMatchObject({ tool_choice: "required", chat_template_kwargs: { reasoning_strength: "xhigh" } });
    expect(Object.keys(bodyAt(toolFake, 0))).not.toContain("reasoning_effort");

    const confirmFake = provide([fixture], speakCall({ decision: "yes" }, undefined, "confirm"));
    await expect(classifyConfirmationRouted(routed([fixture], { "simple-tasks": route(target("local", "low")) }), "yes", undefined, null)).resolves.toBe("yes");
    expect(carried(confirmFake, 0)).toEqual({ effort: undefined, template: { reasoning_strength: "low" } });
  });

  it("sends no level at all for none, even when a level is asked for: it is no level, and it does not turn thinking off", async () => {
    const { fixture, settings } = withParameter("none", "high");
    const textFake = provide([fixture], speak("done"));
    await completeTextRouted(settings, messages, "copilot", { accountScope: null });
    const toolFake = provide([fixture], speakCall({ score: 8 }, undefined, "score"));
    await completeToolRouted(routed([fixture], { review: route(target("local", "high")) }), [{ role: "user", content: "score" }], "review", tool, { accountScope: null });
    const confirmFake = provide([fixture], speakCall({ decision: "yes" }, undefined, "confirm"));
    await classifyConfirmationRouted(routed([fixture], { "simple-tasks": route(target("local", "high")) }), "yes", undefined, null);
    for (const fake of [textFake, toolFake, confirmFake]) {
      expect(Object.keys(bodyAt(fake, 0))).not.toContain("reasoning_effort");
      expect(Object.keys(bodyAt(fake, 0))).not.toContain("chat_template_kwargs");
    }
  });

  it.each(["automatic", undefined, "extreme"] as Array<ThinkingLevel | undefined>)("sends no level in any form when the level is %s, whatever the parameter is", async (level) => {
    for (const parameter of [undefined, "reasoning_effort", TEMPLATE, "none"] as Array<ReasoningParameter | undefined>) {
      const fixture = served("local", {}, parameter ? { reasoningParameter: parameter } : {});
      const fake = provide([fixture], speak("done"));
      await completeTextRouted(routed([fixture], { copilot: route({ integrationId: "local", model: "model-local", ...(level ? { thinking: level } : {}) }) }), messages, "copilot", { accountScope: null });
      expect(Object.keys(bodyAt(fake, 0))).not.toContain("reasoning_effort");
      expect(Object.keys(bodyAt(fake, 0))).not.toContain("chat_template_kwargs");
    }
  });

  it("takes the word of the model through the router: the candidate carries it from the model, and a fallback has the word of its own model", async () => {
    const a = served("a", { thinking: "medium" }, { capabilities: ["director"], reasoningParameter: TEMPLATE });
    const b = served("b", { thinking: "low" });
    const fake = provide([a, b], (call) => (call.url.includes("a.example.test") ? failReply(400, "rate limited") : speak("done")(call)));
    await expect(completeTextRouted(routed([a, b], { director: route(target("a"), target("b")) }), messages, "director", { accountScope: null })).resolves.toBe("done");
    expect(carried(fake, 0)).toEqual({ effort: undefined, template: { reasoning_strength: "medium" } });
    expect(carried(fake, 1)).toEqual({ effort: "low", template: undefined });
  });

  it("takes it from the model for a task that has no route of its own, which goes to the Default route's integration", async () => {
    const a = served("a", { thinking: "high" }, { reasoningParameter: "none" });
    const fake = provide([a], speak("done"));
    await completeTextRouted(routed([a], { default: route(target("a")) }), messages, "editor-actions", { accountScope: null });
    expect(carried(fake, 0)).toEqual({ effort: undefined, template: undefined });
  });

  it("reaches the forced tool call and the confirmation of the routed paths too", async () => {
    const a = served("a", { thinking: "high" }, { capabilities: ["review", "simple-tasks"], reasoningParameter: TEMPLATE });
    const settings = routed([a], { review: route(target("a")), "simple-tasks": route(target("a")) });
    const toolFake = provide([a], speakCall({ score: 8 }, undefined, "score"));
    await completeToolRouted(settings, [{ role: "user", content: "score" }], "review", tool, { accountScope: null });
    expect(bodyAt(toolFake, 0)).toMatchObject({ chat_template_kwargs: { reasoning_strength: "high" } });
    const confirmFake = provide([a], speakCall({ decision: "yes" }, undefined, "confirm"));
    await classifyConfirmationRouted(settings, "yes", undefined, null);
    expect(bodyAt(confirmFake, 0)).toMatchObject({ chat_template_kwargs: { reasoning_strength: "high" } });
    expect(Object.keys(bodyAt(confirmFake, 0))).not.toContain("reasoning_effort");
  });

  it("does not send a level to a model that is declared as not reasoning: it would refuse it, and the engine leaves it out, as it does for the run", async () => {
    const a = served("a", { thinking: "high" }, { supportsReasoning: false });
    const fake = provide([a], speak("done"));
    await completeTextRouted(routed([a], { copilot: route(target("a")) }), messages, "copilot", { accountScope: null });
    expect(Object.keys(bodyAt(fake, 0))).not.toContain("reasoning_effort");
  });
});

describe("the router hands each candidate its own level", () => {
  it("sends the primary its level and, when it fails, the fallback its own", async () => {
    const a = served("a");
    const b = served("b");
    const fake = provide([a, b], (call) => (call.url.includes("a.example.test") ? failReply(400, "rate limited") : speak("done")(call)));
    await expect(completeTextRouted(routed([a, b], { director: route(target("a", "high"), target("b", "low")) }), messages, "director", { accountScope: null })).resolves.toBe("done");
    expect(bodyAt(fake, 0)).toMatchObject({ model: "model-a", reasoning_effort: "high" });
    expect(bodyAt(fake, 1)).toMatchObject({ model: "model-b", reasoning_effort: "low" });
  });

  it("falls back to the level of the integration when the target has none, and lets the target's \"automatic\" switch it off", async () => {
    const a = served("a", { thinking: "medium" });
    const inherited = provide([a], speak("done"));
    await completeTextRouted(routed([a], { director: route(target("a")) }), messages, "director", { accountScope: null });
    expect(bodyAt(inherited, 0)).toMatchObject({ reasoning_effort: "medium" });
    const off = provide([a], speak("done"));
    await completeTextRouted(routed([a], { director: route(target("a", "automatic")) }), messages, "director", { accountScope: null });
    expect(Object.keys(bodyAt(off, 0))).not.toContain("reasoning_effort");
    const own = provide([a], speak("done"));
    await completeTextRouted(routed([a], { director: route(target("a", "xhigh")) }), messages, "director", { accountScope: null });
    expect(bodyAt(own, 0)).toMatchObject({ reasoning_effort: "xhigh" });
  });

  it("sends nothing when neither the target nor the integration names a level", async () => {
    const a = served("a");
    const fake = provide([a], speak("done"));
    await completeTextRouted(routed([a], { director: route(target("a")) }), messages, "director", { accountScope: null });
    expect(Object.keys(bodyAt(fake, 0))).not.toContain("reasoning_effort");
  });

  it("gives a task without a route of its own the level of the integration it is resolved to", async () => {
    const a = served("a", { thinking: "high" });
    const fake = provide([a], speak("done"));
    await completeTextRouted(routed([a]), messages, "director", { accountScope: null });
    expect(bodyAt(fake, 0)).toMatchObject({ reasoning_effort: "high" });
  });

  it("gives a model picked by hand (an override) the level of its integration", async () => {
    const a = served("a", { thinking: "low" });
    const b = served("b", { thinking: "high" });
    const fake = provide([a, b], speak("done"));
    await completeTextRouted(routed([a, b], { default: route(target("a", "xhigh")) }), messages, "default", { accountScope: null, preferred: { integrationId: "b", model: "model-b" } });
    expect(bodyAt(fake, 0)).toMatchObject({ model: "model-b", reasoning_effort: "high" });
  });

  it("does not give the tasks that inherit the Default route the thinking of that route: it only chooses the endpoint, and the level is the integration's, as in the engine", async () => {
    const a = served("a", { thinking: "low" });
    const configured = routed([a], { default: route(target("a", "xhigh")) });
    const inherits = provide([a], speak("done"));
    await completeTextRouted(configured, messages, "editor-actions", { accountScope: null });
    expect(bodyAt(inherits, 0)).toMatchObject({ model: "model-a", reasoning_effort: "low" });
    const itself = provide([a], speak("done"));
    await completeTextRouted(configured, messages, "default", { accountScope: null });
    expect(bodyAt(itself, 0)).toMatchObject({ model: "model-a", reasoning_effort: "low" });
    const bare = served("a");
    const none = provide([bare], speak("done"));
    await completeTextRouted(routed([bare], { default: route(target("a", "xhigh")) }), messages, "editor-actions", { accountScope: null });
    expect(Object.keys(bodyAt(none, 0))).not.toContain("reasoning_effort");
  });

  it("still gives a task with a route of its own the level of that route, whatever the Default route says", async () => {
    const a = served("a", { thinking: "low" });
    const fake = provide([a], speak("done"));
    await completeTextRouted(routed([a], { default: route(target("a", "xhigh")), "editor-actions": route(target("a", "medium")) }), messages, "editor-actions", { accountScope: null });
    expect(bodyAt(fake, 0)).toMatchObject({ reasoning_effort: "medium" });
  });

  it("reaches the forced tool call and the confirmation of the routed paths", async () => {
    const a = served("a");
    const configured = routed([a], { review: route(target("a", "medium")), "simple-tasks": route(target("a", "low")) });
    const toolFake = provide([a], speakCall({ score: 8 }, undefined, "score"));
    await completeToolRouted(configured, messages, "review", tool, { accountScope: null });
    expect(bodyAt(toolFake, 0)).toMatchObject({ reasoning_effort: "medium" });
    const confirmFake = provide([a], speakCall({ decision: "yes" }, undefined, "confirm"));
    await expect(classifyConfirmationRouted(configured, "go on?", undefined, null)).resolves.toBe("yes");
    expect(bodyAt(confirmFake, 0)).toMatchObject({ reasoning_effort: "low" });
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
