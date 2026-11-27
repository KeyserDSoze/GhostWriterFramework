import type { Octokit } from "@octokit/rest";
import type { BookEntry } from "@/types/settings";
import { createTrackedGitHubClient } from "@/repository/githubRequest";
import { getLocalRepository, listUnpushedLocalCommits } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { RepositoryConflictError, commitAndPushTextFileMutation, type RepositoryTextMutation } from "@/repository/safeRepositoryMutation";
import { captureImmediateMutation } from "@/assistant/immediateMutation";
import type { ReaderUpdateDecision, UpdateTarget } from "@/readerUpdate/decision";
import { buildReaderUpdateCommit, type ReaderUpdateCommit } from "@/readerUpdate/commit";
import { ProtectedBranchError, commitUpdateToBranch, githubMessageOf, isProtectedBranchRefusal, openUpdatePullRequest, type UpdatePullRequest } from "@/readerUpdate/publishingBranch";

/**
 * What happened on one branch:
 *  - `published`: the update is on GitHub on that branch;
 *  - `local`: it is a commit on this device (offline, no credential, or other changes of the book still to publish) and the next sync publishes it;
 *  - `pending`: it was not made on that branch (GitHub could not be asked, or can no longer be): the publishing branch is still old, and says so;
 *  - `protected`: GitHub refused to move the branch because it is protected (`githubMessage` is what GitHub said): the pull request is the way that works;
 *  - `changed`: the branch moved after the check, so nothing was written there.
 */
export type BranchUpdateStatus = "published" | "local" | "pending" | "protected" | "changed";

export interface BranchUpdateOutcome {
  branch: string;
  role: "publishing" | "current";
  status: BranchUpdateStatus;
  commitSha?: string;
  githubMessage?: string;
}

/** What a pull request would carry, kept when the publishing branch is protected so that one action opens it. */
export interface PullRequestOffer {
  base: string;
  baseHeadSha: string;
  title: string;
  message: string;
  mutations: RepositoryTextMutation[];
}

export interface ReaderUpdateOutcome {
  /** The commit that a run of the workflow follows: the publishing branch's when the update landed there, otherwise the working branch's. */
  commitSha: string;
  /** That commit is on GitHub, on the branch the workflow runs from: a run can follow. `false`: it is on this device (or the publishing branch was not reached) and the next sync or update publishes it. */
  published: boolean;
  paths: string[];
  /** The branch the workflow runs from, when the update reached it on GitHub. */
  publishedBranch: string | null;
  /** One entry for every branch the update was meant for, the publishing branch first. */
  branches: BranchUpdateOutcome[];
  pullRequestOffer?: PullRequestOffer;
}

type Update = Extract<ReaderUpdateDecision, { kind: "update" }>;

async function updateWorkingBranch(input: { book: BookEntry; branch: string; token: string; update: Update; workflowHash: string | null; commit: ReaderUpdateCommit }): Promise<{ commitSha: string; published: boolean }> {
  const { book, branch, token, update } = input;
  // The workflow is read again, with the head of the branch, as every immediate change of the book is: it is the file whose text the owner may have edited.
  const snapshot = await captureImmediateMutation({ token, book, branch, path: update.workflow.path });
  if (snapshot.hash !== input.workflowHash) throw new RepositoryConflictError(`File changed since it was read: ${update.workflow.path}`, update.workflow.path);
  const { commitSha } = await commitAndPushTextFileMutation({ token, book, branch, expectedRemoteHeadSha: snapshot.remoteHeadSha, message: input.commit.message, mutations: input.commit.mutations, push: update.delivery === "now" });
  const local = await getLocalRepository(book.owner, book.repo, branch, captureRepositoryOperationScope()).catch(() => null);
  const ahead = local ? await listUnpushedLocalCommits(local.id) : [];
  return { commitSha, published: update.delivery === "now" && ahead.length === 0 };
}

const refusal = (target: UpdateTarget, commit: ReaderUpdateCommit): PullRequestOffer => ({ base: target.branch, baseHeadSha: target.headSha ?? "", title: commit.message.split("\n")[0], message: commit.message, mutations: commit.mutations });

/**
 * The update on the publishing branch, the one that decides what is published. With a working copy of that branch on this device it goes through it, like
 * any change of the book (checked file by file, committed, pushed); otherwise it is one commit on GitHub on the head the plan was made against. Never forced.
 * A protected branch is an outcome (`protected`, with GitHub's words and the pull request that would work), not an error.
 */
async function updatePublishingBranch(input: { book: BookEntry; token: string; target: UpdateTarget; commit: ReaderUpdateCommit; octokit?: Octokit }): Promise<{ outcome: BranchUpdateOutcome; offer?: PullRequestOffer }> {
  const { book, token, target, commit } = input;
  const base = { branch: target.branch, role: "publishing" as const };
  if (target.delivery !== "now") return { outcome: { ...base, status: "pending" } };
  try {
    if (target.source === "working-copy") {
      const snapshot = await captureImmediateMutation({ token, book, branch: target.branch, path: target.workflow.path });
      if (snapshot.hash !== target.workflowHash) throw new RepositoryConflictError(`File changed since it was read: ${target.workflow.path}`, target.workflow.path);
      const { commitSha } = await commitAndPushTextFileMutation({ token, book, branch: target.branch, expectedRemoteHeadSha: snapshot.remoteHeadSha, message: commit.message, mutations: commit.mutations, push: true });
      const local = await getLocalRepository(book.owner, book.repo, target.branch, captureRepositoryOperationScope()).catch(() => null);
      const ahead = local ? await listUnpushedLocalCommits(local.id) : [];
      return { outcome: { ...base, status: ahead.length === 0 ? "published" : "local", commitSha } };
    }
    if (!target.headSha) return { outcome: { ...base, status: "pending" } };
    const { commitSha } = await commitUpdateToBranch(input.octokit ?? createTrackedGitHubClient(token), { owner: book.owner, repo: book.repo }, { branch: target.branch, expectedHeadSha: target.headSha, message: commit.message, mutations: commit.mutations });
    return { outcome: { ...base, status: "published", commitSha } };
  } catch (error) {
    if (error instanceof ProtectedBranchError) return { outcome: { ...base, status: "protected", githubMessage: error.githubMessage }, offer: refusal(target, commit) };
    if (isProtectedBranchRefusal(error)) return { outcome: { ...base, status: "protected", githubMessage: githubMessageOf(error) }, offer: refusal(target, commit) };
    if (error instanceof RepositoryConflictError) return { outcome: { ...base, status: "changed" } };
    throw error;
  }
}

/**
 * Makes the update of the reader on the branch the workflow publishes from AND on the branch the author works on, so that the two carry the same files (a later
 * merge of one into the other is clean). Each is ONE commit with every file or none, never forced. The publishing branch goes first: it is what the published
 * site and every check of the workflow depend on. Nothing is written if the owner has not agreed to replace the edits of a customized workflow on either
 * (`CustomizedWorkflowRefused`), nor on the working branch if the workflow or any file of the update is no longer what the check read (`RepositoryConflictError`).
 * Offline or without a credential, the working branch's commit stays on this device and the publishing branch is reported as not reached (`pending`).
 */
export async function applyReaderUpdate(input: {
  book: BookEntry;
  branch: string;
  token: string;
  update: Update;
  workflowHash: string | null;
  replaceEdits: boolean;
  octokit?: Octokit;
}): Promise<ReaderUpdateOutcome> {
  const { book, branch, token, update } = input;
  // Both commits are made up before anything is written: a refusal to replace edits, on either branch, stops everything.
  const currentCommit = update.currentNeeded ? buildReaderUpdateCommit(update, { replaceEdits: input.replaceEdits, workflowHash: input.workflowHash }) : null;
  const target = update.publishingTarget;
  const publishingCommit = target ? buildReaderUpdateCommit(target, { replaceEdits: input.replaceEdits, workflowHash: target.workflowHash, unchecked: target.source === "github" }) : null;

  const branches: BranchUpdateOutcome[] = [];
  let offer: PullRequestOffer | undefined;
  if (target && publishingCommit) {
    const made = await updatePublishingBranch({ book, token, target, commit: publishingCommit, octokit: input.octokit });
    branches.push(made.outcome);
    offer = made.offer;
  } else if (update.publishing && (update.publishing.state === "unknown" || update.publishing.state === "unreadable")) {
    branches.push({ branch: update.publishing.branch, role: "publishing", status: "pending" });
  }
  const publishingDone = branches.find((entry) => entry.role === "publishing");
  // A publishing branch that could not be written, with nothing else to do here, is the failure of the update.
  if (!currentCommit && publishingDone?.status === "changed") throw new RepositoryConflictError(`The branch ${publishingDone.branch} changed after the check.`);

  let current: { commitSha: string; published: boolean } | null = null;
  if (currentCommit) {
    current = await updateWorkingBranch({ book, branch, token, update, workflowHash: input.workflowHash, commit: currentCommit });
    branches.push({ branch, role: "current", status: current.published ? "published" : "local", commitSha: current.commitSha });
  }
  const paths = [...new Set([...(currentCommit?.paths ?? []), ...(publishingCommit?.paths ?? [])])];
  const reached = publishingDone?.status === "published" ? publishingDone : null;
  // A run follows a commit of the branch the workflow publishes from: the publishing branch's when it landed there, the working branch's when that IS it.
  const currentIsPublishing = !update.publishing;
  const followed = reached ?? (currentIsPublishing && current?.published ? { branch, commitSha: current.commitSha } : null);
  return {
    commitSha: followed?.commitSha ?? current?.commitSha ?? publishingDone?.commitSha ?? "",
    published: followed !== null,
    paths,
    publishedBranch: followed?.branch ?? null,
    branches,
    ...(offer ? { pullRequestOffer: offer } : {}),
  };
}

/** Opens the pull request that carries the update to a protected publishing branch: a branch from its head with the update on it, and the pull request from it. */
export async function openReaderUpdatePullRequest(input: { book: BookEntry; token: string; offer: PullRequestOffer; octokit?: Octokit; body: string }): Promise<UpdatePullRequest> {
  return openUpdatePullRequest(input.octokit ?? createTrackedGitHubClient(input.token), { owner: input.book.owner, repo: input.book.repo }, { base: input.offer.base, baseHeadSha: input.offer.baseHeadSha, message: input.offer.message, mutations: input.offer.mutations, title: input.offer.title, body: input.body });
}
