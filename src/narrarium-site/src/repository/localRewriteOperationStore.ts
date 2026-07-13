import type { RewriteOperationManifest } from "@/narrarium/rewriteFromReaderFeedback";

const DB_NAME = "narrarium-local-rewrite-operations";
const DB_VERSION = 1;
const STORE_NAME = "rewriteOperations";

export const LOCAL_REWRITE_OPERATIONS_CHANGED_EVENT = "narrarium:local-rewrite-operations-changed";

interface StoredRewriteOperation extends RewriteOperationManifest {
  repoKey: string;
  targetKey: string;
}

export interface LocalRewriteOperationQuery {
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

function toStored(operation: RewriteOperationManifest): StoredRewriteOperation {
  return {
    ...structuredClone(operation),
    repoKey: repoKey(operation.owner, operation.repo, operation.branch),
    targetKey: targetKey(operation.scope, operation.chapterSlug, operation.paragraphSlug),
  };
}

function fromStored(operation: StoredRewriteOperation): RewriteOperationManifest {
  const { repoKey: _repoKey, targetKey: _targetKey, ...record } = operation;
  return structuredClone(record);
}

function sortLatest(left: RewriteOperationManifest, right: RewriteOperationManifest): number {
  const leftKey = left.updatedAt || left.createdAt;
  const rightKey = right.updatedAt || right.createdAt;
  return rightKey.localeCompare(leftKey) || right.createdAt.localeCompare(left.createdAt);
}

export async function saveLocalRewriteOperation(operation: RewriteOperationManifest): Promise<void> {
  await txStore("readwrite", (store) => store.put(toStored(operation)));
  notifyChanged();
}

export async function loadLocalRewriteOperation(operationId: string): Promise<RewriteOperationManifest | null> {
  const record = await txStore<StoredRewriteOperation | undefined>("readonly", (store) => store.get(operationId));
  return record ? fromStored(record) : null;
}

export async function listLocalRewriteOperations(query: LocalRewriteOperationQuery): Promise<RewriteOperationManifest[]> {
  const records = await allFromIndex<StoredRewriteOperation>("repoKey", repoKey(query.owner, query.repo, query.branch));
  return records
    .map(fromStored)
    .filter((operation) => (query.bookId ? operation.bookId === query.bookId : true))
    .filter((operation) => (query.scope ? operation.scope === query.scope : true))
    .filter((operation) => (query.chapterSlug ? operation.chapterSlug === query.chapterSlug : true))
    .filter((operation) => (query.scope === "paragraph" && query.paragraphSlug !== undefined ? operation.paragraphSlug === query.paragraphSlug : true))
    .sort(sortLatest);
}

export async function loadLatestLocalRewriteOperation(query: LocalRewriteOperationQuery): Promise<RewriteOperationManifest | null> {
  return (await listLocalRewriteOperations(query))[0] ?? null;
}

export function listLatestChapterRewriteOperations(query: Omit<LocalRewriteOperationQuery, "scope" | "paragraphSlug"> & { chapterSlug: string }): Promise<RewriteOperationManifest[]> {
  return listLocalRewriteOperations({ ...query, scope: "chapter" });
}

export function listLatestParagraphRewriteOperations(query: Omit<LocalRewriteOperationQuery, "scope"> & { chapterSlug: string; paragraphSlug: string }): Promise<RewriteOperationManifest[]> {
  return listLocalRewriteOperations({ ...query, scope: "paragraph" });
}

export function loadLatestChapterRewriteOperation(query: Omit<LocalRewriteOperationQuery, "scope" | "paragraphSlug"> & { chapterSlug: string }): Promise<RewriteOperationManifest | null> {
  return loadLatestLocalRewriteOperation({ ...query, scope: "chapter" });
}

export function loadLatestParagraphRewriteOperation(query: Omit<LocalRewriteOperationQuery, "scope"> & { chapterSlug: string; paragraphSlug: string }): Promise<RewriteOperationManifest | null> {
  return loadLatestLocalRewriteOperation({ ...query, scope: "paragraph" });
}
