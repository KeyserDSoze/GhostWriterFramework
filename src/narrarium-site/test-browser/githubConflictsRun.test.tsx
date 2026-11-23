import { cleanup, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeAutopilotAi, seedBookFiles } from "narrarium-engine/testing";
import { AUTOPILOT_STATE_FILE, createAutopilotState, type AiPort, type AiRequest, type AutopilotState } from "narrarium-engine";

const mocks = vi.hoisted(() => ({
  server: null as unknown as { verified: () => unknown },
  book: null as unknown,
  toast: vi.fn(),
  save: vi.fn(async () => true),
  reload: vi.fn(),
  getLocalRepository: vi.fn(),
  localStatus: vi.fn(),
  syncFullRepository: vi.fn(),
  pullRemoteChanges: vi.fn(),
}));

vi.mock("@/autopilot/serverIdentity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/serverIdentity")>()),
  verifiedServer: async () => mocks.server.verified(),
}));
vi.mock("@/repository/localRepository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/repository/localRepository")>()),
  getLocalRepository: mocks.getLocalRepository,
  localStatus: mocks.localStatus,
}));
vi.mock("@/repository/repositoryService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/repository/repositoryService")>()),
  syncFullRepository: mocks.syncFullRepository,
  pullRemoteChanges: mocks.pullRemoteChanges,
  getExistingLocalBookStructure: async () => null,
}));
vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: undefined, loading: false, error: undefined, reload: mocks.reload }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: mocks.save }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { autopilotRuntime } from "@/autopilot/runtime";
import { AutopilotPage } from "@/pages/AutopilotPage";
import { useAutopilotStore } from "@/autopilot/store";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { FakeBookServer, PIN } from "./helpers/fakeBookServer";
import { CONFLICT_BOOK, conflictOf, conflictsOf } from "./helpers/githubConflicts";
import { polyfillRadix } from "./helpers/radix";
import { t } from "./helpers/quickCommands";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });
polyfillRadix();

const SLUG = "001-the-key";
const META = { id: "repo-1", bookId: CONFLICT_BOOK.id, owner: CONFLICT_BOOK.owner, repo: CONFLICT_BOOK.repo, branch: "main", cloneComplete: true };
const CLEAN = { clean: 4, modified: 0, new: 0, deleted: 0, dirty: 0, ahead: 0 };
const scene = (text: string) => `---\ntype: paragraph\nid: paragraph:${SLUG}:001-the-pier\nchapter: chapter:${SLUG}\nnumber: 1\ntitle: The pier\n---\n\n${text}\n`;

/** A book of one chapter that the autopilot wrote and approved, and nothing else to write: a run that gets past its first step has finished it. */
function bookFiles(): Record<string, string> {
  const state: AutopilotState = {
    ...createAutopilotState(new Date("2026-11-21T10:00:00.000Z"), { idea: "A harbor town built on glass hides a lie.", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }),
    status: "paused",
    phase: "write",
    plan: { chapters: [{ number: 1, title: "The key", slug: SLUG, summary: "Mira finds the key under the pier.", goal: "Find the key.", pov: [], keyEvents: ["Mira finds the key"], reveals: [], status: "done", scenes: [] }], approved: true, rounds: 1 },
  } as AutopilotState;
  state.options = { ...state.options, readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false, publishEvery: "step" };
  return {
    ...seedBookFiles(),
    [`chapters/${SLUG}/chapter.md`]: `---\ntype: chapter\nid: chapter:${SLUG}\nnumber: 1\ntitle: The key\nsummary: Mira finds the key under the pier.\n---\n\n# The key\n`,
    [`chapters/${SLUG}/001-the-pier.md`]: scene("Mira finds the key under the pier, wrapped in her father's scarf."),
    [AUTOPILOT_STATE_FILE]: JSON.stringify(state),
  };
}

let server: FakeBookServer;
let calls: number;

function countedAi(): AiPort {
  const inner = createFakeAutopilotAi({ chapters: 1, scenes: 1, words: 120 });
  return {
    async complete(request: AiRequest) {
      calls += 1;
      return inner.complete(request);
    },
  };
}

const band = () => document.querySelector<HTMLElement>("[data-autopilot-band]") as HTMLElement;
const panel = () => document.querySelector<HTMLElement>("[data-autopilot-error]");

function Page() {
  return (
    <MemoryRouter initialEntries={["/app/books/book-1/autopilot"]}>
      <Routes><Route path="/app/books/:bookId/autopilot" element={<AutopilotPage />} /></Routes>
    </MemoryRouter>
  );
}

beforeAll(async () => {
  // A real session of the engine runs in these tests: on a machine that is busy with other work it takes longer than the 4 seconds that the others wait.
  configure({ asyncUtilTimeout: 15_000 });
  await loadAutopilotTranslations();
});

afterAll(() => {
  configure({ asyncUtilTimeout: 4000 });
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  localStorage.clear();
  calls = 0;
  server = new FakeBookServer(bookFiles());
  server.engine = true;
  server.githubConflicts = true;
  server.ai = countedAi();
  server.conflicts = [...conflictsOf(2, "chapters"), conflictOf("plot.md", { server: "modified", github: "deleted", githubBytes: undefined })];
  mocks.server = server;
  mocks.book = { ...CONFLICT_BOOK };
  mocks.toast.mockReset();
  mocks.getLocalRepository.mockReset().mockResolvedValue(META);
  mocks.localStatus.mockReset().mockResolvedValue(CLEAN);
  mocks.syncFullRepository.mockReset().mockResolvedValue({ pulled: 0, committed: 1 });
  mocks.pullRemoteChanges.mockReset().mockResolvedValue({ updated: 0, remoteHeadSha: "abc" });
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [CONFLICT_BOOK], aiIntegrations: [{ id: "ai-1" } as never], personalServer: { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN } } });
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], server: { status: "online", info: server.info(), message: null, books: [], updates: null, connection: { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN } } });
});

afterEach(async () => {
  cleanup();
  await autopilotRuntime.pause(CONFLICT_BOOK.id, "now").catch(() => undefined);
  await server.engineIdle().catch(() => undefined);
  vi.restoreAllMocks();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  autopilotRuntime.ensureServerStream();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  await i18n.changeLanguage("en");
});

describe("a run of the server that stops on a conflict with GitHub, from the error to «Resume»", { timeout: 30_000 }, () => {
  it("is stopped by the typed error of the engine, told in the words of the conflict, settled in the window, and resumed only when the author asks", async () => {
    // The author starts the autopilot: before its first step the server brings in what changed on GitHub and meets files that both sides changed.
    await autopilotRuntime.start(CONFLICT_BOOK.id);
    await server.engineIdle();
    const stopped = await server.engineSnapshot();
    expect(stopped.state?.status).toBe("error");
    expect(stopped.state?.lastError).toMatchObject({ errorKind: "conflict", errorDetail: { githubConflicts: 3 } });
    expect(calls).toBe(0);

    // The page shows the error in its own words, with the way to settle it.
    render(<Page />);
    const heading = await screen.findByRole("heading", { level: 2, name: t("githubConflicts.error.title") });
    expect(panel()).toHaveTextContent(t("githubConflicts.error.explain", { count: 3 }));
    const resolve = within(panel() as HTMLElement).getByRole("button", { name: t("githubConflicts.resolve") });
    expect(heading).toBeInTheDocument();

    // The window lists what both sides changed, the author chooses for each file and resolves.
    fireEvent.click(resolve);
    const dialog = await screen.findByRole("dialog", { name: t("githubConflicts.dialog.title") });
    const list = await within(dialog).findByRole("list", { name: t("githubConflicts.list.title", { count: 3 }) });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(dialog).toHaveTextContent(t("githubConflicts.list.line", { server: t("autopilot.where.sideSize", { state: t("autopilot.where.side.modified"), size: "1.2 KB" }), github: t("autopilot.where.side.deleted") }));
    const [first, second] = conflictsOf(2, "chapters");
    const radio = (version: "server" | "github", path: string) => within(dialog).getByRole("radio", { name: t(version === "server" ? "githubConflicts.choose.serverFor" : "githubConflicts.choose.githubFor", { path }) });
    fireEvent.click(radio("server", first.path));
    fireEvent.click(radio("github", second.path));
    fireEvent.click(radio("github", "plot.md"));
    fireEvent.click(within(dialog).getByRole("button", { name: t("githubConflicts.actions.resolve") }));

    // It says what was done, and offers to resume: the server's run has not been started again.
    const outcome = await waitFor(() => {
      const found = dialog.querySelector<HTMLElement>("[data-github-conflicts-outcome]");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(outcome).toHaveTextContent("Resolved: 1 kept from the server, 2 taken from GitHub. Resume the autopilot whenever you want.");
    await waitFor(() => expect(document.activeElement).toBe(outcome));
    expect(server.resolutions).toEqual([{ fingerprint: expect.any(String), choices: { [first.path]: "server", [second.path]: "github", "plot.md": "github" } }]);
    expect(server.conflicts).toEqual([]);
    expect(server.count("startAutopilot")).toBe(1);
    expect((await server.engineSnapshot()).running).toBe(false);

    // The author resumes: the same step is done once, the run goes past the conflict, and the panel of the error goes away with the window.
    fireEvent.click(within(dialog).getByRole("button", { name: t("autopilot.actions.resume") }));
    await waitFor(() => expect(server.count("startAutopilot")).toBe(2));
    await server.engineIdle();
    expect((await server.engineSnapshot()).state?.status).toBe("completed");
    await waitFor(() => expect(panel()).toBeNull());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // The focus is not lost with the panel and the window that held it: it is where the author looks next.
    await waitFor(() => expect(band().contains(document.activeElement) || document.activeElement === band()).toBe(true));
  });

  it("stops again, with the same words, when the author resumes without settling anything", async () => {
    await autopilotRuntime.start(CONFLICT_BOOK.id);
    await server.engineIdle();

    await autopilotRuntime.start(CONFLICT_BOOK.id);
    await server.engineIdle();

    const again = await server.engineSnapshot();
    expect(again.state?.status).toBe("error");
    expect(again.state?.lastError).toMatchObject({ errorKind: "conflict", errorDetail: { githubConflicts: 3 } });
    expect(calls).toBe(0);
  });

  it("is told to a screen reader once: the alert of the panel is the only alert on the page", async () => {
    await autopilotRuntime.start(CONFLICT_BOOK.id);
    await server.engineIdle();
    render(<Page />);
    await screen.findByRole("heading", { level: 2, name: t("githubConflicts.error.title") });

    expect(within(panel() as HTMLElement).getAllByRole("alert")).toHaveLength(1);
  });
});

