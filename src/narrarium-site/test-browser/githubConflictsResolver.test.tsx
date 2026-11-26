import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  server: null as unknown as { verified: () => unknown },
  toast: vi.fn(),
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
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { autopilotRuntime } from "@/autopilot/runtime";
import { GithubConflictsDialog } from "@/components/autopilot/GithubConflictsDialog";
import { useAutopilotStore } from "@/autopilot/store";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { FakeBookServer } from "./helpers/fakeBookServer";
import { CONFLICT_BOOK, conflictOf, conflictedServer, conflictsOf, seedConflictedBook, type ConflictedBook } from "./helpers/githubConflicts";
import { polyfillRadix } from "./helpers/radix";
import { t } from "./helpers/quickCommands";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });
polyfillRadix();

const META = { id: "repo-1", bookId: CONFLICT_BOOK.id, owner: CONFLICT_BOOK.owner, repo: CONFLICT_BOOK.repo, branch: "main", cloneComplete: true };
const CLEAN = { clean: 4, modified: 0, new: 0, deleted: 0, dirty: 0, ahead: 0 };

let server: FakeBookServer;

const dialog = () => screen.getByRole("dialog");
const inside = () => within(dialog());
const listTitle = (total: number) => t("githubConflicts.list.title", { count: total });
/** A radio by the name it has (its `aria-label`): a query by role over hundreds of radios is slow in jsdom, and the tests of the names check them by role. */
const radio = (version: "server" | "github", path: string): HTMLInputElement => {
  const name = t(version === "server" ? "githubConflicts.choose.serverFor" : "githubConflicts.choose.githubFor", { path });
  const found = [...dialog().querySelectorAll<HTMLInputElement>("input[type=radio]")].find((input) => input.getAttribute("aria-label") === name);
  if (!found) throw new Error(`No ${version} radio for ${path}`);
  return found;
};
/** Chooses a version for many files in one go, as one render: the window is drawn once, not once for each file. */
const chooseAll = (version: "server" | "github", paths: string[]) => act(() => { for (const path of paths) radio(version, path).click(); });
const restRadio = (which: "none" | "server" | "github") => within(inside().getByRole("radiogroup", { name: t("githubConflicts.rest.legend") })).getByRole("radio", { name: t(`githubConflicts.rest.${which}`) });
const resolveButton = () => inside().getByRole("button", { name: t("githubConflicts.actions.resolve") });
const button = (key: string) => inside().getByRole("button", { name: t(key) });
const rowOf = (path: string) => inside().getByText(path, { selector: "code" }).closest("li") as HTMLElement;

/** Opens the window of the book's conflicts and waits until the list is on show (or, with `ready: false`, until the first answer). */
async function open(seed: ConflictedBook = {}, options: { ready?: boolean; total?: number } = {}) {
  seedConflictedBook(server, seed);
  const onOpenChange = vi.fn();
  render(<MemoryRouter><GithubConflictsDialog bookId={CONFLICT_BOOK.id} open onOpenChange={onOpenChange} /></MemoryRouter>);
  if (options.ready !== false) await inside().findByRole("list", { name: listTitle(options.total ?? server.conflicts.length) });
  return { onOpenChange };
}

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  server = conflictedServer(3);
  mocks.server = server;
  mocks.toast.mockReset();
  mocks.getLocalRepository.mockReset().mockResolvedValue(META);
  mocks.localStatus.mockReset().mockResolvedValue(CLEAN);
  mocks.syncFullRepository.mockReset().mockResolvedValue({ pulled: 0, committed: 1 });
  mocks.pullRemoteChanges.mockReset().mockResolvedValue({ updated: 0, remoteHeadSha: "abc" });
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [CONFLICT_BOOK] } });
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  autopilotRuntime.ensureServerStream();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  await i18n.changeLanguage("en");
});

describe("the window of the conflicts with GitHub", () => {
  it("is a dialog with a title and a description, and reads the first page of the list from the server", async () => {
    await open();

    expect(dialog()).toHaveAccessibleName(t("githubConflicts.dialog.title"));
    expect(dialog()).toHaveAccessibleDescription(t("githubConflicts.dialog.description"));
    expect(server.listed).toEqual([{ offset: 0, limit: 50 }]);
  });

  it("says that it is reading while it reads, in a polite status", async () => {
    let release!: () => void;
    server.gates.listGithubConflicts = new Promise<void>((resolve) => { release = resolve; });
    await open({}, { ready: false });

    const status = await inside().findByText(t("githubConflicts.status.loading"));
    expect(status.closest("[role=status]")).not.toBeNull();
    expect(status.closest("[role=status]")?.getAttribute("aria-live")).toBe("polite");
    expect(inside().queryByRole("list")).not.toBeInTheDocument();

    release();
    await inside().findByRole("list", { name: listTitle(3) });
    expect(inside().queryByText(t("githubConflicts.status.loading"))).not.toBeInTheDocument();
  });

  it("says what each side did with each file, with the size of each version, and offers the two versions as a choice named after the file", async () => {
    server.conflicts = [conflictOf("chapters/0001-the-key.md", { server: "modified", github: "deleted", serverBytes: 1_200, githubBytes: undefined }), conflictOf("notes/new.md", { server: "added", github: "added", serverBytes: 300, githubBytes: 2_048 })];
    await open();

    const first = rowOf("chapters/0001-the-key.md");
    expect(first).toHaveTextContent(t("githubConflicts.list.line", { server: t("autopilot.where.sideSize", { state: t("autopilot.where.side.modified"), size: "1.2 KB" }), github: t("autopilot.where.side.deleted") }));
    expect(rowOf("notes/new.md")).toHaveTextContent(t("githubConflicts.list.line", { server: t("autopilot.where.sideSize", { state: t("autopilot.where.side.added"), size: "300 B" }), github: t("autopilot.where.sideSize", { state: t("autopilot.where.side.added"), size: "2 KB" }) }));
    const group = within(first).getByRole("radiogroup", { name: "chapters/0001-the-key.md" });
    expect(within(group).getAllByRole("radio")).toHaveLength(2);
    expect(radio("server", "chapters/0001-the-key.md")).not.toBeChecked();
    expect(radio("github", "chapters/0001-the-key.md")).not.toBeChecked();
  });

  it("says in the words of the spec what the choices do, and that nothing is changed until the author resolves", async () => {
    await open();

    expect(inside().getByText(t("githubConflicts.intro"))).toBeInTheDocument();
    expect(t("githubConflicts.intro")).toMatch(/git/);
    expect(inside().getByText(t("githubConflicts.dialog.description"))).toBeInTheDocument();
  });

  it("says how far the two have gone since they parted", async () => {
    server.ahead = 14;
    server.behind = 3;
    await open();
    expect(inside().getByText(t("githubConflicts.divergence", { ahead: 14, behind: 3 }))).toBeInTheDocument();
  });

  it("says which side's own files of the autopilot are kept, only when both sides changed them", async () => {
    await open();
    expect(inside().queryByText(t("githubConflicts.autopilotFiles.server"))).not.toBeInTheDocument();
    expect(inside().queryByText(t("githubConflicts.autopilotFiles.github"))).not.toBeInTheDocument();
    cleanup();

    server.autopilotFiles = "github";
    await open();
    expect(inside().getByText(t("githubConflicts.autopilotFiles.github"))).toBeInTheDocument();
    cleanup();

    server.autopilotFiles = "server";
    await open();
    expect(inside().getByText(t("githubConflicts.autopilotFiles.server"))).toBeInTheDocument();
  });

  it("warns that the resolution stays on the server while publishing is off, and only then", async () => {
    await open({ publish: "off" });
    expect(inside().getByText(t("githubConflicts.unpublished"))).toBeInTheDocument();
    cleanup();

    await open({ publish: "step" });
    expect(inside().queryByText(t("githubConflicts.unpublished"))).not.toBeInTheDocument();
  });
});

describe("a list of many files", () => {
  beforeEach(() => {
    server.conflicts = conflictsOf(120);
  });

  it("is read from the server fifty at a time, and shown fifty at a time, with where the author is in it", async () => {
    await open();

    expect(server.listed).toEqual([{ offset: 0, limit: 50 }]);
    const list = inside().getByRole("list", { name: listTitle(120) });
    expect(within(list).getAllByRole("listitem")).toHaveLength(50);
    expect(inside().getByText(t("githubConflicts.status.page", { from: 1, to: 50, total: 120 }))).toBeInTheDocument();
    expect(inside().getByText(t("githubConflicts.list.page", { page: 1, pages: 3 }))).toBeInTheDocument();
    expect(button("githubConflicts.list.previous")).toBeDisabled();
    expect(button("githubConflicts.list.next")).toBeEnabled();
  });

  it("goes to the next page and back, reading each from the server, and says the page in a polite status", async () => {
    await open();

    fireEvent.click(button("githubConflicts.list.next"));
    await inside().findByText(conflictsOf(120)[50].path, { selector: "code" });
    expect(server.listed).toEqual([{ offset: 0, limit: 50 }, { offset: 50, limit: 50 }]);
    expect(within(inside().getByRole("list", { name: listTitle(120) })).getAllByRole("listitem")).toHaveLength(50);
    expect(inside().getByText(t("githubConflicts.status.page", { from: 51, to: 100, total: 120 })).closest("[role=status]")).not.toBeNull();
    expect(inside().getByText(t("githubConflicts.list.page", { page: 2, pages: 3 }))).toBeInTheDocument();

    fireEvent.click(button("githubConflicts.list.next"));
    await inside().findByText(conflictsOf(120)[100].path, { selector: "code" });
    expect(within(inside().getByRole("list", { name: listTitle(120) })).getAllByRole("listitem")).toHaveLength(20);
    expect(button("githubConflicts.list.next")).toBeDisabled();

    fireEvent.click(button("githubConflicts.list.previous"));
    await inside().findByText(conflictsOf(120)[50].path, { selector: "code" });
  });

  it("keeps what the author chose while they change page, and the choices of a page they come back to are still there", async () => {
    await open();
    const [first, second] = conflictsOf(120);
    fireEvent.click(radio("github", first.path));
    fireEvent.click(radio("server", second.path));

    fireEvent.click(button("githubConflicts.list.next"));
    await inside().findByText(conflictsOf(120)[50].path, { selector: "code" });
    fireEvent.click(radio("server", conflictsOf(120)[50].path));
    fireEvent.click(button("githubConflicts.list.previous"));
    await inside().findByText(first.path, { selector: "code" });

    expect(radio("github", first.path)).toBeChecked();
    expect(radio("server", second.path)).toBeChecked();
    expect(radio("server", conflictsOf(120)[2].path)).not.toBeChecked();
    fireEvent.click(button("githubConflicts.list.next"));
    await inside().findByText(conflictsOf(120)[50].path, { selector: "code" });
    expect(radio("server", conflictsOf(120)[50].path)).toBeChecked();
  });

  it("moves the focus to the list when the page changes, so that it is not lost with the button that went", async () => {
    await open();
    button("githubConflicts.list.next").focus();
    fireEvent.click(button("githubConflicts.list.next"));
    await inside().findByText(conflictsOf(120)[50].path, { selector: "code" });

    await waitFor(() => expect(document.activeElement).toBe(inside().getByRole("heading", { name: listTitle(120) })));
  });

  it("is not ready, though every file of the page that was read has a version: the other pages have none", async () => {
    await open();
    chooseAll("github", conflictsOf(120).slice(0, 50).map((entry) => entry.path));

    expect(resolveButton()).toBeDisabled();
    expect(resolveButton()).toHaveAccessibleDescription(t("githubConflicts.summary.left", { count: 70 }));
  }, 60_000);

  it("is resolved with a version for all the others and a few exceptions, after asking, without sending a choice for every file", { timeout: 20_000 }, async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    await open();
    const [first] = conflictsOf(120);
    fireEvent.click(restRadio("github"));
    fireEvent.click(radio("server", first.path));
    expect(resolveButton()).toBeEnabled();

    fireEvent.click(resolveButton());
    expect(confirm).toHaveBeenLastCalledWith(t("githubConflicts.confirm.github", { count: 119 }));
    expect(server.resolutions).toEqual([]);
    fireEvent.click(resolveButton());

    await inside().findByText(t("githubConflicts.done.title"));
    expect(server.resolutions).toEqual([{ fingerprint: expect.any(String), default: "github", choices: { [first.path]: "server" } }]);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(server.conflicts).toEqual([]);
  });

  it("asks nothing when every file was chosen one by one: the author looked at each", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    server.conflicts = conflictsOf(3);
    await open();
    for (const entry of conflictsOf(3)) fireEvent.click(radio("server", entry.path));

    fireEvent.click(resolveButton());
    await inside().findByText(t("githubConflicts.done.title"));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("is resolved with a version for each file when the author went through every page and chose them all", async () => {
    server.conflicts = conflictsOf(60);
    await open();
    chooseAll("github", conflictsOf(60).slice(0, 50).map((entry) => entry.path));
    fireEvent.click(button("githubConflicts.list.next"));
    await inside().findByText(conflictsOf(60)[50].path, { selector: "code" });
    expect(resolveButton()).toBeDisabled();
    chooseAll("server", conflictsOf(60).slice(50).map((entry) => entry.path));
    expect(resolveButton()).toBeEnabled();

    fireEvent.click(resolveButton());
    await inside().findByText(t("githubConflicts.done.title"));
    expect(server.resolutions).toHaveLength(1);
    expect(server.resolutions[0].default).toBeUndefined();
    expect(Object.keys(server.resolutions[0].choices ?? {})).toHaveLength(60);
  }, 60_000);
});

describe("the choices", () => {
  it("do not let the author resolve while a file has no version, and say how many have none", async () => {
    await open();

    expect(resolveButton()).toBeDisabled();
    expect(resolveButton()).toHaveAccessibleDescription(t("githubConflicts.summary.left", { count: 3 }));
    fireEvent.click(radio("server", conflictsOf(3)[0].path));
    expect(resolveButton()).toBeDisabled();
    expect(resolveButton()).toHaveAccessibleDescription(t("githubConflicts.summary.left", { count: 2 }));
    expect(inside().getByText(t("githubConflicts.summary.chosen", { count: 1 }))).toBeInTheDocument();
  });

  it("are changed by choosing the other version, and one version for all the others makes the author ready, and can be taken back", async () => {
    server.conflicts = conflictsOf(1);
    await open();
    const [only] = conflictsOf(1);

    fireEvent.click(radio("server", only.path));
    fireEvent.click(radio("github", only.path));
    expect(radio("github", only.path)).toBeChecked();
    expect(radio("server", only.path)).not.toBeChecked();
    expect(resolveButton()).toBeEnabled();
    cleanup();

    server.conflicts = conflictsOf(4);
    await open();
    expect(resolveButton()).toBeDisabled();
    fireEvent.click(restRadio("server"));
    expect(resolveButton()).toBeEnabled();
    expect(inside().getByText(t("githubConflicts.summary.restServer"))).toBeInTheDocument();
    fireEvent.click(restRadio("none"));
    expect(resolveButton()).toBeDisabled();
  });

  it("send the version of each file as the author chose it, with the fingerprint of the list they saw, and nothing else", async () => {
    await open();
    const [first, second, third] = conflictsOf(3);
    fireEvent.click(radio("server", first.path));
    fireEvent.click(radio("github", second.path));
    fireEvent.click(radio("github", third.path));
    const fingerprint = server.fingerprint();

    fireEvent.click(resolveButton());
    await inside().findByText(t("githubConflicts.done.title"));

    expect(server.resolutions).toEqual([{ fingerprint, choices: { [first.path]: "server", [second.path]: "github", [third.path]: "github" } }]);
  });

  it("keep the files the server cannot choose for apart, with why, and ask for no version for them", async () => {
    server.conflicts = [conflictOf("chapters/0001.md"), conflictOf("docs", { resolvable: false, reason: "file-directory", server: "added", github: "added" }), conflictOf("odd\u202ename.md", { resolvable: false, reason: "unsafe-path" }), conflictOf("link.md", { resolvable: false, reason: "not-a-file" })];
    await open();

    const fixed = inside().getByRole("list", { name: t("githubConflicts.fixed.title", { count: 3 }) });
    expect(within(fixed).getAllByRole("listitem")).toHaveLength(3);
    expect(within(fixed).queryAllByRole("radio")).toHaveLength(0);
    expect(fixed).toHaveTextContent(t("githubConflicts.fixed.reason.file-directory"));
    expect(fixed).toHaveTextContent(t("githubConflicts.fixed.reason.unsafe-path"));
    expect(fixed).toHaveTextContent(t("githubConflicts.fixed.reason.not-a-file"));
    expect(inside().getByText(t("githubConflicts.fixed.hint"))).toBeInTheDocument();

    expect(resolveButton()).toBeDisabled();
    fireEvent.click(radio("github", "chapters/0001.md"));
    expect(resolveButton()).toBeEnabled();
    fireEvent.click(resolveButton());
    await inside().findByText(t("githubConflicts.done.title"));
    expect(server.resolutions[0].choices).toEqual({ "chapters/0001.md": "github" });
  });

  it("are not asked for when every conflict is one the server cannot choose for: it keeps its own, and the author can resolve", async () => {
    server.conflicts = [conflictOf("docs", { resolvable: false, reason: "file-directory" })];
    await open();

    expect(resolveButton()).toBeEnabled();
    fireEvent.click(resolveButton());
    await inside().findByText(t("githubConflicts.done.title"));
    expect(server.resolutions).toEqual([{ fingerprint: expect.any(String) }]);
  });

  it("are not made while another operation holds the book", async () => {
    await open();
    act(() => useAutopilotStore.getState().patchView(CONFLICT_BOOK.id, { operation: { kind: "sync", since: new Date().toISOString() } }));

    expect(radio("server", conflictsOf(3)[0].path)).toBeDisabled();
    expect(restRadio("github")).toBeDisabled();
    expect(resolveButton()).toBeDisabled();
  });

  it("survive a name nobody wrote for a person: long, non-Latin, with an emoji and a right-to-left word, kept in the width of the window", async () => {
    const long = `chapters/${"capítulo-".repeat(20)}終章/שלום-📖.md`;
    server.conflicts = [conflictOf(long), conflictOf("章/第一章：鍵.md")];
    await open();

    const code = inside().getByText(long, { selector: "code" });
    expect(code.className).toMatch(/break-all/);
    expect(radio("server", long)).toBeInTheDocument();
    expect(radio("github", "章/第一章：鍵.md")).toBeInTheDocument();
  });
});

describe("what happens when it is resolved", () => {
  async function resolveAll(version: "server" | "github" = "github") {
    for (const entry of server.conflicts.filter((file) => file.resolvable)) fireEvent.click(radio(version, entry.path));
    fireEvent.click(resolveButton());
    return inside().findByText(t("githubConflicts.done.title"));
  }

  it("says what was kept and what was taken, in the sentence of the spec, and moves the focus to it", async () => {
    await open();
    const [first] = conflictsOf(3);
    fireEvent.click(radio("server", first.path));
    fireEvent.click(radio("github", conflictsOf(3)[1].path));
    fireEvent.click(radio("github", conflictsOf(3)[2].path));
    fireEvent.click(resolveButton());
    await inside().findByText(t("githubConflicts.done.title"));

    const outcome = dialog().querySelector("[data-github-conflicts-outcome]") as HTMLElement;
    expect(outcome).toHaveTextContent("Resolved: 1 kept from the server, 2 taken from GitHub. Resume the autopilot whenever you want.");
    expect(outcome.getAttribute("role")).toBe("status");
    expect(outcome.getAttribute("aria-live")).toBe("polite");
    await waitFor(() => expect(document.activeElement).toBe(outcome));
  });

  it("says it in Italian, with the plural of each number", async () => {
    await i18n.changeLanguage("it");
    await open();
    const [first] = conflictsOf(3);
    fireEvent.click(radio("server", first.path));
    fireEvent.click(radio("github", conflictsOf(3)[1].path));
    fireEvent.click(radio("github", conflictsOf(3)[2].path));
    fireEvent.click(resolveButton());
    await inside().findByText("Risolto");

    expect(dialog().querySelector("[data-github-conflicts-outcome]")).toHaveTextContent("Risolto: 1 tenuto dal server, 2 presi da GitHub. Riprendi l'autopilot quando vuoi.");
  });

  it("offers Resume, and does not resume by itself: the run starts only when the author asks, and the window closes", async () => {
    const { onOpenChange } = await open();
    await resolveAll();

    expect(server.count("startAutopilot")).toBe(0);
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.click(button("autopilot.actions.resume"));

    await waitFor(() => expect(server.count("startAutopilot")).toBe(1));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("can be closed without resuming, and then nothing starts", async () => {
    const { onOpenChange } = await open();
    await resolveAll();

    fireEvent.click(button("githubConflicts.actions.close"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(server.count("startAutopilot")).toBe(0);
  });

  it("says that the resolution is published, when it was", async () => {
    await open();
    await resolveAll();
    expect(inside().getByText(t("githubConflicts.done.published"))).toBeInTheDocument();
    expect(inside().queryByText(t("githubConflicts.done.pushFailed"))).not.toBeInTheDocument();
  });

  it("says that it is resolved on the server but not published, with what the server said, and that the next sync publishes it", async () => {
    server.pushError = "remote: Permission to writer/glass-harbor.git denied.";
    await open();
    await resolveAll();

    expect(inside().getByText(t("githubConflicts.done.pushFailed"))).toBeInTheDocument();
    const said = inside().getByText(server.pushError);
    expect(said.closest("[lang=en]")).not.toBeNull();
    expect(inside().queryByText(t("githubConflicts.done.published"))).not.toBeInTheDocument();
    expect(button("autopilot.actions.resume")).toBeInTheDocument();
  });

  it("says that it stays on the server when publishing is off", async () => {
    server.publishOff = true;
    await open({ publish: "off" });
    await resolveAll();

    expect(inside().getByText(t("githubConflicts.done.notPublished"))).toBeInTheDocument();
    expect(inside().queryByText(t("githubConflicts.done.published"))).not.toBeInTheDocument();
  });

  it("says what was kept as the server has it, what was left aside, and whose own files of the autopilot were kept", async () => {
    server.conflicts = [conflictOf("a.md"), conflictOf("docs", { resolvable: false, reason: "file-directory" })];
    server.autopilotFiles = "github";
    // The server leaves aside the choices for files that no longer conflict, and says how many.
    server.resolutionPatch = { ignored: ["gone.md", "gone-too.md"], counts: { total: 2, server: 1, github: 0, ignored: 2, unresolvable: 1 } };
    await open();
    fireEvent.click(radio("server", "a.md"));
    fireEvent.click(resolveButton());
    await inside().findByText(t("githubConflicts.done.title"));

    expect(inside().getByText(t("githubConflicts.done.fixed", { count: 1 }))).toBeInTheDocument();
    expect(inside().getByText(t("githubConflicts.done.ignored", { count: 2 }))).toBeInTheDocument();
    expect(inside().getByText(t("githubConflicts.done.autopilotFiles.github"))).toBeInTheDocument();
    expect(dialog().querySelector("[data-github-conflicts-outcome]")).toHaveTextContent("Resolved: 1 kept from the server, 0 taken from GitHub.");
  });

  it("brings the summary of the book on the server up to date, so that the notice of «Where it runs» goes away", async () => {
    await open();
    expect(useAutopilotStore.getState().views[CONFLICT_BOOK.id].server?.lastSync?.conflicts).toBe(3);
    await resolveAll();

    await waitFor(() => expect(useAutopilotStore.getState().views[CONFLICT_BOOK.id].server?.lastSync?.conflicts).toBeUndefined());
  });

  it("cannot be closed while it is being resolved, by Escape or by the button, and the controls wait", async () => {
    let release!: () => void;
    server.gates.resolveGithubConflicts = new Promise<void>((resolve) => { release = resolve; });
    try {
      const { onOpenChange } = await open();
      for (const entry of conflictsOf(3)) fireEvent.click(radio("server", entry.path));
      fireEvent.click(resolveButton());

      await inside().findByText(t("githubConflicts.status.resolving"));
      fireEvent.keyDown(dialog(), { key: "Escape" });
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(button("githubConflicts.actions.close")).toBeDisabled();
      expect(resolveButton()).toBeDisabled();
    } finally {
      release();
    }
    await inside().findByText(t("githubConflicts.done.title"));
  });

  it("can be closed with Escape when nothing is being done", async () => {
    const { onOpenChange } = await open();
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("what the server refuses, in words, with what can be done", () => {
  async function pickAll() {
    for (const entry of server.conflicts.filter((file) => file.resolvable)) fireEvent.click(radio("server", entry.path));
  }

  it("asks the author to pause the autopilot when it runs, before anything is sent, and the Pause button does it", async () => {
    server.running = true;
    server.onPause = () => server.stop("paused");
    await open({ status: "running", running: true });

    const notice = inside().getByText(t("githubConflicts.failure.busy"));
    expect(notice).toBeInTheDocument();
    await pickAll();
    expect(resolveButton()).toBeDisabled();
    expect(server.count("resolveGithubConflicts")).toBe(0);

    fireEvent.click(button("githubConflicts.actions.pause"));
    await waitFor(() => expect(server.paused).toEqual(["now"]));
    await waitFor(() => expect(inside().queryByText(t("githubConflicts.failure.busy"))).not.toBeInTheDocument());
    expect(resolveButton()).toBeEnabled();
  });

  it("says it also when the server says the run is active though this page did not know, keeping what the author chose", async () => {
    await open();
    await pickAll();
    server.running = true;

    fireEvent.click(resolveButton());

    const alert = await inside().findByRole("alert");
    expect(alert).toHaveTextContent(t("githubConflicts.failure.busy"));
    expect(within(alert).getByRole("button", { name: t("githubConflicts.actions.pause") })).toBeInTheDocument();
    expect(radio("server", conflictsOf(3)[0].path)).toBeChecked();
    expect(server.resolutions).toEqual([]);
  });

  it("shows the new list when GitHub moved again, says so, drops the choices made on the old one, and resolves from the new one", async () => {
    await open();
    await pickAll();
    server.moveGithub();
    server.conflicts = [...server.conflicts, conflictOf("notes/late.md")];

    fireEvent.click(resolveButton());

    await inside().findByText(t("githubConflicts.again"));
    expect(inside().getByRole("list", { name: listTitle(4) })).toBeInTheDocument();
    expect(radio("server", conflictsOf(3)[0].path)).not.toBeChecked();
    expect(resolveButton()).toBeDisabled();
    expect(server.resolutions).toEqual([]);

    for (const entry of server.conflicts) fireEvent.click(radio("github", entry.path));
    const fingerprint = server.fingerprint();
    fireEvent.click(resolveButton());
    await inside().findByText(t("githubConflicts.done.title"));
    expect(server.resolutions).toHaveLength(1);
    expect(server.resolutions[0].fingerprint).toBe(fingerprint);
    expect(Object.keys(server.resolutions[0].choices ?? {})).toHaveLength(4);
  });

  it("notices that GitHub moved while the author was on another page, and starts again from the new list", async () => {
    server.conflicts = conflictsOf(120);
    await open();
    fireEvent.click(radio("github", conflictsOf(120)[0].path));
    server.moveGithub();

    fireEvent.click(button("githubConflicts.list.next"));

    await inside().findByText(t("githubConflicts.again"));
    expect(server.listed[server.listed.length - 1]).toEqual({ offset: 0, limit: 50 });
    expect(radio("github", conflictsOf(120)[0].path)).not.toBeChecked();
    expect(inside().getByText(t("githubConflicts.list.page", { page: 1, pages: 3 }))).toBeInTheDocument();
  });

  it("names the files without a version when the server says some have none, and keeps what was chosen", async () => {
    await open();
    await pickAll();
    server.refusals.resolveGithubConflicts = { status: 400, code: "choice_missing", message: "Choose the version to keep of 2 files.", details: { paths: ["notes/a.md", "notes/b.md"], missing: 2 } };

    fireEvent.click(resolveButton());

    const alert = await inside().findByRole("alert");
    expect(alert).toHaveTextContent(t("githubConflicts.failure.choiceMissing", { count: 2 }));
    expect(alert).toHaveTextContent("notes/a.md");
    expect(alert).toHaveTextContent("notes/b.md");
    expect(radio("server", conflictsOf(3)[0].path)).toBeChecked();
  });

  it("says that there is nothing to resolve when the files no longer conflict, and offers to resume", async () => {
    await open();
    await pickAll();
    server.conflicts = [];

    fireEvent.click(resolveButton());

    const alert = await inside().findByRole("alert");
    expect(alert).toHaveTextContent(t("githubConflicts.failure.notConflicted"));
    expect(inside().queryByRole("list", { name: /./ })).not.toBeInTheDocument();
    expect(button("autopilot.actions.resume")).toBeInTheDocument();
    expect(server.count("startAutopilot")).toBe(0);
  });

  it.each([
    ["maintenance", 503, "maintenance"],
    ["scope", 403, "forbidden"],
  ])("says what %s means in words of its own, changes nothing and keeps the choices", async (code, status, key) => {
    await open();
    await pickAll();
    server.refusals.resolveGithubConflicts = { status, code, message: "The server said no." };

    fireEvent.click(resolveButton());

    const alert = await inside().findByRole("alert");
    expect(alert).toHaveTextContent(t(`githubConflicts.failure.${key}`));
    expect(alert).not.toHaveTextContent("The server said no.");
    expect(radio("server", conflictsOf(3)[0].path)).toBeChecked();
    expect(server.resolutions).toEqual([]);
  });

  it.each([
    ["no_remote", 409, "noRemote"],
    ["unrelated_histories", 409, "unrelatedHistories"],
    ["book_not_found", 404, "bookMissing"],
  ])("says what %s means in words of its own, and takes the list away: there is nothing more to settle here", async (code, status, key) => {
    const { onOpenChange } = await open();
    await pickAll();
    server.refusals.resolveGithubConflicts = { status, code, message: "The server said no." };

    fireEvent.click(resolveButton());

    const alert = await inside().findByRole("alert");
    expect(alert).toHaveTextContent(t(`githubConflicts.failure.${key}`));
    expect(alert).not.toHaveTextContent("The server said no.");
    expect(inside().queryByRole("list", { name: /./ })).not.toBeInTheDocument();
    expect(inside().queryByRole("button", { name: t("githubConflicts.actions.resolve") })).not.toBeInTheDocument();
    expect(server.resolutions).toEqual([]);
    await waitFor(() => expect(document.activeElement).toBe(alert.querySelector("[tabindex='-1']")));
    fireEvent.click(button("githubConflicts.actions.close"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("names the files GitHub holds that the server cannot write, in the server's own words, and what to do", async () => {
    await open();
    await pickAll();
    server.invalidGithubPath = "GitHub holds a file whose name cannot be written in a working copy (a/..): nothing was merged. Remove it from the repository on GitHub, then try again.";

    fireEvent.click(resolveButton());

    const alert = await inside().findByRole("alert");
    expect(alert).toHaveTextContent(t("githubConflicts.failure.invalidPath"));
    expect(within(alert).getByText(server.invalidGithubPath).closest("[lang=en]")).not.toBeNull();
  });

  it("tells a server that is about to restart to try again in a minute, and the Try again button asks once more", async () => {
    await open();
    await pickAll();
    server.maintenance = true;
    fireEvent.click(resolveButton());
    const alert = await inside().findByRole("alert");
    expect(alert).toHaveTextContent(t("githubConflicts.failure.maintenance"));

    server.maintenance = false;
    fireEvent.click(within(alert).getByRole("button", { name: t("githubConflicts.actions.retry") }));

    await inside().findByText(t("githubConflicts.done.title"));
    expect(server.resolutions).toHaveLength(1);
  });

  it("does not say that nothing was changed when the server did not answer: it may have done it, and the list is read again to see", async () => {
    await open();
    await pickAll();
    server.offline = true;
    fireEvent.click(resolveButton());
    const alert = await inside().findByRole("alert");
    expect(alert).toHaveTextContent(t("githubConflicts.failure.unreachable"));
    expect(alert).not.toHaveTextContent(/nothing was changed/i);

    server.offline = false;
    fireEvent.click(within(alert).getByRole("button", { name: t("githubConflicts.actions.reload") }));
    await inside().findByRole("list", { name: listTitle(3) });
    expect(server.listed.length).toBeGreaterThan(1);
  });

  it("says when the server could not reach GitHub, with what it said, and the list can be read again", async () => {
    await open();
    await pickAll();
    server.gitFailure = "fatal: unable to access 'https://github.com/acme/glass-harbor.git/'";
    fireEvent.click(resolveButton());

    const alert = await inside().findByRole("alert");
    expect(alert).toHaveTextContent(t("githubConflicts.failure.gitFailed"));
    expect(within(alert).getByText(server.gitFailure).closest("[lang=en]")).not.toBeNull();
    expect(within(alert).getByRole("button", { name: t("githubConflicts.actions.reload") })).toBeInTheDocument();
  });

  it("says that the book is no longer an unresolved one when the server's list is empty, and offers to resume", async () => {
    server.conflicts = [];
    seedConflictedBook(server);
    render(<MemoryRouter><GithubConflictsDialog bookId={CONFLICT_BOOK.id} open onOpenChange={vi.fn()} /></MemoryRouter>);

    const notice = await inside().findByText(t("githubConflicts.failure.notConflicted"));
    expect(notice.closest("[role=alert],[role=status]")).not.toBeNull();
    expect(button("autopilot.actions.resume")).toBeInTheDocument();
    expect(inside().queryByRole("button", { name: t("githubConflicts.actions.resolve") })).not.toBeInTheDocument();
  });

  it("says what is wrong when the list cannot be read, and reads it again when the author asks", async () => {
    server.gitFailure = "fatal: could not read from remote repository.";
    await open({}, { ready: false });

    const alert = await inside().findByRole("alert");
    expect(alert).toHaveTextContent(t("githubConflicts.failure.gitFailed"));
    server.gitFailure = null;
    fireEvent.click(within(alert).getByRole("button", { name: t("githubConflicts.actions.reload") }));
    await inside().findByRole("list", { name: listTitle(3) });
  });

  it("says that the book is not on GitHub on the server, when the list says so", async () => {
    server.noRemote = true;
    await open({}, { ready: false });
    expect(await inside().findByRole("alert")).toHaveTextContent(t("githubConflicts.failure.noRemote"));
  });

  it("tells the author to update a server that does not have the feature, before anything is asked of it, with the way to its settings", async () => {
    server.githubConflicts = false;
    await open({}, { ready: false });

    const alert = await inside().findByRole("alert");
    expect(alert).toHaveTextContent(t("githubConflicts.failure.oldServer"));
    expect(within(alert).getByRole("link", { name: t("githubConflicts.failure.settings") })).toHaveAttribute("href", "/app/settings/server");
    expect(server.calls).toEqual([]);
  });

  it("says what the server said when it was something nobody expected, and offers to read the list again", async () => {
    await open();
    await pickAll();
    server.refusals.resolveGithubConflicts = { status: 500, code: "internal", message: "Something broke inside the server." };

    fireEvent.click(resolveButton());

    const alert = await inside().findByRole("alert");
    expect(alert).toHaveTextContent(t("githubConflicts.failure.other"));
    expect(within(alert).getByText("Something broke inside the server.").closest("[lang=en]")).not.toBeNull();
    expect(within(alert).getByRole("button", { name: t("githubConflicts.actions.reload") })).toBeInTheDocument();
  });
});

describe("the same window in Italian", () => {
  it("has the labels of the spec: «Tieni la versione del server», «Prendi quella di GitHub», «Per tutti gli altri», «Risolvi»", async () => {
    await i18n.changeLanguage("it");
    await open();

    const first = conflictsOf(3)[0].path;
    expect(inside().getByRole("radio", { name: `Tieni la versione del server: ${first}` })).toBeInTheDocument();
    expect(inside().getByRole("radio", { name: `Prendi quella di GitHub: ${first}` })).toBeInTheDocument();
    expect(inside().getByRole("radiogroup", { name: "Per tutti gli altri" })).toBeInTheDocument();
    expect(inside().getByRole("button", { name: "Risolvi" })).toBeInTheDocument();
    expect(dialog()).toHaveAccessibleName("Conflitti con GitHub");
    expect(inside().getAllByText("Sul server: modificato (1,2 KB) · Su GitHub: modificato (2 KB)")).toHaveLength(3);
  });
});

describe("one file", () => {
  it.each([
    ["en", "1 file changed on both sides"],
    ["it", "1 file cambiato da entrambe le parti"],
  ])("is said in the singular, has no pages, and is resolved by choosing it (%s)", async (language, title) => {
    await i18n.changeLanguage(language);
    server.conflicts = conflictsOf(1);
    await open();

    const list = inside().getByRole("list", { name: title });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(inside().queryByRole("navigation")).not.toBeInTheDocument();
    expect(resolveButton()).toBeDisabled();
    expect(resolveButton()).toHaveAccessibleDescription(t("githubConflicts.summary.left", { count: 1 }));
    fireEvent.click(radio("github", conflictsOf(1)[0].path));
    expect(resolveButton()).toBeEnabled();
    fireEvent.click(resolveButton());
    await inside().findByText(t("githubConflicts.done.title"));
    expect(dialog().querySelector("[data-github-conflicts-outcome]")).toHaveTextContent(language === "en" ? "Resolved: 0 kept from the server, 1 taken from GitHub." : "Risolto: 0 tenuti dal server, 1 preso da GitHub.");
  });
});

describe("every state of the window", () => {
  /** What the author can reach in the window: every button, link and choice has the target of a finger (44 px), and the line that holds a choice is the target. */
  const targets = () => [...dialog().querySelectorAll<HTMLElement>("button, a[href], label")].filter((element) => element.closest("[hidden]") === null);

  it.each(["en", "it"])("shows no translation key, and keeps a target of 44 px for everything that can be pressed, in each of its states (%s)", { timeout: 20_000 }, async (language) => {
    await i18n.changeLanguage(language);
    const keyLeak = /\b(?:githubConflicts|autopilot)\.[a-z][\w.-]*\b/;
    const check = (state: string) => {
      expect(dialog().textContent ?? "", `${language}: ${state} shows a key`).not.toMatch(keyLeak);
      for (const element of targets()) expect(element.className, `${language}: ${state}: «${element.textContent?.trim().slice(0, 30)}» keeps a target of 44 px`).toMatch(/min-h-11/);
    };

    // The list, with files the server cannot choose for, a version for all the others, publishing off, and the autopilot's own files.
    server.conflicts = [...conflictsOf(60), conflictOf("docs", { resolvable: false, reason: "file-directory" })];
    server.autopilotFiles = "server";
    await open({ publish: "off" });
    check("the list");
    fireEvent.click(restRadio("github"));
    check("with a version for all the others");
    fireEvent.click(button("githubConflicts.list.next"));
    await inside().findByText(conflictsOf(60)[50].path, { selector: "code" });
    check("the second page");

    // A refusal, and the outcome with a push that failed.
    server.refusals.resolveGithubConflicts = { status: 409, code: "busy", message: "Pause the autopilot." };
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(resolveButton());
    await inside().findByRole("alert");
    check("a refusal");
    delete server.refusals.resolveGithubConflicts;
    server.pushError = "remote: Permission denied.";
    fireEvent.click(resolveButton());
    await inside().findByText(t("githubConflicts.done.title"));
    check("the outcome");
  });
});
