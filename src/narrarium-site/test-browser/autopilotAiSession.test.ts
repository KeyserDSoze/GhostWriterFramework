import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutopilotSession, createFetchAi, pickAiRuntimeConfig, type AiPort, type AutopilotEvent } from "narrarium-engine";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "narrarium-engine/testing";
import { localWorkspaceScope } from "@/account/deviceIdentity";
import { setFallbackAcknowledgementAccountScope } from "@/assistant/fallbackDisclosure";
import { createBrowserAi } from "@/autopilot/browserAi";
import { presentFeedEvent } from "@/autopilot/format";
import { useCostsStore } from "@/costs/costsStore";
import { useLlmDebugStore } from "@/debug/llmDebugStore";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { useSettingsStore } from "@/store/settingsStore";
import type { AppSettings } from "@/types/settings";
import { assertProvidersClean, createFakeProvider, failReply, streamedReply, textReply, toolReply, type ProviderCall, type ProviderReply } from "./helpers/fakeProvider";
import { chatModel, compatible, endpointsOf, GITHUB_TOKEN, settingsOf, type Fixture } from "./helpers/aiFixtures";
import { resetCosts } from "./helpers/costs";

const USAGE = { prompt_tokens: 100, completion_tokens: 50 };
const fixture = compatible("a", [chatModel("gpt-4o", { maxInputTokens: 128_000, maxOutputTokens: 16_384 })]);
const settings = settingsOf([fixture], { fallbackDisclosure: { sameBoundaryOnly: true, requireAcknowledgement: true } });

/** A provider whose model is the engine's deterministic fake, and which rate limits the very first request for the concept. */
function rateLimitedModel(retryAfter: string): ProviderReply {
  const brain = createFakeAutopilotAi();
  let limited = false;
  return async (call) => {
    const tool = call.body.tools?.[0]?.function;
    if (!limited && tool?.name === "book_concept") {
      limited = true;
      return failReply(429, "Rate limit reached", { "retry-after": retryAfter });
    }
    const out = await brain.complete({ capability: "autopilot", label: "provider", system: call.body.messages[0].content, user: call.body.messages[1].content, json: tool });
    if (tool) return toolReply(out.json, USAGE);
    return call.body.stream ? streamedReply(out.text, USAGE) : textReply(out.text, USAGE);
  };
}

/** The shape of a request, without the prompt: what it asks for and how, which does not change from one run to the next. */
const shapeOf = (calls: ProviderCall[]) => calls.map((call) => ({
  url: call.url,
  method: call.method,
  authorization: call.headers.authorization,
  asks: call.body.tools?.[0]?.function.name ?? (call.body.stream ? "streamed prose" : "prose"),
  limit: call.body.max_tokens ?? call.body.max_completion_tokens,
  temperature: call.body.temperature,
  toolChoice: call.body.tool_choice,
}));

interface Setup {
  fixtures?: Fixture[];
  settings?: AppSettings;
  options?: Record<string, unknown>;
}

async function runBook(host: "browser" | "server", retryAfter: string, setup: Setup = {}) {
  const used = setup.settings ?? settings;
  const fake = createFakeProvider(endpointsOf(setup.fixtures ?? [fixture]), rateLimitedModel(retryAfter), [GITHUB_TOKEN]);
  vi.stubGlobal("fetch", fake.fetch);
  let ai: AiPort;
  if (host === "browser") {
    useSettingsStore.setState({ settings: used });
    ai = createBrowserAi();
  } else {
    ai = createFetchAi(pickAiRuntimeConfig(JSON.parse(JSON.stringify(pickAiRuntimeConfig(used)))), { fetch: fake.fetch });
  }
  const events: AutopilotEvent[] = [];
  const session = new AutopilotSession({ bookId: "book-1", store: new MemoryBookStore(seedBookFiles({ chapters: 1 })), ai, host: "browser", hostLabel: `test ${host}`, retryDelayMs: 40, random: () => 0.5 });
  session.subscribe((event) => events.push(event));
  await session.start({ brief: { idea: "A harbor built on glass hides a lie.", wordsPerScene: 300 }, options: { readers: false, readersOnPlan: false, pauseAfterPlan: false, ...setup.options } });
  await session.waitForIdle();
  const state = (await session.snapshot()).state!;
  return { calls: fake.calls, events, state, retries: events.filter((event) => event.type === "insight" && event.code === "failureRetry") };
}

beforeEach(() => {
  localStorage.clear();
  useLlmDebugStore.setState({ entries: [], pending: 0, storageError: null, accountIdentity: null });
  resetCosts({ bookId: "book-1", bookName: "The Glass Harbor" });
  setFallbackAcknowledgementAccountScope(localWorkspaceScope());
});

afterEach(() => {
  vi.unstubAllGlobals();
  setFallbackAcknowledgementAccountScope(null);
  assertProvidersClean();
});

describe("a whole book written through the browser's AI port", () => {
  it("makes the same requests, rides out a rate limit the same way and costs what the autopilot says, as on the personal server", async () => {
    const browser = await runBook("browser", "20");
    const server = await runBook("server", "20");

    expect(browser.state.status).toBe("completed");
    expect(server.state.status).toBe("completed");
    expect(shapeOf(browser.calls)).toEqual(shapeOf(server.calls));
    expect(browser.calls.length).toBeGreaterThan(8);

    // The rate limit was one request, answered once; the runner waited what Retry-After asked (20 s, scaled by retryDelayMs) and went on.
    const concepts = browser.calls.filter((call) => call.body.tools?.[0]?.function.name === "book_concept");
    expect(concepts).toHaveLength(2);
    for (const run of [browser, server]) {
      expect(run.retries.map((event) => event.type === "insight" && [event.attempt, event.retries, event.waitMs])).toEqual([[1, 3, 200]]);
      expect(run.state.stats.failures, "the rate limit did not fail the run").toBe(0);
    }
    // The two hosts count the same calls, tokens and cost. The time the steps took is the clock's and differs from one run to the next.
    // `workedMsSince` is the moment the first step began: a time of the clock, as the working time is, and it differs from one run to the next.
    const { workedMs: browserWorked, workedMsSince: browserSince, ...browserStats } = browser.state.stats;
    const { workedMs: serverWorked, workedMsSince: serverSince, ...serverStats } = server.state.stats;
    expect(browserStats).toEqual(serverStats);
    for (const worked of [browserWorked, serverWorked]) expect(Number.isInteger(worked) && (worked as number) >= 0, "the working time is a whole number of milliseconds").toBe(true);
    for (const since of [browserSince, serverSince]) expect(since, "the moment the count began, as a date in UTC").toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // What the autopilot counted is what the browser recorded for the costs, and every request has its entry in the panel.
    const ledger = useCostsStore.getState().file.books["book-1"];
    expect(ledger.inputTokens).toBe(browser.state.stats.inputTokens);
    expect(ledger.outputTokens).toBe(browser.state.stats.outputTokens);
    expect(ledger.chatCost).toBeCloseTo(browser.state.stats.cost, 8);
    const panel = useLlmDebugStore.getState();
    expect(panel.entries).toHaveLength(browser.calls.length);
    expect(panel.pending).toBe(0);
    expect(panel.entries.filter((entry) => entry.status === "error")).toHaveLength(1);
  });

  it("sends the temperatures the writer and the tasks ask for and the structured floor, which the browser never did", async () => {
    const { calls } = await runBook("browser", "1");
    const prose = calls.filter((call) => !call.body.tools);
    const structured = calls.filter((call) => call.body.tools);
    const named = (name: string) => structured.find((call) => call.body.tools[0].function.name === name)!;
    expect(prose.length).toBeGreaterThan(0);
    expect(prose[0].body.temperature, "the ghostwriter's temperature reaches the model").toBe(0.8);
    expect(prose.every((call) => call.body.stream === true && typeof call.body.temperature === "number")).toBe(true);
    expect(named("chapter_plan").body).toMatchObject({ temperature: 0.7, max_tokens: 9_000 });
    expect(named("chapter_consolidation").body.temperature).toBe(0.3);
    expect(named("scene_summary").body.max_tokens, "a small structured task still gets the floor").toBe(4_096);
    expect(structured.every((call) => call.body.tool_choice === "required")).toBe(true);
  });
});

describe("the same run with a longer wait asked by the provider", () => {
  it("waits for Retry-After when it is longer than the backoff, and not when it is shorter", async () => {
    const long = await runBook("browser", "20");
    const short = await runBook("browser", "1");
    expect(long.retries.map((event) => event.type === "insight" && event.waitMs)).toEqual([200]);
    expect(short.retries.map((event) => event.type === "insight" && event.waitMs), "a short Retry-After does not shorten the backoff").toEqual([40]);
  });
});

describe("a money budget with a model that has no price", () => {
  it("is explained to the author in the language of the interface, once, and the costs record nothing", async () => {
    await loadAutopilotTranslations();
    const unpriced = compatible("a", [chatModel("gpt-4o", { pricing: undefined })]);

    const run = await runBook("browser", "1", { fixtures: [unpriced], settings: settingsOf([unpriced]), options: { budgetLimit: 1 } });

    expect(run.state.status).toBe("completed");
    const notices = run.events.filter((event) => event.type === "insight" && event.code === "budgetNotApplicable");
    expect(notices, "said once per run").toHaveLength(1);
    expect(presentFeedEvent(i18n.getFixedT("en"), notices[0])?.text).toBe("The money budget does not apply: a model used here has no price.");
    expect(presentFeedEvent(i18n.getFixedT("it"), notices[0])?.text).toBe("Il budget in denaro non si applica: un modello usato qui non ha un prezzo.");
    expect(run.state.stats.costUnknownCalls, "the autopilot counts the calls whose cost it could not measure").toBeGreaterThan(0);
    expect(useCostsStore.getState().file.books["book-1"], "a model without a price has nothing to record").toBeUndefined();
  });
});
