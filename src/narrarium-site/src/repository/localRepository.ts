import type { BookStructure, BookFile, Chapter, Paragraph } from "@/types/book";
import {
  buildBookAuditPath,
  buildChapterAuditPath,
  buildParagraphAuditPath,
} from "@/narrarium/auditPaths";
import { isRewriteOperationManifestPath } from "@/narrarium/rewriteOperationPaths";
import {
  resolveParagraphArtifactPaths,
  type ParagraphArtifactMetadata,
  type ParagraphArtifactTarget,
} from "@/narrarium/paragraphArtifacts";
import { accountIdentity, beginStrandedLegacyRecovery, consumeLegacyAccountUpgradeEvidence, getLegacyAccountUpgradeEvidence, legacyEmailAccountIdentity } from "@/auth/accountIdentity";
import { consumeLegacyAdoptionConsent, type LegacyAdoptionTarget } from "@/auth/legacyAdoptionConsent";
import { finalizeLegacyRewriteOperationMigration, inspectLegacyRewriteOperationMigration, prepareLegacyRewriteOperationMigration } from "@/repository/localRewriteOperationStore";
import { classifyRepositoryError, type RepositoryErrorKind } from "@/repository/repositoryError";
import { RepositoryByteMeter, assertRepositoryFileBytes, utf8Bytes } from "@/repository/repositoryLimits";
import { useAuthStore } from "@/store/authStore";
import { assertRepositoryOperationScopeCurrent, captureRepositoryOperationScope, RepositoryOwnershipChangedError, type RepositoryOperationScope } from "@/repository/repositoryOperationScope";

const DB_NAME = "narrarium-local-repositories";
const DB_VERSION = 13;

export type LocalFileStatus = "clean" | "modified" | "new" | "deleted";
export type LocalFileKind = "text" | "binary";
export type LocalCloneStatus = "cloning" | "migrating" | "repair-required" | "repairing" | "complete";
export type RepositoryLifecycleOperationKind = "cloning" | "migrating" | "repairing";
export type RemoteVerificationStatus = "checking" | "clean" | "changed" | "unverified" | "unavailable";

export interface RemoteVerificationSnapshot {
  status: RemoteVerificationStatus;
  checkedAt?: string;
  errorKind?: RepositoryErrorKind;
}

export interface RepositoryLifecycleLease {
  operationId: string;
  kind: RepositoryLifecycleOperationKind;
  ownerInstanceNonce: string;
  startedAt: string;
  heartbeatAt: string;
  expiresAt: string;
  fence: number;
}

const REPOSITORY_LEASE_MS = 30_000;
const repositoryInstanceNonce = crypto.randomUUID();

export interface LocalRepositoryMeta {
  id: string;
  /** Immutable identity of this particular local working-copy incarnation. */
  localInstanceId: string;
  bookId: string;
  owner: string;
  repo: string;
  branch: string;
  defaultBranch: string;
  remoteHeadSha: string;
  remoteChanged?: boolean;
  remoteStatus?: RemoteVerificationStatus;
  remoteCheckedAt?: string;
  remoteErrorKind?: RepositoryErrorKind;
  lastRemoteHead?: string;
  lastKnownChanged?: boolean;
  clonedAt: string;
  updatedAt: string;
  lastFetchAt?: string;
  /**
   * True only once every file blob of the cloned tree has been stored locally.
   * Undefined on repos cloned before this flag existed (treated as unverified).
   * A repo is considered fully in sync only when this is strictly `true`.
   */
  cloneComplete?: boolean;
  cloneStatus?: LocalCloneStatus;
  /** Present only while a clone or incomplete-clone repair owns this row. */
  cloneOperationId?: string;
  cloneOperationGeneration?: number;
  lastCloneOperationId?: string;
  repairOperationId?: string;
  repairOperationGeneration?: number;
  lastRepairOperationId?: string;
  migrationOperationId?: string;
  migrationOperationGeneration?: number;
  lastMigrationOperationId?: string;
  operationLease?: RepositoryLifecycleLease;
  operationFence?: number;
  /** Number of blobs the remote tree had at clone/verify time. */
  expectedFileCount?: number;
  /** Last repository-scoped commit order allocated transactionally. */
  nextCommitOrder?: number;
  accountScope?: string;
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
  /** Repository-scoped creation order. Missing only on legacy records. */
  order?: number;
}

export interface LocalCommitSettlementResult {
  skippedPaths: string[];
}

export type LocalRepoLogKind = "clone" | "fetch" | "pull" | "commit" | "push" | "backup" | "reset" | "error";

export interface LocalRepoLogEntry {
  id: string;
  repoId: string;
  kind: LocalRepoLogKind;
  message: string;
  createdAt: string;
}

export const REPOSITORY_DIAGNOSTIC_SCHEMA_VERSION = 1 as const;
export const REPOSITORY_DIAGNOSTIC_MAX_RECORDS = 200;
export const REPOSITORY_DIAGNOSTIC_MAX_BYTES = 64 * 1024;

export type RepositoryDiagnosticOperation = "clone" | "repair" | "fetch" | "pull" | "push" | "sync";
export type RepositoryDiagnosticStage = "start" | "remote-read" | "download" | "merge" | "commit" | "push" | "finalize";
export type RepositoryDiagnosticOutcome = "started" | "stage" | "success" | "failure" | "cancelled";

export interface LocalRepositoryDiagnostic {
  id: string;
  schemaVersion: typeof REPOSITORY_DIAGNOSTIC_SCHEMA_VERSION;
  operationId: string;
  localInstanceId: string;
  operation: RepositoryDiagnosticOperation;
  stage: RepositoryDiagnosticStage;
  outcome: RepositoryDiagnosticOutcome;
  createdAt: string;
  startedAt: string;
  durationMs?: number;
  fileCount?: number;
  byteCount?: number;
  errorKind?: RepositoryErrorKind;
  httpStatus?: number;
  retryable?: boolean;
  commitShaPrefix?: string;
}

export interface LocalRepoStatus {
  clean: number;
  modified: number;
  new: number;
  deleted: number;
  dirty: number;
  ahead: number;
}

export interface LocalRepositoryRecovery {
  id: string;
  repoId: string;
  /** Missing only on legacy snapshots, which remain quarantined from operations. */
  accountIdentity?: string;
  reason: string;
  createdAt: string;
  repository: LocalRepositoryMeta;
  files: LocalRepositoryFile[];
  commits: LocalCommit[];
}

interface RepositoryMigrationJournal {
  id: string;
  oldRepoId: string;
  newRepoId: string;
  bookId: string;
  owner: string;
  repo: string;
  branch: string;
  legacyAccountIdentity: string;
  immutableAccountIdentity: string;
  phase: "prepared" | "primary-rekeyed";
  createdAt: string;
  replaceDisposableTarget?: boolean;
}

type RepositoryMigrationCrashPhase = "journal" | "rewrite-prepared" | "primary-rekeyed" | "rewrite-finalized";
let nextRepositoryMigrationCrash: RepositoryMigrationCrashPhase | null = null;

export function crashNextRepositoryMigrationForTests(phase: RepositoryMigrationCrashPhase): void {
  nextRepositoryMigrationCrash = phase;
}

function simulateRepositoryMigrationCrash(phase: RepositoryMigrationCrashPhase): void {
  if (nextRepositoryMigrationCrash !== phase) return;
  nextRepositoryMigrationCrash = null;
  throw new Error(`Simulated repository migration crash after ${phase}.`);
}

function activeAccountScope(): string | null {
  return accountIdentity(useAuthStore.getState().user);
}

function isCurrentAccountScope(scope: string): boolean {
  return Boolean(scope) && activeAccountScope() === scope;
}

function validateRepositoryOperation(repository: LocalRepositoryMeta | undefined, scope: RepositoryOperationScope): LocalRepositoryMeta {
  assertRepositoryOperationScopeCurrent(scope);
  if (!repository || repository.accountScope !== scope.accountIdentity) throw new RepositoryOwnershipChangedError();
  return repository;
}

export class LocalCloneAlreadyInProgressError extends Error {
  readonly code = "LOCAL_CLONE_ALREADY_IN_PROGRESS";

  constructor() {
    super("A local clone is already in progress for this repository.");
    this.name = "LocalCloneAlreadyInProgressError";
  }
}

export type LegacyRepositoryMigrationErrorCode =
  | "LEGACY_REPOSITORY_AUTH_REQUIRED"
  | "LEGACY_REPOSITORY_COPY_CONFLICT"
  | "LEGACY_REPOSITORY_ADOPTION_DECLINED"
  | "LEGACY_REPOSITORY_CHANGED";

export class LegacyRepositoryMigrationRequiredError extends Error {
  constructor(readonly code: LegacyRepositoryMigrationErrorCode, readonly adoptionTarget?: LegacyAdoptionTarget) {
    super(code);
    this.name = "LegacyRepositoryMigrationRequiredError";
  }
}

function validateCloneOperation(repository: LocalRepositoryMeta | undefined, scope: RepositoryOperationScope, cloneOperationId: string): LocalRepositoryMeta {
  const current = validateRepositoryOperation(repository, scope);
  if (current.cloneComplete !== false || current.cloneStatus !== "cloning" || current.cloneOperationId !== cloneOperationId || current.cloneOperationGeneration !== scope.accountGeneration
    || current.operationLease?.operationId !== cloneOperationId || current.operationLease.ownerInstanceNonce !== repositoryInstanceNonce || current.operationLease.fence !== current.operationFence) {
    throw new RepositoryOwnershipChangedError("The local clone operation no longer owns this repository.");
  }
  return current;
}

function validateRepairOperation(repository: LocalRepositoryMeta | undefined, scope: RepositoryOperationScope, repairOperationId: string): LocalRepositoryMeta {
  const current = validateRepositoryOperation(repository, scope);
  if (current.cloneComplete !== false || current.cloneStatus !== "repairing" || current.repairOperationId !== repairOperationId || current.repairOperationGeneration !== scope.accountGeneration
    || current.operationLease?.operationId !== repairOperationId || current.operationLease.ownerInstanceNonce !== repositoryInstanceNonce || current.operationLease.fence !== current.operationFence) {
    throw new RepositoryOwnershipChangedError("The local repair operation no longer owns this repository.");
  }
  return current;
}

function validateMigrationOperation(repository: LocalRepositoryMeta | undefined, scope: RepositoryOperationScope, migrationOperationId: string): LocalRepositoryMeta {
  const current = validateRepositoryOperation(repository, scope);
  if (current.cloneStatus !== "migrating" || current.migrationOperationId !== migrationOperationId || current.migrationOperationGeneration !== scope.accountGeneration
    || current.operationLease?.operationId !== migrationOperationId || current.operationLease.ownerInstanceNonce !== repositoryInstanceNonce || current.operationLease.fence !== current.operationFence) {
    throw new RepositoryOwnershipChangedError("The legacy clone migration no longer owns this repository.");
  }
  return current;
}

function lifecycleLease(kind: RepositoryLifecycleOperationKind, operationId: string, fence: number): RepositoryLifecycleLease {
  const now = Date.now();
  return { operationId, kind, ownerInstanceNonce: repositoryInstanceNonce, startedAt: new Date(now).toISOString(), heartbeatAt: new Date(now).toISOString(), expiresAt: new Date(now + REPOSITORY_LEASE_MS).toISOString(), fence };
}

function leaseExpired(repository: LocalRepositoryMeta, now = Date.now()): boolean {
  return Boolean(repository.operationLease && Date.parse(repository.operationLease.expiresAt) <= now);
}

export function repositoryLifecycleInstanceNonce(): string {
  return repositoryInstanceNonce;
}

function legacyRepoId(owner: string, repo: string, branch: string): string {
  return `${owner}/${repo}#${branch}`.toLowerCase();
}

function repoId(owner: string, repo: string, branch: string, scope = activeAccountScope()): string {
  const remote = legacyRepoId(owner, repo, branch);
  return scope ? `${scope}::${remote}` : remote;
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
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let blocked = false;
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error("Local repository database upgrade is blocked by another tab. Close or reload other Narrarium tabs and retry."));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) {
        db.close();
        return;
      }
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onupgradeneeded = (event) => {
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
      if (!db.objectStoreNames.contains("repositoryDiagnostics")) {
        const diagnostics = db.createObjectStore("repositoryDiagnostics", { keyPath: "id" });
        diagnostics.createIndex("localInstanceId", "localInstanceId", { unique: false });
        diagnostics.createIndex("operationId", "operationId", { unique: false });
        diagnostics.createIndex("createdAt", "createdAt", { unique: false });
      }
      if (!db.objectStoreNames.contains("recoveries")) {
        const recoveries = db.createObjectStore("recoveries", { keyPath: "id" });
        recoveries.createIndex("repoId", "repoId", { unique: false });
      }
      if (!db.objectStoreNames.contains("migrationJournals")) db.createObjectStore("migrationJournals", { keyPath: "id" });
      if (!db.objectStoreNames.contains("maintenanceFences")) db.createObjectStore("maintenanceFences", { keyPath: "repoId" });
      if (!db.objectStoreNames.contains("removalJournals")) db.createObjectStore("removalJournals", { keyPath: "repoId" });
      if (!db.objectStoreNames.contains("consumedBackupReceipts")) db.createObjectStore("consumedBackupReceipts", { keyPath: "receiptId" });
      if (!db.objectStoreNames.contains("maintenanceTombstones")) db.createObjectStore("maintenanceTombstones", { keyPath: "repoId" });
      if (!db.objectStoreNames.contains("maintenanceCompletions")) db.createObjectStore("maintenanceCompletions", { keyPath: "repoId" });
      if (event.oldVersion < 9 && db.objectStoreNames.contains("repositories")) {
        const cursor = request.transaction!.objectStore("repositories").openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) return;
          if (!row.value.localInstanceId) row.update({ ...row.value, localInstanceId: crypto.randomUUID() });
          row.continue();
        };
      }
      if (event.oldVersion < 13 && db.objectStoreNames.contains("logs")) {
        const cursor = request.transaction!.objectStore("logs").openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) return;
          row.update({ ...row.value, message: safeLegacyLogMessage(row.value.kind as LocalRepoLogKind) });
          row.continue();
        };
      }
    };
  }).catch((error) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

const maintenanceAbortErrors = new WeakMap<IDBTransaction, Error>();
let primaryFileWritePause: { entered: () => void; wait: Promise<void> } | null = null;

export function pauseNextPrimaryFileWriteForTests(): { entered: Promise<void>; release: () => void } {
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  primaryFileWritePause = { entered, wait };
  return { entered: enteredPromise, release };
}

async function pausePrimaryFileWriteForTests(): Promise<void> {
  const pause = primaryFileWritePause;
  if (!pause) return;
  primaryFileWritePause = null;
  pause.entered();
  await pause.wait;
}

/** Every ordinary primary mutation includes this guard in its own transaction. */
function guardedWriteTransaction(db: IDBDatabase, storeNames: string | string[], repoIds: string | string[]): IDBTransaction {
  const names = [...new Set([...(Array.isArray(storeNames) ? storeNames : [storeNames]), "maintenanceTombstones", "maintenanceCompletions"])];
  const tx = db.transaction(names, "readwrite");
  for (const repoIdValue of new Set(Array.isArray(repoIds) ? repoIds : [repoIds])) {
    const request = tx.objectStore("maintenanceTombstones").get(repoIdValue);
     const completionRequest = tx.objectStore("maintenanceCompletions").getAll();
    let tombstone = false;
    let completion = false;
    let loaded = 0;
     const validate = () => {
       if (++loaded !== 2 || (!tombstone && !completion)) return;
      maintenanceAbortErrors.set(tx, new RepositoryOwnershipChangedError("The local repository is fenced by maintenance removal."));
      tx.abort();
    };
    request.onsuccess = () => {
      tombstone = Boolean(request.result);
      validate();
    };
     completionRequest.onsuccess = () => { completion = (completionRequest.result as Array<{ repoId?: string; localInstanceId?: string }>).some((marker) => marker.repoId === repoIdValue && marker.localInstanceId !== undefined); validate(); };
  }
  return tx;
}

function transactionError(tx: IDBTransaction): Error | DOMException | null {
  return maintenanceAbortErrors.get(tx) ?? tx.error;
}

function txStore<T>(storeName: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>, maintenanceRepoId?: string | string[]): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const tx = mode === "readwrite" && maintenanceRepoId ? guardedWriteTransaction(db, storeName, maintenanceRepoId) : db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const request = run(store);
    let result: T;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => { if (!maintenanceAbortErrors.has(tx)) reject(request.error); };
    tx.oncomplete = () => resolve(result!);
    tx.onerror = () => reject(transactionError(tx) ?? new Error(`Local ${storeName} transaction failed.`));
    tx.onabort = () => reject(transactionError(tx) ?? new Error(`Local ${storeName} transaction aborted.`));
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

export async function sha256Text(text: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(text));
}

async function hashBlob(blob: Blob): Promise<string> {
  return sha256Bytes(new Uint8Array(await blob.arrayBuffer()));
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
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

export function makeRepoId(owner: string, repo: string, branch: string, scope = activeAccountScope()): string {
  return repoId(owner, repo, branch, scope);
}

export async function putLocalRepository(meta: Omit<LocalRepositoryMeta, "id" | "updatedAt" | "accountScope" | "localInstanceId"> & { localInstanceId?: string }, scope: RepositoryOperationScope): Promise<LocalRepositoryMeta> {
  assertRepositoryOperationScopeCurrent(scope);
  const now = new Date().toISOString();
  const accountScope = scope.accountIdentity;
  const id = repoId(meta.owner, meta.repo, meta.branch, accountScope ?? null);
  const db = await openDb();
  return new Promise<LocalRepositoryMeta>((resolve, reject) => {
    const tx = guardedWriteTransaction(db, "repositories", id);
    const store = tx.objectStore("repositories");
    const request = store.get(id);
    let full: LocalRepositoryMeta;
    request.onsuccess = () => {
      try { assertRepositoryOperationScopeCurrent(scope); }
      catch (error) { validationError = error as Error; tx.abort(); return; }
      const existing = request.result as LocalRepositoryMeta | undefined;
      if (existing && existing.accountScope !== scope.accountIdentity) { validationError = new RepositoryOwnershipChangedError(); tx.abort(); return; }
      const nextCommitOrder = Math.max(existing?.nextCommitOrder ?? 0, meta.nextCommitOrder ?? 0);
      full = { ...meta, localInstanceId: existing?.localInstanceId ?? meta.localInstanceId ?? crypto.randomUUID(), accountScope, id, updatedAt: now, ...(meta.cloneComplete === false && !meta.cloneStatus ? { cloneStatus: "repair-required" as const } : {}), ...(nextCommitOrder ? { nextCommitOrder } : {}) };
      store.put(full);
    };
    request.onerror = () => tx.abort();
    tx.oncomplete = () => resolve(full!);
    let validationError: Error | null = null;
    tx.onerror = () => reject(validationError ?? tx.error);
    tx.onabort = () => reject(validationError ?? tx.error ?? new Error("Local repository transaction aborted."));
  });
}

export async function putOperationalLocalRepository(meta: Omit<LocalRepositoryMeta, "id" | "updatedAt" | "accountScope" | "localInstanceId"> & { localInstanceId?: string }, scope: RepositoryOperationScope): Promise<LocalRepositoryMeta> {
  return putLocalRepository(meta, scope);
}

export async function createLocalRepositoryClone(
  meta: Omit<LocalRepositoryMeta, "id" | "updatedAt" | "accountScope" | "localInstanceId" | "cloneComplete" | "cloneOperationId" | "cloneOperationGeneration">,
  scope: RepositoryOperationScope,
  cloneOperationId: string,
): Promise<LocalRepositoryMeta> {
  assertRepositoryOperationScopeCurrent(scope);
  const id = repoId(meta.owner, meta.repo, meta.branch, scope.accountIdentity);
  const now = new Date().toISOString();
  const db = await openDb();
  return new Promise<LocalRepositoryMeta>((resolve, reject) => {
    const tx = db.transaction(["repositories", "maintenanceFences", "maintenanceTombstones", "maintenanceCompletions"], "readwrite");
    const store = tx.objectStore("repositories");
    let created: LocalRepositoryMeta | undefined;
    let validationError: Error | null = null;
    const request = store.get(id);
    const fenceRequest = tx.objectStore("maintenanceFences").get(id);
    let maintenanceFence = 0;
    let loaded = 0;
    const create = () => {
      if (++loaded !== 2) return;
      try { assertRepositoryOperationScopeCurrent(scope); }
      catch (error) { validationError = error as Error; tx.abort(); return; }
      if (request.result) { validationError = new LocalCloneAlreadyInProgressError(); tx.abort(); return; }
      const operationFence = maintenanceFence + 1;
      created = { ...meta, localInstanceId: crypto.randomUUID(), id, accountScope: scope.accountIdentity, cloneComplete: false, cloneStatus: "cloning", cloneOperationId, cloneOperationGeneration: scope.accountGeneration, operationFence, operationLease: lifecycleLease("cloning", cloneOperationId, operationFence), updatedAt: now };
      tx.objectStore("maintenanceFences").put({ repoId: id, fence: operationFence });
      tx.objectStore("maintenanceTombstones").delete(id);
      tx.objectStore("maintenanceCompletions").delete(id);
      store.add(created);
    };
    request.onsuccess = () => {
      create();
    };
    fenceRequest.onsuccess = () => { maintenanceFence = (fenceRequest.result as { fence?: number } | undefined)?.fence ?? 0; create(); };
    request.onerror = () => tx.abort();
    fenceRequest.onerror = () => tx.abort();
    tx.oncomplete = () => resolve(created!);
    tx.onerror = () => reject(validationError ?? tx.error);
    tx.onabort = () => reject(validationError ?? tx.error ?? new Error("Local clone creation was aborted."));
  });
}

export async function claimLocalRepositoryRepair(repoIdValue: string, scope: RepositoryOperationScope, repairOperationId: string): Promise<LocalRepositoryMeta> {
  const db = await openDb();
  return new Promise<LocalRepositoryMeta>((resolve, reject) => {
    const tx = guardedWriteTransaction(db, "repositories", repoIdValue);
    const store = tx.objectStore("repositories");
    let claimed: LocalRepositoryMeta | undefined;
    let validationError: Error | null = null;
    const request = store.get(repoIdValue);
    request.onsuccess = () => {
      let repository: LocalRepositoryMeta;
      try { repository = validateRepositoryOperation(request.result as LocalRepositoryMeta | undefined, scope); }
      catch (error) { validationError = error as Error; tx.abort(); return; }
      if (repository.cloneStatus === "cloning" || repository.cloneOperationId || repository.cloneStatus === "repairing" || repository.repairOperationId || repository.operationLease) { validationError = new LocalCloneAlreadyInProgressError(); tx.abort(); return; }
      if (repository.cloneComplete !== false || repository.cloneStatus !== "repair-required" || repository.cloneOperationId) { validationError = new Error("The local repository is not ready for repair."); tx.abort(); return; }
      const operationFence = (repository.operationFence ?? 0) + 1;
      claimed = { ...repository, cloneStatus: "repairing", repairOperationId, repairOperationGeneration: scope.accountGeneration, operationFence, operationLease: lifecycleLease("repairing", repairOperationId, operationFence), updatedAt: new Date().toISOString() };
      store.put(claimed);
    };
    request.onerror = () => tx.abort();
    tx.oncomplete = () => resolve(claimed!);
    tx.onerror = () => reject(validationError ?? tx.error);
    tx.onabort = () => reject(validationError ?? tx.error ?? new Error("Local clone repair claim was aborted."));
  });
}

export async function claimLegacyLocalRepositoryMigration(repoIdValue: string, scope: RepositoryOperationScope, migrationOperationId: string): Promise<LocalRepositoryMeta> {
  const db = await openDb();
  return new Promise<LocalRepositoryMeta>((resolve, reject) => {
    const tx = guardedWriteTransaction(db, "repositories", repoIdValue);
    const store = tx.objectStore("repositories");
    let claimed: LocalRepositoryMeta | undefined;
    let validationError: Error | null = null;
    const request = store.get(repoIdValue);
    request.onsuccess = () => {
      let repository: LocalRepositoryMeta;
      try { repository = validateRepositoryOperation(request.result as LocalRepositoryMeta | undefined, scope); }
      catch (error) { validationError = error as Error; tx.abort(); return; }
      if (repository.cloneStatus === "migrating" || repository.migrationOperationId || repository.operationLease) { validationError = new LocalCloneAlreadyInProgressError(); tx.abort(); return; }
      if (repository.cloneComplete !== undefined || repository.cloneStatus !== undefined || repository.cloneOperationId || repository.repairOperationId) {
        validationError = new Error("The local repository is not eligible for legacy migration.");
        tx.abort();
        return;
      }
      const operationFence = (repository.operationFence ?? 0) + 1;
      claimed = { ...repository, cloneStatus: "migrating", migrationOperationId, migrationOperationGeneration: scope.accountGeneration, operationFence, operationLease: lifecycleLease("migrating", migrationOperationId, operationFence), updatedAt: new Date().toISOString() };
      store.put(claimed);
    };
    request.onerror = () => tx.abort();
    tx.oncomplete = () => resolve(claimed!);
    tx.onerror = () => reject(validationError ?? tx.error);
    tx.onabort = () => reject(validationError ?? tx.error ?? new Error("Legacy clone migration claim was aborted."));
  });
}

export async function classifyLegacyLocalRepositoryMigration(input: {
  repoId: string;
  scope: RepositoryOperationScope;
  migrationOperationId: string;
  expectedRemoteHeadSha: string;
  expectedFiles: LocalRepositoryFile[];
  expectedFileCount: number;
  complete: boolean;
}): Promise<LocalRepositoryMeta> {
  const db = await openDb();
  return new Promise<LocalRepositoryMeta>((resolve, reject) => {
    const tx = guardedWriteTransaction(db, ["repositories", "files"], input.repoId);
    const repositories = tx.objectStore("repositories");
    let repository: LocalRepositoryMeta | undefined;
    let files: LocalRepositoryFile[] | undefined;
    let updated: LocalRepositoryMeta | undefined;
    let validationError: Error | null = null;
    const apply = () => {
      if (!repository || !files) return;
      if (repository.remoteHeadSha !== input.expectedRemoteHeadSha || !sameLocalFiles(input.expectedFiles, files)) {
        validationError = new Error("The legacy local repository changed during migration.");
        tx.abort();
        return;
      }
      updated = {
        ...repository,
        cloneComplete: input.complete,
        cloneStatus: input.complete ? "complete" : "repair-required",
        expectedFileCount: input.expectedFileCount,
        migrationOperationId: undefined,
        migrationOperationGeneration: undefined,
        lastMigrationOperationId: input.migrationOperationId,
        operationLease: undefined,
        updatedAt: new Date().toISOString(),
      };
      repositories.put(updated);
    };
    const repositoryRequest = repositories.get(input.repoId);
    repositoryRequest.onsuccess = () => {
      try { repository = validateMigrationOperation(repositoryRequest.result as LocalRepositoryMeta | undefined, input.scope, input.migrationOperationId); }
      catch (error) { validationError = error as Error; tx.abort(); return; }
      apply();
    };
    repositoryRequest.onerror = () => tx.abort();
    const filesRequest = tx.objectStore("files").index("repoId").getAll(input.repoId);
    filesRequest.onsuccess = () => { files = filesRequest.result as LocalRepositoryFile[]; apply(); };
    filesRequest.onerror = () => tx.abort();
    tx.oncomplete = () => resolve(updated!);
    tx.onerror = () => reject(validationError ?? tx.error);
    tx.onabort = () => reject(validationError ?? tx.error ?? new Error("Legacy clone migration classification was aborted."));
  });
}

export async function releaseLegacyLocalRepositoryMigration(repoIdValue: string, scope: RepositoryOperationScope, migrationOperationId: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = guardedWriteTransaction(db, "repositories", repoIdValue);
    const store = tx.objectStore("repositories");
    let validationError: Error | null = null;
    const request = store.get(repoIdValue);
    request.onsuccess = () => {
      try {
        const repository = validateMigrationOperation(request.result as LocalRepositoryMeta | undefined, scope, migrationOperationId);
        store.put({ ...repository, cloneStatus: undefined, migrationOperationId: undefined, migrationOperationGeneration: undefined, lastMigrationOperationId: migrationOperationId, operationLease: undefined, updatedAt: new Date().toISOString() });
      } catch (error) { validationError = error as Error; tx.abort(); }
    };
    request.onerror = () => tx.abort();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(validationError ?? tx.error);
    tx.onabort = () => reject(validationError ?? tx.error ?? new Error("Legacy clone migration release was aborted."));
  });
}

export async function markLocalRepositoryRepairRequired(repoIdValue: string, scope: RepositoryOperationScope, cloneOperationId: string): Promise<LocalRepositoryMeta> {
  const db = await openDb();
  return new Promise<LocalRepositoryMeta>((resolve, reject) => {
    const tx = guardedWriteTransaction(db, "repositories", repoIdValue);
    const store = tx.objectStore("repositories");
    let updated: LocalRepositoryMeta | undefined;
    let validationError: Error | null = null;
    const request = store.get(repoIdValue);
    request.onsuccess = () => {
      try {
        const repository = validateCloneOperation(request.result as LocalRepositoryMeta | undefined, scope, cloneOperationId);
        updated = { ...repository, cloneStatus: "repair-required", cloneOperationId: undefined, cloneOperationGeneration: undefined, lastCloneOperationId: cloneOperationId, operationLease: undefined, updatedAt: new Date().toISOString() };
        store.put(updated);
      } catch (error) { validationError = error as Error; tx.abort(); }
    };
    request.onerror = () => tx.abort();
    tx.oncomplete = () => resolve(updated!);
    tx.onerror = () => reject(validationError ?? tx.error);
    tx.onabort = () => reject(validationError ?? tx.error ?? new Error("Clone repair-required transition was aborted."));
  });
}

export async function releaseLocalRepositoryRepair(repoIdValue: string, scope: RepositoryOperationScope, repairOperationId: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = guardedWriteTransaction(db, "repositories", repoIdValue);
    const store = tx.objectStore("repositories");
    let validationError: Error | null = null;
    const request = store.get(repoIdValue);
    request.onsuccess = () => {
      try {
        const repository = validateRepairOperation(request.result as LocalRepositoryMeta | undefined, scope, repairOperationId);
        store.put({ ...repository, cloneStatus: "repair-required", repairOperationId: undefined, repairOperationGeneration: undefined, lastRepairOperationId: repairOperationId, operationLease: undefined, updatedAt: new Date().toISOString() });
      } catch (error) { validationError = error as Error; tx.abort(); }
    };
    request.onerror = () => tx.abort();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(validationError ?? tx.error);
    tx.onabort = () => reject(validationError ?? transactionError(tx) ?? new Error("Local repair release was aborted."));
  });
}

export async function heartbeatRepositoryLifecycleLease(repoIdValue: string, scope: RepositoryOperationScope, operationId: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = guardedWriteTransaction(db, "repositories", repoIdValue);
    const store = tx.objectStore("repositories");
    let validationError: Error | null = null;
    const request = store.get(repoIdValue);
    request.onsuccess = () => {
      try {
        const repository = validateRepositoryOperation(request.result as LocalRepositoryMeta | undefined, scope);
        const lease = repository.operationLease;
        if (!lease || lease.operationId !== operationId || lease.ownerInstanceNonce !== repositoryInstanceNonce || lease.fence !== repository.operationFence) throw new RepositoryOwnershipChangedError("The repository lifecycle lease is stale.");
        const now = Date.now();
        store.put({ ...repository, operationLease: { ...lease, heartbeatAt: new Date(now).toISOString(), expiresAt: new Date(now + REPOSITORY_LEASE_MS).toISOString() }, updatedAt: new Date(now).toISOString() });
      } catch (error) { validationError = error as Error; tx.abort(); }
    };
    request.onerror = () => tx.abort();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(validationError ?? tx.error);
    tx.onabort = () => reject(validationError ?? tx.error ?? new Error("Repository lifecycle heartbeat was aborted."));
  });
}

export async function reclaimExpiredRepositoryLifecycleLease(repoIdValue: string, scope: RepositoryOperationScope, operationId: string): Promise<LocalRepositoryMeta> {
  const db = await openDb();
  return new Promise<LocalRepositoryMeta>((resolve, reject) => {
    const tx = guardedWriteTransaction(db, "repositories", repoIdValue);
    const store = tx.objectStore("repositories");
    let reclaimed: LocalRepositoryMeta | undefined;
    let validationError: Error | null = null;
    const request = store.get(repoIdValue);
    request.onsuccess = () => {
      try {
        const repository = validateRepositoryOperation(request.result as LocalRepositoryMeta | undefined, scope);
        if (!repository.operationLease || !leaseExpired(repository)) throw new LocalCloneAlreadyInProgressError();
        const operationFence = (repository.operationFence ?? repository.operationLease.fence) + 1;
        const kind = repository.operationLease.kind;
        reclaimed = {
          ...repository,
          operationFence,
          operationLease: lifecycleLease(kind, operationId, operationFence),
          cloneOperationId: kind === "cloning" ? operationId : repository.cloneOperationId,
          cloneOperationGeneration: kind === "cloning" ? scope.accountGeneration : repository.cloneOperationGeneration,
          migrationOperationId: kind === "migrating" ? operationId : repository.migrationOperationId,
          migrationOperationGeneration: kind === "migrating" ? scope.accountGeneration : repository.migrationOperationGeneration,
          repairOperationId: kind === "repairing" ? operationId : repository.repairOperationId,
          repairOperationGeneration: kind === "repairing" ? scope.accountGeneration : repository.repairOperationGeneration,
          updatedAt: new Date().toISOString(),
        };
        store.put(reclaimed);
      } catch (error) { validationError = error as Error; tx.abort(); }
    };
    request.onerror = () => tx.abort();
    tx.oncomplete = () => resolve(reclaimed!);
    tx.onerror = () => reject(validationError ?? tx.error);
    tx.onabort = () => reject(validationError ?? tx.error ?? new Error("Repository lifecycle reclaim was aborted."));
  });
}

export async function putQuarantinedLocalRepository(meta: Omit<LocalRepositoryMeta, "id" | "updatedAt" | "localInstanceId"> & { localInstanceId?: string }): Promise<LocalRepositoryMeta> {
  const now = new Date().toISOString();
  const id = repoId(meta.owner, meta.repo, meta.branch, meta.accountScope ?? null);
  const full = { ...meta, localInstanceId: meta.localInstanceId ?? crypto.randomUUID(), id, updatedAt: now };
  await txStore("repositories", "readwrite", (store) => store.put(full), id);
  return full;
}

export async function getLocalRepository(owner: string, repo: string, branch: string, scope: RepositoryOperationScope): Promise<LocalRepositoryMeta | null> {
  const scopedId = repoId(owner, repo, branch, scope.accountIdentity);
  const db = await openDb();
  return new Promise<LocalRepositoryMeta | null>((resolve, reject) => {
    const tx = db.transaction("repositories", "readonly");
    const request = tx.objectStore("repositories").get(scopedId);
    let result: LocalRepositoryMeta | null = null;
    let validationError: Error | null = null;
    request.onsuccess = () => {
      try {
        assertRepositoryOperationScopeCurrent(scope);
        const repository = request.result as LocalRepositoryMeta | undefined;
        result = repository?.accountScope === scope.accountIdentity ? repository : null;
      } catch (error) {
        validationError = error as Error;
        tx.abort();
      }
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => {
      try { assertRepositoryOperationScopeCurrent(scope); resolve(result); }
      catch (error) { reject(error); }
    };
    tx.onerror = () => reject(validationError ?? tx.error);
    tx.onabort = () => reject(validationError ?? tx.error ?? new Error("Local repository read was aborted."));
  });
}

/** Re-key a proven pre-0.76.38 email-scoped working copy without copying or downloading content. */
export async function adoptLegacyEmailScopedRepository(input: {
  bookId: string;
  owner: string;
  repo: string;
  branch: string;
  scope: RepositoryOperationScope;
}): Promise<LocalRepositoryMeta | null> {
  assertRepositoryOperationScopeCurrent(input.scope);
  const user = useAuthStore.getState().user;
  if (!user || accountIdentity(user) !== input.scope.accountIdentity) throw new RepositoryOwnershipChangedError();
  const legacyScope = legacyEmailAccountIdentity(user);
  const oldId = repoId(input.owner, input.repo, input.branch, legacyScope);
  const newId = repoId(input.owner, input.repo, input.branch, input.scope.accountIdentity);
  const resumed = await resumeRepositoryMigrationForTarget(oldId, newId, input.scope);
  if (resumed) return resumed;
  const legacy = await txStore<LocalRepositoryMeta | undefined>("repositories", "readonly", (store) => store.get(oldId));
  const exact = legacy?.id === oldId && legacy.accountScope === legacyScope && legacy.bookId === input.bookId
    && legacy.owner === input.owner && legacy.repo === input.repo && legacy.branch === input.branch;
  if (!legacy) {
    const candidates = await allFromIndex<LocalRepositoryMeta>("repositories", "remote", IDBKeyRange.only([input.owner, input.repo, input.branch]));
    if (candidates.some((row) => row.bookId === input.bookId && row.id !== newId)) throw new LegacyRepositoryMigrationRequiredError("LEGACY_REPOSITORY_COPY_CONFLICT");
    return null;
  }
  if (!exact) throw new LegacyRepositoryMigrationRequiredError("LEGACY_REPOSITORY_CHANGED");
  const evidence = getLegacyAccountUpgradeEvidence(user, input.scope.accountIdentity);
  if (!evidence) {
    beginStrandedLegacyRecovery(user, legacyScope);
    throw new LegacyRepositoryMigrationRequiredError("LEGACY_REPOSITORY_AUTH_REQUIRED");
  }
  const rewrites = await inspectLegacyRewriteOperationMigration({ oldRepoId: oldId, newRepoId: newId, legacyAccountIdentity: legacyScope, immutableAccountIdentity: input.scope.accountIdentity });
  if (rewrites.collisions.length || rewrites.targetCount) throw new LegacyRepositoryMigrationRequiredError("LEGACY_REPOSITORY_COPY_CONFLICT");
  const targetDisposition = await inspectCompetingImmutableRepository(newId, input.scope.accountIdentity);
  if (targetDisposition === "preserve") throw new LegacyRepositoryMigrationRequiredError("LEGACY_REPOSITORY_COPY_CONFLICT");
  const adoptionTarget: LegacyAdoptionTarget = { bookId: input.bookId, owner: input.owner, repo: input.repo, branch: input.branch, legacyIdentity: legacyScope, evidenceNonce: evidence.nonce, replaceDisposableTarget: targetDisposition === "replace" };
  if (!consumeLegacyAdoptionConsent(user, adoptionTarget, evidence)) throw new LegacyRepositoryMigrationRequiredError("LEGACY_REPOSITORY_ADOPTION_DECLINED", adoptionTarget);
  const journal: RepositoryMigrationJournal = { id: evidence.nonce, oldRepoId: oldId, newRepoId: newId, bookId: input.bookId, owner: input.owner, repo: input.repo, branch: input.branch, legacyAccountIdentity: legacyScope, immutableAccountIdentity: input.scope.accountIdentity, phase: "prepared", createdAt: new Date().toISOString(), replaceDisposableTarget: targetDisposition === "replace" };
  await txStore("migrationJournals", "readwrite", (store) => store.add(journal), [oldId, newId]);
  simulateRepositoryMigrationCrash("journal");
  await prepareLegacyRewriteOperationMigration({ journalId: journal.id, oldRepoId: oldId, newRepoId: newId, legacyAccountIdentity: legacyScope, immutableAccountIdentity: input.scope.accountIdentity });
  simulateRepositoryMigrationCrash("rewrite-prepared");
  return completeRepositoryMigration(journal, input.scope);
}

async function inspectCompetingImmutableRepository(newRepoId: string, immutableIdentity: string): Promise<"none" | "replace" | "preserve"> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["repositories", "files", "commits", "logs", "recoveries"], "readonly");
    const requests = {
      repository: tx.objectStore("repositories").get(newRepoId),
      files: tx.objectStore("files").index("repoId").getAll(newRepoId),
      commits: tx.objectStore("commits").index("repoId").getAll(newRepoId),
      logs: tx.objectStore("logs").index("repoId").getAll(newRepoId),
      recoveries: tx.objectStore("recoveries").index("repoId").getAll(newRepoId),
    };
    Promise.all(Object.values(requests).map((request) => new Promise<unknown>((done, fail) => { request.onsuccess = () => done(request.result); request.onerror = () => fail(request.error); })))
      .then(async ([repositoryValue, filesValue, commitsValue, logsValue, recoveriesValue]) => {
        const repository = repositoryValue as LocalRepositoryMeta | undefined;
        if (!repository) { resolve("none"); return; }
        const files = filesValue as LocalRepositoryFile[];
        const commits = commitsValue as LocalCommit[];
        const logs = logsValue as LocalRepoLogEntry[];
        const recoveries = recoveriesValue as LocalRepositoryRecovery[];
        const rewrites = await inspectLegacyRewriteOperationMigration({ oldRepoId: "", newRepoId, legacyAccountIdentity: "", immutableAccountIdentity: immutableIdentity });
        const filesAreRemoteMirrors = files.every((file) => file.status === "clean" && !file.committed && Boolean(file.baseSha) && Boolean(file.baseHash) && file.currentHash === file.baseHash);
        const hasMutationLog = logs.some((log) => ["commit", "push", "pull", "backup", "reset"].includes(log.kind));
        resolve(repository.accountScope === immutableIdentity && filesAreRemoteMirrors && commits.length === 0 && recoveries.length === 0 && rewrites.targetCount === 0 && !hasMutationLog ? "replace" : "preserve");
      }).catch(reject);
  });
}

async function completeRepositoryMigration(journal: RepositoryMigrationJournal, scope: RepositoryOperationScope): Promise<LocalRepositoryMeta> {
  assertRepositoryOperationScopeCurrent(scope);
  if (journal.immutableAccountIdentity !== scope.accountIdentity) throw new RepositoryOwnershipChangedError();
  const db = await openDb();
  const stores = ["repositories", "files", "commits", "logs", "recoveries", "migrationJournals"].filter((name) => db.objectStoreNames.contains(name));
  if (journal.phase === "prepared") await new Promise<void>((resolve, reject) => {
    const tx = guardedWriteTransaction(db, stores, [journal.oldRepoId, journal.newRepoId]);
    const repositories = tx.objectStore("repositories");
    let validationError: Error | null = null;
    const legacyRequest = repositories.get(journal.oldRepoId);
    const currentRequest = repositories.get(journal.newRepoId);
    let legacy: LocalRepositoryMeta | undefined;
    let current: LocalRepositoryMeta | undefined;
    let loaded = 0;
    let targetFiles: LocalRepositoryFile[] = [];
    let targetCommits: LocalCommit[] = [];
    let targetLogs: LocalRepoLogEntry[] = [];
    let targetRecoveries: LocalRepositoryRecovery[] = [];
    const apply = () => {
      if (++loaded !== 6) return;
      try { assertRepositoryOperationScopeCurrent(scope); } catch (error) { validationError = error as Error; tx.abort(); return; }
      if (!legacy || legacy.bookId !== journal.bookId || legacy.accountScope !== journal.legacyAccountIdentity) { validationError = new RepositoryOwnershipChangedError(); tx.abort(); return; }
      if (current) {
        const disposable = journal.replaceDisposableTarget && current.accountScope === journal.immutableAccountIdentity
          && targetFiles.every((file) => file.status === "clean" && !file.committed && Boolean(file.baseSha) && Boolean(file.baseHash) && file.currentHash === file.baseHash)
          && targetCommits.length === 0 && targetRecoveries.length === 0
          && !targetLogs.some((log) => ["commit", "push", "pull", "backup", "reset"].includes(log.kind));
        if (!disposable) { validationError = new LegacyRepositoryMigrationRequiredError("LEGACY_REPOSITORY_COPY_CONFLICT"); tx.abort(); return; }
        for (const file of targetFiles) tx.objectStore("files").delete(file.key);
        for (const commit of targetCommits) tx.objectStore("commits").delete(commit.id);
        for (const log of targetLogs) tx.objectStore("logs").delete(log.id);
        for (const recovery of targetRecoveries) tx.objectStore("recoveries").delete(recovery.id);
        repositories.delete(journal.newRepoId);
      }
      repositories.add({ ...legacy, id: journal.newRepoId, localInstanceId: legacy.localInstanceId ?? crypto.randomUUID(), accountScope: journal.immutableAccountIdentity, updatedAt: new Date().toISOString() });
        const rekey = <T extends { repoId: string }>(storeName: string, update: (row: T) => T) => {
          if (!stores.includes(storeName)) return;
          const store = tx.objectStore(storeName);
          const request = store.index("repoId").openCursor(IDBKeyRange.only(journal.oldRepoId));
          request.onsuccess = () => { const cursor = request.result; if (!cursor) return; store.delete(cursor.primaryKey); store.put(update(cursor.value as T)); cursor.continue(); };
          request.onerror = () => tx.abort();
        };
        rekey<LocalRepositoryFile>("files", (row) => ({ ...row, repoId: journal.newRepoId, key: fileKey(journal.newRepoId, row.path) }));
        rekey<LocalCommit>("commits", (row) => ({ ...row, repoId: journal.newRepoId }));
        rekey<LocalRepoLogEntry>("logs", (row) => ({ ...row, repoId: journal.newRepoId }));
        rekey<LocalRepositoryRecovery>("recoveries", (row) => ({ ...row, repoId: journal.newRepoId, accountIdentity: journal.immutableAccountIdentity, repository: { ...row.repository, id: journal.newRepoId, accountScope: journal.immutableAccountIdentity }, files: row.files.map((file) => ({ ...file, repoId: journal.newRepoId, key: fileKey(journal.newRepoId, file.path) })), commits: row.commits.map((commit) => ({ ...commit, repoId: journal.newRepoId })) }));
        repositories.delete(journal.oldRepoId);
      tx.objectStore("migrationJournals").put({ ...journal, phase: "primary-rekeyed" });
    };
    legacyRequest.onsuccess = () => { legacy = legacyRequest.result as LocalRepositoryMeta | undefined; apply(); };
    currentRequest.onsuccess = () => { current = currentRequest.result as LocalRepositoryMeta | undefined; apply(); };
    const targetFilesRequest = tx.objectStore("files").index("repoId").getAll(journal.newRepoId);
    const targetCommitsRequest = tx.objectStore("commits").index("repoId").getAll(journal.newRepoId);
    const targetLogsRequest = tx.objectStore("logs").index("repoId").getAll(journal.newRepoId);
    const targetRecoveriesRequest = tx.objectStore("recoveries").index("repoId").getAll(journal.newRepoId);
    targetFilesRequest.onsuccess = () => { targetFiles = targetFilesRequest.result as LocalRepositoryFile[]; apply(); };
    targetCommitsRequest.onsuccess = () => { targetCommits = targetCommitsRequest.result as LocalCommit[]; apply(); };
    targetLogsRequest.onsuccess = () => { targetLogs = targetLogsRequest.result as LocalRepoLogEntry[]; apply(); };
    targetRecoveriesRequest.onsuccess = () => { targetRecoveries = targetRecoveriesRequest.result as LocalRepositoryRecovery[]; apply(); };
    legacyRequest.onerror = currentRequest.onerror = () => tx.abort();
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(validationError ?? tx.error); tx.onabort = () => reject(validationError ?? tx.error ?? new Error("Repository migration was aborted."));
  });
  if (journal.phase === "prepared") simulateRepositoryMigrationCrash("primary-rekeyed");
  await finalizeLegacyRewriteOperationMigration({ journalId: journal.id, oldRepoId: journal.oldRepoId, newRepoId: journal.newRepoId, immutableAccountIdentity: journal.immutableAccountIdentity });
  simulateRepositoryMigrationCrash("rewrite-finalized");
  await txStore("migrationJournals", "readwrite", (store) => store.delete(journal.id), [journal.oldRepoId, journal.newRepoId]);
  const user = useAuthStore.getState().user;
  if (user) consumeLegacyAccountUpgradeEvidence(user, journal.immutableAccountIdentity, journal.id);
  const repository = await getLocalRepositoryById(journal.newRepoId, scope.accountIdentity);
  if (!repository) throw new RepositoryOwnershipChangedError();
  return repository;
}

async function resumeRepositoryMigrationForTarget(oldRepoId: string, newRepoId: string, scope: RepositoryOperationScope): Promise<LocalRepositoryMeta | null> {
  const journals = await txStore<RepositoryMigrationJournal[]>("migrationJournals", "readonly", (store) => store.getAll());
  const journal = journals.find((entry) => entry.oldRepoId === oldRepoId && entry.newRepoId === newRepoId);
  if (!journal) return null;
  if (journal.immutableAccountIdentity !== scope.accountIdentity) throw new LegacyRepositoryMigrationRequiredError("LEGACY_REPOSITORY_COPY_CONFLICT");
  await prepareLegacyRewriteOperationMigration({ journalId: journal.id, oldRepoId: journal.oldRepoId, newRepoId: journal.newRepoId, legacyAccountIdentity: journal.legacyAccountIdentity, immutableAccountIdentity: journal.immutableAccountIdentity });
  return completeRepositoryMigration(journal, scope);
}

export async function resumeCurrentAccountRepositoryMigrations(): Promise<void> {
  const identity = activeAccountScope();
  if (!identity) return;
  const scope = captureRepositoryOperationScope();
  const journals = await txStore<RepositoryMigrationJournal[]>("migrationJournals", "readonly", (store) => store.getAll());
  for (const journal of journals.filter((entry) => entry.immutableAccountIdentity === identity)) {
    await prepareLegacyRewriteOperationMigration({ journalId: journal.id, oldRepoId: journal.oldRepoId, newRepoId: journal.newRepoId, legacyAccountIdentity: journal.legacyAccountIdentity, immutableAccountIdentity: journal.immutableAccountIdentity });
    await completeRepositoryMigration(journal, scope);
  }
}

export async function getLocalRepositoryById(repoIdValue: string, scope: string): Promise<LocalRepositoryMeta | null> {
  if (!isCurrentAccountScope(scope)) return null;
  const repository = await txStore<LocalRepositoryMeta | undefined>("repositories", "readonly", (store) => store.get(repoIdValue));
  return repository?.accountScope === scope ? repository : null;
}

export async function getLocalRepositoryByBook(bookId: string, scope: string): Promise<LocalRepositoryMeta | null> {
  if (!isCurrentAccountScope(scope)) return null;
  const rows = await allFromIndex<LocalRepositoryMeta>("repositories", "bookId", bookId);
  return rows.filter((row) => row.accountScope === scope).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

export async function listLocalFiles(repoIdValue: string): Promise<LocalRepositoryFile[]> {
  const files = await allFromIndex<LocalRepositoryFile>("files", "repoId", repoIdValue);
  return files.filter((file) => file.status !== "deleted").sort((a, b) => a.path.localeCompare(b.path));
}

export async function listAllLocalFiles(repoIdValue: string): Promise<LocalRepositoryFile[]> {
  const files = await allFromIndex<LocalRepositoryFile>("files", "repoId", repoIdValue);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function removeLocalRepository(repoIdValue: string, scope: RepositoryOperationScope): Promise<void> {
  const db = await openDb();
  // Recovery snapshots intentionally outlive the working copy they protect.
  const stores = ["repositories", "files", "commits", "logs", "repositoryDiagnostics"].filter((store) => db.objectStoreNames.contains(store));
  await new Promise<void>((resolve, reject) => {
    const tx = guardedWriteTransaction(db, stores, repoIdValue);
    const repositories = tx.objectStore("repositories");
    let validationError: Error | null = null;
    const repositoryRequest = repositories.get(repoIdValue);
    repositoryRequest.onerror = () => tx.abort();
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
    repositoryRequest.onsuccess = () => {
      try {
        const repository = validateRepositoryOperation(repositoryRequest.result as LocalRepositoryMeta | undefined, scope);
        repositories.delete(repoIdValue);
        const diagnostics = tx.objectStore("repositoryDiagnostics");
        const cursorRequest = diagnostics.index("localInstanceId").openKeyCursor(IDBKeyRange.only(repository.localInstanceId));
        cursorRequest.onsuccess = () => { const cursor = cursorRequest.result; if (cursor) { diagnostics.delete(cursor.primaryKey); cursor.continue(); } };
        cursorRequest.onerror = () => tx.abort();
      } catch (error) { validationError = error as Error; tx.abort(); }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(validationError ?? tx.error);
    tx.onabort = () => reject(validationError ?? tx.error ?? new Error("Local repository removal was aborted."));
  });
}

/** Cleanup only for a clone created by the supplied immutable operation scope. */
export async function removeAbandonedLocalClone(expected: Pick<LocalRepositoryMeta, "id" | "bookId" | "owner" | "repo" | "branch">, scope: RepositoryOperationScope, cloneOperationId: string): Promise<void> {
  const db = await openDb();
  const stores = ["repositories", "files", "commits", "logs", "repositoryDiagnostics"].filter((store) => db.objectStoreNames.contains(store));
  await new Promise<void>((resolve, reject) => {
    const tx = guardedWriteTransaction(db, stores, expected.id);
    const repositories = tx.objectStore("repositories");
    let validationError: Error | null = null;
    const request = repositories.get(expected.id);
    request.onsuccess = () => {
      const repository = request.result as LocalRepositoryMeta | undefined;
      try {
        assertRepositoryOperationScopeCurrent(scope);
      } catch (error) {
        validationError = error as Error;
        tx.abort();
        return;
      }
      if (!repository || repository.id !== expected.id || repository.bookId !== expected.bookId
        || repository.owner !== expected.owner || repository.repo !== expected.repo || repository.branch !== expected.branch
        || repository.accountScope !== scope.accountIdentity || repository.cloneComplete !== false
        || repository.cloneOperationId !== cloneOperationId || repository.cloneOperationGeneration !== scope.accountGeneration) {
        validationError = new RepositoryOwnershipChangedError("Abandoned clone cleanup cannot remove this repository.");
        tx.abort();
        return;
      }
      repositories.delete(expected.id);
      for (const storeName of ["files", "commits", "logs"]) {
        if (!stores.includes(storeName)) continue;
        const store = tx.objectStore(storeName);
        const cursorRequest = store.index("repoId").openKeyCursor(IDBKeyRange.only(expected.id));
        cursorRequest.onsuccess = () => { const cursor = cursorRequest.result; if (cursor) { store.delete(cursor.primaryKey); cursor.continue(); } };
      }
      const diagnostics = tx.objectStore("repositoryDiagnostics");
      const diagnosticCursor = diagnostics.index("localInstanceId").openKeyCursor(IDBKeyRange.only(repository.localInstanceId));
      diagnosticCursor.onsuccess = () => { const cursor = diagnosticCursor.result; if (cursor) { diagnostics.delete(cursor.primaryKey); cursor.continue(); } };
      diagnosticCursor.onerror = () => tx.abort();
    };
    request.onerror = () => tx.abort();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(validationError ?? tx.error);
    tx.onabort = () => reject(validationError ?? tx.error ?? new Error("Abandoned clone cleanup was aborted."));
  });
}

export async function listDirtyLocalFiles(repoIdValue: string): Promise<LocalRepositoryFile[]> {
  return (await listAllLocalFiles(repoIdValue)).filter((file) => file.status !== "clean" && !file.committed);
}

export async function getLocalFileEntry(repoIdValue: string, path: string, scope: RepositoryOperationScope): Promise<LocalRepositoryFile | null> {
  const db = await openDb();
  return new Promise<LocalRepositoryFile | null>((resolve, reject) => {
    const tx = db.transaction(["repositories", "files"], "readonly");
    const repositoryRequest = tx.objectStore("repositories").get(repoIdValue);
    const fileRequest = tx.objectStore("files").get(fileKey(repoIdValue, path));
    let repository: LocalRepositoryMeta | undefined;
    let file: LocalRepositoryFile | undefined;
    let loaded = 0;
    let result: LocalRepositoryFile | null = null;
    let validationError: Error | null = null;
    const complete = () => {
      loaded += 1;
      if (loaded !== 2) return;
      try {
        validateRepositoryOperation(repository, scope);
        result = file ?? null;
      } catch (error) {
        validationError = error as Error;
        tx.abort();
      }
    };
    repositoryRequest.onsuccess = () => { repository = repositoryRequest.result as LocalRepositoryMeta | undefined; complete(); };
    fileRequest.onsuccess = () => { file = fileRequest.result as LocalRepositoryFile | undefined; complete(); };
    repositoryRequest.onerror = fileRequest.onerror = () => tx.abort();
    tx.oncomplete = () => {
      try { assertRepositoryOperationScopeCurrent(scope); resolve(result); }
      catch (error) { reject(error); }
    };
    tx.onerror = () => reject(validationError ?? tx.error);
    tx.onabort = () => reject(validationError ?? tx.error ?? new Error("Local file read was aborted."));
  });
}

export async function getLocalFile(repoIdValue: string, path: string, scope: RepositoryOperationScope): Promise<LocalRepositoryFile | null> {
  const file = await getLocalFileEntry(repoIdValue, path, scope);
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
  const file = await prepareCleanLocalFile(input);
  await txStore("files", "readwrite", (store) => store.put(file), input.repoId);
  return file;
}

export async function putCleanLocalFileScoped(input: Parameters<typeof putCleanLocalFile>[0], scope: RepositoryOperationScope, cloneOperationId: string): Promise<LocalRepositoryFile> {
  const file = await prepareCleanLocalFile(input);
  await putScopedLocalFile(input.repoId, scope, file, cloneOperationId);
  return file;
}

async function prepareCleanLocalFile(input: Parameters<typeof putCleanLocalFile>[0]): Promise<LocalRepositoryFile> {
  const measuredSize = input.kind === "text" ? utf8Bytes(input.text ?? "") : input.blob?.size ?? 0;
  assertRepositoryFileBytes(input.kind, measuredSize);
  const currentHash = input.kind === "text" ? await sha256Text(input.text ?? "") : await hashBlob(input.blob ?? new Blob());
  return { key: fileKey(input.repoId, input.path), repoId: input.repoId, path: input.path, kind: input.kind, text: input.text, blob: input.blob, baseSha: input.baseSha, baseHash: currentHash, currentHash, status: "clean", committed: false, size: measuredSize, updatedAt: new Date().toISOString() };
}

export async function writeLocalTextScoped(repoIdValue: string, path: string, text: string, scope: RepositoryOperationScope): Promise<LocalRepositoryFile> {
  const size = utf8Bytes(text);
  assertRepositoryFileBytes("text", size);
  const existing = await getLocalFileEntry(repoIdValue, path, scope);
  const currentHash = await sha256Text(text);
  const file: LocalRepositoryFile = { key: fileKey(repoIdValue, path), repoId: repoIdValue, path, kind: "text", text, baseSha: existing?.baseSha, baseHash: existing?.baseHash, currentHash, status: statusAfterWrite(existing ?? undefined, currentHash), committed: false, size, updatedAt: new Date().toISOString() };
  await putScopedLocalFile(repoIdValue, scope, file);
  return file;
}

export async function writeLocalBinaryScoped(repoIdValue: string, path: string, bytes: Uint8Array, scope: RepositoryOperationScope): Promise<LocalRepositoryFile> {
  assertRepositoryFileBytes("binary", bytes.byteLength);
  const existing = await getLocalFileEntry(repoIdValue, path, scope);
  const currentHash = await sha256Bytes(bytes);
  const file: LocalRepositoryFile = { key: fileKey(repoIdValue, path), repoId: repoIdValue, path, kind: "binary", blob: new Blob([bytesToArrayBuffer(bytes)]), baseSha: existing?.baseSha, baseHash: existing?.baseHash, currentHash, status: statusAfterWrite(existing ?? undefined, currentHash), committed: false, size: bytes.byteLength, updatedAt: new Date().toISOString() };
  await putScopedLocalFile(repoIdValue, scope, file);
  return file;
}

async function putScopedLocalFile(repoIdValue: string, scope: RepositoryOperationScope, file: LocalRepositoryFile, cloneOperationId?: string): Promise<void> {
  await pausePrimaryFileWriteForTests();
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = guardedWriteTransaction(db, ["repositories", "files"], repoIdValue);
    let validationError: Error | null = null;
    const request = tx.objectStore("repositories").get(repoIdValue);
    request.onsuccess = () => { try { cloneOperationId ? validateCloneOperation(request.result as LocalRepositoryMeta | undefined, scope, cloneOperationId) : validateRepositoryOperation(request.result as LocalRepositoryMeta | undefined, scope); tx.objectStore("files").put(file); } catch (error) { validationError = error as Error; tx.abort(); } };
    request.onerror = () => tx.abort();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(validationError ?? transactionError(tx));
    tx.onabort = () => reject(validationError ?? transactionError(tx) ?? new Error("Local file write was aborted."));
  });
}

export async function deleteLocalFileScoped(repoIdValue: string, path: string, scope: RepositoryOperationScope): Promise<void> {
  await mutateLocalTextFilesAtomically(repoIdValue, scope, [{ path, content: null }]);
}

export async function writeLocalText(repoIdValue: string, path: string, text: string): Promise<LocalRepositoryFile> {
  const size = utf8Bytes(text);
  assertRepositoryFileBytes("text", size);
  const existing = await txStore<LocalRepositoryFile | undefined>("files", "readonly", (store) => store.get(fileKey(repoIdValue, path)));
  const currentHash = await sha256Text(text);
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
    size,
    updatedAt: new Date().toISOString(),
  };
  await pausePrimaryFileWriteForTests();
  await txStore("files", "readwrite", (store) => store.put(file), repoIdValue);
  return file;
}

export async function writeLocalBinary(repoIdValue: string, path: string, bytes: Uint8Array): Promise<LocalRepositoryFile> {
  assertRepositoryFileBytes("binary", bytes.byteLength);
  const existing = await txStore<LocalRepositoryFile | undefined>("files", "readonly", (store) => store.get(fileKey(repoIdValue, path)));
  const blob = new Blob([bytesToArrayBuffer(bytes)]);
  const currentHash = await sha256Bytes(bytes);
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
  await txStore("files", "readwrite", (store) => store.put(file), repoIdValue);
  return file;
}

export type LocalFileAtomicWrite =
  | { path: string; kind: "text"; text: string }
  | { path: string; kind: "binary"; bytes: Uint8Array };

/** Apply a prepared set of local file moves/updates in one IndexedDB transaction. */
export async function applyLocalFileChangesAtomically(
  repoIdValue: string,
  scope: RepositoryOperationScope,
  deletePaths: Iterable<string>,
  writes: LocalFileAtomicWrite[],
  expectedCurrentHashes: ReadonlyMap<string, string | null> = new Map(),
): Promise<void> {
  const meter = new RepositoryByteMeter("mutation");
  for (const write of writes) meter.add(write.kind, write.kind === "text" ? utf8Bytes(write.text) : write.bytes.byteLength);
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
    const currentHash = write.kind === "text" ? await sha256Text(write.text) : await sha256Bytes(write.bytes);
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
    const tx = guardedWriteTransaction(db, ["repositories", "files"], repoIdValue);
    const store = tx.objectStore("files");
    let pending = expectedCurrentHashes.size + 1;
    let validationError: Error | null = null;
    const apply = () => {
      for (const path of deletes) {
        const existing = originalsByPath.get(path);
        if (!existing) continue;
        if (existing.status === "new") store.delete(existing.key);
        else store.put({ ...existing, status: "deleted", committed: false, updatedAt: now });
      }
      for (const file of prepared) store.put(file);
    };
    const repositoryRequest = tx.objectStore("repositories").get(repoIdValue);
    repositoryRequest.onsuccess = () => {
      try { validateRepositoryOperation(repositoryRequest.result as LocalRepositoryMeta | undefined, scope); }
      catch (error) { validationError = error as Error; tx.abort(); return; }
      pending -= 1;
      if (!pending) apply();
    };
    repositoryRequest.onerror = () => tx.abort();
    for (const [path, expected] of expectedCurrentHashes) {
      const request = store.get(fileKey(repoIdValue, path));
      request.onsuccess = () => {
        const current = request.result as LocalRepositoryFile | undefined;
        const actual = !current || current.status === "deleted" ? null : current.currentHash;
        if (actual !== expected && !validationError) {
          validationError = new Error(`File changed since it was read: ${path}`);
          tx.abort();
          return;
        }
        pending -= 1;
        if (!pending && !validationError) apply();
      };
      request.onerror = () => {
        validationError = request.error ?? new Error(`Failed to validate ${path}.`);
        tx.abort();
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(validationError ?? transactionError(tx));
    tx.onabort = () => reject(validationError ?? transactionError(tx) ?? new Error("Local file transaction aborted."));
  });
}

export interface LocalTextFileMutation {
  path: string;
  /** undefined validates only, null deletes, and a string creates or updates. */
  content?: string | null;
  /** undefined skips validation, null requires absence, string requires this SHA-256. */
  expectedCurrentHash?: string | null;
}

async function applyLocalTextFileMutations(
  repoIdValue: string,
  scope: RepositoryOperationScope,
  mutations: LocalTextFileMutation[],
  commitMessage?: string,
): Promise<LocalCommit | null> {
  const meter = new RepositoryByteMeter("mutation");
  for (const mutation of mutations) if (typeof mutation.content === "string") meter.add("text", utf8Bytes(mutation.content));
  const paths = new Set<string>();
  for (const mutation of mutations) {
    if (paths.has(mutation.path)) throw new Error(`Duplicate local file mutation: ${mutation.path}`);
    paths.add(mutation.path);
  }
  const preparedHashes = new Map<string, string>();
  await Promise.all(mutations.map(async (mutation) => {
    if (typeof mutation.content === "string") preparedHashes.set(mutation.path, await sha256Text(mutation.content));
  }));

  const db = await openDb();
  return new Promise<LocalCommit | null>((resolve, reject) => {
    const tx = guardedWriteTransaction(db, commitMessage === undefined ? ["repositories", "files"] : ["repositories", "files", "commits"], repoIdValue);
    const store = tx.objectStore("files");
    const commitsStore = commitMessage === undefined ? null : tx.objectStore("commits");
    const repositoriesStore = tx.objectStore("repositories");
    const existing = new Map<string, LocalRepositoryFile | undefined>();
    let pending = mutations.length + 1;
    let validationError: Error | null = null;
    let localCommit: LocalCommit | null = null;
    let commitOrder: number | undefined;
    const now = new Date().toISOString();

    const apply = () => {
      for (const mutation of mutations) {
        const row = existing.get(mutation.path);
        const logicalRow = row?.status === "deleted" ? undefined : row;
        if (mutation.expectedCurrentHash !== undefined) {
          const actual = logicalRow?.currentHash ?? null;
          if (actual !== mutation.expectedCurrentHash) {
            validationError = new Error(`File changed since it was read: ${mutation.path}`);
            tx.abort();
            return;
          }
        }
      }
      const commitFiles: LocalCommitFile[] = [];
      for (const mutation of mutations) {
        if (mutation.content === undefined) continue;
        const row = existing.get(mutation.path);
        if (mutation.content === null) {
          if (!row || row.status === "deleted") continue;
          if (row.status === "new") store.delete(row.key);
          else {
            commitFiles.push({ path: mutation.path, status: "deleted", kind: row.kind, hash: row.currentHash });
            store.put({ ...row, status: "deleted", committed: commitMessage !== undefined, updatedAt: now });
          }
          continue;
        }
        const currentHash = preparedHashes.get(mutation.path)!;
        if (row?.status !== "deleted" && row?.currentHash === currentHash && row.status === "clean") continue;
        const status = statusAfterWrite(row, currentHash);
        const file: LocalRepositoryFile = {
          key: fileKey(repoIdValue, mutation.path),
          repoId: repoIdValue,
          path: mutation.path,
          kind: "text",
          text: mutation.content,
          baseSha: row?.baseSha,
          baseHash: row?.baseHash,
          currentHash,
          status,
          committed: commitMessage !== undefined && status !== "clean",
          size: new TextEncoder().encode(mutation.content).byteLength,
          updatedAt: now,
        };
        if (status !== "clean") {
          commitFiles.push({ path: mutation.path, status, kind: "text", hash: currentHash });
          if (commitMessage !== undefined) file.status = "clean";
        }
        store.put(file);
      }
      if (commitMessage !== undefined) {
        if (!commitFiles.length) {
          validationError = new Error("No local changes to commit.");
          tx.abort();
          return;
        }
        localCommit = {
          id: crypto.randomUUID(),
          repoId: repoIdValue,
          message: commitMessage,
          createdAt: now,
          order: commitOrder,
          files: commitFiles,
          pushed: false,
        };
        commitsStore!.put(localCommit);
      }
    };

    {
      const request = repositoriesStore.get(repoIdValue);
      request.onsuccess = () => {
        let repository: LocalRepositoryMeta;
        try { repository = validateRepositoryOperation(request.result as LocalRepositoryMeta | undefined, scope); }
        catch (error) { validationError = error as Error; tx.abort(); return; }
        if (commitMessage !== undefined) {
          commitOrder = (repository.nextCommitOrder ?? 0) + 1;
          repositoriesStore.put({ ...repository, nextCommitOrder: commitOrder });
        }
        pending -= 1;
        if (pending === 0) apply();
      };
      request.onerror = () => {
        validationError = request.error ?? new Error("Failed to allocate local commit order.");
        tx.abort();
      };
    }
    if (!pending) apply();
    for (const mutation of mutations) {
      const request = store.get(fileKey(repoIdValue, mutation.path));
      request.onsuccess = () => {
        existing.set(mutation.path, request.result as LocalRepositoryFile | undefined);
        pending -= 1;
        if (pending === 0) apply();
      };
      request.onerror = () => {
        validationError = request.error ?? new Error(`Failed to read ${mutation.path} during transaction.`);
        tx.abort();
      };
    }
    tx.oncomplete = () => resolve(localCommit);
    tx.onerror = () => reject(validationError ?? transactionError(tx) ?? new Error("Local file transaction failed."));
    tx.onabort = () => reject(validationError ?? transactionError(tx) ?? new Error("Local file transaction aborted."));
  });
}

/** Validate and apply text mutations in the same IndexedDB transaction. */
export async function mutateLocalTextFilesAtomically(repoIdValue: string, scope: RepositoryOperationScope, mutations: LocalTextFileMutation[]): Promise<void> {
  await applyLocalTextFileMutations(repoIdValue, scope, mutations);
}

/** Validate, apply, and commit only the changed mutation paths in one IndexedDB transaction. */
export async function mutateLocalTextFilesAndCreateCommitAtomically(
  repoIdValue: string,
  scope: RepositoryOperationScope,
  message: string,
  mutations: LocalTextFileMutation[],
): Promise<LocalCommit> {
  const commit = await applyLocalTextFileMutations(repoIdValue, scope, mutations, message);
  if (!commit) throw new Error("No local commit was created.");
  return commit;
}

export async function restoreLocalFilesAndDeleteCommit(
  repoIdValue: string,
  scope: RepositoryOperationScope,
  commitId: string,
  snapshots: Array<{ path: string; file: LocalRepositoryFile | null }>,
): Promise<LocalCommitSettlementResult> {
  const db = await openDb();
  return new Promise<LocalCommitSettlementResult>((resolve, reject) => {
    const tx = guardedWriteTransaction(db, ["repositories", "files", "commits"], repoIdValue);
    const files = tx.objectStore("files");
    const commits = tx.objectStore("commits");
    const current = new Map<string, LocalRepositoryFile | undefined>();
    let commit: LocalCommit | undefined;
    let pending = snapshots.length + 2;
    let validationError: Error | null = null;
    let result: LocalCommitSettlementResult = { skippedPaths: [] };

    const apply = () => {
      const committedByPath = new Map(commit?.files.map((file) => [file.path, file]) ?? []);
      const skippedPaths: string[] = [];
      for (const snapshot of snapshots) {
        const committedFile = committedByPath.get(snapshot.path);
        const row = current.get(snapshot.path);
        if (!committedFile || !localFileMatchesCommitResult(row, committedFile)) {
          skippedPaths.push(snapshot.path);
          continue;
        }
        if (snapshot.file) files.put(snapshot.file);
        else files.delete(fileKey(repoIdValue, snapshot.path));
      }
      commits.delete(commitId);
      result = { skippedPaths: skippedPaths.sort() };
    };

    const loaded = () => {
      pending -= 1;
      if (pending === 0) apply();
    };
    const commitRequest = commits.get(commitId);
    commitRequest.onsuccess = () => {
      commit = commitRequest.result as LocalCommit | undefined;
      if (!commit || commit.repoId !== repoIdValue) {
        validationError = new RepositoryOwnershipChangedError("The local commit does not belong to the scoped repository.");
        tx.abort();
        return;
      }
      loaded();
    };
    commitRequest.onerror = () => tx.abort();
    const repositoryRequest = tx.objectStore("repositories").get(repoIdValue);
    repositoryRequest.onsuccess = () => {
      try { validateRepositoryOperation(repositoryRequest.result as LocalRepositoryMeta | undefined, scope); loaded(); }
      catch (error) { validationError = error as Error; tx.abort(); }
    };
    repositoryRequest.onerror = () => tx.abort();
    for (const snapshot of snapshots) {
      const request = files.get(fileKey(repoIdValue, snapshot.path));
      request.onsuccess = () => {
        current.set(snapshot.path, request.result as LocalRepositoryFile | undefined);
        loaded();
      };
      request.onerror = () => tx.abort();
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(validationError ?? transactionError(tx));
    tx.onabort = () => reject(validationError ?? transactionError(tx) ?? new Error("Local rollback transaction aborted."));
  });
}

function localFileMatchesCommitResult(file: LocalRepositoryFile | undefined, committedFile: LocalCommitFile): boolean {
  if (!file || file.committed !== true || file.currentHash !== committedFile.hash || file.kind !== committedFile.kind) return false;
  return committedFile.status === "deleted" ? file.status === "deleted" : file.status === "clean";
}

export async function deleteLocalFile(repoIdValue: string, path: string): Promise<void> {
  const existing = await txStore<LocalRepositoryFile | undefined>("files", "readonly", (store) => store.get(fileKey(repoIdValue, path)));
  if (!existing) return;
  if (existing.status === "new") {
    await txStore("files", "readwrite", (store) => store.delete(fileKey(repoIdValue, path)), repoIdValue);
    return;
  }
  await txStore("files", "readwrite", (store) => store.put({ ...existing, status: "deleted", committed: false, updatedAt: new Date().toISOString() }), repoIdValue);
}

export async function deleteLocalFileAtomically(repoIdValue: string, scope: RepositoryOperationScope, path: string, expectedCurrentHash?: string): Promise<void> {
  await mutateLocalTextFilesAtomically(repoIdValue, scope, [{ path, content: null, expectedCurrentHash }]);
}

export async function renameLocalTextFileAtomically(input: {
  repoId: string;
  scope: RepositoryOperationScope;
  oldPath: string;
  newPath: string;
  content: string;
  expectedCurrentHash: string;
}): Promise<LocalRepositoryFile> {
  if (input.oldPath === input.newPath) throw new Error("Rename source and destination are identical.");
  await mutateLocalTextFilesAtomically(input.repoId, input.scope, [
    { path: input.oldPath, content: null, expectedCurrentHash: input.expectedCurrentHash },
    { path: input.newPath, content: input.content, expectedCurrentHash: null },
  ]);
  const file = await getLocalFile(input.repoId, input.newPath, input.scope);
  if (!file) throw new Error(`Renamed file is unavailable: ${input.newPath}`);
  return file;
}

export async function removeLocalFileEntry(repoIdValue: string, path: string): Promise<void> {
  await txStore("files", "readwrite", (store) => store.delete(fileKey(repoIdValue, path)), repoIdValue);
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

export async function getLocalRepositoryStatusSnapshot(owner: string, repo: string, branch: string, scope: string): Promise<{ meta: LocalRepositoryMeta; status: LocalRepoStatus } | null> {
  if (!isCurrentAccountScope(scope)) return null;
  const id = repoId(owner, repo, branch, scope);
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["repositories", "files", "commits"], "readonly");
    const repositoryRequest = tx.objectStore("repositories").get(id);
    const filesRequest = tx.objectStore("files").index("repoId").getAll(id);
    const commitsRequest = tx.objectStore("commits").index("repoId").getAll(id);
    let meta: LocalRepositoryMeta | undefined;
    let files: LocalRepositoryFile[] | undefined;
    let commits: LocalCommit[] | undefined;
    const finish = () => {
      if (!files || !commits || repositoryRequest.readyState !== "done") return;
      if (!meta || meta.accountScope !== scope || !isCurrentAccountScope(scope)) { resolve(null); return; }
      const status: LocalRepoStatus = { clean: 0, modified: 0, new: 0, deleted: 0, dirty: 0, ahead: commits.filter((commit) => !commit.pushed).length };
      for (const file of files) if (file.status === "clean" || !file.committed) status[file.status] += 1;
      status.dirty = status.modified + status.new + status.deleted;
      resolve({ meta, status });
    };
    repositoryRequest.onsuccess = () => { meta = repositoryRequest.result as LocalRepositoryMeta | undefined; finish(); };
    filesRequest.onsuccess = () => { files = filesRequest.result as LocalRepositoryFile[]; finish(); };
    commitsRequest.onsuccess = () => { commits = commitsRequest.result as LocalCommit[]; finish(); };
    repositoryRequest.onerror = filesRequest.onerror = commitsRequest.onerror = () => reject(tx.error ?? new Error("Local repository status could not be read."));
    tx.onabort = () => reject(tx.error ?? new Error("Local repository status transaction was aborted."));
  });
}

export async function addLocalRepoLog(repoIdValue: string, kind: LocalRepoLogKind, _message: string): Promise<void> {
  const entry: LocalRepoLogEntry = { id: crypto.randomUUID(), repoId: repoIdValue, kind, message: safeLegacyLogMessage(kind), createdAt: new Date().toISOString() };
  await txStore("logs", "readwrite", (store) => store.put(entry), repoIdValue);
}

export async function listLocalRepoLogs(repoIdValue: string, limit = 30): Promise<LocalRepoLogEntry[]> {
  const entries = await allFromIndex<LocalRepoLogEntry>("logs", "repoId", repoIdValue);
  return entries.map((entry) => ({ ...entry, message: safeLegacyLogMessage(entry.kind) })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

export function safeLegacyLogMessage(kind: LocalRepoLogKind): string {
  return kind === "error" ? "Repository operation failed." : `Repository ${kind} operation recorded.`;
}

function diagnosticBytes(record: LocalRepositoryDiagnostic): number {
  return new TextEncoder().encode(JSON.stringify(record)).byteLength;
}

function diagnosticRetryable(kind: RepositoryErrorKind): boolean {
  return ["network", "rate-limit", "abuse-limit", "service-unavailable", "permission-unverified", "abort"].includes(kind);
}

function diagnosticShaPrefix(value?: string): string | undefined {
  return value && /^[0-9a-f]{7,64}$/i.test(value) ? value.slice(0, 12) : undefined;
}

function diagnosticUuid(value: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : crypto.randomUUID();
}

export function repositoryDiagnosticFromError(error: unknown, operation: "read" | "update" | "compare" = "read"): Pick<LocalRepositoryDiagnostic, "errorKind" | "httpStatus" | "retryable"> {
  const classified = classifyRepositoryError(error, operation);
  return { errorKind: classified.kind, httpStatus: classified.status, retryable: diagnosticRetryable(classified.kind) };
}

export async function recordRepositoryDiagnostic(input: {
  repoId: string;
  scope: RepositoryOperationScope;
  operationId: string;
  operation: RepositoryDiagnosticOperation;
  localInstanceId: string;
  stage: RepositoryDiagnosticStage;
  outcome: RepositoryDiagnosticOutcome;
  startedAt: string;
  durationMs?: number;
  fileCount?: number;
  byteCount?: number;
  error?: unknown;
  errorOperation?: "read" | "update" | "compare";
  commitSha?: string;
}): Promise<LocalRepositoryDiagnostic> {
  const now = new Date().toISOString();
  const record: LocalRepositoryDiagnostic = {
    id: crypto.randomUUID(),
    schemaVersion: REPOSITORY_DIAGNOSTIC_SCHEMA_VERSION,
    operationId: diagnosticUuid(input.operationId),
    localInstanceId: diagnosticUuid(input.localInstanceId),
    operation: input.operation,
    stage: input.stage,
    outcome: input.outcome,
    createdAt: now,
    startedAt: input.startedAt,
    ...(Number.isFinite(input.durationMs) && input.durationMs! >= 0 ? { durationMs: Math.round(input.durationMs!) } : {}),
    ...(Number.isInteger(input.fileCount) && input.fileCount! >= 0 ? { fileCount: input.fileCount } : {}),
    ...(Number.isInteger(input.byteCount) && input.byteCount! >= 0 ? { byteCount: input.byteCount } : {}),
    ...(input.error ? repositoryDiagnosticFromError(input.error, input.errorOperation) : {}),
    ...(input.commitSha ? { commitShaPrefix: diagnosticShaPrefix(input.commitSha) } : {}),
  };
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = guardedWriteTransaction(db, ["repositories", "repositoryDiagnostics"], input.repoId);
    const diagnostics = tx.objectStore("repositoryDiagnostics");
    diagnostics.put(record);
    const request = diagnostics.index("localInstanceId").getAll(input.localInstanceId);
    request.onsuccess = () => {
      const rows = (request.result as LocalRepositoryDiagnostic[]).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      let bytes = rows.reduce((sum, row) => sum + diagnosticBytes(row), 0);
      for (const row of rows.slice(REPOSITORY_DIAGNOSTIC_MAX_RECORDS)) { diagnostics.delete(row.id); bytes -= diagnosticBytes(row); }
      for (const row of rows.slice(0, REPOSITORY_DIAGNOSTIC_MAX_RECORDS).reverse()) {
        if (bytes <= REPOSITORY_DIAGNOSTIC_MAX_BYTES) break;
        diagnostics.delete(row.id);
        bytes -= diagnosticBytes(row);
      }
    };
    request.onerror = () => tx.abort();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(transactionError(tx));
    tx.onabort = () => reject(transactionError(tx) ?? new Error("Repository diagnostic transaction aborted."));
  });
  return record;
}

export async function listRepositoryDiagnostics(repoIdValue: string, localInstanceId: string, scope: RepositoryOperationScope, limit = REPOSITORY_DIAGNOSTIC_MAX_RECORDS): Promise<LocalRepositoryDiagnostic[]> {
  const repository = await getLocalRepositoryById(repoIdValue, scope.accountIdentity);
  if (!repository || repository.localInstanceId !== localInstanceId) return [];
  const rows = await allFromIndex<LocalRepositoryDiagnostic>("repositoryDiagnostics", "localInstanceId", localInstanceId);
  return rows.filter((row) => row.schemaVersion === REPOSITORY_DIAGNOSTIC_SCHEMA_VERSION).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, limit);
}

export async function createLocalCommit(
  repoIdValue: string,
  scope: RepositoryOperationScope,
  message: string,
  allowedPaths?: ReadonlySet<string>,
  expectedCurrentHashes?: ReadonlyMap<string, string>,
): Promise<LocalCommit> {
  const db = await openDb();
  let validationError: Error | null = null;
  let commit: LocalCommit | null = null;
  await new Promise<void>((resolve, reject) => {
    const tx = guardedWriteTransaction(db, ["repositories", "files", "commits"], repoIdValue);
    const repoStore = tx.objectStore("repositories");
    const filesStore = tx.objectStore("files");
    const commitsStore = tx.objectStore("commits");
    const repoRequest = repoStore.get(repoIdValue);
    const dirtyRequest = filesStore.index("repoId").getAll(repoIdValue);
    let repository: LocalRepositoryMeta | undefined;
    let rows: LocalRepositoryFile[] | undefined;
    const apply = () => {
      if (!repository || !rows) return;
      const dirty = rows.filter((file) => file.status !== "clean" && !file.committed && (!allowedPaths || allowedPaths.has(file.path)));
      if (expectedCurrentHashes) {
        const actual = new Map(dirty.map((file) => [file.path, file.currentHash]));
        if (actual.size !== expectedCurrentHashes.size || [...expectedCurrentHashes].some(([path, hash]) => actual.get(path) !== hash)) {
          validationError = new Error("Local changes changed before they could be committed.");
          tx.abort();
          return;
        }
      }
      if (!dirty.length) {
        validationError = new Error("No local changes to commit.");
        tx.abort();
        return;
      }
      commit = {
        id: crypto.randomUUID(),
        repoId: repoIdValue,
        message,
        createdAt: new Date().toISOString(),
        order: (repository.nextCommitOrder ?? 0) + 1,
        files: dirty.map((file) => ({ path: file.path, status: file.status as Exclude<LocalFileStatus, "clean">, kind: file.kind, hash: file.currentHash })),
        pushed: false,
      };
      repoStore.put({ ...repository, nextCommitOrder: commit.order });
      commitsStore.put(commit);
      for (const file of dirty) {
        const next = file.status === "deleted"
          ? { ...file, committed: true, updatedAt: new Date().toISOString() }
          : { ...file, status: "clean" as const, committed: true, updatedAt: new Date().toISOString() };
        filesStore.put(next);
      }
    };
    repoRequest.onsuccess = () => {
      try { repository = validateRepositoryOperation(repoRequest.result as LocalRepositoryMeta | undefined, scope); }
      catch (error) { validationError = error as Error; tx.abort(); return; }
      apply();
    };
    repoRequest.onerror = () => {
      validationError = repoRequest.error ?? new Error("Failed to allocate local commit order.");
      tx.abort();
    };
    dirtyRequest.onsuccess = () => {
      rows = dirtyRequest.result as LocalRepositoryFile[];
      apply();
    };
    dirtyRequest.onerror = () => {
      validationError = dirtyRequest.error ?? new Error("Failed to read local changes.");
      tx.abort();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(validationError ?? transactionError(tx));
    tx.onabort = () => reject(validationError ?? transactionError(tx) ?? new Error("Local commit transaction aborted."));
  });
  return commit!;
}

export async function listUnpushedLocalCommits(repoIdValue: string): Promise<LocalCommit[]> {
  return (await allFromIndex<LocalCommit>("commits", "repoId", repoIdValue))
    .filter((commit) => !commit.pushed)
    .sort(compareLocalCommitOrder);
}

function compareLocalCommitOrder(a: LocalCommit, b: LocalCommit): number {
  if (a.order !== undefined && b.order !== undefined && a.order !== b.order) return a.order - b.order;
  if (a.order === undefined && b.order !== undefined) return -1;
  if (a.order !== undefined && b.order === undefined) return 1;
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

export async function discardUnpushedLocalCommits(repoIdValue: string): Promise<void> {
  const commits = await listUnpushedLocalCommits(repoIdValue);
  if (!commits.length) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = guardedWriteTransaction(db, "commits", repoIdValue);
    const store = tx.objectStore("commits");
    for (const commit of commits) store.delete(commit.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(transactionError(tx));
  });
}

export async function restoreUnpushedCommitsAsDirty(repoIdValue: string, scope: RepositoryOperationScope): Promise<LocalCommit[]> {
  const commits = await listUnpushedLocalCommits(repoIdValue);
  if (!commits.length) return [];
  const byPath = new Map<string, LocalCommitFile>();
  for (const commit of commits) for (const file of commit.files) byPath.set(file.path, file);
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = guardedWriteTransaction(db, ["repositories", "files", "commits"], repoIdValue);
    const filesStore = tx.objectStore("files");
    const commitsStore = tx.objectStore("commits");
    let validationError: Error | null = null;
    const repositoryRequest = tx.objectStore("repositories").get(repoIdValue);
    repositoryRequest.onsuccess = () => {
      try { validateRepositoryOperation(repositoryRequest.result as LocalRepositoryMeta | undefined, scope); }
      catch (error) { validationError = error as Error; tx.abort(); }
    };
    repositoryRequest.onerror = () => tx.abort();
    for (const file of byPath.values()) {
      const req = filesStore.get(fileKey(repoIdValue, file.path));
      req.onsuccess = () => {
        const row = req.result as LocalRepositoryFile | undefined;
        if (localFileMatchesCommitResult(row, file)) filesStore.put({ ...row, status: file.status, committed: false });
      };
    }
    for (const commit of commits) commitsStore.delete(commit.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(validationError ?? transactionError(tx));
    tx.onabort = () => reject(validationError ?? transactionError(tx) ?? new Error("Local commit restoration was aborted."));
  });
  return commits;
}

export async function createLocalRecoverySnapshot(repoIdValue: string, reason: string, scope: RepositoryOperationScope): Promise<LocalRepositoryRecovery> {
  assertRepositoryOperationScopeCurrent(scope);
  const db = await openDb();
  return new Promise<LocalRepositoryRecovery>((resolve, reject) => {
    const tx = guardedWriteTransaction(db, ["repositories", "files", "commits", "recoveries"], repoIdValue);
    const repositoryRequest = tx.objectStore("repositories").get(repoIdValue);
    const filesRequest = tx.objectStore("files").index("repoId").getAll(repoIdValue);
    const commitsRequest = tx.objectStore("commits").index("repoId").getAll(repoIdValue);
    let repository: LocalRepositoryMeta | undefined;
    let files: LocalRepositoryFile[] | undefined;
    let commits: LocalCommit[] | undefined;
    let recovery: LocalRepositoryRecovery | undefined;
    let validationError: Error | null = null;
    const apply = () => {
      if (!repository || !files || !commits || recovery) return;
      recovery = {
        id: crypto.randomUUID(),
        repoId: repoIdValue,
        accountIdentity: scope.accountIdentity,
        reason,
        createdAt: new Date().toISOString(),
        repository,
        files,
        commits: commits.filter((commit) => !commit.pushed).sort(compareLocalCommitOrder),
      };
      tx.objectStore("recoveries").put(recovery);
    };
    repositoryRequest.onsuccess = () => {
      repository = repositoryRequest.result as LocalRepositoryMeta | undefined;
      try { repository = validateRepositoryOperation(repository, scope); }
      catch (error) { validationError = error as Error; tx.abort(); return; }
      apply();
    };
    filesRequest.onsuccess = () => { files = filesRequest.result as LocalRepositoryFile[]; apply(); };
    commitsRequest.onsuccess = () => { commits = commitsRequest.result as LocalCommit[]; apply(); };
    repositoryRequest.onerror = filesRequest.onerror = commitsRequest.onerror = () => tx.abort();
    tx.oncomplete = () => resolve(recovery!);
    tx.onerror = () => reject(validationError ?? transactionError(tx));
    tx.onabort = () => reject(validationError ?? transactionError(tx) ?? new Error("Recovery snapshot transaction was aborted."));
  });
}

export async function listLocalRecoverySnapshots(repoIdValue: string, scope: string): Promise<LocalRepositoryRecovery[]> {
  if (!isCurrentAccountScope(scope)) return [];
  const recoveries = await allFromIndex<LocalRepositoryRecovery>("recoveries", "repoId", repoIdValue);
  if (!isCurrentAccountScope(scope)) return [];
  return recoveries
    .filter((recovery) => recovery.accountIdentity === scope && recovery.repository?.accountScope === scope)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function getLocalRecoverySnapshot(recoveryId: string, scope: string): Promise<LocalRepositoryRecovery | null> {
  if (!isCurrentAccountScope(scope)) return null;
  const recovery = await txStore<LocalRepositoryRecovery | undefined>("recoveries", "readonly", (store) => store.get(recoveryId));
  if (!isCurrentAccountScope(scope)) return null;
  return recovery?.accountIdentity === scope && recovery.repository?.accountScope === scope ? recovery : null;
}

export async function deleteLocalRecoverySnapshot(recoveryId: string, scope: string): Promise<void> {
  if (!isCurrentAccountScope(scope)) throw new Error("Recovery snapshot account identity is not current.");
  const expected = await txStore<LocalRepositoryRecovery | undefined>("recoveries", "readonly", (store) => store.get(recoveryId));
  if (!expected) throw new Error("Recovery snapshot is unavailable.");
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = guardedWriteTransaction(db, "recoveries", expected.repoId);
    const store = tx.objectStore("recoveries");
    let validationError: Error | null = null;
    const request = store.get(recoveryId);
    request.onsuccess = () => {
      const recovery = request.result as LocalRepositoryRecovery | undefined;
      if (!isCurrentAccountScope(scope) || recovery?.accountIdentity !== scope || recovery.repository?.accountScope !== scope) {
        validationError = new Error("Recovery snapshot is unavailable.");
        tx.abort();
        return;
      }
      store.delete(recoveryId);
    };
    request.onerror = () => tx.abort();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(validationError ?? transactionError(tx));
    tx.onabort = () => reject(validationError ?? transactionError(tx) ?? new Error("Recovery snapshot deletion was aborted."));
  });
}

export async function listLocalRecoverySnapshotsForTarget(owner: string, repo: string, branch: string, scope: string): Promise<LocalRepositoryRecovery[]> {
  if (!isCurrentAccountScope(scope)) return [];
  const rows = await txStore<LocalRepositoryRecovery[]>("recoveries", "readonly", (store) => store.getAll());
  if (!isCurrentAccountScope(scope)) return [];
  return rows
    .filter((recovery) => recovery.repository?.owner === owner && recovery.repository.repo === repo && recovery.repository.branch === branch
      && recovery.accountIdentity === scope && recovery.repository.accountScope === scope)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function restoreLocalRecoverySnapshot(recoveryId: string, scope: RepositoryOperationScope, target: { repoId: string; bookId: string; owner: string; repo: string; branch: string }): Promise<LocalRepositoryRecovery> {
  assertRepositoryOperationScopeCurrent(scope);
  const db = await openDb();
  return new Promise<LocalRepositoryRecovery>((resolve, reject) => {
    const tx = guardedWriteTransaction(db, ["repositories", "files", "commits", "recoveries"], target.repoId);
    const repositories = tx.objectStore("repositories");
    const files = tx.objectStore("files");
    const commits = tx.objectStore("commits");
    const recoveries = tx.objectStore("recoveries");
    let recovery: LocalRepositoryRecovery | undefined;
    let validationError: Error | null = null;
    const beginRestore = () => {
      const repoIdValue = recovery!.repoId;
      const clearByRepo = (store: IDBObjectStore, done: () => void) => {
        const cursorRequest = store.index("repoId").openKeyCursor(IDBKeyRange.only(repoIdValue));
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) { done(); return; }
          store.delete(cursor.primaryKey);
          cursor.continue();
        };
        cursorRequest.onerror = () => {
          validationError = cursorRequest.error ?? new Error("Failed to clear the current working copy.");
          tx.abort();
        };
      };
      let cleared = 0;
      const restore = () => {
        cleared += 1;
        if (cleared !== 2) return;
        repositories.put({ ...recovery!.repository, updatedAt: new Date().toISOString() });
        for (const file of recovery!.files) files.put(file);
        for (const commit of recovery!.commits) commits.put(commit);
      };
      clearByRepo(files, restore);
      clearByRepo(commits, restore);
    };
    const request = recoveries.get(recoveryId);
    request.onsuccess = () => {
      recovery = request.result as LocalRepositoryRecovery | undefined;
      if (!recovery?.repository || recovery.accountIdentity !== scope.accountIdentity || recovery.repository.accountScope !== scope.accountIdentity) {
        validationError = new Error("Recovery snapshot is unavailable or uses an unsupported legacy format.");
        tx.abort();
        return;
      }
      if (recovery.repoId !== target.repoId || recovery.repository.id !== target.repoId || recovery.repository.bookId !== target.bookId
        || recovery.repository.owner !== target.owner || recovery.repository.repo !== target.repo || recovery.repository.branch !== target.branch) {
        validationError = new Error("Recovery snapshot does not match the requested repository.");
        tx.abort();
        return;
      }
      const repositoryRequest = repositories.get(target.repoId);
      repositoryRequest.onsuccess = () => {
        const current = repositoryRequest.result as LocalRepositoryMeta | undefined;
        try { validateRepositoryOperation(current, scope); } catch (error) { validationError = error as Error; tx.abort(); return; }
        if (!current || current.id !== target.repoId || current.bookId !== target.bookId || current.owner !== target.owner || current.repo !== target.repo || current.branch !== target.branch) {
          validationError = new Error("The target repository identity changed before recovery restoration.");
          tx.abort();
          return;
        }
        beginRestore();
      };
      repositoryRequest.onerror = () => tx.abort();
    };
    request.onerror = () => {
      validationError = request.error ?? new Error("Failed to read recovery snapshot.");
      tx.abort();
    };
    tx.oncomplete = () => resolve(recovery!);
    tx.onerror = () => reject(validationError ?? transactionError(tx));
    tx.onabort = () => reject(validationError ?? transactionError(tx) ?? new Error("Recovery restoration was aborted."));
  });
}

export interface RemoteTreeFile {
  path: string;
  kind: LocalFileKind;
  text?: string;
  blob?: Blob;
  baseSha: string;
  size: number;
}

function localFileVersion(file: LocalRepositoryFile): string {
  return `${file.currentHash}:${file.status}:${Boolean(file.committed)}`;
}

function sameLocalFiles(expectedFiles: LocalRepositoryFile[], currentFiles: LocalRepositoryFile[]): boolean {
  const expected = new Map(expectedFiles.map((file) => [file.path, localFileVersion(file)]));
  const actual = new Map(currentFiles.map((file) => [file.path, localFileVersion(file)]));
  return expected.size === actual.size && [...expected].every(([path, value]) => actual.get(path) === value);
}

/** Replace the complete working tree, pending commits, and repository head in one transaction. */
export async function replaceLocalTreeAtomically(
  repoIdValue: string,
  scope: RepositoryOperationScope,
  remoteHeadSha: string,
  inputs: RemoteTreeFile[],
  expectedFiles: LocalRepositoryFile[],
  expectedCommitIds: string[],
  recoveryReason?: string,
  requireClean = false,
): Promise<LocalRepositoryRecovery> {
  assertRepositoryOperationScopeCurrent(scope);
  const now = new Date().toISOString();
  const prepared = await Promise.all(inputs.map(async (input): Promise<LocalRepositoryFile> => {
    const currentHash = input.kind === "text" ? await sha256Text(input.text ?? "") : await hashBlob(input.blob ?? new Blob());
    return {
      key: fileKey(repoIdValue, input.path), repoId: repoIdValue, path: input.path, kind: input.kind,
      text: input.text, blob: input.blob, baseSha: input.baseSha, baseHash: currentHash, currentHash,
      status: "clean", committed: false, size: input.size, updatedAt: now,
    };
  }));
  const db = await openDb();
  return new Promise<LocalRepositoryRecovery>((resolve, reject) => {
    const tx = guardedWriteTransaction(db, ["repositories", "files", "commits", "recoveries"], repoIdValue);
    const repositories = tx.objectStore("repositories");
    const files = tx.objectStore("files");
    const commits = tx.objectStore("commits");
    const recoveries = tx.objectStore("recoveries");
    let repository: LocalRepositoryMeta | undefined;
    let recovery: LocalRepositoryRecovery | undefined;
    let loaded = 0;
    let validationError: Error | null = null;
    const apply = () => {
      loaded += 1;
      if (loaded !== 3) return;
      recovery = {
        id: crypto.randomUUID(),
        repoId: repoIdValue,
        accountIdentity: scope.accountIdentity,
        reason: recoveryReason ?? `Before remote tree replacement to ${remoteHeadSha}`,
        createdAt: now,
        repository: repository!,
        files: expectedFiles,
        commits: currentCommits,
      };
      recoveries.put(recovery);
      repositories.put({ ...repository!, remoteHeadSha, remoteChanged: false, remoteStatus: "clean", remoteCheckedAt: now, remoteErrorKind: undefined, lastRemoteHead: remoteHeadSha, lastKnownChanged: false, cloneComplete: true, expectedFileCount: prepared.length, updatedAt: now, lastFetchAt: now });
      for (const file of prepared) files.put(file);
    };
    const repoRequest = repositories.get(repoIdValue);
    repoRequest.onsuccess = () => {
      repository = repoRequest.result as LocalRepositoryMeta | undefined;
      try { repository = validateRepositoryOperation(repository, scope); } catch (error) {
        validationError = error as Error;
        tx.abort();
        return;
      }
      if (!repository) {
        validationError = new Error("Local repository is not ready.");
        tx.abort();
        return;
      }
      apply();
    };
    repoRequest.onerror = () => tx.abort();
    const currentFilesRequest = files.index("repoId").getAll(repoIdValue);
    currentFilesRequest.onsuccess = () => {
      const current = currentFilesRequest.result as LocalRepositoryFile[];
      if (!sameLocalFiles(expectedFiles, current)) {
        validationError = new Error("The local working copy changed while the remote tree was downloading.");
        tx.abort();
        return;
      }
      if (requireClean && current.some((file) => file.status !== "clean" || file.committed)) {
        validationError = new Error("Pull requires a clean working copy; a local edit appeared while the remote tree was downloading.");
        tx.abort();
        return;
      }
      for (const file of current) files.delete(file.key);
      apply();
    };
    currentFilesRequest.onerror = () => tx.abort();
    let currentCommits: LocalCommit[] = [];
    const currentCommitsRequest = commits.index("repoId").getAll(repoIdValue);
    currentCommitsRequest.onsuccess = () => {
      const current = currentCommitsRequest.result as LocalCommit[];
      currentCommits = current.filter((commit) => !commit.pushed);
      const actualIds = current.filter((commit) => !commit.pushed).map((commit) => commit.id).sort();
      const expectedIds = [...expectedCommitIds].sort();
      if (actualIds.length !== expectedIds.length || actualIds.some((id, index) => id !== expectedIds[index])) {
        validationError = new Error("Local commits changed while the remote tree was downloading.");
        tx.abort();
        return;
      }
      for (const commit of current) commits.delete(commit.id);
      apply();
    };
    currentCommitsRequest.onerror = () => tx.abort();
    tx.oncomplete = () => resolve(recovery!);
    tx.onerror = () => reject(validationError ?? tx.error);
    tx.onabort = () => reject(validationError ?? tx.error ?? new Error("Remote tree replacement was aborted."));
  });
}

export async function applyRemoteMergeAtomically(input: {
  repoId: string;
  scope: RepositoryOperationScope;
  remoteHeadSha: string;
  expectedFiles: LocalRepositoryFile[];
  deletes: string[];
  writes: RemoteTreeFile[];
}): Promise<void> {
  const now = new Date().toISOString();
  const prepared = await Promise.all(input.writes.map(async (write): Promise<LocalRepositoryFile> => {
    const currentHash = write.kind === "text" ? await sha256Text(write.text ?? "") : await hashBlob(write.blob ?? new Blob());
    return {
      key: fileKey(input.repoId, write.path), repoId: input.repoId, path: write.path, kind: write.kind,
      text: write.text, blob: write.blob, baseSha: write.baseSha, baseHash: currentHash, currentHash,
      status: "clean", committed: false, size: write.size, updatedAt: now,
    };
  }));
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = guardedWriteTransaction(db, ["repositories", "files"], input.repoId);
    const repositories = tx.objectStore("repositories");
    const files = tx.objectStore("files");
    let validationError: Error | null = null;
    let repository: LocalRepositoryMeta | undefined;
    let currentFiles: LocalRepositoryFile[] | undefined;
    const apply = () => {
      if (!repository || !currentFiles) return;
      if (!sameLocalFiles(input.expectedFiles, currentFiles)) {
        validationError = new Error("The local working copy changed during repository sync.");
        tx.abort();
        return;
      }
      for (const path of input.deletes) files.delete(fileKey(input.repoId, path));
      for (const file of prepared) files.put(file);
      repositories.put({ ...repository, remoteHeadSha: input.remoteHeadSha, remoteChanged: false, remoteStatus: "clean", remoteCheckedAt: now, remoteErrorKind: undefined, lastRemoteHead: input.remoteHeadSha, lastKnownChanged: false, updatedAt: now, lastFetchAt: now });
    };
    const repoRequest = repositories.get(input.repoId);
    repoRequest.onsuccess = () => { try { repository = validateRepositoryOperation(repoRequest.result as LocalRepositoryMeta | undefined, input.scope); } catch (error) { validationError = error as Error; tx.abort(); return; } apply(); };
    repoRequest.onerror = () => tx.abort();
    const filesRequest = files.index("repoId").getAll(input.repoId);
    filesRequest.onsuccess = () => { currentFiles = filesRequest.result as LocalRepositoryFile[]; apply(); };
    filesRequest.onerror = () => tx.abort();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(validationError ?? tx.error);
    tx.onabort = () => reject(validationError ?? tx.error ?? new Error("Repository merge transaction was aborted."));
  });
}

export async function applyCloneRepairAtomically(input: {
  repoId: string;
  scope: RepositoryOperationScope;
  repairOperationId: string;
  expectedRemoteHeadSha: string;
  expectedFiles: LocalRepositoryFile[];
  writes: RemoteTreeFile[];
  deletePaths: string[];
  expectedFileCount: number;
}): Promise<void> {
  const now = new Date().toISOString();
  const prepared = await Promise.all(input.writes.map(async (write): Promise<LocalRepositoryFile> => {
    const currentHash = write.kind === "text" ? await sha256Text(write.text ?? "") : await hashBlob(write.blob ?? new Blob());
    return {
      key: fileKey(input.repoId, write.path), repoId: input.repoId, path: write.path, kind: write.kind,
      text: write.text, blob: write.blob, baseSha: write.baseSha, baseHash: currentHash, currentHash,
      status: "clean", committed: false, size: write.size, updatedAt: now,
    };
  }));
  const writePaths = new Set<string>();
  for (const file of prepared) {
    if (writePaths.has(file.path)) throw new Error(`Duplicate clone repair write: ${file.path}`);
    writePaths.add(file.path);
  }
  if (input.deletePaths.some((path) => writePaths.has(path))) throw new Error("Clone repair cannot write and delete the same path.");

  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = guardedWriteTransaction(db, ["repositories", "files"], input.repoId);
    const repositories = tx.objectStore("repositories");
    const files = tx.objectStore("files");
    let repository: LocalRepositoryMeta | undefined;
    let currentFiles: LocalRepositoryFile[] | undefined;
    let validationError: Error | null = null;
    const apply = () => {
      if (!repository || !currentFiles) return;
      if (repository.remoteHeadSha !== input.expectedRemoteHeadSha || repository.cloneComplete === true) {
        validationError = new Error("The local repository state changed during clone repair.");
        tx.abort();
        return;
      }
      if (!sameLocalFiles(input.expectedFiles, currentFiles)) {
        validationError = new Error("The local working copy changed during clone repair.");
        tx.abort();
        return;
      }
      for (const path of input.deletePaths) files.delete(fileKey(input.repoId, path));
      for (const file of prepared) files.put(file);
      repositories.put({ ...repository, remoteStatus: "clean", remoteCheckedAt: now, remoteErrorKind: undefined, lastRemoteHead: repository.remoteHeadSha, lastKnownChanged: false, remoteChanged: false, cloneComplete: true, cloneStatus: "complete", expectedFileCount: input.expectedFileCount, repairOperationId: undefined, repairOperationGeneration: undefined, lastRepairOperationId: input.repairOperationId, operationLease: undefined, updatedAt: now, lastFetchAt: now });
    };
    const repoRequest = repositories.get(input.repoId);
    repoRequest.onsuccess = () => {
      try { repository = validateRepairOperation(repoRequest.result as LocalRepositoryMeta | undefined, input.scope, input.repairOperationId); } catch (error) { validationError = error as Error; tx.abort(); return; }
      apply();
    };
    repoRequest.onerror = () => tx.abort();
    const filesRequest = files.index("repoId").getAll(input.repoId);
    filesRequest.onsuccess = () => { currentFiles = filesRequest.result as LocalRepositoryFile[]; apply(); };
    filesRequest.onerror = () => tx.abort();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(validationError ?? tx.error);
    tx.onabort = () => reject(validationError ?? tx.error ?? new Error("Clone repair transaction was aborted."));
  });
}

export async function settleLocalSourceOverwriteAtomically(input: {
  repoId: string;
  scope: RepositoryOperationScope;
  remoteHeadSha: string;
  expectedFiles: LocalRepositoryFile[];
  expectedCommitIds: string[];
  pushedShas: Record<string, string>;
}): Promise<LocalCommitSettlementResult> {
  const db = await openDb();
  return new Promise<LocalCommitSettlementResult>((resolve, reject) => {
    const tx = guardedWriteTransaction(db, ["repositories", "files", "commits"], input.repoId);
    const repositories = tx.objectStore("repositories");
    const files = tx.objectStore("files");
    const commits = tx.objectStore("commits");
    const now = new Date().toISOString();
    const skippedPaths: string[] = [];
    let validationError: Error | null = null;
    let repository: LocalRepositoryMeta | undefined;
    let currentFiles: LocalRepositoryFile[] | undefined;
    let loadedCommits = false;
    const apply = () => {
      if (!repository || !currentFiles || !loadedCommits) return;
      const currentByPath = new Map(currentFiles.map((file) => [file.path, file]));
      for (const expected of input.expectedFiles) {
        const current = currentByPath.get(expected.path);
        const unchanged = current && localFileVersion(current) === localFileVersion(expected);
        const pushedSha = input.pushedShas[expected.path];
        if (expected.status === "deleted") {
          if (unchanged) files.delete(expected.key);
          else if (current) {
            skippedPaths.push(expected.path);
            files.put({
              ...current,
              baseSha: undefined,
              baseHash: undefined,
              committed: current.committed,
              status: current.committed ? current.status : current.status === "deleted" ? "deleted" : "new",
              updatedAt: now,
            });
          }
        } else if (pushedSha) {
          if (unchanged) files.put({ ...current, baseSha: pushedSha, baseHash: expected.currentHash, committed: false, status: "clean", updatedAt: now });
          else if (current) {
            skippedPaths.push(expected.path);
            files.put({
              ...current,
              baseSha: pushedSha,
              baseHash: expected.currentHash,
              committed: current.committed,
              status: current.committed || current.currentHash === expected.currentHash ? "clean" : "modified",
              updatedAt: now,
            });
          } else {
            // The pushed path was deleted locally while the ref update was in flight.
            // Keep that deletion relative to the newly pushed remote blob.
            skippedPaths.push(expected.path);
            files.put({
              ...expected,
              baseSha: pushedSha,
              baseHash: expected.currentHash,
              committed: false,
              status: "deleted",
              updatedAt: now,
            });
          }
        }
      }
      repositories.put({ ...repository, remoteHeadSha: input.remoteHeadSha, remoteChanged: false, remoteStatus: "clean", remoteCheckedAt: now, remoteErrorKind: undefined, lastRemoteHead: input.remoteHeadSha, lastKnownChanged: false, updatedAt: now, lastFetchAt: now });
    };
    const repoRequest = repositories.get(input.repoId);
    repoRequest.onsuccess = () => { try { repository = validateRepositoryOperation(repoRequest.result as LocalRepositoryMeta | undefined, input.scope); } catch (error) { validationError = error as Error; tx.abort(); return; } apply(); };
    repoRequest.onerror = () => tx.abort();
    const filesRequest = files.index("repoId").getAll(input.repoId);
    filesRequest.onsuccess = () => { currentFiles = filesRequest.result as LocalRepositoryFile[]; apply(); };
    filesRequest.onerror = () => tx.abort();
    const commitsRequest = commits.index("repoId").getAll(input.repoId);
    commitsRequest.onsuccess = () => {
      const expectedIds = new Set(input.expectedCommitIds);
      for (const commit of commitsRequest.result as LocalCommit[]) if (expectedIds.has(commit.id)) commits.delete(commit.id);
      loadedCommits = true;
      apply();
    };
    commitsRequest.onerror = () => tx.abort();
    tx.oncomplete = () => resolve({ skippedPaths: [...new Set(skippedPaths)].sort() });
    tx.onerror = () => reject(validationError ?? tx.error);
    tx.onabort = () => reject(validationError ?? tx.error ?? new Error("Local-source settlement was aborted."));
  });
}

export async function markLocalCommitsPushed(repoIdValue: string, scope: RepositoryOperationScope, commitIds: string[], remoteHeadSha: string, pushedShas: Record<string, string | null>): Promise<LocalCommitSettlementResult> {
  const db = await openDb();
  return new Promise<LocalCommitSettlementResult>((resolve, reject) => {
    const tx = guardedWriteTransaction(db, ["repositories", "files", "commits"], repoIdValue);
    const repoStore = tx.objectStore("repositories");
    const fileStore = tx.objectStore("files");
    const commitStore = tx.objectStore("commits");
    const committedByPath = new Map<string, LocalCommitFile>();
    const commitsById = new Map<string, LocalCommit>();
    const skippedPaths: string[] = [];
    let validationError: Error | null = null;
    let pendingCommits = commitIds.length;
    const repoReq = repoStore.get(repoIdValue);
    repoReq.onsuccess = () => {
      try {
        const repo = validateRepositoryOperation(repoReq.result as LocalRepositoryMeta | undefined, scope);
        const now = new Date().toISOString();
        repoStore.put({ ...repo, remoteHeadSha, remoteChanged: false, remoteStatus: "clean", remoteCheckedAt: now, remoteErrorKind: undefined, lastRemoteHead: remoteHeadSha, lastKnownChanged: false, updatedAt: now, lastFetchAt: now });
      } catch (error) { validationError = error as Error; tx.abort(); }
    };

    const settleFiles = () => {
      for (const id of commitIds) {
        const commit = commitsById.get(id);
        if (commit) for (const file of commit.files) committedByPath.set(file.path, file);
      }
      for (const [path, sha] of Object.entries(pushedShas)) {
        const expected = committedByPath.get(path);
        const req = fileStore.get(fileKey(repoIdValue, path));
        req.onsuccess = () => {
          const file = req.result as LocalRepositoryFile | undefined;
          if (!expected || !file || !localFileMatchesCommitResult(file, expected)) {
            skippedPaths.push(path);
            if (!file || !expected) return;
            if (sha === null) {
              fileStore.put({ ...file, baseSha: undefined, baseHash: undefined, committed: false, status: file.status === "deleted" ? "deleted" : "new", updatedAt: new Date().toISOString() });
            } else {
              fileStore.put({ ...file, baseSha: sha, baseHash: expected.hash, committed: false, status: file.status === "deleted" ? "deleted" : "modified", updatedAt: new Date().toISOString() });
            }
            return;
          }
          if (sha === null) fileStore.delete(file.key);
          else fileStore.put({ ...file, baseSha: sha, baseHash: file.currentHash, committed: false, status: "clean", updatedAt: new Date().toISOString() });
        };
      }
    };

    if (!pendingCommits) settleFiles();
    for (const id of commitIds) {
      const req = commitStore.get(id);
      req.onsuccess = () => {
        const commit = req.result as LocalCommit | undefined;
        if (!commit || commit.repoId !== repoIdValue) {
          validationError = new RepositoryOwnershipChangedError("The local commit does not belong to the scoped repository.");
          tx.abort();
          return;
        }
        commitsById.set(id, commit);
        commitStore.put({ ...commit, pushed: true, remoteCommitSha: remoteHeadSha });
        pendingCommits -= 1;
        if (pendingCommits === 0) settleFiles();
      };
      req.onerror = () => tx.abort();
    }
    tx.oncomplete = () => resolve({ skippedPaths: [...new Set(skippedPaths)].sort() });
    tx.onerror = () => reject(validationError ?? tx.error);
    tx.onabort = () => reject(validationError ?? tx.error ?? new Error("Local push settlement transaction aborted."));
  });
}

export async function updateLocalRepositoryHead(repoIdValue: string, scope: RepositoryOperationScope, remoteHeadSha: string): Promise<void> {
  await updateLocalRepositoryMeta(repoIdValue, scope, (repo) => { const now = new Date().toISOString(); return { ...repo, remoteHeadSha, remoteChanged: false, remoteStatus: "clean", remoteCheckedAt: now, remoteErrorKind: undefined, lastRemoteHead: remoteHeadSha, lastKnownChanged: false, updatedAt: now, lastFetchAt: now }; });
}

export async function markLocalRepositoryCloneComplete(repoIdValue: string, scope: RepositoryOperationScope, cloneOperationId: string, expectedFileCount: number, remoteHeadSha?: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = guardedWriteTransaction(db, "repositories", repoIdValue);
    const store = tx.objectStore("repositories");
    let validationError: Error | null = null;
    const request = store.get(repoIdValue);
    request.onsuccess = () => {
      try {
        const repo = validateCloneOperation(request.result as LocalRepositoryMeta | undefined, scope, cloneOperationId);
        const now = new Date().toISOString();
        store.put({ ...repo, cloneComplete: true, cloneStatus: "complete", cloneOperationId: undefined, cloneOperationGeneration: undefined, lastCloneOperationId: cloneOperationId, operationLease: undefined, expectedFileCount, ...(remoteHeadSha ? { remoteHeadSha, remoteChanged: false, remoteStatus: "clean", remoteCheckedAt: now, remoteErrorKind: undefined, lastRemoteHead: remoteHeadSha, lastKnownChanged: false, lastFetchAt: now } : {}), updatedAt: now });
      } catch (error) { validationError = error as Error; tx.abort(); }
    };
    request.onerror = () => tx.abort();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(validationError ?? tx.error);
    tx.onabort = () => reject(validationError ?? tx.error ?? new Error("Local clone completion was aborted."));
  });
}

export async function markLocalRepositoryRemoteCheck(repoIdValue: string, scope: RepositoryOperationScope, remoteHeadSha: string, changed: boolean): Promise<void> {
  await updateLocalRepositoryMeta(repoIdValue, scope, (repo) => { const now = new Date().toISOString(); return { ...repo, remoteChanged: changed, remoteStatus: changed ? "changed" : "clean", remoteCheckedAt: now, remoteErrorKind: undefined, lastRemoteHead: remoteHeadSha, lastKnownChanged: changed, updatedAt: now, lastFetchAt: now, ...(changed ? {} : { remoteHeadSha }) }; });
}

export async function markLocalRepositoryRemoteChecking(repoIdValue: string, scope: RepositoryOperationScope): Promise<RemoteVerificationSnapshot> {
  let previous: RemoteVerificationSnapshot | undefined;
  await updateLocalRepositoryMeta(repoIdValue, scope, (repo) => {
    const status = effectiveRemoteStatus(repo);
    previous = { status: status === "checking" ? "unverified" : status, checkedAt: repo.remoteCheckedAt, errorKind: repo.remoteErrorKind };
    return { ...repo, remoteStatus: "checking", remoteErrorKind: undefined, updatedAt: new Date().toISOString(), ...(repo.remoteStatus ? {} : { lastKnownChanged: repo.remoteChanged ?? false }) };
  });
  return previous!;
}

export async function markLocalRepositoryRemoteFailure(repoIdValue: string, scope: RepositoryOperationScope, errorKind: RepositoryErrorKind, previous?: RemoteVerificationSnapshot): Promise<void> {
  const unavailable = errorKind === "service-unavailable" || errorKind === "network" || errorKind === "rate-limit" || errorKind === "abuse-limit";
  await updateLocalRepositoryMeta(repoIdValue, scope, (repo) => errorKind === "abort" && previous
    ? { ...repo, remoteStatus: previous.status, remoteCheckedAt: previous.checkedAt, remoteErrorKind: previous.errorKind, updatedAt: new Date().toISOString(), ...(repo.lastKnownChanged === undefined ? { lastKnownChanged: repo.remoteChanged ?? false } : {}) }
    : { ...repo, remoteStatus: unavailable ? "unavailable" : "unverified", remoteCheckedAt: new Date().toISOString(), remoteErrorKind: errorKind, updatedAt: new Date().toISOString(), ...(repo.lastKnownChanged === undefined ? { lastKnownChanged: repo.remoteChanged ?? false } : {}) });
}

export function effectiveRemoteStatus(repo: LocalRepositoryMeta): RemoteVerificationStatus {
  return repo.remoteStatus ?? (repo.remoteChanged ? "changed" : repo.lastFetchAt ? "clean" : "unverified");
}

async function updateLocalRepositoryMeta(repoIdValue: string, scope: RepositoryOperationScope, update: (repository: LocalRepositoryMeta) => LocalRepositoryMeta): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = guardedWriteTransaction(db, "repositories", repoIdValue);
    const store = tx.objectStore("repositories");
    let validationError: Error | null = null;
    const request = store.get(repoIdValue);
    request.onsuccess = () => {
      try { store.put(update(validateRepositoryOperation(request.result as LocalRepositoryMeta | undefined, scope))); }
      catch (error) { validationError = error as Error; tx.abort(); }
    };
    request.onerror = () => tx.abort();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(validationError ?? tx.error);
    tx.onabort = () => reject(validationError ?? tx.error ?? new Error("Local repository metadata transaction aborted."));
  });
}

function splitFrontmatter(raw: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match) return {};
  const title = /^title:\s*(.+)$/m.exec(match[1])?.[1]?.trim().replace(/^["']|["']$/g, "");
  const name = /^name:\s*(.+)$/m.exec(match[1])?.[1]?.trim().replace(/^["']|["']$/g, "");
  const description = /^description:\s*(.+)$/m.exec(match[1])?.[1]?.trim().replace(/^["']|["']$/g, "");
  const language = /^language:\s*(.+)$/m.exec(match[1])?.[1]?.trim().replace(/^["']|["']$/g, "");
  const ghostwriter = /^ghostwriter:\s*(.+)$/m.exec(match[1])?.[1]?.trim().replace(/^["']|["']$/g, "");
  const paragraph = /^paragraph:\s*(.+)$/m.exec(match[1])?.[1]?.trim().replace(/^["']|["']$/g, "");
  const known_from = /^known_from:\s*(.+)$/m.exec(match[1])?.[1]?.trim().replace(/^["']|["']$/g, "");
  const reveal_in = /^reveal_in:\s*(.+)$/m.exec(match[1])?.[1]?.trim().replace(/^["']|["']$/g, "");
  return { title, name, description, language, ghostwriter, paragraph, known_from, reveal_in };
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
  const paragraphPaths = allPaths.filter((path) => /^chapters\/[^/]+\/\d{3}(?:-[^/]+)?\.md$/.test(path));
  const paragraphArtifactPaths = allPaths.filter((path) =>
    /^(?:drafts\/[^/]+|chapters\/[^/]+\/drafts|scripts\/[^/]+)\/[^/]+\.md$/.test(path),
  );
  const artifactTargets: ParagraphArtifactTarget[] = paragraphPaths.map((path) => {
    const parts = path.split("/");
    const paragraphSlug = (parts.pop() ?? "").replace(/\.md$/i, "");
    return {
      path,
      chapterSlug: parts[1] ?? "",
      paragraphSlug,
      title: titleName(path, slugToTitle(paragraphSlug)),
    };
  });
  const artifactMetadata: Record<string, ParagraphArtifactMetadata> = Object.fromEntries(
    paragraphArtifactPaths.map((path) => {
      const fm = splitFrontmatter(textMap.get(path) ?? "");
      const title = (typeof fm.title === "string" && fm.title) || (typeof fm.name === "string" && fm.name) || undefined;
      const paragraph = typeof fm.paragraph === "string" ? fm.paragraph : undefined;
      return [path, { title, paragraph }];
    }),
  );
  const draftPaths = resolveParagraphArtifactPaths("draft", allPaths, artifactTargets, artifactMetadata);
  const scriptPaths = resolveParagraphArtifactPaths("script", allPaths, artifactTargets, artifactMetadata);
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
      const frontmatter = splitFrontmatter(textMap.get(p) ?? "");
      return {
        path: p,
        sha: file?.baseSha ?? file?.currentHash ?? "",
        size: file?.size ?? 0,
        name: titleName(p, slugToTitle(slug)),
        imagePath: firstExistingImage(assetBase),
        knownFrom: typeof frontmatter.known_from === "string" && frontmatter.known_from ? frontmatter.known_from : undefined,
        revealIn: typeof frontmatter.reveal_in === "string" && frontmatter.reveal_in ? frontmatter.reveal_in : undefined,
      };
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
      const paragraphFm = splitFrontmatter(textMap.get(p) ?? "");
      const evaluationPath = `evaluations/paragraphs/${slug}/${paragraphSlug}.md`;
      const auditPath = buildParagraphAuditPath(slug, paragraphSlug);
      const imagePromptPath = `assets/chapters/${slug}/paragraphs/${paragraphSlug}/primary.md`;
      return {
        number: num,
        title: titleName(p, slugToTitle(filename.replace(/\.md$/, ""))),
        path: p,
        revision: files.find((file) => file.path === p)?.currentHash,
        ghostwriter: typeof paragraphFm.ghostwriter === "string" && paragraphFm.ghostwriter ? paragraphFm.ghostwriter : undefined,
        draftPath: draftPaths.get(p),
        scriptPath: scriptPaths.get(p),
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
    rootFiles: files
      .filter((file) => !file.path.includes("/") && file.path.endsWith(".md"))
      .map((file) => ({ path: file.path, sha: file.baseSha ?? file.currentHash, size: file.size })),
    firstClassFiles: files
      .filter((file) => ["context.md", "ideas.md", "story-design.md", "notes.md", "promoted.md", "evaluation-guidelines.md", "state/current.md", "state/status.md", "state/script-ledger.md", "resumes/total.md", "evaluations/total.md"].includes(file.path))
      .map((file) => ({ path: file.path, sha: file.baseSha ?? file.currentHash, size: file.size })),
    searchableFiles: files
      .filter((file) => file.kind === "text" && /\.(md|txt)$/i.test(file.path))
      .map((file) => ({ path: file.path, sha: file.baseSha ?? file.currentHash, size: file.size, role: file.path.startsWith("research/") ? "research" : file.path.startsWith("notes/") || file.path === "notes.md" ? "note" : file.path.startsWith("chapters/") ? "chapter or paragraph" : "repository text" })),
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
    operationManifestFiles: files
      .filter((file) => isRewriteOperationManifestPath(file.path))
      .map((file) => ({ path: file.path, sha: file.baseSha ?? file.currentHash, size: file.size, content: file.kind === "text" ? file.text : undefined })),
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
