import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerBookSummary } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ book: null as unknown, runtime: null as unknown as ReturnType<typeof import("./helpers/quickCommands").makeRuntime>, toast: vi.fn(), save: vi.fn(async () => true) }));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: undefined, loading: false, error: undefined, reload: vi.fn() }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: mocks.save }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AutopilotDock } from "@/components/autopilot/AutopilotDock";
import { AutopilotLauncher } from "@/components/autopilot/AutopilotLauncher";
import { AutopilotPage, WhereCard } from "@/pages/AutopilotPage";
import { SetupCard } from "@/components/autopilot/config/SetupCard";
import { emptyView, useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { CONNECTION, GITHUB_BOOK, LOCAL_BOOK, makeRuntime, namedControls, openMenu, quickGroupName, quickName, seedBar, t } from "./helpers/quickCommands";

const OTHER: BookEntry = { ...LOCAL_BOOK, id: "book-2", repo: "book-2", name: "The Second Book" };

// With the panel: it hides itself on the page of the autopilot, so the author brings it back with its small button, and then both are on the screen.
function Page({ path = "/app/books/book-1/autopilot", withDock = false }: { path?: string; withDock?: boolean }) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/app/books/:bookId/autopilot" element={<AutopilotPage />} /></Routes>
      {withDock && <><AutopilotLauncher /><AutopilotDock /></>}
    </MemoryRouter>
  );
}

const bringBackTheDock = () => fireEvent.click(screen.getByRole("button", { name: t("autopilot.openDock") }));

// The live panel is looked at on the page of the book: on the pages of the autopilot it keeps out of the way.
function Dock({ path = "/app/books/book-1" }: { path?: string }) {
  return <MemoryRouter initialEntries={[path]}><AutopilotDock /></MemoryRouter>;
}

const groups = () => [...document.querySelectorAll<HTMLElement>("[data-quick-commands]")];
const controlNames = (root: HTMLElement) => [...root.querySelectorAll("button, a[href]")].map((element) => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "");

beforeAll(async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  await loadAutopilotTranslations();
});
afterAll(() => vi.unstubAllGlobals());

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.runtime = makeRuntime();
  mocks.toast.mockReset();
  mocks.save.mockClear();
  mocks.book = LOCAL_BOOK;
});

afterEach(async () => {
  cleanup();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false, pageDockOpen: false, dockTab: "live", dockFocusBook: null, whereIntent: null, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("the autopilot page", () => {
  it("keeps the Director and Refresh in its header, and puts the bar of quick commands where Pause, Stop and Resume were", () => {
    seedBar({ status: "running", running: true });
    render(<Page />);
    expect(screen.getByRole("link", { name: t("autopilot.actions.director") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("autopilot.actions.refresh") })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: quickGroupName() })).toBeInTheDocument();
    // The bar is the only place of the commands: no second Pause or Stop with the old names.
    expect(screen.queryByRole("button", { name: t("autopilot.actions.pause") })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("autopilot.actions.stop") })).not.toBeInTheDocument();
    const header = screen.getByRole("heading", { level: 1 }).closest("div")!.parentElement!;
    expect(within(header).queryByRole("button", { name: /^Pause|^Stop|^Resume/ })).not.toBeInTheDocument();
  });

  it("is told, in the same words in Italian, what each command does", async () => {
    await i18n.changeLanguage("it");
    seedBar({ status: "running", running: true });
    render(<Page />);
    expect(screen.getByRole("button", { name: "Pausa dopo questo passo — The Glass Harbor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ferma subito — The Glass Harbor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Altri modi di mettere in pausa — The Glass Harbor" })).toBeInTheDocument();
  });

  // Changed on purpose (the menu in groups): the form to start is in the configuration, and the live page leads there.
  it("shows nothing of the bar for a book that never started, and the way to the configuration, where it starts", () => {
    seedBar({ noState: true });
    render(<Page />);
    expect(screen.queryByRole("group", { name: quickGroupName() })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("autopilot.live.configure") })).toHaveAttribute("href", "/app/books/book-1/autopilot/settings");
  });

  it("brings the card it is linked to into view and gives it the focus: the question, or “Where it runs”", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    try {
      seedBar({ status: "waiting-author", question: { id: "q-1", kind: "plan-approval", question: "Approve this plan?", context: "", options: [], askedAt: "2026-11-21T10:00:00.000Z" } });
      const view = render(<Page path="/app/books/book-1/autopilot#autopilot-question" />);
      await waitFor(() => expect(document.activeElement?.id).toBe("autopilot-question"));
      expect(scroll).toHaveBeenCalled();
      view.unmount();

      seedBar({ status: "paused", server: "online" });
      render(<Page path="/app/books/book-1/autopilot#autopilot-where" />);
      await waitFor(() => expect(document.activeElement?.id).toBe("autopilot-where"));
      // What takes the focus has a name, so that a screen reader says where it is.
      expect(document.activeElement).toHaveAccessibleName(t("autopilot.where.title"));
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("opens the flow of “Where it runs” with the side the quick command asked for, and forgets the request", async () => {
    seedBar({ status: "paused", server: "online" });
    render(<MemoryRouter><WhereCard book={LOCAL_BOOK} running={false} /></MemoryRouter>);
    expect(screen.getByRole("radio", { name: t("autopilot.where.server") })).toHaveAttribute("aria-checked", "false");
    act(() => useAutopilotStore.getState().setWhereIntent({ bookId: "book-1", side: "server", at: Date.now() }));
    await waitFor(() => expect(screen.getByRole("radio", { name: t("autopilot.where.server") })).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByRole("button", { name: t("autopilot.where.move") })).toBeEnabled();
    expect(useAutopilotStore.getState().whereIntent).toBeNull();
  });

  it("does not open the flow of another book", () => {
    seedBar({ status: "paused", server: "online" });
    useAutopilotStore.setState({ whereIntent: { bookId: "book-2", side: "server", at: Date.now() } });
    render(<MemoryRouter><WhereCard book={LOCAL_BOOK} running={false} /></MemoryRouter>);
    expect(screen.getByRole("radio", { name: t("autopilot.where.server") })).toHaveAttribute("aria-checked", "false");
    expect(useAutopilotStore.getState().whereIntent).not.toBeNull();
  });
});

describe("the live panel, tab “This book”", () => {
  it("puts the bar where the buttons were, writes the name of the book once, and keeps the link to the page", () => {
    seedBar({ status: "running", running: true, dockOpen: true });
    render(<Dock />);
    const bar = screen.getByRole("group", { name: quickGroupName("dock") });
    expect(within(bar).getByRole("button", { name: quickName(t("autopilot.actions.pause"), "dock") })).toBeEnabled();
    expect(screen.getAllByText(LOCAL_BOOK.name)).toHaveLength(1);
    // One way to the page, in the header of the panel: the mini-player does not repeat it.
    expect(screen.getAllByRole("link", { name: t("autopilot.openPage") }).map((link) => link.getAttribute("href"))).toEqual(["/app/books/book-1/autopilot"]);
    expect(screen.queryByRole("button", { name: t("autopilot.actions.pause") })).not.toBeInTheDocument();
  });

  it("starts from the page for a book that never started, as before: there is no bar to command", () => {
    seedBar({ noState: true, dockOpen: true });
    render(<Dock />);
    expect(screen.queryByRole("group", { name: quickGroupName("dock") })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("autopilot.actions.start") })).toBeInTheDocument();
  });
});

describe("the live panel, tab “Live”", () => {
  beforeEach(() => {
    seedBar({ status: "running", running: true, dockOpen: true });
    useAutopilotStore.setState({ dockTab: "live" });
  });

  it("shows the commands of the book in focus above the feed when the author is not in a book, with the name of the book on them", () => {
    render(<Dock path="/app/books" />);
    const panel = screen.getByRole("region", { name: t("autopilot.dockTitle") });
    const bar = screen.getByRole("group", { name: quickGroupName("dock") });
    // The name is written on top of the mini-player, and in the name of every control of the bar.
    expect(within(panel).getByText(LOCAL_BOOK.name)).toBeVisible();
    expect(within(bar).getByRole("button", { name: quickName(t("autopilot.actions.stop"), "dock") })).toBeEnabled();
    expect(bar.compareDocumentPosition(screen.getByText(t("autopilot.feedEmpty")))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // One book to command: nothing to choose.
    expect(screen.queryByRole("button", { name: /^Book:|^Libro:/ })).not.toBeInTheDocument();
  });

  it("has no bar in the feed of a book's page: the bar is in the other tab, and the feed is only the feed", () => {
    render(<Dock />);
    expect(document.querySelectorAll("[data-quick-commands]")).toHaveLength(0);
    expect(screen.getByText(t("autopilot.feedEmpty"))).toBeInTheDocument();
  });

  it("shows no bar, and the feed as it always was, when no book is in focus", () => {
    useAutopilotStore.setState({ views: {}, summaries: {}, feed: [] });
    render(<Dock path="/app/books" />);
    expect(document.querySelectorAll("[data-quick-commands]")).toHaveLength(0);
    expect(screen.getByText(t("autopilot.feedEmpty"))).toBeInTheDocument();
  });

  it("commands the only book that runs when the author is not in a book, wherever it runs", () => {
    const view = { ...useAutopilotStore.getState().views["book-1"] };
    const summary = useAutopilotStore.getState().summaries["book-1"];
    useAutopilotStore.setState({ views: { "book-1": { ...view, snapshot: { ...view.snapshot!, running: false } } }, summaries: { "book-1": { ...summary, status: "running", runner: { host: "server", label: "Home server", hostId: "s", runId: "r", startedAt: summary.updatedAt, heartbeatAt: new Date().toISOString() } } } });
    render(<Dock path="/app/books" />);
    expect(screen.getByRole("group", { name: quickGroupName("dock") })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: t("autopilot.dockTitle") })).getByText(LOCAL_BOOK.name)).toBeVisible();
  });

  it("lets the author choose which book to command when several run, and always says which one it is", async () => {
    const running = (book: BookEntry): ServerBookSummary => ({ bookId: book.id, title: book.name, storage: { kind: "local" }, hasGithubToken: false, ready: true, revision: "r", autopilot: null, running: true, lastSync: null });
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, books: [LOCAL_BOOK, OTHER] } });
    const state = useAutopilotStore.getState();
    useAutopilotStore.setState({ server: { ...state.server, books: [running(LOCAL_BOOK), running(OTHER)] }, views: { ...state.views, [OTHER.id]: { ...emptyView(OTHER.id), snapshot: { bookId: OTHER.id, state: state.views["book-1"].snapshot!.state, activities: [], live: null, running: true, host: null } } } });
    render(<Dock path="/app/books" />);

    const selector = screen.getByRole("button", { name: new RegExp(`^${t("autopilot.quick.bookLabel", { name: "" }).replace(/\s+$/, "")}`) });
    expect(selector).toHaveTextContent(/The (Glass Harbor|Second Book)/);
    const first = selector.textContent!.includes(LOCAL_BOOK.name) ? LOCAL_BOOK : OTHER;
    const second = first === LOCAL_BOOK ? OTHER : LOCAL_BOOK;
    expect(screen.getByRole("group", { name: quickGroupName("dock", first) })).toBeInTheDocument();

    openMenu(selector);
    const radios = screen.getAllByRole("menuitemradio");
    expect(radios).toHaveLength(2);
    for (const radio of radios) expect(radio).toHaveTextContent(t("autopilot.quick.bookRunning"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: new RegExp(second.name) }));
    await waitFor(() => expect(screen.getByRole("group", { name: quickGroupName("dock", second) })).toBeInTheDocument());
    expect(screen.queryByRole("group", { name: quickGroupName("dock", first) })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("autopilot.quick.bookLabel", { name: second.name }) })).toBeInTheDocument();
  });

  it("refreshes the book it commands, as the tab of the book does, so that its state is there to read", async () => {
    useAutopilotStore.setState({ views: {}, summaries: {} });
    render(<Dock />);
    await waitFor(() => expect(mocks.runtime.refresh).toHaveBeenCalledWith("book-1", expect.anything()));
  });
});

describe("the page and the live panel on the same screen", () => {
  it("never repeat the name of a control: each says which bar it belongs to", async () => {
    seedBar({ book: GITHUB_BOOK, status: "running", running: true, server: "online", publish: "chapter", pausePending: "after-chapter", limits: { steps: 2, stepsDone: 0, chaptersDone: 0 }, handover: { to: "server", when: "after-step", phase: "armed" }, dockOpen: true });
    mocks.book = GITHUB_BOOK;
    render(<Page withDock />);
    bringBackTheDock();
    const [page, dock] = groups();
    expect(groups().map((group) => group.getAttribute("data-quick-commands"))).toEqual(["page", "dock"]);
    const names = [...controlNames(page), ...controlNames(dock)];
    expect(names.length).toBeGreaterThan(12);
    expect(names.filter((name, index) => names.indexOf(name) !== index), "names used twice").toEqual([]);
    expect(page).toHaveAccessibleName(quickGroupName("page", GITHUB_BOOK));
    expect(dock).toHaveAccessibleName(quickGroupName("dock", GITHUB_BOOK));
    expect(quickGroupName("page", GITHUB_BOOK)).not.toBe(quickGroupName("dock", GITHUB_BOOK));
  });

  it("also tell apart the button that takes control of a run that belongs to another device", () => {
    seedBar({ status: "running", running: false, runner: { host: "browser", label: "Browser · Android", hostId: "other", runId: "run-1", startedAt: "2026-11-21T10:00:00.000Z", heartbeatAt: new Date().toISOString() }, dockOpen: true });
    render(<Page withDock />);
    bringBackTheDock();
    const [page, dock] = groups();
    const names = [...controlNames(page), ...controlNames(dock)];
    expect(names.filter((name) => name.startsWith(t("autopilot.control.takeOver")))).toEqual([quickName(t("autopilot.control.takeOver"), "page"), quickName(t("autopilot.control.takeOver"), "dock")]);
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
  });

  it("tell apart the entries of their menus too, and every control of the bar of a book that is stopped", async () => {
    seedBar({ book: GITHUB_BOOK, status: "paused", server: "online", publish: "step", dockOpen: true });
    mocks.book = GITHUB_BOOK;
    render(<Page withDock />);
    bringBackTheDock();
    const [page, dock] = groups();
    const names = [...controlNames(page), ...controlNames(dock)];
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
    // One of the menus, open: its entries have names of their own, and so does the menu.
    const entries = namedControls(document.body).filter((control) => control.role.startsWith("menuitem"));
    expect(entries).toEqual([]);
    openMenu(within(page).getByRole("button", { name: quickName(t("autopilot.quick.run.menu"), "page", GITHUB_BOOK) }));
    const menu = await screen.findByRole("menu");
    const labels = within(menu).getAllByRole("menuitem").map((item) => item.textContent);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

// Changed on purpose (the configuration of the autopilot): the switch “Publish to GitHub after every chapter” is now a choice of three, every step,
// every chapter or never, the same as the quick commands offer. It keeps the older switch in agreement, as the switch did.
describe("the choice of publishing in the configuration of the autopilot", () => {
  const runtime = { configure: vi.fn(async () => undefined), start: vi.fn(async () => undefined) };
  const run = vi.fn(async (_name: string, action: (runtime: unknown, bookId: string) => Promise<unknown>) => { await action(runtime, "book-1"); return true; });
  const stateWith = (options: Record<string, unknown>) => seedBar({ book: GITHUB_BOOK, status: "paused", statePatch: { options: { ...seedBar({ book: GITHUB_BOOK }).state!.options, ...options } as never } }).state;
  const choice = (mode: "step" | "chapter" | "off") => screen.getByRole("radio", { name: t(`autopilot.quick.publish.choice.${mode}`) });
  const save = () => fireEvent.click(screen.getByRole("button", { name: t("autopilot.setup.save") }));

  beforeEach(() => { runtime.configure.mockClear(); run.mockClear(); });

  function openSetup(options: Record<string, unknown>) {
    const state = stateWith(options);
    render(<MemoryRouter><SetupCard book={GITHUB_BOOK} state={state} existingChapters={1} running={false} busy={false} disabled={false} run={run as never} /></MemoryRouter>);
  }

  it("shows how the author chose to publish from the quick commands, not an older option that says otherwise", () => {
    openSetup({ syncAfterChapter: false, publishEvery: "step" });
    expect(choice("step")).toBeChecked();
    cleanup();
    openSetup({ syncAfterChapter: true, publishEvery: "off" });
    expect(choice("off")).toBeChecked();
  });

  it("follows the older option when the author did not choose", () => {
    openSetup({ syncAfterChapter: true });
    expect(choice("chapter")).toBeChecked();
    cleanup();
    openSetup({ syncAfterChapter: false });
    expect(choice("off")).toBeChecked();
  });

  it("changes both when Never is chosen, so that the two never disagree", async () => {
    openSetup({ syncAfterChapter: true, publishEvery: "step" });
    fireEvent.click(choice("off"));
    save();
    await waitFor(() => expect(runtime.configure).toHaveBeenCalledTimes(1));
    expect(runtime.configure).toHaveBeenLastCalledWith("book-1", { brief: expect.anything(), options: expect.objectContaining({ syncAfterChapter: false, publishEvery: "off" }) });
  });

  it("changes both when every chapter is chosen: the way the older switch always meant it", async () => {
    openSetup({ syncAfterChapter: false, publishEvery: "off" });
    fireEvent.click(choice("chapter"));
    save();
    await waitFor(() => expect(runtime.configure).toHaveBeenCalledTimes(1));
    expect(runtime.configure).toHaveBeenLastCalledWith("book-1", { brief: expect.anything(), options: expect.objectContaining({ syncAfterChapter: true, publishEvery: "chapter" }) });
  });

  it("leaves the older option to decide, as it always did, when the author does not touch the choice", async () => {
    openSetup({ syncAfterChapter: true });
    fireEvent.click(screen.getByRole("switch", { name: t("autopilot.setup.specialists") }));
    save();
    await waitFor(() => expect(runtime.configure).toHaveBeenCalledTimes(1));
    const options = (runtime.configure.mock.calls[0] as unknown as [string, { options: Record<string, unknown> }])[1].options;
    expect(options.syncAfterChapter).toBe(true);
    expect(options).not.toHaveProperty("publishEvery");
  });
});

void CONNECTION;
