import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/repository/repositoryService", async (importOriginal) => ({ ...await importOriginal<typeof import("@/repository/repositoryService")>(), pushLocalCommits: push.fn }));

import { planPagesWorkflowUpgrade } from "narrarium-astro-reader/github-pages";
import { PAGES_WORKFLOW_PATH } from "@/github/bookRepository";
import { loadBookTemplate } from "@/narrarium/bookTemplate";
import { getLocalFile, listUnpushedLocalCommits, markLocalCommitsPushed } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { applyReaderUpdate } from "@/readerUpdate/apply";
import { decideReaderUpdate, type ReaderUpdateInputs } from "@/readerUpdate/decision";
import { inspectReaderUpdate, type ReaderUpdateInspection } from "@/readerUpdate/inspect";
import { forgetPublishingBranchReads } from "@/readerUpdate/publishingBranch";
import { inspectReaderWorkflow } from "@/readerAccess/workflowPlan";
import { createLinkedBookClone, resetLocalWorkspace, type LocalFirstBook } from "./helpers/localFirst";
import { createFakeBranchGitHub, type FakeBranchGitHub } from "./helpers/fakeBranchGitHub";
import v2 from "./fixtures/pagesWorkflowV2.yml?raw";

// The workflow of version 2 hands the build step every secret of the repository as JSON (toJSON(secrets)), and GitHub can hold such a file at «Action required»
// (the owner's book, run #318, 2026-11-27). «Update the reader» replaces it with version 3, which names only the password slots, and says why.

const V3 = planPagesWorkflowUpgrade(v2).text;
const BOOK_FILES = [
  { path: "book.md", content: "---\ntype: book\ntitle: Jesus\n---\n" },
  { path: "chapters/001/chapter.md", content: "---\ntype: chapter\ntitle: The Road\n---\nIt began.\n" },
];

/** The files of a book whose reader folder is the current one and whose workflow is the given one: the only thing old is the workflow. */
async function files(workflow: string): Promise<Array<{ path: string; content: string }>> {
  const template = await loadBookTemplate();
  const reader = Object.entries(template.files).filter(([path]) => path.startsWith("reader/")).map(([path, file]) => ({ path, content: file.text.split(template.placeholders.readerPackage).join("jesus-reader") }));
  return [...BOOK_FILES, ...reader, { path: PAGES_WORKFLOW_PATH, content: workflow }];
}

describe("what the update knows of the workflow it replaces", () => {
  it("recognizes version 2 as the package's own workflow, that reads the passwords and is only older", () => {
    const plan = planPagesWorkflowUpgrade(v2);
    expect(plan).toMatchObject({ status: "generated", safe: true, fromVersion: 2 });
    expect(plan.text).not.toContain("toJSON");
    expect(plan.changes[0]).toContain("toJSON(secrets)");
    expect(inspectReaderWorkflow(v2)).toBe("previous");
    expect(inspectReaderWorkflow(V3)).toBe("current");
    // The workflow before the passwords with several slots does not read them: it is «outdated», not «previous».
    expect(inspectReaderWorkflow(v2.replace(/.*READER_PASSWORD_SECRETS.*\n/g, "").replace(/.*toJSON.*\n/g, ""))).not.toBe("previous");
  });

  const base: ReaderUpdateInputs = { storage: "github", workingCopy: true, workflowText: v2, folder: { present: true, writes: [], deletes: [], unchanged: 70, kept: [], version: "0.1.62" }, branch: "main", online: true, credential: true, localChanges: false };

  it("offers the update when only the workflow is version 2, and says it is not an exposure of the book: the reader is current", () => {
    const decision = decideReaderUpdate({ ...base, remote: { pagesOn: true, passwordsSet: true } });
    expect(decision).toMatchObject({ kind: "update", workflowChanges: true, exposure: "workflow-v2", workflow: { fromVersion: 2 } });
    // With an old reader as well, the old reader's exposure is the one said.
    const withOldReader = decideReaderUpdate({ ...base, folder: { ...base.folder!, writes: [{ path: "reader/src/lib/book.ts", content: "new", change: "replaced", expectedHash: "h" }] }, remote: { pagesOn: true, passwordsSet: true } });
    expect(withOldReader).toMatchObject({ kind: "update", exposure: "password-old-reader" });
    expect(decideReaderUpdate({ ...base, remote: { pagesOn: false, passwordsSet: true } })).toMatchObject({ exposure: "not-published" });
  });

  it("is current, with nothing to say, once the workflow is version 3", () => {
    expect(decideReaderUpdate({ ...base, workflowText: V3 })).toMatchObject({ kind: "current" });
  });

  it("says «previous» for a workflow on GitHub that is still version 2 when the working copy has the update, and is never «up to date» then", () => {
    const decision = decideReaderUpdate({ ...base, workflowText: V3, remote: { pagesOn: true, passwordsSet: true, workflowText: v2 } });
    expect(decision).toMatchObject({ kind: "on-device", reason: "remote-differs", remoteWorkflow: "previous", exposure: "workflow-v2" });
  });
});

let github: FakeBranchGitHub;
beforeEach(async () => {
  await resetLocalWorkspace();
  forgetPublishingBranchReads();
  push.fn.mockReset().mockImplementation(async (input: { repoId: string }) => {
    const commits = await listUnpushedLocalCommits(input.repoId);
    await markLocalCommitsPushed(input.repoId, captureRepositoryOperationScope(), commits.map((commit) => commit.id), "remote-sha", {});
    return { commitSha: "remote-sha" };
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const asRecord = (list: Array<{ path: string; content: string }>) => Object.fromEntries(list.map((file) => [file.path, file.content]));
const asUpdate = (inspection: ReaderUpdateInspection) => {
  if (inspection.decision.kind !== "update") throw new Error(`expected an update, got ${inspection.decision.kind}`);
  return inspection.decision;
};
const inspect = (local: LocalFirstBook, publishingBranch?: string) => inspectReaderUpdate({ book: local.book, branch: local.branch, token: local.token, ...(publishingBranch ? { publishingBranch } : {}), octokit: github?.octokit, loadTemplate: loadBookTemplate });
const apply = (local: LocalFirstBook, inspection: ReaderUpdateInspection) => applyReaderUpdate({ book: local.book, branch: local.branch, token: local.token, update: asUpdate(inspection), workflowHash: inspection.workflowHash, replaceEdits: false, octokit: github?.octokit });

describe("the upgrade of version 2 to version 3 with the book on this device and GitHub stubbed", () => {
  it("commits ONLY the workflow, replaced by version 3, and the second check says current: nothing else of the book or the reader is touched", async () => {
    const local = await createLinkedBookClone({ owner: "keyser", repo: "jesus", token: "ghp_book", files: await files(v2) });
    const inspection = await inspect(local);
    const decision = asUpdate(inspection);
    expect(decision).toMatchObject({ workflowChanges: true, exposure: "workflow-v2", folder: { writes: [], deletes: [] } });
    const outcome = await apply(local, inspection);
    expect(outcome.paths).toEqual([PAGES_WORKFLOW_PATH]);
    expect(outcome.published).toBe(true);
    const commit = (await listUnpushedLocalCommits(local.meta.id));
    expect(commit).toEqual([]);
    const text = (await getLocalFile(local.meta.id, PAGES_WORKFLOW_PATH, captureRepositoryOperationScope()))?.text ?? "";
    expect(text).toBe(V3);
    expect(text).not.toContain("toJSON(secrets)");
    expect(text).toContain("READER_PASSWORD_001: ${{ secrets.READER_PASSWORD_001 }}");
    expect(text).toContain("READER_PASSWORD_024: ${{ secrets.READER_PASSWORD_024 }}");
    expect((await inspect(local)).decision).toMatchObject({ kind: "current" });
  }, 60_000);

  it("keeps the single older password of a book whose workflow had it, in version 3", async () => {
    const legacy = v2.replace("          READER_PASSWORD_SECRETS:", "          NARRARIUM_READER_PASSWORD: ${{ secrets.BOOK_PASSWORD }}\n          READER_PASSWORD_SECRETS:");
    const local = await createLinkedBookClone({ owner: "keyser", repo: "jesus", token: "", files: await files(legacy) });
    const decision = asUpdate(await inspect(local));
    expect(decision.workflow.fromVersion).toBe(2);
    expect(decision.workflow.text).toContain("NARRARIUM_READER_PASSWORD: ${{ secrets.BOOK_PASSWORD }}");
    expect(decision.workflow.text).not.toContain("toJSON");
  }, 60_000);

  it("upgrades the workflow on the publishing branch (main) on GitHub, as one commit, and on the working branch, with the same text", async () => {
    const list = await files(v2);
    github = createFakeBranchGitHub({ branch: "main", files: asRecord(list) });
    github.refs.set("feature/x", github.refs.get("main")!);
    const local = await createLinkedBookClone({ owner: "keyser", repo: "jesus", branch: "feature/x", token: "ghp_book", files: list });
    const inspection = await inspect(local, "main");
    const decision = asUpdate(inspection);
    expect(decision).toMatchObject({ publishing: { branch: "main", state: "old" }, publishingTarget: { branch: "main", workflowChanges: true, workflow: { fromVersion: 2 } }, exposure: "workflow-v2" });
    expect(decision.publishingTarget?.folder.writes).toEqual([]);
    const before = github.refs.get("main")!;
    const outcome = await apply(local, inspection);
    expect(outcome).toMatchObject({ published: true, publishedBranch: "main" });
    const mainHead = github.refs.get("main")!;
    expect(github.commits.get(mainHead)!.parents).toEqual([before]);
    expect(github.filesOf("main").get(PAGES_WORKFLOW_PATH)).toBe(V3);
    expect(github.filesOf("main").get(PAGES_WORKFLOW_PATH)).not.toContain("toJSON");
    expect((await getLocalFile(local.meta.id, PAGES_WORKFLOW_PATH, captureRepositoryOperationScope()))?.text).toBe(V3);
    // Only the workflow differs between the commit and its parent.
    const parent = github.commits.get(before)!.files;
    const changed = [...github.filesOf("main")].filter(([path, content]) => parent.get(path) !== content).map(([path]) => path);
    expect(changed).toEqual([PAGES_WORKFLOW_PATH]);
  }, 60_000);
});
