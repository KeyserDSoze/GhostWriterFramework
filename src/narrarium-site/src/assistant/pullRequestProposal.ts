import type { BranchDiffFile, BranchSummary, PullRequestSummary } from "@/github/githubClient";
import type { AssistantAction } from "@/assistant/store";

export type PullRequestProposalAction = Extract<AssistantAction, { kind: "confirm-create-pull-request" }>;

export interface PullRequestProposalDependencies {
  getDefaultBranch(token: string, owner: string, repo: string): Promise<string>;
  listBranches(token: string, owner: string, repo: string): Promise<BranchSummary[]>;
  listBranchCommits(token: string, owner: string, repo: string, branch: string): Promise<Array<{ sha: string }>>;
  compareBranches(token: string, owner: string, repo: string, base: string, head: string): Promise<BranchDiffFile[]>;
  listOpenPullRequests(token: string, owner: string, repo: string, head?: string): Promise<PullRequestSummary[]>;
  createPullRequest(token: string, owner: string, repo: string, input: { title: string; body?: string; head: string; base: string }): Promise<PullRequestSummary>;
}

export class PullRequestProposalError extends Error {
  readonly code: "default-head" | "protected-head" | "missing-branch" | "duplicate" | "stale" | "empty-diff";
  constructor(code: PullRequestProposalError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "PullRequestProposalError";
  }
}

async function inspect(input: { token: string; owner: string; repo: string; base: string; head: string }, dependencies: PullRequestProposalDependencies) {
  if (input.base === input.head) throw new PullRequestProposalError("default-head", `Cannot create a pull request from the default branch ${input.base}.`);
  const [defaultBranch, branches, baseCommits, headCommits, files, existing] = await Promise.all([
    dependencies.getDefaultBranch(input.token, input.owner, input.repo),
    dependencies.listBranches(input.token, input.owner, input.repo),
    dependencies.listBranchCommits(input.token, input.owner, input.repo, input.base),
    dependencies.listBranchCommits(input.token, input.owner, input.repo, input.head),
    dependencies.compareBranches(input.token, input.owner, input.repo, input.base, input.head),
    dependencies.listOpenPullRequests(input.token, input.owner, input.repo, input.head),
  ]);
  if (defaultBranch !== input.base) throw new PullRequestProposalError("stale", `The repository default branch changed from ${input.base} to ${defaultBranch}. Create a new proposal before confirming.`);
  const baseBranch = branches.find((branch) => branch.name === input.base);
  const headBranch = branches.find((branch) => branch.name === input.head);
  if (!baseBranch || !headBranch || !baseCommits[0]?.sha || !headCommits[0]?.sha) throw new PullRequestProposalError("missing-branch", "The base or head branch no longer exists.");
  if (headBranch.protected) throw new PullRequestProposalError("protected-head", `Cannot create a pull request from protected branch ${input.head}.`);
  return { baseRevision: baseCommits[0].sha, headRevision: headCommits[0].sha, files, existing };
}

export async function buildPullRequestProposal(input: { token: string; owner: string; repo: string; base: string; head: string }, dependencies: PullRequestProposalDependencies) {
  return inspect(input, dependencies);
}

export async function confirmPullRequestProposal(input: { token: string; action: PullRequestProposalAction }, dependencies: PullRequestProposalDependencies): Promise<PullRequestSummary> {
  const { action } = input;
  const current = await inspect({ token: input.token, owner: action.owner!, repo: action.repo!, base: action.base, head: action.head }, dependencies);
  if (current.existing.length) throw new PullRequestProposalError("duplicate", `Pull request #${current.existing[0].number} is already open for ${action.head}.`);
  const currentFiles = summarizePullRequestFiles(current.files);
  if (current.baseRevision !== action.baseRevision || current.headRevision !== action.headRevision || JSON.stringify(currentFiles) !== JSON.stringify(action.changedFiles)) {
    throw new PullRequestProposalError("stale", "The branch heads or diff changed after this proposal was generated. Create a new proposal before confirming.");
  }
  if (!current.files.length) throw new PullRequestProposalError("empty-diff", "There are no changes to include in this pull request.");
  return dependencies.createPullRequest(input.token, action.owner!, action.repo!, { title: action.title, body: action.body || undefined, head: action.head, base: action.base });
}

export function summarizePullRequestFiles(files: BranchDiffFile[]) {
  return files.map((file) => ({ filename: file.filename, status: file.status, additions: file.additions, deletions: file.deletions }));
}

export function pullRequestRevision(baseRevision: string, headRevision: string): string {
  return JSON.stringify({ baseRevision, headRevision });
}
