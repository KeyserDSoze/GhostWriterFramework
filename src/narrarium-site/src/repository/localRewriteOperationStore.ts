import type { RewriteOperationManifest } from "@/narrarium/rewriteFromReaderFeedback";
import { assertRepositoryOperationScopeCurrent, RepositoryOwnershipChangedError, type RepositoryOperationScope } from "@/repository/repositoryOperationScope";

const DB_NAME = "narrarium-local-rewrite-operations";
const DB_VERSION = 3;
const STORE_NAME = "rewriteOperationsV3";
const LEGACY_STORE_NAME = "rewriteOperations";

export const LOCAL_REWRITE_OPERATIONS_CHANGED_EVENT = "narrarium:local-rewrite-operations-changed";

interface StoredRewriteOperation extends RewriteOperationManifest {
  storageId: string;
  accountIdentity?: string;
  repoId: string;
  repoKey: string;
  targetKey: string;
  migrationCopyOf?: string;
  migrationJournalId?: string;
}

function storageId(repoId: string, operationId: string): string {
  return `${encodeURIComponent(repoId)}::${operationId}`;
}

async function assertNoRepositoryMigration(repoId: string): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("narrarium-local-repositories");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  if (!db.objectStoreNames.contains("migrationJournals")) { db.close(); return; }
  const pending = await new Promise<boolean>((resolve, reject) => {
    const tx = db.transaction("migrationJournals", "readonly");
    const request = tx.objectStore("migrationJournals").getAll();
    request.onsuccess = () => resolve((request.result as Array<{ oldRepoId: string; newRepoId: string }>).some((journal) => journal.oldRepoId === repoId || journal.newRepoId === repoId));
    request.onerror = () => reject(request.error);
  });
  db.close();
  if (pending) throw new RepositoryOwnershipChangedError("Local repository migration is incomplete and must resume before rewrite operations are available.");
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
        const store = db.createObjectStore(STORE_NAME, { keyPath: "storageId" });
        store.createIndex("repoKey", "repoKey", { unique: false });
        store.createIndex("bookId", "bookId", { unique: false });
        store.createIndex("repoTargetKey", ["repoKey", "targetKey"], { unique: false });
        store.createIndex("operationId", "operationId", { unique: false });
        if (db.objectStoreNames.contains(LEGACY_STORE_NAME)) {
          const cursorRequest = request.transaction!.objectStore(LEGACY_STORE_NAME).openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const record = cursor.value as Omit<StoredRewriteOperation, "storageId">;
            store.put({ ...record, storageId: storageId(record.repoId, record.operationId) });
            cursor.continue();
          };
        }
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
    storageId: storageId(operation.repoId, operation.operationId),
    accountIdentity: scope.accountIdentity,
    repoKey: repoKey(operation.owner, operation.repo, operation.branch),
    targetKey: targetKey(operation.scope, operation.chapterSlug, operation.paragraphSlug),
  };
}

function fromStored(operation: StoredRewriteOperation): RewriteOperationManifest {
  const { storageId: _storageId, repoKey: _repoKey, targetKey: _targetKey, accountIdentity: _accountIdentity, migrationCopyOf: _migrationCopyOf, migrationJournalId: _migrationJournalId, ...record } = operation;
  return structuredClone(record);
}

function sortLatest(left: RewriteOperationManifest, right: RewriteOperationManifest): number {
  const leftKey = left.updatedAt || left.createdAt;
  const rightKey = right.updatedAt || right.createdAt;
  return rightKey.localeCompare(leftKey) || right.createdAt.localeCompare(left.createdAt);
}

export async function saveLocalRewriteOperation(operation: RewriteOperationManifest, scope: RepositoryOperationScope): Promise<void> {
  await assertNoRepositoryMigration(operation.repoId);
  assertRepositoryOperationScopeCurrent(scope);
  const existing = await txStore<StoredRewriteOperation | undefined>("readonly", (store) => store.get(storageId(operation.repoId, operation.operationId)));
  if (existing && (existing.accountIdentity !== scope.accountIdentity || existing.repoId !== operation.repoId)) throw new RepositoryOwnershipChangedError("The rewrite operation belongs to another scoped repository.");
  assertRepositoryOperationScopeCurrent(scope);
  await txStore("readwrite", (store) => {
    assertRepositoryOperationScopeCurrent(scope);
    return store.put(toStored(operation, scope));
  });
  notifyChanged();
}

export async function loadLocalRewriteOperation(operationId: string, repoId: string, scope: RepositoryOperationScope): Promise<RewriteOperationManifest | null> {
  await assertNoRepositoryMigration(repoId);
  assertRepositoryOperationScopeCurrent(scope);
  const record = await txStore<StoredRewriteOperation | undefined>("readonly", (store) => store.get(storageId(repoId, operationId)));
  assertRepositoryOperationScopeCurrent(scope);
  return record?.accountIdentity === scope.accountIdentity && record.repoId === repoId ? fromStored(record) : null;
}

export async function listLocalRewriteOperations(query: LocalRewriteOperationQuery, scope: RepositoryOperationScope): Promise<RewriteOperationManifest[]> {
  await assertNoRepositoryMigration(query.repoId);
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
  await txStore("readwrite", (store) => { assertRepositoryOperationScopeCurrent(scope); return store.delete(storageId(repoId, operationId)); });
  notifyChanged();
}

export async function prepareLegacyRewriteOperationMigration(input: { journalId: string; oldRepoId: string; newRepoId: string; legacyAccountIdentity: string; immutableAccountIdentity: string }): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => {
      const records = request.result as StoredRewriteOperation[];
      const target = records.filter((record) => record.repoId === input.newRepoId && !record.migrationJournalId);
      if (target.length) { tx.abort(); return; }
      for (const record of records) {
        if (record.repoId !== input.oldRepoId || (record.accountIdentity !== undefined && record.accountIdentity !== input.legacyAccountIdentity)) continue;
        const copyStorageId = `${storageId(input.newRepoId, record.operationId)}::migration::${input.journalId}`;
        store.put({ ...structuredClone(record), storageId: copyStorageId, repoId: input.newRepoId, accountIdentity: input.immutableAccountIdentity, migrationCopyOf: record.operationId, migrationJournalId: input.journalId });
      }
    };
    request.onerror = () => tx.abort();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Rewrite migration preparation was aborted."));
  });
}

export async function inspectLegacyRewriteOperationMigration(input: { oldRepoId: string; newRepoId: string; legacyAccountIdentity: string; immutableAccountIdentity: string }): Promise<{ legacyCount: number; targetCount: number; collisions: string[] }> {
  const records = await txStore<StoredRewriteOperation[]>("readonly", (store) => store.getAll());
  const legacy = records.filter((record) => record.repoId === input.oldRepoId && (record.accountIdentity === undefined || record.accountIdentity === input.legacyAccountIdentity) && !record.migrationJournalId);
  const target = records.filter((record) => record.repoId === input.newRepoId && record.accountIdentity === input.immutableAccountIdentity && !record.migrationJournalId);
  const targetIds = new Set(target.map((record) => record.operationId));
  return { legacyCount: legacy.length, targetCount: target.length, collisions: legacy.map((record) => record.operationId).filter((id) => targetIds.has(id)) };
}

export async function finalizeLegacyRewriteOperationMigration(input: { journalId: string; oldRepoId: string; newRepoId: string; immutableAccountIdentity: string }): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => {
      const records = request.result as StoredRewriteOperation[];
      const copies = records.filter((record) => record.migrationJournalId === input.journalId);
      const copyIds = new Set(copies.map((copy) => copy.migrationCopyOf));
      const collision = records.some((record) => record.repoId === input.newRepoId && !record.migrationJournalId && copyIds.has(record.operationId));
      if (collision) { tx.abort(); return; }
      for (const record of records) if (record.repoId === input.oldRepoId && record.migrationJournalId !== input.journalId) store.delete(record.storageId);
      for (const copy of copies) {
        const originalId = copy.migrationCopyOf!;
        store.put({ ...copy, storageId: storageId(input.newRepoId, originalId), operationId: originalId, repoId: input.newRepoId, accountIdentity: input.immutableAccountIdentity, migrationCopyOf: undefined, migrationJournalId: undefined });
        store.delete(copy.storageId);
      }
    };
    request.onerror = () => tx.abort();
    tx.oncomplete = () => { notifyChanged(); resolve(); };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Rewrite migration finalization was aborted."));
  });
}
