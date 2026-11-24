import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/repository/repositoryService", async (importOriginal) => ({ ...await importOriginal<typeof import("@/repository/repositoryService")>(), pushLocalCommits: push.fn }));

import { planPagesWorkflowUpgrade } from "narrarium-astro-reader/github-pages";
import { updateFile } from "@/github/githubClient";
import { PAGES_WORKFLOW_PATH } from "@/github/bookRepository";
import { loadBookTemplate } from "@/narrarium/bookTemplate";
import { getLocalFile, listUnpushedLocalCommits, markLocalCommitsPushed } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { RepositoryConflictError } from "@/repository/safeRepositoryMutation";
import { applyReaderUpdate } from "@/readerUpdate/apply";
import { CustomizedWorkflowRefused } from "@/readerUpdate/commit";
import { inspectReaderUpdate, type ReaderUpdateInspection } from "@/readerUpdate/inspect";
import { markGitHubCredentialRejected } from "@/github/remoteAvailability";
import { blockNetwork, createLinkedBookClone, createLocalOnlyBook, resetLocalWorkspace, type LocalFirstBook } from "./helpers/localFirst";
import v1 from "./fixtures/pagesWorkflowV1.yml?raw";

// The update of an old reader, on a book with the structure of one published with a password and an old reader: the v1 workflow that passes
// NARRARIUM_READER_PASSWORD, a reader/ folder from before the key slots, the author's own chapters. The template is the real snapshot of the site.

const BOOK_FILES = [
  { path: "book.md", content: "---\ntype: book\ntitle: Jesus\n---\n" },
  { path: "chapters/001/chapter.md", content: "---\ntype: chapter\ntitle: The Road\n---\nIt began.\n" },
  { path: "canon/characters/mary.md", content: "---\ntype: character\nname: Mary\n---\n" },
  { path: "package.json", content: '{"name":"jesus","private":true}\n' },
];
const LEGACY_WORKFLOW = v1.replace("          SITE_BASE:", "          NARRARIUM_READER_PASSWORD: ${{ secrets.BOOK_PASSWORD }}\n          SITE_BASE:");
// What the reader gained since the old one: the files the old reader did not have.
const NEWER = [/^reader\/src\/lib\/ereader\//, /^reader\/src\/lib\/reader-/, /^reader\/src\/pages\/book\//, /^reader\/src\/pages\/content\//, /^reader\/src\/pages\/version\.json\.ts$/, /^reader\/src\/styles\/reader\.css$/, /^reader\/scripts\/reader-output\.mjs$/];

async function oldReaderFiles(): Promise<Array<{ path: string; content: string }>> {
  const template = await loadBookTemplate();
  const files: Array<{ path: string; content: string }> = [];
  for (const [path, file] of Object.entries(template.files)) {
    if (!path.startsWith("reader/") || NEWER.some((pattern) => pattern.test(path))) continue;
    const text = file.text.split(template.placeholders.readerPackage).join("jesus-reader");
    files.push({ path, content: /\/(components|layouts)\//.test(path) ? `${text}\n<!-- 0.1.50 -->\n` : text });
  }
  const pkg = files.find((file) => file.path === "reader/package.json")!;
  pkg.content = pkg.content.replace(/"narrarium": "[^"]+"/, '"narrarium": "^0.1.50"');
  return files;
}

async function jesus(options: { token?: string; workflow?: string } = {}): Promise<LocalFirstBook> {
  return createLinkedBookClone({ owner: "keyser", repo: "jesus", token: options.token, files: [...BOOK_FILES, ...await oldReaderFiles(), { path: PAGES_WORKFLOW_PATH, content: options.workflow ?? LEGACY_WORKFLOW }] });
}

const inspect = (local: LocalFirstBook, remote?: Parameters<typeof inspectReaderUpdate>[0]["remote"]) => inspectReaderUpdate({ book: local.book, branch: local.branch, token: local.token, remote, loadTemplate: loadBookTemplate });
const asUpdate = (inspection: ReaderUpdateInspection) => {
  if (inspection.decision.kind !== "update") throw new Error(`expected an update, got ${inspection.decision.kind}`);
  return inspection.decision;
};
const apply = (local: LocalFirstBook, inspection: ReaderUpdateInspection, replaceEdits = false) =>
  applyReaderUpdate({ book: local.book, branch: local.branch, token: local.token, update: asUpdate(inspection), workflowHash: inspection.workflowHash, replaceEdits });

const text = async (local: LocalFirstBook, path: string) => (await getLocalFile(local.meta.id, path, captureRepositoryOperationScope()))?.text;

beforeEach(async () => {
  await resetLocalWorkspace();
  push.fn.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("a book published with a password and an old reader", () => {
  it("is found out of date from the working copy alone, and says it exposes the book", async () => {
    const network = blockNetwork();
    const local = await jesus();
    const decision = asUpdate(await inspect(local));
    expect(decision).toMatchObject({ exposure: "password-old-reader", workflowChanges: true, customized: false, delivery: "no-credential", publishesFromBranch: true });
    expect(decision.workflow.settings.legacyPasswordSecret).toBe("BOOK_PASSWORD");
    expect(decision.folder.writes.filter((file) => file.change === "added").map((file) => file.path)).toContain("reader/src/lib/reader-passwords.ts");
    expect(decision.folder.writes.filter((file) => file.change === "replaced").length).toBeGreaterThan(0);
    expect(network.requests).toEqual([]);
  }, 60_000);

  it("is updated in ONE local commit with the workflow and the reader's files, never the book's own, and the second check says current", async () => {
    const network = blockNetwork();
    const local = await jesus();
    const inspection = await inspect(local);
    const decision = asUpdate(inspection);

    const outcome = await apply(local, inspection);
    expect(outcome.published).toBe(false);
    const commits = await listUnpushedLocalCommits(local.meta.id);
    expect(commits).toHaveLength(1);
    const expected = [PAGES_WORKFLOW_PATH, ...decision.folder.writes.map((file) => file.path)].sort();
    expect(commits[0].files.map((file) => file.path).sort()).toEqual(expected);
    expect(commits[0].files.every((file) => file.path === PAGES_WORKFLOW_PATH || file.path.startsWith("reader/"))).toBe(true);
    expect(commits[0].message.split("\n")[0]).toMatch(/^Update the reader to version \d+\.\d+\.\d+$/);

    expect(await text(local, PAGES_WORKFLOW_PATH)).toBe(planPagesWorkflowUpgrade(LEGACY_WORKFLOW).text);
    expect(await text(local, PAGES_WORKFLOW_PATH)).toContain("NARRARIUM_READER_PASSWORD: ${{ secrets.BOOK_PASSWORD }}");
    expect(await text(local, "chapters/001/chapter.md")).toBe(BOOK_FILES[1].content);
    expect(await text(local, "book.md")).toBe(BOOK_FILES[0].content);
    expect(JSON.parse((await text(local, "reader/package.json"))!)).toMatchObject({ name: "jesus-reader", dependencies: { narrarium: expect.not.stringContaining("0.1.50") } });

    const again = await inspect(local);
    expect(again.decision).toMatchObject({ kind: "current" });
    expect(network.requests).toEqual([]);
    expect(push.fn).not.toHaveBeenCalled();
  }, 60_000);

  it("publishes the commit with the book's credential when it is online and has one, and the commit is no longer waiting", async () => {
    const local = await jesus({ token: "ghp_book" });
    push.fn.mockImplementation(async (input: { repoId: string }) => {
      const commits = await listUnpushedLocalCommits(input.repoId);
      await markLocalCommitsPushed(input.repoId, captureRepositoryOperationScope(), commits.map((commit) => commit.id), "remote-sha", {});
      return { commitSha: "remote-sha" };
    });
    const inspection = await inspect(local);
    expect(asUpdate(inspection).delivery).toBe("now");
    const outcome = await apply(local, inspection);
    expect(outcome).toMatchObject({ published: true, commitSha: "remote-sha" });
    expect(push.fn).toHaveBeenCalledTimes(1);
    expect(push.fn.mock.calls[0][0]).toMatchObject({ token: "ghp_book", owner: "keyser", repo: "jesus", branch: "main" });
    expect(await listUnpushedLocalCommits(local.meta.id)).toEqual([]);
  }, 60_000);

  it("stays a local commit when the device is offline, and says it publishes at the next sync", async () => {
    const local = await jesus({ token: "ghp_book" });
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const inspection = await inspect(local);
    expect(asUpdate(inspection).delivery).toBe("offline");
    const outcome = await apply(local, inspection);
    expect(outcome.published).toBe(false);
    expect(push.fn).not.toHaveBeenCalled();
    expect(await listUnpushedLocalCommits(local.meta.id)).toHaveLength(1);
  }, 60_000);

  it("stays a local commit when GitHub refused the book's credential, exactly as without one, and says it publishes at the next sync", async () => {
    const local = await jesus({ token: "ghp_refused_by_github" });
    markGitHubCredentialRejected("ghp_refused_by_github");
    const inspection = await inspect(local);
    expect(asUpdate(inspection).delivery).toBe("no-credential");
    const outcome = await apply(local, inspection);
    expect(outcome.published).toBe(false);
    expect(push.fn).not.toHaveBeenCalled();
    expect(await listUnpushedLocalCommits(local.meta.id)).toHaveLength(1);
  }, 60_000);

  it("waits for the next sync, together with the changes of its own, when the book has other changes not published yet", async () => {
    const local = await jesus({ token: "ghp_book" });
    const current = await getLocalFile(local.meta.id, "book.md", captureRepositoryOperationScope());
    await updateFile(local.token, "keyser", "jesus", local.branch, "book.md", current!.currentHash, "---\ntype: book\ntitle: Jesus, again\n---\n", "Edit the book");
    const inspection = await inspect(local);
    expect(asUpdate(inspection).delivery).toBe("local-changes");
    const outcome = await apply(local, inspection);
    expect(outcome.published).toBe(false);
    expect(push.fn).not.toHaveBeenCalled();
  }, 60_000);

  it("refuses a workflow with edits unless the owner says «replace my edits», and then writes the standard one", async () => {
    const edited = `${planPagesWorkflowUpgrade(LEGACY_WORKFLOW).text}\n  notify:\n    runs-on: ubuntu-latest\n`;
    const local = await jesus({ workflow: edited });
    const inspection = await inspect(local);
    const decision = asUpdate(inspection);
    expect(decision.customized).toBe(true);
    expect(decision.workflow.customizations.some((line) => line.includes("notify"))).toBe(true);

    await expect(apply(local, inspection, false)).rejects.toBeInstanceOf(CustomizedWorkflowRefused);
    expect(await listUnpushedLocalCommits(local.meta.id)).toEqual([]);
    expect(await text(local, PAGES_WORKFLOW_PATH)).toBe(edited);

    await apply(local, inspection, true);
    expect(await text(local, PAGES_WORKFLOW_PATH)).toBe(planPagesWorkflowUpgrade(edited).text);
    expect(await text(local, PAGES_WORKFLOW_PATH)).not.toContain("notify");
  }, 60_000);

  it("commits nothing when a file changed after it was checked", async () => {
    const local = await jesus();
    const inspection = await inspect(local);
    const file = asUpdate(inspection).folder.writes.find((candidate) => candidate.change === "replaced")!;
    const current = await getLocalFile(local.meta.id, file.path, captureRepositoryOperationScope());
    await updateFile(local.token, "keyser", "jesus", local.branch, file.path, current!.currentHash, "edited by hand", "Edit");
    await expect(apply(local, inspection)).rejects.toBeInstanceOf(RepositoryConflictError);
    expect(await listUnpushedLocalCommits(local.meta.id)).toEqual([]);
  }, 60_000);

  it("commits nothing when the workflow changed after it was checked", async () => {
    const local = await jesus();
    const inspection = await inspect(local);
    const current = await getLocalFile(local.meta.id, PAGES_WORKFLOW_PATH, captureRepositoryOperationScope());
    await updateFile(local.token, "keyser", "jesus", local.branch, PAGES_WORKFLOW_PATH, current!.currentHash, `${LEGACY_WORKFLOW}# edited\n`, "Edit");
    await expect(apply(local, inspection)).rejects.toBeInstanceOf(RepositoryConflictError);
    expect(await listUnpushedLocalCommits(local.meta.id)).toEqual([]);
  }, 60_000);

  it("is left alone on a branch that the workflow does not publish from, and says so", async () => {
    const local = await createLinkedBookClone({ owner: "keyser", repo: "jesus", branch: "draft", files: [...BOOK_FILES, ...await oldReaderFiles(), { path: PAGES_WORKFLOW_PATH, content: LEGACY_WORKFLOW }] });
    expect(asUpdate(await inspect(local))).toMatchObject({ publishesFromBranch: false });
  }, 60_000);
});

describe("a book that is not on GitHub or has no reader", () => {
  it("is a local book: nothing to update, and nothing is read from GitHub", async () => {
    const network = blockNetwork();
    const local = await createLocalOnlyBook();
    expect((await inspect(local)).decision).toEqual({ kind: "local-only" });
    expect(network.requests).toEqual([]);
  });

  it("has nothing to update when its repository has no workflow and no reader/ folder", async () => {
    const local = await createLinkedBookClone({ owner: "keyser", repo: "plain", files: BOOK_FILES });
    expect((await inspect(local)).decision).toEqual({ kind: "not-published" });
  }, 60_000);

  it("cannot be checked when the branch has no working copy on this device", async () => {
    const local = await jesus();
    const other = { ...local.book, owner: "someone", repo: "else" };
    const inspection = await inspectReaderUpdate({ book: other, branch: "main", token: "", loadTemplate: loadBookTemplate });
    expect(inspection.decision).toEqual({ kind: "no-working-copy" });
  }, 60_000);
});
