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
  listUnpushedLocalCommits,
  markLocalRepositoryRemoteCheck,
  markLocalCommitsPushed,
  putCleanLocalFile,
  putLocalRepository,
  removeLocalFileEntry,
  removeLocalRepository,
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
  return new Uint8Array(await response.arrayBuffer());
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
    return { meta: existing, structure: await buildLocalBookStructure(existing), cloned: false };
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

  await addLocalRepoLog(meta.id, "clone", `Cloned ${blobs.length} files from ${meta.branch}`);

  return { meta, structure: await buildLocalBookStructure(meta), cloned: true };
}

export async function getExistingLocalBookStructure(bookId: string): Promise<{ meta: LocalRepositoryMeta; structure: BookStructure } | null> {
  const meta = await getLocalRepositoryByBook(bookId);
  return meta ? { meta, structure: await buildLocalBookStructure(meta) } : null;
}

export async function commitLocalChanges(bookId: string, message: string) {
  const meta = await getLocalRepositoryByBook(bookId);
  if (!meta) throw new Error("Local repository is not ready.");
  const commit = await createLocalCommit(meta.id, message.trim() || "Update book files");
  await addLocalRepoLog(meta.id, "commit", `Committed ${commit.files.length} files: ${commit.message}`);
  return commit;
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

  const pushedShas: Record<string, string | null> = {};
  const treeEntries = [] as Array<{ path: string; mode: "100644"; type: "blob"; sha: string | null }>;
  for (const [path, file] of changedPaths) {
    if (!file) {
      treeEntries.push({ path, mode: "100644", type: "blob", sha: null });
      pushedShas[path] = null;
      continue;
    }
    const blob = await createBlobForFile(octokit, meta, file);
    treeEntries.push({ path, mode: "100644", type: "blob", sha: blob });
    pushedShas[path] = blob;
  }
  const tree = await octokit.rest.git.createTree({ owner: meta.owner, repo: meta.repo, base_tree: baseCommit.data.tree.sha, tree: treeEntries });
  const commit = await octokit.rest.git.createCommit({ owner: meta.owner, repo: meta.repo, message: commits.map((entry) => entry.message).join("\n\n"), tree: tree.data.sha, parents: [remoteHeadSha] });
  await octokit.rest.git.updateRef({ owner: meta.owner, repo: meta.repo, ref: `heads/${meta.branch}`, sha: commit.data.sha });
  await markLocalCommitsPushed(meta.id, commits.map((entry) => entry.id), commit.data.sha, pushedShas);
  await addLocalRepoLog(meta.id, "push", `Pushed ${changedPaths.size} files to ${commit.data.sha.slice(0, 7)} (local wins)`);
  return { commitSha: commit.data.sha, files: changedPaths.size };
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
