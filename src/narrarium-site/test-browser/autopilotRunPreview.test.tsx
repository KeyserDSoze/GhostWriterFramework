import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTOPILOT_PRESETS,
  DEFAULT_BRIEF,
  type AutopilotPresetId,
  DEFAULT_OPTIONS,
  TWO_CALL_TASKS,
  countWords,
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
  type AutopilotState,
  type EstimateResult,
  type ServerAiStatus,
} from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";

const mocks = vi.hoisted(() => ({
  book: null as unknown,
  structure: undefined as unknown,
  runtime: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
  local: null as unknown,
  verified: vi.fn(),
  toast: vi.fn(),
  save: vi.fn(async () => true),
}));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: mocks.structure, loading: false, error: undefined, reload: vi.fn() }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: mocks.save }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));
vi.mock("@/autopilot/browserStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/browserStore")>()),
  createBrowserBookStore: () => mocks.local,
}));
vi.mock("@/outline/outlineSource", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/outline/outlineSource")>();
  return { ...original, browserOutlineSource: () => original.storeOutlineSource(mocks.local as never) };
});
vi.mock("@/autopilot/serverIdentity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/serverIdentity")>()),
  verifiedServer: (options: unknown) => mocks.verified(options),
}));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { PREVIEW_PAUSE_MS } from "@/components/autopilot/config/RunPreview";
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { longPlan } from "./helpers/autopilotFixtures";
import { SCALETTA_IDEA, SCALETTA_SYNOPSIS, renderWithScaletta, sizeFiles } from "./helpers/scaletta";

/** The words of the brief the Scaletta fixture holds: the engine counts them in the prompts, so an estimate with them is the one the page shows. */
const SCALETTA_BRIEF = { idea: SCALETTA_IDEA, synopsis: SCALETTA_SYNOPSIS, genre: "mystery", audience: "adults" };
import { seedRun } from "./helpers/autopilotBand";
import { LOCAL_BOOK, makeRuntime, seedBar, t } from "./helpers/quickCommands";
import { CLOUD, HOME, Page, field, measuredStep, region, statValue, structureOf, type, withAi, withModels } from "./helpers/setupEstimate";

type Language = "en" | "it";
const LANGUAGES: Language[] = ["en", "it"];
const PRESET_IDS = AUTOPILOT_PRESETS.map((preset) => preset.id);
const PANEL = mergeReaderPersonas("en", []).filter((reader) => reader.enabled).length;
const ADA = serializeDirector({ ...defaultDirector("en"), name: "Ada", maxReviewRounds: 3 });

const ROLE_OF: Record<string, string> = { autopilot: "writer", director: "director", "reader-evaluation": "readers", "reader-evaluation-summary": "readers", review: "specialists", "simple-tasks": "summaries" };
const preview = () => region("autopilot.estimate.title");
const settings = () => useSettingsStore.getState().settings;
const warnings = (code: string) => Array.from(preview().querySelectorAll(`[data-warning="${code}"]`)) as HTMLElement[];
const range = (name: string) => ({ min: Number(statValue(name).dataset.min), max: Number(statValue(name).dataset.max) });
const rowOf = (role: string) => preview().querySelector(`[data-role="${role}"]`) as HTMLElement;

/** The typing pause of the preview, and a little more: what a person waits for after the last key. */
const pause = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, PREVIEW_PAUSE_MS + 120)); });
const read = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); }); };

async function showFresh(language: Language = "en", integrations = [CLOUD]) {
  await i18n.changeLanguage(language);
  seedBar({ noState: true });
  withAi(integrations);
  await renderWithScaletta(<Page />);
  await screen.findByRole("region", { name: t("autopilot.estimate.title") });
  await read();
}

/**
 * A book made from a size at its creation: its Scaletta has the size's chapter entries and words, and its first configuration starts with the size's
 * review options (`startPreset`). The sizes are not chosen in the configuration any more.
 */
async function showSize(id: AutopilotPresetId, language: Language = "en") {
  const preset = AUTOPILOT_PRESETS.find((entry) => entry.id === id)!;
  mocks.book = { ...LOCAL_BOOK, startPreset: id };
  mocks.local = new MemoryBookStore({ ...sizeFiles(preset.chapters, preset.wordsPerScene), "director.md": ADA });
  await i18n.changeLanguage(language);
  seedBar({ noState: true, book: mocks.book as typeof LOCAL_BOOK });
  withAi([CLOUD]);
  await renderWithScaletta(<Page />);
  await screen.findByRole("region", { name: t("autopilot.estimate.title") });
  await read();
}

/** What the engine says when it is asked, as the spec says, with the same inputs the form and the book give. */
/**
 * The engine's estimate with the chapters of the book (`targetChapters`, which the Scaletta has: its entries, the last one the number of the chapters) and the
 * brief's words; `extra` wins over all of it.
 */
function engineSays(brief: Partial<typeof DEFAULT_BRIEF> & { targetChapters?: number }, options: Partial<typeof DEFAULT_OPTIONS>, extra: Record<string, unknown> = {}): EstimateResult {
  const { targetChapters = 12, ...words } = brief;
  return estimateAutopilotRun({
    brief: { ...DEFAULT_BRIEF, ...words }, outline: { entries: targetChapters, lastChapter: targetChapters, words: 0 }, options: { ...DEFAULT_OPTIONS, ...options }, maxReviewRounds: 3, language: "en", currency: "EUR",
    models: estimateModelsFromConfig(pickAiRuntimeConfig(settings())),
    readerPanelSize: PANEL,
    context: { directorWords: countWords(directorPrompt(parseDirector(ADA, "en"))) },
    ...extra,
  });
}

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.runtime = { ...makeRuntime(), configure: vi.fn(async () => undefined), reset: vi.fn(async () => undefined) };
  mocks.book = LOCAL_BOOK;
  mocks.structure = structureOf();
  mocks.local = new MemoryBookStore({ ...sizeFiles(12, DEFAULT_BRIEF.wordsPerScene), "director.md": ADA });
  mocks.verified.mockReset();
  mocks.toast.mockReset();
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false, pageDockOpen: false, dockTab: "live", whereIntent: null, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("the preview of the run, in the form of the autopilot", () => {
  it.each(LANGUAGES)("is a section of the page between the retries and publishing, with a title, and says what it is: an estimate, made before it starts (%s)", async (language) => {
    await showFresh(language);
    const titles = within(document.getElementById("autopilot-panel-overview") as HTMLElement).getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent?.trim());
    expect(titles).toEqual([t("autopilot.config.overview.state"), t("autopilot.config.overview.scaletta"), t("autopilot.estimate.title")]);
    expect(within(preview()).getByText(t("autopilot.estimate.intro"))).toBeInTheDocument();
  });

  describe.each(LANGUAGES)("(%s)", (language) => it.each(PRESET_IDS)("shows, for a book made from «%s», the numbers of the engine called with the same inputs: the calls, the tokens, the cost, and the chapters and the words", async (id) => {
    await showSize(id, language);
    await pause();
    const preset = AUTOPILOT_PRESETS.find((entry) => entry.id === id)!;
    const expected = engineSays({ ...SCALETTA_BRIEF, targetChapters: preset.chapters, wordsPerScene: preset.wordsPerScene }, preset.options);
    expect(range("calls")).toEqual(expected.calls);
    expect(range("input-tokens")).toEqual(expected.inputTokens);
    expect(range("output-tokens")).toEqual(expected.outputTokens);
    expect(expected.cost).not.toBeNull();
    expect(range("cost")).toEqual({ min: expected.cost!.min, max: expected.cost!.max });
    expect(statValue("cost").dataset.known).toBe("true");
    const headline = preview().querySelector("[data-estimate='book']") as HTMLElement;
    expect(Number(headline.dataset.chapters)).toBe(expected.chapters);
    expect(Number(headline.dataset.toWrite)).toBe(expected.chaptersToWrite);
    expect(Number(headline.dataset.words)).toBe(expected.words);
    expect(headline).toHaveTextContent(new Intl.NumberFormat(language).format(expected.words));
    // The calls by role are the same calls, shown by role.
    const roles = Array.from(preview().querySelectorAll("[data-role]")) as HTMLElement[];
    expect(roles.reduce((sum, row) => sum + Number(row.dataset.max), 0)).toBe(expected.calls.max);
    expect(roles.reduce((sum, row) => sum + Number(row.dataset.min), 0)).toBe(expected.calls.min);
  }));

  it.each(LANGUAGES)("writes its figures in the language of the page: grouping, words for the millions, the currency, and two figures at most: no fake precision (%s)", async (language) => {
    await showFresh(language);
    const expected = engineSays({}, {});
    const whole = (value: number) => new Intl.NumberFormat(language).format(value);
    expect(preview().querySelector("[data-estimate='book']")).toHaveTextContent(whole(expected.words));
    const shown = (name: string) => ({ min: Number(statValue(name).dataset.shownMin), max: Number(statValue(name).dataset.shownMax) });
    expect(statValue("calls")).toHaveTextContent(whole(shown("calls").min));
    expect(statValue("calls")).toHaveTextContent(whole(shown("calls").max));
    // Two significant figures: a number of three digits or more ends in zeros, whatever the engine said.
    for (const name of ["calls", "input-tokens", "output-tokens"]) {
      for (const value of [shown(name).min, shown(name).max]) expect(String(value).replace(/0+$/, "").length, `${name} ${value}`).toBeLessThanOrEqual(2);
    }
    expect(statValue("input-tokens").textContent).toMatch(language === "en" ? /million|thousand/ : /milion|mila/);
    expect(statValue("cost").textContent).toContain("€");
    expect(statValue("cost").textContent).not.toMatch(/\d[.,]\d\d\d/);
  });

  it("holds the engine's interval with its ends: what is shown is never inside what the engine computed", async () => {
    await showFresh();
    const expected = engineSays({}, {});
    const shown = (name: string) => ({ min: Number(statValue(name).dataset.shownMin), max: Number(statValue(name).dataset.shownMax) });
    for (const [name, real] of [["calls", expected.calls], ["input-tokens", expected.inputTokens], ["output-tokens", expected.outputTokens]] as const) {
      expect(shown(name).min, name).toBeLessThanOrEqual(real.min);
      expect(shown(name).max, name).toBeGreaterThanOrEqual(real.max);
    }
    expect(shown("cost").min).toBeLessThanOrEqual(expected.cost!.min);
    expect(shown("cost").max).toBeGreaterThanOrEqual(expected.cost!.max);
  });

  it("says in words that the range is wide on purpose, and what it depends on: the rounds of review the director allows", async () => {
    await showFresh();
    expect(within(preview()).getByText(t("autopilot.estimate.interval", { rounds: 3 }))).toBeInTheDocument();
  });
});

describe("the review rounds, which are the director's", () => {
  it("are the ones the director's file allows, with the way to the page that changes them", async () => {
    await showFresh();
    const sentence = within(preview()).getByText(t("autopilot.estimate.rounds.director", { count: 3 }));
    expect(sentence).toBeInTheDocument();
    const rounds = preview().querySelector("[data-estimate='rounds']") as HTMLElement;
    expect(within(rounds).getByRole("link", { name: t("autopilot.estimate.rounds.open") })).toHaveAttribute("href", "/app/books/book-1/director");
    expect(range("calls").max).toBeGreaterThan(engineSays({}, {}, { maxReviewRounds: 1, context: {} }).calls.max);
  });

  it("have one link to the director's page for both notes: a target of 44 px after them, not a line-high link inside a sentence", async () => {
    await showSize("novel-draft");
    await pause();
    const group = preview().querySelector("[data-estimate='rounds']") as HTMLElement;
    expect(group.querySelector("[data-estimate='preset-rounds']")).not.toBeNull();
    const links = within(group).getAllByRole("link", { name: t("autopilot.estimate.rounds.open") });
    expect(links).toHaveLength(1);
    expect(links[0].className).toMatch(/\bmin-h-11\b/);
    expect(links[0].closest("p")).toBeNull();
    expect(preview().querySelectorAll("a[href$='/director']")).toHaveLength(1);
  });

  it("are the default director's when the book has none yet", async () => {
    mocks.local = new MemoryBookStore(sizeFiles(12, DEFAULT_BRIEF.wordsPerScene));
    await showFresh();
    expect(within(preview()).getByText(t("autopilot.estimate.rounds.director", { count: defaultDirector("en").maxReviewRounds }))).toBeInTheDocument();
  });

  it("say, when the size chosen recommends others, that the preset does not change the director, and link to the director's page", async () => {
    await showSize("novel-draft");
    await pause();
    const note = preview().querySelector("[data-estimate='preset-rounds']") as HTMLElement;
    expect(note).toHaveTextContent(t("autopilot.estimate.rounds.preset", { preset: t("autopilot.presets.novel-draft.name"), count: 1, rounds: 3 }));
    expect(within(note.closest("[data-estimate='rounds']") as HTMLElement).getByRole("link", { name: t("autopilot.estimate.rounds.open") })).toHaveAttribute("href", "/app/books/book-1/director");
    // The estimate is made with the director's three, not the preset's one.
    expect(range("calls")).toEqual(engineSays({ targetChapters: AUTOPILOT_PRESETS[2].chapters, wordsPerScene: AUTOPILOT_PRESETS[2].wordsPerScene }, AUTOPILOT_PRESETS[2].options).calls);
    expect(((mocks.local as MemoryBookStore).files.get("director.md"))).toBe(ADA);
  });

  it("say nothing of it when the director allows what the size recommends, and when the numbers are the author's own", async () => {
    mocks.local = new MemoryBookStore({ ...sizeFiles(24, 1500), "director.md": serializeDirector({ ...defaultDirector("en"), maxReviewRounds: 1 }) });
    mocks.book = { ...LOCAL_BOOK, startPreset: "novel-draft" };
    seedBar({ noState: true, book: mocks.book as typeof LOCAL_BOOK });
    await i18n.changeLanguage("en");
    withAi([CLOUD]);
    await renderWithScaletta(<Page />);
    await read();
    expect(preview().querySelector("[data-estimate='preset-rounds']")).toBeNull();
    type(field("autopilot.setup.maxReaders"), "2");
    await pause();
    expect(preview().querySelector("[data-estimate='preset-rounds']")).toBeNull();
  });
});

describe("the cost and the time that are not known", () => {
  it("say Not known, with the reason, for a model that has no price: the owner's computer is not free, it is not priced, and the calls and the tokens stay", async () => {
    await showFresh("en", [HOME]);
    const expected = engineSays({}, {});
    expect(expected.cost).toBeNull();
    expect(statValue("cost")).toHaveTextContent(t("autopilot.estimate.notKnown"));
    expect(statValue("cost").dataset.known).toBe("false");
    expect(statValue("cost").textContent).not.toMatch(/[0-9]/);
    expect(stat_why("cost")).toHaveTextContent("llama-local");
    expect(range("calls")).toEqual(expected.calls);
    expect(range("input-tokens")).toEqual(expected.inputTokens);
    expect(range("output-tokens")).toEqual(expected.outputTokens);
  });

  it("say, when there is no model at all, that none is set for the roles, and not that a price is missing for «no model»", async () => {
    await showFresh("en", []);
    const roles = ["writer", "director", "readers", "specialists", "summaries"].map((role) => t(`autopilot.estimate.roles.${role}`)).join(", ");
    expect(statValue("cost")).toHaveTextContent(t("autopilot.estimate.notKnown"));
    expect(stat_why("cost")).toHaveTextContent(t("autopilot.estimate.noModelWhy", { roles }));
    expect(stat_why("cost").textContent).not.toMatch(/no price is set/i);
    expect(statValue("minutes")).toHaveTextContent(t("autopilot.estimate.notEstimated"));
    expect(stat_why("minutes")).toHaveTextContent(t("autopilot.estimate.noModelWhy", { roles }));
  });

  it("say Not estimated, with the reason, until the book has run: the speed of a model is learned from the steps it ran", async () => {
    await showFresh();
    expect(statValue("minutes")).toHaveTextContent(t("autopilot.estimate.notEstimated"));
    expect(statValue("minutes").dataset.known).toBe("false");
    expect(stat_why("minutes")).toHaveTextContent(t("autopilot.estimate.minutesWhy"));
  });

  it("give the cost that is known when some roles have a price and some do not, as the part that can be added up, and never as the cost of the run", async () => {
    const mixed = withModels(HOME, [{ ...HOME.chatModels![0], capabilities: ["director", "review"] }]);
    await showFresh("en", [CLOUD, mixed]);
    expect(statValue("cost")).toHaveTextContent(t("autopilot.estimate.notKnown"));
    expect(stat_why("cost")).toHaveTextContent(t("autopilot.estimate.roles.director"));
    expect(preview().querySelector("[data-estimate='priced-part']")).not.toBeNull();
  });

  it("say, for a model with the price declared as zero, zero: a price of zero is a price", async () => {
    const free = withModels(HOME, [{ ...HOME.chatModels![0], pricing: { inputPerMTok: 0, outputPerMTok: 0 } }]);
    await showFresh("en", [free]);
    expect(statValue("cost").dataset.known).toBe("true");
    expect(range("cost")).toEqual({ min: 0, max: 0 });
  });
});

function stat_why(name: string): HTMLElement {
  return preview().querySelector(`[data-stat="${name}"] [data-why]`) as HTMLElement;
}

describe("a book that is started, or that grows", () => {
  it("counts only what is left of the chapters of a book that is half way, and says so", async () => {
    await i18n.changeLanguage("en");
    const seeded = seedRun({ status: "paused", chapters: longPlan(12, 4) });
    withAi([CLOUD]);
    await renderWithScaletta(<Page />);
    await screen.findByRole("region", { name: t("autopilot.estimate.title") });
    await read();
    const state = seeded.state as AutopilotState;
    // A book that has a plan has been through its concept: the planner does not plan before it.
    const expected = engineSays(state.brief, state.options, { progress: { ...estimateProgressFromState(state), conceptDone: true }, context: { ...estimateContextFromState(state), directorWords: countWords(directorPrompt(parseDirector(ADA, "en"))) } });
    const headline = preview().querySelector("[data-estimate='book']") as HTMLElement;
    expect(Number(headline.dataset.toWrite)).toBe(8);
    expect(Number(headline.dataset.chapters)).toBe(12);
    expect(headline).toHaveTextContent(t("autopilot.estimate.remaining", { count: 8, total: 12, words: new Intl.NumberFormat("en").format(expected.words) }));
    expect(range("calls")).toEqual(expected.calls);
    expect(range("input-tokens")).toEqual(expected.inputTokens);
  });

  it("counts only the new chapters when «Add chapters» asks for more than a finished book has", async () => {
    seedRun({ status: "completed", chapters: longPlan(12, 12), statePatch: { finalDone: true } });
    mocks.local = new MemoryBookStore({ ...sizeFiles(12, DEFAULT_BRIEF.wordsPerScene), "director.md": ADA });
    withAi([CLOUD]);
    await renderWithScaletta(<Page />);
    await screen.findByRole("region", { name: t("autopilot.estimate.title") });
    await read();
    const headline = () => preview().querySelector("[data-estimate='book']") as HTMLElement;
    expect(preview()).toHaveTextContent(t("autopilot.estimate.nothingLeft"));
    expect(Number(headline().dataset.toWrite)).toBe(0);
    // The author adds four entries to the Scaletta, and comes back to the configuration: the page reads them again when the window is back.
    const store = mocks.local as MemoryBookStore;
    for (const number of [13, 14, 15, 16]) store.files.set(`outline/chapters/${String(number).padStart(3, "0")}.md`, serializeOutlineChapter({ number, origin: "author" }));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(Number(headline().dataset.toWrite)).toBe(4), { timeout: 3000 });
    expect(Number(headline().dataset.chapters)).toBe(16);
    expect(preview()).not.toHaveTextContent(t("autopilot.estimate.nothingLeft"));
  });

  it("counts the chapters a book already has, and a call for each one that has no summary, before the plan, when the autopilot never started", async () => {
    mocks.structure = structureOf({ chapters: [{ slug: "001-one", title: "One", paragraphs: [{}], hasResume: true }, { slug: "002-two", title: "Two", paragraphs: [{}], hasResume: false }, { slug: "003-three", title: "Three", paragraphs: [{}], hasResume: false }] });
    await showFresh();
    const expected = engineSays({ targetChapters: 12 }, {}, { progress: { chaptersDone: 3, withoutSummary: 2 }, context: { directorWords: countWords(directorPrompt(parseDirector(ADA, "en"))) } });
    expect(Number((preview().querySelector("[data-estimate='book']") as HTMLElement).dataset.toWrite)).toBe(expected.chaptersToWrite);
    expect(range("calls")).toEqual(expected.calls);
  });

});

describe("the warnings of the engine", () => {
  const SMALL = withModels(CLOUD, [{ id: "s", name: "small-8k", capabilities: ["default"], supportsToolCalls: true, supportsReasoning: true, maxInputTokens: 8000, maxOutputTokens: 2000, pricing: { inputPerMTok: 1, outputPerMTok: 1 } }]);
  const UNPRICED = withModels(SMALL, [{ ...SMALL.chatModels![0], pricing: undefined }]);

  it.each(LANGUAGES)("say that a model is too small for a step, as a problem, with the engine's own words and a way to the row of the router that chooses it: the icon, the word and the text, never only a colour (%s)", async (language) => {
    await showFresh(language, [SMALL]);
    const expected = engineSays({}, {}).warnings.filter((entry) => entry.code === "smallWindow");
    expect(expected.length).toBeGreaterThan(0);
    const shown = warnings("smallWindow");
    expect(shown).toHaveLength(expected.length);
    for (const entry of expected) {
      const item = shown.find((candidate) => candidate.dataset.capability === entry.capability)!;
      expect(item.dataset.severity).toBe(entry.severity);
      expect(item).toHaveTextContent(entry.text);
      expect(within(item).getByText(t(`autopilot.estimate.severity.${entry.severity}`))).toBeInTheDocument();
      expect(item.querySelector("svg[aria-hidden='true']")).not.toBeNull();
      const role = t(`autopilot.estimate.roles.${ROLE_OF[entry.capability]}`);
      expect(within(item).getByRole("link", { name: t("autopilot.estimate.actions.routerRow", { role }) })).toHaveAttribute("href", `/app/settings/ai-router#router-row-${entry.capability}`);
    }
  });

  it.each(LANGUAGES)("say that a model cannot answer as much as a step needs, that it has no price, no speed, and that it reasons (%s)", async (language) => {
    await showFresh(language, [UNPRICED]);
    const expected = engineSays({}, {});
    expect(expected.warnings.some((entry) => entry.code === "smallOutput")).toBe(true);
    expect(warnings("smallOutput")[0]).toHaveTextContent(expected.warnings.find((entry) => entry.code === "smallOutput")!.text);
    for (const code of ["noPrice", "noSpeed", "reasoningModel"]) {
      const found = warnings(code);
      expect(found, code).toHaveLength(1);
      expect(found[0]).toHaveTextContent("small-8k");
      expect(found[0].dataset.severity).toBe(expected.warnings.find((entry) => entry.code === code)!.severity);
      expect(within(found[0]).getByText(t(`autopilot.estimate.severity.${found[0].dataset.severity}`))).toBeInTheDocument();
      expect(found[0].querySelector("svg[aria-hidden='true']")).not.toBeNull();
    }
  });

  it.each(LANGUAGES)("say, once, that no model is set, as a problem, with the way to AI Integrations when there is not one at all (%s)", async (language) => {
    await showFresh(language, []);
    const found = warnings("noModel");
    expect(found).toHaveLength(1);
    expect(found[0].dataset.severity).toBe("error");
    expect(within(found[0]).getByRole("link", { name: t("autopilot.estimate.actions.integrations") })).toHaveAttribute("href", "/app/settings/ai-integrations");
    for (const role of ["writer", "director", "readers", "specialists", "summaries"]) expect(found[0]).toHaveTextContent(t(`autopilot.estimate.roles.${role}`));
    expect(statValue("cost").dataset.known).toBe("false");
    expect(range("calls").max).toBeGreaterThan(0);
  });

  it("lead to the row of the router of each role that has no model, when there are integrations but none serves it", async () => {
    const odd = withModels(CLOUD, [{ id: "c", name: "chat-only", capabilities: ["copilot"], supportsToolCalls: true }]);
    await showFresh("en", [odd]);
    const found = warnings("noModel")[0];
    expect(found).toBeDefined();
    for (const capability of ["autopilot", "director", "reader-evaluation", "review", "simple-tasks"]) {
      const link = within(found).getByRole("link", { name: t("autopilot.estimate.actions.routerRow", { role: t(`autopilot.estimate.roles.${ROLE_OF[capability]}`) }) });
      expect(link).toHaveAttribute("href", `/app/settings/ai-router#router-row-${capability}`);
    }
  });

  it("show the problems before the warnings and the warnings before the notes", async () => {
    await showFresh("en", [UNPRICED]);
    const order = { error: 0, warning: 1, info: 2 } as Record<string, number>;
    const shown = Array.from(preview().querySelectorAll("[data-warning]")).map((item) => order[(item as HTMLElement).dataset.severity!]);
    expect(shown.length).toBeGreaterThan(3);
    expect(shown).toEqual([...shown].sort((a, b) => a - b));
  });

  it("have no list at all when there is nothing to say", async () => {
    mocks.local = new MemoryBookStore({ ...sizeFiles(12, DEFAULT_BRIEF.wordsPerScene), "director.md": ADA });
    await showFresh("en", [CLOUD]);
    // A model with a price and a window, whose speed no run has measured: only the note about the speed.
    expect(Array.from(preview().querySelectorAll("[data-warning]")).map((item) => (item as HTMLElement).dataset.warning)).toEqual(["noSpeed"]);
  });
});

describe("alphabets that are not Latin", () => {
  it("estimates a book written in another script with the engine's factor for its language, and marks the engine's words with the language they are in", async () => {
    mocks.structure = structureOf({ language: "ru" });
    await showFresh();
    const expected = engineSays({}, {}, { language: "ru" });
    expect(expected.outputTokens.max).toBeGreaterThan(engineSays({}, {}).outputTokens.max);
    expect(range("output-tokens")).toEqual(expected.outputTokens);
    expect(range("calls")).toEqual(expected.calls);
    // The engine's sentences are English for a book that is not Italian: that, and not the book's own language, is what they are marked with.
    expect(expected.language).toBe("ru");
    expect(expected.assumptions.join(" ")).toMatch(/The book has/);
    const items = Array.from(preview().querySelectorAll("details li"));
    expect(items.length).toBeGreaterThan(3);
    for (const item of items) expect(item).toHaveAttribute("lang", "en");
  });

  it("marks the engine's words with Italian for an Italian book, and with the language of the page for its own words", async () => {
    mocks.structure = structureOf({ language: "it" });
    await showFresh("en", [withModels(CLOUD, [{ ...CLOUD.chatModels![0], maxInputTokens: 8000, maxOutputTokens: 2000 }])]);
    const found = warnings("smallWindow")[0];
    expect(found.querySelector("span[lang]")).toHaveAttribute("lang", "it");
    expect(found.querySelector("span[lang]")?.textContent).toMatch(/finestra/);
    for (const item of preview().querySelectorAll("details li")) expect(item).toHaveAttribute("lang", "it");
  });

  it("keeps the name of a model in another script apart from the words of ours, and shows it as it is in the table", async () => {
    const arabic = withModels(HOME, [{ ...HOME.chatModels![0], name: "نموذج-محلي" }]);
    await showFresh("en", [arabic]);
    const found = warnings("noPrice")[0];
    expect(found.textContent).toContain("\u2068نموذج-محلي\u2069");
    expect(rowOf("writer").querySelector("bdi")).toHaveTextContent("نموذج-محلي");
    expect(stat_why("cost").textContent).toContain("\u2068نموذج-محلي\u2069");
  });

  it("writes the figures with the digits and the grouping of the language of the page, whatever the language of the book", async () => {
    mocks.structure = structureOf({ language: "ja" });
    await showFresh("it");
    const expected = engineSays({}, {}, { language: "ja" });
    expect(preview().querySelector("[data-estimate='book']")).toHaveTextContent(new Intl.NumberFormat("it").format(expected.words));
    expect(range("calls")).toEqual(expected.calls);
  });
});

describe("what the assumptions are", () => {
  it("are the engine's own sentences, in a section that opens and closes, closed by default, in the language of the book", async () => {
    await showFresh();
    const details = preview().querySelector("details[data-estimate='assumptions']") as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(within(details).getByText(t("autopilot.estimate.assumptions.title"))).toBeInTheDocument();
    const expected = engineSays({}, {});
    for (const sentence of expected.assumptions) expect(details).toHaveTextContent(sentence.slice(0, 40));
    expect(details.querySelector("li")).toHaveAttribute("lang", "en");
  });

  it("say what was assumed of the files of the book, and of the canon, when they were measured or not", async () => {
    mocks.structure = structureOf({ characters: [{}, {}, {}], locations: [{}, {}] });
    mocks.local = new MemoryBookStore({ ...sizeFiles(12, DEFAULT_BRIEF.wordsPerScene), "director.md": ADA });
    await showFresh();
    const details = preview().querySelector("details[data-estimate='assumptions']") as HTMLElement;
    expect(within(details).getByText(t("autopilot.estimate.assumptions.canon", { count: 5 }))).toBeInTheDocument();
  });
});

describe("after the first run", () => {
  const RUN = [measuredStep("plan", 0), measuredStep("scenes", 1), measuredStep("consolidate", 2)];
  const writes = [0, 1, 2, 3].map((index) => measuredStep("write", 10 + index, { summary: "1000 words — The keeper climbs the stairs.", usage: { inputTokens: 4000, outputTokens: 1500, cachedInputTokens: 0 }, model: "writer-1" }));

  it("uses the speed the book measured, and says that it is based on what the book did", async () => {
    seedRun({ status: "paused", chapters: longPlan(12, 4), activities: RUN });
    withAi([CLOUD]);
    await renderWithScaletta(<Page />);
    await screen.findByRole("region", { name: t("autopilot.estimate.title") });
    await read();
    const speeds = measuredSpeed(RUN, { ignoreTasks: TWO_CALL_TASKS });
    const state = useAutopilotStore.getState().views["book-1"].snapshot!.state as AutopilotState;
    const expected = estimateAutopilotRun({
      brief: state.brief, options: state.options, maxReviewRounds: 3, language: "en", currency: "EUR", models: estimateModelsFromConfig(pickAiRuntimeConfig(settings()), speeds), readerPanelSize: PANEL,
      progress: { ...estimateProgressFromState(state), conceptDone: true }, context: { ...estimateContextFromState(state), directorWords: countWords(directorPrompt(parseDirector(ADA, "en"))) },
    });
    expect(expected.minutes).not.toBeNull();
    expect(statValue("minutes").dataset.known).toBe("true");
    expect(range("minutes")).toEqual(expected.minutes);
    const basis = preview().querySelector("[data-note='measured']") as HTMLElement;
    expect(basis).not.toBeNull();
    expect(basis).toHaveTextContent(t("autopilot.estimate.basis.speed", { count: 3 }));
    expect(preview().querySelector("[data-note='tokens']")).toBeNull();
  });

  it("uses the tokens a word it measured, when the scenes it wrote say enough, and says so", async () => {
    seedRun({ status: "paused", chapters: longPlan(12, 4), activities: [...RUN, ...writes] });
    withAi([CLOUD]);
    await renderWithScaletta(<Page />);
    await screen.findByRole("region", { name: t("autopilot.estimate.title") });
    await read();
    const note = preview().querySelector("[data-note='tokens']") as HTMLElement;
    expect(note).not.toBeNull();
    expect(note).toHaveTextContent(t("autopilot.estimate.basis.tokens", { count: 4, value: "1.5" }));
    const state = useAutopilotStore.getState().views["book-1"].snapshot!.state as AutopilotState;
    const expected = estimateAutopilotRun({
      brief: state.brief, options: state.options, maxReviewRounds: 3, language: "en", currency: "EUR", models: estimateModelsFromConfig(pickAiRuntimeConfig(settings()), measuredSpeed([...RUN, ...writes], { ignoreTasks: TWO_CALL_TASKS })), readerPanelSize: PANEL,
      progress: { ...estimateProgressFromState(state), conceptDone: true }, context: { ...estimateContextFromState(state), directorWords: countWords(directorPrompt(parseDirector(ADA, "en"))) }, tokensPerWord: 1.5,
    });
    expect(range("output-tokens")).toEqual(expected.outputTokens);
  });

  it("says nothing of measures before the book has run: there is none to say", async () => {
    await showFresh();
    expect(preview().querySelector("[data-note='measured']")).toBeNull();
    expect(preview().querySelector("[data-note='tokens']")).toBeNull();
  });
});

describe("a book that runs on the personal server", () => {
  const SERVER_STATUS: ServerAiStatus = {
    configured: true, updatedAt: "2026-11-20T10:00:00.000Z", routedTasks: ["autopilot", "director"],
    integrations: [
      { id: "cloud", name: "Cloud", provider: "openai", endpoint: "https://api.example.test/v1", hasApiKey: true, models: [{ name: "writer-1", capabilities: ["default"], supportsToolCalls: true, maxInputTokens: 128_000, maxOutputTokens: 16_000 }] },
      { id: "home", name: "Home", provider: "openai", endpoint: "http://127.0.0.1:8080/v1", hasApiKey: false, models: [{ name: "llama-local", capabilities: ["director"], supportsToolCalls: true }] },
    ],
    taskRouting: { director: { primary: { integrationId: "home", model: "llama-local" }, fallbacks: [] } },
    toolsOnly: true,
  };

  async function showOnServer(status: ServerAiStatus | Error | "pending", integrations = [CLOUD]) {
    mocks.book = { ...LOCAL_BOOK, autopilotHost: "server" };
    if (status === "pending") mocks.verified.mockImplementation(() => new Promise(() => undefined));
    else if (status instanceof Error) mocks.verified.mockRejectedValue(status);
    else mocks.verified.mockResolvedValue({ client: { aiStatus: vi.fn(async () => status) }, info: {}, fingerprint: "f" });
    seedBar({ book: mocks.book as never, noState: true, server: "online" });
    withAi(integrations);
    await renderWithScaletta(<Page />);
    await screen.findByRole("region", { name: t("autopilot.estimate.title") });
    await read();
  }

  it("is estimated with the server's models, and not with this browser's: a server with none configured stops at its first step", async () => {
    await showOnServer({ configured: false, integrations: [], routedTasks: [], updatedAt: null });
    expect(mocks.verified).toHaveBeenCalled();
    const found = warnings("noModel");
    expect(found).toHaveLength(1);
    expect(found[0].dataset.severity).toBe("error");
    expect(within(found[0]).getByRole("link", { name: t("autopilot.estimate.actions.server") })).toHaveAttribute("href", "/app/settings/server");
    expect(within(found[0]).queryByRole("link", { name: t("autopilot.estimate.actions.integrations") })).toBeNull();
    expect(rowOf("writer")).toHaveTextContent(t("autopilot.estimate.noModelShort"));
    expect(statValue("cost").dataset.known).toBe("false");
  });

  it("takes the server's models and routes, and the price this browser knows for the same integration and model: the one it does not know is not priced", async () => {
    await showOnServer(SERVER_STATUS);
    const config = {
      aiIntegrations: [
        { id: "cloud", name: "Cloud", provider: "openai", endpoint: "https://api.example.test/v1", apiKey: "", chatModels: [{ id: "writer-1", name: "writer-1", capabilities: ["default"], supportsToolCalls: true, maxInputTokens: 128_000, maxOutputTokens: 16_000, pricing: { inputPerMTok: 2, outputPerMTok: 8 } }] },
        { id: "home", name: "Home", provider: "openai", endpoint: "http://127.0.0.1:8080/v1", apiKey: "", chatModels: [{ id: "llama-local", name: "llama-local", capabilities: ["director"], supportsToolCalls: true }] },
      ],
      taskRouting: { director: { primary: { integrationId: "home", model: "llama-local" }, fallbacks: [] } },
      defaultWritingIntegrationId: "cloud", defaultReviewIntegrationId: "cloud", toolsOnly: true,
    };
    const expected = engineSays({}, {}, { models: estimateModelsFromConfig(config as never) });
    await waitFor(() => expect(range("calls")).toEqual(expected.calls));
    expect(rowOf("writer")).toHaveTextContent("writer-1");
    expect(rowOf("director")).toHaveTextContent("llama-local");
    expect(statValue("cost").dataset.known).toBe("false");
    expect(stat_why("cost")).toHaveTextContent(t("autopilot.estimate.roles.director"));
    expect(preview().querySelector("[data-note='server']")).not.toBeNull();
    expect(preview().querySelector("[data-note='server']")).toHaveTextContent(t("autopilot.estimate.server.models"));
  });

  it("says that it could not ask the server, and uses this browser's models in its place, when the server does not answer", async () => {
    await showOnServer(new Error("offline"));
    const note = preview().querySelector("[data-note='server']") as HTMLElement;
    expect(note).toHaveTextContent(t("autopilot.estimate.server.unavailable"));
    expect(range("calls")).toEqual(engineSays({}, {}).calls);
    expect(rowOf("writer")).toHaveTextContent("writer-1");
  });

  it("says that it is asking, while it asks", async () => {
    await showOnServer("pending");
    expect(preview().querySelector("[data-note='server']")).toHaveTextContent(t("autopilot.estimate.server.asking"));
  });

  it("does not ask the server for a book that runs in this browser", async () => {
    await showFresh();
    expect(mocks.verified).not.toHaveBeenCalled();
    expect(preview().querySelector("[data-note='server']")).toBeNull();
  });
});
