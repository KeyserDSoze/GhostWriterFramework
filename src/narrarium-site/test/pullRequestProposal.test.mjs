import assert from "node:assert/strict";
import test from "node:test";
import { buildPullRequestProposal, confirmPullRequestProposal, pullRequestRevision, summarizePullRequestFiles } from "../src/assistant/pullRequestProposal.ts";

const file = { filename: "chapters/001.md", status: "modified", additions: 4, deletions: 1, changes: 5 };

function setup(overrides = {}) {
  let creates = 0;
  const state = { defaultBranch: "main", baseSha: "base-1", headSha: "head-1", files: [file], pulls: [], branches: [{ name: "main", protected: true }, { name: "feature/x", protected: false }], ...overrides };
  const dependencies = {
    getDefaultBranch: async () => state.defaultBranch,
    listBranches: async () => state.branches,
    listBranchCommits: async (_token, _owner, _repo, branch) => [{ sha: branch === "main" ? state.baseSha : state.headSha }],
    compareBranches: async () => state.files,
    listOpenPullRequests: async () => state.pulls,
    createPullRequest: async (_token, _owner, _repo, input) => { creates += 1; return { number: 12, title: input.title, state: "open", htmlUrl: "https://example.test/pr/12", head: input.head, base: input.base }; },
  };
  return { state, dependencies, creates: () => creates };
}

function action(inspected) {
  /** @type {import("../src/assistant/pullRequestProposal.ts").PullRequestProposalAction} */
  const proposal = {
    kind: "confirm-create-pull-request", bookId: "book", toolId: "create-pull-request", owner: "writer", repo: "novel", branch: "feature/x",
    sourceRevision: pullRequestRevision(inspected.baseRevision, inspected.headRevision), sourceRevisions: {}, generatedAt: new Date().toISOString(),
    base: "main", head: "feature/x", title: "Finish ending", body: "Ready for review", baseRevision: inspected.baseRevision, headRevision: inspected.headRevision,
    changedFiles: summarizePullRequestFiles(inspected.files), existingPullRequests: inspected.existing.map(({ number, title, htmlUrl, state }) => ({ number, title, htmlUrl, state })),
  };
  return proposal;
}

test("builds a reviewable proposal without creating and creates only after confirmation", async () => {
  const fixture = setup();
  const inspected = await buildPullRequestProposal({ token: "t", owner: "writer", repo: "novel", base: "main", head: "feature/x" }, fixture.dependencies);
  assert.equal(fixture.creates(), 0);
  const pull = await confirmPullRequestProposal({ token: "t", action: action(inspected) }, fixture.dependencies);
  assert.equal(pull.number, 12);
  assert.equal(fixture.creates(), 1);
});

test("reports existing PR state in proposal and rejects duplicate at confirmation", async () => {
  const duplicate = { number: 7, title: "Existing", state: "open", htmlUrl: "https://example.test/pr/7", head: "feature/x", base: "main" };
  const fixture = setup({ pulls: [duplicate] });
  const inspected = await buildPullRequestProposal({ token: "t", owner: "writer", repo: "novel", base: "main", head: "feature/x" }, fixture.dependencies);
  assert.deepEqual(inspected.existing, [duplicate]);
  await assert.rejects(confirmPullRequestProposal({ token: "t", action: action(inspected) }, fixture.dependencies), (error) => error instanceof Error && "code" in error && error.code === "duplicate");
  assert.equal(fixture.creates(), 0);
});

test("rejects default and protected heads", async () => {
  const fixture = setup();
  await assert.rejects(buildPullRequestProposal({ token: "t", owner: "writer", repo: "novel", base: "main", head: "main" }, fixture.dependencies), (error) => error instanceof Error && "code" in error && error.code === "default-head");
  fixture.state.branches[1].protected = true;
  await assert.rejects(buildPullRequestProposal({ token: "t", owner: "writer", repo: "novel", base: "main", head: "feature/x" }, fixture.dependencies), (error) => error instanceof Error && "code" in error && error.code === "protected-head");
});

test("revalidates branch revisions and diff immediately before creation", async () => {
  const fixture = setup();
  const inspected = await buildPullRequestProposal({ token: "t", owner: "writer", repo: "novel", base: "main", head: "feature/x" }, fixture.dependencies);
  fixture.state.headSha = "head-2";
  await assert.rejects(confirmPullRequestProposal({ token: "t", action: action(inspected) }, fixture.dependencies), (error) => error instanceof Error && "code" in error && error.code === "stale");
  assert.equal(fixture.creates(), 0);
});

test("rejects confirmation when the live default branch changed", async () => {
  const fixture = setup();
  const inspected = await buildPullRequestProposal({ token: "t", owner: "writer", repo: "novel", base: "main", head: "feature/x" }, fixture.dependencies);
  fixture.state.defaultBranch = "release";
  await assert.rejects(confirmPullRequestProposal({ token: "t", action: action(inspected) }, fixture.dependencies), (error) => error instanceof Error && "code" in error && error.code === "stale");
  assert.equal(fixture.creates(), 0);
});

test("rejects confirmation when the proposed head became the default branch", async () => {
  const fixture = setup();
  const inspected = await buildPullRequestProposal({ token: "t", owner: "writer", repo: "novel", base: "main", head: "feature/x" }, fixture.dependencies);
  fixture.state.defaultBranch = "feature/x";
  await assert.rejects(confirmPullRequestProposal({ token: "t", action: action(inspected) }, fixture.dependencies), (error) => error instanceof Error && "code" in error && error.code === "stale");
  assert.equal(fixture.creates(), 0);
});

test("propagates inspection and create API failures without creating twice", async () => {
  const fixture = setup();
  const inspected = await buildPullRequestProposal({ token: "t", owner: "writer", repo: "novel", base: "main", head: "feature/x" }, fixture.dependencies);
  fixture.dependencies.createPullRequest = async () => { throw new Error("GitHub unavailable"); };
  await assert.rejects(confirmPullRequestProposal({ token: "t", action: action(inspected) }, fixture.dependencies), /GitHub unavailable/);
  const failedInspection = setup();
  failedInspection.dependencies.listBranches = async () => { throw new Error("rate limited"); };
  await assert.rejects(buildPullRequestProposal({ token: "t", owner: "writer", repo: "novel", base: "main", head: "feature/x" }, failedInspection.dependencies), /rate limited/);
});

test("cancellation is represented by discarding the proposal and performs no API call", async () => {
  const fixture = setup();
  await buildPullRequestProposal({ token: "t", owner: "writer", repo: "novel", base: "main", head: "feature/x" }, fixture.dependencies);
  assert.equal(fixture.creates(), 0);
});
