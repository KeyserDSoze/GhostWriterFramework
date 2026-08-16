import type { Octokit } from "@octokit/rest";

export type IntendedRemoteRevision = {
  path: string;
  content?: string | null;
  blobSha?: string | null;
};

function decodeBase64Utf8(value: string): string {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function generatedCommitIsAncestor(octokit: Octokit, owner: string, repo: string, generatedCommitSha: string, latestHeadSha: string): Promise<boolean> {
  if (generatedCommitSha === latestHeadSha) return true;
  const queue = [latestHeadSha];
  const visited = new Set<string>();
  while (queue.length && visited.size < 100) {
    const sha = queue.shift()!;
    if (visited.has(sha)) continue;
    visited.add(sha);
    const commit = await octokit.rest.git.getCommit({ owner, repo, commit_sha: sha }).catch(() => null);
    if (!commit) return false;
    for (const parent of commit.data.parents ?? []) {
      if (parent.sha === generatedCommitSha) return true;
      if (!visited.has(parent.sha)) queue.push(parent.sha);
    }
  }
  return false;
}

export async function reconcileRemoteMutation(input: {
  octokit: Octokit;
  owner: string;
  repo: string;
  branch: string;
  generatedCommitSha: string;
  revisions: IntendedRemoteRevision[];
}): Promise<{ landed: boolean; headSha?: string; blobShas?: Record<string, string | null> }> {
  const latest = await input.octokit.rest.git.getRef({ owner: input.owner, repo: input.repo, ref: `heads/${input.branch}` }).catch(() => null);
  const headSha = latest?.data.object.sha;
  if (!headSha || !await generatedCommitIsAncestor(input.octokit, input.owner, input.repo, input.generatedCommitSha, headSha)) return { landed: false, headSha };

  const tree = await input.octokit.rest.git.getTree({ owner: input.owner, repo: input.repo, tree_sha: headSha, recursive: "1" }).catch(() => null);
  if (!tree || tree.data.truncated) return { landed: false, headSha };
  const blobs = new Map<string, string | null>(tree.data.tree.filter((entry) => entry.type === "blob" && entry.path).map((entry) => [entry.path!, typeof entry.sha === "string" ? entry.sha : null]));
  const blobShas: Record<string, string | null> = {};
  for (const revision of input.revisions) {
    if (revision.content === undefined && revision.blobSha === undefined) continue;
    const actualSha = blobs.get(revision.path) ?? null;
    blobShas[revision.path] = actualSha;
    if (revision.content === null || revision.blobSha === null) {
      if (actualSha !== null) return { landed: false, headSha };
      continue;
    }
    if (revision.blobSha !== undefined) {
      if (actualSha !== revision.blobSha) return { landed: false, headSha };
      continue;
    }
    if (!actualSha) return { landed: false, headSha };
    const blob = await input.octokit.rest.git.getBlob({ owner: input.owner, repo: input.repo, file_sha: actualSha }).catch(() => null);
    if (!blob || blob.data.encoding !== "base64" || decodeBase64Utf8(blob.data.content) !== revision.content) return { landed: false, headSha };
  }
  return { landed: true, headSha, blobShas };
}
