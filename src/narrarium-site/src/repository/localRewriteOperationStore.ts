import type { RewriteOperationManifest } from "@/narrarium/rewriteFromReaderFeedback";
import { assertRepositoryOperationScopeCurrent, RepositoryOwnershipChangedError, type RepositoryOperationScope } from "@/repository/repositoryOperationScope";

const DB_NAME = "narrarium-local-rewrite-operations";
const DB_VERSION = 7;
const STORE_NAME = "rewriteOperationsV3";
const LEGACY_STORE_NAME = "rewriteOperations";
const TOMBSTONE_STORE_NAME = "maintenanceTombstones";
const COMPLETION_STORE_NAME = "maintenanceCompletions";
const MIGRATION_COMPLETION_STORE_NAME = "migrationCompletions";

export const LOCAL_REWRITE_OPERATIONS_CHANGED_EVENT = "narrarium:local-rewrite-operations-changed";

type StoredRewriteOperation = Omit<RewriteOperationManifest, "localInstanceId"> & {
  storageId: string;
  localInstanceId?: string;
  accountIdentity?: string;
  repoId: string;
  repoKey: string;
  targetKey: string;
  migrationCopyOf?: string;
  migrationJournalId?: string;
  legacyUnresolved?: boolean;
  quarantineReason?: RewriteOperationQuarantineReason;
};

export type RewriteOperationQuarantineReason = "missingRepository" | "accountMismatch" | "legacyRepository" | "ambiguousRepository";

export type RewriteOperationMaintenanceRecord = RewriteOperationManifest & {
  legacyUnresolved?: boolean;
  quarantineReason?: RewriteOperationQuarantineReason;
};

export class RewriteOperationRecoveryRequiredError extends Error {
  readonly code = "LOCAL_REWRITE_RECOVERY_REQUIRED";

  constructor(readonly reason: RewriteOperationQuarantineReason = "legacyRepository") {
    super("This local rewrite operation needs recovery before it can be used.");
    this.name = "RewriteOperationRecoveryRequiredError";
  }
}

interface RewriteMaintenanceTombstone {
  repoId: string;
  localInstanceId: string;
  journalId: string;
  accountIdentity: string;
  createdAt: string;
  generation: number;
}

interface RewriteMaintenanceCompletion {
  markerId: string;
  journalId: string;
  repoId: string;
  localInstanceId: string;
  accountIdentity: string;
  preDeleteDigest: string;
  deletedRecords: Array<{ operationId: string; hash: string }>;
  deletedCount: number;
  tombstoneGeneration: number;
  completedAt: string;
}

export interface RewriteMaintenanceCompletionEvidence {
  journalId: string;
  repoId: string;
  localInstanceId: string;
  accountIdentity: string;
  preDeleteDigest: string;
  deletedRecords: Array<{ operationId: string; hash: string }>;
  deletedCount: number;
  tombstoneGeneration: number;
  completedAt: string;
}

interface RewriteMigrationCompletion {
  markerId: string;
  journalId: string;
  oldRepoId: string;
  newRepoId: string;
  immutableAccountIdentity: string;
  finalizedRecords: Array<{ operationId: string; hash: string }>;
  completedAt: string;
}

export interface ExpectedRewriteMaintenanceRecord {
  operationId: string;
  hash: string;
  snapshot: string;
}

export interface RewriteMaintenanceTombstoneIdentity {
  repoId: string;
  localInstanceId: string;
  journalId: string;
  accountIdentity: string;
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
    const names = ["migrationJournals", "removalJournals"].filter((name) => db.objectStoreNames.contains(name));
    const tx = db.transaction(names, "readonly");
    const migrationRequest = tx.objectStore("migrationJournals").getAll();
    const removalRequest = names.includes("removalJournals") ? tx.objectStore("removalJournals").get(repoId) : null;
    let migrations: Array<{ oldRepoId: string; newRepoId: string }> | undefined;
    let removal = false;
    const finish = () => { if (migrations && (!removalRequest || removalRequest.readyState === "done")) resolve(removal || migrations.some((journal) => journal.oldRepoId === repoId || journal.newRepoId === repoId)); };
    migrationRequest.onsuccess = () => { migrations = migrationRequest.result as Array<{ oldRepoId: string; newRepoId: string }>; finish(); };
    if (removalRequest) removalRequest.onsuccess = () => { removal = Boolean(removalRequest.result); finish(); };
    migrationRequest.onerror = () => reject(migrationRequest.error);
    if (removalRequest) removalRequest.onerror = () => reject(removalRequest.error);
  });
  db.close();
  if (pending) throw new RepositoryOwnershipChangedError("Local repository migration or removal is incomplete and must resume before rewrite operations are available.");
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
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onblocked = () => reject(new Error("Local rewrite operation database upgrade is blocked by another tab. Close or reload other Narrarium tabs and retry."));
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
      if (!db.objectStoreNames.contains(TOMBSTONE_STORE_NAME)) db.createObjectStore(TOMBSTONE_STORE_NAME, { keyPath: "repoId" });
      if (!db.objectStoreNames.contains(COMPLETION_STORE_NAME)) db.createObjectStore(COMPLETION_STORE_NAME, { keyPath: "markerId" });
      if (!db.objectStoreNames.contains(MIGRATION_COMPLETION_STORE_NAME)) db.createObjectStore(MIGRATION_COMPLETION_STORE_NAME, { keyPath: "markerId" });
    };
  }).then(async (db) => {
    try {
      await reconcileLegacyRewriteOperations(db);
      db.onversionchange = () => { db.close(); dbPromise = null; };
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }).catch((error) => {
    dbPromise = null;
    throw error;
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

function fromStored(operation: StoredRewriteOperation, includeQuarantine = false): RewriteOperationManifest {
  const { storageId: _storageId, repoKey: _repoKey, targetKey: _targetKey, accountIdentity: _accountIdentity, migrationCopyOf: _migrationCopyOf, migrationJournalId: _migrationJournalId, ...record } = operation;
  if (!includeQuarantine) {
    delete (record as Partial<StoredRewriteOperation>).legacyUnresolved;
    delete (record as Partial<StoredRewriteOperation>).quarantineReason;
  }
  return structuredClone(record) as RewriteOperationManifest;
}

interface PrimaryRepositoryIdentity {
  id: string;
  bookId?: string;
  owner: string;
  repo: string;
  branch: string;
  accountScope?: string;
  localInstanceId?: string;
}

function isLegacyRepoId(repoId: string): boolean {
  return !repoId.includes("::");
}

async function readPrimaryRepositories(repoIds: string[]): Promise<Map<string, PrimaryRepositoryIdentity | null>> {
  const primary = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("narrarium-local-repositories");
    request.onblocked = () => reject(new Error("The local repository database is unavailable while rewrite recovery is being prepared. Retry after other Narrarium tabs finish their work."));
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  try {
    if (!primary.objectStoreNames.contains("repositories")) throw new Error("The local repository database is unavailable while rewrite recovery is being prepared. Retry after the primary repository has been initialized.");
    const lookups = new Map<string, Promise<PrimaryRepositoryIdentity | null>>();
    const db = primary;
    for (const repoId of repoIds) {
      lookups.set(repoId, new Promise<PrimaryRepositoryIdentity | null>((resolve, reject) => {
        const tx = db.transaction("repositories", "readonly");
        const request = tx.objectStore("repositories").get(repoId);
        request.onsuccess = () => resolve(request.result as PrimaryRepositoryIdentity | undefined ?? null);
        request.onerror = () => reject(request.error);
        tx.onerror = () => reject(tx.error);
      }));
    }
    return new Map(await Promise.all([...lookups.entries()].map(async ([repoId, request]) => [repoId, await request] as const)));
  } finally {
    primary.close();
  }
}

async function reconcileLegacyRewriteOperations(db: IDBDatabase): Promise<void> {
  const records = await new Promise<StoredRewriteOperation[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result as StoredRewriteOperation[]);
    request.onerror = () => reject(request.error);
    tx.onerror = () => reject(tx.error);
  });
  const pending = records.filter((record) => !record.legacyUnresolved && (!record.localInstanceId || isLegacyRepoId(record.repoId)));
  if (!pending.length) return;
  const primaryByRepoId = await readPrimaryRepositories([...new Set(pending.map((record) => record.repoId))]);
  const updates = pending.map((record) => {
    const repository = primaryByRepoId.get(record.repoId);
    let update: Partial<StoredRewriteOperation>;
    if (isLegacyRepoId(record.repoId)) {
      update = { legacyUnresolved: true, quarantineReason: "legacyRepository" };
    } else if (!repository) {
      update = { legacyUnresolved: true, quarantineReason: "missingRepository" };
    } else if (!record.accountIdentity || repository.accountScope !== record.accountIdentity) {
      update = { legacyUnresolved: true, quarantineReason: "accountMismatch" };
    } else if (repository.id !== record.repoId || !repository.localInstanceId) {
      update = { legacyUnresolved: true, quarantineReason: "legacyRepository" };
    } else if (repository.bookId !== record.bookId || repository.owner !== record.owner || repository.repo !== record.repo || repository.branch !== record.branch) {
      update = { legacyUnresolved: true, quarantineReason: "ambiguousRepository" };
    } else {
      update = { localInstanceId: repository.localInstanceId };
    }
    return { record, update };
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    for (const { record, update } of updates) {
      const request = store.get(record.storageId);
      request.onsuccess = () => {
        const current = request.result as StoredRewriteOperation | undefined;
        if (current && !current.localInstanceId && !current.legacyUnresolved) store.put({ ...current, ...update });
      };
      request.onerror = () => tx.abort();
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Rewrite operation recovery migration was aborted."));
  });
}

function sortLatest(left: RewriteOperationManifest, right: RewriteOperationManifest): number {
  const leftKey = left.updatedAt || left.createdAt;
  const rightKey = right.updatedAt || right.createdAt;
  return rightKey.localeCompare(leftKey) || right.createdAt.localeCompare(left.createdAt);
}

let rewriteWritePause: { entered: () => void; wait: Promise<void> } | null = null;
export function pauseNextRewriteWriteForTests(): { entered: Promise<void>; release: () => void } {
  let entered!: () => void; let release!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  rewriteWritePause = { entered, wait };
  return { entered: enteredPromise, release };
}

export async function saveLocalRewriteOperation(operation: RewriteOperationManifest, scope: RepositoryOperationScope): Promise<void> {
  await assertNoRepositoryMigration(operation.repoId);
  assertRepositoryOperationScopeCurrent(scope);
  const repository = await currentRepository(operation.repoId);
  if (!repository || repository.accountScope !== scope.accountIdentity) throw new RepositoryOwnershipChangedError("The rewrite operation belongs to another scoped repository.");
  if (!operation.localInstanceId || repository.localInstanceId !== operation.localInstanceId) throw new RepositoryOwnershipChangedError("The rewrite operation belongs to a stale local repository incarnation.");
  const pause = rewriteWritePause;
  if (pause) { rewriteWritePause = null; pause.entered(); await pause.wait; }
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_NAME, TOMBSTONE_STORE_NAME, COMPLETION_STORE_NAME], "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const existingRequest = store.get(storageId(operation.repoId, operation.operationId));
    const tombstoneRequest = tx.objectStore(TOMBSTONE_STORE_NAME).get(operation.repoId);
    const completionRequest = tx.objectStore(COMPLETION_STORE_NAME).getAll();
    let existing: StoredRewriteOperation | undefined;
    let tombstone: RewriteMaintenanceTombstone | undefined;
    let completedIncarnation = false;
    let loaded = 0;
    let validationError: Error | null = null;
    const save = () => {
      if (++loaded !== 3) return;
      try { assertRepositoryOperationScopeCurrent(scope); }
      catch (error) { validationError = error as Error; tx.abort(); return; }
      if (completedIncarnation || (tombstone && tombstone.localInstanceId === operation.localInstanceId) || (existing && (existing.accountIdentity !== scope.accountIdentity || existing.repoId !== operation.repoId || existing.localInstanceId !== operation.localInstanceId))) {
        validationError = new RepositoryOwnershipChangedError("The rewrite operation is fenced by repository maintenance.");
        tx.abort();
        return;
      }
      store.put(toStored(operation, scope));
    };
    existingRequest.onsuccess = () => { existing = existingRequest.result as StoredRewriteOperation | undefined; save(); };
    tombstoneRequest.onsuccess = () => { tombstone = tombstoneRequest.result as RewriteMaintenanceTombstone | undefined; save(); };
    completionRequest.onsuccess = () => { completedIncarnation = (completionRequest.result as RewriteMaintenanceCompletion[]).some((marker) => marker.repoId === operation.repoId && marker.localInstanceId === operation.localInstanceId); save(); };
    existingRequest.onerror = tombstoneRequest.onerror = completionRequest.onerror = () => tx.abort();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(validationError ?? tx.error);
    tx.onabort = () => reject(validationError ?? tx.error ?? new RepositoryOwnershipChangedError());
  });
  notifyChanged();
}

async function currentRepository(repoId: string): Promise<PrimaryRepositoryIdentity | null> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("narrarium-local-repositories");
    request.onblocked = () => reject(new Error("The local repository database is unavailable while the rewrite operation is being checked. Retry after other Narrarium tabs finish their work."));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    if (!db.objectStoreNames.contains("repositories")) throw new Error("The local repository database is unavailable while the rewrite operation is being checked. Retry after the primary repository has been initialized.");
    return await new Promise<PrimaryRepositoryIdentity | null>((resolve, reject) => {
      const tx = db.transaction("repositories", "readonly");
      const request = tx.objectStore("repositories").get(repoId);
      request.onsuccess = () => resolve(request.result as PrimaryRepositoryIdentity | undefined ?? null);
      request.onerror = () => reject(request.error);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function findPrimaryRepositoryForMigration(repoId: string, owner: string, repo: string, branch: string): Promise<PrimaryRepositoryIdentity | null> {
  const exact = await currentRepository(repoId);
  if (exact) return exact;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("narrarium-local-repositories");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<PrimaryRepositoryIdentity | null>((resolve, reject) => {
      const tx = db.transaction("repositories", "readonly");
      const request = tx.objectStore("repositories").getAll();
      request.onsuccess = () => {
        const rows = request.result as PrimaryRepositoryIdentity[];
        const exact = rows.find((row) => row.id === repoId || row.id.endsWith(`::${repoId.split("::").pop()}`));
        if (exact) { resolve(exact); return; }
        const candidates = rows.filter((row) => row.owner === owner && row.repo === repo && row.branch === branch);
        resolve(candidates.length === 1 ? candidates[0] : null);
      };
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function assertOperationalRecord(record: StoredRewriteOperation, repoId: string, scope: RepositoryOperationScope): Promise<void> {
  if (record.repoId !== repoId || record.accountIdentity !== scope.accountIdentity) {
    throw new RepositoryOwnershipChangedError("The rewrite operation belongs to another scoped repository.");
  }
  if (record.legacyUnresolved || !record.localInstanceId) throw new RewriteOperationRecoveryRequiredError(record.quarantineReason);
  const primary = await currentRepository(repoId);
  if (!primary) throw new RewriteOperationRecoveryRequiredError("missingRepository");
  if (primary.accountScope !== scope.accountIdentity) throw new RewriteOperationRecoveryRequiredError("accountMismatch");
  if (primary.localInstanceId !== record.localInstanceId) throw new RepositoryOwnershipChangedError("The rewrite operation belongs to a stale local repository incarnation.");
}

export async function loadLocalRewriteOperation(operationId: string, repoId: string, scope: RepositoryOperationScope): Promise<RewriteOperationManifest | null> {
  await assertNoRepositoryMigration(repoId);
  assertRepositoryOperationScopeCurrent(scope);
  const record = await txStore<StoredRewriteOperation | undefined>("readonly", (store) => store.get(storageId(repoId, operationId)));
  assertRepositoryOperationScopeCurrent(scope);
  if (!record) return null;
  await assertOperationalRecord(record, repoId, scope);
  assertRepositoryOperationScopeCurrent(scope);
  return fromStored(record);
}

export async function listLocalRewriteOperations(query: LocalRewriteOperationQuery, scope: RepositoryOperationScope): Promise<RewriteOperationManifest[]> {
  await assertNoRepositoryMigration(query.repoId);
  assertRepositoryOperationScopeCurrent(scope);
  const records = await allFromIndex<StoredRewriteOperation>("repoKey", repoKey(query.owner, query.repo, query.branch));
  assertRepositoryOperationScopeCurrent(scope);
  const scopedRecords = records.filter((operation) => operation.accountIdentity === scope.accountIdentity && operation.repoId === query.repoId);
  for (const record of scopedRecords) await assertOperationalRecord(record, query.repoId, scope);
  return scopedRecords
    .map((operation) => fromStored(operation))
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
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_NAME, TOMBSTONE_STORE_NAME], "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const existingRequest = store.get(storageId(repoId, operationId));
    const tombstoneRequest = tx.objectStore(TOMBSTONE_STORE_NAME).get(repoId);
    let existing: StoredRewriteOperation | undefined; let tombstone: RewriteMaintenanceTombstone | undefined; let loaded = 0; let validationError: Error | null = null;
    const remove = () => { if (++loaded !== 2) return; try { assertRepositoryOperationScopeCurrent(scope); } catch (error) { validationError = error as Error; tx.abort(); return; } if ((tombstone && tombstone.localInstanceId === existing?.localInstanceId) || !existing || existing.accountIdentity !== scope.accountIdentity || existing.repoId !== repoId) { validationError = new RepositoryOwnershipChangedError("The rewrite operation is fenced or unavailable."); tx.abort(); return; } store.delete(existing.storageId); };
    existingRequest.onsuccess = () => { existing = existingRequest.result as StoredRewriteOperation | undefined; remove(); };
    tombstoneRequest.onsuccess = () => { tombstone = tombstoneRequest.result as RewriteMaintenanceTombstone | undefined; remove(); };
    existingRequest.onerror = tombstoneRequest.onerror = () => tx.abort(); tx.oncomplete = () => resolve(); tx.onerror = () => reject(validationError ?? tx.error); tx.onabort = () => reject(validationError ?? tx.error ?? new RepositoryOwnershipChangedError());
  });
  notifyChanged();
}

/** Maintenance-only inspection. Operational rewrite reads must keep using listLocalRewriteOperations. */
export async function countLocalRewriteOperationsForMaintenance(repoId: string, scope: RepositoryOperationScope): Promise<number> {
  assertRepositoryOperationScopeCurrent(scope);
  const records = await txStore<StoredRewriteOperation[]>("readonly", (store) => store.getAll());
  assertRepositoryOperationScopeCurrent(scope);
  return records.filter((record) => record.repoId === repoId && record.accountIdentity === scope.accountIdentity && !record.migrationJournalId).length;
}

export async function listLocalRewriteOperationsForMaintenance(repoId: string, scope: RepositoryOperationScope): Promise<RewriteOperationManifest[]> {
  assertRepositoryOperationScopeCurrent(scope);
  const records = await txStore<StoredRewriteOperation[]>("readonly", (store) => store.getAll());
  assertRepositoryOperationScopeCurrent(scope);
  return records.filter((record) => record.repoId === repoId && record.accountIdentity === scope.accountIdentity && !record.migrationJournalId).map((record) => fromStored(record, true)).sort(sortLatest);
}

export async function getRewriteMaintenanceTombstone(repoId: string, accountIdentity: string): Promise<RewriteMaintenanceTombstoneIdentity | null> {
  const db = await openDb();
  return new Promise<RewriteMaintenanceTombstoneIdentity | null>((resolve, reject) => {
    const tx = db.transaction(TOMBSTONE_STORE_NAME, "readonly");
    const request = tx.objectStore(TOMBSTONE_STORE_NAME).get(repoId);
    request.onsuccess = () => {
      const tombstone = request.result as RewriteMaintenanceTombstone | undefined;
      resolve(tombstone && tombstone.repoId === repoId && tombstone.accountIdentity === accountIdentity ? tombstone : null);
    };
    request.onerror = () => reject(request.error);
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearRewriteMaintenanceCompletion(input: { repoId: string; localInstanceId: string; journalId: string }): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(COMPLETION_STORE_NAME, "readwrite");
    tx.objectStore(COMPLETION_STORE_NAME).delete(completionMarkerId(input));
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  });
}

export async function clearRewriteMaintenanceTombstone(repoId: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(TOMBSTONE_STORE_NAME, "readwrite");
    tx.objectStore(TOMBSTONE_STORE_NAME).delete(repoId);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  });
}

export async function getRewriteMaintenanceCompletion(input: { repoId: string; localInstanceId: string; journalId: string }): Promise<RewriteMaintenanceCompletionEvidence | null> {
  const db = await openDb();
  return new Promise<RewriteMaintenanceCompletionEvidence | null>((resolve, reject) => {
    const tx = db.transaction(COMPLETION_STORE_NAME, "readonly");
    const request = tx.objectStore(COMPLETION_STORE_NAME).get(completionMarkerId(input));
    request.onsuccess = () => {
      const completion = request.result as RewriteMaintenanceCompletion | undefined;
      resolve(completion && completion.journalId === input.journalId && completion.repoId === input.repoId && completion.localInstanceId === input.localInstanceId ? completion : null);
    };
    request.onerror = () => reject(request.error);
  });
}

function completionMarkerId(input: { journalId: string; repoId: string; localInstanceId: string }): string {
  return `${input.journalId}::${input.repoId}::${input.localInstanceId}`;
}

function migrationCompletionMarkerId(input: { journalId: string; oldRepoId: string; newRepoId: string }): string {
  return `migration::${input.journalId}::${input.oldRepoId}::${input.newRepoId}`;
}

export async function fenceAndRemoveLocalRewriteOperationsForMaintenance(input: { repoId: string; localInstanceId: string; journalId: string; accountIdentity: string; expectedSnapshot: string; expectedDigest: string; expectedRecords: ExpectedRewriteMaintenanceRecord[] }, scope: RepositoryOperationScope): Promise<number> {
  assertRepositoryOperationScopeCurrent(scope);
  const db = await openDb();
  return new Promise<number>((resolve, reject) => {
    const tx = db.transaction([STORE_NAME, TOMBSTONE_STORE_NAME, COMPLETION_STORE_NAME], "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const tombstones = tx.objectStore(TOMBSTONE_STORE_NAME);
    const completions = tx.objectStore(COMPLETION_STORE_NAME);
    let removed = 0;
    let validationError: Error | null = null;
    const tombstoneRequest = tombstones.get(input.repoId);
    const completionRequest = completions.get(completionMarkerId(input));
    let tombstone: RewriteMaintenanceTombstone | undefined;
    let completion: RewriteMaintenanceCompletion | undefined;
    let loaded = 0;
    const apply = () => {
      if (++loaded !== 2) return;
      const existing = tombstone;
      const allRequest = store.getAll();
      allRequest.onsuccess = () => {
        const records = (allRequest.result as StoredRewriteOperation[]).filter((record) => record.repoId === input.repoId && record.accountIdentity === input.accountIdentity && !record.migrationJournalId);
        if (completion) {
          const exactMarker = completion.journalId === input.journalId && completion.repoId === input.repoId && completion.localInstanceId === input.localInstanceId
            && completion.accountIdentity === input.accountIdentity && completion.preDeleteDigest === input.expectedDigest
            && completion.deletedCount === input.expectedRecords.length && stableRewriteSnapshot(completion.deletedRecords) === stableRewriteSnapshot(input.expectedRecords.map(({ operationId, hash }) => ({ operationId, hash })));
          if (!exactMarker || records.length !== 0 || (existing && (existing.journalId !== input.journalId || existing.localInstanceId !== input.localInstanceId || existing.generation !== completion.tombstoneGeneration))) {
            validationError = new Error("REWRITE_MAINTENANCE_EVIDENCE_INVALID"); tx.abort(); return;
          }
          removed = completion.deletedCount;
          return;
        }
        if (existing && (existing.localInstanceId !== input.localInstanceId || existing.journalId !== input.journalId || existing.accountIdentity !== input.accountIdentity)) {
          validationError = new RepositoryOwnershipChangedError("A different repository incarnation owns the rewrite maintenance tombstone."); tx.abort(); return;
        }
        const manifests = records.map((record) => fromStored(record, true)).sort(sortLatest);
        const snapshot = stableRewriteSnapshot(manifests);
        const expectedById = new Map(input.expectedRecords.map((record) => [record.operationId, record]));
        const exactRecords = records.length === input.expectedRecords.length && records.every((record) => expectedById.get(record.operationId)?.snapshot === stableRewriteSnapshot(fromStored(record, true)));
        if (!exactRecords || snapshot !== input.expectedSnapshot) { validationError = new Error(existing ? "REWRITE_MAINTENANCE_EVIDENCE_INVALID" : "REWRITE_BACKUP_STALE"); tx.abort(); return; }
        const generation = (existing?.generation ?? 0) + 1;
        const completedAt = new Date().toISOString();
        const { expectedSnapshot: _snapshot, expectedDigest: _digest, expectedRecords: _records, ...tombstoneInput } = input;
        tombstones.put({ ...tombstoneInput, generation, createdAt: existing?.createdAt ?? completedAt });
        completions.add({ markerId: completionMarkerId(input), journalId: input.journalId, repoId: input.repoId, localInstanceId: input.localInstanceId, accountIdentity: input.accountIdentity, preDeleteDigest: input.expectedDigest, deletedRecords: input.expectedRecords.map(({ operationId, hash }) => ({ operationId, hash })), deletedCount: input.expectedRecords.length, tombstoneGeneration: generation, completedAt } satisfies RewriteMaintenanceCompletion);
        for (const record of records) { store.delete(record.storageId); removed += 1; }
      };
      allRequest.onerror = () => tx.abort();
    };
    tombstoneRequest.onsuccess = () => { tombstone = tombstoneRequest.result as RewriteMaintenanceTombstone | undefined; apply(); };
    completionRequest.onsuccess = () => { completion = completionRequest.result as RewriteMaintenanceCompletion | undefined; apply(); };
    tombstoneRequest.onerror = completionRequest.onerror = () => tx.abort();
    tx.oncomplete = () => { if (removed) notifyChanged(); resolve(removed); };
    tx.onerror = () => reject(validationError ?? tx.error);
    tx.onabort = () => reject(validationError ?? tx.error ?? new Error("Rewrite maintenance fencing was aborted."));
  });
}

function stableRewriteSnapshot(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableRewriteSnapshot).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableRewriteSnapshot(item)}`).join(",")}}`;
}

export async function finalizeLocalRewriteMaintenanceTombstone(_input: { repoId: string; localInstanceId: string; journalId: string; accountIdentity: string }, scope: RepositoryOperationScope): Promise<void> {
  assertRepositoryOperationScopeCurrent(scope);
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_NAME, TOMBSTONE_STORE_NAME, COMPLETION_STORE_NAME], "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const tombstones = tx.objectStore(TOMBSTONE_STORE_NAME);
    const completions = tx.objectStore(COMPLETION_STORE_NAME);
    const tombstoneRequest = tombstones.get(_input.repoId);
    const completionRequest = completions.get(completionMarkerId(_input));
    let tombstone: RewriteMaintenanceTombstone | undefined; let completion: RewriteMaintenanceCompletion | undefined; let loaded = 0; let validationError: Error | null = null;
    const recordsRequest = store.getAll();
    let records: StoredRewriteOperation[] = [];
    const finalize = () => {
      if (++loaded !== 3) return;
      const activeRecords = records.filter((record) => record.repoId === _input.repoId && !record.migrationJournalId);
       if (!completion || completion.journalId !== _input.journalId || completion.repoId !== _input.repoId || completion.localInstanceId !== _input.localInstanceId || completion.accountIdentity !== _input.accountIdentity || activeRecords.length !== 0) {
        validationError = new Error("REWRITE_MAINTENANCE_EVIDENCE_INVALID");
        tx.abort();
        return;
      }
      if (tombstone) {
        if (tombstone.localInstanceId !== _input.localInstanceId || tombstone.journalId !== _input.journalId || tombstone.generation !== completion.tombstoneGeneration) {
          validationError = new Error("REWRITE_MAINTENANCE_EVIDENCE_INVALID");
          tx.abort();
          return;
        }
        tombstones.delete(_input.repoId);
      }
    };
    tombstoneRequest.onsuccess = () => { tombstone = tombstoneRequest.result as RewriteMaintenanceTombstone | undefined; finalize(); };
    completionRequest.onsuccess = () => { completion = completionRequest.result as RewriteMaintenanceCompletion | undefined; finalize(); };
    recordsRequest.onsuccess = () => { records = recordsRequest.result as StoredRewriteOperation[]; finalize(); };
    tombstoneRequest.onerror = completionRequest.onerror = recordsRequest.onerror = () => tx.abort(); tx.oncomplete = () => resolve(); tx.onerror = () => reject(validationError ?? tx.error); tx.onabort = () => reject(validationError ?? tx.error ?? new Error("Rewrite maintenance finalization was aborted."));
  });
}

export async function prepareLegacyRewriteOperationMigration(input: { journalId: string; oldRepoId: string; newRepoId: string; legacyAccountIdentity: string; immutableAccountIdentity: string }): Promise<void> {
  const sourceRepository = await currentRepository(input.oldRepoId);
  const targetRepository = sourceRepository ?? await currentRepository(input.newRepoId);
  if (targetRepository && targetRepository.accountScope !== input.legacyAccountIdentity && targetRepository.accountScope !== input.immutableAccountIdentity) throw new RewriteOperationRecoveryRequiredError("accountMismatch");
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_NAME, TOMBSTONE_STORE_NAME, MIGRATION_COMPLETION_STORE_NAME], "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    const oldTombstone = tx.objectStore(TOMBSTONE_STORE_NAME).get(input.oldRepoId);
    const newTombstone = tx.objectStore(TOMBSTONE_STORE_NAME).get(input.newRepoId);
    const completionRequest = tx.objectStore(MIGRATION_COMPLETION_STORE_NAME).get(migrationCompletionMarkerId(input));
    let loaded = 0;
    const apply = () => {
      if (++loaded !== 4) return;
      if (oldTombstone.result || newTombstone.result) { tx.abort(); return; }
      const records = request.result as StoredRewriteOperation[];
      const completion = completionRequest.result as RewriteMigrationCompletion | undefined;
      if (completion) {
        const target = records.filter((record) => record.repoId === input.newRepoId);
        const copies = records.filter((record) => record.migrationJournalId === input.journalId);
        const exactCompletion = completion.journalId === input.journalId
          && completion.oldRepoId === input.oldRepoId
          && completion.newRepoId === input.newRepoId
          && completion.immutableAccountIdentity === input.immutableAccountIdentity
          && copies.length === 0
          && records.every((record) => record.repoId !== input.oldRepoId)
          && target.length === completion.finalizedRecords.length
          && target.every((record) => record.accountIdentity === input.immutableAccountIdentity && !record.migrationJournalId
            && completion.finalizedRecords.some((expected) => expected.operationId === record.operationId && expected.hash === stableRewriteSnapshot(record)));
        if (!exactCompletion) { tx.abort(); return; }
        return;
      }
      const target = records.filter((record) => record.repoId === input.newRepoId && !record.migrationJournalId);
      if (target.length) { tx.abort(); return; }
      for (const record of records) {
        if (record.repoId !== input.oldRepoId || (record.accountIdentity !== undefined && record.accountIdentity !== input.legacyAccountIdentity)) continue;
        const copyStorageId = `${storageId(input.newRepoId, record.operationId)}::migration::${input.journalId}`;
        store.put({ ...structuredClone(record), storageId: copyStorageId, repoId: input.newRepoId, localInstanceId: targetRepository?.localInstanceId, accountIdentity: input.immutableAccountIdentity, legacyUnresolved: undefined, quarantineReason: undefined, migrationCopyOf: record.operationId, migrationJournalId: input.journalId });
      }
    };
    request.onsuccess = oldTombstone.onsuccess = newTombstone.onsuccess = completionRequest.onsuccess = apply;
    request.onerror = oldTombstone.onerror = newTombstone.onerror = completionRequest.onerror = () => tx.abort();
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
  const targetRepository = await findPrimaryRepositoryForMigration(input.newRepoId, "", "", "");
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_NAME, TOMBSTONE_STORE_NAME, MIGRATION_COMPLETION_STORE_NAME], "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const migrationCompletions = tx.objectStore(MIGRATION_COMPLETION_STORE_NAME);
    const request = store.getAll();
    const oldTombstone = tx.objectStore(TOMBSTONE_STORE_NAME).get(input.oldRepoId);
    const newTombstone = tx.objectStore(TOMBSTONE_STORE_NAME).get(input.newRepoId);
    const completionRequest = migrationCompletions.get(migrationCompletionMarkerId(input));
    let loaded = 0;
    let validationError: Error | null = null;
    const apply = () => {
      if (++loaded !== 4) return;
      if (oldTombstone.result || newTombstone.result) { tx.abort(); return; }
      const records = request.result as StoredRewriteOperation[];
      const copies = records.filter((record) => record.migrationJournalId === input.journalId);
      const localInstanceId = targetRepository?.localInstanceId ?? copies.find((copy) => copy.localInstanceId)?.localInstanceId;
      if (copies.length && !localInstanceId) { validationError = new RewriteOperationRecoveryRequiredError("legacyRepository"); tx.abort(); return; }
      const completion = completionRequest.result as RewriteMigrationCompletion | undefined;
      const targetRecords = records.filter((record) => record.repoId === input.newRepoId && !record.migrationJournalId && record.accountIdentity === input.immutableAccountIdentity);
      if (completion) {
        const exactCompletion = completion.journalId === input.journalId && completion.oldRepoId === input.oldRepoId && completion.newRepoId === input.newRepoId && completion.immutableAccountIdentity === input.immutableAccountIdentity
          && copies.length === 0
          && targetRecords.length === completion.finalizedRecords.length
          && targetRecords.every((record) => completion.finalizedRecords.some((expected) => expected.operationId === record.operationId && expected.hash === stableRewriteSnapshot(record)));
        const unexpected = records.some((record) => record.repoId === input.oldRepoId || (record.repoId === input.newRepoId && (record.migrationJournalId !== undefined || record.accountIdentity !== input.immutableAccountIdentity)));
        if (!exactCompletion || unexpected) { validationError = new RewriteOperationRecoveryRequiredError("ambiguousRepository"); tx.abort(); return; }
        return;
      }
      const copyIds = new Set(copies.map((copy) => copy.migrationCopyOf));
      const collision = records.some((record) => record.repoId === input.newRepoId && !record.migrationJournalId && copyIds.has(record.operationId));
      if (collision) { validationError = new RepositoryOwnershipChangedError("Rewrite migration operation collision."); tx.abort(); return; }
      const finalizedRecords: RewriteMigrationCompletion["finalizedRecords"] = [];
      for (const record of records) if (record.repoId === input.oldRepoId && record.migrationJournalId !== input.journalId) store.delete(record.storageId);
      for (const copy of copies) {
        const originalId = copy.migrationCopyOf!;
        const finalized = { ...copy, storageId: storageId(input.newRepoId, originalId), operationId: originalId, repoId: input.newRepoId, localInstanceId: localInstanceId!, accountIdentity: input.immutableAccountIdentity, legacyUnresolved: undefined, quarantineReason: undefined, migrationCopyOf: undefined, migrationJournalId: undefined };
        finalizedRecords.push({ operationId: originalId, hash: stableRewriteSnapshot(finalized) });
        store.put(finalized);
        store.delete(copy.storageId);
      }
      migrationCompletions.add({ markerId: migrationCompletionMarkerId(input), journalId: input.journalId, oldRepoId: input.oldRepoId, newRepoId: input.newRepoId, immutableAccountIdentity: input.immutableAccountIdentity, finalizedRecords, completedAt: new Date().toISOString() } satisfies RewriteMigrationCompletion);
    };
    request.onsuccess = oldTombstone.onsuccess = newTombstone.onsuccess = completionRequest.onsuccess = apply;
    request.onerror = oldTombstone.onerror = newTombstone.onerror = completionRequest.onerror = () => tx.abort();
    tx.oncomplete = () => { notifyChanged(); resolve(); };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(validationError ?? tx.error ?? new Error("Rewrite migration finalization was aborted."));
  });
}
