import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as engine from "narrarium-engine";
import { completeTextRouted, resolveTaskCandidates, routingTargetIssue, StaleRoutingConfigurationError } from "@/assistant/router";
import { followOrder, modelSupportsCapability, pickModelFor } from "@/assistant/llm";
import { migrateSettings } from "@/drive/cloudSettingsClient";
import { modelChoicesFor } from "@/router/routerTableModel";
import { BRAINSTORMING_CAPABILITY, CAPABILITY_FOLLOWS, CHAT_CAPABILITIES, ROUTING_TASKS, type AppSettings, type ChatCapability, type RoutingTarget, type TaskRoute } from "@/types/settings";
import { assertProvidersClean } from "./helpers/fakeProvider";
import { chatModel, compatible, settingsOf, type Fixture } from "./helpers/aiFixtures";
import { entries, failure, hostsOf, MESSAGES, provide, resetStores, speak } from "./helpers/copilotHarness";

// Brainstorming has a task of its own in the router, `brainstorming`. While it has no route of its own it follows the Copilot's route; without that either it goes
// where the Copilot goes (the models tagged for it, then those tagged for the Copilot, then the Default route's endpoint and any default model), so a setup made
// before the task existed keeps working with nothing to configure. The web app and the engine resolve it the same way.

beforeEach(resetStores);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  assertProvidersClean();
});

const route = (primary: RoutingTarget | undefined, ...fallbacks: RoutingTarget[]): TaskRoute => ({ primary, fallbacks });
const pick = (fixture: Fixture, model = fixture.integration.chatModels![0].name, thinking?: RoutingTarget["thinking"]): RoutingTarget => ({ integrationId: fixture.integration.id, model, ...(thinking ? { thinking } : {}) });
const hostRoute = (settings: AppSettings, task: ChatCapability) => resolveTaskCandidates(settings, task).map((candidate) => [`${candidate.integration?.id}::${candidate.model}`, candidate.thinking ?? null]);
const engineRoute = (settings: AppSettings, task: ChatCapability) => engine.resolveAiCandidates(engine.pickAiRuntimeConfig(settings), task).map((candidate) => [`${candidate.integration.id}::${candidate.model}`, candidate.thinking ?? null]);

const writer = compatible("w", [chatModel("general", { capabilities: ["default"] }), chatModel("chatty", { capabilities: ["copilot"] })], { thinking: "medium" });
const muse = compatible("m", [chatModel("deep", { capabilities: ["brainstorming"] }), chatModel("small", { capabilities: ["simple-tasks"] })]);
const spare = compatible("s", [chatModel("spare", { capabilities: ["default", "copilot"] })]);
const all = [writer, muse, spare];

describe("the task and what it follows", () => {
  it("has a stable name, the engine's, and follows the Copilot as in the engine", () => {
    expect(BRAINSTORMING_CAPABILITY).toBe("brainstorming");
    expect(BRAINSTORMING_CAPABILITY).toBe(engine.BRAINSTORMING_CAPABILITY);
    expect(CAPABILITY_FOLLOWS).toEqual({ ...engine.AI_CAPABILITY_FOLLOWS });
    expect(CHAT_CAPABILITIES).toContain("brainstorming");
    expect(ROUTING_TASKS).toContain("brainstorming");
    expect(CHAT_CAPABILITIES.indexOf("brainstorming")).toBe(CHAT_CAPABILITIES.indexOf("copilot") + 1);
    expect(followOrder("brainstorming")).toEqual(["brainstorming", "copilot"]);
    expect(followOrder("copilot")).toEqual(["copilot"]);
  });

  it("allows it the models allowed the Copilot, not the other way round, and prefers its own tag", () => {
    const [general, chatty] = writer.integration.chatModels!;
    const [deep, small] = muse.integration.chatModels!;
    expect(modelSupportsCapability(chatty, "brainstorming")).toBe(true);
    expect(modelSupportsCapability(general, "brainstorming")).toBe(true);
    expect(modelSupportsCapability(deep, "brainstorming")).toBe(true);
    expect(modelSupportsCapability(deep, "copilot")).toBe(false);
    expect(modelSupportsCapability(small, "brainstorming")).toBe(false);
    expect(pickModelFor([general, chatty, deep], "brainstorming")?.name).toBe("deep");
    expect(pickModelFor([general, chatty], "brainstorming")?.name).toBe("chatty");
    expect(pickModelFor([general, chatty], "simple-tasks")?.name).toBe("general");
    expect(routingTargetIssue(all.map((fixture) => fixture.integration), "brainstorming", pick(writer, "chatty"))).toBeNull();
    expect(routingTargetIssue(all.map((fixture) => fixture.integration), "copilot", pick(muse, "deep"))).not.toBeNull();
    expect(modelChoicesFor(all.map((fixture) => fixture.integration), "w", "brainstorming")).toEqual(["general", "chatty"]);
    expect(modelChoicesFor(all.map((fixture) => fixture.integration), "m", "brainstorming")).toEqual(["deep"]);
    expect(modelChoicesFor(all.map((fixture) => fixture.integration), "m", "copilot")).toEqual([]);
  });
});

describe("where a call of Brainstorming goes: its own route, else the Copilot's, else where the Copilot goes", () => {
  it("uses its own route alone when it has one, whatever the Copilot's", () => {
    const settings = settingsOf(all, { taskRouting: { brainstorming: route(pick(muse, "deep", "xhigh")), copilot: route(pick(writer, "chatty", "low"), pick(spare)) } });
    expect(hostRoute(settings, "brainstorming")).toEqual([["m::deep", "xhigh"]]);
    expect(hostRoute(settings, "copilot")).toEqual([["w::chatty", "low"], ["s::spare", null]]);
    expect(hostRoute(settings, "brainstorming")).toEqual(engineRoute(settings, "brainstorming"));
  });

  it("follows the Copilot's route, its order and its levels of thinking, when it has none of its own", () => {
    const settings = settingsOf(all, { taskRouting: { copilot: route(pick(writer, "chatty", "low"), pick(spare)), default: route(pick(spare)) } });
    expect(hostRoute(settings, "brainstorming")).toEqual([["w::chatty", "low"], ["s::spare", null]]);
    expect(hostRoute(settings, "brainstorming")).toEqual(hostRoute(settings, "copilot"));
    expect(hostRoute(settings, "brainstorming")).toEqual(engineRoute(settings, "brainstorming"));
    // An empty route is no route: it still follows the Copilot's.
    const empty = settingsOf(all, { taskRouting: { brainstorming: route(undefined), copilot: route(pick(writer, "chatty")) } });
    expect(hostRoute(empty, "brainstorming")).toEqual([["w::chatty", "medium"]]);
    expect(hostRoute(empty, "brainstorming")).toEqual(engineRoute(empty, "brainstorming"));
  });

  it("without either route goes where the Copilot goes: its own tags first, then the Copilot's, then the Default route's endpoint", () => {
    const tagged = settingsOf(all, { taskRouting: { default: route(pick(writer, "general")) } });
    expect(hostRoute(tagged, "brainstorming").map(([id]) => id)).toEqual(["m::deep", "w::chatty", "s::spare"]);
    expect(hostRoute(tagged, "brainstorming")).toEqual(engineRoute(tagged, "brainstorming"));
    const untagged = settingsOf([compatible("w", [chatModel("general", { capabilities: ["default"] })])], { taskRouting: { default: route(pick(writer, "general")) } });
    expect(hostRoute(untagged, "brainstorming")).toEqual(hostRoute(untagged, "copilot"));
    expect(hostRoute(untagged, "brainstorming").map(([id]) => id)).toEqual(["w::general"]);
    expect(hostRoute(untagged, "brainstorming")).toEqual(engineRoute(untagged, "brainstorming"));
  });

  it("sends the request to the Copilot's route, for its own task, and the debug panel says which task it was", async () => {
    const fake = provide(all, speak("A bigger idea."));
    const settings = settingsOf(all, { taskRouting: { copilot: route(pick(spare)) } });
    await expect(completeTextRouted(settings, MESSAGES, BRAINSTORMING_CAPABILITY, { accountScope: null, label: BRAINSTORMING_CAPABILITY })).resolves.toBe("A bigger idea.");
    expect(hostsOf(fake)).toEqual(["s"]);
    expect(entries()[0]).toMatchObject({ label: "brainstorming", task: "brainstorming", model: "spare", status: "done" });
  });

  it("says that the Copilot's route is stale, when the route it follows names a model that is gone", async () => {
    const settings = settingsOf(all, { taskRouting: { copilot: route(pick(writer, "removed")) } });
    const error = await failure(completeTextRouted(settings, MESSAGES, BRAINSTORMING_CAPABILITY, { accountScope: null }));
    expect(error).toBeInstanceOf(StaleRoutingConfigurationError);
    expect(error.message).toContain("copilot route");
  });
});

describe("the settings: a route and a tag of the task are kept, and a file from before still loads", () => {
  it("keeps the route of Brainstorming, its thinking and the tag of a model, through saving and loading", () => {
    const settings = settingsOf(all, { books: [], taskRouting: { brainstorming: route(pick(muse, "deep", "high"), pick(writer, "chatty")), copilot: route(pick(spare)) } });
    const loaded = migrateSettings(JSON.parse(JSON.stringify(settings)));
    expect(loaded.taskRouting?.brainstorming).toEqual(route(pick(muse, "deep", "high"), pick(writer, "chatty")));
    expect(loaded.taskRouting?.copilot).toEqual(route(pick(spare)));
    expect(loaded.aiIntegrations?.find((entry) => entry.id === "m")?.chatModels?.[0].capabilities).toEqual(["brainstorming"]);
    expect(hostRoute(loaded, "brainstorming")).toEqual([["m::deep", "high"], ["w::chatty", "medium"]]);
  });

  it("loads a file written before the task existed, with nothing to configure: Brainstorming follows the Copilot", () => {
    const before = {
      version: 2,
      books: [],
      defaultGitHubToken: "",
      ui: { language: "it" },
      aiIntegrations: [
        { id: "old", name: "Old", provider: "openai", endpoint: "https://old.example.test/v1", apiKey: "sk-old-0123456789abcdef", chatModels: [{ id: "c", name: "chat-model", capabilities: ["default", "copilot", "simple-tasks", "review"] }] },
        { id: "legacy", name: "Legacy", provider: "openai", endpoint: "https://legacy.example.test/v1", apiKey: "sk-legacy-0123456789abcdef", modelWriting: "gpt-legacy" },
      ],
      taskRouting: { copilot: { primary: { integrationId: "old", model: "chat-model", thinking: "low" }, fallbacks: [{ integrationId: "legacy", model: "gpt-legacy" }] } },
    };
    const loaded = migrateSettings(before);
    expect(loaded.taskRouting?.brainstorming).toBeUndefined();
    expect(hostRoute(loaded, "brainstorming")).toEqual([["old::chat-model", "low"], ["legacy::gpt-legacy", null]]);
    expect(hostRoute(loaded, "brainstorming")).toEqual(engineRoute(loaded, "brainstorming"));
    const { taskRouting: _routing, ...unrouted } = before;
    const plain = migrateSettings(unrouted);
    expect(hostRoute(plain, "brainstorming")).toEqual(hostRoute(plain, "copilot"));
    expect(hostRoute(plain, "brainstorming").length).toBeGreaterThan(0);
  });
});
