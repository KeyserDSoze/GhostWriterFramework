import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AutopilotRuleError, SERVER_FEATURE_AUTOPILOT_CONTROLS, SERVER_FEATURE_AUTOPILOT_RULES, ServerRequestError, type ServerInfo } from "narrarium-engine";
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
      </Routes>
      <Where />
    </MemoryRouter>
  );
}

const region = (key: string) => screen.getByRole("region", { name: t(key) });
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
  mocks.local = new MemoryBookStore({ "director.md": "---\nname: Ada\n---\nThe vision.\n" });
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
    expect(screen.getByRole("link", { name: t("nav.autopilotLive") })).toHaveAttribute("href", `${ROOT}/autopilot`);
  });

  it("has its sections, each with its title, in order: the book, the review, publishing, the rules, the profiles, the danger zone", () => {
    mocks.book = GITHUB_BOOK;
    seedRun({ book: GITHUB_BOOK, status: "paused" });
    render(<Page />);
    const titles = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent?.trim());
    expect(titles).toEqual([
      t("autopilot.config.sections.book"),
      t("autopilot.config.sections.review"),
      t("autopilot.config.sections.publish"),
      t("autopilot.config.sections.rules"),
      t("autopilot.config.sections.profiles"),
      t("autopilot.danger.title"),
    ]);
  });

  it("has the brief in The book, the synopsis with the way to the Outline that takes its place, and the switch that fills the Outline", () => {
    seedRun({ status: "paused" });
    render(<Page />);
    const book = region("autopilot.config.sections.book");
    for (const key of ["idea", "chapters", "scenes", "words", "genre", "audience", "synopsis"]) expect(within(book).getByLabelText(t(`autopilot.setup.${key}`)), key).toBeInTheDocument();
    expect(within(book).getByLabelText(t("autopilot.setup.synopsis"))).toHaveAccessibleDescription(new RegExp(t("autopilot.setup.synopsisOutline").slice(0, 30)));
    expect(within(book).getByRole("link", { name: t("autopilot.setup.useOutline") })).toHaveAttribute("href", `${ROOT}/outline`);
    expect(within(book).getByRole("switch", { name: t("autopilot.setup.fillOutline") })).toBeChecked();
  });

  it("has how the autopilot reviews the book in Review: the readers and how many, the plan, the specialists, the pauses, the sessions and the two budgets", () => {
    seedRun({ status: "paused" });
    render(<Page />);
    const review = region("autopilot.config.sections.review");
    for (const key of ["readers", "readersOnPlan", "specialists", "pauseAfterPlan", "pauseAfterEachChapter"]) expect(within(review).getByRole("switch", { name: t(`autopilot.setup.${key}`) }), key).toBeInTheDocument();
    for (const key of ["maxReaders", "chaptersPerRun", "budget", "budgetTokens"]) expect(within(review).getByLabelText(t(`autopilot.setup.${key}`)), key).toBeInTheDocument();
  });

  it("saves the brief and the settings together with configure while the autopilot is stopped", async () => {
    seedRun({ status: "paused" });
    render(<Page />);
    type(field("autopilot.setup.chapters"), "14");
    fireEvent.click(screen.getByRole("switch", { name: t("autopilot.setup.specialists") }));
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.setup.save") }));
    await waitFor(() => expect(mocks.runtime.configure).toHaveBeenCalledTimes(1));
    expect(mocks.runtime.configure).toHaveBeenCalledWith("book-1", { brief: expect.objectContaining({ targetChapters: 14 }), options: expect.objectContaining({ specialists: false }) });
    expect(mocks.runtime.updateOptions).not.toHaveBeenCalled();
  });

  describe("publishing", () => {
    it("is a choice of three for a book on GitHub: every step, every chapter, never", () => {
      mocks.book = GITHUB_BOOK;
      seedRun({ book: GITHUB_BOOK, status: "paused", options: { syncAfterChapter: true } });
      render(<Page />);
      const publish = region("autopilot.config.sections.publish");
      const choices = within(publish).getAllByRole("radio");
      expect(choices.map((choice) => (choice as HTMLInputElement).labels?.[0]?.textContent?.trim())).toEqual(["step", "chapter", "off"].map((mode) => t(`autopilot.quick.publish.choice.${mode}`)));
      // The book publishes every chapter today, as the older switch said.
      expect(within(publish).getByRole("radio", { name: t("autopilot.quick.publish.choice.chapter") })).toBeChecked();
    });

    it("saves the choice with the settings while the autopilot is stopped, and keeps the older switch in agreement", async () => {
      mocks.book = GITHUB_BOOK;
      seedRun({ book: GITHUB_BOOK, status: "paused", options: { syncAfterChapter: true } });
      render(<Page />);
      fireEvent.click(screen.getByRole("radio", { name: t("autopilot.quick.publish.choice.off") }));
      fireEvent.click(screen.getByRole("button", { name: t("autopilot.setup.save") }));
      await waitFor(() => expect(mocks.runtime.configure).toHaveBeenCalledTimes(1));
      expect(mocks.runtime.configure).toHaveBeenCalledWith("book-1", { brief: expect.anything(), options: expect.objectContaining({ publishEvery: "off", syncAfterChapter: false }) });
    });

    it("shows the choice the author made from the quick commands, not an older switch that says otherwise", () => {
      mocks.book = GITHUB_BOOK;
      seedRun({ book: GITHUB_BOOK, status: "paused", options: { syncAfterChapter: false, publishEvery: "step" } });
      render(<Page />);
      expect(screen.getByRole("radio", { name: t("autopilot.quick.publish.choice.step") })).toBeChecked();
    });

    it("says that a book kept in this browser has nothing to publish", () => {
      seedRun({ status: "paused" });
      render(<Page />);
      const publish = region("autopilot.config.sections.publish");
      expect(within(publish).queryAllByRole("radio")).toEqual([]);
      expect(within(publish).getByText(t("autopilot.config.publishLocal"))).toBeInTheDocument();
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
      for (const key of ["idea", "chapters", "budget", "budgetTokens"]) expect(field(`autopilot.setup.${key}`), key).toBeDisabled();
      expect(screen.getByRole("switch", { name: t("autopilot.setup.specialists") })).toBeDisabled();
    });

    it("changes where it publishes and the pause after every chapter with updateOptions, and nothing else", async () => {
      running();
      render(<Page />);
      expect(screen.getByRole("switch", { name: t("autopilot.setup.pauseAfterEachChapter") })).toBeEnabled();
      fireEvent.click(screen.getByRole("radio", { name: t("autopilot.quick.publish.choice.step") }));
      fireEvent.click(screen.getByRole("switch", { name: t("autopilot.setup.pauseAfterEachChapter") }));
      fireEvent.click(screen.getByRole("button", { name: t("autopilot.setup.save") }));
      await waitFor(() => expect(mocks.runtime.updateOptions).toHaveBeenCalledTimes(1));
      expect(mocks.runtime.updateOptions).toHaveBeenCalledWith("book-1", { publishEvery: "step", pauseAfterEachChapter: true });
      expect(mocks.runtime.configure).not.toHaveBeenCalled();
    });

    it("has no danger zone, and no button to start: the way to follow the run instead", () => {
      running();
      render(<Page />);
      expect(screen.queryByRole("region", { name: t("autopilot.danger.title") })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: t("autopilot.actions.resume") })).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: t("autopilot.config.followLive") })).toHaveAttribute("href", `${ROOT}/autopilot`);
    });

    it("sends nothing when what can change during a run is back as it was: a server refuses an empty change", async () => {
      running();
      render(<Page />);
      const pause = screen.getByRole("switch", { name: t("autopilot.setup.pauseAfterEachChapter") });
      fireEvent.click(pause);
      fireEvent.click(pause);
      fireEvent.click(screen.getByRole("button", { name: t("autopilot.setup.save") }));
      await waitFor(() => expect(screen.getByRole("button", { name: t("autopilot.setup.save") })).toBeDisabled());
      expect(mocks.runtime.updateOptions).not.toHaveBeenCalled();
    });

    it("changes nothing during a run on a personal server that predates it, and says to update it", () => {
      const book = { ...LOCAL_BOOK, autopilotHost: "server" as const };
      mocks.book = book;
      seedRun({ book, status: "running", running: true, live: { activity: LIVE }, server: "old" });
      render(<Page />);
      expect(screen.getByText(t("autopilot.errors.controlsUnsupported", { version: "0.1.5" }))).toBeInTheDocument();
      expect(screen.getByRole("switch", { name: t("autopilot.setup.pauseAfterEachChapter") })).toBeDisabled();
    });
  });

  describe("the permanent rules", () => {
    const withRules = (patch: Parameters<typeof seedRun>[0] = {}) => seedRun({ status: "paused", statePatch: { constraints: [...RULES] }, ...patch });
    const rules = () => region("autopilot.config.sections.rules");
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
      expect(within(rules()).getByText(t("autopilot.config.rules.empty"))).toBeInTheDocument();
      expect(within(rules()).getByRole("link", { name: t("autopilot.config.rules.openLive") })).toHaveAttribute("href", `${ROOT}/autopilot`);
    });
  });

  describe("the profiles used", () => {
    const profiles = () => region("autopilot.config.sections.profiles");
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
      mocks.local = new MemoryBookStore({ "director.md": "---\nname: Ada\nstrictness: lots\n---\nThe vision.\n", "personas/ada.md": "---\nname: Ada\n---\nA reader.\n" });
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
      const zone = region("autopilot.danger.title");
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

    it("starts a book that never started with what the form says, and opens the live page", async () => {
      seedBar({ noState: true });
      render(<Page />);
      type(field("autopilot.setup.idea") as unknown as HTMLInputElement, "A harbor built on glass.");
      type(field("autopilot.setup.chapters"), "20");
      const start = within(bottom()).getByRole("button", { name: t("autopilot.actions.start") });
      expect(bottom().compareDocumentPosition(region("autopilot.config.sections.profiles")) & Node.DOCUMENT_POSITION_PRECEDING, "at the bottom of the page").toBeTruthy();
      fireEvent.click(start);
      await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith("book-1", { brief: expect.objectContaining({ idea: "A harbor built on glass.", targetChapters: 20 }), options: expect.anything() }));
      await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`${ROOT}/autopilot`));
      expect(await screen.findByText("The live page")).toBeInTheDocument();
    });

    it("resumes a book that is stopped, saving what was changed first, and opens the live page", async () => {
      seedRun({ status: "paused" });
      render(<Page />);
      type(field("autopilot.setup.chapters"), "15");
      fireEvent.click(within(bottom()).getByRole("button", { name: t("autopilot.actions.resume") }));
      await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith("book-1"));
      expect(mocks.runtime.configure).toHaveBeenCalledWith("book-1", { brief: expect.objectContaining({ targetChapters: 15 }), options: expect.anything() });
      expect(mocks.runtime.configure.mock.invocationCallOrder[0]).toBeLessThan(mocks.runtime.start.mock.invocationCallOrder[0]);
      await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`${ROOT}/autopilot`));
    });

    it("does not leave the page when the start fails, so that nothing that was written is lost", async () => {
      seedBar({ noState: true });
      mocks.runtime.start.mockRejectedValueOnce(new Error("No AI model."));
      render(<Page />);
      type(field("autopilot.setup.idea") as unknown as HTMLInputElement, "A harbor built on glass.");
      fireEvent.click(within(bottom()).getByRole("button", { name: t("autopilot.actions.start") }));
      await waitFor(() => expect(mocks.toast).toHaveBeenCalled());
      expect(screen.getByTestId("location")).toHaveTextContent(SETTINGS);
      expect(field("autopilot.setup.idea")).toHaveValue("A harbor built on glass.");
    });
  });

  it("does not offer to start a book whose autopilot could not be read (the server cannot be reached): it says why instead", () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [LOCAL_BOOK], aiIntegrations: [{ id: "ai-1" } as never] } });
    useAutopilotStore.setState({ views: { "book-1": { ...emptyView("book-1"), error: "Your personal server is not reachable right now." } } });
    render(<Page />);
    expect(screen.getByText("Your personal server is not reachable right now.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("autopilot.actions.start") })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(t("autopilot.setup.idea"))).not.toBeInTheDocument();
  });

  it("puts the number of chapters in front of the author when a link asks for it", async () => {
    seedRun({ status: "completed", phase: "completed", statePatch: { finalDone: true } });
    render(<Page path={`${SETTINGS}#autopilot-chapters`} />);
    await waitFor(() => expect(document.activeElement).toBe(field("autopilot.setup.chapters")));
  });

  it("is in Italian when the app is", async () => {
    await i18n.changeLanguage("it");
    mocks.book = GITHUB_BOOK;
    seedRun({ book: GITHUB_BOOK, status: "paused" });
    render(<Page />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Configurazione dell'autopilot");
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent?.trim())).toEqual(["Il libro", "Revisione", "Pubblicazione", "Regole permanenti", "Profili usati", "Zona pericolosa"]);
    expect(screen.getByRole("link", { name: "In diretta" })).toBeInTheDocument();
  });
});

void act;
