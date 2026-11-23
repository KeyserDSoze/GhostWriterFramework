import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OLD_SERVER_INFO } from "./helpers/fakeBookServer";

const mocks = vi.hoisted(() => ({
  server: null as unknown as { verified: () => unknown },
  toast: vi.fn(),
  save: vi.fn(async () => true),
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
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: mocks.save }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { autopilotRuntime } from "@/autopilot/runtime";
import { errorActions } from "@/autopilot/errorModel";
import { ErrorPanel } from "@/components/autopilot/ErrorPanel";
import { GithubConflictsWindow } from "@/components/autopilot/GithubConflictsWindow";
import { WhereCard } from "@/pages/AutopilotPage";
import { useAutopilotStore } from "@/autopilot/store";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { FakeBookServer } from "./helpers/fakeBookServer";
import { CONFLICT_BOOK, conflictMessage, conflictedServer, seedConflictedBook, type ConflictedBook } from "./helpers/githubConflicts";
import { polyfillRadix } from "./helpers/radix";
import { seedRun } from "./helpers/autopilotBand";
import { t } from "./helpers/quickCommands";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });
polyfillRadix();

const META = { id: "repo-1", bookId: CONFLICT_BOOK.id, owner: CONFLICT_BOOK.owner, repo: CONFLICT_BOOK.repo, branch: "main", cloneComplete: true };
const CLEAN = { clean: 4, modified: 0, new: 0, deleted: 0, dirty: 0, ahead: 0 };

let server: FakeBookServer;

const panel = () => document.querySelector<HTMLElement>("[data-autopilot-error]") as HTMLElement;
const resolveEntry = (scope: HTMLElement | Document = document.body) => within(scope as HTMLElement).queryAllByRole("button", { name: t("githubConflicts.resolve") });

/** What the page does: the panel and the card ask for the window, and the page shows it once. */
function show(seed: ConflictedBook = {}) {
  seedConflictedBook(server, seed);
  return render(<MemoryRouter><ErrorPanel bookId={CONFLICT_BOOK.id} /><GithubConflictsWindow bookId={CONFLICT_BOOK.id} /></MemoryRouter>);
}

function showWhere(seed: ConflictedBook = {}, book = CONFLICT_BOOK) {
  seedConflictedBook(server, seed);
  return render(<MemoryRouter><WhereCard book={book} running={false} /><GithubConflictsWindow bookId={book.id} /></MemoryRouter>);
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
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  autopilotRuntime.ensureServerStream();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  await i18n.changeLanguage("en");
});

describe("what the error panel offers for a run that stopped on a conflict with GitHub", () => {
  it("says in its own words that the book changed on both sides, with the number of files, and not in those of the other conflict", () => {
    show();

    const alert = within(panel()).getByRole("alert");
    expect(within(alert).getByRole("heading", { level: 2, name: "The book changed on both GitHub and the server" })).toBeInTheDocument();
    expect(alert).toHaveTextContent(t("githubConflicts.error.explain", { count: 3 }));
    expect(alert).not.toHaveTextContent(t("autopilot.failure.kind.conflict.title"));
    expect(alert).not.toHaveTextContent(t("autopilot.failure.kind.conflict.explain"));
    expect(panel().getAttribute("aria-labelledby")).toBe(within(alert).getByRole("heading", { level: 2 }).id);
  });

  it("says the singular when it is one file", () => {
    server.conflicts = server.conflicts.slice(0, 1);
    show();
    expect(panel()).toHaveTextContent(t("githubConflicts.error.explain", { count: 1 }));
    expect(t("githubConflicts.error.explain", { count: 1 })).toMatch(/^1 file was/);
  });

  it("makes «Resolve the conflicts» the main action: the first button, in the colour of the main action, and Resume is the second", () => {
    show();

    const buttons = within(panel()).getAllByRole("button");
    expect(buttons[0]).toHaveAccessibleName(t("githubConflicts.resolve"));
    expect(buttons[0].className).toMatch(/bg-primary/);
    const resume = within(panel()).getByRole("button", { name: new RegExp(t("autopilot.failure.actions.retry")) });
    expect(resume.className).not.toMatch(/bg-primary/);
    expect(buttons.indexOf(resume)).toBeGreaterThan(0);
  });

  it("keeps the button out of the alert, which is announced once, and does not repeat it in the details", () => {
    show();
    expect(within(within(panel()).getByRole("alert")).queryByRole("button")).not.toBeInTheDocument();
    expect(resolveEntry(panel())).toHaveLength(1);
    expect(within(panel()).getByText(conflictMessage(3))).toBeInTheDocument();
  });

  it("opens the window that settles them, which reads the first page from the server", async () => {
    show();
    fireEvent.click(resolveEntry(panel())[0]);

    const dialog = await screen.findByRole("dialog", { name: t("githubConflicts.dialog.title") });
    await within(dialog).findByRole("list", { name: t("githubConflicts.list.title", { count: 3 }) });
    expect(server.listed).toEqual([{ offset: 0, limit: 50 }]);
  });

  it("moves the focus to the title of the window when it opens, and gives it back to the button that opened it when it closes, whether or not the click focused the button", async () => {
    show();
    const entry = resolveEntry(panel())[0];
    fireEvent.click(entry);

    const dialog = await screen.findByRole("dialog", { name: t("githubConflicts.dialog.title") });
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("heading", { name: t("githubConflicts.dialog.title") })));
    await within(dialog).findByRole("list", { name: t("githubConflicts.list.title", { count: 3 }) });

    fireEvent.click(within(dialog).getByRole("button", { name: t("githubConflicts.actions.close") }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(entry));

    fireEvent.click(entry);
    const again = await screen.findByRole("dialog", { name: t("githubConflicts.dialog.title") });
    fireEvent.keyDown(again, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(entry));
  });

  it("leaves the other conflict, the one of a file that changed while a step ran, as it was: no way to resolve it with GitHub", () => {
    seedConflictedBook(server, { statePatch: { lastError: { message: "docs/plot.md changed while the step ran.", at: "2026-11-21T10:00:00.000Z", errorKind: "conflict" } } });
    render(<MemoryRouter><ErrorPanel bookId={CONFLICT_BOOK.id} /></MemoryRouter>);

    const alert = within(panel()).getByRole("alert");
    expect(alert).toHaveTextContent(t("autopilot.failure.kind.conflict.title"));
    expect(alert).toHaveTextContent(t("autopilot.failure.kind.conflict.explain"));
    expect(resolveEntry(panel())).toHaveLength(0);
    expect(within(panel()).getAllByRole("button")[0].className).toMatch(/bg-primary/);
  });

  it("tells the author to update a server that does not have the feature, and does not offer a button that could not work", () => {
    server.githubConflicts = false;
    show();

    expect(resolveEntry(panel())).toHaveLength(0);
    expect(within(panel()).getByText(t("githubConflicts.oldServer.text"))).toBeInTheDocument();
    expect(within(panel()).getByRole("link", { name: t("githubConflicts.oldServer.link") })).toHaveAttribute("href", "/app/settings/server");
    expect(server.calls).toEqual([]);
  });

  it("offers the button while it is not known what the server can do (it is connecting): the window finds out", () => {
    show({ server: "connecting" });
    expect(resolveEntry(panel())).toHaveLength(1);
    expect(within(panel()).queryByText(t("githubConflicts.oldServer.text"))).not.toBeInTheDocument();
  });

  it("knows an older server by its features, as it knows the one that has them", () => {
    seedConflictedBook(server, { serverInfo: OLD_SERVER_INFO });
    render(<MemoryRouter><ErrorPanel bookId={CONFLICT_BOOK.id} /></MemoryRouter>);
    expect(resolveEntry(panel())).toHaveLength(0);
    expect(within(panel()).getByText(t("githubConflicts.oldServer.text"))).toBeInTheDocument();
  });

  it("is not there for a run that did not stop, and not for a run that stopped for another reason", () => {
    seedRun({ status: "paused" });
    const { container } = render(<MemoryRouter><ErrorPanel bookId="book-1" /></MemoryRouter>);
    expect(container).toBeEmptyDOMElement();
    cleanup();

    seedRun({ status: "error", statePatch: { lastError: { message: "Connection error.", at: "2026-11-21T10:00:00.000Z", errorKind: "network" } } });
    render(<MemoryRouter><ErrorPanel bookId="book-1" /></MemoryRouter>);
    expect(resolveEntry(panel())).toHaveLength(0);
  });

  it("says it all in Italian, with the labels of the spec", async () => {
    await i18n.changeLanguage("it");
    show();

    const alert = within(panel()).getByRole("alert");
    expect(within(alert).getByRole("heading", { level: 2, name: "Il libro è cambiato sia su GitHub sia sul server" })).toBeInTheDocument();
    expect(alert).toHaveTextContent("3 file sono stati modificati sul server e su GitHub");
    expect(within(panel()).getByRole("button", { name: "Risolvi i conflitti" })).toBeInTheDocument();
  });
});

describe("the error panel once the author has resolved the conflicts and not resumed yet", () => {
  const settled = (patch: Record<string, unknown> = {}) => ({ at: "2026-11-21T10:05:00.000Z", ok: true, message: "The conflicts with GitHub were resolved and pushed.", head: "3333", ...patch });

  it("says that they are resolved, and makes resuming the main action: it does not offer to resolve them again", () => {
    show({ lastSync: settled() });

    const alert = within(panel()).getByRole("alert");
    expect(alert).toHaveTextContent(t("githubConflicts.error.settledTitle"));
    expect(alert).toHaveTextContent(t("githubConflicts.error.settledExplain"));
    expect(alert).not.toHaveTextContent(t("githubConflicts.error.title"));
    expect(resolveEntry(panel())).toHaveLength(0);
    expect(panel().getAttribute("data-kind")).toBe("conflict");
    const resume = within(panel()).getAllByRole("button")[0];
    expect(resume).toHaveAccessibleName(new RegExp(t("autopilot.failure.actions.retry")));
    expect(resume.className).toMatch(/bg-primary/);
  });

  it("says it also when the server says the last sync worked later without saying how: a sync that works means there is no conflict left", () => {
    show({ lastSync: settled({ message: "Pulled and pushed." }) });
    expect(within(panel()).getByRole("alert")).toHaveTextContent(t("githubConflicts.error.settledTitle"));
  });

  it("is still the conflict when the last sync is older than the error, failed, or says it met conflicts again", () => {
    show({ lastSync: settled({ at: "2026-11-21T09:00:00.000Z" }) });
    expect(within(panel()).getByRole("alert")).toHaveTextContent(t("githubConflicts.error.title"));
    expect(resolveEntry(panel())).toHaveLength(1);
    cleanup();

    show({ lastSync: settled({ ok: false, message: "remote: Permission denied." }) });
    expect(within(panel()).getByRole("alert")).toHaveTextContent(t("githubConflicts.error.title"));
    cleanup();

    show({ lastSync: settled({ ok: false, conflicts: 4 }) });
    expect(within(panel()).getByRole("alert")).toHaveTextContent(t("githubConflicts.error.title"));
    expect(resolveEntry(panel())).toHaveLength(1);
  });

  it("is still the conflict when nothing is known of the last sync (the server forgot it when it restarted): the window says there is nothing left", () => {
    show({ lastSync: null });
    expect(within(panel()).getByRole("alert")).toHaveTextContent(t("githubConflicts.error.title"));
  });

  it("says it in Italian", async () => {
    await i18n.changeLanguage("it");
    show({ lastSync: settled() });
    expect(within(panel()).getByRole("alert")).toHaveTextContent("I conflitti con GitHub sono risolti");
  });
});

describe("the rule of the main action", () => {
  it("is as it was for every failure, and for a conflict that is not with GitHub", () => {
    expect(errorActions("conflict")).toEqual({ retry: "main", integrations: false, router: false, first: "retry" });
    expect(errorActions("network")).toEqual({ retry: "main", integrations: true, router: false, first: "retry" });
    expect(errorActions("conflict", { configurationBlocks: false })).toEqual({ retry: "main", integrations: false, router: false, first: "retry" });
  });

  it("is to resolve, for a conflict with GitHub: resuming comes second, as it would only meet the conflict again", () => {
    expect(errorActions("conflict", { githubConflict: true })).toEqual({ retry: "secondary", integrations: false, router: false, first: "resolve" });
  });

  it("does not change the other kinds, whatever the option says", () => {
    expect(errorActions("network", { githubConflict: true })).toEqual(errorActions("network"));
    expect(errorActions("config", { githubConflict: true })).toEqual(errorActions("config"));
  });
});

describe("what «Where it runs» says when the server says the book conflicts with GitHub", () => {
  it("says it with the number of files and the same button, next to what it says of the last sync", () => {
    showWhere();

    const notice = document.querySelector<HTMLElement>("[data-github-conflicts-notice]") as HTMLElement;
    expect(notice).not.toBeNull();
    expect(notice).toHaveTextContent(t("githubConflicts.notice.text", { count: 3 }));
    expect(within(notice).getByRole("button", { name: t("githubConflicts.resolve") })).toBeInTheDocument();
  });

  it("opens the window that settles them", async () => {
    showWhere();
    fireEvent.click(screen.getByRole("button", { name: t("githubConflicts.resolve") }));

    const dialog = await screen.findByRole("dialog", { name: t("githubConflicts.dialog.title") });
    await within(dialog).findByRole("list", { name: t("githubConflicts.list.title", { count: 3 }) });
  });

  it("is not there when the last sync worked, or failed for another reason, or the book is not run by the server", () => {
    showWhere({ lastSync: { at: "2026-11-21T10:00:00.000Z", ok: true, message: "Pushed to GitHub." } });
    expect(document.querySelector("[data-github-conflicts-notice]")).toBeNull();
    cleanup();

    showWhere({ lastSync: { at: "2026-11-21T10:00:00.000Z", ok: false, message: "remote: Permission denied." } });
    expect(document.querySelector("[data-github-conflicts-notice]")).toBeNull();
    cleanup();

    showWhere({}, { ...CONFLICT_BOOK, autopilotHost: undefined });
    expect(document.querySelector("[data-github-conflicts-notice]")).toBeNull();
  });

  it("tells the author to update a server that does not have the feature, instead of offering the button", () => {
    server.githubConflicts = false;
    showWhere();

    const notice = document.querySelector<HTMLElement>("[data-github-conflicts-notice]") as HTMLElement;
    expect(notice).toHaveTextContent(t("githubConflicts.notice.text", { count: 3 }));
    expect(within(notice).queryByRole("button", { name: t("githubConflicts.resolve") })).not.toBeInTheDocument();
    expect(within(notice).getByText(t("githubConflicts.oldServer.text"))).toBeInTheDocument();
    expect(within(notice).getByRole("link", { name: t("githubConflicts.oldServer.link") })).toBeInTheDocument();
  });

  it("is told to a screen reader as a note of its own, with an icon and words: the state is never only a colour", () => {
    showWhere();
    const notice = document.querySelector<HTMLElement>("[data-github-conflicts-notice]") as HTMLElement;
    expect(notice.querySelector("svg[aria-hidden=true]")).not.toBeNull();
    expect(notice.textContent?.length ?? 0).toBeGreaterThan(20);
  });

  it("leaves the conflicts between this device and the server, and the other things «Where it runs» says, as they were", () => {
    showWhere();
    expect(screen.getByRole("button", { name: t("autopilot.where.sync") })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: t("autopilot.where.title") })).toBeInTheDocument();
  });

  it("says it in Italian", async () => {
    await i18n.changeLanguage("it");
    showWhere();
    const notice = document.querySelector<HTMLElement>("[data-github-conflicts-notice]") as HTMLElement;
    expect(notice).toHaveTextContent("Il libro è cambiato sia su GitHub sia sul server: 3 file da risolvere.");
    expect(within(notice).getByRole("button", { name: "Risolvi i conflitti" })).toBeInTheDocument();
  });
});

describe("a manual sync that the server answers with a conflict", () => {
  it("makes the notice and the button appear in «Where it runs» at once, and says it in a toast", async () => {
    const real = new FakeBookServer();
    real.githubConflicts = true;
    real.conflicts = server.conflicts;
    mocks.server = real;
    mocks.localStatus.mockResolvedValue({ ...CLEAN, dirty: 1, modified: 1, ahead: 2 });
    seedConflictedBook(real, { status: "paused", lastSync: { at: "2026-11-21T09:00:00.000Z", ok: true, message: "Pushed to GitHub." } });
    const { ServerRequestError } = await import("narrarium-engine");
    real.failures.syncGitHub = new ServerRequestError(conflictMessage(3), 409, "github_conflict", { conflicts: 3 });
    render(<MemoryRouter><WhereCard book={CONFLICT_BOOK} running={false} /></MemoryRouter>);
    expect(document.querySelector("[data-github-conflicts-notice]")).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: t("autopilot.where.sync") }));

    await waitFor(() => expect(document.querySelector("[data-github-conflicts-notice]")).not.toBeNull());
    expect(document.querySelector("[data-github-conflicts-notice]")).toHaveTextContent(t("githubConflicts.notice.text", { count: 3 }));
    expect(screen.getByRole("button", { name: t("githubConflicts.resolve") })).toBeInTheDocument();
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ description: t("autopilot.errors.githubConflict", { count: 3 }), variant: "destructive" })));
  });
});

describe("the window outlives what opened it", () => {
  async function resolveFrom(opener: () => HTMLElement) {
    fireEvent.click(opener());
    const dialog = await screen.findByRole("dialog", { name: t("githubConflicts.dialog.title") });
    await within(dialog).findByRole("list", { name: t("githubConflicts.list.title", { count: 3 }) });
    for (const input of within(dialog).getAllByRole("radio").filter((radio) => radio.getAttribute("aria-label")?.startsWith(t("githubConflicts.choose.server")))) fireEvent.click(input);
    fireEvent.click(within(dialog).getByRole("button", { name: t("githubConflicts.actions.resolve") }));
    const outcome = await waitFor(() => {
      const found = dialog.querySelector<HTMLElement>("[data-github-conflicts-outcome]");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    return { dialog, outcome };
  }

  it("keeps the outcome on show when the panel that opened it says the conflicts are resolved and takes its button away", async () => {
    show();
    const { dialog, outcome } = await resolveFrom(() => resolveEntry(panel())[0]);

    // The server's summary of the book is read again after the resolution: the panel now says it is resolved, and has no button to resolve with.
    // (The window is modal: what is behind it is hidden from the accessibility tree, so the panel is looked at as it is.)
    await waitFor(() => expect(within(panel()).getByRole("alert", { hidden: true })).toHaveTextContent(t("githubConflicts.error.settledTitle")));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(within(panel()).queryAllByRole("button", { name: t("githubConflicts.resolve"), hidden: true })).toHaveLength(0);
    expect(screen.getByRole("dialog", { name: t("githubConflicts.dialog.title") })).toBe(dialog);
    expect(outcome).toBeInTheDocument();
    expect(outcome).toHaveTextContent(t("githubConflicts.done.title"));
  });

  it("keeps the outcome on show when the notice of «Where it runs» that opened it goes away with the conflicts", async () => {
    showWhere();
    const { dialog, outcome } = await resolveFrom(() => screen.getByRole("button", { name: t("githubConflicts.resolve") }));

    await waitFor(() => expect(document.querySelector("[data-github-conflicts-notice]")).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole("dialog", { name: t("githubConflicts.dialog.title") })).toBe(dialog);
    expect(outcome).toBeInTheDocument();
  });
});
