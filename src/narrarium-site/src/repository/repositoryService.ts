import { Octokit } from "@octokit/rest";
import type { BookEntry } from "@/types/settings";
import type { BookStructure } from "@/types/book";
import { isAccountIdentityCurrent } from "@/auth/accountIdentity";
import { useAuthStore } from "@/store/authStore";
import { assertRepositoryOperationScopeCurrent, captureRepositoryOperationScope, RepositoryOwnershipChangedError, type RepositoryOperationScope } from "@/repository/repositoryOperationScope";
import {
  addLocalRepoLog,
  adoptLegacyEmailScopedRepository,
  applyLocalFileChangesAtomically,
  applyCloneRepairAtomically,
  claimLocalRepositoryRepair,
  claimLegacyLocalRepositoryMigration,
  classifyLegacyLocalRepositoryMigration,
  createLocalRepositoryClone,
  applyRemoteMergeAtomically,
  buildLocalBookStructure,
  createLocalCommit,
  createLocalRecoverySnapshot,
  getLocalFileEntry,
  getLocalRecoverySnapshot,
  getLocalRepository,
  getLocalRepositoryById,
  listAllLocalFiles,
  listDirtyLocalFiles,
  listUnpushedLocalCommits,
  recordRepositoryDiagnostic,
  type RepositoryDiagnosticOperation,
  type RepositoryDiagnosticStage,
  markLocalRepositoryRemoteCheck,
  markLocalRepositoryRemoteChecking,
  markLocalRepositoryRemoteFailure,
  markLocalRepositoryCloneComplete,
  markLocalRepositoryRepairRequired,
  heartbeatRepositoryLifecycleLease,
  markLocalCommitsPushed,
  putCleanLocalFileScoped,
  releaseLocalRepositoryRepair,
  releaseLegacyLocalRepositoryMigration,
  reclaimExpiredRepositoryLifecycleLease,
  replaceLocalTreeAtomically,
  restoreLocalRecoverySnapshot,
  restoreUnpushedCommitsAsDirty,
  sha256Bytes,
  settleLocalSourceOverwriteAtomically,
  updateLocalRepositoryHead,
  type LocalCommitFile,
  type LocalRepositoryMeta,
  type LocalRepositoryFile,
  type LocalRepositoryRecovery,
  type RemoteTreeFile,
} from "@/repository/localRepository";
import { lookupRepositoryMaintenanceTarget, removeRepositoryWithBackupReceipt, RepositoryMaintenanceError } from "@/repository/repositoryMaintenance";
import { reconcileRemoteMutation } from "@/repository/remoteMutationReconciliation";
import { classifyRepositoryError, RepositoryError } from "@/repository/repositoryError";
import { createTrackedGitHubClient } from "@/repository/githubRequest";
import { recordRepositoryReadValidated, recordRepositoryWriteValidated, tokenExpirationFromHeaders, writeTokenHealth, type TokenHealth, type TokenHealthTarget } from "@/repository/tokenHealth";
import { RepositoryByteMeter, RepositoryLimitExceededError, REPOSITORY_TRANSFER_LIMIT_BYTES, assertRepositoryAggregateBytes, assertRepositoryFileBytes, bytesToBase64, utf8Bytes } from "@/repository/repositoryLimits";
import { fetchRepositoryBlobBytes } from "@/repository/repositoryBlobTransport";

const TEXT_EXTENSIONS = new Set(["md", "markdown", "txt", "json", "yaml", "yml", "toml", "csv", "html", "css", "js", "ts", "tsx"]);

function tokenHealthTarget(input: Pick<ExactRepositoryTarget, "accountIdentity" | "owner" | "repo" | "branch"> & { token: string }): TokenHealthTarget {
  return { accountIdentity: input.accountIdentity, token: input.token, owner: input.owner, repo: input.repo, branch: input.branch };
}

function trackedOctokit(token: string, target?: Pick<ExactRepositoryTarget, "accountIdentity" | "owner" | "repo" | "branch">): Octokit {
  return createTrackedGitHubClient(token, target);
}

export interface LocalCloneProgress {
  done: number;
  total: number;
  path?: string;
  phase?: "cloning" | "migrating" | "repairing" | "finalizing";
}

export interface RemoteStatusResult {
  remoteHeadSha: string;
  changed: boolean;
}

export interface PushResult {
  commitSha: string;
  files: number;
  recoveryPaths?: string[];
}

export class RemoteHeadMismatchError extends Error {
  readonly code = "REMOTE_HEAD_MISMATCH";
  constructor(readonly expectedRemoteHeadSha: string, readonly actualRemoteHeadSha: string) {
    super(`Remote head changed: expected ${expectedRemoteHeadSha}, found ${actualRemoteHeadSha}.`);
    this.name = "RemoteHeadMismatchError";
  }
}

export interface PushLocalCommitsInput {
  bookId: string;
  token: string;
  expectedRemoteHeadSha?: string;
  repoId?: string;
  owner: string;
  repo: string;
  branch: string;
  accountIdentity: string;
  allowRemoteOverwrite?: boolean;
  confirmed?: boolean;
  signal?: AbortSignal;
}

export interface ExactRepositoryTarget {
  bookId: string;
  owner: string;
  repo: string;
  branch: string;
  accountIdentity: string;
  repoId?: string;
}

export interface SyncResult {
  pulled: number;
  keptLocal: number;
  committed: number;
  pushed: number;
}

export type RepositorySyncConflictResolution = "local" | "remote";

export interface RepositorySyncConflict {
  path: string;
  kind: "text" | "binary";
  localContent: string | null;
  remoteContent: string | null;
  localDeleted: boolean;
  remoteDeleted: boolean;
  localHash: string | null;
  remoteSha: string | null;
  localBaseSha: string | null;
  localChanged: boolean;
}

export interface RepositorySyncConflictChoice {
  choice: RepositorySyncConflictResolution;
  expectedLocalHash: string | null;
  expectedRemoteSha: string | null;
  expectedLocalDeleted: boolean;
  expectedRemoteDeleted: boolean;
  expectedLocalBaseSha: string | null;
  expectedLocalChanged: boolean;
}

export class RepositorySyncConflictError extends Error {
  readonly code = "REPOSITORY_SYNC_CONFLICT";
  constructor(readonly conflicts: RepositorySyncConflict[]) {
    super(`Repository sync conflict: ${conflicts.map((conflict) => conflict.path).sort().join(", ")}`);
    this.name = "RepositorySyncConflictError";
  }
}

export class RepositorySyncChoiceStaleError extends Error {
  readonly code = "REPOSITORY_SYNC_CHOICE_STALE";
  constructor(readonly conflicts: RepositorySyncConflict[] = []) {
    super("Repository conflict choices are stale because the local or remote files changed. Review the current state and sync again.");
    this.name = "RepositorySyncChoiceStaleError";
  }
}

interface RemoteChangeState {
  remoteHeadSha: string;
  changed: boolean;
}

const repositoryMutationQueues = new Map<string, Promise<void>>();
type RepositoryEnsureOperation = {
  scope: RepositoryOperationScope;
  epoch: number;
  controller: AbortController;
  promise: Promise<{ meta: LocalRepositoryMeta; structure: BookStructure; cloned: boolean }>;
};

const repositoryEnsureOperations = new Map<string, RepositoryEnsureOperation>();
let repositoryEnsureEpoch = 0;

export function invalidateRepositoryEnsureOperations(epoch: number, accountIdentity?: string): void {
  repositoryEnsureEpoch = Math.max(repositoryEnsureEpoch, epoch);
  for (const [key, operation] of repositoryEnsureOperations) {
    if (!accountIdentity || operation.scope.accountIdentity === accountIdentity || operation.epoch < repositoryEnsureEpoch) {
      operation.controller.abort();
      repositoryEnsureOperations.delete(key);
    }
  }
}

async function withRepositoryMutationLease<T>(repoId: string, run: () => Promise<T>): Promise<T> {
  const previous = repositoryMutationQueues.get(repoId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  repositoryMutationQueues.set(repoId, queued);
  await previous;
  try {
    if (typeof navigator !== "undefined" && navigator.locks) {
      return await navigator.locks.request(`narrarium-repository-${repoId}`, { mode: "exclusive" }, run);
    }
    return await run();
  } finally {
    release();
    if (repositoryMutationQueues.get(repoId) === queued) repositoryMutationQueues.delete(repoId);
  }
}

function operationScope(target: ExactRepositoryTarget): RepositoryOperationScope {
  const scope = captureRepositoryOperationScope();
  if (scope.accountIdentity !== target.accountIdentity) throw new Error("Local repository account identity is not current.");
  return scope;
}

async function diagnostic(input: {
  meta: LocalRepositoryMeta;
  scope: RepositoryOperationScope;
  operationId: string;
  operation: RepositoryDiagnosticOperation;
  stage: RepositoryDiagnosticStage;
  outcome: "started" | "stage" | "success" | "failure" | "cancelled";
  startedAt: string;
  durationMs?: number;
  fileCount?: number;
  byteCount?: number;
  error?: unknown;
  errorOperation?: "read" | "update" | "compare";
  commitSha?: string;
}): Promise<void> {
  await recordRepositoryDiagnostic({
    repoId: input.meta.id,
    localInstanceId: input.meta.localInstanceId,
    ...input,
  }).catch(() => undefined);
}

async function exactLocalRepository(target: ExactRepositoryTarget, scope = operationScope(target)): Promise<LocalRepositoryMeta> {
  assertRepositoryOperationScopeCurrent(scope);
  if (!target.accountIdentity || !isAccountIdentityCurrent(target.accountIdentity, useAuthStore.getState().user)) {
    throw new Error("Local repository account identity is not current.");
  }
  const meta = target.repoId
    ? await getLocalRepositoryById(target.repoId, target.accountIdentity)
    : await getLocalRepository(target.owner, target.repo, target.branch, scope);
  if (!meta) throw new Error("Local repository is not ready.");
  if (meta.accountScope !== target.accountIdentity) throw new Error("Local repository account identity does not match.");
  if (meta.bookId !== target.bookId || meta.owner !== target.owner || meta.repo !== target.repo || meta.branch !== target.branch) {
    throw new Error("The selected local repository does not match the requested book and branch.");
  }
  return meta;
}

function extension(path: string): string {
  return (path.split(".").pop() ?? "").toLowerCase();
}

function isTextPath(path: string): boolean {
  return TEXT_EXTENSIONS.has(extension(path));
}

async function repositoryTransferAllowance(): Promise<number> {
  const storage: StorageEstimate = await navigator.storage?.estimate?.().catch(() => ({} as StorageEstimate)) ?? {};
  if (storage.quota === undefined) return REPOSITORY_TRANSFER_LIMIT_BYTES;
  return Math.min(REPOSITORY_TRANSFER_LIMIT_BYTES, Math.max(0, storage.quota - (storage.usage ?? 0)));
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
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

async function withLifecycleHeartbeat<T>(repoId: string, scope: RepositoryOperationScope, operationId: string, run: () => Promise<T>): Promise<T> {
  await heartbeatRepositoryLifecycleLease(repoId, scope, operationId);
  const timer = window.setInterval(() => { void heartbeatRepositoryLifecycleLease(repoId, scope, operationId).catch(() => undefined); }, 10_000);
  try { return await run(); }
  finally { window.clearInterval(timer); }
}

export async function ensureLocalBookStructure(input: {
  bookId: string;
  book: BookEntry;
  token: string;
  accountIdentity: string;
  branch?: string;
  onProgress?: (progress: LocalCloneProgress) => void;
}): Promise<{ meta: LocalRepositoryMeta; structure: BookStructure; cloned: boolean }> {
  const scope = operationScope({ bookId: input.bookId, owner: input.book.owner, repo: input.book.repo, branch: input.branch ?? "", accountIdentity: input.accountIdentity });
  const epoch = repositoryEnsureEpoch;
  const key = `${epoch}::${scope.accountGeneration}::${scope.accountIdentity}::${input.bookId}::${input.book.owner}/${input.book.repo}#${input.branch ?? ""}`.toLocaleLowerCase();
  const active = repositoryEnsureOperations.get(key);
  if (active) return active.promise;
  const controller = new AbortController();
  const promise = ensureLocalBookStructureOnce(input, scope, controller.signal);
  const operation = { scope, epoch, controller, promise };
  repositoryEnsureOperations.set(key, operation);
  try {
    const result = await promise;
    assertRepositoryOperationScopeCurrent(scope);
    if (repositoryEnsureEpoch !== epoch) throw new RepositoryOwnershipChangedError();
    return result;
  }
  finally { if (repositoryEnsureOperations.get(key) === operation) repositoryEnsureOperations.delete(key); }
}

async function ensureLocalBookStructureOnce(input: {
  bookId: string;
  book: BookEntry;
  token: string;
  accountIdentity: string;
  branch?: string;
  onProgress?: (progress: LocalCloneProgress) => void;
}, scope: RepositoryOperationScope, signal: AbortSignal): Promise<{ meta: LocalRepositoryMeta; structure: BookStructure; cloned: boolean }> {
  assertRepositoryOperationScopeCurrent(scope);
  const branch = input.branch;
  let existing: LocalRepositoryMeta | null = null;
  if (branch) {
    input.onProgress?.({ done: 0, total: 0, phase: "migrating" });
    existing = await adoptLegacyEmailScopedRepository({ bookId: input.bookId, owner: input.book.owner, repo: input.book.repo, branch, scope });
    existing ??= await getLocalRepository(input.book.owner, input.book.repo, branch, scope);
  }
  if (existing) {
    // A repo is only trustworthy once its clone was verified complete. Legacy repos
    // (cloneComplete === undefined) and interrupted clones (=== false) get healed here.
    if (existing.cloneComplete === true) {
      input.onProgress?.({ done: 1, total: 1, phase: "finalizing" });
      return { meta: existing, structure: await buildLocalBookStructure(existing), cloned: false };
    }
    if (existing.operationLease) {
      const recovered = await recoverExpiredRepositoryLifecycle({ meta: existing, token: input.token, accountIdentity: input.accountIdentity, onProgress: input.onProgress, scope });
      return { meta: recovered.meta, structure: recovered.structure, cloned: false };
    }
    const classified = existing.cloneComplete === undefined && existing.cloneStatus === undefined
      ? await migrateLegacyLocalRepository({ meta: existing, token: input.token, accountIdentity: input.accountIdentity, scope })
      : existing;
    if (classified.cloneComplete === true) return { meta: classified, structure: await buildLocalBookStructure(classified), cloned: false };
    const repaired = await verifyAndRepairLocalRepository({ meta: classified, token: input.token, accountIdentity: input.accountIdentity, onProgress: input.onProgress, scope });
    return { meta: repaired.meta, structure: repaired.structure, cloned: false };
  }

  const octokit = createTrackedGitHubClient(input.token);
  const repoData = await octokit.rest.repos.get({ owner: input.book.owner, repo: input.book.repo, request: { signal } });
  const defaultBranch = repoData.data.default_branch;
  const resolvedBranch = branch || defaultBranch;

  const persistent = await navigator.storage?.persist?.().catch(() => false);
  const ref = await octokit.rest.git.getRef({ owner: input.book.owner, repo: input.book.repo, ref: `heads/${resolvedBranch}`, request: { signal } });
  const headSha = ref.data.object.sha;
  const tree = await octokit.rest.git.getTree({ owner: input.book.owner, repo: input.book.repo, tree_sha: headSha, recursive: "1", request: { signal } });
  const blobs = tree.data.tree
    .filter((item) => item.type === "blob" && item.path)
    .map((item) => ({ path: item.path!, sha: item.sha, size: item.size ?? 0 }));
  const advertisedBytes = blobs.reduce((sum, blob) => sum + Math.max(0, blob.size), 0);
  assertRepositoryAggregateBytes(advertisedBytes, "transfer");
  const transferAllowance = await repositoryTransferAllowance();
  if (advertisedBytes > transferAllowance) throw new RepositoryLimitExceededError("transfer", "aggregate", advertisedBytes, transferAllowance);
  const cloneOperationId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const meta = await createLocalRepositoryClone({
    bookId: input.bookId,
    owner: input.book.owner,
    repo: input.book.repo,
    branch: resolvedBranch,
    defaultBranch,
    remoteHeadSha: headSha,
    clonedAt: new Date().toISOString(),
    // Mark incomplete up-front: only flip to true once every blob is stored, so an
    // interrupted clone can never masquerade as a complete, clean, synced repo.
    expectedFileCount: blobs.length,
  }, scope, cloneOperationId);
  await diagnostic({ meta, scope, operationId: cloneOperationId, operation: "clone", stage: "start", outcome: "started", startedAt, fileCount: blobs.length });
  if (persistent === false) await addLocalRepoLog(meta.id, scope, "error", "Browser storage persistence was not granted; export backups regularly because the working copy may be evicted");

  let done = 0;
  const transferMeter = new RepositoryByteMeter("transfer", transferAllowance);
  input.onProgress?.({ done, total: blobs.length, phase: "cloning" });
  try {
    await withLifecycleHeartbeat(meta.id, scope, cloneOperationId, async () => {
    await mapLimit(blobs, 5, async (blob) => {
      if (!blob.sha) throw new Error(`Remote tree entry has no immutable blob SHA: ${blob.path}`);
      const bytes = await fetchBlobBytesForRepository(input.token, input.book.owner, input.book.repo, blob.path, blob.sha, transferMeter, signal);
      assertRepositoryAggregateBytes(bytes.byteLength, "transfer", await repositoryTransferAllowance());
      if (isTextPath(blob.path)) {
        await putCleanLocalFileScoped({ repoId: meta.id, path: blob.path, kind: "text", text: new TextDecoder().decode(bytes), baseSha: blob.sha, size: bytes.byteLength }, scope, cloneOperationId);
      } else {
        await putCleanLocalFileScoped({ repoId: meta.id, path: blob.path, kind: "binary", blob: new Blob([bytesToArrayBuffer(bytes)]), baseSha: blob.sha, size: bytes.byteLength }, scope, cloneOperationId);
      }
      done += 1;
      input.onProgress?.({ done, total: blobs.length, path: blob.path, phase: "cloning" });
    });
    });
  } catch (error) {
    const classified = classifyRepositoryError(error, "read");
    await markLocalRepositoryRepairRequired(meta.id, scope, cloneOperationId).catch(() => undefined);
    await diagnostic({ meta, scope, operationId: cloneOperationId, operation: "clone", stage: "download", outcome: classified.kind === "abort" ? "cancelled" : "failure", startedAt, durationMs: Date.now() - Date.parse(startedAt), fileCount: done, error: classified });
    throw error;
  }

  if (tree.data.truncated) {
    // Extremely large tree we could not enumerate in one request: leave the repo
    // marked incomplete so it is re-verified, rather than trusting a partial file set.
    await markLocalRepositoryRepairRequired(meta.id, scope, cloneOperationId);
    await diagnostic({ meta, scope, operationId: cloneOperationId, operation: "clone", stage: "finalize", outcome: "failure", startedAt, durationMs: Date.now() - Date.parse(startedAt), fileCount: blobs.length, error: new Error("Remote tree truncated") });
    await addLocalRepoLog(meta.id, scope, "error", `Remote tree truncated at ${blobs.length} files; clone left ready for repair`);
  } else {
    input.onProgress?.({ done: blobs.length, total: blobs.length, phase: "finalizing" });
    await markLocalRepositoryCloneComplete(meta.id, scope, cloneOperationId, blobs.length, headSha);
    await diagnostic({ meta, scope, operationId: cloneOperationId, operation: "clone", stage: "finalize", outcome: "success", startedAt, durationMs: Date.now() - Date.parse(startedAt), fileCount: blobs.length });
  }
  await addLocalRepoLog(meta.id, scope, "clone", `Cloned ${blobs.length} files from ${meta.branch}`);

  const finalMeta = await getLocalRepository(input.book.owner, input.book.repo, resolvedBranch, scope) ?? meta;
  return { meta: finalMeta, structure: await buildLocalBookStructure(finalMeta), cloned: true };
}

export async function migrateLegacyLocalRepository(input: { meta: LocalRepositoryMeta; token: string; accountIdentity: string; scope?: RepositoryOperationScope }): Promise<LocalRepositoryMeta> {
  const scope = input.scope ?? operationScope({ ...input.meta, accountIdentity: input.accountIdentity });
  assertRepositoryOperationScopeCurrent(scope);
  const migrationOperationId = crypto.randomUUID();
  const target = { ...input.meta, repoId: input.meta.id, accountIdentity: input.accountIdentity };
  const selected = await exactLocalRepository(target, scope);
  return withRepositoryMutationLease(selected.id, async () => {
    const claimed = await claimLegacyLocalRepositoryMigration(selected.id, scope, migrationOperationId);
    try {
      return await withLifecycleHeartbeat(claimed.id, scope, migrationOperationId, async () => {
      const octokit = trackedOctokit(input.token, { accountIdentity: input.accountIdentity, owner: input.meta.owner, repo: input.meta.repo, branch: input.meta.branch });
      const tree = await octokit.rest.git.getTree({ owner: claimed.owner, repo: claimed.repo, tree_sha: claimed.remoteHeadSha, recursive: "1" });
      if (tree.data.truncated) throw new Error("Remote tree is truncated; legacy local repository migration remains retryable.");
      const remoteBlobs = tree.data.tree.filter((entry) => entry.type === "blob" && entry.path && entry.sha).map((entry) => ({ path: entry.path!, sha: entry.sha! }));
      const localFiles = await listAllLocalFiles(claimed.id);
      const localByPath = new Map(localFiles.map((file) => [file.path, file]));
      const transferMeter = new RepositoryByteMeter("transfer", await repositoryTransferAllowance());
      let complete = localFiles.length === remoteBlobs.length && localFiles.every((file) => file.status === "clean" && !file.committed);
      for (const remote of remoteBlobs) {
        const local = localByPath.get(remote.path);
        if (!local || local.status !== "clean" || local.committed || local.baseSha !== remote.sha) { complete = false; continue; }
        const bytes = await fetchBlobBytesForRepository(input.token, claimed.owner, claimed.repo, remote.path, remote.sha, transferMeter);
        if (await sha256Bytes(bytes) !== local.currentHash) complete = false;
      }
      return await classifyLegacyLocalRepositoryMigration({ repoId: claimed.id, scope, migrationOperationId, expectedRemoteHeadSha: claimed.remoteHeadSha, expectedFiles: localFiles, expectedFileCount: remoteBlobs.length, complete });
      });
    } catch (error) {
      await releaseLegacyLocalRepositoryMigration(claimed.id, scope, migrationOperationId).catch(() => undefined);
      throw error;
    }
  });
}

/**
 * Fetch a single blob by its git object sha (exact content, independent of branch tip).
 */
export async function fetchBlobBytesForRepository(token: string, owner: string, repo: string, path: string, fileSha: string, meter: RepositoryByteMeter, signal?: AbortSignal): Promise<Uint8Array> {
  return fetchRepositoryBlobBytes({ token, owner, repo, path, sha: fileSha, kind: isTextPath(path) ? "text" : "binary", meter, signal });
}

export async function restoreLocalFilesToBase(input: {
  repoId: string;
  bookId: string;
  owner: string;
  repo: string;
  branch: string;
  accountIdentity: string;
  paths: string[];
  token?: string;
}): Promise<{ restored: number }> {
  const scope = operationScope(input);
  await exactLocalRepository(input, scope);
  const uniquePaths = [...new Set(input.paths)];
  if (!uniquePaths.length) return { restored: 0 };

  const selected = (await Promise.all(uniquePaths.map((path) => getLocalFileEntry(input.repoId, path, scope))))
     .filter((file): file is LocalRepositoryFile => Boolean(file && file.status !== "clean"));
  const remote = input.token ? trackedOctokit(input.token, input) : null;
  const deletes: string[] = [];
  const writes: Array<{ path: string; kind: "text"; text: string } | { path: string; kind: "binary"; bytes: Uint8Array }> = [];
  const transferMeter = new RepositoryByteMeter("mutation");
  const expected = new Map(selected.map((file) => [file.path, file.currentHash]));
  for (const file of selected) {
    if (file.status === "new") { deletes.push(file.path); continue; }
    if (!file.baseSha) throw new Error(`Cannot restore ${file.path} because its clean base snapshot is unavailable.`);
    if (!remote) throw new Error(`Cannot restore ${file.path} without a GitHub token for its clean base snapshot.`);
    const bytes = await fetchBlobBytesForRepository(input.token!, input.owner, input.repo, file.path, file.baseSha, transferMeter);
    writes.push(file.kind === "binary"
      ? { path: file.path, kind: "binary", bytes }
      : { path: file.path, kind: "text", text: new TextDecoder().decode(bytes) });
  }
  if (selected.length) await applyLocalFileChangesAtomically(input.repoId, scope, deletes, writes, expected);
  const restored = selected.length;

  if (restored) {
    await addLocalRepoLog(input.repoId, scope, "reset", `Restored ${restored} local file${restored === 1 ? "" : "s"} to the clean base state`);
  }
  return { restored };
}

/**
 * Heal an incomplete or unverified local clone: re-fetch any blob from the repo's
 * recorded head tree that is missing locally (or stored clean with a stale base sha),
 * without touching the user's dirty/uncommitted edits. Marks the repo clone-complete.
 */
export async function verifyAndRepairLocalRepository(input: {
  meta: LocalRepositoryMeta;
  token: string;
  accountIdentity: string;
  onProgress?: (progress: LocalCloneProgress) => void;
  scope?: RepositoryOperationScope;
}): Promise<{ meta: LocalRepositoryMeta; structure: BookStructure; repaired: number }> {
  const { meta, token } = input;
  const scope = input.scope ?? operationScope({ ...meta, accountIdentity: input.accountIdentity });
  assertRepositoryOperationScopeCurrent(scope);
  const repairOperationId = crypto.randomUUID();
  const target = { ...meta, repoId: meta.id, accountIdentity: input.accountIdentity };
  const selected = await exactLocalRepository(target, scope);
  return withRepositoryMutationLease(selected.id, async () => {
    const claimed = await claimLocalRepositoryRepair(selected.id, scope, repairOperationId);
    const startedAt = new Date().toISOString();
    await diagnostic({ meta: claimed, scope, operationId: repairOperationId, operation: "repair", stage: "start", outcome: "started", startedAt });
    try {
      const result = await withLifecycleHeartbeat(claimed.id, scope, repairOperationId, () => verifyAndRepairLocalRepositoryLeased(claimed, token, scope, repairOperationId, input.onProgress));
      await diagnostic({ meta: claimed, scope, operationId: repairOperationId, operation: "repair", stage: "finalize", outcome: "success", startedAt, durationMs: Date.now() - Date.parse(startedAt), fileCount: result.repaired });
      return result;
    } catch (error) {
      await releaseLocalRepositoryRepair(claimed.id, scope, repairOperationId).catch(() => undefined);
      const classified = classifyRepositoryError(error, "compare");
      await diagnostic({ meta: claimed, scope, operationId: repairOperationId, operation: "repair", stage: "download", outcome: classified.kind === "abort" ? "cancelled" : "failure", startedAt, durationMs: Date.now() - Date.parse(startedAt), error: classified });
      throw error;
    }
  });
}

export async function recoverExpiredRepositoryLifecycle(input: {
  meta: LocalRepositoryMeta;
  token: string;
  accountIdentity: string;
  onProgress?: (progress: LocalCloneProgress) => void;
  scope?: RepositoryOperationScope;
}): Promise<{ meta: LocalRepositoryMeta; structure: BookStructure; repaired: number }> {
  const scope = input.scope ?? operationScope({ ...input.meta, accountIdentity: input.accountIdentity });
  assertRepositoryOperationScopeCurrent(scope);
  const operationId = crypto.randomUUID();
  const reclaimed = await reclaimExpiredRepositoryLifecycleLease(input.meta.id, scope, operationId);
  if (reclaimed.cloneStatus === "cloning") {
    await markLocalRepositoryRepairRequired(reclaimed.id, scope, operationId);
  } else if (reclaimed.cloneStatus === "migrating") {
    await releaseLegacyLocalRepositoryMigration(reclaimed.id, scope, operationId);
    const legacy = await getLocalRepositoryById(reclaimed.id, input.accountIdentity);
    if (!legacy) throw new RepositoryOwnershipChangedError();
    const migrated = await migrateLegacyLocalRepository({ meta: legacy, token: input.token, accountIdentity: input.accountIdentity, scope });
    if (migrated.cloneComplete === true) return { meta: migrated, structure: await buildLocalBookStructure(migrated), repaired: 0 };
  } else if (reclaimed.cloneStatus === "repairing") {
    await releaseLocalRepositoryRepair(reclaimed.id, scope, operationId);
  }
  const retryable = await getLocalRepositoryById(reclaimed.id, input.accountIdentity);
  if (!retryable) throw new RepositoryOwnershipChangedError();
  return verifyAndRepairLocalRepository({ meta: retryable, token: input.token, accountIdentity: input.accountIdentity, onProgress: input.onProgress, scope });
}

async function verifyAndRepairLocalRepositoryLeased(
  meta: LocalRepositoryMeta,
  token: string,
  scope: RepositoryOperationScope,
  repairOperationId: string,
  onProgress?: (progress: LocalCloneProgress) => void,
): Promise<{ meta: LocalRepositoryMeta; structure: BookStructure; repaired: number }> {
  const octokit = trackedOctokit(token, { accountIdentity: scope.accountIdentity, owner: meta.owner, repo: meta.repo, branch: meta.branch });
  // Verify against the head the local repo claims to be at, so we restore exactly that
  // tree; the normal fetch/pull flow advances to any newer remote head afterwards.
  const treeSha = meta.remoteHeadSha;
  const tree = await octokit.rest.git.getTree({ owner: meta.owner, repo: meta.repo, tree_sha: treeSha, recursive: "1" });
  const remoteBlobs = tree.data.tree
    .filter((item) => item.type === "blob" && item.path && item.sha)
    .map((item) => ({ path: item.path!, sha: item.sha!, size: item.size ?? 0 }));
  if (tree.data.truncated) {
    await addLocalRepoLog(meta.id, scope, "error", "Repository verification stopped because the remote tree is truncated");
    throw new Error("Remote tree is truncated; local clone repair stopped without deleting files.");
  }

  const localFiles = await listAllLocalFiles(meta.id);
  const localByPath = new Map(localFiles.map((file) => [file.path, file]));
  const remotePaths = new Set(remoteBlobs.map((blob) => blob.path));
  const missing: typeof remoteBlobs = [];
  const verifiedRemoteBytes = new Map<string, Uint8Array>();
  const transferMeter = new RepositoryByteMeter("transfer", await repositoryTransferAllowance());
  for (const blob of remoteBlobs) {
    const local = localByPath.get(blob.path);
    if (!local) { missing.push(blob); continue; }
    if (local.status !== "clean" || local.committed) continue;
    const actualBytes = local.kind === "text" ? new TextEncoder().encode(local.text ?? "") : new Uint8Array(await (local.blob ?? new Blob()).arrayBuffer());
    const actualHash = await sha256Bytes(actualBytes);
    const remoteBytes = await fetchBlobBytesForRepository(token, meta.owner, meta.repo, blob.path, blob.sha, transferMeter);
    verifiedRemoteBytes.set(blob.path, remoteBytes);
    const remoteHash = await sha256Bytes(remoteBytes);
    if (local.baseSha !== blob.sha || local.currentHash !== actualHash || actualHash !== remoteHash) missing.push(blob);
  }

  let done = 0;
  onProgress?.({ done, total: missing.length });
  const prepared = new Map<string, RemoteTreeFile>();
  await mapLimit(missing, 5, async (blob) => {
    const bytes = verifiedRemoteBytes.get(blob.path) ?? await fetchBlobBytesForRepository(token, meta.owner, meta.repo, blob.path, blob.sha, transferMeter);
    const kind = isTextPath(blob.path) ? "text" as const : "binary" as const;
    prepared.set(blob.path, { path: blob.path, kind, text: kind === "text" ? new TextDecoder().decode(bytes) : undefined, blob: kind === "binary" ? new Blob([bytesToArrayBuffer(bytes)]) : undefined, baseSha: blob.sha, size: bytes.byteLength });
    done += 1;
    onProgress?.({ done, total: missing.length, path: blob.path });
  });

  const unexpectedClean = localFiles.filter((file) => file.status === "clean" && !file.committed && !remotePaths.has(file.path));
  const represented = new Set(localFiles.filter((file) => file.status !== "deleted" && !unexpectedClean.some((unexpected) => unexpected.path === file.path)).map((file) => file.path));
  for (const path of prepared.keys()) represented.add(path);
  const complete = remoteBlobs.every((blob) => represented.has(blob.path));
  if (!complete) throw new Error("Local repository verification did not store every remote file.");
  assertRepositoryAggregateBytes(transferMeter.measuredBytes, "transfer", await repositoryTransferAllowance());
  await applyCloneRepairAtomically({
    repoId: meta.id,
    scope,
    repairOperationId,
    expectedRemoteHeadSha: treeSha,
    expectedFiles: localFiles,
    writes: [...prepared.values()],
    deletePaths: unexpectedClean.map((file) => file.path),
    expectedFileCount: remoteBlobs.length,
  });
  if (missing.length || unexpectedClean.length) await addLocalRepoLog(meta.id, scope, "pull", `Repaired ${missing.length} missing and ${unexpectedClean.length} unexpected clean file(s) on ${meta.branch}`);

  const updated = await getLocalRepository(meta.owner, meta.repo, meta.branch, scope) ?? meta;
  return { meta: updated, structure: await buildLocalBookStructure(updated), repaired: missing.length };
}

export async function getExistingLocalBookStructure(bookId: string, owner: string, repo: string, branch: string, accountIdentity: string): Promise<{ meta: LocalRepositoryMeta; structure: BookStructure } | null> {
  const scope = operationScope({ bookId, owner, repo, branch, accountIdentity });
  const meta = await getLocalRepository(owner, repo, branch, scope);
  if (meta && meta.bookId !== bookId) return null;
  return meta ? { meta, structure: await buildLocalBookStructure(meta) } : null;
}

export async function commitLocalChanges(target: ExactRepositoryTarget, message: string) {
  const scope = operationScope(target);
  const meta = await exactLocalRepository(target, scope);
  const dirty = await listDirtyLocalFiles(meta.id);
  const commit = await createLocalCommit(meta.id, scope, message.trim() || autoCommitMessage(dirty.map((file) => file.path)));
  await addLocalRepoLog(meta.id, scope, "commit", `Committed ${commit.files.length} files: ${commit.message}`);
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

export async function fetchRemoteStatus(input: ExactRepositoryTarget & { token: string; signal?: AbortSignal }): Promise<RemoteStatusResult> {
  const scope = operationScope(input);
  const meta = await exactLocalRepository(input, scope);
  const operationId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  await diagnostic({ meta, scope, operationId, operation: "fetch", stage: "start", outcome: "started", startedAt });
  let previous: Awaited<ReturnType<typeof markLocalRepositoryRemoteChecking>> | undefined;
  try {
    previous = await markLocalRepositoryRemoteChecking(meta.id, scope, meta.remoteHeadSha);
    const octokit = trackedOctokit(input.token, input);
    const { remoteHeadSha, changed } = await resolveRemoteChangeState(octokit, meta, input.signal);
    input.signal?.throwIfAborted();
    const acceptedChanged = await markLocalRepositoryRemoteCheck(meta.id, scope, meta.remoteHeadSha, remoteHeadSha, changed);
    await diagnostic({ meta, scope, operationId, operation: "fetch", stage: "remote-read", outcome: "success", startedAt, durationMs: Date.now() - Date.parse(startedAt) });
    await addLocalRepoLog(meta.id, scope, "fetch", acceptedChanged ? `Remote changed: ${remoteHeadSha.slice(0, 7)}` : "Remote up to date");
    return { remoteHeadSha, changed: acceptedChanged };
  } catch (error) {
    const classified = classifyRepositoryError(error, "read");
    await markLocalRepositoryRemoteFailure(meta.id, scope, meta.remoteHeadSha, classified.kind, previous).catch(() => undefined);
    await diagnostic({ meta, scope, operationId, operation: "fetch", stage: "remote-read", outcome: classified.kind === "abort" ? "cancelled" : "failure", startedAt, durationMs: Date.now() - Date.parse(startedAt), error: classified });
    throw classified;
  }
}

async function resolveRemoteChangeState(octokit: Octokit, meta: LocalRepositoryMeta, signal?: AbortSignal): Promise<RemoteChangeState> {
  signal?.throwIfAborted();
  const ref = await octokit.rest.git.getRef({ owner: meta.owner, repo: meta.repo, ref: `heads/${meta.branch}`, request: { signal } });
  const remoteHeadSha = ref.data.object.sha;
  if (remoteHeadSha === meta.remoteHeadSha) return { remoteHeadSha, changed: false };
  try {
    const [currentCommit, remoteCommit] = await Promise.all([
      octokit.rest.git.getCommit({ owner: meta.owner, repo: meta.repo, commit_sha: meta.remoteHeadSha, request: { signal } }),
      octokit.rest.git.getCommit({ owner: meta.owner, repo: meta.repo, commit_sha: remoteHeadSha, request: { signal } }),
    ]);
    return { remoteHeadSha, changed: currentCommit.data.tree.sha !== remoteCommit.data.tree.sha };
  } catch (error) {
    signal?.throwIfAborted();
    throw classifyRepositoryError(error, "compare");
  }
}

export interface RepositoryTokenHealthResult extends TokenHealth {
  repository: string;
}

export async function checkRepositoryTokenHealth(input: Pick<ExactRepositoryTarget, "owner" | "repo" | "branch" | "accountIdentity"> & { token: string }): Promise<RepositoryTokenHealthResult> {
  const target = tokenHealthTarget(input);
  const octokit = trackedOctokit(input.token, input);
  try {
    const repository = await octokit.rest.repos.get({ owner: input.owner, repo: input.repo });
    const ref = await octokit.rest.git.getRef({ owner: input.owner, repo: input.repo, ref: `heads/${input.branch}` });
    const expiresAt = tokenExpirationFromHeaders(repository.headers as Record<string, unknown>) ?? tokenExpirationFromHeaders(ref.headers as Record<string, unknown>);
    const health = await recordRepositoryReadValidated(target, expiresAt);
    return { ...health, repository: `${input.owner}/${input.repo}` };
  } catch (error) {
    const classified = classifyRepositoryError(error, "read");
    const denied = classified.kind === "credential-invalid" || classified.kind === "permission" || classified.kind === "permission-unverified" || classified.kind === "sso-required";
    await writeTokenHealth(target, { lastValidated: new Date().toISOString(), permissionStatus: denied ? "denied" : "unknown", errorKind: classified.kind });
    throw classified;
  }
}

export async function pullRemoteChanges(input: ExactRepositoryTarget & {
  token: string;
  mode?: "safe" | "remote-wins";
  confirmed?: boolean;
  signal?: AbortSignal;
}): Promise<{ updated: number; remoteHeadSha: string; recoveryId?: string }> {
  const scope = operationScope(input);
  const selected = await exactLocalRepository(input, scope);
  return withRepositoryMutationLease(selected.id, async () => pullRemoteChangesLeased(await exactLocalRepository(input, scope), input, scope));
}

async function pullRemoteChangesLeased(meta: LocalRepositoryMeta, input: ExactRepositoryTarget & {
  token: string;
  mode?: "safe" | "remote-wins";
  confirmed?: boolean;
  signal?: AbortSignal;
}, scope: RepositoryOperationScope): Promise<{ updated: number; remoteHeadSha: string; recoveryId?: string }> {
  const operationId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  await diagnostic({ meta, scope, operationId, operation: "pull", stage: "start", outcome: "started", startedAt });
  const dirty = await listDirtyLocalFiles(meta.id);
  const ahead = await listUnpushedLocalCommits(meta.id);
  const destructive = input.mode === "remote-wins";
  if ((dirty.length || ahead.length) && !destructive) {
    await diagnostic({ meta, scope, operationId, operation: "pull", stage: "merge", outcome: "failure", startedAt, durationMs: Date.now() - Date.parse(startedAt), error: new Error("Pull requires confirmation") });
    throw new Error("Pull requires a clean working copy. Use the confirmed remote-wins recovery action to discard local work.");
  }
  if (destructive && !input.confirmed) {
    await diagnostic({ meta, scope, operationId, operation: "pull", stage: "merge", outcome: "failure", startedAt, durationMs: Date.now() - Date.parse(startedAt), error: new Error("Remote-wins pull requires confirmation") });
    throw new Error("Remote-wins pull requires explicit confirmation.");
  }

  let previous: Awaited<ReturnType<typeof markLocalRepositoryRemoteChecking>> | undefined;
  try {
  previous = await markLocalRepositoryRemoteChecking(meta.id, scope, meta.remoteHeadSha);
  const octokit = trackedOctokit(input.token, input);
  const { remoteHeadSha, changed } = await resolveRemoteChangeState(octokit, meta, input.signal);
  input.signal?.throwIfAborted();
  if (remoteHeadSha === meta.remoteHeadSha && !dirty.length && !ahead.length) {
    await markLocalRepositoryRemoteCheck(meta.id, scope, meta.remoteHeadSha, remoteHeadSha, false);
    await diagnostic({ meta, scope, operationId, operation: "pull", stage: "finalize", outcome: "success", startedAt, durationMs: Date.now() - Date.parse(startedAt) });
    return { updated: 0, remoteHeadSha };
  }
  if (!changed && !dirty.length && !ahead.length) {
    await updateLocalRepositoryHead(meta.id, scope, remoteHeadSha);
    await addLocalRepoLog(meta.id, scope, "pull", `Remote head changed to ${remoteHeadSha.slice(0, 7)} with no file-content differences`);
    await diagnostic({ meta, scope, operationId, operation: "pull", stage: "finalize", outcome: "success", startedAt, durationMs: Date.now() - Date.parse(startedAt) });
    return { updated: 0, remoteHeadSha };
  }
  const remoteTree = await octokit.rest.git.getTree({ owner: meta.owner, repo: meta.repo, tree_sha: remoteHeadSha, recursive: "1", request: { signal: input.signal } });
  if (remoteTree.data.truncated) throw new Error("Remote tree is truncated; pull stopped without advancing the local head.");
  const remoteBlobEntries = (remoteTree.data.tree ?? []).filter((entry) => entry.type === "blob" && entry.path);
  const remoteByPath = new Map(remoteBlobEntries.map((entry) => [entry.path!, entry.sha!]));
  const localFiles = await listAllLocalFiles(meta.id);
  const prepared: RemoteTreeFile[] = [];
  const transferMeter = new RepositoryByteMeter("transfer", await repositoryTransferAllowance());
  let updated = localFiles.filter((file) => !remoteByPath.has(file.path)).length;
  for (const [path, blobSha] of remoteByPath) {
    input.signal?.throwIfAborted();
    const local = localFiles.find((file) => file.path === path);
    let bytes: Uint8Array;
    if (local?.baseSha === blobSha && local.status === "clean" && !local.committed) {
      bytes = local.kind === "text" ? new TextEncoder().encode(local.text ?? "") : new Uint8Array(await (local.blob ?? new Blob()).arrayBuffer());
    } else {
      bytes = await fetchBlobBytesForRepository(input.token, meta.owner, meta.repo, path, blobSha, transferMeter, input.signal);
      updated += 1;
    }
    const kind = isTextPath(path) ? "text" as const : "binary" as const;
    prepared.push({ path, kind, text: kind === "text" ? new TextDecoder().decode(bytes) : undefined, blob: kind === "binary" ? new Blob([bytesToArrayBuffer(bytes)]) : undefined, baseSha: blobSha, size: bytes.byteLength });
  }
  input.signal?.throwIfAborted();
  const pullRecoveryBytes = localFiles.reduce((sum, file) => sum + file.size, 0);
  assertRepositoryAggregateBytes(transferMeter.measuredBytes + pullRecoveryBytes, "transfer", await repositoryTransferAllowance());
  const recovery = await replaceLocalTreeAtomically(
    meta.id,
    scope,
    remoteHeadSha,
    prepared,
    localFiles,
    ahead.map((commit) => commit.id),
    `Before ${destructive ? "remote-wins" : "clean"} pull to ${remoteHeadSha}`,
    !destructive,
  );
  const recoveryId = recovery.id;
    await addLocalRepoLog(meta.id, scope, "pull", `Pulled ${updated} files from remote${recoveryId ? ` after recovery snapshot ${recoveryId}` : ""}`);
    await diagnostic({ meta, scope, operationId, operation: "pull", stage: "finalize", outcome: "success", startedAt, durationMs: Date.now() - Date.parse(startedAt), fileCount: updated });
  return { updated, remoteHeadSha, ...(recoveryId ? { recoveryId } : {}) };
  } catch (error) {
    const classified = classifyRepositoryError(error, "compare");
    await markLocalRepositoryRemoteFailure(meta.id, scope, meta.remoteHeadSha, classified.kind, previous).catch(() => undefined);
    await diagnostic({ meta, scope, operationId, operation: "pull", stage: "merge", outcome: classified.kind === "abort" ? "cancelled" : "failure", startedAt, durationMs: Date.now() - Date.parse(startedAt), error: classified });
    throw error instanceof RepositoryOwnershipChangedError || classified.kind === "unknown" ? error : classified;
  }
}

export async function restoreRepositoryRecovery(input: ExactRepositoryTarget & { recoveryId: string }): Promise<{ recovery: LocalRepositoryRecovery; structure: BookStructure }> {
  const scope = operationScope(input);
  const target = await exactLocalRepository(input, scope);
  const snapshot = await getLocalRecoverySnapshot(input.recoveryId, input.accountIdentity);
  assertRepositoryOperationScopeCurrent(scope);
  if (!snapshot?.repository) throw new Error("Recovery snapshot is unavailable or uses an unsupported legacy format.");
  const snapshotMeta = snapshot.repository;
  if (snapshotMeta.bookId !== input.bookId || snapshotMeta.owner !== input.owner || snapshotMeta.repo !== input.repo || snapshotMeta.branch !== input.branch || snapshotMeta.id !== snapshot.repoId) {
    throw new Error("Recovery snapshot does not match the requested book and branch.");
  }
  const recovery = await withRepositoryMutationLease(target.id, async () => {
    const current = await exactLocalRepository(input, scope);
    return restoreLocalRecoverySnapshot(input.recoveryId, scope, {
      repoId: current.id, bookId: current.bookId, owner: current.owner, repo: current.repo, branch: current.branch,
    });
  });
  const meta = recovery.repository;
  await addLocalRepoLog(meta.id, scope, "reset", `Restored recovery snapshot ${recovery.id}`);
  return { recovery, structure: await buildLocalBookStructure(meta) };
}

export class AmbiguousLocalPushError extends Error {
  constructor(message: string, readonly generatedCommitSha: string, readonly cause?: unknown) {
    super(message);
    this.name = "AmbiguousLocalPushError";
  }
}

export async function pushLocalCommits(input: PushLocalCommitsInput): Promise<PushResult> {
  input.signal?.throwIfAborted();
  const scope = operationScope(input);
  const selected = await exactLocalRepository(input, scope);
  const operationId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  await diagnostic({ meta: selected, scope, operationId, operation: "push", stage: "start", outcome: "started", startedAt });
  try {
    const result = await withRepositoryMutationLease(selected.id, async () => {
      const meta = await exactLocalRepository(input, scope);
      return pushLocalCommitsLocked(meta, input, scope);
    });
    await diagnostic({ meta: selected, scope, operationId, operation: "push", stage: "push", outcome: "success", startedAt, durationMs: Date.now() - Date.parse(startedAt), fileCount: result.files, commitSha: result.commitSha });
    return result;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      await diagnostic({ meta: selected, scope, operationId, operation: "push", stage: "push", outcome: "cancelled", startedAt, durationMs: Date.now() - Date.parse(startedAt), error, errorOperation: "update" });
      throw error;
    }
    if (error instanceof RepositoryOwnershipChangedError || error instanceof RemoteHeadMismatchError || error instanceof AmbiguousLocalPushError) {
      await diagnostic({ meta: selected, scope, operationId, operation: "push", stage: "push", outcome: "failure", startedAt, durationMs: Date.now() - Date.parse(startedAt), error, errorOperation: "update" });
      throw error;
    }
    const record = error && typeof error === "object" ? error as { status?: unknown; response?: unknown; name?: unknown } : undefined;
    if (error instanceof RepositoryError || typeof record?.status === "number" || record?.response || record?.name === "TypeError" || record?.name === "AbortError") {
      const classified = classifyRepositoryError(error, "update");
      await diagnostic({ meta: selected, scope, operationId, operation: "push", stage: "push", outcome: classified.kind === "abort" ? "cancelled" : "failure", startedAt, durationMs: Date.now() - Date.parse(startedAt), error: classified, errorOperation: "update" });
      throw classified;
    }
    await diagnostic({ meta: selected, scope, operationId, operation: "push", stage: "push", outcome: "failure", startedAt, durationMs: Date.now() - Date.parse(startedAt), error, errorOperation: "update" });
    throw error;
  }
}

async function pushLocalCommitsLocked(meta: LocalRepositoryMeta, input: PushLocalCommitsInput, scope: RepositoryOperationScope): Promise<PushResult> {
  input.signal?.throwIfAborted();
  const dirty = await listDirtyLocalFiles(meta.id);
  input.signal?.throwIfAborted();
  if (dirty.length) throw new Error("Commit local changes before pushing.");
  const commits = await listUnpushedLocalCommits(meta.id);
  input.signal?.throwIfAborted();
  if (!commits.length) throw new Error("No local commits to push.");

  const octokit = trackedOctokit(input.token, input);
  const request = { request: { signal: input.signal } };
  const ref = await octokit.rest.git.getRef({ owner: meta.owner, repo: meta.repo, ref: `heads/${meta.branch}`, ...request });
  input.signal?.throwIfAborted();
  const remoteHeadSha = ref.data.object.sha;
  const expectedRemoteHeadSha = input.expectedRemoteHeadSha ?? meta.remoteHeadSha;
  if (remoteHeadSha !== expectedRemoteHeadSha && !(input.allowRemoteOverwrite && input.confirmed)) {
    throw new RemoteHeadMismatchError(expectedRemoteHeadSha, remoteHeadSha);
  }
  const baseCommit = await octokit.rest.git.getCommit({ owner: meta.owner, repo: meta.repo, commit_sha: remoteHeadSha, ...request });
  input.signal?.throwIfAborted();
  const files = await listAllLocalFiles(meta.id);
  input.signal?.throwIfAborted();
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  const committedByPath = new Map<string, LocalCommitFile>();
  for (const commit of commits) for (const file of commit.files) committedByPath.set(file.path, file);
  const changedPaths = new Map<string, LocalRepositoryFile | null>();
  for (const file of committedByPath.values()) {
    const current = fileByPath.get(file.path);
    const matchesCommit = current?.committed === true
      && current.currentHash === file.hash
      && current.kind === file.kind
      && (file.status === "deleted" ? current.status === "deleted" : current.status === "clean");
    if (!matchesCommit) throw new Error(`Local file changed after it was committed: ${file.path}`);
    changedPaths.set(file.path, file.status === "deleted" ? null : current);
  }

  const pushMeter = new RepositoryByteMeter("mutation");
  for (const file of changedPaths.values()) {
    if (!file) continue;
    const size = file.kind === "text" ? utf8Bytes(file.text ?? "") : file.blob?.size ?? 0;
    pushMeter.add(file.kind, size);
  }

  // A deletion entry whose path is a directory (or missing) on the remote tree
  // triggers GitRPC::BadObjectState. Only keep deletions that target an actual blob.
  const remoteBlobPaths = new Set<string>();
  let baseTreeTruncated = false;
  try {
    const baseTree = await octokit.rest.git.getTree({ owner: meta.owner, repo: meta.repo, tree_sha: baseCommit.data.tree.sha, recursive: "1", ...request });
    baseTreeTruncated = Boolean(baseTree.data.truncated);
    for (const entry of baseTree.data.tree ?? []) {
      if (entry.type === "blob" && entry.path) remoteBlobPaths.add(entry.path);
    }
  } catch {
    input.signal?.throwIfAborted();
    // If we cannot read the base tree, fall back to attempting all deletions.
  }
  input.signal?.throwIfAborted();
  if (baseTreeTruncated) throw new Error("Remote base tree is truncated; push stopped before planning changes.");

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
    const blob = await createBlobForFile(octokit, meta, file, input.signal);
    treeEntries.push({ path, mode: "100644", type: "blob", sha: blob });
    pushedShas[path] = blob;
  }
  if (treeEntries.length === 0) {
    // Nothing valid to push (e.g. only stale directory-deletions). Mark commits
    // pushed against the current remote head so the local state settles.
    const settlement = await markLocalCommitsPushed(meta.id, scope, commits.map((entry) => entry.id), remoteHeadSha, pushedShas);
    await addLocalRepoLog(meta.id, scope, settlement.skippedPaths.length ? "error" : "push", settlement.skippedPaths.length
      ? `Push settled with newer local edits preserved for recovery: ${settlement.skippedPaths.join(", ")}`
      : `No pushable changes; settled local commits at ${remoteHeadSha.slice(0, 7)}`);
    return { commitSha: remoteHeadSha, files: 0, ...(settlement.skippedPaths.length ? { recoveryPaths: settlement.skippedPaths } : {}) };
  }
  input.signal?.throwIfAborted();
  const tree = await octokit.rest.git.createTree({ owner: meta.owner, repo: meta.repo, base_tree: baseCommit.data.tree.sha, tree: treeEntries, ...request });
  input.signal?.throwIfAborted();
  const commit = await octokit.rest.git.createCommit({ owner: meta.owner, repo: meta.repo, message: commits.map((entry) => entry.message).join("\n\n"), tree: tree.data.sha, parents: [remoteHeadSha], ...request });
  input.signal?.throwIfAborted();
  try {
    await octokit.rest.git.updateRef({ owner: meta.owner, repo: meta.repo, ref: `heads/${meta.branch}`, sha: commit.data.sha, ...request });
  } catch (error) {
    const classified = classifyRepositoryError(error, "update");
    if (["branch-protected", "credential-invalid", "permission", "permission-unverified", "sso-required"].includes(classified.kind)) throw classified;
    const reconciled = await reconcileRemoteMutation({
      octokit,
      owner: meta.owner,
      repo: meta.repo,
      branch: meta.branch,
      generatedCommitSha: commit.data.sha,
      revisions: Object.entries(pushedShas).map(([path, blobSha]) => ({ path, blobSha })),
    });
    if (reconciled.landed && reconciled.headSha) {
      await recordRepositoryWriteValidated(tokenHealthTarget(input));
      const settlement = await markLocalCommitsPushed(meta.id, scope, commits.map((entry) => entry.id), reconciled.headSha, reconciled.blobShas ?? pushedShas);
      await addLocalRepoLog(meta.id, scope, settlement.skippedPaths.length ? "error" : "push", settlement.skippedPaths.length
        ? `Push reconciled with newer local edits preserved for recovery: ${settlement.skippedPaths.join(", ")}`
        : `Push reconciled at ${reconciled.headSha.slice(0, 7)}`);
      return { commitSha: reconciled.headSha, files: treeEntries.length, ...(settlement.skippedPaths.length ? { recoveryPaths: settlement.skippedPaths } : {}) };
    }
    throw new AmbiguousLocalPushError("The local push ref update had an ambiguous outcome.", commit.data.sha, error);
  }
  await recordRepositoryWriteValidated(tokenHealthTarget(input));
  const settlement = await markLocalCommitsPushed(meta.id, scope, commits.map((entry) => entry.id), commit.data.sha, pushedShas);
  await addLocalRepoLog(meta.id, scope, settlement.skippedPaths.length ? "error" : "push", settlement.skippedPaths.length
    ? `Push completed with newer local edits preserved for recovery: ${settlement.skippedPaths.join(", ")}`
    : `Pushed ${treeEntries.length} files to ${commit.data.sha.slice(0, 7)} (local wins)`);
  return { commitSha: commit.data.sha, files: treeEntries.length, ...(settlement.skippedPaths.length ? { recoveryPaths: settlement.skippedPaths } : {}) };
}

export async function syncFullRepository(input: ExactRepositoryTarget & { token: string; conflictResolutions?: Record<string, RepositorySyncConflictChoice> }): Promise<SyncResult> {
  const scope = operationScope(input);
  const selected = await exactLocalRepository(input, scope);
  const operationId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  await diagnostic({ meta: selected, scope, operationId, operation: "sync", stage: "start", outcome: "started", startedAt });
  try {
    const result = await withRepositoryMutationLease(selected.id, async () => syncFullRepositoryLeased(await exactLocalRepository(input, scope), input, scope));
    await diagnostic({ meta: selected, scope, operationId, operation: "sync", stage: "finalize", outcome: "success", startedAt, durationMs: Date.now() - Date.parse(startedAt), fileCount: result.pulled + result.committed, });
    return result;
  } catch (error) {
    const classified = classifyRepositoryError(error, "compare");
    await diagnostic({ meta: selected, scope, operationId, operation: "sync", stage: "merge", outcome: classified.kind === "abort" ? "cancelled" : "failure", startedAt, durationMs: Date.now() - Date.parse(startedAt), error: classified });
    throw error;
  }
}

async function syncFullRepositoryLeased(meta: LocalRepositoryMeta, input: ExactRepositoryTarget & { token: string; conflictResolutions?: Record<string, RepositorySyncConflictChoice> }, scope: RepositoryOperationScope): Promise<SyncResult> {
  const previous = await markLocalRepositoryRemoteChecking(meta.id, scope, meta.remoteHeadSha);
  try {
  const pendingBeforeSync = await listUnpushedLocalCommits(meta.id);
  const octokit = trackedOctokit(input.token, input);
  const { remoteHeadSha, changed: remoteChanged } = await resolveRemoteChangeState(octokit, meta);
  let pulled = 0;
  let keptLocal = 0;
  let syncPreflightIncludesRecovery = false;
  if (remoteChanged) {
    const remoteTree = await octokit.rest.git.getTree({ owner: meta.owner, repo: meta.repo, tree_sha: remoteHeadSha, recursive: "1" });
    if (remoteTree.data.truncated) throw new Error("Remote tree is truncated; sync stopped without advancing the local head.");
    const remoteBlobEntries = (remoteTree.data.tree ?? []).filter((entry) => entry.type === "blob" && entry.path);
    const remoteByPath = new Map(remoteBlobEntries.map((entry) => [entry.path!, entry.sha!]));
    const localFiles = await listAllLocalFiles(meta.id);
    const localByPath = new Map(localFiles.map((file) => [file.path, file]));
    const conflicts: RepositorySyncConflict[] = [];
    const remoteBytes = new Map<string, Uint8Array>();
    const transferMeter = new RepositoryByteMeter("transfer", await repositoryTransferAllowance());
    const deletes: string[] = [];
    const writes: Array<{ path: string; sha: string; bytes: Uint8Array; kind: "text" | "binary" }> = [];
    const seenResolutions = new Set<string>();
    let staleChoices = false;
    for (const path of new Set([...localByPath.keys(), ...remoteByPath.keys()])) {
      const local = localByPath.get(path);
      const remoteSha = remoteByPath.get(path);
      const localChanged = Boolean(local && (local.status !== "clean" || local.committed));
      const remoteChangedFromBase = local ? remoteSha !== local.baseSha : remoteSha !== undefined;
      const resolution = input.conflictResolutions?.[path];
      if (resolution) {
        seenResolutions.add(path);
        const localDeleted = !local || local.status === "deleted";
        const remoteDeleted = !remoteSha;
        const resolutionStillMatches = resolution.expectedLocalHash === (local?.currentHash ?? null)
          && resolution.expectedRemoteSha === (remoteSha ?? null)
          && resolution.expectedLocalDeleted === localDeleted
          && resolution.expectedRemoteDeleted === remoteDeleted
          && resolution.expectedLocalBaseSha === (local?.baseSha ?? null)
          && resolution.expectedLocalChanged === localChanged;
        if (!resolutionStillMatches) staleChoices = true;
        else if (resolution.choice === "local") {
          if (localChanged) keptLocal += 1;
          continue;
        } else {
          if (!remoteSha) deletes.push(path);
          else {
            const bytes = await fetchBlobBytesForRepository(input.token, meta.owner, meta.repo, path, remoteSha, transferMeter);
            remoteBytes.set(path, bytes);
            writes.push({ path, sha: remoteSha, bytes, kind: isTextPath(path) ? "text" : "binary" });
          }
          continue;
        }
      }
      if (localChanged && remoteChangedFromBase) {
        const bytes = remoteSha
          ? await fetchBlobBytesForRepository(input.token, meta.owner, meta.repo, path, remoteSha, transferMeter)
          : null;
        if (remoteSha && bytes && local && local.status !== "deleted") {
          remoteBytes.set(path, bytes);
          const remoteHash = await sha256Bytes(bytes);
          if (remoteHash === local.currentHash) {
            writes.push({ path, sha: remoteSha, bytes, kind: local.kind });
            continue;
          }
        } else if (!remoteSha && local?.status === "deleted") {
          deletes.push(path);
          continue;
        }
        const kind = local?.kind ?? (isTextPath(path) ? "text" : "binary");
        conflicts.push({
          path,
          kind,
          localContent: kind === "text" && local?.status !== "deleted" ? local?.text ?? "" : null,
          remoteContent: kind === "text" && bytes ? new TextDecoder().decode(bytes) : null,
          localDeleted: !local || local.status === "deleted",
          remoteDeleted: !remoteSha,
          localHash: local?.currentHash ?? null,
          remoteSha: remoteSha ?? null,
          localBaseSha: local?.baseSha ?? null,
          localChanged,
        });
        continue;
      }
      if (localChanged) {
        keptLocal += 1;
        continue;
      }
      if (!remoteSha) {
        if (local) deletes.push(path);
        continue;
      }
      if (local?.baseSha === remoteSha) continue;
      const bytes = remoteBytes.get(path) ?? await fetchBlobBytesForRepository(input.token, meta.owner, meta.repo, path, remoteSha, transferMeter);
      writes.push({ path, sha: remoteSha, bytes, kind: isTextPath(path) ? "text" : "binary" });
    }
    if (Object.keys(input.conflictResolutions ?? {}).some((path) => !seenResolutions.has(path))) staleChoices = true;
    if (staleChoices) throw new RepositorySyncChoiceStaleError(conflicts);
    if (conflicts.length) throw new RepositorySyncConflictError(conflicts);
    const recoveryBytes = pendingBeforeSync.length ? localFiles.reduce((sum, file) => sum + file.size, 0) + transferMeter.measuredBytes : 0;
    assertRepositoryAggregateBytes(transferMeter.measuredBytes + recoveryBytes, "transfer", await repositoryTransferAllowance());
    const resolvedRemoteConflict = Object.values(input.conflictResolutions ?? {}).some((resolution) => resolution.choice === "remote");
    if (pendingBeforeSync.length > 0 || resolvedRemoteConflict) {
      await createLocalRecoverySnapshot(meta.id, `Before conflict-aware full sync from ${meta.remoteHeadSha}`, scope);
      syncPreflightIncludesRecovery = true;
    }
    await applyRemoteMergeAtomically({
      repoId: meta.id,
      scope,
      remoteHeadSha,
      expectedFiles: localFiles,
      deletes,
      writes: writes.map(({ path, sha, bytes, kind }) => ({ path, kind, text: kind === "text" ? new TextDecoder().decode(bytes) : undefined, blob: kind === "binary" ? new Blob([bytesToArrayBuffer(bytes)]) : undefined, baseSha: sha, size: bytes.byteLength })),
    });
    pulled = deletes.length + writes.length;
    await addLocalRepoLog(meta.id, scope, "pull", `Sync pulled ${pulled} remote files and kept ${keptLocal} non-conflicting local files`);
  } else {
    if (Object.keys(input.conflictResolutions ?? {}).length) throw new RepositorySyncChoiceStaleError();
    await updateLocalRepositoryHead(meta.id, scope, remoteHeadSha);
    if (remoteHeadSha !== meta.remoteHeadSha) await addLocalRepoLog(meta.id, scope, "pull", `Remote head changed to ${remoteHeadSha.slice(0, 7)} with no file-content differences`);
    else await markLocalRepositoryRemoteCheck(meta.id, scope, meta.remoteHeadSha, remoteHeadSha, false);
  }
  // Do not mutate unpushed commits until every remote blob has been downloaded
  // and measured successfully. Limit rejection leaves local work byte-for-byte intact.
  if (pendingBeforeSync.length) {
    if (!syncPreflightIncludesRecovery) {
      const currentFiles = await listAllLocalFiles(meta.id);
      assertRepositoryAggregateBytes(currentFiles.reduce((sum, file) => sum + file.size, 0), "transfer", await repositoryTransferAllowance());
    }
    await createLocalRecoverySnapshot(meta.id, `Before full sync from ${meta.remoteHeadSha}`, scope);
  }
  await restoreUnpushedCommitsAsDirty(meta.id, scope);
  const dirtyAfterMerge = await listDirtyLocalFiles(meta.id);
  let committed = 0;
  if (dirtyAfterMerge.length) {
    const commit = await createLocalCommit(
      meta.id,
      scope,
      autoCommitMessage(dirtyAfterMerge.map((file) => file.path)),
      new Set(dirtyAfterMerge.map((file) => file.path)),
      new Map(dirtyAfterMerge.map((file) => [file.path, file.currentHash])),
    );
    committed = commit.files.length;
    await addLocalRepoLog(meta.id, scope, "commit", `Sync auto-committed ${committed} files: ${commit.message}`);
  }
  const ahead = await listUnpushedLocalCommits(meta.id);
  let pushed = 0;
  if (ahead.length) {
    const lockedMeta = await exactLocalRepository(input, scope);
    pushed = (await pushLocalCommitsLocked(lockedMeta, { ...input, expectedRemoteHeadSha: remoteHeadSha }, scope)).files;
    // Re-read the branch head after push. This closes the race where the periodic
    // remote check sees the new commit between updateRef and the IndexedDB update.
    const finalRef = await octokit.rest.git.getRef({ owner: meta.owner, repo: meta.repo, ref: `heads/${meta.branch}` });
    await updateLocalRepositoryHead(meta.id, scope, finalRef.data.object.sha);
  }
  await addLocalRepoLog(meta.id, scope, "push", `Full sync complete: pulled ${pulled}, kept local ${keptLocal}, committed ${committed}, pushed ${pushed}`);
  return { pulled, keptLocal, committed, pushed };
  } catch (error) {
    const classified = classifyRepositoryError(error, "compare");
    await markLocalRepositoryRemoteFailure(meta.id, scope, meta.remoteHeadSha, classified.kind, previous).catch(() => undefined);
    throw error instanceof RepositoryOwnershipChangedError || error instanceof RepositorySyncConflictError || error instanceof RepositorySyncChoiceStaleError || classified.kind === "unknown" ? error : classified;
  }
}

export async function removeLocalWorkingCopy(target: ExactRepositoryTarget & { backupReceiptId: string; confirmation: string }): Promise<{ recoveriesPreserved: number; rewriteOperationsRemoved: number }> {
  operationScope(target);
  if (target.confirmation !== `REMOVE ${target.owner}/${target.repo}`) throw new RepositoryMaintenanceError("CONFIRMATION_REQUIRED");
  invalidateRepositoryEnsureOperations(repositoryEnsureEpoch + 1, target.accountIdentity);
  return withRepositoryMutationLease(target.repoId ?? `${target.accountIdentity}::${target.owner}/${target.repo}#${target.branch}`.toLowerCase(), () => removeRepositoryWithBackupReceipt(target, target.backupReceiptId));
}

export async function recloneLocalWorkingCopy(input: {
  bookId: string;
  book: BookEntry;
  token: string;
  accountIdentity: string;
  branch?: string;
  onProgress?: (progress: LocalCloneProgress) => void;
}): Promise<{ meta: LocalRepositoryMeta; structure: BookStructure; cloned: boolean }> {
  if (!input.branch) throw new Error("An exact branch is required to re-clone a local working copy.");
  const scope = operationScope({ bookId: input.bookId, owner: input.book.owner, repo: input.book.repo, branch: input.branch, accountIdentity: input.accountIdentity });
  const existing = await lookupRepositoryMaintenanceTarget({ bookId: input.bookId, owner: input.book.owner, repo: input.book.repo, branch: input.branch, accountIdentity: input.accountIdentity });
  if (existing.removalPending) throw new RepositoryMaintenanceError("REMOVAL_PENDING");
  if (existing.repository) throw new RepositoryMaintenanceError("RECLONE_REQUIRES_REMOVAL");
  const result = await ensureLocalBookStructure(input);
  await addLocalRepoLog(result.meta.id, scope, "reset", "Recloned local working copy");
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
export async function overwriteRemoteWithLocal(input: ExactRepositoryTarget & { token: string; confirmed: boolean }): Promise<PushResult> {
  if (!input.confirmed) throw new Error("Overwriting the remote branch requires explicit confirmation.");
  const scope = operationScope(input);
  const selected = await exactLocalRepository(input, scope);
  return withRepositoryMutationLease(selected.id, async () => overwriteRemoteWithLocalLeased(await exactLocalRepository(input, scope), input, scope));
}

async function overwriteRemoteWithLocalLeased(meta: LocalRepositoryMeta, input: ExactRepositoryTarget & { token: string; confirmed: boolean }, scope: RepositoryOperationScope): Promise<PushResult> {
  // Refuse to make an unverified/partial local copy the source of truth: doing so would
  // overwrite the remote branch with an incomplete tree and destroy files that never
  // finished cloning. Require a verified-complete clone first.
  if (meta.cloneComplete !== true) {
    throw new Error("Local working copy is not fully synced yet. Reload the book (or re-clone) so all files are present before using it as the source of truth.");
  }

  const octokit = trackedOctokit(input.token, input);
  const ref = await octokit.rest.git.getRef({ owner: meta.owner, repo: meta.repo, ref: `heads/${meta.branch}` });
  const remoteHeadSha = ref.data.object.sha;

  const allFilesBeforePush = await listAllLocalFiles(meta.id);
  const commitsBeforePush = await listUnpushedLocalCommits(meta.id);
  // The app's current view = all non-deleted local files.
  const allLocal = allFilesBeforePush.filter((file) => file.status !== "deleted");
  if (allLocal.length === 0) throw new Error("Local working copy is empty.");
  const overwriteMeter = new RepositoryByteMeter("mutation");
  for (const file of allLocal) overwriteMeter.add(file.kind, file.kind === "text" ? utf8Bytes(file.text ?? "") : file.blob?.size ?? 0);
  const recovery = await createLocalRecoverySnapshot(meta.id, `Before local-source overwrite of ${meta.branch}`, scope);

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

  if (droppedPaths.size) {
    await addLocalRepoLog(meta.id, scope, "error", `Local-source repair blocked; recovery ${recovery.id} contains excluded paths: ${[...droppedPaths].sort().join(", ")}`);
    throw new Error(`Local-source repair cannot continue until these malformed or colliding paths are resolved: ${[...droppedPaths].sort().join(", ")}. Recovery snapshot: ${recovery.id}`);
  }

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
  await recordRepositoryWriteValidated(tokenHealthTarget(input));

  const settlement = await settleLocalSourceOverwriteAtomically({
    repoId: meta.id,
    scope,
    remoteHeadSha: commit.data.sha,
    expectedFiles: allFilesBeforePush,
    expectedCommitIds: commitsBeforePush.map((entry) => entry.id),
    pushedShas,
  });
  await addLocalRepoLog(meta.id, scope, settlement.skippedPaths.length ? "error" : "push", settlement.skippedPaths.length
    ? `Resynced remote with newer local edits preserved: ${settlement.skippedPaths.join(", ")}; recovery ${recovery.id}`
    : `Resynced remote to match local (${files.length} files) at ${commit.data.sha.slice(0, 7)}; recovery ${recovery.id}`);

  return { commitSha: commit.data.sha, files: files.length, ...(settlement.skippedPaths.length ? { recoveryPaths: settlement.skippedPaths } : {}) };
}

async function createBlobForFile(octokit: Octokit, meta: LocalRepositoryMeta, file: LocalRepositoryFile, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (file.kind === "text") {
    assertRepositoryFileBytes("text", utf8Bytes(file.text ?? ""));
    const result = await octokit.rest.git.createBlob({ owner: meta.owner, repo: meta.repo, content: file.text ?? "", encoding: "utf-8", request: { signal } });
    return result.data.sha;
  }
  const bytes = file.blob ? new Uint8Array(await file.blob.arrayBuffer()) : new Uint8Array();
  assertRepositoryFileBytes("binary", bytes.byteLength);
  signal?.throwIfAborted();
  const result = await octokit.rest.git.createBlob({ owner: meta.owner, repo: meta.repo, content: bytesToBase64(bytes), encoding: "base64", request: { signal } });
  return result.data.sha;
}
