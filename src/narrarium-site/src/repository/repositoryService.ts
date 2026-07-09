import { Octokit } from "@octokit/rest";
import type { BookEntry } from "@/types/settings";
import type { BookStructure } from "@/types/book";
import {
  addLocalRepoLog,
  buildLocalBookStructure,
  createLocalCommit,
  discardUnpushedLocalCommits,
  getLocalRepository,
  getLocalRepositoryByBook,
  listAllLocalFiles,
  listDirtyLocalFiles,
  listLocalFiles,
  listUnpushedLocalCommits,
  markLocalRepositoryRemoteCheck,
  markLocalRepositoryCloneComplete,
  markLocalCommitsPushed,
  putCleanLocalFile,
  putLocalRepository,
  removeLocalFileEntry,
  removeLocalRepository,
  restoreUnpushedCommitsAsDirty,
  updateLocalRepositoryHead,
  type LocalRepositoryMeta,
  type LocalRepositoryFile,
} from "@/repository/localRepository";

const TEXT_EXTENSIONS = new Set(["md", "markdown", "txt", "json", "yaml", "yml", "toml", "csv", "html", "css", "js", "ts", "tsx"]);

export interface LocalCloneProgress {
  done: number;
  total: number;
  path?: string;
}

export interface RemoteStatusResult {
  remoteHeadSha: string;
  changed: boolean;
}

export interface PushResult {
  commitSha: string;
  files: number;
}

export interface SyncResult {
  pulled: number;
  keptLocal: number;
  committed: number;
  pushed: number;
}

function extension(path: string): string {
  return (path.split(".").pop() ?? "").toLowerCase();
}

function isTextPath(path: string): boolean {
  return TEXT_EXTENSIONS.has(extension(path));
}

function rawContentUrl(owner: string, repo: string, path: string, ref: string): string {
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function fetchRaw(token: string, owner: string, repo: string, branch: string, path: string): Promise<Uint8Array> {
  const response = await fetch(rawContentUrl(owner, repo, path, branch), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.raw",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`Download ${path}: ${response.status}`);
  const buffer = await response.arrayBuffer();
  // GitHub may ignore the "raw" media type and return the JSON contents
  // envelope ({ content: base64, encoding: "base64", ... }). Detect that and
  // decode the real bytes so the JSON never gets stored as the file content.
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer))) as { content?: string; encoding?: string };
      if (typeof json.content === "string" && json.encoding === "base64") {
        const binary = atob(json.content.replace(/\n/g, ""));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
      }
    } catch {
      // Not the JSON envelope after all — fall through to raw bytes.
    }
  }
  return new Uint8Array(buffer);
}

async function mapLimit<T>(items: T[], limit: number, run: (item: T, index: number) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      await run(items[current], current);
    }
  });
  await Promise.all(workers);
}

export async function ensureLocalBookStructure(input: {
  bookId: string;
  book: BookEntry;
  token: string;
  branch?: string;
  onProgress?: (progress: LocalCloneProgress) => void;
}): Promise<{ meta: LocalRepositoryMeta; structure: BookStructure; cloned: boolean }> {
  const octokit = new Octokit({ auth: input.token });
  const repoData = await octokit.rest.repos.get({ owner: input.book.owner, repo: input.book.repo });
  const defaultBranch = repoData.data.default_branch;
  const branch = input.branch || defaultBranch;
  const existing = await getLocalRepository(input.book.owner, input.book.repo, branch);
  if (existing) {
    // A repo is only trustworthy once its clone was verified complete. Legacy repos
    // (cloneComplete === undefined) and interrupted clones (=== false) get healed here.
    if (existing.cloneComplete === true) {
      return { meta: existing, structure: await buildLocalBookStructure(existing), cloned: false };
    }
    const repaired = await verifyAndRepairLocalRepository({ meta: existing, token: input.token, onProgress: input.onProgress });
    return { meta: repaired.meta, structure: repaired.structure, cloned: false };
  }

  await navigator.storage?.persist?.().catch(() => false);
  const ref = await octokit.rest.git.getRef({ owner: input.book.owner, repo: input.book.repo, ref: `heads/${branch}` });
  const headSha = ref.data.object.sha;
  const tree = await octokit.rest.git.getTree({ owner: input.book.owner, repo: input.book.repo, tree_sha: headSha, recursive: "1" });
  const blobs = tree.data.tree
    .filter((item) => item.type === "blob" && item.path)
    .map((item) => ({ path: item.path!, sha: item.sha, size: item.size ?? 0 }));
  const meta = await putLocalRepository({
    bookId: input.bookId,
    owner: input.book.owner,
    repo: input.book.repo,
    branch,
    defaultBranch,
    remoteHeadSha: headSha,
    clonedAt: new Date().toISOString(),
    // Mark incomplete up-front: only flip to true once every blob is stored, so an
    // interrupted clone can never masquerade as a complete, clean, synced repo.
    cloneComplete: false,
    expectedFileCount: blobs.length,
  });

  let done = 0;
  input.onProgress?.({ done, total: blobs.length });
  await mapLimit(blobs, 5, async (blob) => {
    const bytes = await fetchRaw(input.token, input.book.owner, input.book.repo, branch, blob.path);
    if (isTextPath(blob.path)) {
      await putCleanLocalFile({ repoId: meta.id, path: blob.path, kind: "text", text: new TextDecoder().decode(bytes), baseSha: blob.sha, size: bytes.byteLength });
    } else {
      await putCleanLocalFile({ repoId: meta.id, path: blob.path, kind: "binary", blob: new Blob([bytesToArrayBuffer(bytes)]), baseSha: blob.sha, size: bytes.byteLength });
    }
    done += 1;
    input.onProgress?.({ done, total: blobs.length, path: blob.path });
  });

  if (tree.data.truncated) {
    // Extremely large tree we could not enumerate in one request: leave the repo
    // marked incomplete so it is re-verified, rather than trusting a partial file set.
    await addLocalRepoLog(meta.id, "error", `Remote tree truncated at ${blobs.length} files; clone left unverified`);
  } else {
    await markLocalRepositoryCloneComplete(meta.id, blobs.length, headSha);
  }
  await addLocalRepoLog(meta.id, "clone", `Cloned ${blobs.length} files from ${meta.branch}`);

  const finalMeta = await getLocalRepository(input.book.owner, input.book.repo, branch) ?? meta;
  return { meta: finalMeta, structure: await buildLocalBookStructure(finalMeta), cloned: true };
}

/**
 * Fetch a single blob by its git object sha (exact content, independent of branch tip).
 */
async function fetchBlobBytes(octokit: Octokit, owner: string, repo: string, fileSha: string): Promise<Uint8Array> {
  const blob = await octokit.rest.git.getBlob({ owner, repo, file_sha: fileSha });
  if (blob.data.encoding === "base64") {
    const binary = atob(blob.data.content.replace(/\n/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new TextEncoder().encode(blob.data.content);
}

/**
 * Heal an incomplete or unverified local clone: re-fetch any blob from the repo's
 * recorded head tree that is missing locally (or stored clean with a stale base sha),
 * without touching the user's dirty/uncommitted edits. Marks the repo clone-complete.
 */
export async function verifyAndRepairLocalRepository(input: {
  meta: LocalRepositoryMeta;
  token: string;
  onProgress?: (progress: LocalCloneProgress) => void;
}): Promise<{ meta: LocalRepositoryMeta; structure: BookStructure; repaired: number }> {
  const { meta, token } = input;
  const octokit = new Octokit({ auth: token });
  // Verify against the head the local repo claims to be at, so we restore exactly that
  // tree; the normal fetch/pull flow advances to any newer remote head afterwards.
  const treeSha = meta.remoteHeadSha;
  const tree = await octokit.rest.git.getTree({ owner: meta.owner, repo: meta.repo, tree_sha: treeSha, recursive: "1" });
  const remoteBlobs = tree.data.tree
    .filter((item) => item.type === "blob" && item.path && item.sha)
    .map((item) => ({ path: item.path!, sha: item.sha!, size: item.size ?? 0 }));

  const localFiles = await listAllLocalFiles(meta.id);
  const localByPath = new Map(localFiles.map((file) => [file.path, file]));
  const missing = remoteBlobs.filter((blob) => {
    const local = localByPath.get(blob.path);
    if (!local) return true;
    // Only refetch a "clean" file whose recorded base sha no longer matches the tree;
    // never clobber modified/new/deleted (uncommitted) local work.
    return local.status === "clean" && Boolean(local.baseSha) && Boolean(blob.sha) && local.baseSha !== blob.sha;
  });

  let done = 0;
  input.onProgress?.({ done, total: missing.length });
  await mapLimit(missing, 5, async (blob) => {
    const bytes = await fetchBlobBytes(octokit, meta.owner, meta.repo, blob.sha);
    if (isTextPath(blob.path)) {
      await putCleanLocalFile({ repoId: meta.id, path: blob.path, kind: "text", text: new TextDecoder().decode(bytes), baseSha: blob.sha, size: bytes.byteLength });
    } else {
      await putCleanLocalFile({ repoId: meta.id, path: blob.path, kind: "binary", blob: new Blob([bytesToArrayBuffer(bytes)]), baseSha: blob.sha, size: bytes.byteLength });
    }
    done += 1;
    input.onProgress?.({ done, total: missing.length, path: blob.path });
  });

  if (!tree.data.truncated) {
    await markLocalRepositoryCloneComplete(meta.id, remoteBlobs.length);
    if (missing.length) await addLocalRepoLog(meta.id, "pull", `Repaired ${missing.length} missing file(s) on ${meta.branch}`);
  }

  const updated = await getLocalRepository(meta.owner, meta.repo, meta.branch) ?? meta;
  return { meta: updated, structure: await buildLocalBookStructure(updated), repaired: missing.length };
}

export async function getExistingLocalBookStructure(bookId: string): Promise<{ meta: LocalRepositoryMeta; structure: BookStructure } | null> {
  const meta = await getLocalRepositoryByBook(bookId);
  return meta ? { meta, structure: await buildLocalBookStructure(meta) } : null;
}

export async function commitLocalChanges(bookId: string, message: string) {
  const meta = await getLocalRepositoryByBook(bookId);
  if (!meta) throw new Error("Local repository is not ready.");
  const dirty = await listDirtyLocalFiles(meta.id);
  const commit = await createLocalCommit(meta.id, message.trim() || autoCommitMessage(dirty.map((file) => file.path)));
  await addLocalRepoLog(meta.id, "commit", `Committed ${commit.files.length} files: ${commit.message}`);
  return commit;
}

export function autoCommitMessage(paths: string[]): string {
  const names = paths.slice(0, 5).map((path) => path.split("/").pop() || path);
  const rest = Math.max(0, paths.length - names.length);
  const joined = names.length <= 1 ? names[0] ?? "files" : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  let message = `Update ${joined}${rest ? ` and ${rest} other files` : ""}`;
  if (message.length > 120) {
    const shorter = names.slice(0, 3).join(", ");
    message = `Update ${shorter}${paths.length > 3 ? ` and ${paths.length - 3} other files` : ""}`;
  }
  return message.slice(0, 120);
}

export async function fetchRemoteStatus(input: { bookId: string; token: string }): Promise<RemoteStatusResult> {
  const meta = await getLocalRepositoryByBook(input.bookId);
  if (!meta) throw new Error("Local repository is not ready.");
  const octokit = new Octokit({ auth: input.token });
  const ref = await octokit.rest.git.getRef({ owner: meta.owner, repo: meta.repo, ref: `heads/${meta.branch}` });
  const remoteHeadSha = ref.data.object.sha;
  const changed = remoteHeadSha !== meta.remoteHeadSha;
  await markLocalRepositoryRemoteCheck(meta.id, remoteHeadSha, changed);
  await addLocalRepoLog(meta.id, "fetch", changed ? `Remote changed: ${remoteHeadSha.slice(0, 7)}` : "Remote up to date");
  return { remoteHeadSha, changed };
}

export async function pullRemoteChanges(input: { bookId: string; token: string }): Promise<{ updated: number; remoteHeadSha: string }> {
  const meta = await getLocalRepositoryByBook(input.bookId);
  if (!meta) throw new Error("Local repository is not ready.");
  const dirty = await listDirtyLocalFiles(meta.id);
  const ahead = await listUnpushedLocalCommits(meta.id);

  const octokit = new Octokit({ auth: input.token });
  const ref = await octokit.rest.git.getRef({ owner: meta.owner, repo: meta.repo, ref: `heads/${meta.branch}` });
  const remoteHeadSha = ref.data.object.sha;
  if (remoteHeadSha === meta.remoteHeadSha && !dirty.length && !ahead.length) return { updated: 0, remoteHeadSha };
  const comparison = await octokit.rest.repos.compareCommitsWithBasehead({ owner: meta.owner, repo: meta.repo, basehead: `${meta.remoteHeadSha}...${remoteHeadSha}` });
  const remoteTree = await octokit.rest.git.getTree({ owner: meta.owner, repo: meta.repo, tree_sha: remoteHeadSha, recursive: "1" });
  const remoteBlobEntries = (remoteTree.data.tree ?? []).filter((entry) => entry.type === "blob" && entry.path);
  const remotePaths = new Set(remoteBlobEntries.map((entry) => entry.path!));
  const remoteShaByPath = new Map(remoteBlobEntries.map((entry) => [entry.path!, entry.sha]));
  const pathsToApply = new Set<string>();
  for (const file of comparison.data.files ?? []) pathsToApply.add(file.filename);
  for (const file of dirty) pathsToApply.add(file.path);
  for (const commit of ahead) for (const file of commit.files) pathsToApply.add(file.path);
  let updated = 0;
  for (const path of pathsToApply) {
    if (!remotePaths.has(path)) {
      await removePulledFile(meta.id, path);
      updated += 1;
      continue;
    }
    const bytes = await fetchRaw(input.token, meta.owner, meta.repo, meta.branch, path);
    await putCleanLocalFile({
      repoId: meta.id,
      path,
      kind: isTextPath(path) ? "text" : "binary",
      text: isTextPath(path) ? new TextDecoder().decode(bytes) : undefined,
      blob: isTextPath(path) ? undefined : new Blob([bytesToArrayBuffer(bytes)]),
      baseSha: remoteShaByPath.get(path),
      size: bytes.byteLength,
    });
    updated += 1;
  }
  if (ahead.length) await discardUnpushedLocalCommits(meta.id);
  await updateLocalRepositoryHead(meta.id, remoteHeadSha);
  await addLocalRepoLog(meta.id, "pull", `Pulled ${updated} files from remote (remote wins)`);
  return { updated, remoteHeadSha };
}

async function removePulledFile(repoId: string, path: string): Promise<void> {
  await removeLocalFileEntry(repoId, path);
}

export async function pushLocalCommits(input: { bookId: string; token: string }): Promise<PushResult> {
  const meta = await getLocalRepositoryByBook(input.bookId);
  if (!meta) throw new Error("Local repository is not ready.");
  const dirty = await listDirtyLocalFiles(meta.id);
  if (dirty.length) throw new Error("Commit local changes before pushing.");
  const commits = await listUnpushedLocalCommits(meta.id);
  if (!commits.length) throw new Error("No local commits to push.");

  const octokit = new Octokit({ auth: input.token });
  const ref = await octokit.rest.git.getRef({ owner: meta.owner, repo: meta.repo, ref: `heads/${meta.branch}` });
  const remoteHeadSha = ref.data.object.sha;
  const baseCommit = await octokit.rest.git.getCommit({ owner: meta.owner, repo: meta.repo, commit_sha: remoteHeadSha });
  const files = await listAllLocalFiles(meta.id);
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  const changedPaths = new Map<string, LocalRepositoryFile | null>();
  for (const commit of commits) {
    for (const file of commit.files) changedPaths.set(file.path, file.status === "deleted" ? null : fileByPath.get(file.path) ?? null);
  }

  // A deletion entry whose path is a directory (or missing) on the remote tree
  // triggers GitRPC::BadObjectState. Only keep deletions that target an actual blob.
  const remoteBlobPaths = new Set<string>();
  try {
    const baseTree = await octokit.rest.git.getTree({ owner: meta.owner, repo: meta.repo, tree_sha: baseCommit.data.tree.sha, recursive: "1" });
    for (const entry of baseTree.data.tree ?? []) {
      if (entry.type === "blob" && entry.path) remoteBlobPaths.add(entry.path);
    }
  } catch {
    // If we cannot read the base tree, fall back to attempting all deletions.
  }

  const pushedShas: Record<string, string | null> = {};
  const treeEntries = [] as Array<{ path: string; mode: "100644"; type: "blob"; sha: string | null }>;
  for (const [path, file] of changedPaths) {
    if (!file) {
      // Skip deletions for paths that are not blobs on the remote (avoids BadObjectState).
      if (remoteBlobPaths.size > 0 && !remoteBlobPaths.has(path)) {
        pushedShas[path] = null;
        continue;
      }
      treeEntries.push({ path, mode: "100644", type: "blob", sha: null });
      pushedShas[path] = null;
      continue;
    }
    const blob = await createBlobForFile(octokit, meta, file);
    treeEntries.push({ path, mode: "100644", type: "blob", sha: blob });
    pushedShas[path] = blob;
  }
  if (treeEntries.length === 0) {
    // Nothing valid to push (e.g. only stale directory-deletions). Mark commits
    // pushed against the current remote head so the local state settles.
    await markLocalCommitsPushed(meta.id, commits.map((entry) => entry.id), remoteHeadSha, pushedShas);
    await addLocalRepoLog(meta.id, "push", `No pushable changes; settled local commits at ${remoteHeadSha.slice(0, 7)}`);
    return { commitSha: remoteHeadSha, files: 0 };
  }
  const tree = await octokit.rest.git.createTree({ owner: meta.owner, repo: meta.repo, base_tree: baseCommit.data.tree.sha, tree: treeEntries });
  const commit = await octokit.rest.git.createCommit({ owner: meta.owner, repo: meta.repo, message: commits.map((entry) => entry.message).join("\n\n"), tree: tree.data.sha, parents: [remoteHeadSha] });
  await octokit.rest.git.updateRef({ owner: meta.owner, repo: meta.repo, ref: `heads/${meta.branch}`, sha: commit.data.sha });
  await markLocalCommitsPushed(meta.id, commits.map((entry) => entry.id), commit.data.sha, pushedShas);
  await addLocalRepoLog(meta.id, "push", `Pushed ${treeEntries.length} files to ${commit.data.sha.slice(0, 7)} (local wins)`);
  return { commitSha: commit.data.sha, files: treeEntries.length };
}

export async function syncFullRepository(input: { bookId: string; token: string }): Promise<SyncResult> {
  const meta = await getLocalRepositoryByBook(input.bookId);
  if (!meta) throw new Error("Local repository is not ready.");
  await restoreUnpushedCommitsAsDirty(meta.id);
  const octokit = new Octokit({ auth: input.token });
  const ref = await octokit.rest.git.getRef({ owner: meta.owner, repo: meta.repo, ref: `heads/${meta.branch}` });
  const remoteHeadSha = ref.data.object.sha;
  const remoteChanged = remoteHeadSha !== meta.remoteHeadSha;
  let pulled = 0;
  let keptLocal = 0;
  if (remoteChanged) {
    const remoteChanges = await remoteChangedFiles(octokit, meta, remoteHeadSha);
    const dirty = await listDirtyLocalFiles(meta.id);
    const dirtyByPath = new Map(dirty.map((file) => [file.path, file]));
    const remoteTree = await octokit.rest.git.getTree({ owner: meta.owner, repo: meta.repo, tree_sha: remoteHeadSha, recursive: "1" });
    const remoteBlobEntries = (remoteTree.data.tree ?? []).filter((entry) => entry.type === "blob" && entry.path);
    const remotePaths = new Set(remoteBlobEntries.map((entry) => entry.path!));
    const remoteShaByPath = new Map(remoteBlobEntries.map((entry) => [entry.path!, entry.sha]));
    for (const [path, remoteDate] of remoteChanges) {
      const local = dirtyByPath.get(path);
      if (local && new Date(local.updatedAt).getTime() >= remoteDate.getTime()) {
        keptLocal += 1;
        continue;
      }
      if (!remotePaths.has(path)) {
        await removePulledFile(meta.id, path);
        pulled += 1;
        continue;
      }
      const bytes = await fetchRaw(input.token, meta.owner, meta.repo, meta.branch, path);
      await putCleanLocalFile({
        repoId: meta.id,
        path,
        kind: isTextPath(path) ? "text" : "binary",
        text: isTextPath(path) ? new TextDecoder().decode(bytes) : undefined,
        blob: isTextPath(path) ? undefined : new Blob([bytesToArrayBuffer(bytes)]),
        baseSha: remoteShaByPath.get(path),
        size: bytes.byteLength,
      });
      pulled += 1;
    }
    await updateLocalRepositoryHead(meta.id, remoteHeadSha);
    await addLocalRepoLog(meta.id, "pull", `Sync pulled ${pulled} remote files, kept ${keptLocal} local files by timestamp`);
  } else {
    await markLocalRepositoryRemoteCheck(meta.id, remoteHeadSha, false);
  }
  const dirtyAfterMerge = await listDirtyLocalFiles(meta.id);
  let committed = 0;
  if (dirtyAfterMerge.length) {
    const commit = await createLocalCommit(meta.id, autoCommitMessage(dirtyAfterMerge.map((file) => file.path)));
    committed = commit.files.length;
    await addLocalRepoLog(meta.id, "commit", `Sync auto-committed ${committed} files: ${commit.message}`);
  }
  const ahead = await listUnpushedLocalCommits(meta.id);
  let pushed = 0;
  if (ahead.length) pushed = (await pushLocalCommits(input)).files;
  await addLocalRepoLog(meta.id, "push", `Full sync complete: pulled ${pulled}, kept local ${keptLocal}, committed ${committed}, pushed ${pushed}`);
  return { pulled, keptLocal, committed, pushed };
}

async function remoteChangedFiles(octokit: Octokit, meta: LocalRepositoryMeta, remoteHeadSha: string): Promise<Map<string, Date>> {
  const comparison = await octokit.rest.repos.compareCommitsWithBasehead({ owner: meta.owner, repo: meta.repo, basehead: `${meta.remoteHeadSha}...${remoteHeadSha}` });
  const lastCommit = comparison.data.commits[comparison.data.commits.length - 1];
  const fallbackDate = new Date(lastCommit?.commit.committer?.date ?? Date.now());
  const map = new Map<string, Date>();
  const commits = comparison.data.commits.slice(-50);
  for (const commitSummary of commits) {
    const date = new Date(commitSummary.commit.committer?.date ?? fallbackDate);
    const detail = await octokit.rest.repos.getCommit({ owner: meta.owner, repo: meta.repo, ref: commitSummary.sha }).catch(() => null);
    for (const file of detail?.data.files ?? []) map.set(file.filename, date);
  }
  for (const file of comparison.data.files ?? []) if (!map.has(file.filename)) map.set(file.filename, fallbackDate);
  return map;
}

export async function removeLocalWorkingCopy(bookId: string): Promise<void> {
  const meta = await getLocalRepositoryByBook(bookId);
  if (!meta) return;
  await removeLocalRepository(meta.id);
}

export async function recloneLocalWorkingCopy(input: {
  bookId: string;
  book: BookEntry;
  token: string;
  branch?: string;
  onProgress?: (progress: LocalCloneProgress) => void;
}): Promise<{ meta: LocalRepositoryMeta; structure: BookStructure; cloned: boolean }> {
  await removeLocalWorkingCopy(input.bookId);
  const result = await ensureLocalBookStructure(input);
  await addLocalRepoLog(result.meta.id, "reset", "Recloned local working copy");
  return result;
}

/**
 * Overwrite the remote branch so it matches the local working copy exactly.
 *
 * Use this to recover from a local/remote divergence: it snapshots every
 * non-deleted local file into a fresh tree (no base_tree), commits it on top of
 * the current remote head, then rebases the local baseline so the working copy
 * is reported clean and consistent again.
 *
 * A full tree with no base_tree avoids the `GitRPC::BadObjectState` error that
 * corrupted repositories hit on incremental pushes (e.g. a stale "deleted"
 * tombstone pointing at a path that is a directory on the remote). Invalid or
 * colliding paths (a blob that is also used as a directory) are dropped so the
 * tree is always well-formed.
 */
export async function overwriteRemoteWithLocal(input: { bookId: string; token: string }): Promise<PushResult> {
  const meta = await getLocalRepositoryByBook(input.bookId);
  if (!meta) throw new Error("Local repository is not ready.");
  // Refuse to make an unverified/partial local copy the source of truth: doing so would
  // overwrite the remote branch with an incomplete tree and destroy files that never
  // finished cloning. Require a verified-complete clone first.
  if (meta.cloneComplete !== true) {
    throw new Error("Local working copy is not fully synced yet. Reload the book (or re-clone) so all files are present before using it as the source of truth.");
  }

  const octokit = new Octokit({ auth: input.token });
  const ref = await octokit.rest.git.getRef({ owner: meta.owner, repo: meta.repo, ref: `heads/${meta.branch}` });
  const remoteHeadSha = ref.data.object.sha;

  // The app's current view = all non-deleted local files.
  const allLocal = await listLocalFiles(meta.id);
  if (allLocal.length === 0) throw new Error("Local working copy is empty.");

  // Drop malformed paths (empty segments, leading/trailing slashes, . / ..).
  const wellFormed = allLocal.filter((file) => {
    const p = file.path;
    if (!p || p.startsWith("/") || p.endsWith("/") || p.includes("//")) return false;
    return !p.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
  });

  // Any path used as a directory prefix cannot also exist as a blob (git tree
  // conflict). Collect directory prefixes, then drop bare files that collide.
  const directoryPrefixes = new Set<string>();
  for (const file of wellFormed) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) directoryPrefixes.add(parts.slice(0, i).join("/"));
  }
  const files = wellFormed.filter((file) => !directoryPrefixes.has(file.path));
  const droppedPaths = new Set(allLocal.filter((f) => !files.includes(f)).map((f) => f.path));

  if (files.length === 0) throw new Error("No valid files to push after removing conflicting paths.");

  const treeEntries: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }> = [];
  const pushedShas: Record<string, string> = {};
  await mapLimit(files, 6, async (file) => {
    const blob = await createBlobForFile(octokit, meta, file);
    treeEntries.push({ path: file.path, mode: "100644", type: "blob", sha: blob });
    pushedShas[file.path] = blob;
  });

  // Full tree (no base_tree) → remote will contain EXACTLY these files.
  const tree = await octokit.rest.git.createTree({ owner: meta.owner, repo: meta.repo, tree: treeEntries });
  const commit = await octokit.rest.git.createCommit({
    owner: meta.owner,
    repo: meta.repo,
    message: "Resync: local working copy as source of truth",
    tree: tree.data.sha,
    parents: [remoteHeadSha],
  });
  await octokit.rest.git.updateRef({ owner: meta.owner, repo: meta.repo, ref: `heads/${meta.branch}`, sha: commit.data.sha });

  // Rebase the local baseline so everything reads clean and consistent again.
  await discardUnpushedLocalCommits(meta.id);
  const allFiles = await listAllLocalFiles(meta.id);
  for (const file of allFiles) {
    // Remove deletion tombstones and any dropped/conflicting entries.
    if (file.status === "deleted" || droppedPaths.has(file.path)) {
      await removeLocalFileEntry(meta.id, file.path);
      continue;
    }
    await putCleanLocalFile({
      repoId: meta.id,
      path: file.path,
      kind: file.kind,
      text: file.kind === "text" ? file.text ?? "" : undefined,
      blob: file.kind === "binary" ? file.blob : undefined,
      baseSha: pushedShas[file.path],
      size: file.size,
    });
  }
  await updateLocalRepositoryHead(meta.id, commit.data.sha);
  await addLocalRepoLog(meta.id, "push", `Resynced remote to match local (${files.length} files) at ${commit.data.sha.slice(0, 7)}`);

  return { commitSha: commit.data.sha, files: files.length };
}

async function createBlobForFile(octokit: Octokit, meta: LocalRepositoryMeta, file: LocalRepositoryFile): Promise<string> {
  if (file.kind === "text") {
    const result = await octokit.rest.git.createBlob({ owner: meta.owner, repo: meta.repo, content: file.text ?? "", encoding: "utf-8" });
    return result.data.sha;
  }
  const bytes = file.blob ? new Uint8Array(await file.blob.arrayBuffer()) : new Uint8Array();
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  const result = await octokit.rest.git.createBlob({ owner: meta.owner, repo: meta.repo, content: btoa(binary), encoding: "base64" });
  return result.data.sha;
}
