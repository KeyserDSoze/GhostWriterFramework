import type { BookStructure, BookFile, Chapter, Paragraph } from "@/types/book";
import {
  buildBookAuditPath,
  buildChapterAuditPath,
  buildParagraphAuditPath,
} from "@/narrarium/auditPaths";

const DB_NAME = "narrarium-local-repositories";
const DB_VERSION = 4;

export type LocalFileStatus = "clean" | "modified" | "new" | "deleted";
export type LocalFileKind = "text" | "binary";

export interface LocalRepositoryMeta {
  id: string;
  bookId: string;
  owner: string;
  repo: string;
  branch: string;
  defaultBranch: string;
  remoteHeadSha: string;
  remoteChanged?: boolean;
  clonedAt: string;
  updatedAt: string;
  lastFetchAt?: string;
  /**
   * True only once every file blob of the cloned tree has been stored locally.
   * Undefined on repos cloned before this flag existed (treated as unverified).
   * A repo is considered fully in sync only when this is strictly `true`.
   */
  cloneComplete?: boolean;
  /** Number of blobs the remote tree had at clone/verify time. */
  expectedFileCount?: number;
}

export interface LocalRepositoryFile {
  key: string;
  repoId: string;
  path: string;
  kind: LocalFileKind;
  text?: string;
  blob?: Blob;
  baseSha?: string;
  /** SHA-256 of the clean/base content, used for dirty tracking. */
  baseHash?: string;
  currentHash: string;
  status: LocalFileStatus;
  /** True when this file change is already included in a local commit awaiting push. */
  committed?: boolean;
  size: number;
  updatedAt: string;
}

export interface LocalCommitFile {
  path: string;
  status: Exclude<LocalFileStatus, "clean">;
  kind: LocalFileKind;
  hash: string;
}

export interface LocalCommit {
  id: string;
  repoId: string;
  message: string;
  createdAt: string;
  files: LocalCommitFile[];
  pushed: boolean;
  remoteCommitSha?: string;
}

export type LocalRepoLogKind = "clone" | "fetch" | "pull" | "commit" | "push" | "backup" | "reset" | "error";

export interface LocalRepoLogEntry {
  id: string;
  repoId: string;
  kind: LocalRepoLogKind;
  message: string;
  createdAt: string;
}

export interface LocalRepoStatus {
  clean: number;
  modified: number;
  new: number;
  deleted: number;
  dirty: number;
  ahead: number;
}

function repoId(owner: string, repo: string, branch: string): string {
  return `${owner}/${repo}#${branch}`.toLowerCase();
}

function fileKey(id: string, path: string): string {
  return `${id}::${path}`;
}

function slugToTitle(slug: string): string {
  return slug
    .replace(/^\d{3}[-_]?/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase()) || slug;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("repositories")) {
        const repositories = db.createObjectStore("repositories", { keyPath: "id" });
        repositories.createIndex("bookId", "bookId", { unique: false });
        repositories.createIndex("remote", ["owner", "repo", "branch"], { unique: false });
      }
      if (!db.objectStoreNames.contains("files")) {
        const files = db.createObjectStore("files", { keyPath: "key" });
        files.createIndex("repoId", "repoId", { unique: false });
        files.createIndex("repoStatus", ["repoId", "status"], { unique: false });
      }
      if (!db.objectStoreNames.contains("commits")) {
        const commits = db.createObjectStore("commits", { keyPath: "id" });
        commits.createIndex("repoId", "repoId", { unique: false });
      }
      if (!db.objectStoreNames.contains("logs")) {
        const logs = db.createObjectStore("logs", { keyPath: "id" });
        logs.createIndex("repoId", "repoId", { unique: false });
      }
    };
  });
  return dbPromise;
}

function txStore<T>(storeName: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const request = run(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.onerror = () => reject(tx.error);
  }));
}

function allFromIndex<T>(storeName: string, indexName: string, query: IDBValidKey | IDBKeyRange): Promise<T[]> {
  return openDb().then((db) => new Promise<T[]>((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).index(indexName).getAll(query);
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  }));
}

async function hashText(text: string): Promise<string> {
  return hashBytes(new TextEncoder().encode(text));
}

async function hashBlob(blob: Blob): Promise<string> {
  return hashBytes(new Uint8Array(await blob.arrayBuffer()));
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytesToArrayBuffer(bytes));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function statusAfterWrite(existing: LocalRepositoryFile | undefined, currentHash: string): LocalFileStatus {
  if (!existing || existing.status === "new") return "new";
  if (existing.baseHash && currentHash === existing.baseHash) return "clean";
  return "modified";
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function makeRepoId(owner: string, repo: string, branch: string): string {
  return repoId(owner, repo, branch);
}

export async function putLocalRepository(meta: Omit<LocalRepositoryMeta, "id" | "updatedAt">): Promise<LocalRepositoryMeta> {
  const now = new Date().toISOString();
  const full: LocalRepositoryMeta = { ...meta, id: repoId(meta.owner, meta.repo, meta.branch), updatedAt: now };
  await txStore("repositories", "readwrite", (store) => store.put(full));
  return full;
}

export async function getLocalRepository(owner: string, repo: string, branch: string): Promise<LocalRepositoryMeta | null> {
  return (await txStore<LocalRepositoryMeta | undefined>("repositories", "readonly", (store) => store.get(repoId(owner, repo, branch)))) ?? null;
}

export async function getLocalRepositoryByBook(bookId: string): Promise<LocalRepositoryMeta | null> {
  const rows = await allFromIndex<LocalRepositoryMeta>("repositories", "bookId", bookId);
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

export async function listLocalFiles(repoIdValue: string): Promise<LocalRepositoryFile[]> {
  const files = await allFromIndex<LocalRepositoryFile>("files", "repoId", repoIdValue);
  return files.filter((file) => file.status !== "deleted").sort((a, b) => a.path.localeCompare(b.path));
}

export async function listAllLocalFiles(repoIdValue: string): Promise<LocalRepositoryFile[]> {
  const files = await allFromIndex<LocalRepositoryFile>("files", "repoId", repoIdValue);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function removeLocalRepository(repoIdValue: string): Promise<void> {
  const db = await openDb();
  const stores = ["repositories", "files", "commits", "logs"].filter((store) => db.objectStoreNames.contains(store));
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(stores, "readwrite");
    tx.objectStore("repositories").delete(repoIdValue);
    for (const storeName of ["files", "commits", "logs"]) {
      if (!stores.includes(storeName)) continue;
      const store = tx.objectStore(storeName);
      const index = store.index("repoId");
      const request = index.openKeyCursor(IDBKeyRange.only(repoIdValue));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        store.delete(cursor.primaryKey);
        cursor.continue();
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function listDirtyLocalFiles(repoIdValue: string): Promise<LocalRepositoryFile[]> {
  return (await listAllLocalFiles(repoIdValue)).filter((file) => file.status !== "clean" && !file.committed);
}

export async function getLocalFile(repoIdValue: string, path: string): Promise<LocalRepositoryFile | null> {
  const file = await txStore<LocalRepositoryFile | undefined>("files", "readonly", (store) => store.get(fileKey(repoIdValue, path)));
  return file && file.status !== "deleted" ? file : null;
}

export async function putCleanLocalFile(input: {
  repoId: string;
  path: string;
  kind: LocalFileKind;
  text?: string;
  blob?: Blob;
  baseSha?: string;
  size: number;
}): Promise<LocalRepositoryFile> {
  const currentHash = input.kind === "text" ? await hashText(input.text ?? "") : await hashBlob(input.blob ?? new Blob());
  const file: LocalRepositoryFile = {
    key: fileKey(input.repoId, input.path),
    repoId: input.repoId,
    path: input.path,
    kind: input.kind,
    text: input.text,
    blob: input.blob,
    baseSha: input.baseSha,
    baseHash: currentHash,
    currentHash,
    status: "clean",
    committed: false,
    size: input.size,
    updatedAt: new Date().toISOString(),
  };
  await txStore("files", "readwrite", (store) => store.put(file));
  return file;
}

export async function writeLocalText(repoIdValue: string, path: string, text: string): Promise<LocalRepositoryFile> {
  const existing = await txStore<LocalRepositoryFile | undefined>("files", "readonly", (store) => store.get(fileKey(repoIdValue, path)));
  const currentHash = await hashText(text);
  const file: LocalRepositoryFile = {
    key: fileKey(repoIdValue, path),
    repoId: repoIdValue,
    path,
    kind: "text",
    text,
    baseSha: existing?.baseSha,
    baseHash: existing?.baseHash,
    currentHash,
    status: statusAfterWrite(existing, currentHash),
    committed: false,
    size: new TextEncoder().encode(text).byteLength,
    updatedAt: new Date().toISOString(),
  };
  await txStore("files", "readwrite", (store) => store.put(file));
  return file;
}

export async function writeLocalBinary(repoIdValue: string, path: string, bytes: Uint8Array): Promise<LocalRepositoryFile> {
  const existing = await txStore<LocalRepositoryFile | undefined>("files", "readonly", (store) => store.get(fileKey(repoIdValue, path)));
  const blob = new Blob([bytesToArrayBuffer(bytes)]);
  const currentHash = await hashBytes(bytes);
  const file: LocalRepositoryFile = {
    key: fileKey(repoIdValue, path),
    repoId: repoIdValue,
    path,
    kind: "binary",
    blob,
    baseSha: existing?.baseSha,
    baseHash: existing?.baseHash,
    currentHash,
    status: statusAfterWrite(existing, currentHash),
    committed: false,
    size: bytes.byteLength,
    updatedAt: new Date().toISOString(),
  };
  await txStore("files", "readwrite", (store) => store.put(file));
  return file;
}

export type LocalFileAtomicWrite =
  | { path: string; kind: "text"; text: string }
  | { path: string; kind: "binary"; bytes: Uint8Array };

/** Apply a prepared set of local file moves/updates in one IndexedDB transaction. */
export async function applyLocalFileChangesAtomically(
  repoIdValue: string,
  deletePaths: Iterable<string>,
  writes: LocalFileAtomicWrite[],
): Promise<void> {
  const originals = await allFromIndex<LocalRepositoryFile>("files", "repoId", repoIdValue);
  const originalsByPath = new Map(originals.map((file) => [file.path, file]));
  const deletes = new Set(deletePaths);
  const writePaths = new Set<string>();
  for (const write of writes) {
    if (writePaths.has(write.path)) throw new Error(`Duplicate local file write: ${write.path}`);
    if (deletes.has(write.path)) throw new Error(`Cannot delete and write local file in one operation: ${write.path}`);
    writePaths.add(write.path);
  }

  const now = new Date().toISOString();
  const prepared = await Promise.all(writes.map(async (write): Promise<LocalRepositoryFile> => {
    const existing = originalsByPath.get(write.path);
    const currentHash = write.kind === "text" ? await hashText(write.text) : await hashBytes(write.bytes);
    return {
      key: fileKey(repoIdValue, write.path),
      repoId: repoIdValue,
      path: write.path,
      kind: write.kind,
      ...(write.kind === "text" ? { text: write.text } : { blob: new Blob([bytesToArrayBuffer(write.bytes)]) }),
      baseSha: existing?.baseSha,
      baseHash: existing?.baseHash,
      currentHash,
      status: statusAfterWrite(existing, currentHash),
      committed: false,
      size: write.kind === "text" ? new TextEncoder().encode(write.text).byteLength : write.bytes.byteLength,
      updatedAt: now,
    };
  }));

  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("files", "readwrite");
    const store = tx.objectStore("files");
    for (const path of deletes) {
      const existing = originalsByPath.get(path);
      if (!existing) continue;
      if (existing.status === "new") store.delete(existing.key);
      else store.put({ ...existing, status: "deleted", committed: false, updatedAt: now });
    }
    for (const file of prepared) store.put(file);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Local file transaction aborted."));
  });
}

export async function deleteLocalFile(repoIdValue: string, path: string): Promise<void> {
  const existing = await txStore<LocalRepositoryFile | undefined>("files", "readonly", (store) => store.get(fileKey(repoIdValue, path)));
  if (!existing) return;
  if (existing.status === "new") {
    await txStore("files", "readwrite", (store) => store.delete(fileKey(repoIdValue, path)));
    return;
  }
  await txStore("files", "readwrite", (store) => store.put({ ...existing, status: "deleted", committed: false, updatedAt: new Date().toISOString() }));
}

export async function removeLocalFileEntry(repoIdValue: string, path: string): Promise<void> {
  await txStore("files", "readwrite", (store) => store.delete(fileKey(repoIdValue, path)));
}

export async function localStatus(repoIdValue: string): Promise<LocalRepoStatus> {
  const files = await allFromIndex<LocalRepositoryFile>("files", "repoId", repoIdValue);
  const out: LocalRepoStatus = { clean: 0, modified: 0, new: 0, deleted: 0, dirty: 0, ahead: 0 };
  for (const file of files) {
    if (file.status === "clean" || !file.committed) out[file.status] += 1;
  }
  out.dirty = out.modified + out.new + out.deleted;
  out.ahead = (await listUnpushedLocalCommits(repoIdValue)).length;
  return out;
}

export async function addLocalRepoLog(repoIdValue: string, kind: LocalRepoLogKind, message: string): Promise<void> {
  const entry: LocalRepoLogEntry = { id: crypto.randomUUID(), repoId: repoIdValue, kind, message, createdAt: new Date().toISOString() };
  await txStore("logs", "readwrite", (store) => store.put(entry));
}

export async function listLocalRepoLogs(repoIdValue: string, limit = 30): Promise<LocalRepoLogEntry[]> {
  const entries = await allFromIndex<LocalRepoLogEntry>("logs", "repoId", repoIdValue);
  return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

export async function createLocalCommit(repoIdValue: string, message: string): Promise<LocalCommit> {
  const dirty = await listDirtyLocalFiles(repoIdValue);
  if (!dirty.length) throw new Error("No local changes to commit.");
  const commit: LocalCommit = {
    id: crypto.randomUUID(),
    repoId: repoIdValue,
    message,
    createdAt: new Date().toISOString(),
    files: dirty.map((file) => ({ path: file.path, status: file.status as Exclude<LocalFileStatus, "clean">, kind: file.kind, hash: file.currentHash })),
    pushed: false,
  };
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["files", "commits"], "readwrite");
    const filesStore = tx.objectStore("files");
    const commitsStore = tx.objectStore("commits");
    commitsStore.put(commit);
    for (const file of dirty) {
      const next = file.status === "deleted"
        ? { ...file, committed: true, updatedAt: new Date().toISOString() }
        : { ...file, status: "clean" as const, committed: true, updatedAt: new Date().toISOString() };
      filesStore.put(next);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return commit;
}

export async function listUnpushedLocalCommits(repoIdValue: string): Promise<LocalCommit[]> {
  return (await allFromIndex<LocalCommit>("commits", "repoId", repoIdValue))
    .filter((commit) => !commit.pushed)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function discardUnpushedLocalCommits(repoIdValue: string): Promise<void> {
  const commits = await listUnpushedLocalCommits(repoIdValue);
  if (!commits.length) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("commits", "readwrite");
    const store = tx.objectStore("commits");
    for (const commit of commits) store.delete(commit.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function restoreUnpushedCommitsAsDirty(repoIdValue: string): Promise<LocalCommit[]> {
  const commits = await listUnpushedLocalCommits(repoIdValue);
  if (!commits.length) return [];
  const byPath = new Map<string, LocalCommitFile>();
  for (const commit of commits) for (const file of commit.files) byPath.set(file.path, file);
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["files", "commits"], "readwrite");
    const filesStore = tx.objectStore("files");
    const commitsStore = tx.objectStore("commits");
    for (const file of byPath.values()) {
      const req = filesStore.get(fileKey(repoIdValue, file.path));
      req.onsuccess = () => {
        const row = req.result as LocalRepositoryFile | undefined;
        if (row) filesStore.put({ ...row, status: file.status, committed: false });
      };
    }
    for (const commit of commits) commitsStore.delete(commit.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return commits;
}

export async function markLocalCommitsPushed(repoIdValue: string, commitIds: string[], remoteHeadSha: string, pushedShas: Record<string, string | null>): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["repositories", "files", "commits"], "readwrite");
    const repoStore = tx.objectStore("repositories");
    const fileStore = tx.objectStore("files");
    const commitStore = tx.objectStore("commits");
    const repoReq = repoStore.get(repoIdValue);
    repoReq.onsuccess = () => {
      const repo = repoReq.result as LocalRepositoryMeta | undefined;
      if (repo) repoStore.put({ ...repo, remoteHeadSha, remoteChanged: false, updatedAt: new Date().toISOString(), lastFetchAt: new Date().toISOString() });
    };
    for (const id of commitIds) {
      const req = commitStore.get(id);
      req.onsuccess = () => {
        const commit = req.result as LocalCommit | undefined;
        if (commit) commitStore.put({ ...commit, pushed: true, remoteCommitSha: remoteHeadSha });
      };
    }
    for (const [path, sha] of Object.entries(pushedShas)) {
      const req = fileStore.get(fileKey(repoIdValue, path));
      req.onsuccess = () => {
        const file = req.result as LocalRepositoryFile | undefined;
        if (!file) return;
        if (sha === null) fileStore.delete(file.key);
        else fileStore.put({ ...file, baseSha: sha, baseHash: file.currentHash, committed: false, status: "clean", updatedAt: new Date().toISOString() });
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function updateLocalRepositoryHead(repoIdValue: string, remoteHeadSha: string): Promise<void> {
  const repo = await txStore<LocalRepositoryMeta | undefined>("repositories", "readonly", (store) => store.get(repoIdValue));
  if (!repo) return;
  await txStore("repositories", "readwrite", (store) => store.put({ ...repo, remoteHeadSha, remoteChanged: false, updatedAt: new Date().toISOString(), lastFetchAt: new Date().toISOString() }));
}

export async function markLocalRepositoryCloneComplete(repoIdValue: string, expectedFileCount: number, remoteHeadSha?: string): Promise<void> {
  const repo = await txStore<LocalRepositoryMeta | undefined>("repositories", "readonly", (store) => store.get(repoIdValue));
  if (!repo) return;
  await txStore("repositories", "readwrite", (store) => store.put({
    ...repo,
    cloneComplete: true,
    expectedFileCount,
    ...(remoteHeadSha ? { remoteHeadSha } : {}),
    updatedAt: new Date().toISOString(),
  }));
}

export async function markLocalRepositoryRemoteCheck(repoIdValue: string, remoteHeadSha: string, changed: boolean): Promise<void> {
  const repo = await txStore<LocalRepositoryMeta | undefined>("repositories", "readonly", (store) => store.get(repoIdValue));
  if (!repo) return;
  await txStore("repositories", "readwrite", (store) => store.put({ ...repo, remoteChanged: changed, updatedAt: new Date().toISOString(), lastFetchAt: new Date().toISOString(), ...(changed ? {} : { remoteHeadSha }) }));
}

function splitFrontmatter(raw: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match) return {};
  const title = /^title:\s*(.+)$/m.exec(match[1])?.[1]?.trim().replace(/^["']|["']$/g, "");
  const name = /^name:\s*(.+)$/m.exec(match[1])?.[1]?.trim().replace(/^["']|["']$/g, "");
  const description = /^description:\s*(.+)$/m.exec(match[1])?.[1]?.trim().replace(/^["']|["']$/g, "");
  const language = /^language:\s*(.+)$/m.exec(match[1])?.[1]?.trim().replace(/^["']|["']$/g, "");
  const ghostwriter = /^ghostwriter:\s*(.+)$/m.exec(match[1])?.[1]?.trim().replace(/^["']|["']$/g, "");
  return { title, name, description, language, ghostwriter };
}

function markdownBody(raw: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  return (match ? match[1] : raw).trim();
}

function textByPath(files: LocalRepositoryFile[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of files) if (file.kind === "text" && file.text !== undefined) map.set(file.path, file.text);
  return map;
}

export async function buildLocalBookStructure(meta: LocalRepositoryMeta): Promise<BookStructure> {
  const files = await listLocalFiles(meta.id);
  const allPaths = files.map((file) => file.path);
  const textMap = textByPath(files);
  const imageExtensions = ["png", "jpg", "jpeg", "webp", "gif"];
  const firstExistingImage = (basePath: string): string | undefined =>
    imageExtensions.map((extension) => `${basePath}.${extension}`).find((candidate) => allPaths.includes(candidate));
  const titleName = (path: string, fallback: string) => {
    const fm = splitFrontmatter(textMap.get(path) ?? "");
    return (typeof fm.title === "string" && fm.title) || (typeof fm.name === "string" && fm.name) || fallback;
  };
  const bookFm = splitFrontmatter(textMap.get("book.md") ?? "");
  const auditFiles: BookFile[] = files
    .filter((file) => file.path.startsWith("audit/") && file.path.endsWith(".md"))
    .map((file) => ({
      path: file.path,
      sha: file.baseSha ?? file.currentHash,
      size: file.size,
      content: file.kind === "text" ? file.text : undefined,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const auditPathSet = new Set(auditFiles.map((file) => file.path));

  const canonPrefixes = ["characters", "locations", "factions", "items", "timelines", "secrets"] as const;
  const filesUnder = (prefix: typeof canonPrefixes[number]): BookFile[] => allPaths
    .filter((p) => p.startsWith(`${prefix}/`) && p.endsWith(".md"))
    .map((p) => {
      const slug = (p.split("/").pop() ?? "").replace(/\.md$/i, "");
      const assetBase = prefix === "timelines" ? `assets/timelines/events/${slug}/primary` : `assets/${prefix}/${slug}/primary`;
      const file = files.find((entry) => entry.path === p);
      return { path: p, sha: file?.baseSha ?? file?.currentHash ?? "", size: file?.size ?? 0, name: titleName(p, slugToTitle(slug)), imagePath: firstExistingImage(assetBase) };
    });

  const chapterFolders = [...new Set(allPaths.filter((p) => p.startsWith("chapters/")).map((p) => p.split("/").slice(0, 2).join("/")))].sort();
  const chapters: Chapter[] = chapterFolders.map((folder) => {
    const slug = folder.replace("chapters/", "");
    const folderPaths = allPaths.filter((p) => p.startsWith(`${folder}/`));
    const chapterFm = splitFrontmatter(textMap.get(`${folder}/chapter.md`) ?? "");
    const paragraphFiles = folderPaths.filter((p) => /\/\d{3}(?:-[^/]+)?\.md$/.test(p) && !p.includes("/drafts/")).sort();
    const paragraphs: Paragraph[] = paragraphFiles.map((p) => {
      const filename = p.split("/").pop() ?? "";
      const num = filename.match(/^(\d{3})(?:-[^/]+)?\.md$/)?.[1] ?? "";
      const paragraphSlug = filename.replace(/\.md$/i, "");
      const canonicalDraftPath = `drafts/${slug}/${filename}`;
      const legacyDraftPath = `${folder}/drafts/${filename}`;
      const scriptPath = `scripts/${slug}/${paragraphSlug}.md`;
      const evaluationPath = `evaluations/paragraphs/${slug}/${paragraphSlug}.md`;
      const auditPath = buildParagraphAuditPath(slug, paragraphSlug);
      const imagePromptPath = `assets/chapters/${slug}/paragraphs/${paragraphSlug}/primary.md`;
      return {
        number: num,
        title: titleName(p, slugToTitle(filename.replace(/\.md$/, ""))),
        path: p,
        draftPath: allPaths.includes(canonicalDraftPath) ? canonicalDraftPath : allPaths.includes(legacyDraftPath) ? legacyDraftPath : undefined,
        scriptPath: allPaths.includes(scriptPath) ? scriptPath : undefined,
        evaluationPath: allPaths.includes(evaluationPath) ? evaluationPath : undefined,
        auditPath: auditPathSet.has(auditPath) ? auditPath : undefined,
        imagePromptPath: allPaths.includes(imagePromptPath) ? imagePromptPath : undefined,
        imagePath: firstExistingImage(`assets/chapters/${slug}/paragraphs/${paragraphSlug}/primary`),
      };
    });
    const imagePromptPath = `assets/chapters/${slug}/primary.md`;
    return {
      slug,
      path: folder,
      title: titleName(`${folder}/chapter.md`, slugToTitle(slug)),
      ghostwriter: typeof chapterFm.ghostwriter === "string" && chapterFm.ghostwriter ? chapterFm.ghostwriter : undefined,
      paragraphs,
      writingStylePath: folderPaths.find((p) => p.endsWith("writing-style.md")),
      draftPath: allPaths.includes(`drafts/${slug}/chapter.md`)
        ? `drafts/${slug}/chapter.md`
        : folderPaths.find((p) => p.endsWith("draft.md")),
      auditPath: auditPathSet.has(buildChapterAuditPath(slug)) ? buildChapterAuditPath(slug) : undefined,
      imagePromptPath: allPaths.includes(imagePromptPath) ? imagePromptPath : undefined,
      imagePath: firstExistingImage(`assets/chapters/${slug}/primary`),
      hasResume: allPaths.includes(`resumes/chapters/${slug}.md`),
      hasEvaluation: allPaths.includes(`evaluations/chapters/${slug}.md`),
    };
  });

  return {
    title: (typeof bookFm.title === "string" && bookFm.title) || meta.repo,
    description: markdownBody(textMap.get("book.md") ?? "") || (typeof bookFm.description === "string" ? bookFm.description : ""),
    language: typeof bookFm.language === "string" && bookFm.language ? bookFm.language : undefined,
    ghostwriter: typeof bookFm.ghostwriter === "string" && bookFm.ghostwriter ? bookFm.ghostwriter : undefined,
    owner: meta.owner,
    repo: meta.repo,
    defaultBranch: meta.defaultBranch,
    loadedBranch: meta.branch,
    bookCoverPath: firstExistingImage("assets/book/cover"),
    bookCoverPromptPath: allPaths.includes("assets/book/cover.md") ? "assets/book/cover.md" : undefined,
    bookAuditPath: auditPathSet.has(buildBookAuditPath()) ? buildBookAuditPath() : undefined,
    chapters,
    characters: filesUnder("characters"),
    locations: filesUnder("locations"),
    factions: filesUnder("factions"),
    items: filesUnder("items"),
    timelines: filesUnder("timelines"),
    secrets: filesUnder("secrets"),
    globalWritingStylePath: allPaths.find((p) => p === "writing-style.md") ?? allPaths.find((p) => p === "guidelines/writing-style.md" || p === "guidelines/style.md"),
    globalPunctuationStylePath: allPaths.includes("punctuation-style.md") ? "punctuation-style.md" : undefined,
    voicesPath: allPaths.find((p) => p === "guidelines/voices.md"),
    plotPath: allPaths.includes("plot.md") ? "plot.md" : undefined,
    ghostwriters: allPaths
      .filter((p) => /^ghostwriters\/[^/]+\.md$/.test(p))
      .map((p) => {
        const slug = p.replace(/^ghostwriters\//, "").replace(/\.md$/i, "");
        return { slug, path: p, name: titleName(p, slugToTitle(slug)) };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
    readerPersonas: allPaths
      .filter((p) => /^personas\/[^/]+\.md$/.test(p))
      .map((p) => {
        const slug = p.replace(/^personas\//, "").replace(/\.md$/i, "");
        return { slug, path: p, name: titleName(p, slugToTitle(slug)) };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
    readerEvaluationFiles: files
      .filter((file) => /^evaluations\/readers\/.+\.md$/.test(file.path))
      .map((file) => ({ path: file.path, sha: file.baseSha ?? "", size: file.size, content: file.kind === "text" ? file.text : undefined })),
    auditFiles,
    researchFiles: allPaths
      .filter((p) => /^research\/[^/]+\.md$/.test(p))
      .map((p) => {
        const slug = p.replace(/^research\//, "").replace(/\.md$/i, "");
        return { path: p, sha: "", slug, title: titleName(p, slug) };
      })
      .sort((a, b) => b.slug.localeCompare(a.slug)),
    notesFiles: allPaths
      .filter((p) => /^notes\/[^/]+\.md$/.test(p))
      .map((p) => {
        const slug = p.replace(/^notes\//, "").replace(/\.md$/i, "");
        return { path: p, sha: "", slug, title: titleName(p, slugToTitle(slug)) };
      })
      .sort((a, b) => b.slug.localeCompare(a.slug)),
  };
}
