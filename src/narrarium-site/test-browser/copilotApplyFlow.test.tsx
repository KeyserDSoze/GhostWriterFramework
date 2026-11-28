import "fake-indexeddb/auto";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

const toasts = vi.hoisted(() => [] as Array<{ title?: string; description?: string; variant?: string }>);
const github = vi.hoisted(() => ({ getRef: vi.fn(), getCommit: vi.fn(), getTree: vi.fn(), createBlob: vi.fn(), createTree: vi.fn(), createCommit: vi.fn(), updateRef: vi.fn() }));
vi.mock("@octokit/rest", () => ({ Octokit: class { rest = { git: github }; } }));
vi.mock("@/components/ui/use-toast", () => {
  // One function for every render: the panel lists `toast` among the dependencies of its effects.
  const toast = (entry: (typeof toasts)[number]) => { toasts.push(entry); };
  return { useToast: () => ({ toast }), toast };
});
vi.mock("@/assistant/service", () => ({ appendAssistantNote: vi.fn(), applyParagraphRewrite: vi.fn(), compactAssistantSession: vi.fn(async ({ session }) => session), runAssistantPrompt: vi.fn() }));
vi.mock("@/assistant/chatCloud", async (original) => ({ ...await original<typeof import("@/assistant/chatCloud")>(), listAssistantSessions: vi.fn(async () => []), saveAssistantSession: vi.fn(async () => ({ fileId: "f", revision: "r" })), loadAssistantSession: vi.fn(), deleteAssistantSession: vi.fn() }));
vi.mock("@/assistant/chatLocal", () => ({ listLocalChatSessions: vi.fn(async () => []), saveLocalChatSession: vi.fn(async () => undefined), loadLocalChatSession: vi.fn(), deleteLocalChatSession: vi.fn(async () => undefined) }));
vi.mock("@/assistant/context", async (original) => ({ ...await original<typeof import("@/assistant/context")>(), loadWriterContext: vi.fn(async () => ({ title: "Ghostwriters", summary: "", loadedFilePaths: [], availableFiles: [], relevantFiles: [], route: { kind: "book-ghostwriters", bookId: "book" }, book: null, structure: null, branchReady: true })) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false }) }));
vi.mock("@/assistant/mutationRefresh", async (original) => ({ ...await original<typeof import("@/assistant/mutationRefresh")>(), refreshBookAfterMutation: vi.fn(async () => undefined) }));

import i18n from "@/i18n";
import { AssistantPanel } from "@/components/assistant/AssistantPanel";
import { createEmptyAssistantSession, useAssistantStore, type AssistantMessage } from "@/assistant/store";
import { captureImmediateMutation, commitImmediateMutation } from "@/assistant/immediateMutation";
import { getLocalFile, getLocalRepositoryStatusSnapshot, listDirtyLocalFiles, mutateLocalTextFilesAtomically } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { sha256Text } from "@/repository/safeRepositoryMutation";
import { localWorkspaceScope } from "@/account/deviceIdentity";
import { useRepositorySyncStore } from "@/store/repositorySyncStore";
import { resetAssistantSessionIndex } from "@/assistant/sessionIndex";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { createLinkedBookClone, resetLocalWorkspace, type LocalFirstBook } from "./helpers/localFirst";

// The page proposal of the ghostwriters (the owner's report, issue #124) applied through the real panel, on a book whose working copy holds a local commit and an
// edit not saved as a commit: it is applied, not refused, and sent by the sync together with the rest. Texts in both languages, never the raw text of an error.

const CLASSIC = "---\ntype: ghostwriter\nname: Classic\nslug: classic\n---\n\nClassic voice.\n";
const CLASSIC_NEW = "---\ntype: ghostwriter\nname: Classic\nslug: classic\n---\n\nClassic voice, warmer.\n";
const MODERN_NEW = "---\ntype: ghostwriter\nname: Modern\nslug: modern\n---\n\nModern voice.\n";
const SYNOPSIS = "---\ntype: outline-book\n---\n\nThe synopsis.\n";
const NOTE = "# Note\n\nA first line.\n";
const NOTE_EDITED = "# Note\n\nAn edit that is not a commit yet.\n";

let linked: LocalFirstBook;
const scope = () => captureRepositoryOperationScope();

async function proposal(): Promise<AssistantMessage> {
  return {
    id: "proposal", role: "assistant", text: "Two ghostwriters change.",
    action: {
      kind: "apply-file-updates", bookId: linked.book.id, toolId: "edit-page", owner: linked.book.owner, repo: linked.book.repo, branch: "main", sourceRevision: "unused", generatedAt: new Date().toISOString(),
      sourceRevisions: { "ghostwriters/classic.md": await sha256Text(CLASSIC), "ghostwriters/modern.md": null },
      updates: [{ path: "ghostwriters/classic.md", content: CLASSIC_NEW, reason: "Warmer" }, { path: "ghostwriters/modern.md", content: MODERN_NEW, reason: "New" }],
      review: { page: "ghostwriters", rows: [
        { id: "classic", name: "Classic", kind: "custom", builtin: false, change: "edited", fields: ["body"] },
        { id: "modern", name: "Modern", kind: "custom", builtin: false, before: null, after: true, change: "created" },
      ] },
    },
  };
}

function githubUnchanged() {
  github.getRef.mockResolvedValue({ data: { object: { sha: "remote-head" } } });
  github.getCommit.mockResolvedValue({ data: { tree: { sha: "remote-tree" } } });
  github.getTree.mockResolvedValue({ data: { truncated: false, tree: ["ghostwriters/classic.md", "outline/book.md", "notes/note.md"].map((path, index) => ({ path, type: "blob", sha: `blob-${index}` })) } });
  let blob = 0;
  github.createBlob.mockImplementation(async () => ({ data: { sha: `pushed-blob-${++blob}` } }));
  github.createTree.mockResolvedValue({ data: { sha: "pushed-tree" } });
  github.createCommit.mockResolvedValue({ data: { sha: "pushed-head" } });
  github.updateRef.mockResolvedValue({ data: {} });
}

async function setup(options: { proposalOverNote?: boolean } = {}) {
  resetAssistantSessionIndex(null);
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView = vi.fn();
  linked = await createLinkedBookClone({ token: "ghp_real_token", files: [{ path: "book.md", content: "---\ntype: book\nid: book\ntitle: Jesus\n---\n" }, { path: "ghostwriters/classic.md", content: CLASSIC }, { path: "outline/book.md", content: SYNOPSIS }, { path: "notes/note.md", content: NOTE }] });
  // The long-paste import of the Synopsis: a local commit GitHub does not have, and an edit of the author's that is not a commit.
  const snapshot = await captureImmediateMutation({ token: linked.token, book: linked.book, branch: "main", path: "outline/book.md" });
  await commitImmediateMutation({ token: linked.token, book: linked.book, branch: "main", snapshot, content: `${SYNOPSIS}\nImported.\n`, message: "Import the Synopsis" });
  await mutateLocalTextFilesAtomically(linked.meta.id, scope(), [{ path: "notes/note.md", content: NOTE_EDITED }]);
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [linked.book] } });
  const session = createEmptyAssistantSession("Ghostwriters");
  const message = await proposal();
  if (options.proposalOverNote) {
    message.action = { ...message.action!, updates: [...(message.action as { updates: unknown[] }).updates, { path: "notes/note.md", content: "# Note\n\nThe Copilot's line.\n" }], sourceRevisions: { ...(message.action as { sourceRevisions: object }).sourceRevisions, "notes/note.md": await sha256Text(NOTE) } } as never;
  }
  session.messages = [{ id: "ask", role: "user", text: "make the classic ghostwriter warmer, add a modern one" }, message];
  useAssistantStore.setState({ open: true, busy: false, sessions: [], sessionAccountIdentity: null, sessionsLoading: false, currentSession: session });
}

beforeEach(async () => { toasts.length = 0; await resetLocalWorkspace(); await i18n.changeLanguage("en"); });
afterEach(async () => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); useRepositorySyncStore.getState().setConflict(null); await i18n.changeLanguage("en"); });

const status = async () => (await getLocalRepositoryStatusSnapshot(linked.book.owner, linked.book.repo, "main", localWorkspaceScope()))!.status;
const mount = () => render(<MemoryRouter initialEntries={[`/app/books/${linked.book.id}/ghostwriters`]}><AssistantPanel /></MemoryRouter>);

describe.each([["en"], ["it"]] as const)("applying a page proposal of the Copilot on a book with work not sent yet, in %s", (language) => {
  beforeEach(async () => { await i18n.changeLanguage(language); });

  it("applies it, sends it with the rest by the sync, says so, and undoes it the same way", async () => {
    await setup();
    githubUnchanged();
    expect(await status()).toMatchObject({ ahead: 1, dirty: 1 });
    mount();

    fireEvent.click(await screen.findByRole("button", { name: i18n.t("pageCopilot.review.apply") }));

    await waitFor(() => expect(github.updateRef).toHaveBeenCalled());
    const pushed = github.createTree.mock.calls[0][0] as { tree: Array<{ path: string }> };
    expect(pushed.tree.map((entry) => entry.path).sort()).toEqual(["ghostwriters/classic.md", "ghostwriters/modern.md", "notes/note.md", "outline/book.md"]);
    expect(github.updateRef.mock.calls.every(([call]) => (call as { force?: boolean }).force !== true)).toBe(true);
    await waitFor(async () => expect(await status()).toMatchObject({ ahead: 0, dirty: 0 }));
    expect(await getLocalFile(linked.meta.id, "ghostwriters/modern.md", scope())).toMatchObject({ text: MODERN_NEW });
    expect(await getLocalFile(linked.meta.id, "notes/note.md", scope())).toMatchObject({ text: NOTE_EDITED });
    // The author is told what was sent, in their language, and no raw error reaches them.
    const synced = i18n.t("copilotApply.appliedSynced", { count: 2 });
    await waitFor(() => expect(toasts.map((toast) => toast.title)).toContain(synced));
    expect(synced).toContain(language === "en" ? "Applied and synchronised: 1 change of yours and 2 earlier ones" : "Applicato e sincronizzato: 1 tua modifica e 2 precedenti");
    expect(JSON.stringify(toasts)).not.toMatch(/must be clean|Push or discard/);

    // Undo is a change like the others: saved on top and sent by the sync.
    github.updateRef.mockClear();
    github.createTree.mockClear();
    github.getRef.mockResolvedValue({ data: { object: { sha: "pushed-head" } } });
    // GitHub has the ghostwriter the apply sent, so that taking it back is a deletion it can make.
    github.getTree.mockResolvedValue({ data: { truncated: false, tree: ["ghostwriters/classic.md", "ghostwriters/modern.md", "outline/book.md", "notes/note.md"].map((path, index) => ({ path, type: "blob", sha: `blob-${index}` })) } });
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("pageCopilot.review.undo") }));
    await waitFor(() => expect(github.updateRef).toHaveBeenCalled());
    expect((github.createTree.mock.calls[0][0] as { tree: Array<{ path: string }> }).tree.map((entry) => entry.path).sort()).toEqual(["ghostwriters/classic.md", "ghostwriters/modern.md"]);
    expect(await getLocalFile(linked.meta.id, "ghostwriters/classic.md", scope())).toMatchObject({ text: CLASSIC });
  }, 60_000);

  it("is applied and kept on this device when GitHub cannot be reached, and says what to do", async () => {
    await setup();
    github.getRef.mockRejectedValue(new TypeError("Failed to fetch"));
    mount();

    fireEvent.click(await screen.findByRole("button", { name: i18n.t("pageCopilot.review.apply") }));

    await waitFor(() => expect(toasts.map((toast) => toast.description)).toContain(i18n.t("copilotApply.saved.unreachable")));
    expect(toasts.every((toast) => toast.variant !== "destructive")).toBe(true);
    expect(await getLocalFile(linked.meta.id, "ghostwriters/modern.md", scope())).toMatchObject({ text: MODERN_NEW });
    expect(github.updateRef).not.toHaveBeenCalled();
    expect(screen.queryByText(/must be clean|Push or discard/)).toBeNull();
    expect((await listDirtyLocalFiles(linked.meta.id)).map((file) => file.path)).toEqual(["notes/note.md"]);
  }, 60_000);

  it("stops on a file that has edits made after the proposal, shows it and lets the author choose: keep mine, or use the proposal", async () => {
    await setup({ proposalOverNote: true });
    githubUnchanged();
    // The author edited the note after the Copilot proposed a change to it: the one real conflict at apply time.
    mount();
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("pageCopilot.review.apply") }));

    const choice = await screen.findByRole("group", { name: i18n.t("copilotApply.conflictChoice.title") });
    expect(within(choice).getByText(i18n.t("copilotApply.conflictChoice.local-edits", { file: "notes/note.md" }))).toBeInTheDocument();
    expect(github.updateRef, "nothing was written").not.toHaveBeenCalled();
    expect(await getLocalFile(linked.meta.id, "notes/note.md", scope())).toMatchObject({ text: NOTE_EDITED });
    expect(await getLocalFile(linked.meta.id, "ghostwriters/modern.md", scope())).toBeNull();

    fireEvent.click(within(choice).getByRole("button", { name: i18n.t("copilotApply.conflictChoice.useProposalFor", { file: "notes/note.md" }) }));
    await waitFor(() => expect(github.updateRef).toHaveBeenCalled());
    expect(await getLocalFile(linked.meta.id, "notes/note.md", scope())).toMatchObject({ text: "# Note\n\nThe Copilot's line.\n" });
    await waitFor(() => expect(screen.queryByRole("group", { name: i18n.t("copilotApply.conflictChoice.title") })).toBeNull());
  }, 60_000);

  it("keeps the author's version when asked to: the proposal is not applied, and nothing is lost", async () => {
    await setup({ proposalOverNote: true });
    githubUnchanged();
    mount();
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("pageCopilot.review.apply") }));
    const choice = await screen.findByRole("group", { name: i18n.t("copilotApply.conflictChoice.title") });

    fireEvent.click(within(choice).getByRole("button", { name: i18n.t("copilotApply.conflictChoice.keepMineFor", { file: "notes/note.md" }) }));

    expect(await screen.findAllByText(i18n.t("copilotApply.conflictChoice.keptOne", { file: "notes/note.md" }))).not.toHaveLength(0);
    expect(github.updateRef).not.toHaveBeenCalled();
    expect(await getLocalFile(linked.meta.id, "notes/note.md", scope())).toMatchObject({ text: NOTE_EDITED });
  }, 60_000);
});
