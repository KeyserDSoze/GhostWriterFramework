import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTEXT_FILE,
  DEFAULT_BRIEF,
  DIRECTOR_FILE,
  EVALUATION_GUIDELINES_FILE,
  STORY_DESIGN_FILE,
  TWO_CALL_TASKS,
  countWords,
  createAutopilotState,
  defaultDirector,
  directorPrompt,
  estimateAutopilotRun,
  estimateContextFromState,
  estimateModelsFromConfig,
  estimateProgressFromState,
  measuredSpeed,
  mergeReaderPersonas,
  outlineChapterPath,
  parseDirector,
  pickAiRuntimeConfig,
  serializeDirector,
  serializeOutlineChapter,
  type AutopilotActivity,
  type AutopilotBrief,
  type AutopilotOptions,
  type AutopilotPlan,
  type AutopilotState,
  type PlannedChapter,
  type ServerAiStatus,
} from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";

class SpyStore extends MemoryBookStore {
  reads: string[] = [];
  listed = 0;
  failing = false;
  async list() {
    this.listed += 1;
    return super.list();
  }
  async read(path: string) {
    if (this.failing) throw new Error("the working copy is not here");
    this.reads.push(path);
    return super.read(path);
  }
}

const mocks = vi.hoisted(() => ({
  book: null as unknown,
  structure: undefined as unknown,
  ready: true,
  store: null as unknown,
  outline: [] as Array<{ path: string; content: string; hash?: string }>,
  outlineReads: vi.fn(),
  rest: vi.fn(),
  verified: vi.fn(),
}));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: mocks.structure, loading: false, error: undefined, reload: vi.fn() }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: mocks.ready, ensuring: false, error: null }) }));
vi.mock("@/autopilot/browserStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/browserStore")>()),
  createBrowserBookStore: () => mocks.store,
}));
vi.mock("@/outline/outlineSource", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/outline/outlineSource")>()),
  browserOutlineSource: () => ({
    files: async () => {
      mocks.outlineReads();
      return mocks.outline;
    },
    commit: async () => undefined,
    readState: async () => null,
    readFiles: async () => [],
  }),
}));
vi.mock("@/autopilot/serverIdentity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/serverIdentity")>()),
  verifiedServer: (options: unknown) => mocks.verified(options),
}));
vi.mock("@/autopilot/runEstimate", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/autopilot/runEstimate")>();
  return {
    ...original,
    estimateRest: (...args: Parameters<typeof original.estimateRest>) => {
      mocks.rest(...args);
      return original.estimateRest(...args);
    },
  };
});

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { PlanRestCost } from "@/components/autopilot/plan/PlanRestCost";
import { roundMinutesRange, roundMoneyRange, roundRange } from "@/autopilot/runEstimateFormat";
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { activityOf } from "./helpers/autopilotBand";
import { chapter, planOf, scene } from "./helpers/autopilotFixtures";
import { LOCAL_BOOK, seedBar, t } from "./helpers/quickCommands";
import { CLOUD, HOME, measuredStep, structureOf, withAi, withModels } from "./helpers/setupEstimate";

type Language = "en" | "it";
const LANGUAGES: Language[] = ["en", "it"];
const ADA = serializeDirector({ ...defaultDirector("en"), name: "Ada", maxReviewRounds: 3 });
const PANEL = mergeReaderPersonas("en", []).filter((reader) => reader.enabled).length;
const IDEA = "A harbor town built on glass hides a lie.";

const ROLE_OF: Record<string, string> = { autopilot: "writer", director: "director", "reader-evaluation": "readers", "reader-evaluation-summary": "readers", review: "specialists", "simple-tasks": "summaries" };

type Patch = { brief?: Partial<AutopilotBrief>; plan?: Partial<AutopilotPlan>; options?: Partial<AutopilotOptions>; version?: number };

function chaptersOf(count: number, done = 0, scenes = 0): PlannedChapter[] {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    const status = number <= done ? "done" : "planned";
    return chapter(number, status, { title: `Title ${number}`, summary: `Summary ${number}`, scenes: Array.from({ length: scenes }, (_unused, offset) => scene(offset + 1, status === "done" ? "reviewed" : "planned")) });
  });
}

/** A plan that waits for the author, as the engine leaves it after the director approved it. */
function waiting(chapters: PlannedChapter[], patch: Patch = {}): AutopilotState {
  const base = createAutopilotState(new Date("2026-11-20T10:00:00.000Z"), { ...DEFAULT_BRIEF, idea: IDEA, ...patch.brief });
  return {
    ...base,
    status: "paused",
    phase: "plan",
    concept: { ...base.concept, done: true, generated: true, logline: "A glassmaker's daughter exposes a lie." },
    options: { ...base.options, ...patch.options },
    plan: { ...planOf(chapters), approved: true, awaitingAuthor: true, ...patch.plan },
    version: patch.version ?? 7,
  };
}

const section = () => document.querySelector("[data-plan-rest]") as HTMLElement;
const stat = (name: string) => section().querySelector(`[data-stat="${name}"]`) as HTMLElement;
const value = (name: string) => stat(name).querySelector("dd") as HTMLElement;
const range = (name: string) => ({ min: Number(value(name).dataset.min), max: Number(value(name).dataset.max) });
const warnings = (code: string) => Array.from(section().querySelectorAll(`[data-warning="${code}"]`)) as HTMLElement[];
const headline = () => section().querySelector("[data-estimate='book']") as HTMLElement;

function Rest({ state, activities = [], mode = "approve" }: { state: AutopilotState; activities?: AutopilotActivity[]; mode?: "approve" | "revise" }) {
  return (
    <MemoryRouter>
      <PlanRestCost bookId="book-1" mode={mode} state={state} activities={activities} />
    </MemoryRouter>
  );
}

async function ready() {
  await waitFor(() => expect(document.querySelector("[data-plan-rest][data-state='ready']")).not.toBeNull());
}

async function show(state: AutopilotState, options: { language?: Language; activities?: AutopilotActivity[]; mode?: "approve" | "revise"; integrations?: Parameters<typeof withAi>[0] } = {}) {
  await i18n.changeLanguage(options.language ?? "en");
  seedBar({ noState: true });
  withAi(options.integrations ?? [CLOUD]);
  const view = render(<Rest state={state} activities={options.activities} mode={options.mode} />);
  await ready();
  return view;
}

/** What the engine says, asked as the card asks: the plan's chapters and scenes, the options of the run, where it is, the director's rounds and the files of the book. */
function engineSays(state: AutopilotState, brief: Partial<AutopilotBrief>, activities: AutopilotActivity[] = [], extra: Record<string, unknown> = {}) {
  const speeds = measuredSpeed(activities, { ignoreTasks: TWO_CALL_TASKS });
  return estimateAutopilotRun({
    brief: { ...state.brief, ...brief },
    outline: { entries: 0, lastChapter: state.plan?.chapters.length ?? 0, words: 0 },
    options: state.options,
    maxReviewRounds: 3,
    language: "en",
    currency: "EUR",
    models: estimateModelsFromConfig(pickAiRuntimeConfig(useSettingsStore.getState().settings), speeds),
    readerPanelSize: PANEL,
    progress: { ...estimateProgressFromState(state), conceptDone: true },
    context: { directorWords: countWords(directorPrompt(parseDirector(ADA, "en"))), ...estimateContextFromState(state) },
    ...extra,
  });
}

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.book = LOCAL_BOOK;
  mocks.structure = structureOf();
  mocks.ready = true;
  mocks.store = new SpyStore({ [DIRECTOR_FILE]: ADA });
  mocks.outline = [];
  mocks.outlineReads.mockReset();
  mocks.rest.mockReset();
  mocks.verified.mockReset();
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false, pageDockOpen: false, dockTab: "live", whereIntent: null, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("what the rest will cost, at the end of a plan that waits for the author", () => {
  it.each(LANGUAGES)("is a region named by a heading of its own, and says what it is: an estimate and not a quote (%s)", async (language) => {
    await show(waiting(chaptersOf(12)), { language });
    const region = screen.getByRole("region", { name: t("autopilot.approval.rest.title") });
    expect(region).toBe(section());
    expect(within(region).getByRole("heading", { level: 3, name: t("autopilot.approval.rest.title") })).toBeInTheDocument();
    expect(within(region).getByText(t("autopilot.approval.rest.intro"))).toBeInTheDocument();
  });

  it("is worked out after the first paint: the first draw has its title and no figure, nothing is read and nothing is calculated in it, and the estimate is made later, once", async () => {
    await i18n.changeLanguage("en");
    seedBar({ noState: true });
    withAi([CLOUD]);
    render(<Rest state={waiting(chaptersOf(12))} />);
    expect(section()).toHaveAttribute("data-state", "working");
    expect(section().querySelector("[data-stat]")).toBeNull();
    expect(within(section()).getByText(t("autopilot.approval.rest.working"))).toBeInTheDocument();
    expect((mocks.store as SpyStore).reads).toEqual([]);
    expect(mocks.outlineReads).not.toHaveBeenCalled();
    expect(mocks.rest).not.toHaveBeenCalled();
    await ready();
    expect(mocks.rest).toHaveBeenCalledTimes(1);
    expect((mocks.store as SpyStore).reads).toContain(DIRECTOR_FILE);
  });

  it("does not ask the personal server in the first draw either", async () => {
    mocks.book = { ...LOCAL_BOOK, autopilotHost: "server" };
    mocks.verified.mockResolvedValue({ client: { aiStatus: vi.fn(async () => ({ configured: true, updatedAt: null, routedTasks: [], integrations: [], taskRouting: {} })) }, info: {}, fingerprint: "f" });
    seedBar({ book: mocks.book as never, noState: true, server: "online" });
    withAi([CLOUD]);
    render(<Rest state={waiting(chaptersOf(12))} />);
    expect(mocks.verified).not.toHaveBeenCalled();
    await ready();
    expect(mocks.verified).toHaveBeenCalled();
  });

  it("waits for the working branch before it reads anything, and for the files before it works anything out: one calculation, not one with typical sizes and another with the real ones", async () => {
    mocks.ready = false;
    seedBar({ noState: true });
    withAi([CLOUD]);
    const state = waiting(chaptersOf(12));
    const view = render(<Rest state={state} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
    expect(section()).toHaveAttribute("data-state", "working");
    expect((mocks.store as SpyStore).reads).toEqual([]);
    expect(mocks.rest).not.toHaveBeenCalled();
    mocks.ready = true;
    view.rerender(<Rest state={{ ...state }} />);
    await ready();
    expect(mocks.rest).toHaveBeenCalledTimes(1);
    expect((mocks.store as SpyStore).reads).toContain(DIRECTOR_FILE);
  });

  it("is the estimate of the engine called with the chapters and the scenes of the plan and the options of the run: the calls, the tokens sent and written, the cost", async () => {
    const state = waiting(chaptersOf(14, 0, 4), { options: { maxReaders: 3 } });
    await show(state);
    const expected = engineSays(state, {}, [], { scenesPerChapter: 4 });
    expect(range("calls")).toEqual(expected.calls);
    expect(range("tokens")).toEqual({ min: expected.inputTokens.min + expected.outputTokens.min, max: expected.inputTokens.max + expected.outputTokens.max });
    expect(expected.cost).not.toBeNull();
    expect(range("cost")).toEqual({ min: expected.cost!.min, max: expected.cost!.max });
    expect(headline()).toHaveAttribute("data-chapters", "14");
    expect(headline()).toHaveAttribute("data-to-write", "14");
    expect(headline()).toHaveAttribute("data-words", String(14 * 4 * 1400));
  });

  it("counts only what is left: the chapters done are not paid for again", async () => {
    const state = waiting(chaptersOf(14, 5));
    await show(state);
    expect(range("calls")).toEqual(engineSays(state, {}).calls);
    expect(headline()).toHaveAttribute("data-to-write", "9");
    expect(headline()).toHaveTextContent(t("autopilot.estimate.remaining", { count: 9, total: 14, words: "37,800" }));
  });

  it.each(LANGUAGES)("shows the figures rounded outward to two, and written in the language of the page (%s)", async (language) => {
    await show(waiting(chaptersOf(14)), { language });
    const calls = range("calls");
    const tokens = range("tokens");
    const cost = range("cost");
    expect({ min: Number(value("calls").dataset.shownMin), max: Number(value("calls").dataset.shownMax) }).toEqual(roundRange(calls));
    expect({ min: Number(value("tokens").dataset.shownMin), max: Number(value("tokens").dataset.shownMax) }).toEqual(roundRange(tokens));
    expect({ min: Number(value("cost").dataset.shownMin), max: Number(value("cost").dataset.shownMax) }).toEqual(roundMoneyRange(cost));
    const locale = language === "it" ? "it-IT" : "en-US";
    expect(value("calls")).toHaveTextContent(new Intl.NumberFormat(locale).format(roundRange(calls).min));
    expect(value("tokens").textContent).toMatch(language === "it" ? /milion/ : /million/);
    expect(value("cost").textContent).toContain("€");
  });

  it.each(LANGUAGES)("labels its four figures with the words the full preview uses (%s)", async (language) => {
    await show(waiting(chaptersOf(12)), { language });
    expect(stat("calls")).toHaveTextContent(t("autopilot.estimate.stats.calls"));
    expect(stat("tokens")).toHaveTextContent(t("autopilot.approval.rest.tokens"));
    expect(stat("cost")).toHaveTextContent(t("autopilot.estimate.stats.cost"));
    expect(stat("minutes")).toHaveTextContent(t("autopilot.estimate.stats.minutes"));
    expect(section().querySelectorAll("dt")).toHaveLength(4);
  });

  it("says the cost is not known, and for which model, when a model has no price: it never says zero", async () => {
    await show(waiting(chaptersOf(12)), { integrations: [HOME] });
    expect(value("cost").dataset.known).toBe("false");
    expect(value("cost")).toHaveTextContent(t("autopilot.estimate.notKnown"));
    expect(stat("cost").querySelector("[data-why]")).toHaveTextContent("llama-local");
    expect(range("calls").max).toBeGreaterThan(0);
    expect(range("tokens").max).toBeGreaterThan(0);
    // The missing price is told by the figure; it is not a warning of this card.
    expect(warnings("noPrice")).toHaveLength(0);
  });

  it("says the time is not estimated, and why, until a model has a speed measured on the steps of the book", async () => {
    await show(waiting(chaptersOf(12)));
    expect(value("minutes").dataset.known).toBe("false");
    expect(value("minutes")).toHaveTextContent(t("autopilot.estimate.notEstimated"));
    expect(stat("minutes").querySelector("[data-why]")).toHaveTextContent(t("autopilot.estimate.minutesWhy"));
    expect(warnings("noSpeed")).toHaveLength(0);
  });

  it("estimates the time with the speed of the steps of the planning, and says it is based on what the book did", async () => {
    const activities = [measuredStep("concept", 0), measuredStep("plan", 1), measuredStep("plan-review", 2)];
    const state = waiting(chaptersOf(12));
    await show(state, { activities });
    const expected = engineSays(state, {}, activities);
    expect(expected.minutes).not.toBeNull();
    expect(range("minutes")).toEqual(expected.minutes);
    expect({ min: Number(value("minutes").dataset.shownMin), max: Number(value("minutes").dataset.shownMax) }).toEqual(roundMinutesRange(expected.minutes!));
    expect(section().querySelector("[data-note='measured']")).toHaveTextContent(t("autopilot.estimate.basis.speed", { count: 3 }));
  });

  it("is not in a live region, and has none that ticks: its figures are there to be read, and nothing is announced while they are worked out", async () => {
    await show(waiting(chaptersOf(12)));
    expect(section().closest("[aria-live], [role='status'], [role='alert'], [role='log']")).toBeNull();
    expect(section().querySelector("[aria-live], [role='status'], [role='alert'], [role='log']")).toBeNull();
    for (const element of Array.from(section().querySelectorAll("dd"))) expect(element.closest("[aria-live], [role='status'], [role='alert'], [role='log']")).toBeNull();
  });

  it("is made once for a version of the plan: another log or another copy of the same state is not a new calculation, a new version is", async () => {
    const state = waiting(chaptersOf(12), { version: 7 });
    const view = await show(state, { activities: [] });
    expect(mocks.rest).toHaveBeenCalledTimes(1);
    view.rerender(<Rest state={{ ...state }} activities={[]} />);
    view.rerender(<Rest state={{ ...state, plan: { ...state.plan! } }} activities={[]} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
    expect(mocks.rest).toHaveBeenCalledTimes(1);
    const next = waiting(chaptersOf(12, 3), { version: 8 });
    view.rerender(<Rest state={next} activities={[]} />);
    await waitFor(() => expect(mocks.rest).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(headline()).toHaveAttribute("data-to-write", "9"));
  });

  it("links to the card of the full preview in the Configuration, with a target of 44 pixels", async () => {
    await show(waiting(chaptersOf(12)));
    const link = within(section()).getByRole("link", { name: t("autopilot.approval.rest.full") });
    expect(link).toHaveAttribute("href", "/app/books/book-1/autopilot/settings#autopilot-estimate");
    expect(link.className).toMatch(/\bmin-h-11\b/);
    // The focus is seen as it is on the buttons of the card: a ring.
    expect(link.className).toMatch(/focus-visible:ring-2/);
  });

  it("says nothing when no chapter is left to write", async () => {
    await i18n.changeLanguage("en");
    seedBar({ noState: true });
    withAi([CLOUD]);
    render(<Rest state={waiting(chaptersOf(6, 6))} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
    await waitFor(() => expect(document.querySelector("[data-plan-rest]")).toBeNull());
  });

  it("says nothing for a book it does not know", async () => {
    mocks.book = undefined;
    seedBar({ noState: true });
    withAi([CLOUD]);
    render(<Rest state={waiting(chaptersOf(12))} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
    expect(document.querySelector("[data-plan-rest]")).toBeNull();
  });
});

describe("the problems it shows", () => {
  const SMALL = withModels(CLOUD, [{ id: "m1", name: "small-8k", capabilities: ["default"], supportsToolCalls: true, maxInputTokens: 6000, maxOutputTokens: 500 }]);
  const ROLES_OF_ALL = ["writer", "director", "readers", "specialists", "summaries"];
  const isolated = (name: string) => `\u2068${name}\u2069`;

  it("are a role with no model, with the way to give it one: AI Integrations when there is no integration at all", async () => {
    await show(waiting(chaptersOf(12)), { integrations: [] });
    const found = warnings("noModel");
    expect(found).toHaveLength(1);
    expect(found[0]).toHaveAttribute("data-severity", "error");
    expect(found[0]).toHaveTextContent(t("autopilot.estimate.severity.error"));
    for (const role of ROLES_OF_ALL) expect(found[0]).toHaveTextContent(t(`autopilot.estimate.roles.${role}`));
    expect(within(found[0]).getByRole("link", { name: t("autopilot.estimate.actions.integrations") })).toHaveAttribute("href", "/app/settings/ai-integrations");
    expect(value("cost").dataset.known).toBe("false");
    // The problem says why, once, right under them: the figures do not say it a third and a fourth time, and do not blame a price that nobody could set.
    expect(value("cost")).toHaveTextContent(t("autopilot.estimate.notKnown"));
    expect(value("minutes")).toHaveTextContent(t("autopilot.estimate.notEstimated"));
    expect(stat("cost").querySelector("[data-why]")).toBeNull();
    expect(stat("minutes").querySelector("[data-why]")).toBeNull();
    expect(section().textContent).not.toMatch(/no price is set/i);
  });

  it("still says why when a role has a model that is not priced and the problem is another one", async () => {
    const mixed = withModels(HOME, [{ id: "l1", name: "llama-local", capabilities: ["director"], supportsToolCalls: true }]);
    await show(waiting(chaptersOf(12)), { integrations: [mixed] });
    expect(warnings("noModel")).toHaveLength(1);
    expect(stat("cost").querySelector("[data-why]")).toHaveTextContent("llama-local");
  });

  it("are the window of a model that is too small, said once for all the roles it is asked for, with one way to the AI Router", async () => {
    await show(waiting(chaptersOf(12)), { integrations: [SMALL] });
    const found = warnings("smallWindow");
    expect(found).toHaveLength(1);
    expect(found[0]).toHaveAttribute("data-severity", "error");
    // Every role the window is too small for (the summaries fit in it).
    for (const role of ["writer", "director", "readers", "specialists"]) expect(found[0]).toHaveTextContent(t(`autopilot.estimate.roles.${role}`));
    expect(found[0].dataset.capabilities!.split(" ").length).toBeGreaterThan(2);
    expect(found[0]).toHaveTextContent(`${isolated("small-8k")} (6,000 tokens)`);
    const links = within(found[0]).getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveTextContent(t("autopilot.approval.rest.router"));
    expect(links[0].getAttribute("href")).toMatch(/^\/app\/settings\/ai-router#router-row-(autopilot|director|reader-evaluation|review|simple-tasks)/);
    expect(links[0].getAttribute("href")).toBe(`/app/settings/ai-router#router-row-${found[0].dataset.capabilities!.split(" ")[0]}`);
    expect(links[0].className).toMatch(/\bmin-h-11\b/);
  });

  it("are the replies that do not fit, said once as well", async () => {
    await show(waiting(chaptersOf(12)), { integrations: [SMALL] });
    const found = warnings("smallOutput");
    expect(found).toHaveLength(1);
    expect(found[0]).toHaveAttribute("data-severity", "warning");
    expect(found[0]).toHaveTextContent(`${isolated("small-8k")} cannot answer with more than 500 tokens`);
    expect(within(found[0]).getAllByRole("link")).toHaveLength(1);
    expect(section().querySelectorAll("[data-warning]").length).toBeLessThanOrEqual(2);
  });

  it("have a button for each role when only one or two are concerned, to the row of the AI Router of the role", async () => {
    const fine = withModels({ ...CLOUD, id: "fine", name: "Fine" }, [{ id: "m1", name: "writer-1", capabilities: ["default"], supportsToolCalls: true, maxInputTokens: 128_000, maxOutputTokens: 16_000, pricing: { inputPerMTok: 2, outputPerMTok: 8 } }]);
    const tiny = withModels({ ...CLOUD, id: "tiny", name: "Tiny" }, [{ id: "t1", name: "tiny-4k", capabilities: ["director"], supportsToolCalls: true, maxInputTokens: 4000, maxOutputTokens: 16_000, pricing: { inputPerMTok: 1, outputPerMTok: 2 } }]);
    seedBar({ noState: true });
    withAi([fine, tiny], { taskRouting: { director: { primary: { integrationId: "tiny", model: "tiny-4k" }, fallbacks: [] } } } as never);
    render(<Rest state={waiting(chaptersOf(12))} />);
    await ready();
    const found = warnings("smallWindow");
    expect(found).toHaveLength(1);
    expect(found[0]).toHaveAttribute("data-capability", "director");
    expect(found[0]).toHaveTextContent(t("autopilot.estimate.roles.director"));
    const link = within(found[0]).getByRole("link");
    expect(link).toHaveAttribute("href", "/app/settings/ai-router#router-row-director");
    expect(link).toHaveTextContent(t("autopilot.estimate.actions.routerRow", { role: t("autopilot.estimate.roles.director") }));
  });

  it("say a window that fits with little to spare as a warning, and the others as an error", async () => {
    const mid = withModels(CLOUD, [{ id: "m1", name: "mid-20k", capabilities: ["default"], supportsToolCalls: true, maxInputTokens: 20_000, maxOutputTokens: 16_000, pricing: { inputPerMTok: 1, outputPerMTok: 2 } }]);
    await show(waiting(chaptersOf(12)), { integrations: [mid] });
    const found = warnings("smallWindow");
    expect(found).toHaveLength(1);
    expect(found[0]).toHaveAttribute("data-severity", "warning");
    expect(found[0]).toHaveTextContent(t("autopilot.estimate.severity.warning"));
    expect(found[0]).toHaveTextContent("leaves little room");
  });

  it("leave out the notes that are about something else: no price, no speed, a model that reasons, an outline longer than the brief", async () => {
    const reasoning = withModels(HOME, [{ id: "l1", name: "thinker", capabilities: ["default"], supportsToolCalls: true, supportsReasoning: true }]);
    await show(waiting(chaptersOf(12)), { integrations: [reasoning] });
    for (const code of ["noPrice", "noSpeed", "reasoningModel"]) expect(warnings(code), code).toHaveLength(0);
    expect(section().querySelectorAll("[data-warning]")).toHaveLength(0);
  });

  it.each(LANGUAGES)("say their gravity in a word and with an icon, and are written in the language of the page, with its numbers (%s)", async (language) => {
    await show(waiting(chaptersOf(12)), { language, integrations: [SMALL] });
    const items = Array.from(section().querySelectorAll("[data-warning]")) as HTMLElement[];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.querySelector("svg[aria-hidden='true']")).not.toBeNull();
      expect(item).toHaveTextContent(t(`autopilot.estimate.severity.${item.dataset.severity}`));
      // Said by the page itself: no sentence of the engine, so no other language in it.
      expect(item.querySelector("[lang]")).toBeNull();
    }
    const window = warnings("smallWindow")[0];
    const locale = language === "it" ? "it-IT" : "en-US";
    expect(window).toHaveTextContent(`(${new Intl.NumberFormat(locale).format(6000)} ${language === "it" ? "token" : "tokens"})`);
    const prompt = Number(/(?:about|circa) ([\d.,]+) token/.exec(window.textContent ?? "")![1].replace(/[.,]/g, ""));
    expect(window).toHaveTextContent(`${new Intl.NumberFormat(locale).format(prompt)} token`);
    expect(window).toHaveTextContent(language === "it" ? "il più grande è di circa" : "the largest is about");
  });

  it("are listed in a list the page names, errors before warnings", async () => {
    await show(waiting(chaptersOf(12)), { integrations: [SMALL] });
    const list = within(section()).getByRole("list", { name: t("autopilot.estimate.warnings.label") });
    const order = Array.from(list.querySelectorAll("[data-severity]")).map((item) => ["error", "warning", "info"].indexOf((item as HTMLElement).dataset.severity!));
    expect(order.length).toBeGreaterThan(1);
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });

  it("say the numbers as the page says them: the largest prompt rounded to two figures", async () => {
    await show(waiting(chaptersOf(12)), { integrations: [SMALL] });
    const text = warnings("smallWindow")[0].textContent ?? "";
    const prompt = Number(/about ([\d,]+) tokens/.exec(text)![1].replace(/,/g, ""));
    expect(prompt).toBeGreaterThan(6000);
    expect(prompt % 100).toBe(0);
  });
});

describe("what it reads", () => {
  it("is the few files the full preview reads, in one batch, and the outline as a folder: never the book", async () => {
    const files: Record<string, string> = { [DIRECTOR_FILE]: ADA, [STORY_DESIGN_FILE]: "# Story design\n\nA harbor of glass.", [CONTEXT_FILE]: "# World\n\nSalt and sand.", [EVALUATION_GUIDELINES_FILE]: "# Style\n\nPlain.", "ghostwriters/default.md": "---\ntype: ghostwriter\n---\n\nWrite plainly." };
    for (let number = 1; number <= 40; number += 1) files[`chapters/${String(number).padStart(3, "0")}-title/001-scene.md`] = `Scene text of chapter ${number}.`;
    files["characters/mira-vale.md"] = "---\nname: Mira\n---\n";
    mocks.store = new SpyStore(files);
    mocks.structure = structureOf({ ghostwriters: [{ slug: "default", path: "ghostwriters/default.md", name: "Default" }], readerPersonas: [{ path: "personas/anna.md" }] });
    await show(waiting(chaptersOf(40)));
    const store = mocks.store as SpyStore;
    const allowed = new Set([DIRECTOR_FILE, STORY_DESIGN_FILE, CONTEXT_FILE, EVALUATION_GUIDELINES_FILE, "ghostwriters/default.md", "personas/anna.md"]);
    expect(store.reads.length).toBeGreaterThan(0);
    expect(store.reads.filter((path) => !allowed.has(path))).toEqual([]);
    expect(store.listed).toBe(0);
    expect(mocks.outlineReads).toHaveBeenCalledTimes(1);
  });

  it("counts the author's outline as the full preview does: an entry beyond the plan makes the book longer", async () => {
    mocks.outline = [{ path: outlineChapterPath(12), content: serializeOutlineChapter({ number: 12, title: "The last tide", body: "The tide takes the town.", origin: "author" }) }];
    const state = waiting(chaptersOf(11));
    await show(state);
    expect(mocks.outlineReads).toHaveBeenCalledTimes(1);
    expect(headline()).toHaveAttribute("data-chapters", "12");
  });

  it("says that typical sizes are assumed when the files of the book cannot be read here, and goes on without waiting for them", async () => {
    (mocks.store as SpyStore).failing = true;
    const state = waiting(chaptersOf(12));
    await show(state);
    expect(section().querySelector("[data-note='unread']")).toHaveTextContent(t("autopilot.estimate.unread"));
    expect(range("calls").max).toBeGreaterThan(0);
  });
});

describe("when the plan is to be made again", () => {
  it("counts the plan made again and says so: the changes asked make the director review it before anything is written", async () => {
    const state = waiting(chaptersOf(12), { plan: { approved: false, awaitingAuthor: false, revisionNotes: ["Chapter 3: make it darker."] } });
    await show(state, { mode: "revise" });
    const again = engineSays(state, {});
    expect(again.steps.plan.calls.max).toBeGreaterThan(0);
    expect(range("calls")).toEqual(again.calls);
    expect(within(section()).getByText(t("autopilot.approval.rest.again"))).toBeInTheDocument();
  });

  it("does not say it for a plan that is only to be approved", async () => {
    await show(waiting(chaptersOf(12)));
    expect(within(section()).queryByText(t("autopilot.approval.rest.again"))).toBeNull();
  });
});

describe("a book that runs on the personal server", () => {
  const STATUS: ServerAiStatus = {
    configured: true, updatedAt: "2026-11-20T10:00:00.000Z", routedTasks: ["autopilot"],
    integrations: [{ id: "cloud", name: "Cloud", provider: "openai", endpoint: "https://api.example.test/v1", hasApiKey: true, models: [{ name: "writer-1", capabilities: ["default"], supportsToolCalls: true, maxInputTokens: 128_000, maxOutputTokens: 16_000 }] }],
    taskRouting: {},
    toolsOnly: true,
  };

  async function onServer(answer: ServerAiStatus | Error) {
    mocks.book = { ...LOCAL_BOOK, autopilotHost: "server" };
    if (answer instanceof Error) mocks.verified.mockRejectedValue(answer);
    else mocks.verified.mockResolvedValue({ client: { aiStatus: vi.fn(async () => answer) }, info: {}, fingerprint: "f" });
    seedBar({ book: mocks.book as never, noState: true, server: "online" });
    withAi([CLOUD]);
    render(<Rest state={waiting(chaptersOf(12))} />);
    await ready();
  }

  it("is estimated with the models the server has, and with the price this browser knows for the same integration and model", async () => {
    await onServer(STATUS);
    expect(mocks.verified).toHaveBeenCalled();
    expect(mocks.rest).toHaveBeenCalledTimes(1);
    expect(value("cost").dataset.known).toBe("true");
    expect(warnings("noModel")).toHaveLength(0);
  });

  it("says that the server has no model when it has none, and sends to its settings", async () => {
    await onServer({ configured: false, integrations: [], routedTasks: [], updatedAt: null });
    const found = warnings("noModel");
    expect(found).toHaveLength(1);
    expect(within(found[0]).getByRole("link", { name: t("autopilot.estimate.actions.server") })).toHaveAttribute("href", "/app/settings/server");
    for (const role of ["writer", "director", "readers", "specialists", "summaries"]) expect(found[0]).toHaveTextContent(t(`autopilot.estimate.roles.${role}`));
    expect(found[0]).toHaveTextContent(/personal server has no model/i);
  });

  it("says that the server could not be asked, and uses this browser's models in its place", async () => {
    await onServer(new Error("offline"));
    expect(section().querySelector("[data-note='server']")).toHaveTextContent(t("autopilot.estimate.server.unavailable"));
    expect(value("calls").dataset.known).toBe("true");
  });

  it("does not wait for a working copy in this browser: the models are the server's and the files, when they cannot be read here, are typical sizes", async () => {
    mocks.ready = false;
    (mocks.store as SpyStore).failing = true;
    await onServer(STATUS);
    expect(section().querySelector("[data-note='unread']")).not.toBeNull();
    expect(value("calls").dataset.known).toBe("true");
  });

  it("does not ask the server for a book that runs in this browser", async () => {
    await show(waiting(chaptersOf(12)));
    expect(mocks.verified).not.toHaveBeenCalled();
    expect(section().querySelector("[data-note='server']")).toBeNull();
  });
});
