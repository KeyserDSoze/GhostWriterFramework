import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/repository/repositoryService", async (importOriginal) => ({ ...await importOriginal<typeof import("@/repository/repositoryService")>(), pushLocalCommits: push.fn }));

import { planPagesWorkflowUpgrade } from "narrarium-astro-reader/github-pages";
import { PAGES_WORKFLOW_PATH } from "@/github/bookRepository";
import { loadBookTemplate } from "@/narrarium/bookTemplate";
import { getLocalFile, listUnpushedLocalCommits, markLocalCommitsPushed } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { applyReaderUpdate, openReaderUpdatePullRequest } from "@/readerUpdate/apply";
import { inspectReaderUpdate, type ReaderUpdateInspection } from "@/readerUpdate/inspect";
import { forgetPublishingBranchReads } from "@/readerUpdate/publishingBranch";
import { blockNetwork, createLinkedBookClone, resetLocalWorkspace, type LocalFirstBook } from "./helpers/localFirst";
import { createFakeBranchGitHub, type FakeBranchGitHub } from "./helpers/fakeBranchGitHub";
import v1 from "./fixtures/pagesWorkflowV1.yml?raw";

// The update of the reader when the author works on a branch that is not the one the workflow publishes from (2026-11-27, the owner's book): it has to land on
// the publishing branch too, on GitHub, as one commit that is moved forward without force, and on the branch of the author, so that the two carry the same files.

const BOOK_FILES = [
  { path: "book.md", content: "---\ntype: book\ntitle: Jesus\n---\n" },
  { path: "chapters/001/chapter.md", content: "---\ntype: chapter\ntitle: The Road\n---\nIt began.\n" },
];
const NEWER = [/^reader\/src\/lib\/ereader\//, /^reader\/src\/lib\/reader-/, /^reader\/src\/pages\/book\//, /^reader\/src\/pages\/content\//, /^reader\/src\/pages\/version\.json\.ts$/, /^reader\/src\/styles\/reader\.css$/];

async function oldFiles(): Promise<Array<{ path: string; content: string }>> {
  const template = await loadBookTemplate();
  const files: Array<{ path: string; content: string }> = [];
  for (const [path, file] of Object.entries(template.files)) {
    if (!path.startsWith("reader/") || NEWER.some((pattern) => pattern.test(path))) continue;
    const text = file.text.split(template.placeholders.readerPackage).join("jesus-reader");
    files.push({ path, content: /\/(components|layouts)\//.test(path) ? `${text}\n<!-- 0.1.50 -->\n` : text });
  }
  const pkg = files.find((file) => file.path === "reader/package.json")!;
  pkg.content = pkg.content.replace(/"narrarium": "[^"]+"/, '"narrarium": "^0.1.50"');
  return [...BOOK_FILES, ...files, { path: PAGES_WORKFLOW_PATH, content: v1 }];
}

const asRecord = (files: Array<{ path: string; content: string }>) => Object.fromEntries(files.map((file) => [file.path, file.content]));

let github: FakeBranchGitHub;
async function setup(options: { branch?: string; token?: string; mainFiles?: Array<{ path: string; content: string }> } = {}): Promise<LocalFirstBook> {
  const files = await oldFiles();
  github = createFakeBranchGitHub({ branch: "main", files: asRecord(options.mainFiles ?? files) });
  github.refs.set("feature/x", github.refs.get("main")!);
  return createLinkedBookClone({ owner: "keyser", repo: "jesus", branch: options.branch ?? "feature/x", token: options.token ?? "ghp_book", files });
}

const inspect = (local: LocalFirstBook, publishingBranch = "main"): Promise<ReaderUpdateInspection> => inspectReaderUpdate({ book: local.book, branch: local.branch, token: local.token, publishingBranch, octokit: github.octokit, loadTemplate: loadBookTemplate });
const asUpdate = (inspection: ReaderUpdateInspection) => {
  if (inspection.decision.kind !== "update") throw new Error(`expected an update, got ${inspection.decision.kind}`);
  return inspection.decision;
};
const apply = (local: LocalFirstBook, inspection: ReaderUpdateInspection) =>
  applyReaderUpdate({ book: local.book, branch: local.branch, token: local.token, update: asUpdate(inspection), workflowHash: inspection.workflowHash, replaceEdits: false, octokit: github.octokit });
const localText = async (local: LocalFirstBook, path: string) => (await getLocalFile(local.meta.id, path, captureRepositoryOperationScope()))?.text;

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

describe("the update of the reader from a branch that is not the publishing one", () => {
  it("reads what the publishing branch has on GitHub, names it, and plans the update there as well as on the working branch", async () => {
    const local = await setup();
    const decision = asUpdate(await inspect(local));
    expect(decision).toMatchObject({ currentNeeded: true, publishesFromBranch: false, publishing: { branch: "main", state: "old" }, publishingTarget: { branch: "main", source: "github", workflowChanges: true } });
    expect(decision.publishingTarget!.headSha).toBe(github.refs.get("main"));
    // Both branches get the same files: the plans are the same.
    expect(decision.publishingTarget!.folder.writes.map((file) => [file.path, file.content])).toEqual(decision.folder.writes.map((file) => [file.path, file.content]));
    expect(decision.publishingTarget!.workflow.text).toBe(planPagesWorkflowUpgrade(v1).text);
  }, 60_000);

  it("lands on main as ONE commit moved forward without force, and on the working branch, with the same files; a run follows the commit of main", async () => {
    const local = await setup();
    const before = github.refs.get("main")!;
    const inspection = await inspect(local);
    const outcome = await apply(local, inspection);

    const mainHead = github.refs.get("main")!;
    expect(mainHead).not.toBe(before);
    expect(github.commits.get(mainHead)!.parents).toEqual([before]);
    expect(github.calls.filter((call) => call.method === "createCommit")).toHaveLength(1);
    const updates = github.calls.filter((call) => call.method === "updateRef");
    expect(updates).toHaveLength(1);
    expect(updates[0].args).toMatchObject({ ref: "heads/main", sha: mainHead, force: false });
    // Nothing of the book was touched on main; the workflow and the reader files are the update.
    expect(github.filesOf("main").get("book.md")).toBe(BOOK_FILES[0].content);
    expect(github.filesOf("main").get(PAGES_WORKFLOW_PATH)).toBe(planPagesWorkflowUpgrade(v1).text);
    expect(github.refs.get("feature/x")).toBe(before);

    expect(outcome).toMatchObject({ published: true, publishedBranch: "main", commitSha: mainHead });
    expect(outcome.branches.map((entry) => [entry.branch, entry.role, entry.status])).toEqual([["main", "publishing", "published"], ["feature/x", "current", "published"]]);

    // The working branch has the same files as main, so a merge of one into the other has nothing to resolve.
    for (const write of asUpdate(inspection).folder.writes) {
      expect(github.filesOf("main").get(write.path)).toBe(write.content);
      expect(await localText(local, write.path)).toBe(write.content);
    }
    expect(await localText(local, PAGES_WORKFLOW_PATH)).toBe(github.filesOf("main").get(PAGES_WORKFLOW_PATH));
    expect(push.fn).toHaveBeenCalledTimes(1);
    expect(push.fn.mock.calls[0][0]).toMatchObject({ branch: "feature/x" });
  }, 60_000);

  it("is current everywhere after the update: the second check says up to date on both branches", async () => {
    const local = await setup();
    await apply(local, await inspect(local));
    forgetPublishingBranchReads();
    const again = await inspect(local);
    expect(again.decision).toMatchObject({ kind: "current", publishing: { branch: "main", state: "current" } });
  }, 60_000);

  it("updates only main when the working branch is already updated, and says what each branch has", async () => {
    const local = await setup();
    await apply(local, await inspect(local));
    // Someone resets main to the old files: the working branch has the update, main does not.
    const old = await oldFiles();
    github.commit("main", asRecord(old), "Back to the old reader");
    forgetPublishingBranchReads();
    const decision = asUpdate(await inspect(local));
    expect(decision).toMatchObject({ currentNeeded: false, publishing: { branch: "main", state: "old" } });
    expect(decision.publishingTarget).toBeTruthy();
    const outcome = await apply(local, await inspect(local));
    expect(outcome.branches.map((entry) => entry.role)).toEqual(["publishing"]);
    expect(outcome.published).toBe(true);
  }, 60_000);

  it("says it when main is protected, with GitHub's own words, still updates the working branch, and opens a pull request from a branch that carries the update", async () => {
    const local = await setup();
    github.protectedBranches.add("main");
    const before = github.refs.get("main")!;
    const inspection = await inspect(local);
    const outcome = await apply(local, inspection);

    expect(github.refs.get("main")).toBe(before);
    expect(outcome.published).toBe(false);
    expect(outcome.branches[0]).toMatchObject({ branch: "main", role: "publishing", status: "protected", githubMessage: expect.stringContaining("Changes must be made through a pull request") });
    expect(outcome.branches[1]).toMatchObject({ branch: "feature/x", status: "published" });
    expect(outcome.pullRequestOffer).toMatchObject({ base: "main", baseHeadSha: before });

    const pullRequest = await openReaderUpdatePullRequest({ book: local.book, token: local.token, offer: outcome.pullRequestOffer!, octokit: github.octokit, body: "Updates the reader.", });
    expect(pullRequest.url).toBe("https://github.com/o/r/pull/1");
    expect(pullRequest.branch).toMatch(/^narrarium\/update-reader-\d{8}$/);
    expect(github.refs.get("main")).toBe(before);
    const carried = github.refs.get(pullRequest.branch)!;
    expect(github.commits.get(carried)!.parents).toEqual([before]);
    expect(github.filesOf(pullRequest.branch).get(PAGES_WORKFLOW_PATH)).toBe(planPagesWorkflowUpgrade(v1).text);
    expect(github.pullRequests).toMatchObject([{ head: pullRequest.branch, base: "main" }]);
    for (const call of github.calls.filter((entry) => entry.method === "updateRef")) expect(call.args.force).toBe(false);
  }, 60_000);

  it("stays a local commit on the working branch when offline, and says main was not reached: on this device, not yet on main", async () => {
    const local = await setup();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const before = github.refs.get("main")!;
    const inspection = await inspect(local);
    expect(asUpdate(inspection)).toMatchObject({ publishing: { branch: "main", state: "unknown" }, delivery: "offline" });
    expect(asUpdate(inspection).publishingTarget).toBeUndefined();
    const outcome = await apply(local, inspection);
    expect(github.refs.get("main")).toBe(before);
    expect(github.calls.filter((call) => call.method === "createCommit")).toHaveLength(0);
    expect(outcome.published).toBe(false);
    expect(outcome.branches.map((entry) => [entry.branch, entry.status])).toEqual([["main", "pending"], ["feature/x", "local"]]);
    expect(push.fn).not.toHaveBeenCalled();
    expect(await listUnpushedLocalCommits(local.meta.id)).toHaveLength(1);
  }, 60_000);

  it("stays on this device without a credential, and reads nothing from GitHub", async () => {
    const network = blockNetwork();
    const local = await setup({ token: "" });
    const inspection = await inspect(local);
    expect(asUpdate(inspection)).toMatchObject({ publishing: { branch: "main", state: "unknown" }, delivery: "no-credential" });
    expect(github.calls).toEqual([]);
    expect(network.requests).toEqual([]);
    const outcome = await apply(local, inspection);
    expect(outcome.branches.map((entry) => [entry.branch, entry.status])).toEqual([["main", "pending"], ["feature/x", "local"]]);
  }, 60_000);

  it("writes nothing on main when its head moved after the check, and still updates the working branch", async () => {
    const local = await setup();
    const inspection = await inspect(local);
    const moved = github.commit("main", { "notes.md": "someone else\n" });
    const outcome = await apply(local, inspection);
    expect(github.refs.get("main")).toBe(moved);
    expect(github.filesOf("main").get(PAGES_WORKFLOW_PATH)).toBe(v1);
    expect(outcome.branches.map((entry) => [entry.branch, entry.status])).toEqual([["main", "changed"], ["feature/x", "published"]]);
  }, 60_000);

  it("takes the publishing branch from the repository, not from a list of names: «trunk» is the one, and «main» is a working branch like any other", async () => {
    const files = await oldFiles();
    github = createFakeBranchGitHub({ branch: "trunk", files: asRecord(files) });
    const local = await createLinkedBookClone({ owner: "keyser", repo: "jesus", branch: "main", token: "ghp_book", files });
    const decision = asUpdate(await inspectReaderUpdate({ book: local.book, branch: "main", token: local.token, publishingBranch: "trunk", octokit: github.octokit, loadTemplate: loadBookTemplate }));
    expect(decision).toMatchObject({ publishesFromBranch: false, publishing: { branch: "trunk", state: "old" }, publishingTarget: { branch: "trunk" } });
    const outcome = await applyReaderUpdate({ book: local.book, branch: "main", token: local.token, update: decision, workflowHash: (await inspectReaderUpdate({ book: local.book, branch: "main", token: local.token, publishingBranch: "trunk", octokit: github.octokit, loadTemplate: loadBookTemplate })).workflowHash, replaceEdits: false, octokit: github.octokit });
    expect(outcome).toMatchObject({ publishedBranch: "trunk", published: true });
    expect(github.filesOf("trunk").get(PAGES_WORKFLOW_PATH)).toBe(planPagesWorkflowUpgrade(v1).text);
  }, 60_000);

  it("is the old single-branch update, with nothing read from the publishing side, when the working branch IS the publishing one", async () => {
    const local = await setup({ branch: "main" });
    const decision = asUpdate(await inspect(local, "main"));
    expect(decision).toMatchObject({ publishesFromBranch: true, currentNeeded: true });
    expect(decision.publishing).toBeUndefined();
    expect(decision.publishingTarget).toBeUndefined();
    expect(github.calls).toEqual([]);
  }, 60_000);
});
