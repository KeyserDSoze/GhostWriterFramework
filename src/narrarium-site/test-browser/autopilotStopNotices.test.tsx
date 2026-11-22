import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FrontmatterError, createAutopilotState, type AutopilotEvent, type AutopilotState, type AutopilotStateSummary, type DirectorQuestion } from "narrarium-engine";

const mocks = vi.hoisted(() => ({
  book: null as unknown,
  runtime: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
  toast: vi.fn(),
}));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: undefined, loading: false, error: undefined, reload: vi.fn() }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: vi.fn() }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AutopilotDock } from "@/components/autopilot/AutopilotDock";
import { AutopilotFeed } from "@/components/autopilot/AutopilotFeed";
import { AutopilotLauncher } from "@/components/autopilot/AutopilotLauncher";
import { AutopilotHubPage } from "@/pages/AutopilotHubPage";
import { AutopilotPage } from "@/pages/AutopilotPage";
import { emptyView, useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";

const T0 = "2026-11-21T10:00:00.000Z";
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", addedAt: T0, autopilotHost: "server" };
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

const DIRECTOR_PROBLEM = "director.md: autonomy «sometimes» is not one of full, ask-on-critical, ask-always: ask-on-critical is used";
const GHOSTWRITER_PROBLEM = "ghostwriters/default.md: the frontmatter is not valid YAML (line 3: a mapping is not allowed here): the profile could not be read as the file says; correct the file.";
const READER_PROBLEM = "personas/standard-general.md: enabled «maybe» is neither yes nor no: yes is used";
const HEADING = "Correct these profiles before resuming: the autopilot does not use a profile it cannot read as it is written";
const message = (...problems: string[]) => `${HEADING}. ${problems.join(" · ")}`;
const QUESTION: DirectorQuestion = { id: "q-1", kind: "plan-approval", question: "Approve this plan?", context: "", options: ["Yes", "No"], askedAt: T0 };

function seed(patch: Partial<AutopilotState> = {}, options: { book?: BookEntry; running?: boolean; dockOpen?: boolean } = {}) {
  const book = options.book ?? BOOK;
  mocks.book = book;
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [book], aiIntegrations: [{ id: "ai-1" } as never] } });
  const state: AutopilotState = { ...createAutopilotState(new Date(T0)), status: "waiting-author", phase: "write", updatedAt: T0, ...patch };
  useAutopilotStore.setState({
    dockOpen: options.dockOpen ?? false,
    dockTab: "book",
    views: { [book.id]: { ...emptyView(book.id), snapshot: { bookId: book.id, state, activities: [], live: null, running: options.running ?? false, host: null } } },
    summaries: {},
    live: {},
    feed: [],
  });
}

function Page() {
  return (
    <MemoryRouter initialEntries={["/app/books/book-1/autopilot"]}>
      <Routes><Route path="/app/books/:bookId/autopilot" element={<AutopilotPage />} /></Routes>
    </MemoryRouter>
  );
}

const dock = () => <MemoryRouter initialEntries={["/app/books/book-1/autopilot"]}><AutopilotDock /></MemoryRouter>;
const alertsWith = (text: string) => screen.queryAllByRole("alert").filter((element) => element.textContent?.includes(text));
const resume = () => screen.getByRole("button", { name: t("autopilot.actions.resume") }) as HTMLButtonElement;
const link = (name: string) => screen.getByRole("link", { name }) as HTMLAnchorElement;

function summaryOf(patch: Partial<AutopilotStateSummary> = {}, seconds = 30): AutopilotStateSummary {
  return {
    status: "waiting-author",
    phase: "write",
    message: message(DIRECTOR_PROBLEM),
    progress: { chapters: 1, chaptersDone: 0, scenes: 1, scenesWritten: 0, words: 0 },
    question: null,
    lastError: null,
    runner: null,
    stats: { tasks: 0, aiCalls: 0, inputTokens: 0, outputTokens: 0, cost: 0, failures: 0 },
    pendingNotes: 0,
    constraints: 0,
    updatedAt: new Date(Date.parse(T0) + seconds * 1000).toISOString(),
    ...patch,
  };
}

const stateEvent = (state: AutopilotStateSummary, seq: number) => ({ bookId: BOOK.id, at: state.updatedAt, seq, type: "state", state }) as AutopilotEvent;

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.runtime = {
    refresh: vi.fn(async () => null),
    start: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    ensureServerStream: vi.fn(),
    describeError: vi.fn((error: unknown) => String(error)),
  };
  mocks.toast.mockReset();
});

afterEach(async () => {
  cleanup();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("the page of a run that waits because a profile file has problems", () => {
  it("says so, lists each problem on its own line, points at the page that corrects the file, and resumes", async () => {
    seed({ message: message(DIRECTOR_PROBLEM, GHOSTWRITER_PROBLEM) });
    render(<Page />);

    const [notice] = alertsWith("director.md");
    expect(notice, "the text is in an alert").toBeDefined();
    expect(within(notice).getByText(t("autopilot.profileProblems.title"))).toBeInTheDocument();
    const lines = within(notice).getAllByRole("listitem").map((item) => item.textContent);
    expect(lines).toEqual([DIRECTOR_PROBLEM, GHOSTWRITER_PROBLEM]);
    expect(notice.textContent).not.toContain(HEADING);

    expect(link(t("autopilot.profileProblems.openDirector")).getAttribute("href")).toBe("/app/books/book-1/director");
    expect(link(t("autopilot.profileProblems.openGhostwriters")).getAttribute("href")).toBe("/app/books/book-1/ghostwriters");
    expect(screen.queryByRole("link", { name: t("autopilot.profileProblems.openReaders") }), "only the pages of the files named").not.toBeInTheDocument();

    expect(resume()).toBeEnabled();
    expect(screen.queryByRole("button", { name: t("autopilot.question.send") })).not.toBeInTheDocument();
    fireEvent.click(resume());
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith("book-1"));
  });

  it("tells the author what the button does: it checks the files again before anything is spent", () => {
    seed({ message: message(DIRECTOR_PROBLEM) });
    render(<Page />);
    expect(resume()).toHaveAccessibleDescription(t("autopilot.profileProblems.resumeHint", { action: t("autopilot.actions.resume") }));
    expect(t("autopilot.profileProblems.resumeHint", { action: t("autopilot.actions.resume") })).toContain(t("autopilot.actions.resume"));
  });

  it("says the same in Italian, with the problems as the engine wrote them", async () => {
    await i18n.changeLanguage("it");
    seed({ message: message(DIRECTOR_PROBLEM) });
    render(<Page />);
    const [notice] = alertsWith("director.md");
    expect(within(notice).getByText("Aspetta te: ci sono problemi nei file dei profili")).toBeInTheDocument();
    expect(within(notice).getAllByRole("listitem").map((item) => item.textContent)).toEqual([DIRECTOR_PROBLEM]);
    expect(link("Apri il direttore").getAttribute("href")).toBe("/app/books/book-1/director");
    expect(screen.getByRole("button", { name: "Riprendi" })).toBeEnabled();
  });

  it("offers every page when the message names no file it recognises, and when there is no message at all", () => {
    seed({ message: "Something a newer engine says." });
    const view = render(<Page />);
    for (const key of ["openDirector", "openGhostwriters", "openReaders"]) expect(link(t(`autopilot.profileProblems.${key}`))).toBeInTheDocument();
    view.unmount();

    seed({ message: null });
    render(<Page />);
    expect(link(t("autopilot.profileProblems.openReaders")).getAttribute("href")).toBe("/app/books/book-1/simulated-readers");
    expect(screen.getByText(t("autopilot.profileProblems.title"))).toBeInTheDocument();
  });

  it("shows the reader files' page for a problem in a reader file", () => {
    seed({ message: message(READER_PROBLEM) });
    render(<Page />);
    expect(link(t("autopilot.profileProblems.openReaders")).getAttribute("href")).toBe("/app/books/book-1/simulated-readers");
    expect(screen.queryByRole("link", { name: t("autopilot.profileProblems.openDirector") })).not.toBeInTheDocument();
  });

  it("is announced once, however many times the state is heard again with the same words", async () => {
    seed({ message: message(DIRECTOR_PROBLEM) });
    render(<Page />);
    const [notice] = alertsWith("director.md");
    expect(alertsWith("director.md")).toHaveLength(1);

    for (let step = 1; step <= 5; step += 1) await act(async () => { useAutopilotStore.getState().ingest(stateEvent(summaryOf({ message: message(DIRECTOR_PROBLEM) }, step * 30), step), BOOK.name); });
    const [later] = alertsWith("director.md");
    expect(alertsWith("director.md"), "the same words are not announced again by a second alert").toHaveLength(1);
    expect(later, "the element is the same one: it is not made again for every event").toBe(notice);
  });

  it("goes away as soon as the run is going again", async () => {
    seed({ message: message(DIRECTOR_PROBLEM) });
    render(<Page />);
    expect(alertsWith("director.md")).toHaveLength(1);
    await act(async () => { useAutopilotStore.getState().ingest(stateEvent(summaryOf({ status: "running", message: null }, 60), 1), BOOK.name); });
    expect(alertsWith("director.md")).toHaveLength(0);
    expect(screen.queryByText(t("autopilot.profileProblems.title"))).not.toBeInTheDocument();
  });

  it("leaves a question of the director as it is: the question to answer, the words of the run, no notice about profiles", () => {
    seed({ question: QUESTION, message: "The director has a question for you." });
    render(<Page />);
    expect(screen.getByText(QUESTION.question)).toBeInTheDocument();
    expect(screen.getByText(t("autopilot.question.title"))).toBeInTheDocument();
    expect(alertsWith("The director has a question for you.")).toHaveLength(1);
    expect(screen.queryByText(t("autopilot.profileProblems.title"))).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: t("autopilot.profileProblems.openDirector") })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("autopilot.actions.resume") })).not.toBeInTheDocument();
  });

  it("leaves the words of any other stop as they are", () => {
    seed({ status: "paused", message: "Budget reached: raise the limit to continue." });
    render(<Page />);
    expect(alertsWith("Budget reached: raise the limit to continue.")).toHaveLength(1);
    expect(screen.queryByText(t("autopilot.profileProblems.title"))).not.toBeInTheDocument();
  });
});

describe("the dock of a run that waits because a profile file has problems", () => {
  it("shows the problems once, with the page that corrects them and the button that resumes", async () => {
    seed({ message: message(DIRECTOR_PROBLEM, READER_PROBLEM) }, { dockOpen: true });
    render(dock());

    const notices = alertsWith("director.md");
    expect(notices).toHaveLength(1);
    expect(within(notices[0]).getAllByRole("listitem").map((item) => item.textContent)).toEqual([DIRECTOR_PROBLEM, READER_PROBLEM]);
    expect(link(t("autopilot.profileProblems.openDirector")).getAttribute("href")).toBe("/app/books/book-1/director");
    expect(link(t("autopilot.profileProblems.openReaders")).getAttribute("href")).toBe("/app/books/book-1/simulated-readers");
    expect(screen.queryByText(message(DIRECTOR_PROBLEM, READER_PROBLEM)), "the message is not written a second time as plain text").not.toBeInTheDocument();

    expect(resume()).toBeEnabled();
    expect(resume()).toHaveAccessibleDescription(t("autopilot.profileProblems.resumeHint", { action: t("autopilot.actions.resume") }));
    fireEvent.click(resume());
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith("book-1"));
  });

  it("keeps the link to the question when the director asks", () => {
    seed({ question: QUESTION, message: "The director has a question for you." }, { dockOpen: true });
    render(dock());
    expect(screen.getByText(QUESTION.question, { exact: false })).toBeInTheDocument();
    expect(screen.queryByText(t("autopilot.profileProblems.title"))).not.toBeInTheDocument();
  });
});

describe("the list of books of the hub, for a run that waits because a profile file has problems", () => {
  const hub = () => <MemoryRouter initialEntries={["/app/autopilot"]}><AutopilotHubPage /></MemoryRouter>;

  it("says why the book waits, and where to correct the file", () => {
    seed({ message: message(DIRECTOR_PROBLEM) });
    render(hub());
    const notices = alertsWith("director.md");
    expect(notices).toHaveLength(1);
    expect(within(notices[0]).getAllByRole("listitem").map((item) => item.textContent)).toEqual([DIRECTOR_PROBLEM]);
    expect(link(t("autopilot.profileProblems.openDirector")).getAttribute("href")).toBe("/app/books/book-1/director");
  });

  it("says nothing more about a book that only waits for an answer", () => {
    seed({ question: QUESTION, message: "The director has a question for you." });
    render(hub());
    expect(screen.queryByText(t("autopilot.profileProblems.title"))).not.toBeInTheDocument();
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });
});

describe("the launcher while a book waits because a profile file has problems", () => {
  const launcher = () => <MemoryRouter initialEntries={["/app/books/book-1/autopilot"]}><AutopilotLauncher /></MemoryRouter>;
  const button = () => screen.getByRole("button", { name: new RegExp(t("autopilot.openDock")) });

  it("names the state in words, not only with a coloured dot", () => {
    useAutopilotStore.setState({ summaries: { "book-1": summaryOf() }, live: {} });
    render(launcher());
    expect(button().getAttribute("aria-label")).toBe(`${t("autopilot.openDock")}: ${t("autopilot.launcherProfileProblems")}`);
    expect(within(button()).getByText(t("autopilot.launcherProfileProblems"))).toBeInTheDocument();
    expect(button().getAttribute("title")).toContain(t("autopilot.launcherProfileProblems"));
  });

  it("is unchanged while a book waits for an answer, and when nothing waits", () => {
    useAutopilotStore.setState({ summaries: { "book-1": summaryOf({ question: QUESTION, message: "The director has a question for you." }) }, live: {} });
    const view = render(launcher());
    expect(button().getAttribute("aria-label")).toBe(t("autopilot.openDock"));
    expect(within(button()).getByText(t("autopilot.launcher"))).toBeInTheDocument();
    view.unmount();

    useAutopilotStore.setState({ summaries: {}, live: {} });
    render(launcher());
    expect(button().getAttribute("aria-label")).toBe(t("autopilot.openDock"));
  });

  it("is in Italian when the app is", async () => {
    await i18n.changeLanguage("it");
    useAutopilotStore.setState({ summaries: { "book-1": summaryOf() }, live: {} });
    render(launcher());
    expect(within(button()).getByText("Problemi nei profili")).toBeInTheDocument();
  });
});

describe("the live feed", () => {
  const insight = (detail: string): AutopilotEvent => ({ bookId: "book-1", at: T0, seq: 1, type: "insight", tone: "warning", code: "profileProblems", title: HEADING, detail }) as AutopilotEvent;

  it("shows every problem of the profile warning, not only the first three lines", () => {
    const lines = Array.from({ length: 9 }, (_, index) => `personas/reader-${index}.md: severity «high» is not a number: 5 is used`);
    seed({});
    useAutopilotStore.setState({ feed: [{ event: insight(lines.join("\n")), bookTitle: BOOK.name }] });
    render(<AutopilotFeed bookId="book-1" />);
    const detail = screen.getByText(/personas\/reader-0\.md/);
    expect(detail.textContent).toBe(lines.join("\n"));
    expect(detail.className).not.toMatch(/line-clamp/);
  });

  it("still keeps the other notices short", () => {
    const long = Array.from({ length: 9 }, (_, index) => `line ${index}`).join("\n");
    seed({}, {});
    useAutopilotStore.setState({ feed: [{ event: { bookId: "book-1", at: T0, seq: 2, type: "insight", tone: "info", title: "A note", detail: long } as AutopilotEvent, bookTitle: BOOK.name }] });
    render(<AutopilotFeed bookId="book-1" />);
    expect(screen.getByText(/line 0/).className).toMatch(/line-clamp-3/);
  });
});

describe("a run that stopped because a file it was to rewrite has front matter that cannot be read", () => {
  const PATH = "chapters/001-the-arrival/chapter.md";
  const failure = (path: string, language?: string) => new FrontmatterError(path, "a mapping is not allowed here", 4, language).message;
  const failed = (text: string): Partial<AutopilotState> => ({ status: "error", message: text, lastError: { message: text, at: T0, task: "write" } });
  const open = (path: string) => t("autopilot.fileError.openFileNamed", { path });

  it("shows the whole message once, in an alert, and offers to open the file", () => {
    const text = failure(PATH);
    seed(failed(text));
    render(<Page />);
    const notices = alertsWith(text);
    expect(notices, "once: not again as the plain message of the run").toHaveLength(1);
    expect(notices[0]).toHaveTextContent(t("autopilot.lastError"));
    expect(notices[0].textContent).toContain(text);
    expect(link(open(PATH)).getAttribute("href")).toBe("/app/books/book-1/chapters/001-the-arrival");
    expect(link(open(PATH)).textContent).toBe(t("autopilot.fileError.openFile"));
    expect(screen.getByText(t("autopilot.fileError.hint"))).toBeInTheDocument();
  });

  it("reads the message of a book written in Italian the same way", async () => {
    await i18n.changeLanguage("it");
    const text = failure("chapters/002-la-diga/001-alba.md", "it");
    seed(failed(text));
    render(<Page />);
    expect(alertsWith(text)).toHaveLength(1);
    expect(link("Apri il file chapters/002-la-diga/001-alba.md").getAttribute("href")).toBe("/app/books/book-1/chapters/002-la-diga/paragraphs/001");
  });

  it("shows the path as text, and what to do, for a file the site has no page for", () => {
    const text = failure("plot.md");
    seed(failed(text));
    render(<Page />);
    expect(screen.queryByRole("link", { name: /plot\.md/ })).not.toBeInTheDocument();
    expect(screen.getByText("plot.md", { selector: "code" })).toBeInTheDocument();
    expect(screen.getByText(t("autopilot.fileError.hint"))).toBeInTheDocument();
    expect(alertsWith(text)).toHaveLength(1);
  });

  it("says nothing about files when the message names none", () => {
    seed(failed("Too many steps in one run."));
    render(<Page />);
    expect(alertsWith("Too many steps in one run.")).toHaveLength(1);
    expect(screen.queryByText(t("autopilot.fileError.hint"))).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: new RegExp(t("autopilot.fileError.openFile")) })).not.toBeInTheDocument();
  });

  it("shows the file to open in the dock too, and the whole message", () => {
    const text = failure(PATH);
    seed(failed(text), { dockOpen: true });
    render(dock());
    expect(alertsWith(text)).toHaveLength(1);
    expect(link(open(PATH)).getAttribute("href")).toBe("/app/books/book-1/chapters/001-the-arrival");
  });

  it("shows the whole message in the live feed, not only its first lines", () => {
    const text = failure(PATH);
    seed(failed(text));
    useAutopilotStore.setState({ feed: [{ event: { bookId: "book-1", at: T0, seq: 3, type: "run-ended", runId: "run-1", status: "error", message: text } as AutopilotEvent, bookTitle: BOOK.name }] });
    render(<AutopilotFeed bookId="book-1" />);
    const detail = screen.getByText(text);
    expect(detail.className).not.toMatch(/line-clamp/);
  });

  it("explains the book in the hub, with the way to the file", () => {
    const text = failure(PATH);
    seed(failed(text));
    render(<MemoryRouter initialEntries={["/app/autopilot"]}><AutopilotHubPage /></MemoryRouter>);
    expect(alertsWith(text)).toHaveLength(1);
    expect(link(open(PATH)).getAttribute("href")).toBe("/app/books/book-1/chapters/001-the-arrival");
  });
});
