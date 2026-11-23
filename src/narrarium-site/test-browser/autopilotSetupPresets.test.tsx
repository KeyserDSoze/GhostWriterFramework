import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOPILOT_PRESETS, DEFAULT_BRIEF, DEFAULT_OPTIONS, defaultDirector, serializeDirector } from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";

const mocks = vi.hoisted(() => ({
  book: null as unknown,
  structure: undefined as unknown,
  runtime: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
  local: null as unknown,
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

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { runningStep, seedRun } from "./helpers/autopilotBand";
import { LOCAL_BOOK, makeRuntime, seedBar, t } from "./helpers/quickCommands";
import { CLOUD, Page, field, region, structureOf, type, withAi } from "./helpers/setupEstimate";

type Language = "en" | "it";
const LANGUAGES: Language[] = ["en", "it"];
const PRESET_IDS = AUTOPILOT_PRESETS.map((preset) => preset.id);

const book = () => region("autopilot.config.sections.book");
const review = () => region("autopilot.config.sections.review");
const group = () => within(book()).getByRole("group", { name: t("autopilot.presets.legend") });
const radio = (id: string) => within(group()).getByRole("radio", { name: t(`autopilot.presets.${id}.name`) }) as HTMLInputElement;
const switchOf = (key: string) => within(review()).getByRole("switch", { name: t(`autopilot.setup.${key}`) });

/** A book that never started, with a model, on a page that has read what it needs. */
async function showFresh(language: Language = "en") {
  await i18n.changeLanguage(language);
  seedBar({ noState: true });
  withAi([CLOUD]);
  render(<Page />);
  await screen.findByRole("group", { name: t("autopilot.presets.legend") });
}

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.runtime = { ...makeRuntime(), configure: vi.fn(async () => undefined), reset: vi.fn(async () => undefined) };
  mocks.book = LOCAL_BOOK;
  mocks.structure = structureOf();
  mocks.local = new MemoryBookStore({ "director.md": serializeDirector({ ...defaultDirector("en"), name: "Ada", maxReviewRounds: 3 }) });
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

describe.each(LANGUAGES)("the sizes at the head of the book form (%s)", (language) => {
  it("are three choices of a radio group with a name and a description in plain words, before the idea: a person starts here", async () => {
    await showFresh(language);
    const choices = within(group()).getAllByRole("radio");
    expect(choices.map((choice) => choice.getAttribute("value"))).toEqual(PRESET_IDS);
    for (const id of PRESET_IDS) {
      expect(radio(id)).toHaveAccessibleName(t(`autopilot.presets.${id}.name`));
      const description = radio(id).getAttribute("aria-describedby")!;
      const text = description.split(" ").map((part) => document.getElementById(part)?.textContent ?? "").join(" ");
      expect(text).toContain(t(`autopilot.presets.${id}.about`));
    }
    const idea = field("autopilot.setup.idea");
    expect(group().compareDocumentPosition(idea) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(book()).getAllByRole("group")[0]).toBe(group());
    expect(group()).toHaveAccessibleDescription(t("autopilot.presets.hint"));
  });

  it("say their numbers from the engine's presets, formatted in the language of the page: what a size is, not only its name", async () => {
    await showFresh(language);
    for (const preset of AUTOPILOT_PRESETS) {
      const words = preset.brief.targetChapters * preset.brief.scenesPerChapter * preset.brief.wordsPerScene;
      const text = radio(preset.id).getAttribute("aria-describedby")!.split(" ").map((part) => document.getElementById(part)?.textContent ?? "").join(" ");
      expect(text).toContain(`${preset.brief.targetChapters} `);
      expect(text).toContain(new Intl.NumberFormat(language).format(words));
    }
  });

  it("start the form of a new book on the novella: the numbers a new book has are the ones of that size", async () => {
    await showFresh(language);
    expect(radio("novella")).toBeChecked();
    expect(radio("story")).not.toBeChecked();
    expect(radio("novel-draft")).not.toBeChecked();
    expect(field("autopilot.setup.chapters").value).toBe(String(DEFAULT_BRIEF.targetChapters));
  });

  it.each(PRESET_IDS)("fill the seven fields of «%s» and say Custom no more", async (id) => {
    await showFresh(language);
    type(field("autopilot.setup.idea"), "A keeper who counts the ships that never arrive.", false);
    fireEvent.click(radio(id));
    const preset = AUTOPILOT_PRESETS.find((entry) => entry.id === id)!;
    expect(field("autopilot.setup.chapters").value).toBe(String(preset.brief.targetChapters));
    expect(field("autopilot.setup.scenes").value).toBe(String(preset.brief.scenesPerChapter));
    expect(field("autopilot.setup.words").value).toBe(String(preset.brief.wordsPerScene));
    expect(field("autopilot.setup.maxReaders").value).toBe(String(preset.options.maxReaders));
    expect(switchOf("readers")).toHaveAttribute("aria-checked", String(preset.options.readers));
    expect(switchOf("readersOnPlan")).toHaveAttribute("aria-checked", String(preset.options.readersOnPlan));
    expect(switchOf("specialists")).toHaveAttribute("aria-checked", String(preset.options.specialists));
    expect(radio(id)).toBeChecked();
    expect(screen.queryByText(t("autopilot.presets.custom"))).not.toBeInTheDocument();
    // The rest of the form is the author's: the idea they wrote, the pauses, the budgets.
    expect(field("autopilot.setup.idea").value).toBe("A keeper who counts the ships that never arrive.");
    expect(switchOf("pauseAfterPlan")).toHaveAttribute("aria-checked", String(DEFAULT_OPTIONS.pauseAfterPlan));
  });

  it("follow every edit with the engine's own rule: Custom as soon as a number leaves a size, the size again when it comes back, and the focus never leaves the field", async () => {
    await showFresh(language);
    fireEvent.click(radio("story"));
    const chapters = field("autopilot.setup.chapters");
    chapters.focus();
    type(chapters, "5", false);
    expect(chapters).toHaveFocus();
    for (const id of PRESET_IDS) expect(radio(id)).not.toBeChecked();
    expect(within(book()).getByText(t("autopilot.presets.custom"))).toBeInTheDocument();
    type(chapters, "4", false);
    expect(chapters).toHaveFocus();
    expect(radio("story")).toBeChecked();
    expect(screen.queryByText(t("autopilot.presets.custom"))).not.toBeInTheDocument();
    // A switch of the review leaves the size too, and what changes no number of the run does not.
    switchOf("specialists").focus();
    fireEvent.click(switchOf("specialists"));
    expect(radio("story")).not.toBeChecked();
    expect(switchOf("specialists")).toHaveFocus();
    fireEvent.click(switchOf("specialists"));
    expect(radio("story")).toBeChecked();
    fireEvent.click(switchOf("pauseAfterPlan"));
    expect(radio("story")).toBeChecked();
  });

  it("are Custom for a book whose numbers are its own, and say it in words, not in a colour", async () => {
    await i18n.changeLanguage(language);
    seedRun({ status: "paused", statePatch: { brief: { ...DEFAULT_BRIEF, targetChapters: 9 } } });
    withAi([CLOUD]);
    render(<Page />);
    await screen.findByRole("group", { name: t("autopilot.presets.legend") });
    for (const id of PRESET_IDS) expect(radio(id)).not.toBeChecked();
    const custom = within(book()).getByText(t("autopilot.presets.custom"));
    expect(custom.closest("[aria-hidden]")).toBeNull();
    expect(group()).toHaveAccessibleDescription(new RegExp(t("autopilot.presets.custom").slice(0, 12)));
  });
});

describe("the text fields of the form", () => {
  it("let a keyboard through: Tab moves on from the idea and from the synopsis, where an editor would indent, so that nobody is stuck in the form", async () => {
    await showFresh();
    for (const key of ["idea", "synopsis"]) {
      const area = field(`autopilot.setup.${key}`);
      area.focus();
      type(area, "Line one\nLine two", false);
      area.setSelectionRange(0, area.value.length);
      const before = area.value;
      // `fireEvent` answers false when the page cancelled the key: that is what an indent does, and what a form field must not.
      expect(fireEvent.keyDown(area, { key: "Tab" }), key).toBe(true);
      expect(fireEvent.keyDown(area, { key: "Tab", shiftKey: true }), key).toBe(true);
      expect(area.value, key).toBe(before);
    }
  });
});

describe("the number fields of the form", () => {
  it("stay level in a row, whatever their labels do: where a label takes two lines the field sits at the bottom of its cell, so that no input is lower than its neighbour", async () => {
    await showFresh();
    for (const key of ["chapters", "scenes", "words", "maxReaders", "chaptersPerRun", "budget", "budgetTokens"]) {
      const cell = field(`autopilot.setup.${key}`).parentElement as HTMLElement;
      expect(cell.className, key).toMatch(/\bflex\b/);
      expect(cell.className, key).toMatch(/\bflex-col\b/);
      expect(cell.className, key).toMatch(/\bjustify-between\b/);
      expect(cell.className, key).toMatch(/\bh-full\b/);
    }
  });
});

describe("the sizes and the rules of the page", () => {
  it("are native radio buttons of one group, so that Tab enters the group once and the arrow keys move between the sizes", async () => {
    await showFresh();
    const radios = within(group()).getAllByRole("radio") as HTMLInputElement[];
    expect(new Set(radios.map((choice) => choice.name)).size).toBe(1);
    expect(radios.every((choice) => choice.tagName === "INPUT" && choice.type === "radio")).toBe(true);
    expect(group().tagName).toBe("FIELDSET");
    for (const choice of radios) expect(choice.labels?.length).toBe(1);
    expect(radios.every((choice) => choice.tabIndex >= 0)).toBe(true);
  });

  it("choosing one on a book the autopilot saved changes the form, not the book: nothing is saved before «Save settings»", async () => {
    seedRun({ status: "paused" });
    withAi([CLOUD]);
    render(<Page />);
    await screen.findByRole("group", { name: t("autopilot.presets.legend") });
    fireEvent.click(radio("story"));
    expect(mocks.runtime.configure).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: t("autopilot.setup.save") })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.setup.save") }));
    await waitFor(() => expect(mocks.runtime.configure).toHaveBeenCalledTimes(1));
    const [, saved] = mocks.runtime.configure.mock.calls[0] as unknown as [string, { brief: { targetChapters: number }; options: { maxReaders: number } }];
    expect(saved.brief.targetChapters).toBe(4);
    expect(saved.options.maxReaders).toBe(3);
  });

  it("never rewrite director.md: no preset commits a file of the book, and the review rounds are the director's", async () => {
    await showFresh();
    const store = mocks.local as MemoryBookStore;
    const before = store.files.get("director.md");
    const commit = vi.spyOn(store, "commit");
    for (const id of PRESET_IDS) fireEvent.click(radio(id));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(commit).not.toHaveBeenCalled();
    expect(store.files.get("director.md")).toBe(before);
    expect(mocks.runtime.configure).not.toHaveBeenCalled();
  });

  it("are locked while the autopilot runs, like the numbers they fill", async () => {
    seedRun({ status: "running", running: true, live: { activity: runningStep("write", "Writing scene 2 of chapter 5 «Scene 2»") } });
    withAi([CLOUD]);
    render(<Page />);
    await screen.findByRole("group", { name: t("autopilot.presets.legend") });
    for (const id of PRESET_IDS) expect(radio(id)).toBeDisabled();
  });
});
