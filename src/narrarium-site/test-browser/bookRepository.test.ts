import { describe, expect, it } from "vitest";
import {
  BookRepositoryError,
  BOOTSTRAP_MESSAGE,
  PAGES_WORKFLOW_PATH,
  TREE_CHUNK_MAX_BYTES,
  TREE_CHUNK_MAX_ENTRIES,
  createCompleteBookRepository,
  deleteEmptyBookRepository,
  gitBlobSha,
  isWorkflowPath,
  preflightBookRepository,
  repositoryNameProblem,
  type BookRepositoryFile,
  type CreateCompleteBookRepositoryInput,
} from "@/github/bookRepository";
import { createFakeGitHub, type FakeGitHub, type FakeGitHubOptions } from "./helpers/fakeGitHub";

// The creation of a complete book repository, against a fake GitHub (nothing here reaches the network or reads a token): the order of the calls, what lands
// in each commit, and what the service does with every refusal a token or an account can give.

const WORKFLOW = "name: Deploy Reader To GitHub Pages\non: push\n";
const RATE_LIMIT = { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000" };

function book(extra: BookRepositoryFile[] = []): BookRepositoryFile[] {
  return [
    { path: "README.md", content: "# The Glass Harbor\n" },
    { path: "book.md", content: "---\ntype: book\n---\n" },
    { path: "reader/package.json", content: "{}\n" },
    { path: "reader/.github/workflows/deploy-pages.yml", content: "name: Not run\n" },
    { path: PAGES_WORKFLOW_PATH, content: WORKFLOW },
    ...extra,
  ];
}

function manyFiles(count: number): BookRepositoryFile[] {
  return Array.from({ length: count }, (_, index) => ({ path: `chapters/${String(index).padStart(4, "0")}.md`, content: `Chapter ${index}\n` }));
}

function run(fake: FakeGitHub, input: Partial<CreateCompleteBookRepositoryInput> = {}) {
  return createCompleteBookRepository({ token: "never-used", octokit: fake.octokit, name: "book-glass-harbor", files: book(), ...input });
}

const fail = async (promise: Promise<unknown>): Promise<BookRepositoryError> => {
  try { await promise; } catch (error) { expect(error).toBeInstanceOf(BookRepositoryError); return error as BookRepositoryError; }
  throw new Error("It should have failed.");
};

const sizeOfTree = (call: { params: Record<string, unknown> }) => JSON.stringify(call.params.tree).length;

describe("createCompleteBookRepository: the sequence", () => {
  it("makes a private repository for the user, with every file but the workflows in a first commit with no parent, then the workflow alone in a second", async () => {
    const fake = createFakeGitHub();
    const result = await run(fake, { description: "Narrarium book: The Glass Harbor" });

    expect(result).toMatchObject({ owner: "ada", repo: "book-glass-harbor", defaultBranch: "main", private: true, htmlUrl: "https://github.com/ada/book-glass-harbor", workflow: "done", pages: "skipped", firstCommitPath: "direct", createdRepository: true, warnings: [], pendingWorkflow: [] });
    expect(fake.names()).toEqual([
      "users.getAuthenticated", "repos.get", "repos.createForAuthenticatedUser",
      "git.createTree", "git.createCommit", "git.createRef",
      "git.createTree", "git.createCommit", "git.updateRef",
    ]);
    const create = fake.calls.find((call) => call.name === "repos.createForAuthenticatedUser")!.params;
    expect(create).toMatchObject({ name: "book-glass-harbor", private: true, auto_init: false, description: "Narrarium book: The Glass Harbor" });
    const history = fake.history("ada", "book-glass-harbor");
    expect(history.map((commit) => commit.message)).toEqual(["Add the GitHub Pages workflow", "Initialize Narrarium book"]);
    expect(history[1].parents).toEqual([]);
    expect(history[0].parents).toEqual([history[1].sha]);
    expect(fake.calls.find((call) => call.name === "git.createCommit")!.params.parents).toEqual([]);
    expect(fake.calls.filter((call) => call.name === "git.updateRef").map((call) => call.params.force)).toEqual([false]);
    const files = fake.filesAt("ada", "book-glass-harbor")!;
    expect([...files.keys()].sort()).toEqual(book().map((file) => file.path).sort());
    // Neither workflow is in the first commit: the first tree has the three other files and the second tree is built on it with the two workflow files.
    const trees = fake.calls.filter((call) => call.name === "git.createTree");
    expect((trees[0].params.tree as Array<{ path: string }>).map((entry) => entry.path).sort()).toEqual(["README.md", "book.md", "reader/package.json"]);
    expect((trees[1].params.tree as Array<{ path: string }>).map((entry) => entry.path).sort()).toEqual([PAGES_WORKFLOW_PATH, "reader/.github/workflows/deploy-pages.yml"]);
    expect(trees[1].params.base_tree).toBe(history[1].sha ? fake.repo("ada", "book-glass-harbor")!.commits.get(history[1].sha)!.tree : undefined);
    expect(result.committed.files).toBe(5);
    expect(result.shas["README.md"]).toBe(await gitBlobSha(new TextEncoder().encode("# The Glass Harbor\n")));
    expect(result.headSha).toBe(history[0].sha);
  });

  it("makes the repository in an organization when the owner is one, and public when asked", async () => {
    const fake = createFakeGitHub({ orgs: ["acme"] });
    const result = await run(fake, { owner: "acme", visibility: "public" });
    expect(result).toMatchObject({ owner: "acme", private: false });
    expect(fake.count("repos.createInOrg")).toBe(1);
    expect(fake.count("repos.createForAuthenticatedUser")).toBe(0);
    expect(fake.calls.find((call) => call.name === "repos.createInOrg")!.params).toMatchObject({ org: "acme", private: false, auto_init: false });
    expect(fake.filesAt("acme", "book-glass-harbor")).not.toBeNull();
  });

  it("takes the user's own login as the user even when it is written in other letters", async () => {
    const fake = createFakeGitHub();
    await run(fake, { owner: "ADA" });
    expect(fake.count("repos.createForAuthenticatedUser")).toBe(1);
  });

  it("sends no request for each file: text goes inline in the tree", async () => {
    const fake = createFakeGitHub();
    await run(fake, { files: manyFiles(60) });
    expect(fake.count("git.createBlob")).toBe(0);
    expect(fake.calls.filter((call) => call.name === "git.createTree").flatMap((call) => call.params.tree as Array<{ content?: string }>).every((entry) => typeof entry.content === "string")).toBe(true);
  });

  it("splits a book of 500 files into trees of a few hundred KB at most, each on top of the one before it, and the whole is one commit", async () => {
    const fake = createFakeGitHub();
    const result = await run(fake, { files: [...book(), ...manyFiles(500)] });
    const trees = fake.calls.filter((call) => call.name === "git.createTree");
    expect(trees).toHaveLength(Math.ceil(503 / TREE_CHUNK_MAX_ENTRIES) + 1);
    expect(trees[0].params.base_tree).toBeUndefined();
    const created = fake.repo("ada", "book-glass-harbor")!;
    const treeIds = [...created.trees.keys()];
    for (let index = 1; index < trees.length - 1; index += 1) expect(trees[index].params.base_tree).toBe(treeIds[index - 1]);
    for (const tree of trees) expect((tree.params.tree as unknown[]).length).toBeLessThanOrEqual(TREE_CHUNK_MAX_ENTRIES);
    expect(fake.count("git.createCommit")).toBe(2);
    expect(fake.count("git.createRef")).toBe(1);
    expect(fake.filesAt("ada", "book-glass-harbor")!.size).toBe(505);
    expect(result.committed.files).toBe(505);
  });

  it("splits by size too: files of a megabyte each do not share a request", async () => {
    const fake = createFakeGitHub();
    const big = (name: string): BookRepositoryFile => ({ path: name, content: "x".repeat(1_000_000) });
    await run(fake, { files: [...book(), big("a.md"), big("b.md"), big("c.md")] });
    const trees = fake.calls.filter((call) => call.name === "git.createTree");
    expect(trees.length).toBeGreaterThanOrEqual(4);
    for (const tree of trees) expect(sizeOfTree(tree)).toBeLessThanOrEqual(TREE_CHUNK_MAX_BYTES + 1_000_000);
    const withBig = trees.filter((tree) => (tree.params.tree as Array<{ content?: string }>).some((entry) => (entry.content?.length ?? 0) > 900_000));
    expect(withBig).toHaveLength(3);
    for (const tree of withBig) expect((tree.params.tree as Array<{ content?: string }>).filter((entry) => (entry.content?.length ?? 0) > 900_000)).toHaveLength(1);
    expect(fake.filesAt("ada", "book-glass-harbor")!.size).toBe(8);
  });

  it("sends binaries as blobs and puts their sha in the tree", async () => {
    const fake = createFakeGitHub();
    const cover = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
    const result = await run(fake, { files: [...book(), { path: "assets/cover.png", bytes: cover }] });
    const blobs = fake.calls.filter((call) => call.name === "git.createBlob");
    expect(blobs).toHaveLength(1);
    expect(blobs[0].params).toMatchObject({ encoding: "base64", content: btoa(String.fromCharCode(...cover)) });
    const entry = (fake.calls.find((call) => call.name === "git.createTree")!.params.tree as Array<{ path: string; sha?: string; content?: string }>).find((candidate) => candidate.path === "assets/cover.png")!;
    expect(entry.sha).toBeTruthy();
    expect(entry.content).toBeUndefined();
    expect(result.shas["assets/cover.png"]).toBe(await gitBlobSha(cover));
  });

  it("measures a git blob the way git does", async () => {
    expect(await gitBlobSha(new TextEncoder().encode("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    expect(await gitBlobSha(new Uint8Array())).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });

  it("tells the steps as they happen, with the chunk it is at", async () => {
    const fake = createFakeGitHub();
    const steps: string[] = [];
    await run(fake, { files: [...book(), ...manyFiles(300)], pages: "enable", visibility: "public", onProgress: (progress) => steps.push(progress.chunk ? `${progress.step} ${progress.chunk}/${progress.chunks}` : progress.step) });
    expect(steps).toEqual(["repository", "first-commit", "first-commit 1/3", "first-commit 2/3", "first-commit 3/3", "pages", "workflow", "done"]);
  });
});

describe("createCompleteBookRepository: the names", () => {
  it.each([["", "empty"], ["  ", "empty"], ["my book", "characters"], ["a/b", "characters"], ["..", "reserved"], ["repo.git", "reserved"], ["x".repeat(101), "too-long"]])("refuses «%s» before any request (%s)", async (name, problem) => {
    const fake = createFakeGitHub();
    expect(repositoryNameProblem(name)).toBe(problem);
    const error = await fail(run(fake, { name }));
    expect(error.code).toBe("invalid-name");
    expect(fake.calls).toEqual([]);
  });

  it("accepts the names GitHub accepts", () => {
    for (const name of ["book-glass-harbor", "Book_1.0", ".github-notes", "a"]) expect(repositoryNameProblem(name)).toBeNull();
  });

  it("stops when the name is taken, and touches nothing", async () => {
    const fake = createFakeGitHub({ existing: [{ owner: "ada", name: "book-glass-harbor" }] });
    const error = await fail(run(fake));
    expect(error.code).toBe("name-taken");
    expect(fake.names()).toEqual(["users.getAuthenticated", "repos.get"]);
  });

  it("says the name is taken when GitHub answers 422 at the creation (a private repository the token could not see)", async () => {
    const fake = createFakeGitHub();
    const taken = createFakeGitHub({ faults: [{ call: "repos.createForAuthenticatedUser", status: 422, message: "Repository creation failed.", errors: [{ message: "name already exists on this account" }] }] });
    expect((await fail(run(taken))).code).toBe("name-taken");
    expect(fake.calls).toEqual([]);
  });

  it("refuses a request with no files", async () => {
    const fake = createFakeGitHub();
    expect((await fail(run(fake, { files: [] }))).code).toBe("no-files");
    expect((await fail(run(fake, { files: [{ path: PAGES_WORKFLOW_PATH, content: WORKFLOW }] }))).code).toBe("no-files");
    expect(fake.calls).toEqual([]);
  });

  it("knows a workflow by its folder", () => {
    expect(isWorkflowPath(PAGES_WORKFLOW_PATH)).toBe(true);
    expect(isWorkflowPath("reader/.github/workflows/deploy-pages.yml")).toBe(true);
    expect(isWorkflowPath(".github/copilot-instructions.md")).toBe(false);
    expect(isWorkflowPath("docs/github/workflows/x.yml")).toBe(false);
  });
});

describe("createCompleteBookRepository: what the token cannot do at the creation", () => {
  it("says the token cannot create a repository when GitHub answers 403, and makes nothing", async () => {
    const fake = createFakeGitHub({ faults: [{ call: "repos.createForAuthenticatedUser", status: 403, message: "Resource not accessible by personal access token" }] });
    const error = await fail(run(fake));
    expect(error).toMatchObject({ code: "cannot-create", status: 403 });
    expect(error.repository).toBeUndefined();
    expect(fake.repos.size).toBe(0);
  });

  it("says the organization is unavailable when GitHub answers 404 for it", async () => {
    const fake = createFakeGitHub({ orgs: [] });
    const error = await fail(run(fake, { owner: "ghost-org" }));
    expect(error).toMatchObject({ code: "owner-unavailable", status: 404 });
  });

  it("says the organization asks for single sign-on when it does", async () => {
    const fake = createFakeGitHub({ orgs: ["acme"], faults: [{ call: "repos.createInOrg", status: 403, message: "Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization." }] });
    const error = await fail(run(fake, { owner: "acme" }));
    expect(error).toMatchObject({ code: "cannot-create", reason: "sso-required" });
  });

  it("says a token that stopped working did", async () => {
    const fake = createFakeGitHub({ faults: [{ call: "users.getAuthenticated", status: 401, message: "Bad credentials" }] });
    expect((await fail(run(fake))).code).toBe("credential-invalid");
  });

  it("gives the time a rate limit ends, and does not try again", async () => {
    const fake = createFakeGitHub({ faults: [{ call: "repos.createForAuthenticatedUser", status: 403, message: "API rate limit exceeded", headers: RATE_LIMIT }] });
    const error = await fail(run(fake));
    expect(error).toMatchObject({ code: "rate-limit", resetAt: new Date(1893456000 * 1000).toISOString() });
    expect(fake.count("repos.createForAuthenticatedUser")).toBe(1);
  });

  it("refuses a book that is too large before it makes the repository", async () => {
    const fake = createFakeGitHub();
    const error = await fail(run(fake, { files: [...book(), { path: "assets/huge.bin", bytes: new Uint8Array(26 * 1024 * 1024) }] }));
    expect(error.code).toBe("too-large");
    expect(fake.calls).toEqual([]);
  });
});

describe("createCompleteBookRepository: the first commit on an empty repository", () => {
  it("goes first the direct way (the tree, the commit, the reference) and makes no commit of its own to bootstrap", async () => {
    const fake = createFakeGitHub({ emptyRepository: "ok" });
    const result = await run(fake);
    expect(result.firstCommitPath).toBe("direct");
    expect(fake.count("repos.createOrUpdateFileContents")).toBe(0);
  });

  it("falls back when GitHub refuses the git data on an empty repository: the README gives the branch, then the branch is moved to one root commit with force", async () => {
    const fake = createFakeGitHub({ emptyRepository: "tree" });
    const result = await run(fake);
    expect(result).toMatchObject({ firstCommitPath: "bootstrap", workflow: "done" });
    expect(result.warnings).toEqual([{ code: "bootstrap-path" }]);
    const names = fake.names();
    expect(names.indexOf("repos.createOrUpdateFileContents")).toBeGreaterThan(names.indexOf("git.createTree"));
    const put = fake.calls.find((call) => call.name === "repos.createOrUpdateFileContents")!.params;
    expect(put).toMatchObject({ path: "README.md", message: BOOTSTRAP_MESSAGE });
    expect(atob(String(put.content))).toBe("# The Glass Harbor\n");
    expect(put.branch).toBeUndefined();
    expect(fake.calls.filter((call) => call.name === "git.updateRef").map((call) => call.params.force)).toEqual([true, false]);
    const history = fake.history("ada", "book-glass-harbor");
    expect(history.map((commit) => commit.message)).toEqual(["Add the GitHub Pages workflow", "Initialize Narrarium book"]);
    expect(history[1].parents).toEqual([]);
    expect(fake.filesAt("ada", "book-glass-harbor")!.size).toBe(5);
  });

  it("falls back when only the reference is refused: the commit already built is the one that is published", async () => {
    const fake = createFakeGitHub({ emptyRepository: "ref" });
    const result = await run(fake);
    expect(result.firstCommitPath).toBe("bootstrap");
    expect(fake.count("git.createCommit")).toBe(2);
    expect(fake.count("git.createRef")).toBe(1);
    expect(fake.history("ada", "book-glass-harbor").map((commit) => commit.message)).toEqual(["Add the GitHub Pages workflow", "Initialize Narrarium book"]);
  });

  it("falls back at most once: when the fallback is refused too the first commit has failed, and the empty repository is reported", async () => {
    const fake = createFakeGitHub({ emptyRepository: "tree", faults: [{ call: "repos.createOrUpdateFileContents", status: 403, message: "Resource not accessible by personal access token" }] });
    const error = await fail(run(fake));
    expect(error.code).toBe("first-commit-failed");
    expect(error.repository).toMatchObject({ owner: "ada", repo: "book-glass-harbor", created: true, defaultBranch: "main" });
    expect(fake.count("repos.createOrUpdateFileContents")).toBe(1);
  });

  it("does not fall back on a rate limit or a credential: they are not an empty repository", async () => {
    const fake = createFakeGitHub({ faults: [{ call: "git.createTree", status: 403, message: "You have exceeded a secondary rate limit.", headers: { "retry-after": "60" } }] });
    const error = await fail(run(fake));
    expect(error).toMatchObject({ code: "first-commit-failed", reason: "abuse-limit" });
    expect(fake.count("repos.createOrUpdateFileContents")).toBe(0);
  });
});

describe("createCompleteBookRepository: a first commit that fails after the repository exists", () => {
  it("says the repository exists and is empty, with the time of the rate limit when that is why", async () => {
    const fake = createFakeGitHub({ faults: [{ call: "git.createTree", when: (_params, _repo) => true, status: 403, message: "API rate limit exceeded", headers: RATE_LIMIT, times: 1 }] });
    const error = await fail(run(fake, { files: manyFiles(300) }));
    expect(error).toMatchObject({ code: "first-commit-failed", reason: "rate-limit", resetAt: new Date(1893456000 * 1000).toISOString(), repository: { owner: "ada", repo: "book-glass-harbor", created: true, htmlUrl: "https://github.com/ada/book-glass-harbor" } });
    expect(fake.repo("ada", "book-glass-harbor")!.refs.size).toBe(0);
    expect(fake.count("git.createTree")).toBe(1);
  });

  it("stops at a rate limit in the middle of the trees and does not go on", async () => {
    const fake = createFakeGitHub({ faults: [{ call: "git.createTree", when: (params) => Boolean(params.base_tree), status: 403, message: "API rate limit exceeded", headers: RATE_LIMIT, times: 1 }] });
    const error = await fail(run(fake, { files: manyFiles(400) }));
    expect(error.code).toBe("first-commit-failed");
    expect(fake.count("git.createTree")).toBe(2);
    expect(fake.count("git.createCommit")).toBe(0);
  });

  it("fills the same empty repository on a retry, with the same files", async () => {
    const fake = createFakeGitHub({ faults: [{ call: "git.createCommit", status: 500, message: "Server Error", times: 1 }] });
    const error = await fail(run(fake));
    expect(error).toMatchObject({ code: "first-commit-failed", reason: "service-unavailable" });
    const retried = await run(fake, { existing: "empty" });
    expect(retried).toMatchObject({ owner: "ada", repo: "book-glass-harbor", createdRepository: false, workflow: "done", firstCommitPath: "direct" });
    expect(fake.repos.size).toBe(1);
    expect(fake.filesAt("ada", "book-glass-harbor")!.size).toBe(5);
  });

  it("does not fill a repository that has a branch of someone's work, unless asked to overwrite it", async () => {
    const fake = createFakeGitHub({ existing: [{ owner: "ada", name: "book-glass-harbor", withBranch: true }] });
    expect((await fail(run(fake, { existing: "empty" }))).code).toBe("not-empty");
    expect((await fail(run(fake))).code).toBe("name-taken");
    const overwritten = await run(fake, { existing: "overwrite" });
    expect(overwritten.createdRepository).toBe(false);
    expect(fake.calls.filter((call) => call.name === "git.updateRef").map((call) => call.params.force)).toEqual([true, false]);
    expect(fake.history("ada", "book-glass-harbor").map((commit) => commit.message)).toEqual(["Add the GitHub Pages workflow", "Initialize Narrarium book", "Someone's work"]);
    expect(fake.filesAt("ada", "book-glass-harbor")!.has("old.md")).toBe(false);
  });

  it("takes back an empty repository that a failed fallback left with only its README, as a root commit", async () => {
    const fake = createFakeGitHub({ emptyRepository: "tree", faults: [{ call: "git.createTree", when: (params) => !params.base_tree && fake.repo("ada", "book-glass-harbor")!.refs.size > 0, status: 500, message: "Server Error", times: 1 }] });
    const first = await fail(run(fake));
    expect(first.code).toBe("first-commit-failed");
    expect(fake.history("ada", "book-glass-harbor").map((commit) => commit.message)).toEqual([BOOTSTRAP_MESSAGE]);
    const retried = await run(fake, { existing: "empty" });
    expect(retried.createdRepository).toBe(false);
    expect(fake.history("ada", "book-glass-harbor").map((commit) => commit.message)).toEqual(["Add the GitHub Pages workflow", "Initialize Narrarium book"]);
  });

  it("deletes an empty repository only on request, and never one that has a branch", async () => {
    const fake = createFakeGitHub({ faults: [{ call: "git.createCommit", status: 500, message: "Server Error", times: 1 }] });
    await fail(run(fake));
    await deleteEmptyBookRepository({ token: "never-used", octokit: fake.octokit, owner: "ada", repo: "book-glass-harbor" });
    expect(fake.repo("ada", "book-glass-harbor")).toBeUndefined();
    const full = createFakeGitHub();
    await run(full);
    await expect(deleteEmptyBookRepository({ token: "never-used", octokit: full.octokit, owner: "ada", repo: "book-glass-harbor" })).rejects.toMatchObject({ code: "not-empty" });
    expect(full.count("repos.delete")).toBe(0);
  });

  it("says when the repository cannot be deleted with this token", async () => {
    const fake = createFakeGitHub({ existing: [{ owner: "ada", name: "empty" }], faults: [{ call: "repos.delete", status: 403, message: "Must have admin rights to Repository." }] });
    await expect(deleteEmptyBookRepository({ token: "never-used", octokit: fake.octokit, owner: "ada", repo: "empty" })).rejects.toMatchObject({ code: "cannot-delete", status: 403 });
  });
});

describe("createCompleteBookRepository: the workflow commit", () => {
  const refusal = { status: 404, message: "Not Found" };

  it("keeps the repository, complete without the workflows, when the token may not write them (said in words)", async () => {
    const fake = createFakeGitHub({ workflowRefusal: { status: 403, message: "refusing to allow a Personal Access Token to create or update workflow `.github/workflows/deploy-reader-pages.yml` without `workflow` scope" } });
    const result = await run(fake);
    expect(result.workflow).toBe("not-allowed");
    expect(result.warnings).toEqual([{ code: "workflow-not-allowed", status: 403 }]);
    expect(result.pendingWorkflow.map((file) => file.path).sort()).toEqual(["reader/.github/workflows/deploy-reader-pages.yml".replace("deploy-reader-pages", "deploy-pages"), PAGES_WORKFLOW_PATH].sort());
    expect(result.pendingWorkflow.find((file) => file.path === PAGES_WORKFLOW_PATH)!.content).toBe(WORKFLOW);
    expect(result.committed.files).toBe(3);
    expect([...fake.filesAt("ada", "book-glass-harbor")!.keys()].sort()).toEqual(["README.md", "book.md", "reader/package.json"]);
    expect(result.headSha).toBe(fake.history("ada", "book-glass-harbor")[0].sha);
    expect(fake.history("ada", "book-glass-harbor")).toHaveLength(1);
  });

  it("knows a refusal that does not say workflow by trying the same update without it", async () => {
    const fake = createFakeGitHub({ workflowRefusal: refusal });
    const result = await run(fake);
    expect(result.workflow).toBe("not-allowed");
    // The first update of the branch was the workflow's, refused; the second is the same branch moved to the commit it is at, and it went through.
    expect(fake.calls.filter((call) => call.name === "git.updateRef")).toHaveLength(2);
    expect(fake.calls.filter((call) => call.name === "git.updateRef")[1].params.sha).toBe(result.headSha);
  });

  it("does not call a refusal the workflow's when the branch cannot be written at all", async () => {
    const fake = createFakeGitHub({ faults: [{ call: "git.updateRef", status: 403, message: "Resource not accessible by personal access token" }] });
    const result = await run(fake);
    expect(result.workflow).toBe("skipped");
    expect(result.warnings).toEqual([{ code: "workflow-failed", status: 403 }]);
    expect(result.pendingWorkflow).toHaveLength(2);
  });

  it("keeps the repository and says when a rate limit stops the workflow", async () => {
    const fake = createFakeGitHub({ faults: [{ call: "git.updateRef", status: 403, message: "API rate limit exceeded", headers: RATE_LIMIT }] });
    const result = await run(fake);
    expect(result).toMatchObject({ workflow: "skipped", committed: { files: 3 } });
    expect(result.warnings).toEqual([{ code: "workflow-rate-limit", status: 403, resetAt: new Date(1893456000 * 1000).toISOString() }]);
    expect(fake.calls.filter((call) => call.name === "git.updateRef")).toHaveLength(1);
  });

  it("keeps the repository when GitHub fails the workflow commit for its own reasons", async () => {
    const fake = createFakeGitHub({ faults: [{ call: "git.createCommit", when: (params) => params.parents.length === 1, status: 502, message: "Bad Gateway" }] });
    const result = await run(fake);
    expect(result).toMatchObject({ workflow: "skipped", warnings: [{ code: "workflow-failed", status: 502 }] });
  });

  it("makes no second commit when the book has no workflow", async () => {
    const fake = createFakeGitHub();
    const result = await run(fake, { files: book().filter((file) => !isWorkflowPath(file.path)) });
    expect(result.workflow).toBe("skipped");
    expect(result.warnings).toEqual([]);
    expect(fake.count("git.createCommit")).toBe(1);
  });
});

describe("createCompleteBookRepository: GitHub Pages", () => {
  it("is not touched unless asked", async () => {
    const fake = createFakeGitHub();
    const result = await run(fake, { visibility: "public" });
    expect(result.pages).toBe("skipped");
    expect(fake.count("repos.createPagesSite")).toBe(0);
  });

  it("is turned on from a workflow, before the workflow commit lands", async () => {
    const fake = createFakeGitHub();
    const result = await run(fake, { visibility: "public", pages: "enable" });
    expect(result.pages).toBe("enabled");
    expect(fake.calls.find((call) => call.name === "repos.createPagesSite")!.params).toMatchObject({ owner: "ada", repo: "book-glass-harbor", build_type: "workflow" });
    const names = fake.names();
    expect(names.indexOf("repos.createPagesSite")).toBeGreaterThan(names.indexOf("git.createRef"));
    expect(names.indexOf("repos.createPagesSite")).toBeLessThan(names.lastIndexOf("git.createTree"));
  });

  it("is left to the user when the plan does not allow it for a private repository, and nothing else is lost", async () => {
    const fake = createFakeGitHub({ faults: [{ call: "repos.createPagesSite", status: 422, message: "Your current plan does not support GitHub Pages for this repository." }] });
    const result = await run(fake, { pages: "enable" });
    expect(result).toMatchObject({ pages: "manual", workflow: "done" });
    expect(result.warnings).toEqual([{ code: "pages-plan", status: 422 }]);
  });

  it("is left to the user when the token may not do it", async () => {
    const fake = createFakeGitHub({ faults: [{ call: "repos.createPagesSite", status: 403, message: "Resource not accessible by personal access token" }] });
    const result = await run(fake, { visibility: "public", pages: "enable" });
    expect(result).toMatchObject({ pages: "manual", workflow: "done" });
    expect(result.warnings).toEqual([{ code: "pages-refused", status: 403 }]);
  });

  it("counts a site that is there already as enabled", async () => {
    const fake = createFakeGitHub({ faults: [{ call: "repos.createPagesSite", status: 409, message: "A GitHub Pages site already exists for this repository." }] });
    expect((await run(fake, { visibility: "public", pages: "enable" })).pages).toBe("enabled");
  });
});

describe("preflightBookRepository", () => {
  const preflight = (options: FakeGitHubOptions, token = "ghp_test") => preflightBookRepository({ token, octokit: createFakeGitHub(options).octokit });

  it("reads the scopes of a classic token from the header of the user", async () => {
    expect(await preflight({ scopes: "repo, workflow", orgs: ["zeta", "acme"] })).toMatchObject({ login: "ada", tokenKind: "classic", scopes: ["repo", "workflow"], canCreate: "yes", canWriteWorkflows: "yes", issues: [], organizations: ["acme", "zeta"] });
  });

  it("sees a classic token with no workflow scope", async () => {
    expect(await preflight({ scopes: "repo" })).toMatchObject({ canCreate: "yes", canWriteWorkflows: "no", issues: ["no-workflow-scope"] });
  });

  it("sees a classic token that may only make public repositories", async () => {
    expect(await preflight({ scopes: "public_repo, workflow" })).toMatchObject({ canCreate: "yes", issues: ["public-only"] });
  });

  it("sees a classic token with no repository scope at all", async () => {
    expect(await preflight({ scopes: "read:user" })).toMatchObject({ canCreate: "no", canWriteWorkflows: "no", issues: ["no-repo-scope", "no-workflow-scope"] });
    expect(await preflight({ scopes: "" })).toMatchObject({ canCreate: "no" });
  });

  it("does not claim to know what a fine-grained token can do: it is tried and its refusals are classified", async () => {
    expect(await preflight({}, "github_pat_test")).toMatchObject({ tokenKind: "fine-grained", canCreate: "unknown", canWriteWorkflows: "unknown", issues: ["fine-grained"] });
    expect(await preflight({}, "something")).toMatchObject({ tokenKind: "unknown", issues: ["unknown-token"] });
  });

  it("lists no organizations when the token cannot, and still answers", async () => {
    const fake = createFakeGitHub({ scopes: "repo", faults: [{ call: "orgs.listForAuthenticatedUser", status: 403, message: "Resource not accessible" }] });
    expect(await preflightBookRepository({ token: "ghp_test", octokit: fake.octokit })).toMatchObject({ organizations: [], canCreate: "yes" });
  });

  it("fails with the credential error when the token does not work", async () => {
    const fake = createFakeGitHub({ faults: [{ call: "users.getAuthenticated", status: 401, message: "Bad credentials" }] });
    await expect(preflightBookRepository({ token: "ghp_test", octokit: fake.octokit })).rejects.toMatchObject({ code: "credential-invalid" });
  });
});
