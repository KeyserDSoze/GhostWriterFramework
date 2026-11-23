import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pickAiRuntimeConfig, resolveAiCandidates } from "narrarium-engine";
import { runCopilotAttempt, startRoutingClock } from "@/assistant/copilotAi";
import { CrossBoundaryFallbackCancelledError, setFallbackAcknowledgementAccountScope } from "@/assistant/fallbackDisclosure";
import {
  classifyConfirmationRouted,
  completeTextRouted,
  completeToolRouted,
  NoCompletionCandidatesError,
  resolveTaskCandidates,
  RoutingExecutionBudgetError,
  StaleRoutingConfigurationError,
} from "@/assistant/router";
import { DEFAULT_SETTINGS, type AppSettings, type ChatCapability, type RoutingTarget, type TaskRoute } from "@/types/settings";
import { assertProvidersClean, failReply } from "./helpers/fakeProvider";
import { chatModel, compatible, settingsOf, type Fixture } from "./helpers/aiFixtures";
import { failure, hostsOf, MESSAGES, provide, resetStores, routeOf, speak, speakCall } from "./helpers/copilotHarness";

beforeEach(resetStores);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  assertProvidersClean();
});

const SCHEMA_RESULT = { name: "result", description: "A result", parameters: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } };
const route = (primary: RoutingTarget | undefined, ...fallbacks: RoutingTarget[]): TaskRoute => ({ primary, fallbacks });
const pick = (fixture: Fixture, model = fixture.integration.chatModels![0].name, thinking?: RoutingTarget["thinking"]): RoutingTarget => ({ integrationId: fixture.integration.id, model, ...(thinking ? { thinking } : {}) });

/** What the Copilot would try for a task, and what the engine would try for the same settings: where the models are, in order, with the level of thinking each is given. */
const hostRoute = (settings: AppSettings, task: ChatCapability) => resolveTaskCandidates(settings, task).map((candidate) => [`${candidate.integration?.id}::${candidate.model}`, candidate.thinking ?? null]);
const engineRoute = (settings: AppSettings, task: ChatCapability) => resolveAiCandidates(pickAiRuntimeConfig(settings), task).map((candidate) => [`${candidate.integration.id}::${candidate.model}`, candidate.thinking ?? null]);

describe("the Copilot's route and the engine's route: where they are one, and where they are not", () => {
  const a = compatible("a", [chatModel("model-a", { capabilities: ["default", "review", "copilot"] })], { thinking: "medium" });
  const b = compatible("b", [chatModel("model-b", { capabilities: ["default", "review", "copilot"] })], { thinking: "low" });
  const c = compatible("c", [chatModel("model-c", { capabilities: ["review"] }), chatModel("model-c2", { capabilities: ["default"] })]);
  const all = [a, b, c];

  describe("the same models in the same order, with the same thinking", () => {
    it("for an explicit route: its primary, then its fallbacks, nothing else", () => {
      const settings = settingsOf(all, { taskRouting: { copilot: route(pick(a, undefined, "high"), pick(b), pick(c, "model-c2", "automatic")) } });
      expect(hostRoute(settings, "copilot")).toEqual([["a::model-a", "high"], ["b::model-b", "low"], ["c::model-c2", "automatic"]]);
      expect(hostRoute(settings, "copilot")).toEqual(engineRoute(settings, "copilot"));
    });

    it("for an explicit route with a model that is gone, or that does not serve the task: the others, and never a legacy model in their place", () => {
      const settings = settingsOf(all, { taskRouting: { copilot: route(pick(a, "removed"), pick(c, "model-c"), pick(b)) } });
      expect(hostRoute(settings, "copilot")).toEqual([["b::model-b", "low"]]);
      expect(hostRoute(settings, "copilot")).toEqual(engineRoute(settings, "copilot"));
    });

    it("for a route that names a model twice, and for one that names an integration that is not there", () => {
      const settings = settingsOf(all, { taskRouting: { copilot: route(pick(a), pick(a), { integrationId: "gone", model: "x" }, pick(b)) } });
      expect(hostRoute(settings, "copilot").map(([id]) => id)).toEqual(["a::model-a", "b::model-b"]);
      expect(hostRoute(settings, "copilot")).toEqual(engineRoute(settings, "copilot"));
    });

    it("for the route of a task that has none: the models of the capability, then the default writing integration, then any default model", () => {
      const settings = settingsOf(all, { defaultWritingIntegrationId: "b" });
      for (const task of ["copilot", "default", "simple-tasks", "review", "director"] as const) expect(hostRoute(settings, task), task).toEqual(engineRoute(settings, task));
      expect(hostRoute(settings, "director").map(([id]) => id), "nobody tags «director»: the writing integration comes first, then any default model").toEqual(["b::model-b", "a::model-a", "c::model-c2"]);
      expect(hostRoute(settings, "copilot").map(([id]) => id), "the models tagged with the capability come before the writing integration").toEqual(["a::model-a", "b::model-b", "c::model-c2"]);
    });

    it("for the integration that the Default route names as its primary, which is the writing integration of every task that has no route", () => {
      const settings = settingsOf(all, { taskRouting: { default: route(pick(c, "model-c2")) } });
      expect(hostRoute(settings, "director").map(([id]) => id)).toEqual(["c::model-c2", "a::model-a", "b::model-b"]);
      expect(hostRoute(settings, "director").map(([id]) => id)).toEqual(engineRoute(settings, "director").map(([id]) => id));
    });

    it("for the integrations of Microsoft 365 Copilot, which neither of them can call", () => {
      const m365 = { ...compatible("m", [chatModel("model-m")]), integration: { ...compatible("m", [chatModel("model-m")]).integration, provider: "m365_copilot" as const } };
      const settings = settingsOf([m365, a], { taskRouting: { copilot: route(pick(m365), pick(a)) } });
      expect(hostRoute(settings, "copilot").map(([id]) => id)).toEqual(["a::model-a"]);
      expect(hostRoute(settings, "copilot")).toEqual(engineRoute(settings, "copilot"));
    });

    it("for a limit of candidates from 1 to 8", () => {
      for (const maxCandidates of [1, 2, 3, 8]) {
        const many = Array.from({ length: 9 }, (_, index) => compatible(`many${index}`, [chatModel(`model-${index}`)]));
        const settings = settingsOf(many, { routingExecution: { ...DEFAULT_SETTINGS.routingExecution, maxCandidates }, taskRouting: { copilot: route(pick(many[0]), ...many.slice(1).map((fixture) => pick(fixture))) } });
        expect(hostRoute(settings, "copilot"), `${maxCandidates} candidates`).toEqual(engineRoute(settings, "copilot"));
        expect(hostRoute(settings, "copilot")).toHaveLength(maxCandidates);
      }
    });
  });

  describe("the places where the Copilot's route is its own, and stays so", () => {
    it("a task that is not the Default route, and has no route, goes where the Default route goes: the engine's capability list has no such rule for «editor-actions»", () => {
      const settings = settingsOf(all, { taskRouting: { default: route(pick(c, "model-c2"), pick(b)) } });
      expect(hostRoute(settings, "editor-actions").map(([id]) => id)).toEqual(["c::model-c2", "b::model-b"]);
      expect(engineRoute(settings, "editor-actions").map(([id]) => id)).not.toEqual(["c::model-c2", "b::model-b"]);
    });

    it("the thinking of the Default route is not given to the tasks that go where it goes, nor to the Default route itself: the thinking of the integration is", () => {
      const settings = settingsOf(all, { taskRouting: { default: route(pick(a, undefined, "xhigh")) } });
      expect(hostRoute(settings, "default")[0]).toEqual(["a::model-a", "medium"]);
      expect(engineRoute(settings, "default")[0]).toEqual(["a::model-a", "xhigh"]);
      expect(hostRoute(settings, "editor-actions")[0]).toEqual(["a::model-a", "medium"]);
    });

    it("a limit of candidates that the engine would bring back to 1 or 8: the Copilot keeps the author's number, as it always did", () => {
      const many = Array.from({ length: 9 }, (_, index) => compatible(`many${index}`, [chatModel(`model-${index}`)]));
      const routing = { copilot: route(pick(many[0]), ...many.slice(1).map((fixture) => pick(fixture))) };
      const none = settingsOf(many, { routingExecution: { ...DEFAULT_SETTINGS.routingExecution, maxCandidates: 0 }, taskRouting: routing });
      expect(hostRoute(none, "copilot")).toHaveLength(0);
      expect(engineRoute(none, "copilot")).toHaveLength(1);
      const lots = settingsOf(many, { routingExecution: { ...DEFAULT_SETTINGS.routingExecution, maxCandidates: 20 }, taskRouting: routing });
      expect(hostRoute(lots, "copilot")).toHaveLength(9);
      expect(engineRoute(lots, "copilot")).toHaveLength(8);
    });

    it("the review of a task with no route starts with the default review integration, or with the first integration when none is chosen: the engine's list has no such first step", () => {
      const plain = compatible("pa", [chatModel("model-pa")]);
      const tagged = compatible("rv", [chatModel("model-rv", { capabilities: ["review"] })]);
      const settings = settingsOf([plain, tagged]);
      expect(hostRoute(settings, "review").map(([id]) => id)).toEqual(["pa::model-pa", "rv::model-rv"]);
      expect(engineRoute(settings, "review").map(([id]) => id)).toEqual(["rv::model-rv", "pa::model-pa"]);
      const chosen = settingsOf([plain, tagged], { defaultReviewIntegrationId: "rv" });
      expect(hostRoute(chosen, "review")).toEqual(engineRoute(chosen, "review"));
    });
  });
});

describe("the order in which the candidates are asked, and what stops the asking", () => {
  it("asks the primary first and the fallbacks in order, and stops at the first that answers", async () => {
    const [x, y, z] = [compatible("x"), compatible("y"), compatible("z")];
    const fake = provide([x, y, z], (call) => (call.url.includes("z.example.test") ? speak("From z.")(call) : failReply(400, "refused")));

    await expect(completeTextRouted(routeOf("copilot", [x, y, z]), MESSAGES, "copilot", { accountScope: null })).resolves.toBe("From z.");
    expect(hostsOf(fake)).toEqual(["x", "y", "z"]);

    const answered = provide([x, y, z], speak("From x."));
    await completeTextRouted(routeOf("copilot", [x, y, z]), MESSAGES, "copilot", { accountScope: null });
    expect(hostsOf(answered)).toEqual(["x"]);
  });

  it("asks a model that the author picked by hand first, then the route as it is configured", async () => {
    const x = compatible("x");
    const y = compatible("y");
    const fake = provide([x, y], (call) => (call.url.includes("x.example.test") ? failReply(400, "refused") : speak("From y.")(call)));
    const settings = settingsOf([x, y], { taskRouting: { default: route(pick(y)) } });

    await expect(completeTextRouted(settings, MESSAGES, "default", { accountScope: null, preferred: pick(x) })).resolves.toBe("From y.");

    expect(hostsOf(fake)).toEqual(["x", "y"]);
  });

  it("does not ask a model that the author picked by hand twice when the route has it too", async () => {
    const x = compatible("x");
    const y = compatible("y");
    const fake = provide([x, y], () => failReply(400, "refused"));
    const settings = settingsOf([x, y], { taskRouting: { default: route(pick(x), pick(y)) } });

    await failure(completeTextRouted(settings, MESSAGES, "default", { accountScope: null, preferred: pick(x) }));

    expect(hostsOf(fake)).toEqual(["x", "y"]);
  });

  it("asks no more candidates than the limit of the author says: four unless it is changed", async () => {
    const many = Array.from({ length: 6 }, (_, index) => compatible(`many${index}`, [chatModel(`model-${index}`)]));
    const fake = provide(many, () => failReply(400, "refused"));
    await failure(completeTextRouted(routeOf("copilot", many), MESSAGES, "copilot", { accountScope: null }));
    expect(hostsOf(fake)).toEqual(["many0", "many1", "many2", "many3"]);

    const three = provide(many, () => failReply(400, "refused"));
    await failure(completeTextRouted(routeOf("copilot", many, { routingExecution: { ...DEFAULT_SETTINGS.routingExecution, maxCandidates: 3 } }), MESSAGES, "copilot", { accountScope: null }));
    expect(hostsOf(three)).toEqual(["many0", "many1", "many2"]);
  });

  it("leaves out of a forced call the models that cannot call a function, and counts them in the limit of candidates", async () => {
    const plain = Array.from({ length: 6 }, (_, index) => compatible(`ai${index}`, [chatModel(`model-${index}`, { supportsToolCalls: index !== 0 })]));
    const fake = provide(plain, () => failReply(400, "refused"));
    const settings = routeOf("copilot", plain, { routingExecution: { ...DEFAULT_SETTINGS.routingExecution, maxCandidates: 3 } });

    await failure(completeToolRouted(settings, MESSAGES, "copilot", SCHEMA_RESULT, { accountScope: null }));

    expect(hostsOf(fake)).toEqual(["ai1", "ai2"]);
  });

  it("stops asking the author's fallbacks that the budget of attempts cannot hold, and refuses a first candidate that is already over it", async () => {
    const x = compatible("x", [chatModel("model-x", { maxInputTokens: 10_000, maxOutputTokens: 1_000 })]);
    const y = compatible("y", [chatModel("model-y", { maxInputTokens: 10_000, maxOutputTokens: 1_000 })]);
    const fake = provide([x, y], () => failReply(400, "refused"));
    const limits = (maxTokenAttempts: number) => ({ routingExecution: { ...DEFAULT_SETTINGS.routingExecution, maxTokenAttempts } });

    await failure(completeTextRouted(routeOf("copilot", [x, y], limits(15_000)), MESSAGES, "copilot", { accountScope: null }));
    expect(hostsOf(fake), "9 500 tokens are the budget of one attempt: two do not fit in 15 000").toEqual(["x"]);

    const over = await failure(completeTextRouted(routeOf("copilot", [x, y], limits(5_000)), MESSAGES, "copilot", { accountScope: null }));
    expect(over).toBeInstanceOf(RoutingExecutionBudgetError);
    expect(hostsOf(fake)).toEqual(["x"]);
  });

  it("stops asking the fallbacks that the estimated cost of the attempts cannot hold", async () => {
    const x = compatible("x", [chatModel("model-x", { maxInputTokens: 10_000, maxOutputTokens: 1_000, pricing: { inputPerMTok: 10, outputPerMTok: 100 } })]);
    const y = compatible("y", [chatModel("model-y", { maxInputTokens: 10_000, maxOutputTokens: 1_000, pricing: { inputPerMTok: 10, outputPerMTok: 100 } })]);
    const fake = provide([x, y], () => failReply(400, "refused"));
    // One attempt is estimated at 0.185: 8 500 tokens of input at 10 a million and 1 000 of output at 100.
    const settings = routeOf("copilot", [x, y], { routingExecution: { ...DEFAULT_SETTINGS.routingExecution, maxEstimatedCost: 0.2 } });

    await failure(completeTextRouted(settings, MESSAGES, "copilot", { accountScope: null }));

    expect(hostsOf(fake)).toEqual(["x"]);
  });
});

describe("a route that leads nowhere", () => {
  it("says that the route no longer references a model, when the author configured one and none of its models is there", async () => {
    const x = compatible("x");
    const fake = provide([x], speak("never"));
    const stale = settingsOf([x], { taskRouting: { copilot: route(pick(x, "removed")) } });

    expect(await failure(completeTextRouted(stale, MESSAGES, "copilot", { accountScope: null }))).toBeInstanceOf(StaleRoutingConfigurationError);
    expect(await failure(completeToolRouted(stale, MESSAGES, "copilot", SCHEMA_RESULT, { accountScope: null }))).toBeInstanceOf(StaleRoutingConfigurationError);
    expect(fake.calls).toHaveLength(0);
  });

  it("says that there is no integration, when the author configured nothing", async () => {
    const fake = provide([], speak("never"));
    const empty = settingsOf([]);

    const text = await failure(completeTextRouted(empty, MESSAGES, "copilot", { accountScope: null }));
    expect(text).toBeInstanceOf(NoCompletionCandidatesError);
    expect(text.message).toBe("No AI integration configured for this task.");
    expect(await failure(completeToolRouted(empty, MESSAGES, "copilot", SCHEMA_RESULT, { accountScope: null }))).toBeInstanceOf(NoCompletionCandidatesError);
    await expect(classifyConfirmationRouted(empty, "yes", undefined, null)).resolves.toBe("unclear");
    expect(fake.calls).toHaveLength(0);
  });

  it("sends nothing to Microsoft 365 Copilot, which the browser cannot call: the same errors as before, for every path", async () => {
    const m365 = compatible("m", [chatModel("model-m", { capabilities: ["default", "simple-tasks"] })]);
    m365.integration.provider = "m365_copilot";
    const fake = provide([m365], speak("never"));
    const settings = settingsOf([m365], { taskRouting: { copilot: route(pick(m365)), "simple-tasks": route(pick(m365)) } });

    expect(await failure(completeTextRouted(settings, MESSAGES, "copilot", { accountScope: null }))).toBeInstanceOf(StaleRoutingConfigurationError);
    expect(await failure(completeToolRouted(settings, MESSAGES, "copilot", SCHEMA_RESULT, { accountScope: null }))).toBeInstanceOf(StaleRoutingConfigurationError);
    await expect(classifyConfirmationRouted(settings, "yes", undefined, null)).resolves.toBe("unclear");
    const alone = settingsOf([m365]);
    expect(await failure(completeTextRouted(alone, MESSAGES, "copilot", { accountScope: null }))).toBeInstanceOf(NoCompletionCandidatesError);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("a candidate that is Microsoft 365 Copilot, if one ever reached the attempt", () => {
  it("is refused with the words it always was, and nothing is sent: the browser cannot call it", async () => {
    const m365 = compatible("m", [chatModel("model-m")]);
    m365.integration.provider = "m365_copilot";
    const fake = provide([m365], speak("never"));
    const candidate = { integration: m365.integration, model: "model-m" };
    const settings = settingsOf([m365]);
    const attempt = { settings, accountScope: null, signal: new AbortController().signal, capability: "copilot" as const, candidate, route: { index: 0 }, label: "copilot:chat", messages: MESSAGES, maxOutputTokens: 100, clock: startRoutingClock(settings) };

    await expect(runCopilotAttempt(attempt)).rejects.toThrow("Microsoft 365 Copilot is not yet wired into the in-browser assistant.");
    await expect(runCopilotAttempt({ ...attempt, json: SCHEMA_RESULT })).rejects.toThrow("Microsoft 365 Copilot does not support browser tool calls.");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("a fallback that sends the content to another account", () => {
  const two = () => [compatible("x"), compatible("y")];
  const policy = (patch: Partial<NonNullable<AppSettings["fallbackDisclosure"]>>) => ({ fallbackDisclosure: { sameBoundaryOnly: false, requireAcknowledgement: false, ...patch } });

  it("is not asked at all when the author said that content must never leave the primary's account", async () => {
    const [x, y] = two();
    const fake = provide([x, y], () => failReply(400, "refused"));

    const error = await failure(completeTextRouted(routeOf("copilot", [x, y], policy({ sameBoundaryOnly: true })), MESSAGES, "copilot", { accountScope: null }));

    expect(error).toBeInstanceOf(Error);
    expect(hostsOf(fake)).toEqual(["x"]);
  });

  it("is tried without asking anything when the author set no policy", async () => {
    const [x, y] = two();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const fake = provide([x, y], (call) => (call.url.includes("x.example.test") ? failReply(400, "refused") : speak("From y.")(call)));

    await expect(completeTextRouted(routeOf("copilot", [x, y], policy({})), MESSAGES, "copilot", { accountScope: null })).resolves.toBe("From y.");

    expect(hostsOf(fake)).toEqual(["x", "y"]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("asks the author before the content goes to the other account, and once for the account and the kind of content", async () => {
    const [x, y] = two();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const fake = provide([x, y], (call) => (call.url.includes("x.example.test") ? failReply(400, "refused") : speak("From y.")(call)));
    const settings = routeOf("copilot", [x, y], policy({ requireAcknowledgement: true }));
    setFallbackAcknowledgementAccountScope("google:first@example.com");

    await completeTextRouted(settings, MESSAGES, "copilot", { accountScope: "google:first@example.com" });
    await completeTextRouted(settings, MESSAGES, "copilot", { accountScope: "google:first@example.com" });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toContain("crosses an account/provider boundary");
    expect(hostsOf(fake)).toEqual(["x", "y", "x", "y"]);
  });

  it("does not send a word to the other account when the author declines, and the call ends as a cancel, for the text, the forced call and the confirmation", async () => {
    const [x, y] = two();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const fake = provide([x, y], () => failReply(400, "refused"));
    const settings = settingsOf([x, y], {
      ...policy({ requireAcknowledgement: true }),
      taskRouting: { copilot: route(pick(x), pick(y)), "simple-tasks": route(pick(x), pick(y)) },
    });

    const text = await failure(completeTextRouted(settings, MESSAGES, "copilot", { accountScope: null }));
    expect(text).toBeInstanceOf(CrossBoundaryFallbackCancelledError);
    const tool = await failure(completeToolRouted(settings, MESSAGES, "copilot", SCHEMA_RESULT, { accountScope: null }));
    expect(tool).toBeInstanceOf(CrossBoundaryFallbackCancelledError);
    const confirmation = await failure(classifyConfirmationRouted(settings, "yes", undefined, null));
    expect(confirmation).toBeInstanceOf(CrossBoundaryFallbackCancelledError);

    expect(hostsOf(fake), "only the primary ever saw the content").toEqual(["x", "x", "x"]);
  });

  it("keeps the answer of the author per account: another account is asked again", async () => {
    const [x, y] = two();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    provide([x, y], (call) => (call.url.includes("x.example.test") ? failReply(400, "refused") : speak("From y.")(call)));
    const settings = routeOf("copilot", [x, y], policy({ requireAcknowledgement: true }));

    setFallbackAcknowledgementAccountScope("google:first@example.com");
    await completeTextRouted(settings, MESSAGES, "copilot", { accountScope: "google:first@example.com" });
    setFallbackAcknowledgementAccountScope("google:second@example.com");
    await completeTextRouted(settings, MESSAGES, "copilot", { accountScope: "google:second@example.com" });

    expect(confirm).toHaveBeenCalledTimes(2);
  });
});

describe("a task that has no route of its own", () => {
  it("goes where the Default route goes, for the editor actions", async () => {
    const x = compatible("x");
    const y = compatible("y");
    const fake = provide([x, y], (call) => (call.url.includes("x.example.test") ? failReply(400, "refused") : speak("From y.")(call)));
    const settings = settingsOf([x, y], { taskRouting: { default: route(pick(x), pick(y)) } });

    await expect(completeTextRouted(settings, MESSAGES, "editor-actions", { accountScope: null })).resolves.toBe("From y.");

    expect(hostsOf(fake)).toEqual(["x", "y"]);
  });

  it("asks the models of the capability first, as the legacy resolution always did", async () => {
    const plain = compatible("plain", [chatModel("model-plain")]);
    const tagged = compatible("tagged", [chatModel("model-tagged", { capabilities: ["default", "reader-evaluation"] })]);
    const fake = provide([plain, tagged], speakCall({ ok: true }));

    await completeToolRouted(settingsOf([plain, tagged]), MESSAGES, "reader-evaluation", SCHEMA_RESULT, { accountScope: null });

    expect(hostsOf(fake)).toEqual(["tagged"]);
  });
});
