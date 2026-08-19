import JSZip from "jszip";
import { legacyEmailAccountIdentity } from "@/auth/accountIdentity";
import { useAuthStore } from "@/store/authStore";
import { assertRepositoryOperationScopeCurrent, captureRepositoryOperationScope, RepositoryOwnershipChangedError, type RepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { clearRewriteMaintenanceCompletion, clearRewriteMaintenanceTombstone, finalizeLocalRewriteMaintenanceTombstone, fenceAndRemoveLocalRewriteOperationsForMaintenance, getRewriteMaintenanceCompletion, getRewriteMaintenanceTombstone, listLocalRewriteOperationsForMaintenance, type ExpectedRewriteMaintenanceRecord } from "@/repository/localRewriteOperationStore";
import type { RewriteOperationManifest } from "@/narrarium/rewriteFromReaderFeedback";
import { listRepositoryDiagnostics, type LocalCommit, type LocalRepoLogEntry, type LocalRepositoryDiagnostic, type LocalRepositoryFile, type LocalRepositoryMeta, type LocalRepositoryRecovery, type LocalRepoStatus } from "@/repository/localRepository";

const DB_NAME = "narrarium-local-repositories";
const RECEIPT_PREFIX = "narrarium:backup-receipt:";
const RECEIPT_TTL_MS = 10 * 60_000;
export const MAINTENANCE_BACKUP_SCHEMA = "narrarium-maintenance-backup/v1" as const;

export type MaintenanceLifecycle = "complete" | "cloning" | "repair-required" | "repairing" | "migrating" | "legacy-unverified" | "journal-failed";
export type MaintenanceErrorCode = "ACCOUNT_MISMATCH" | "TARGET_MISMATCH" | "NOT_FOUND" | "BACKUP_REQUIRED" | "BACKUP_STALE" | "CONFIRMATION_REQUIRED" | "ACTIVE_LIFECYCLE" | "RECLONE_REQUIRES_REMOVAL" | "REMOVAL_PENDING";

export class RepositoryMaintenanceError extends Error {
  constructor(readonly code: MaintenanceErrorCode) { super(code); this.name = "RepositoryMaintenanceError"; }
}

export interface RepositoryMaintenanceTarget { bookId: string; owner: string; repo: string; branch: string; accountIdentity: string; repoId?: string; }

export interface BackupReceipt {
  schemaVersion: 1;
  receiptId: string;
  sessionNonce: string;
  accountIdentity: string;
  repoId: string;
  localInstanceId: string;
  operationFence: number;
  snapshotDigest: string;
  primaryDigest: string;
  rewriteDigest: string;
  primarySnapshot: string;
  rewriteSnapshot: string;
  rewriteRecords: ExpectedRewriteMaintenanceRecord[];
  counts: { files: number; commits: number; recoveries: number; rewrites: number };
  bytes: number;
  createdAt: string;
}

export interface RepositoryMaintenanceSnapshot {
  target: RepositoryMaintenanceTarget;
  repository: LocalRepositoryMeta | null;
  lifecycle: MaintenanceLifecycle | null;
  files: LocalRepositoryFile[];
  dirtyFiles: LocalRepositoryFile[];
  commits: LocalCommit[];
  unpushedCommits: LocalCommit[];
  logs: LocalRepoLogEntry[];
  diagnostics: LocalRepositoryDiagnostic[];
  recoveries: LocalRepositoryRecovery[];
  rewriteOperations: RewriteOperationManifest[];
  rewriteOperationCount: number;
  status: LocalRepoStatus;
  legacyCopies: LocalRepositoryMeta[];
  hasUserWork: boolean;
  activeLifecycle: boolean;
  removalPending: boolean;
  digest: string;
}

interface RemovalJournal {
  repoId: string;
  journalId: string;
  accountIdentity: string;
  bookId: string;
  owner: string;
  repo: string;
  branch: string;
  localInstanceId: string;
  snapshotDigest: string;
  primaryDigest: string;
  rewriteDigest: string;
  rewriteSnapshot: string;
  rewriteCount: number;
  rewriteRecords: ExpectedRewriteMaintenanceRecord[];
  receiptId: string;
  observedFence: number;
  removalFence: number;
  recoveriesPreserved: number;
  rewriteOperationsRemoved: number;
  primaryCounts: BackupReceipt["counts"];
  recoveryRecords: Array<{ id: string; digest: string }>;
  phase: "prepared" | "rewrites-fenced" | "primary-deleted" | "finalizing" | "finalized";
  createdAt: string;
}

interface RemovalCompletion {
  repoId: string;
  journalId: string;
  localInstanceId: string;
  accountIdentity: string;
  bookId: string;
  owner: string;
  repo: string;
  branch: string;
  receiptId: string;
  snapshotDigest: string;
  primaryDigest: string;
  rewriteDigest: string;
  rewriteCount: number;
  rewriteRecords: Array<{ operationId: string; hash: string }>;
  recoveriesPreserved: number;
  primaryCounts: BackupReceipt["counts"];
  recoveryRecords: Array<{ id: string; digest: string }>;
  rewriteCompleted: boolean;
  phase: "finalizing" | "finalized";
  completedAt: string;
}

export interface MaintenanceBackupManifest {
  schema: typeof MAINTENANCE_BACKUP_SCHEMA;
  createdAt: string;
  accountIdentityHash: string;
  snapshotDigest: string;
  repository: Omit<LocalRepositoryMeta, "accountScope" | "operationLease"> & { accountIdentityHash: string };
  lifecycle: MaintenanceLifecycle;
  counts: BackupReceipt["counts"];
  files: Array<Omit<LocalRepositoryFile, "blob" | "text"> & { contentPath?: string }>;
  commits: LocalCommit[];
  recoveries: Array<Omit<LocalRepositoryRecovery, "files" | "commits" | "repository" | "accountIdentity"> & { repository: MaintenanceBackupManifest["repository"]; files: MaintenanceBackupManifest["files"]; commits: LocalCommit[] }>;
  rewriteOperations: RewriteOperationManifest[];
  logs: Array<Pick<LocalRepoLogEntry, "kind" | "message" | "createdAt">>;
  restoreContract: { format: "zip"; manifestPath: "manifest.json"; contentRoot: "content/"; deletedFilesMayOmitContent: true; validation: "snapshotDigest" };
}

interface MigrationJournalRow { oldRepoId: string; newRepoId: string; bookId: string; immutableAccountIdentity: string; }

let crashPhase: "after-prepare" | "before-rewrite-transaction" | "after-rewrite-marker" | "after-rewrite-phase-update" | "after-rewrites" | "after-primary" | "after-rewrite-finalize" | "after-primary-marker" | "after-final-cleanup" | "after-finalized" | null = null;
export function crashNextMaintenanceRemovalForTests(phase: typeof crashPhase): void { crashPhase = phase; }
function simulateCrash(phase: Exclude<typeof crashPhase, null>): void { if (crashPhase === phase) { crashPhase = null; throw new Error(`Simulated maintenance removal crash ${phase}.`); } }

function scopedRepoId(target: RepositoryMaintenanceTarget): string { return `${target.accountIdentity}::${target.owner}/${target.repo}#${target.branch}`.toLowerCase(); }
function lifecycle(repository: LocalRepositoryMeta, journalFailed: boolean): MaintenanceLifecycle {
  if (journalFailed) return "journal-failed";
  if (repository.cloneStatus === "cloning") return "cloning";
  if (repository.cloneStatus === "repair-required") return "repair-required";
  if (repository.cloneStatus === "repairing") return "repairing";
  if (repository.cloneStatus === "migrating") return "migrating";
  if (repository.cloneComplete === undefined) return "legacy-unverified";
  return repository.cloneComplete === true ? "complete" : "repair-required";
}
function status(files: LocalRepositoryFile[], commits: LocalCommit[]): LocalRepoStatus {
  const result: LocalRepoStatus = { clean: 0, modified: 0, new: 0, deleted: 0, dirty: 0, ahead: commits.filter((commit) => !commit.pushed).length };
  for (const file of files) result[file.status] += 1;
  result.dirty = result.modified + result.new + result.deleted;
  return result;
}
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function fileDigest(file: LocalRepositoryFile) { return { path: file.path, kind: file.kind, baseSha: file.baseSha, baseHash: file.baseHash, currentHash: file.currentHash, status: file.status, committed: Boolean(file.committed), size: file.size }; }
function sanitizedRepository(repository: LocalRepositoryMeta, accountIdentityHash: string): MaintenanceBackupManifest["repository"] {
  const { accountScope: _accountScope, operationLease: _operationLease, accountIdentity: _accountIdentity, ...safe } = repository as LocalRepositoryMeta & { accountIdentity?: string };
  return { ...safe, accountIdentityHash };
}
async function primarySnapshotDigest(input: { repository: LocalRepositoryMeta; lifecycle: MaintenanceLifecycle; files: LocalRepositoryFile[]; commits: LocalCommit[]; recoveries: LocalRepositoryRecovery[] }): Promise<string> {
  return sha256(primarySnapshotComponent(input));
}
function primarySnapshotComponent(input: { repository: LocalRepositoryMeta; lifecycle: MaintenanceLifecycle; files: LocalRepositoryFile[]; commits: LocalCommit[]; recoveries: LocalRepositoryRecovery[] }): string { return stable({ repository: { ...input.repository, accountScope: undefined }, lifecycle: input.lifecycle, files: input.files.map(fileDigest).sort((a, b) => a.path.localeCompare(b.path)), commits: input.commits, recoveries: input.recoveries.map((recovery) => ({ id: recovery.id, reason: recovery.reason, createdAt: recovery.createdAt, repository: { id: recovery.repository.id, localInstanceId: recovery.repository.localInstanceId, operationFence: recovery.repository.operationFence }, files: recovery.files.map(fileDigest).sort((a, b) => a.path.localeCompare(b.path)), commits: recovery.commits })) }); }
function rewriteSnapshotComponent(rewrites: RewriteOperationManifest[]): string { return stable(rewrites); }
async function rewriteSnapshotDigest(rewrites: RewriteOperationManifest[]): Promise<string> { return sha256(rewriteSnapshotComponent(rewrites)); }
function recoverySnapshotComponent(recovery: LocalRepositoryRecovery): string { return stable({ id: recovery.id, repoId: recovery.repoId, accountIdentity: recovery.accountIdentity, reason: recovery.reason, createdAt: recovery.createdAt, repository: { id: recovery.repository.id, localInstanceId: recovery.repository.localInstanceId, accountScope: recovery.repository.accountScope, bookId: recovery.repository.bookId, owner: recovery.repository.owner, repo: recovery.repository.repo, branch: recovery.repository.branch, operationFence: recovery.repository.operationFence }, files: recovery.files.map(fileDigest).sort((a, b) => a.path.localeCompare(b.path)), commits: recovery.commits }); }
function recoveryRecordsDigest(recoveries: LocalRepositoryRecovery[]): Array<{ id: string; digest: string }> { return recoveries.map((recovery) => ({ id: recovery.id, digest: recoverySnapshotComponent(recovery) })); }
async function openPrimary(): Promise<IDBDatabase> { return new Promise((resolve, reject) => { const request = indexedDB.open(DB_NAME); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }

export async function lookupRepositoryMaintenanceTarget(target: RepositoryMaintenanceTarget): Promise<RepositoryMaintenanceSnapshot> {
  const scope = captureRepositoryOperationScope();
  if (!target.accountIdentity || scope.accountIdentity !== target.accountIdentity) throw new RepositoryMaintenanceError("ACCOUNT_MISMATCH");
  const exactId = scopedRepoId(target);
  if (target.repoId && target.repoId !== exactId) throw new RepositoryMaintenanceError("TARGET_MISMATCH");
  const db = await openPrimary();
    const stores = ["repositories", "files", "commits", "logs", "repositoryDiagnostics", "recoveries", "migrationJournals", "removalJournals", "maintenanceTombstones", "maintenanceCompletions"].filter((name) => db.objectStoreNames.contains(name));
  const result = await new Promise<Omit<RepositoryMaintenanceSnapshot, "diagnostics" | "rewriteOperations" | "rewriteOperationCount" | "hasUserWork" | "digest">>((resolve, reject) => {
    const tx = db.transaction(stores, "readonly");
    const repositories = tx.objectStore("repositories");
     const requests = { repository: repositories.get(exactId), candidates: repositories.index("remote").getAll(IDBKeyRange.only([target.owner, target.repo, target.branch])), files: tx.objectStore("files").index("repoId").getAll(exactId), commits: tx.objectStore("commits").index("repoId").getAll(exactId), logs: tx.objectStore("logs").index("repoId").getAll(exactId), recoveries: tx.objectStore("recoveries").index("repoId").getAll(exactId), migrations: tx.objectStore("migrationJournals").getAll(), removals: tx.objectStore("removalJournals").getAll(), tombstone: tx.objectStore("maintenanceTombstones").get(exactId), completion: tx.objectStore("maintenanceCompletions").get(exactId) };
    let validationError: Error | null = null;
    tx.oncomplete = () => {
      try { assertRepositoryOperationScopeCurrent(scope); } catch (error) { reject(error); return; }
       const repository = requests.repository.result as LocalRepositoryMeta | undefined;
       const removals = requests.removals.result as RemovalJournal[];
        const tombstone = requests.tombstone.result as { repoId?: string; journalId?: string; localInstanceId?: string; accountIdentity?: string; bookId?: string; owner?: string; repo?: string; branch?: string } | undefined;
        const completion = requests.completion.result as RemovalCompletion | undefined;
        const removal = removals.find((candidate) => candidate.repoId === exactId && candidate.accountIdentity === target.accountIdentity && candidate.bookId === target.bookId && candidate.owner === target.owner && candidate.repo === target.repo && candidate.branch === target.branch)
          ?? (tombstone && tombstone.accountIdentity === target.accountIdentity && tombstone.bookId === target.bookId && tombstone.owner === target.owner && tombstone.repo === target.repo && tombstone.branch === target.branch ? tombstone as RemovalJournal : undefined);
        if (removals.some((candidate) => candidate.repoId === exactId && (candidate.accountIdentity !== target.accountIdentity || candidate.bookId !== target.bookId || candidate.owner !== target.owner || candidate.repo !== target.repo || candidate.branch !== target.branch))) { reject(new RepositoryMaintenanceError("TARGET_MISMATCH")); return; }
        if (tombstone && (tombstone.accountIdentity !== target.accountIdentity || tombstone.bookId !== target.bookId || tombstone.owner !== target.owner || tombstone.repo !== target.repo || tombstone.branch !== target.branch)) { reject(new RepositoryMaintenanceError("TARGET_MISMATCH")); return; }
        if (completion && (!completionMatchesTarget(completion, target) || !completionEvidenceIsExact(completion))) { reject(new RepositoryMaintenanceError("TARGET_MISMATCH")); return; }
       if (repository && (repository.id !== exactId || repository.accountScope !== target.accountIdentity || repository.bookId !== target.bookId || repository.owner !== target.owner || repository.repo !== target.repo || repository.branch !== target.branch || (removal && removal.localInstanceId !== repository.localInstanceId))) { reject(new RepositoryMaintenanceError("TARGET_MISMATCH")); return; }
      const files = (requests.files.result as LocalRepositoryFile[]).sort((a, b) => a.path.localeCompare(b.path));
      const commits = (requests.commits.result as LocalCommit[]).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const logs = (requests.logs.result as LocalRepoLogEntry[]).map((entry) => ({ ...entry, message: `Repository ${entry.kind} operation recorded.` })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const recoveries = requests.recoveries.result as LocalRepositoryRecovery[];
        const recoveryInstanceId = repository?.localInstanceId ?? completion?.localInstanceId;
        const scopedRecoveries = recoveries.filter((recovery) => recovery.accountIdentity === target.accountIdentity && recovery.repoId === exactId && recovery.repository?.id === exactId && (!recoveryInstanceId || recovery.repository?.localInstanceId === recoveryInstanceId) && recovery.repository?.accountScope === target.accountIdentity && recovery.repository?.bookId === target.bookId && recovery.repository?.owner === target.owner && recovery.repository?.repo === target.repo && recovery.repository?.branch === target.branch);
        scopedRecoveries.sort((a, b) => a.id.localeCompare(b.id));
      const journalFailed = (requests.migrations.result as MigrationJournalRow[]).some((journal) => journal.newRepoId === exactId && journal.bookId === target.bookId && journal.immutableAccountIdentity === target.accountIdentity);
      const user = useAuthStore.getState().user;
      const legacyIdentity = user ? legacyEmailAccountIdentity(user) : "";
      const legacyCopies = (requests.candidates.result as LocalRepositoryMeta[]).filter((candidate) => candidate.id !== exactId && candidate.accountScope === legacyIdentity && candidate.bookId === target.bookId);
         resolve({ target: { ...target, repoId: exactId }, repository: repository ?? null, lifecycle: removal || (completion && completion.phase !== "finalized") ? "journal-failed" : repository ? lifecycle(repository, journalFailed) : null, files, dirtyFiles: files.filter((file) => file.status !== "clean" && !file.committed), commits, unpushedCommits: commits.filter((commit) => !commit.pushed), logs, recoveries: scopedRecoveries, status: status(files, commits), legacyCopies, activeLifecycle: Boolean(repository?.operationLease), removalPending: Boolean(removal || (completion && completion.phase !== "finalized")) });
    };
     for (const request of Object.values(requests)) request.onerror = () => { validationError = request.error; tx.abort(); };
    tx.onerror = () => reject(validationError ?? tx.error); tx.onabort = () => reject(validationError ?? tx.error ?? new Error("Repository maintenance read was aborted."));
  });
  db.close();
  assertRepositoryOperationScopeCurrent(scope);
  const rewriteOperations = await listLocalRewriteOperationsForMaintenance(exactId, scope);
  const rewriteTombstone = await getRewriteMaintenanceTombstone(exactId, target.accountIdentity);
  const primaryCompletion = await existingRemovalCompletion(exactId);
  const hasUserWork = result.status.dirty > 0 || result.unpushedCommits.length > 0 || result.recoveries.length > 0 || rewriteOperations.length > 0;
  const primaryDigest = result.repository && result.lifecycle ? await primarySnapshotDigest({ repository: result.repository, lifecycle: result.lifecycle, files: result.files, commits: result.commits, recoveries: result.recoveries }) : "";
  const rewriteDigest = await rewriteSnapshotDigest(rewriteOperations);
  const digest = primaryDigest ? await sha256(`${primaryDigest}:${rewriteDigest}`) : "";
    const diagnostics = result.repository ? await listRepositoryDiagnostics(exactId, result.repository.localInstanceId, scope) : [];
    return { ...result, diagnostics, rewriteOperations, rewriteOperationCount: rewriteOperations.length, hasUserWork, removalPending: result.removalPending || Boolean(rewriteTombstone) || Boolean(primaryCompletion && primaryCompletion.phase !== "finalized"), digest };
}

function safeSegment(value: string): string { return encodeURIComponent(value).replace(/%2F/gi, "%252F"); }
async function addFileContent(zip: JSZip, root: string, files: LocalRepositoryFile[]): Promise<MaintenanceBackupManifest["files"]> {
  return Promise.all(files.map(async (file, index) => {
    const contentPath = (file.kind === "binary" ? !file.blob : file.text === undefined) ? undefined : `${root}/${String(index).padStart(6, "0")}-${safeSegment(file.path)}`;
    if (contentPath) zip.file(contentPath, file.kind === "text" ? file.text! : file.blob!);
    const { blob: _blob, text: _text, ...metadata } = file;
    return { ...metadata, contentPath };
  }));
}

export async function createMaintenanceBackupBundle(target: RepositoryMaintenanceTarget): Promise<{ blob: Blob; receipt: BackupReceipt; manifest: MaintenanceBackupManifest }> {
  const snapshot = await lookupRepositoryMaintenanceTarget(target);
  if (!snapshot.repository || !snapshot.lifecycle) throw new RepositoryMaintenanceError("NOT_FOUND");
  const accountIdentityHash = await sha256(target.accountIdentity);
  const zip = new JSZip();
  const files = await addFileContent(zip, "content/repository", snapshot.files);
  const repository = sanitizedRepository(snapshot.repository, accountIdentityHash);
  const recoveries = await Promise.all(snapshot.recoveries.map(async (recovery) => ({ id: recovery.id, repoId: recovery.repoId, reason: recovery.reason, createdAt: recovery.createdAt, repository: sanitizedRepository(recovery.repository, accountIdentityHash), files: await addFileContent(zip, `content/recoveries/${safeSegment(recovery.id)}`, recovery.files), commits: recovery.commits })));
  const draft: MaintenanceBackupManifest = { schema: MAINTENANCE_BACKUP_SCHEMA, createdAt: new Date().toISOString(), accountIdentityHash, snapshotDigest: snapshot.digest, repository, lifecycle: snapshot.lifecycle, counts: { files: files.length, commits: snapshot.commits.length, recoveries: recoveries.length, rewrites: snapshot.rewriteOperations.length }, files, commits: snapshot.commits, recoveries, rewriteOperations: snapshot.rewriteOperations, logs: snapshot.logs.map(({ kind, message, createdAt }) => ({ kind, message, createdAt })), restoreContract: { format: "zip", manifestPath: "manifest.json", contentRoot: "content/", deletedFilesMayOmitContent: true, validation: "snapshotDigest" } };
  // Scoped record ids embed the account identity. The bundle keeps referential
  // integrity while replacing that raw identity with its one-way hash.
  const manifest = JSON.parse(JSON.stringify(draft).split(target.accountIdentity).join(`sha256:${accountIdentityHash}`)) as MaintenanceBackupManifest;
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  const blob = await zip.generateAsync({ type: "blob" });
  const primaryInput = { repository: snapshot.repository, lifecycle: snapshot.lifecycle, files: snapshot.files, commits: snapshot.commits, recoveries: snapshot.recoveries };
  const rewriteRecords = await Promise.all(snapshot.rewriteOperations.map(async (operation) => { const serialized = stable(operation); return { operationId: operation.operationId, hash: await sha256(serialized), snapshot: serialized }; }));
  const receipt: BackupReceipt = { schemaVersion: 1, receiptId: crypto.randomUUID(), sessionNonce: sessionNonce(), accountIdentity: target.accountIdentity, repoId: snapshot.repository.id, localInstanceId: snapshot.repository.localInstanceId, operationFence: snapshot.repository.operationFence ?? 0, snapshotDigest: snapshot.digest, primaryDigest: await primarySnapshotDigest(primaryInput), rewriteDigest: await rewriteSnapshotDigest(snapshot.rewriteOperations), primarySnapshot: primarySnapshotComponent(primaryInput), rewriteSnapshot: rewriteSnapshotComponent(snapshot.rewriteOperations), rewriteRecords, counts: manifest.counts, bytes: blob.size, createdAt: manifest.createdAt };
  sessionStorage.setItem(`${RECEIPT_PREFIX}${receipt.receiptId}`, JSON.stringify(receipt));
  return { blob, receipt, manifest };
}

function sessionNonce(): string { const key = `${RECEIPT_PREFIX}session`; let nonce = sessionStorage.getItem(key); if (!nonce) { nonce = crypto.randomUUID(); sessionStorage.setItem(key, nonce); } return nonce; }
function loadReceipt(receiptId: string): BackupReceipt | null { try { const raw = sessionStorage.getItem(`${RECEIPT_PREFIX}${receiptId}`); return raw ? JSON.parse(raw) as BackupReceipt : null; } catch { return null; } }

export async function validateMaintenanceBackupBundle(blob: Blob): Promise<MaintenanceBackupManifest> {
  const zip = await JSZip.loadAsync(blob);
  const raw = await zip.file("manifest.json")?.async("string");
  if (!raw) throw new Error("Maintenance backup manifest is missing.");
  const manifest = JSON.parse(raw) as MaintenanceBackupManifest;
  if (manifest.schema !== MAINTENANCE_BACKUP_SCHEMA || manifest.restoreContract?.manifestPath !== "manifest.json") throw new Error("Unsupported maintenance backup schema.");
  const allFiles = [...manifest.files, ...manifest.recoveries.flatMap((recovery) => recovery.files)];
  for (const file of allFiles) {
    if (file.contentPath && (!file.contentPath.startsWith("content/") || file.contentPath.includes("../") || !zip.file(file.contentPath))) throw new Error("Maintenance backup contains an unsafe or missing content reference.");
    if (file.status !== "deleted" && !file.contentPath) throw new Error(`Maintenance backup content is missing for ${file.path}.`);
  }
  if (manifest.counts.files !== manifest.files.length || manifest.counts.commits !== manifest.commits.length || manifest.counts.recoveries !== manifest.recoveries.length || manifest.counts.rewrites !== manifest.rewriteOperations.length) throw new Error("Maintenance backup counts do not match its manifest.");
  return manifest;
}

async function existingRemovalJournal(repoId: string): Promise<RemovalJournal | null> { const db = await openPrimary(); const value = await new Promise<RemovalJournal | null>((resolve, reject) => { const tx = db.transaction("removalJournals", "readonly"); const request = tx.objectStore("removalJournals").get(repoId); request.onsuccess = () => resolve(request.result as RemovalJournal | undefined ?? null); request.onerror = () => reject(request.error); }); db.close(); return value; }

async function existingRemovalCompletion(repoId: string): Promise<RemovalCompletion | null> {
  const db = await openPrimary();
  const value = await new Promise<RemovalCompletion | null>((resolve, reject) => {
    const tx = db.transaction("maintenanceCompletions", "readonly");
    const request = tx.objectStore("maintenanceCompletions").get(repoId);
    request.onsuccess = () => resolve(request.result as RemovalCompletion | undefined ?? null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return value;
}

function completionMatchesTarget(completion: RemovalCompletion, target: RepositoryMaintenanceTarget): boolean {
  return completion.repoId === scopedRepoId(target) && completion.accountIdentity === target.accountIdentity && completion.bookId === target.bookId && completion.owner === target.owner && completion.repo === target.repo && completion.branch === target.branch;
}

function completionEvidenceIsExact(completion: RemovalCompletion): boolean {
  if (!completion.journalId || !completion.localInstanceId || !completion.receiptId || !completion.snapshotDigest || !completion.primaryDigest || !completion.rewriteDigest || !completion.primaryCounts || !Number.isInteger(completion.primaryCounts.files) || !Number.isInteger(completion.primaryCounts.commits) || !Number.isInteger(completion.primaryCounts.recoveries) || !Number.isInteger(completion.primaryCounts.rewrites) || !Number.isInteger(completion.rewriteCount) || completion.rewriteCount < 0 || !Number.isInteger(completion.recoveriesPreserved) || completion.recoveriesPreserved < 0 || completion.primaryCounts.rewrites !== completion.rewriteCount || completion.primaryCounts.recoveries !== completion.recoveriesPreserved || !Array.isArray(completion.rewriteRecords) || completion.rewriteRecords.length !== completion.rewriteCount || !Array.isArray(completion.recoveryRecords) || completion.recoveryRecords.length !== completion.recoveriesPreserved || typeof completion.rewriteCompleted !== "boolean" || !["finalizing", "finalized"].includes(completion.phase)) return false;
  const ids = new Set<string>();
  const recoveryIds = new Set<string>();
  return completion.rewriteRecords.every((record) => Boolean(record.operationId) && Boolean(record.hash) && !ids.has(record.operationId) && (ids.add(record.operationId), true))
    && completion.recoveryRecords.every((record) => Boolean(record.id) && Boolean(record.digest) && !recoveryIds.has(record.id) && (recoveryIds.add(record.id), true));
}

function completionMatchesReceipt(completion: RemovalCompletion, receipt: BackupReceipt | null): boolean {
  if (!receipt) return true;
  return receipt.receiptId === completion.receiptId && receipt.repoId === completion.repoId && receipt.localInstanceId === completion.localInstanceId && receipt.accountIdentity === completion.accountIdentity && receipt.snapshotDigest === completion.snapshotDigest && receipt.primaryDigest === completion.primaryDigest && receipt.rewriteDigest === completion.rewriteDigest && stable(receipt.counts) === stable(completion.primaryCounts) && receipt.rewriteRecords.length === completion.rewriteRecords.length && receipt.rewriteRecords.every((record) => completion.rewriteRecords.some((expected) => expected.operationId === record.operationId && expected.hash === record.hash));
}

function recoveryEvidenceMatches(completion: RemovalCompletion, recoveries: LocalRepositoryRecovery[]): boolean {
  const actual = recoveryRecordsDigest(recoveries);
  return actual.length === completion.recoveryRecords.length
    && actual.every((record) => completion.recoveryRecords.some((expected) => expected.id === record.id && expected.digest === record.digest));
}

async function removeReceipt(receiptId: string): Promise<void> {
  if (receiptId) sessionStorage.removeItem(`${RECEIPT_PREFIX}${receiptId}`);
}

async function clearRemovalCompletion(repoId: string): Promise<void> {
  const db = await openPrimary();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("maintenanceCompletions", "readwrite");
    tx.objectStore("maintenanceCompletions").delete(repoId);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function allRecoveryRows(repoId: string): Promise<LocalRepositoryRecovery[]> {
  const db = await openPrimary();
  const rows = await new Promise<LocalRepositoryRecovery[]>((resolve, reject) => {
    const tx = db.transaction("recoveries", "readonly");
    const request = tx.objectStore("recoveries").index("repoId").getAll(repoId);
    request.onsuccess = () => resolve(request.result as LocalRepositoryRecovery[]);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return rows;
}

async function prepareRemoval(target: RepositoryMaintenanceTarget, receiptId: string): Promise<RemovalJournal> {
  const receipt = loadReceipt(receiptId);
  if (!receipt || receipt.sessionNonce !== sessionNonce() || Date.now() - Date.parse(receipt.createdAt) > RECEIPT_TTL_MS) throw new RepositoryMaintenanceError("BACKUP_REQUIRED");
  if (receipt.accountIdentity !== target.accountIdentity || receipt.repoId !== scopedRepoId(target)) throw new RepositoryMaintenanceError("BACKUP_STALE");
  const scope = captureRepositoryOperationScope();
  const db = await openPrimary();
  const journal = await new Promise<RemovalJournal>((resolve, reject) => {
    const stores = ["repositories", "files", "commits", "recoveries", "logs", "repositoryDiagnostics", "migrationJournals", "maintenanceFences", "removalJournals", "maintenanceTombstones", "consumedBackupReceipts"];
    const tx = db.transaction(stores, "readwrite");
    const repositories = tx.objectStore("repositories");
    const requests = { repository: repositories.get(receipt.repoId), files: tx.objectStore("files").index("repoId").getAll(receipt.repoId), commits: tx.objectStore("commits").index("repoId").getAll(receipt.repoId), recoveries: tx.objectStore("recoveries").index("repoId").getAll(receipt.repoId), logs: tx.objectStore("logs").index("repoId").getAll(receipt.repoId), migrations: tx.objectStore("migrationJournals").getAll(), consumed: tx.objectStore("consumedBackupReceipts").get(receipt.receiptId), tombstone: tx.objectStore("maintenanceTombstones").get(receipt.repoId) };
    let result: RemovalJournal; let validationError: Error | null = null; let loaded = 0;
    const prepare = () => {
      if (++loaded !== Object.keys(requests).length) return;
      try { assertRepositoryOperationScopeCurrent(scope); } catch (error) { validationError = error as Error; tx.abort(); return; }
      const current = requests.repository.result as LocalRepositoryMeta | undefined;
      const files = requests.files.result as LocalRepositoryFile[];
      const commits = requests.commits.result as LocalCommit[];
      const recoveries = (requests.recoveries.result as LocalRepositoryRecovery[]).filter((recovery) => recovery.accountIdentity === target.accountIdentity);
      if (requests.consumed.result || requests.tombstone.result || !current || current.accountScope !== target.accountIdentity || current.bookId !== target.bookId || current.owner !== target.owner || current.repo !== target.repo || current.branch !== target.branch || current.localInstanceId !== receipt.localInstanceId || (current.operationFence ?? 0) !== receipt.operationFence) { validationError = new RepositoryMaintenanceError("BACKUP_STALE"); tx.abort(); return; }
      const journalFailed = (requests.migrations.result as MigrationJournalRow[]).some((entry) => entry.newRepoId === receipt.repoId && entry.bookId === target.bookId && entry.immutableAccountIdentity === target.accountIdentity);
      const actualPrimarySnapshot = primarySnapshotComponent({ repository: current, lifecycle: lifecycle(current, journalFailed), files, commits: commits.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)), recoveries: recoveries.sort((a, b) => a.id.localeCompare(b.id)) });
      if (actualPrimarySnapshot !== receipt.primarySnapshot || files.length !== receipt.counts.files || commits.length !== receipt.counts.commits || recoveries.length !== receipt.counts.recoveries) { validationError = new RepositoryMaintenanceError("BACKUP_STALE"); tx.abort(); return; }
      const removalFence = receipt.operationFence + 1;
      result = { repoId: current.id, journalId: crypto.randomUUID(), accountIdentity: target.accountIdentity, bookId: target.bookId, owner: target.owner, repo: target.repo, branch: target.branch, localInstanceId: current.localInstanceId, snapshotDigest: receipt.snapshotDigest, primaryDigest: receipt.primaryDigest, rewriteDigest: receipt.rewriteDigest, rewriteSnapshot: receipt.rewriteSnapshot, rewriteRecords: receipt.rewriteRecords, rewriteCount: receipt.counts.rewrites, receiptId, observedFence: receipt.operationFence, removalFence, recoveriesPreserved: recoveries.length, recoveryRecords: recoveryRecordsDigest(recoveries), rewriteOperationsRemoved: 0, primaryCounts: receipt.counts, phase: "prepared", createdAt: new Date().toISOString() };
      repositories.put({ ...current, operationFence: removalFence, operationLease: undefined, cloneOperationId: undefined, repairOperationId: undefined, migrationOperationId: undefined, updatedAt: new Date().toISOString() });
      tx.objectStore("maintenanceFences").put({ repoId: current.id, fence: removalFence });
       tx.objectStore("maintenanceTombstones").add({ repoId: current.id, journalId: result.journalId, localInstanceId: current.localInstanceId, accountIdentity: target.accountIdentity, bookId: target.bookId, owner: target.owner, repo: target.repo, branch: target.branch, fence: removalFence, createdAt: result.createdAt });
      tx.objectStore("consumedBackupReceipts").add({ receiptId: receipt.receiptId, repoId: current.id, localInstanceId: current.localInstanceId, consumedAt: result.createdAt });
      tx.objectStore("removalJournals").add(result);
    };
    for (const request of Object.values(requests)) { request.onsuccess = prepare; request.onerror = () => tx.abort(); }
    tx.oncomplete = () => resolve(result!); tx.onerror = () => reject(validationError ?? tx.error); tx.onabort = () => reject(validationError ?? tx.error ?? new Error("Removal journal preparation was aborted."));
  });
  db.close();
  return journal;
}

async function updateJournal(journal: RemovalJournal, phase: RemovalJournal["phase"], rewriteOperationsRemoved = journal.rewriteOperationsRemoved): Promise<RemovalJournal> { const updated = { ...journal, phase, rewriteOperationsRemoved }; const db = await openPrimary(); await new Promise<void>((resolve, reject) => { const tx = db.transaction("removalJournals", "readwrite"); tx.objectStore("removalJournals").put(updated); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); db.close(); return updated; }
async function cancelPreparedRemoval(journal: RemovalJournal): Promise<void> {
  const db = await openPrimary();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["repositories", "maintenanceTombstones", "removalJournals"], "readwrite");
    const repositories = tx.objectStore("repositories"); const request = repositories.get(journal.repoId); let validationError: Error | null = null;
    request.onsuccess = () => { const current = request.result as LocalRepositoryMeta | undefined; if (!current || current.localInstanceId !== journal.localInstanceId || (current.operationFence ?? 0) !== journal.removalFence) { validationError = new RepositoryOwnershipChangedError("Removal cancellation cannot unfence a replacement repository."); tx.abort(); return; } repositories.put({ ...current, operationFence: journal.observedFence, updatedAt: new Date().toISOString() }); tx.objectStore("maintenanceTombstones").delete(journal.repoId); tx.objectStore("removalJournals").delete(journal.repoId); };
    request.onerror = () => tx.abort(); tx.oncomplete = () => resolve(); tx.onerror = () => reject(validationError ?? tx.error); tx.onabort = () => reject(validationError ?? tx.error ?? new Error("Removal cancellation was aborted."));
  }); db.close();
}
async function deletePrimary(journal: RemovalJournal, scope: RepositoryOperationScope): Promise<void> {
  const db = await openPrimary(); await new Promise<void>((resolve, reject) => { const tx = db.transaction(["repositories", "files", "commits", "logs", "repositoryDiagnostics", "maintenanceFences"], "readwrite"); const repositories = tx.objectStore("repositories"); const request = repositories.get(journal.repoId); let validationError: Error | null = null; request.onsuccess = () => { const current = request.result as LocalRepositoryMeta | undefined; try { assertRepositoryOperationScopeCurrent(scope); } catch (error) { validationError = error as Error; tx.abort(); return; } if (current && (current.localInstanceId !== journal.localInstanceId || (current.operationFence ?? 0) !== journal.removalFence)) { validationError = new RepositoryOwnershipChangedError("A replacement repository cannot be removed by this journal."); tx.abort(); return; } if (current) repositories.delete(journal.repoId); for (const name of ["files", "commits", "logs"]) { const store = tx.objectStore(name); const cursor = store.index("repoId").openKeyCursor(IDBKeyRange.only(journal.repoId)); cursor.onsuccess = () => { if (cursor.result) { store.delete(cursor.result.primaryKey); cursor.result.continue(); } }; cursor.onerror = () => tx.abort(); } const diagnostics = tx.objectStore("repositoryDiagnostics"); const diagnosticCursor = diagnostics.index("localInstanceId").openKeyCursor(IDBKeyRange.only(journal.localInstanceId)); diagnosticCursor.onsuccess = () => { const cursor = diagnosticCursor.result; if (cursor) { diagnostics.delete(cursor.primaryKey); cursor.continue(); } }; diagnosticCursor.onerror = () => tx.abort(); }; request.onerror = () => tx.abort(); tx.oncomplete = () => resolve(); tx.onerror = () => reject(validationError ?? tx.error); tx.onabort = () => reject(validationError ?? tx.error ?? new Error("Primary maintenance deletion was aborted.")); }); db.close();
}

export async function removeRepositoryWithBackupReceipt(target: RepositoryMaintenanceTarget, receiptId: string): Promise<{ recoveriesPreserved: number; rewriteOperationsRemoved: number }> {
  const scope = captureRepositoryOperationScope(); if (scope.accountIdentity !== target.accountIdentity) throw new RepositoryMaintenanceError("ACCOUNT_MISMATCH");
  const repoId = scopedRepoId(target);
  const completed = await existingRemovalCompletion(repoId);
  if (completed) {
    if (!completionMatchesTarget(completed, target) || !completionEvidenceIsExact(completed)) throw new RepositoryMaintenanceError("TARGET_MISMATCH");
    const journal = await existingRemovalJournal(repoId);
    if (journal && (journal.journalId !== completed.journalId || journal.localInstanceId !== completed.localInstanceId || journal.accountIdentity !== completed.accountIdentity)) throw new RepositoryMaintenanceError("TARGET_MISMATCH");
    const snapshot = await lookupRepositoryMaintenanceTarget(target);
    const recoveryRows = await allRecoveryRows(repoId);
    const exactRecoveries = recoveryRows.filter((recovery) => recovery.accountIdentity === target.accountIdentity && recovery.repoId === repoId && recovery.repository?.id === repoId && recovery.repository?.localInstanceId === completed.localInstanceId && recovery.repository?.accountScope === target.accountIdentity && recovery.repository?.bookId === target.bookId && recovery.repository?.owner === target.owner && recovery.repository?.repo === target.repo && recovery.repository?.branch === target.branch);
    const exactRows = snapshot.files.length === 0 && snapshot.commits.length === 0 && snapshot.logs.length === 0 && snapshot.rewriteOperationCount === 0;
    const exactCompletion = exactRows && recoveryRows.length === completed.recoveriesPreserved && exactRecoveries.length === completed.recoveriesPreserved && recoveryEvidenceMatches(completed, exactRecoveries) && completionMatchesReceipt(completed, loadReceipt(completed.receiptId));
    if (!exactCompletion) throw new RepositoryMaintenanceError("BACKUP_STALE");
    if (completed.rewriteCount > 0 && !completed.rewriteCompleted) throw new RepositoryMaintenanceError("BACKUP_STALE");
    if (completed.rewriteCount > 0 && completed.phase !== "finalized") {
      const rewriteMarker = await getRewriteMaintenanceCompletion({ repoId, localInstanceId: completed.localInstanceId, journalId: completed.journalId });
      if (rewriteMarker) {
        await finalizeLocalRewriteMaintenanceTombstone({ repoId, localInstanceId: completed.localInstanceId, journalId: completed.journalId, accountIdentity: completed.accountIdentity }, scope);
        await clearRewriteMaintenanceCompletion({ repoId, localInstanceId: completed.localInstanceId, journalId: completed.journalId });
      } else if (!completed.rewriteCompleted) {
        throw new RepositoryMaintenanceError("BACKUP_STALE");
      }
      await clearRewriteMaintenanceTombstone(repoId);
    }
    const finalizedDb = await openPrimary();
    await new Promise<void>((resolve, reject) => {
      const tx = finalizedDb.transaction("removalJournals", "readwrite");
      const request = tx.objectStore("removalJournals").get(repoId);
      request.onsuccess = () => { const current = request.result as RemovalJournal | undefined; if (current && current.phase !== "finalized") tx.objectStore("removalJournals").put({ ...current, phase: "finalized" }); };
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    finalizedDb.close();
    const cleanupDb = await openPrimary();
    await new Promise<void>((resolve, reject) => {
      const tx = cleanupDb.transaction(["removalJournals", "maintenanceTombstones"], "readwrite");
      tx.objectStore("removalJournals").delete(repoId);
      tx.objectStore("maintenanceTombstones").delete(repoId);
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    cleanupDb.close();
    await clearRewriteMaintenanceCompletion({ repoId, localInstanceId: completed.localInstanceId, journalId: completed.journalId }).catch(() => undefined);
    await clearRewriteMaintenanceTombstone(repoId).catch(() => undefined);
    await removeReceipt(completed.receiptId);
    await clearRemovalCompletion(repoId);
    return { recoveriesPreserved: completed.recoveriesPreserved, rewriteOperationsRemoved: completed.rewriteCount };
  }
  let journal = await existingRemovalJournal(repoId);
  if (journal && (journal.accountIdentity !== target.accountIdentity || journal.bookId !== target.bookId || journal.owner !== target.owner || journal.repo !== target.repo || journal.branch !== target.branch)) throw new RepositoryMaintenanceError("TARGET_MISMATCH");
  journal ??= await prepareRemoval(target, receiptId); simulateCrash("after-prepare");
  if (journal.phase === "prepared") {
    try {
      simulateCrash("before-rewrite-transaction");
      const removed = await fenceAndRemoveLocalRewriteOperationsForMaintenance({ repoId, localInstanceId: journal.localInstanceId, journalId: journal.journalId, accountIdentity: journal.accountIdentity, expectedSnapshot: journal.rewriteSnapshot, expectedDigest: journal.rewriteDigest, expectedRecords: journal.rewriteRecords }, scope);
      simulateCrash("after-rewrite-marker");
      journal = await updateJournal(journal, "rewrites-fenced", removed);
      simulateCrash("after-rewrite-phase-update");
      simulateCrash("after-rewrites");
    } catch (error) {
      if (error instanceof Error && error.message === "REWRITE_BACKUP_STALE") { await cancelPreparedRemoval(journal); sessionStorage.removeItem(`${RECEIPT_PREFIX}${journal.receiptId}`); throw new RepositoryMaintenanceError("BACKUP_STALE"); }
      throw error;
    }
  }
  if (journal.phase === "rewrites-fenced") { await deletePrimary(journal, scope); journal = await updateJournal(journal, "primary-deleted"); simulateCrash("after-primary"); }
  if (journal.phase === "primary-deleted") { journal = await updateJournal(journal, "finalizing"); simulateCrash("after-primary-marker"); }
  const rewriteEvidence = await getRewriteMaintenanceCompletion(journal);
  if (journal.phase === "finalizing") await finalizeLocalRewriteMaintenanceTombstone(journal, scope);
  if (journal.phase === "finalizing") simulateCrash("after-rewrite-finalize");
  if (!journal) throw new RepositoryMaintenanceError("REMOVAL_PENDING");
  const db = await openPrimary();
  const finalJournal = journal;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("maintenanceCompletions", "readwrite");
      tx.objectStore("maintenanceCompletions").put({ repoId, journalId: finalJournal.journalId, localInstanceId: finalJournal.localInstanceId, accountIdentity: finalJournal.accountIdentity, bookId: finalJournal.bookId, owner: finalJournal.owner, repo: finalJournal.repo, branch: finalJournal.branch, receiptId: finalJournal.receiptId, snapshotDigest: finalJournal.snapshotDigest, primaryDigest: finalJournal.primaryDigest, rewriteDigest: finalJournal.rewriteDigest, rewriteCount: finalJournal.rewriteCount, rewriteRecords: finalJournal.rewriteRecords.map(({ operationId, hash }) => ({ operationId, hash })), recoveriesPreserved: finalJournal.recoveriesPreserved, recoveryRecords: finalJournal.recoveryRecords, primaryCounts: finalJournal.primaryCounts, rewriteCompleted: Boolean(rewriteEvidence || finalJournal.rewriteCount === 0), phase: "finalizing", completedAt: new Date().toISOString() } satisfies RemovalCompletion);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  });
  db.close();
  journal = await updateJournal(journal, "finalized");
  simulateCrash("after-rewrite-finalize");
  const cleanupDb = await openPrimary(); await new Promise<void>((resolve, reject) => { const tx = cleanupDb.transaction(["removalJournals", "maintenanceTombstones"], "readwrite"); tx.objectStore("maintenanceTombstones").delete(repoId); tx.objectStore("removalJournals").delete(repoId); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); cleanupDb.close();
  simulateCrash("after-final-cleanup");
  const finalizedDb = await openPrimary();
  await new Promise<void>((resolve, reject) => {
    const tx = finalizedDb.transaction("maintenanceCompletions", "readwrite");
    const request = tx.objectStore("maintenanceCompletions").get(repoId);
    request.onsuccess = () => { const completion = request.result as RemovalCompletion | undefined; if (completion) tx.objectStore("maintenanceCompletions").put({ ...completion, phase: "finalized" }); };
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  });
  finalizedDb.close();
  simulateCrash("after-finalized");
  sessionStorage.removeItem(`${RECEIPT_PREFIX}${journal.receiptId}`);
  return { recoveriesPreserved: journal.recoveriesPreserved, rewriteOperationsRemoved: journal.rewriteOperationsRemoved };
}

export function maintenanceScope(target: RepositoryMaintenanceTarget): RepositoryOperationScope { const scope = captureRepositoryOperationScope(); if (scope.accountIdentity !== target.accountIdentity) throw new RepositoryOwnershipChangedError(); return scope; }
