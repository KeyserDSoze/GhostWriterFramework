import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as engine from "narrarium-engine";
import { completeTextRouted, resolveTaskCandidates } from "@/assistant/router";
import { followOrder, modelSupportsCapability, pickModelFor } from "@/assistant/llm";
import { migrateSettings } from "@/drive/cloudSettingsClient";
import { CAPABILITY_FOLLOWS, CHAT_CAPABILITIES, ROUTING_TASKS, WILDCARDS_CAPABILITY, type AppSettings, type ChatCapability, type RoutingTarget, type TaskRoute } from "@/types/settings";
import { assertProvidersClean } from "./helpers/fakeProvider";
import { chatModel, compatible, settingsOf, type Fixture } from "./helpers/aiFixtures";
import { entries, hostsOf, MESSAGES, provide, resetStores, speak } from "./helpers/copilotHarness";

// The wildcards' room has a task of its own in the router, `wildcards`. While it has no route of its own it follows the review's route; without that either it goes
// where the review goes, with its own tags first (the models tagged for it, the review's default integration, the models tagged for the review, then the Default
// route's endpoint), so a setup made before the task existed keeps working with nothing to configure. The web app and the engine resolve it the same way.

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

const writer = compatible("w", [chatModel("general", { capabilities: ["default"] }), chatModel("critic", { capabilities: ["review"] })]);
const legacy = compatible("l", [chatModel("old-review", { capabilities: ["review"] })]);
const muse = compatible("m", [chatModel("wild", { capabilities: ["wildcards"] })]);
const all = [writer, legacy, muse];

describe("the task and what it follows", () => {
  it("has the engine's name, follows the review as in the engine, and sits right after the review", () => {
    expect(WILDCARDS_CAPABILITY).toBe("wildcards");
    expect(WILDCARDS_CAPABILITY).toBe(engine.WILDCARDS_CAPABILITY);
    expect(CAPABILITY_FOLLOWS).toEqual({ ...engine.AI_CAPABILITY_FOLLOWS });
    expect(CAPABILITY_FOLLOWS.wildcards).toBe("review");
    expect(CHAT_CAPABILITIES.indexOf("wildcards")).toBe(CHAT_CAPABILITIES.indexOf("review") + 1);
    expect(ROUTING_TASKS).toContain("wildcards");
    expect(followOrder("wildcards")).toEqual(["wildcards", "review"]);
  });

  it("allows it the models allowed the review, not the other way round, and prefers its own tag", () => {
    const [general, critic] = writer.integration.chatModels!;
    const [wild] = muse.integration.chatModels!;
    expect(modelSupportsCapability(critic, "wildcards")).toBe(true);
    expect(modelSupportsCapability(general, "wildcards")).toBe(true);
    expect(modelSupportsCapability(wild, "review")).toBe(false);
    expect(pickModelFor([general, critic, wild], "wildcards")?.name).toBe("wild");
    expect(pickModelFor([general, critic], "wildcards")?.name).toBe("critic");
  });
});

describe("where a call of the room goes: its own route, else the review's, else where the review goes", () => {
  it("uses its own route alone, and the review's when it has none", () => {
    const own = settingsOf(all, { taskRouting: { wildcards: route(pick(muse, "wild", "high")), review: route(pick(writer, "critic")) } });
    expect(hostRoute(own, "wildcards")).toEqual([["m::wild", "high"]]);
    expect(hostRoute(own, "wildcards")).toEqual(engineRoute(own, "wildcards"));
    const reviewOnly = settingsOf(all, { taskRouting: { review: route(pick(writer, "critic"), pick(legacy)) } });
    expect(hostRoute(reviewOnly, "wildcards")).toEqual(hostRoute(reviewOnly, "review"));
    expect(hostRoute(reviewOnly, "wildcards")).toEqual(engineRoute(reviewOnly, "wildcards"));
  });

  it("without either route: its own tags, then the review's default integration, then the models tagged for the review, as in the engine", () => {
    const unrouted = settingsOf(all, { defaultReviewIntegrationId: "l", taskRouting: { default: route(pick(writer, "general")) } });
    expect(hostRoute(unrouted, "wildcards").map(([id]) => id)).toEqual(["m::wild", "l::old-review", "w::critic"]);
    expect(hostRoute(unrouted, "wildcards")).toEqual(engineRoute(unrouted, "wildcards"));
    // The review itself resolves as it always did.
    expect(hostRoute(unrouted, "review").map(([id]) => id)).toEqual(["l::old-review", "w::critic"]);
    expect(hostRoute(unrouted, "review")).toEqual(engineRoute(unrouted, "review"));
  });

  it("sends the request for its own task, and the debug panel says which task it was", async () => {
    const fake = provide(all, speak("An idea."));
    const settings = settingsOf(all, { taskRouting: { review: route(pick(legacy)) } });
    await expect(completeTextRouted(settings, MESSAGES, WILDCARDS_CAPABILITY, { accountScope: null, label: "wildcards:poet" })).resolves.toBe("An idea.");
    expect(hostsOf(fake)).toEqual(["l"]);
    expect(entries()[0]).toMatchObject({ label: "wildcards:poet", task: "wildcards", model: "old-review", status: "done" });
  });
});

describe("the settings", () => {
  it("keep a route of the room and the tag of a model; a file from before the task loads with nothing to configure", () => {
    const settings = settingsOf(all, { books: [], taskRouting: { wildcards: route(pick(muse, "wild", "high")), review: route(pick(writer, "critic")) } });
    const loaded = migrateSettings(JSON.parse(JSON.stringify(settings)));
    expect(loaded.taskRouting?.wildcards).toEqual(route(pick(muse, "wild", "high")));
    expect(loaded.aiIntegrations?.find((entry) => entry.id === "m")?.chatModels?.[0].capabilities).toEqual(["wildcards"]);
    const before = migrateSettings(JSON.parse(JSON.stringify(settingsOf([writer, legacy], { books: [], taskRouting: { review: route(pick(writer, "critic")) } }))));
    expect(before.taskRouting?.wildcards).toBeUndefined();
    expect(hostRoute(before, "wildcards")).toEqual([["w::critic", null]]);
  });
});
