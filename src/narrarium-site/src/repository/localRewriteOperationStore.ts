import type { RewriteOperationManifest } from "@/narrarium/rewriteFromReaderFeedback";
import { assertRepositoryOperationScopeCurrent, RepositoryOwnershipChangedError, type RepositoryOperationScope } from "@/repository/repositoryOperationScope";

const DB_NAME = "narrarium-local-rewrite-operations";
const DB_VERSION = 2;
const STORE_NAME = "rewriteOperations";

export const LOCAL_REWRITE_OPERATIONS_CHANGED_EVENT = "narrarium:local-rewrite-operations-changed";

interface StoredRewriteOperation extends RewriteOperationManifest {
  accountIdentity?: string;
  repoId: string;
  repoKey: string;
  targetKey: string;
}

export interface LocalRewriteOperationQuery {
  repoId: string;
  bookId?: string;
  owner: string;
  repo: string;
  branch: string;
  scope?: RewriteOperationManifest["scope"];
  chapterSlug?: string;
  paragraphSlug?: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function repoKey(owner: string, repo: string, branch: string): string {
  return `${owner}/${repo}#${branch}`.toLowerCase();
}

function targetKey(scope: RewriteOperationManifest["scope"], chapterSlug: string, paragraphSlug?: string): string {
  return scope === "chapter"
    ? `chapter:${chapterSlug}`
    : `paragraph:${chapterSlug}:${paragraphSlug ?? ""}`;
}

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "operationId" });
        store.createIndex("repoKey", "repoKey", { unique: false });
        store.createIndex("bookId", "bookId", { unique: false });
        store.createIndex("repoTargetKey", ["repoKey", "targetKey"], { unique: false });
      }
    };
  });
  return dbPromise;
}

function notifyChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(LOCAL_REWRITE_OPERATIONS_CHANGED_EVENT));
}

function txStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const request = run(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.onerror = () => reject(tx.error);
  }));
}

function allFromIndex<T>(indexName: string, query: IDBValidKey | IDBKeyRange): Promise<T[]> {
  return openDb().then((db) => new Promise<T[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).index(indexName).getAll(query);
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  }));
}

function toStored(operation: RewriteOperationManifest, scope: RepositoryOperationScope): StoredRewriteOperation {
  return {
    ...structuredClone(operation),
    accountIdentity: scope.accountIdentity,
    repoKey: repoKey(operation.owner, operation.repo, operation.branch),
    targetKey: targetKey(operation.scope, operation.chapterSlug, operation.paragraphSlug),
  };
}

function fromStored(operation: StoredRewriteOperation): RewriteOperationManifest {
  const { repoKey: _repoKey, targetKey: _targetKey, accountIdentity: _accountIdentity, ...record } = operation;
  return structuredClone(record);
}

function sortLatest(left: RewriteOperationManifest, right: RewriteOperationManifest): number {
  const leftKey = left.updatedAt || left.createdAt;
  const rightKey = right.updatedAt || right.createdAt;
  return rightKey.localeCompare(leftKey) || right.createdAt.localeCompare(left.createdAt);
}

export async function saveLocalRewriteOperation(operation: RewriteOperationManifest, scope: RepositoryOperationScope): Promise<void> {
  assertRepositoryOperationScopeCurrent(scope);
  const existing = await txStore<StoredRewriteOperation | undefined>("readonly", (store) => store.get(operation.operationId));
  if (existing && (existing.accountIdentity !== scope.accountIdentity || existing.repoId !== operation.repoId)) throw new RepositoryOwnershipChangedError("The rewrite operation belongs to another scoped repository.");
  assertRepositoryOperationScopeCurrent(scope);
  await txStore("readwrite", (store) => {
    assertRepositoryOperationScopeCurrent(scope);
    return store.put(toStored(operation, scope));
  });
  notifyChanged();
}

export async function loadLocalRewriteOperation(operationId: string, repoId: string, scope: RepositoryOperationScope): Promise<RewriteOperationManifest | null> {
  assertRepositoryOperationScopeCurrent(scope);
  const record = await txStore<StoredRewriteOperation | undefined>("readonly", (store) => store.get(operationId));
  assertRepositoryOperationScopeCurrent(scope);
  return record?.accountIdentity === scope.accountIdentity && record.repoId === repoId ? fromStored(record) : null;
}

export async function listLocalRewriteOperations(query: LocalRewriteOperationQuery, scope: RepositoryOperationScope): Promise<RewriteOperationManifest[]> {
  assertRepositoryOperationScopeCurrent(scope);
  const records = await allFromIndex<StoredRewriteOperation>("repoKey", repoKey(query.owner, query.repo, query.branch));
  assertRepositoryOperationScopeCurrent(scope);
  return records
    .filter((operation) => operation.accountIdentity === scope.accountIdentity && operation.repoId === query.repoId)
    .map(fromStored)
    .filter((operation) => (query.bookId ? operation.bookId === query.bookId : true))
    .filter((operation) => (query.scope ? operation.scope === query.scope : true))
    .filter((operation) => (query.chapterSlug ? operation.chapterSlug === query.chapterSlug : true))
    .filter((operation) => (query.scope === "paragraph" && query.paragraphSlug !== undefined ? operation.paragraphSlug === query.paragraphSlug : true))
    .sort(sortLatest);
}

export async function loadLatestLocalRewriteOperation(query: LocalRewriteOperationQuery, scope: RepositoryOperationScope): Promise<RewriteOperationManifest | null> {
  return (await listLocalRewriteOperations(query, scope))[0] ?? null;
}

export function listLatestChapterRewriteOperations(query: Omit<LocalRewriteOperationQuery, "scope" | "paragraphSlug"> & { chapterSlug: string }, scope: RepositoryOperationScope): Promise<RewriteOperationManifest[]> {
  return listLocalRewriteOperations({ ...query, scope: "chapter" }, scope);
}

export function listLatestParagraphRewriteOperations(query: Omit<LocalRewriteOperationQuery, "scope"> & { chapterSlug: string; paragraphSlug: string }, scope: RepositoryOperationScope): Promise<RewriteOperationManifest[]> {
  return listLocalRewriteOperations({ ...query, scope: "paragraph" }, scope);
}

export function loadLatestChapterRewriteOperation(query: Omit<LocalRewriteOperationQuery, "scope" | "paragraphSlug"> & { chapterSlug: string }, scope: RepositoryOperationScope): Promise<RewriteOperationManifest | null> {
  return loadLatestLocalRewriteOperation({ ...query, scope: "chapter" }, scope);
}

export function loadLatestParagraphRewriteOperation(query: Omit<LocalRewriteOperationQuery, "scope"> & { chapterSlug: string; paragraphSlug: string }, scope: RepositoryOperationScope): Promise<RewriteOperationManifest | null> {
  return loadLatestLocalRewriteOperation({ ...query, scope: "paragraph" }, scope);
}

export async function deleteLocalRewriteOperation(operationId: string, repoId: string, scope: RepositoryOperationScope): Promise<void> {
  const existing = await loadLocalRewriteOperation(operationId, repoId, scope);
  if (!existing) throw new RepositoryOwnershipChangedError("The rewrite operation is unavailable for this scoped repository.");
  await txStore("readwrite", (store) => { assertRepositoryOperationScopeCurrent(scope); return store.delete(operationId); });
  notifyChanged();
}
