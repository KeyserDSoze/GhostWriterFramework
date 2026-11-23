import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AutopilotRuleError, SERVER_FEATURE_AUTOPILOT_CONTROLS, SERVER_FEATURE_AUTOPILOT_RULES, ServerRequestError, serializeOutlineBook, serializeOutlineChapter, type ServerInfo } from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";
import { serializeOutlineBrief } from "@/autopilot/outlineBrief";
import { formatWhole } from "@/autopilot/runEstimateFormat";

const mocks = vi.hoisted(() => ({
  book: null as unknown,
  structure: undefined as unknown,
  runtime: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
  local: null as unknown,
  outlineMissing: false,
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
// The Scaletta is read from the same store the autopilot writes: its brief and its chapter entries.
vi.mock("@/outline/outlineSource", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/outline/outlineSource")>();
  return {
    ...original,
    browserOutlineSource: () => {
      const source = original.storeOutlineSource(mocks.local as never);
      return mocks.outlineMissing ? { ...source, files: async () => { throw new Error("no working copy"); } } : source;
    },
  };
});

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AutopilotSettingsPage } from "@/pages/AutopilotSettingsPage";
import { emptyView, useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { runningStep, seedRun } from "./helpers/autopilotBand";
import { SERVER_INFO } from "./helpers/fakeBookServer";
import { GITHUB_BOOK, LOCAL_BOOK, makeRuntime, seedBar, t } from "./helpers/quickCommands";

const ROOT = "/app/books/book-1";
const SETTINGS = `${ROOT}/autopilot/settings`;
const LIVE = runningStep("write", "Writing scene 2 of chapter 5 «Scene 2»", { chapterNumber: 5, sceneNumber: 2 });
const RULES = ["Keep the tone ironic.", "Never name the ledger before chapter 9."];
const RULES_INFO = { ...SERVER_INFO, serverVersion: "0.1.6", features: [SERVER_FEATURE_AUTOPILOT_CONTROLS, SERVER_FEATURE_AUTOPILOT_RULES] } as ServerInfo;
const IDEA = "A harbor built on glass.";
const SYNOPSIS = "Chapter 1: the wall cracks.\nChapter 2: the council lies.";

function structureOf(patch: Record<string, unknown> = {}) {
  return {
    title: "The Glass Harbor", language: "en", owner: "local", repo: "book-1", defaultBranch: "main", loadedBranch: "main",
    rootFiles: [{ path: "book.md" }, { path: "director.md" }],
    firstClassFiles: [{ path: "evaluation-guidelines.md" }],
    chapters: [{ slug: "001-one", title: "One", paragraphs: [{}] }],
    ghostwriters: [], readerPersonas: [],
    ...patch,
  };
}

/** The Scaletta of the book: its brief, and two chapter entries. */
function scalettaFiles(brief: { idea: string; genre: string; audience: string; wordsPerScene: number; synopsis: string } | null = { idea: IDEA, genre: "mystery", audience: "adults", wordsPerScene: 1400, synopsis: SYNOPSIS }) {
  return {
    ...(brief ? { "outline/book.md": serializeOutlineBook({ body: brief.idea, origin: "author" }), "outline/_brief.md": serializeOutlineBrief({ genre: brief.genre, audience: brief.audience, wordsPerScene: brief.wordsPerScene, synopsis: brief.synopsis }) } : {}),
    "outline/chapters/001.md": serializeOutlineChapter({ number: 1, title: "The wall", origin: "author" }),
    "outline/chapters/002.md": serializeOutlineChapter({ number: 2, title: "The lie", origin: "author" }),
  };
}

function Where() {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.hash}`}</p>;
}

function Page({ path = SETTINGS }: { path?: string }) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app/books/:bookId/autopilot/settings" element={<AutopilotSettingsPage />} />
        <Route path="/app/books/:bookId/autopilot" element={<p>The live page</p>} />
        <Route path="/app/books/:bookId/outline" element={<p>The Scaletta page</p>} />
      </Routes>
      <Where />
    </MemoryRouter>
  );
}

const TABS = ["overview", "review", "retries", "publishing", "rules", "profiles", "danger"] as const;
const tab = (key: string) => screen.getByRole("tab", { name: t(`autopilot.config.tabs.${key}`) });
const choose = (key: string) => fireEvent.click(tab(key));
const panel = (key: string) => document.getElementById(`autopilot-panel-${key}`) as HTMLElement;
const bar = () => document.querySelector<HTMLElement>("[data-autopilot-bar]") as HTMLElement;
const field = (key: string) => screen.getByLabelText(t(key)) as HTMLInputElement;
/** What a person does: the field gets every keystroke, then loses the focus. */
function type(input: HTMLInputElement | HTMLTextAreaElement, text: string) {
  fireEvent.change(input, { target: { value: text } });
  fireEvent.blur(input);
}

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.runtime = {
    ...makeRuntime(),
    configure: vi.fn(async () => undefined),
    reset: vi.fn(async () => undefined),
    updateRule: vi.fn(async () => undefined),
    removeRule: vi.fn(async () => undefined),
  };
  mocks.book = LOCAL_BOOK;
  mocks.structure = structureOf();
  mocks.outlineMissing = false;
  mocks.local = new MemoryBookStore({ "director.md": "---\nname: Ada\n---\nThe vision.\n", ...scalettaFiles() });
  mocks.toast.mockReset();
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false, pageDockOpen: false, dockTab: "live", whereIntent: null, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("the configuration of the autopilot", () => {
  it("is a page of its own with a title, and a way back to what is happening", () => {
    seedRun({ status: "paused" });
    render(<Page />);
    expect(screen.getByRole("heading", { level: 1, name: t("autopilot.config.title") })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: t("nav.autopilotLive") })[0]).toHaveAttribute("href", `${ROOT}/autopilot`);
  });

  it("has its parts as tabs of one tablist, the overview first, and the panel of each is labelled by its tab", () => {
    mocks.book = GITHUB_BOOK;
    seedRun({ book: GITHUB_BOOK, status: "paused" });
    render(<Page />);
    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab");
    expect(tabs.map((element) => element.textContent)).toEqual(TABS.map((key) => t(`autopilot.config.tabs.${key}`)));
    expect(tab("overview")).toHaveAttribute("aria-selected", "true");
    expect(tab("review")).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tabpanel", { name: t("autopilot.config.tabs.overview") })).toBe(panel("overview"));
    expect(screen.getAllByRole("tab", { selected: true })).toHaveLength(1);
  });

  it("moves between the tabs with the arrow keys, Home and End, and only the selected tab is in the tab order", () => {
    seedRun({ status: "paused" });
    render(<Page />);
    tab("overview").focus();
    fireEvent.keyDown(tab("overview"), { key: "ArrowRight" });
    expect(tab("review")).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(tab("review"));
    expect(tab("review")).toHaveAttribute("tabindex", "0");
    expect(tab("overview")).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(tab("review"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tab("overview"));
    fireEvent.keyDown(tab("overview"), { key: "ArrowLeft" });
    expect(document.activeElement, "the first wraps to the last").toBe(tab("danger"));
    fireEvent.keyDown(tab("danger"), { key: "ArrowRight" });
    expect(document.activeElement, "the last wraps to the first").toBe(tab("overview"));
    fireEvent.keyDown(tab("overview"), { key: "End" });
    expect(tab("danger")).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tab("danger"), { key: "Home" });
    expect(tab("overview")).toHaveAttribute("aria-selected", "true");
  });

  it("keeps what was typed in a tab when another tab is shown, and draws only the selected panel", () => {
    seedRun({ status: "paused" });
    render(<Page />);
    choose("review");
    type(field("autopilot.setup.maxReaders"), "7");
    choose("publishing");
    expect(panel("review")).not.toBeVisible();
    choose("review");
    expect(field("autopilot.setup.maxReaders")).toHaveValue(7);
  });

  it("opens the tab that holds a part the link points at: the rules and the estimate", () => {
    seedRun({ status: "paused", statePatch: { constraints: [...RULES] } });
    render(<Page path={`${SETTINGS}#autopilot-rules`} />);
    expect(tab("rules")).toHaveAttribute("aria-selected", "true");
  });
});

describe("the overview of the configuration", () => {
  it("shows the brief and the chapter entries of the Scaletta, read only, with a way to the Scaletta where they are written", async () => {
    seedRun({ status: "paused" });
    render(<Page />);
    const overview = panel("overview");
    await waitFor(() => expect(within(overview).getByText(IDEA)).toBeInTheDocument());
    expect(within(overview).getByText("mystery")).toBeInTheDocument();
    expect(within(overview).getByText("adults")).toBeInTheDocument();
    expect(within(overview).getByText(t("autopilot.config.overview.wordsValue", { words: formatWhole(1400, "en") }))).toBeInTheDocument();
    expect(within(overview).getByText(t("autopilot.config.overview.chaptersValue", { count: 2 }))).toBeInTheDocument();
    expect(within(overview).getByText(/Chapter 1: the wall cracks\./)).toBeInTheDocument();
    expect(within(overview).queryAllByRole("textbox")).toEqual([]);
    expect(within(overview).queryAllByRole("spinbutton")).toEqual([]);
    expect(within(overview).getByRole("link", { name: t("autopilot.config.overview.edit") })).toHaveAttribute("href", `${ROOT}/outline`);
  });

  it("says the expected length as the chapter count and the words per scene, and no total of scenes", async () => {
    seedRun({ status: "paused" });
    render(<Page />);
    await waitFor(() => expect(within(panel("overview")).getByText(t("autopilot.config.overview.length", { count: 2, words: formatWhole(1400, "en") }))).toBeInTheDocument());
  });

  it("says that the Scaletta cannot be read here, and that the autopilot cannot start from this page", async () => {
    mocks.outlineMissing = true;
    seedBar({ noState: true });
    render(<Page />);
    await waitFor(() => expect(within(panel("overview")).getByText(t("autopilot.config.overview.unreadable"))).toBeInTheDocument());
    expect(screen.getByRole("button", { name: t("autopilot.actions.start") })).toBeDisabled();
  });

  it("has no field for chapters, scenes or words anywhere in the configuration", () => {
    seedRun({ status: "paused" });
    render(<Page />);
    for (const id of ["autopilot-chapters", "autopilot-scenes", "autopilot-words", "autopilot-idea", "autopilot-synopsis", "autopilot-book"]) expect(document.getElementById(id), id).toBeNull();
    expect(screen.queryByRole("group", { name: t("autopilot.presets.legend") }), "the sizes are at the creation of a book").not.toBeInTheDocument();
  });
});

describe("the review, the save and the reset", () => {
  it("has how the autopilot reviews the book in Review: the readers, the plan, the specialists, the pauses, the sessions, the budgets and the fill of the Outline", () => {
    seedRun({ status: "paused" });
    render(<Page />);
    choose("review");
    const review = panel("review");
    for (const key of ["readers", "readersOnPlan", "specialists", "pauseAfterPlan", "pauseAfterEachChapter", "fillOutline"]) expect(within(review).getByRole("switch", { name: t(`autopilot.setup.${key}`) }), key).toBeInTheDocument();
    for (const key of ["maxReaders", "chaptersPerRun", "budget", "budgetTokens"]) expect(within(review).getByLabelText(t(`autopilot.setup.${key}`)), key).toBeInTheDocument();
  });

  it("has the save and the reset at the top, in a bar that stays on the screen: «Save» is off until something changed", () => {
    seedRun({ status: "paused" });
    render(<Page />);
    expect(bar()).toBeInTheDocument();
    expect(within(bar()).getByRole("button", { name: t("autopilot.setup.save") })).toBeDisabled();
    expect(within(bar()).getByRole("button", { name: t("autopilot.actions.reset") })).toBeEnabled();
    expect(bar().compareDocumentPosition(panel("overview")) & Node.DOCUMENT_POSITION_FOLLOWING, "before the parts").toBeTruthy();
    expect(bar()).toHaveClass("sticky", "top-0");
  });

  it("saves what the review changed with configure, and the brief of the Scaletta with it, while the autopilot is stopped", async () => {
    seedRun({ status: "paused" });
    render(<Page />);
    await screen.findByText(IDEA);
    choose("review");
    fireEvent.click(screen.getByRole("switch", { name: t("autopilot.setup.specialists") }));
    fireEvent.click(within(bar()).getByRole("button", { name: t("autopilot.setup.save") }));
    await waitFor(() => expect(mocks.runtime.configure).toHaveBeenCalledTimes(1));
    expect(mocks.runtime.configure).toHaveBeenCalledWith("book-1", { brief: expect.objectContaining({ idea: IDEA, genre: "mystery", wordsPerScene: 1400 }), options: expect.objectContaining({ specialists: false }) });
    expect(mocks.runtime.updateOptions).not.toHaveBeenCalled();
    await waitFor(() => expect(within(bar()).getByRole("button", { name: t("autopilot.setup.save") })).toBeDisabled());
  });

  it("resets the autopilot from the bar with the same question as the danger zone, and does nothing when the question is refused", async () => {
    seedRun({ status: "paused" });
    render(<Page />);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(within(bar()).getByRole("button", { name: t("autopilot.actions.reset") }));
    expect(confirm).toHaveBeenCalledWith(t("autopilot.actions.resetConfirm"));
    expect(mocks.runtime.reset).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(within(bar()).getByRole("button", { name: t("autopilot.actions.reset") }));
    await waitFor(() => expect(mocks.runtime.reset).toHaveBeenCalledWith("book-1"));
  });

  it("keeps the save in reach from the bottom of a long tab: the bar is the same element wherever the focus is", () => {
    seedRun({ status: "paused" });
    render(<Page />);
    choose("profiles");
    expect(within(bar()).getByRole("button", { name: t("autopilot.setup.save") })).toBeInTheDocument();
    expect(document.querySelectorAll("[data-autopilot-bar]")).toHaveLength(1);
  });
});

describe("a Scaletta with no chapters", () => {
  const EMPTY = "The Scaletta has no chapters: add them before you start.";
  const emptyScaletta = () => { mocks.local = new MemoryBookStore({ "director.md": "---\nname: Ada\n---\nThe vision.\n", "outline/book.md": serializeOutlineBook({ body: IDEA, origin: "author" }), "outline/_brief.md": serializeOutlineBrief({ genre: "", audience: "", wordsPerScene: 1400, synopsis: "" }) }); };

  it("says why the autopilot cannot start, in the overview with a way to the Scaletta, and the start is off with the same reason", async () => {
    emptyScaletta();
    seedBar({ noState: true });
    render(<Page />);
    await screen.findByText(IDEA);
    const overview = panel("overview");
    expect(within(overview).getByText(EMPTY)).toBeInTheDocument();
    expect(within(overview).getAllByRole("link", { name: t("autopilot.config.overview.edit") })[0]).toHaveAttribute("href", `${ROOT}/outline`);
    const start = within(document.querySelector("[data-autopilot-start]") as HTMLElement).getByRole("button", { name: t("autopilot.actions.start") });
    expect(start).toBeDisabled();
    expect(document.getElementById(start.getAttribute("aria-describedby") ?? "")).toHaveTextContent(EMPTY);
    fireEvent.click(start);
    expect(mocks.runtime.start).not.toHaveBeenCalled();
  });

  it("does not stop a book that has a plan, whose chapters are in the plan: it starts as it did", async () => {
    emptyScaletta();
    seedRun({ status: "paused" });
    render(<Page />);
    await screen.findByText(IDEA);
    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument();
    expect(within(document.querySelector("[data-autopilot-start]") as HTMLElement).getByRole("button", { name: t("autopilot.actions.resume") })).toBeEnabled();
  });

  it("does not stop a book that has entries in its Scaletta", async () => {
    seedBar({ noState: true });
    render(<Page />);
    await screen.findByText(IDEA);
    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument();
    expect(within(document.querySelector("[data-autopilot-start]") as HTMLElement).getByRole("button", { name: t("autopilot.actions.start") })).toBeEnabled();
  });
});

describe("a book created from a size", () => {
  it("starts its first configuration with the review options of that size, and the words per scene of its brief", async () => {
    mocks.book = { ...LOCAL_BOOK, startPreset: "novel-draft" };
    seedBar({ noState: true, book: mocks.book as typeof LOCAL_BOOK });
    render(<Page />);
    await screen.findByText(IDEA);
    choose("review");
    expect(field("autopilot.setup.maxReaders")).toHaveValue(3);
    expect(screen.getByRole("switch", { name: t("autopilot.setup.readersOnPlan") })).toBeChecked();
  });
});

describe("publishing", () => {
  it("is a choice of three for a book on GitHub: every step, every chapter, never", () => {
    mocks.book = GITHUB_BOOK;
    seedRun({ book: GITHUB_BOOK, status: "paused", options: { syncAfterChapter: true } });
    render(<Page />);
    choose("publishing");
    const publish = panel("publishing");
    const choices = within(publish).getAllByRole("radio");
    expect(choices.map((choice) => (choice as HTMLInputElement).labels?.[0]?.textContent?.trim())).toEqual(["step", "chapter", "off"].map((mode) => t(`autopilot.quick.publish.choice.${mode}`)));
    expect(within(publish).getByRole("radio", { name: t("autopilot.quick.publish.choice.chapter") })).toBeChecked();
  });

  it("saves the choice with the settings while the autopilot is stopped, and keeps the older switch in agreement", async () => {
    mocks.book = GITHUB_BOOK;
    seedRun({ book: GITHUB_BOOK, status: "paused", options: { syncAfterChapter: true } });
    render(<Page />);
    await screen.findByText(IDEA);
    choose("publishing");
    fireEvent.click(screen.getByRole("radio", { name: t("autopilot.quick.publish.choice.off") }));
    fireEvent.click(within(bar()).getByRole("button", { name: t("autopilot.setup.save") }));
    await waitFor(() => expect(mocks.runtime.configure).toHaveBeenCalledTimes(1));
    expect(mocks.runtime.configure).toHaveBeenCalledWith("book-1", { brief: expect.anything(), options: expect.objectContaining({ publishEvery: "off", syncAfterChapter: false }) });
  });

  it("shows the choice the author made from the quick commands, not an older switch that says otherwise", () => {
    mocks.book = GITHUB_BOOK;
    seedRun({ book: GITHUB_BOOK, status: "paused", options: { syncAfterChapter: false, publishEvery: "step" } });
    render(<Page />);
    choose("publishing");
    expect(screen.getByRole("radio", { name: t("autopilot.quick.publish.choice.step") })).toBeChecked();
  });

  it("says that a book kept in this browser has nothing to publish", () => {
    seedRun({ status: "paused" });
    render(<Page />);
    choose("publishing");
    expect(within(panel("publishing")).queryAllByRole("radio")).toEqual([]);
    expect(within(panel("publishing")).getByText(t("autopilot.config.publishLocal"))).toBeInTheDocument();
  });
});

describe("while the autopilot runs", () => {
  const running = (book = GITHUB_BOOK) => {
    mocks.book = book;
    seedRun({ book, status: "running", running: true, live: { activity: LIVE }, options: { syncAfterChapter: true } });
  };

  it("locks what cannot change during a run, and says why", () => {
    running();
    render(<Page />);
    expect(screen.getByText(t("autopilot.config.runningNote"))).toBeInTheDocument();
    choose("review");
    for (const key of ["budget", "budgetTokens", "maxReaders"]) expect(field(`autopilot.setup.${key}`), key).toBeDisabled();
    expect(screen.getByRole("switch", { name: t("autopilot.setup.specialists") })).toBeDisabled();
  });

  it("changes where it publishes and the pause after every chapter with updateOptions, and nothing else", async () => {
    running();
    render(<Page />);
    choose("review");
    expect(screen.getByRole("switch", { name: t("autopilot.setup.pauseAfterEachChapter") })).toBeEnabled();
    choose("publishing");
    fireEvent.click(screen.getByRole("radio", { name: t("autopilot.quick.publish.choice.step") }));
    choose("review");
    fireEvent.click(screen.getByRole("switch", { name: t("autopilot.setup.pauseAfterEachChapter") }));
    fireEvent.click(within(bar()).getByRole("button", { name: t("autopilot.setup.save") }));
    await waitFor(() => expect(mocks.runtime.updateOptions).toHaveBeenCalledTimes(1));
    expect(mocks.runtime.updateOptions).toHaveBeenCalledWith("book-1", { publishEvery: "step", pauseAfterEachChapter: true });
    expect(mocks.runtime.configure).not.toHaveBeenCalled();
  });

  it("has no danger zone, and no button to start: the way to follow the run instead", () => {
    running();
    render(<Page />);
    expect(screen.queryByRole("tab", { name: t("autopilot.config.tabs.danger") })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("autopilot.actions.resume") })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("autopilot.config.followLive") })).toHaveAttribute("href", `${ROOT}/autopilot`);
  });

  it("sends nothing when what can change during a run is back as it was: a server refuses an empty change", async () => {
    running();
    render(<Page />);
    choose("review");
    const pause = screen.getByRole("switch", { name: t("autopilot.setup.pauseAfterEachChapter") });
    fireEvent.click(pause);
    fireEvent.click(pause);
    fireEvent.click(within(bar()).getByRole("button", { name: t("autopilot.setup.save") }));
    await waitFor(() => expect(within(bar()).getByRole("button", { name: t("autopilot.setup.save") })).toBeDisabled());
    expect(mocks.runtime.updateOptions).not.toHaveBeenCalled();
  });

  it("changes nothing during a run on a personal server that predates it, and says to update it", () => {
    const book = { ...LOCAL_BOOK, autopilotHost: "server" as const };
    mocks.book = book;
    seedRun({ book, status: "running", running: true, live: { activity: LIVE }, server: "old" });
    render(<Page />);
    expect(screen.getByText(t("autopilot.errors.controlsUnsupported", { version: "0.1.5" }))).toBeInTheDocument();
    choose("review");
    expect(screen.getByRole("switch", { name: t("autopilot.setup.pauseAfterEachChapter") })).toBeDisabled();
  });
});

describe("the permanent rules", () => {
  const withRules = (patch: Parameters<typeof seedRun>[0] = {}) => seedRun({ status: "paused", statePatch: { constraints: [...RULES] }, ...patch });
  const rules = () => { choose("rules"); return panel("rules"); };
  const edit = (number: number) => within(rules()).getByRole("button", { name: t("autopilot.config.rules.editNamed", { number }) });
  const remove = (number: number) => within(rules()).getByRole("button", { name: t("autopilot.config.rules.removeNamed", { number }) });
  const editor = (number: number) => within(rules()).getByRole("textbox", { name: t("autopilot.config.rules.rule", { number }) }) as HTMLTextAreaElement;

  it("are listed, each with a way to change it and to remove it", () => {
    withRules();
    render(<Page />);
    const items = within(rules()).getAllByRole("listitem");
    expect(items.map((item) => item.querySelector("[data-rule-text]")?.textContent)).toEqual(RULES);
    expect(edit(1)).toHaveTextContent(t("autopilot.config.rules.edit"));
    expect(remove(2)).toHaveTextContent(t("autopilot.config.rules.remove"));
  });

  it("are changed with the text the author saw as the guard, and the focus goes back to the rule", async () => {
    withRules();
    render(<Page />);
    fireEvent.click(edit(2));
    expect(editor(2)).toHaveValue(RULES[1]);
    expect(document.activeElement).toBe(editor(2));
    fireEvent.change(editor(2), { target: { value: "Never name the ledger before chapter 10." } });
    fireEvent.click(within(rules()).getByRole("button", { name: t("autopilot.config.rules.save") }));
    await waitFor(() => expect(mocks.runtime.updateRule).toHaveBeenCalledWith("book-1", 1, "Never name the ledger before chapter 10.", RULES[1]));
    await waitFor(() => expect(document.activeElement).toBe(edit(2)));
  });

  it("are removed after a question, with the same guard", async () => {
    withRules();
    render(<Page />);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(remove(1));
    expect(confirm).toHaveBeenCalledWith(t("autopilot.config.rules.removeConfirm"));
    expect(mocks.runtime.removeRule).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(remove(1));
    await waitFor(() => expect(mocks.runtime.removeRule).toHaveBeenCalledWith("book-1", 0, RULES[0]));
  });

  it("count the characters and never send a rule over the limit, or an empty one", () => {
    withRules();
    render(<Page />);
    fireEvent.click(edit(1));
    fireEvent.change(editor(1), { target: { value: "x".repeat(801) } });
    expect(editor(1)).toHaveAccessibleDescription(new RegExp("801"));
    expect(within(rules()).getByRole("button", { name: t("autopilot.config.rules.save") })).toBeDisabled();
    fireEvent.change(editor(1), { target: { value: "   " } });
    expect(within(rules()).getByRole("button", { name: t("autopilot.config.rules.save") })).toBeDisabled();
  });

  it.each([
    ["rule_changed", new AutopilotRuleError("rule_changed", "The rule changed in the meantime: reload the rules and try again."), true],
    ["rule_not_found", new ServerRequestError("There is no rule number 2.", 404, "rule_not_found"), true],
    ["rule_too_long", new ServerRequestError("The rule is 900 characters long.", 400, "rule_too_long"), false],
    ["rule_duplicate", new AutopilotRuleError("rule_duplicate", "Another rule already says this."), false],
  ] as const)("say in the author's words why a rule was refused (%s), and read the rules again when they changed", async (code, error, reloads) => {
    withRules();
    mocks.runtime.updateRule.mockRejectedValueOnce(error);
    render(<Page />);
    fireEvent.click(edit(2));
    fireEvent.change(editor(2), { target: { value: "Keep the tone ironic." } });
    fireEvent.click(within(rules()).getByRole("button", { name: t("autopilot.config.rules.save") }));
    const alert = await within(rules()).findByRole("alert");
    expect(alert).toHaveTextContent(t(`autopilot.config.rules.errors.${code}`, { max: 800 }));
    expect(mocks.toast).not.toHaveBeenCalled();
    if (reloads) {
      await waitFor(() => expect(mocks.runtime.refresh).toHaveBeenCalledWith("book-1"));
      expect(within(rules()).queryByRole("textbox")).not.toBeInTheDocument();
    } else {
      expect(editor(2), "the author keeps what they wrote, to correct it").toHaveValue("Keep the tone ironic.");
    }
  });

  it("can be changed on a personal server that knows how", () => {
    const book = { ...LOCAL_BOOK, autopilotHost: "server" as const };
    mocks.book = book;
    withRules({ book, server: "online" });
    useAutopilotStore.setState((state) => ({ server: { ...state.server, info: RULES_INFO } }));
    render(<Page />);
    expect(edit(1)).toBeEnabled();
  });

  it("are only read on a personal server that cannot change them yet, which the page says to update", () => {
    const book = { ...LOCAL_BOOK, autopilotHost: "server" as const };
    mocks.book = book;
    withRules({ book, server: "online" });
    render(<Page />);
    expect(within(rules()).getByText(RULES[0])).toBeInTheDocument();
    expect(within(rules()).queryByRole("button", { name: /Edit|Remove/ })).not.toBeInTheDocument();
    const note = within(rules()).getByText(new RegExp(t("autopilot.config.rules.oldServer", { version: "0.1.6" }).slice(0, 40)));
    expect(note).toHaveTextContent("0.1.6");
    expect(within(rules()).getByRole("link", { name: t("personalServer.title") })).toHaveAttribute("href", "/app/settings/server");
  });

  it("say how to give one when there are none", () => {
    seedRun({ status: "paused" });
    render(<Page />);
    choose("rules");
    expect(within(panel("rules")).getByText(t("autopilot.config.rules.empty"))).toBeInTheDocument();
    expect(within(panel("rules")).getByRole("link", { name: t("autopilot.config.rules.openLive") })).toHaveAttribute("href", `${ROOT}/autopilot`);
  });
});

describe("the profiles used", () => {
  const profiles = () => { choose("profiles"); return panel("profiles"); };
  const row = (key: string) => within(profiles()).getByRole("link", { name: t(key) }).closest("li") as HTMLElement;
  const status = (key: string) => row(key).querySelector("[data-profile-status]")?.getAttribute("data-profile-status");

  it("lead to the director, the ghostwriters, the evaluation style and the simulated readers, with the state of each", async () => {
    seedRun({ status: "paused" });
    render(<Page />);
    const links = within(profiles()).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([`${ROOT}/director`, `${ROOT}/ghostwriters`, `${ROOT}/evaluation-style`, `${ROOT}/simulated-readers`]);
    await waitFor(() => expect(status("director.title")).toBe("present"));
    expect(within(row("director.title")).getByText(t("autopilot.config.profiles.status.present"))).toBeInTheDocument();
    expect(status("ghostwriters.title")).toBe("default");
    expect(within(row("ghostwriters.title")).getByText(t("autopilot.config.profiles.status.default"))).toBeInTheDocument();
    expect(status("evaluationStyle.title")).toBe("present");
    expect(status("readerPersonas.title")).toBe("default");
  });

  it("say which profile has problems: the ones the engine stopped for, and a file it cannot read as it is written", async () => {
    mocks.structure = structureOf({ readerPersonas: [{ slug: "ada", path: "personas/ada.md", name: "Ada" }] });
    mocks.local = new MemoryBookStore({ "director.md": "---\nname: Ada\nstrictness: lots\n---\nThe vision.\n", "personas/ada.md": "---\nname: Ada\n---\nA reader.\n", ...scalettaFiles() });
    seedRun({ status: "waiting-author", message: "Correct these profiles before resuming: personas/ada.md: the frontmatter is not valid YAML (line 2: bad): correct the file." });
    render(<Page />);
    await waitFor(() => expect(status("director.title")).toBe("problems"));
    expect(within(row("director.title")).getByText(t("autopilot.config.profiles.status.problems"))).toBeInTheDocument();
    expect(status("readerPersonas.title")).toBe("problems");
    expect(status("ghostwriters.title")).toBe("default");
  });
});

describe("the danger zone", () => {
  it("asks before it resets the autopilot", async () => {
    seedRun({ status: "paused" });
    render(<Page />);
    choose("danger");
    const zone = panel("danger");
    expect(within(zone).getByText(t("autopilot.danger.description"))).toBeInTheDocument();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(within(zone).getByRole("button", { name: t("autopilot.actions.reset") }));
    expect(confirm).toHaveBeenCalledWith(t("autopilot.actions.resetConfirm"));
    expect(mocks.runtime.reset).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(within(zone).getByRole("button", { name: t("autopilot.actions.reset") }));
    await waitFor(() => expect(mocks.runtime.reset).toHaveBeenCalledWith("book-1"));
  });
});

describe("the button at the bottom", () => {
  const bottom = () => document.querySelector<HTMLElement>("[data-autopilot-start]") as HTMLElement;

  it("starts a book that never started with the brief of the Scaletta, and opens the live page", async () => {
    seedBar({ noState: true });
    render(<Page />);
    await screen.findByText(IDEA);
    expect(bottom().compareDocumentPosition(document.querySelector("[role=tablist]") as Node) & Node.DOCUMENT_POSITION_PRECEDING, "after the parts").toBeTruthy();
    fireEvent.click(within(bottom()).getByRole("button", { name: t("autopilot.actions.start") }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith("book-1", { brief: expect.objectContaining({ idea: IDEA }), options: expect.anything() }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`${ROOT}/autopilot`));
    expect(await screen.findByText("The live page")).toBeInTheDocument();
  });

  it("resumes a book that is stopped, saving what was changed first, and opens the live page", async () => {
    seedRun({ status: "paused" });
    render(<Page />);
    await screen.findByText(IDEA);
    choose("review");
    type(field("autopilot.setup.maxReaders"), "4");
    fireEvent.click(within(bottom()).getByRole("button", { name: t("autopilot.actions.resume") }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith("book-1"));
    expect(mocks.runtime.configure).toHaveBeenCalledWith("book-1", { brief: expect.objectContaining({ idea: IDEA }), options: expect.objectContaining({ maxReaders: 4 }) });
    expect(mocks.runtime.configure.mock.invocationCallOrder[0]).toBeLessThan(mocks.runtime.start.mock.invocationCallOrder[0]);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`${ROOT}/autopilot`));
  });

  it("does not leave the page when the start fails, so that nothing that was written is lost", async () => {
    seedBar({ noState: true });
    mocks.runtime.start.mockRejectedValueOnce(new Error("No AI model."));
    render(<Page />);
    await screen.findByText(IDEA);
    choose("review");
    type(field("autopilot.setup.maxReaders"), "4");
    fireEvent.click(within(bottom()).getByRole("button", { name: t("autopilot.actions.start") }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalled());
    expect(screen.getByTestId("location")).toHaveTextContent(SETTINGS);
    expect(field("autopilot.setup.maxReaders")).toHaveValue(4);
  });
});

it("does not offer to start a book whose autopilot could not be read (the server cannot be reached): it says why instead", () => {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [LOCAL_BOOK], aiIntegrations: [{ id: "ai-1" } as never] } });
  useAutopilotStore.setState({ views: { "book-1": { ...emptyView("book-1"), error: "Your personal server is not reachable right now." } } });
  render(<Page />);
  expect(screen.getByText("Your personal server is not reachable right now.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: t("autopilot.actions.start") })).not.toBeInTheDocument();
  expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
});

it("is in Italian when the app is", async () => {
  await i18n.changeLanguage("it");
  mocks.book = GITHUB_BOOK;
  seedRun({ book: GITHUB_BOOK, status: "paused" });
  render(<Page />);
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Configurazione dell'autopilot");
  expect(within(screen.getByRole("tablist")).getAllByRole("tab").map((element) => element.textContent)).toEqual(["Panoramica", "Revisione", "Nuovi tentativi", "Pubblicazione", "Regole", "Profili", "Zona pericolosa"]);
  expect(screen.getAllByRole("link", { name: "In diretta" })[0]).toBeInTheDocument();
  expect(within(bar()).getByRole("button", { name: "Salva" })).toBeInTheDocument();
  expect(within(bar()).getByRole("button", { name: "Azzera" })).toBeInTheDocument();
});

void act;
