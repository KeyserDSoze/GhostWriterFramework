import type { BookEntry } from "@/types/settings";
import { getLocalRepository, listUnpushedLocalCommits } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { RepositoryConflictError, commitAndPushTextFileMutation } from "@/repository/safeRepositoryMutation";
import { captureImmediateMutation } from "@/assistant/immediateMutation";
import type { ReaderUpdateDecision } from "@/readerUpdate/decision";
import { buildReaderUpdateCommit } from "@/readerUpdate/commit";

export interface ReaderUpdateOutcome {
  commitSha: string;
  /** The commit is on GitHub: a run of the publishing workflow can follow. `false`: it is on this device and the next sync publishes it. */
  published: boolean;
  paths: string[];
}

/**
 * Makes the one commit of an update of the reader through the same path as any change of the book: the working copy first, then the publication with the
 * book's credential. Offline, without a credential or with other changes of the book still to publish, the commit stays on this device (`published: false`).
 * Nothing is written if the owner has not agreed to replace the edits of a customized workflow (`CustomizedWorkflowRefused`), nor if the workflow or any file
 * of the update is no longer what the check read (`RepositoryConflictError`).
 */
export async function applyReaderUpdate(input: {
  book: BookEntry;
  branch: string;
  token: string;
  update: Extract<ReaderUpdateDecision, { kind: "update" }>;
  workflowHash: string | null;
  replaceEdits: boolean;
}): Promise<ReaderUpdateOutcome> {
  const { book, branch, token, update } = input;
  // The workflow is read again, with the head of the branch, as every immediate change of the book is: it is the file whose text the owner may have edited.
  const snapshot = await captureImmediateMutation({ token, book, branch, path: update.workflow.path });
  if (snapshot.hash !== input.workflowHash) throw new RepositoryConflictError(`File changed since it was read: ${update.workflow.path}`, update.workflow.path);
  const commit = buildReaderUpdateCommit(update, { replaceEdits: input.replaceEdits, workflowHash: snapshot.hash });
  const { commitSha } = await commitAndPushTextFileMutation({ token, book, branch, expectedRemoteHeadSha: snapshot.remoteHeadSha, message: commit.message, mutations: commit.mutations, push: update.delivery === "now" });
  const scope = captureRepositoryOperationScope();
  const local = await getLocalRepository(book.owner, book.repo, branch, scope).catch(() => null);
  const ahead = local ? await listUnpushedLocalCommits(local.id) : [];
  return { commitSha, published: update.delivery === "now" && ahead.length === 0, paths: commit.paths };
}
