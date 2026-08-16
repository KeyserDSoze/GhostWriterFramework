import { isGitHubFileNotFoundError, readFileWithSha } from "@/github/githubClient";
import type { BookEntry } from "@/types/settings";
import {
  commitAndPushTextFileMutation,
  resolveRepositoryHeadForMutation,
  sha256Text,
} from "@/repository/safeRepositoryMutation";

export interface ImmediateMutationSnapshot {
  path: string;
  content: string | null;
  sha: string | null;
  hash: string | null;
  remoteHeadSha: string;
}

export async function captureImmediateMutation(input: {
  token: string;
  book: BookEntry;
  branch: string;
  path: string;
  remoteHeadSha?: string;
}): Promise<ImmediateMutationSnapshot> {
  const remoteHeadSha = input.remoteHeadSha ?? await resolveRepositoryHeadForMutation(input);
  const current = await readFileWithSha(input.token, input.book.owner, input.book.repo, input.branch, input.path).catch((error) => {
    if (isGitHubFileNotFoundError(error)) return null;
    throw error;
  });
  return {
    path: input.path,
    content: current?.content ?? null,
    sha: current?.sha ?? null,
    hash: current ? await sha256Text(current.content) : null,
    remoteHeadSha,
  };
}

export async function commitImmediateMutation(input: {
  token: string;
  book: BookEntry;
  branch: string;
  snapshot: ImmediateMutationSnapshot;
  content: string;
  message: string;
  signal?: AbortSignal;
}): Promise<string> {
  return commitImmediateMutations({
    ...input,
    snapshots: [{ snapshot: input.snapshot, content: input.content }],
  });
}

export async function commitImmediateMutations(input: {
  token: string;
  book: BookEntry;
  branch: string;
  snapshots: Array<{ snapshot: ImmediateMutationSnapshot; content: string | null }>;
  message: string;
  signal?: AbortSignal;
}): Promise<string> {
  input.signal?.throwIfAborted();
  const remoteHeads = new Set(input.snapshots.map(({ snapshot }) => snapshot.remoteHeadSha));
  if (remoteHeads.size !== 1) throw new Error("Immediate mutations must share one source head.");
  const result = await commitAndPushTextFileMutation({
    token: input.token,
    book: input.book,
    branch: input.branch,
    expectedRemoteHeadSha: input.snapshots[0].snapshot.remoteHeadSha,
    message: input.message,
    mutations: input.snapshots.map(({ snapshot, content }) => ({ path: snapshot.path, content, expectedCurrentHash: snapshot.hash })),
    signal: input.signal,
  });
  return result.commitSha;
}

export function mergeManagedFrontmatter(
  existing: Record<string, unknown>,
  managed: Record<string, unknown>,
  managedKeys: readonly string[],
): Record<string, unknown> {
  const preserved = Object.fromEntries(Object.entries(existing).filter(([key]) => !managedKeys.includes(key)));
  return { ...preserved, ...managed };
}
