import { isSafeBookPath, isTextBookPath } from "../book/paths.js";
import type { BookFileChange, BookFileContent, BookFileEntry, BookStore } from "../book/store.js";

export type SyncDirection = "upload" | "download";

/** Why a file was not moved: it is over the size limit, its path is not a safe repository path, or it is not a text file (binary assets are left to the hosts). */
export type SyncSkipReason = "too-large" | "unsafe-path" | "not-text";

/** A file a sync did not move, and why. `size` (bytes) is given for `too-large`. */
export interface SyncSkippedFile {
  path: string;
  reason: SyncSkipReason;
  size?: number;
}

export interface FileSyncPlan {
  /** Changed only on this side: send to the other side (`null` hash = delete there). */
  upload: Array<{ path: string; hash: string | null }>;
  /** Changed only on the other side: apply here (`null` hash = delete here). */
  download: Array<{ path: string; hash: string | null }>;
  /** Changed differently on both sides since the last sync. */
  conflicts: string[];
  /** Paths a manifest listed that are not safe repository paths (`../x.md`, `.git/…`, absolute): never synced. */
  rejected: string[];
  /** Every path the plan leaves out, with its reason: the `rejected` ones (`unsafe-path`) and the files that are not text and are not the same on both sides (`not-text`), in path order. */
  skipped: SyncSkippedFile[];
}

/**
 * Three-way plan between a local and a remote manifest (path → content hash), using the
 * manifest of the last successful sync as the common base.
 */
export function planFileSync(local: ReadonlyMap<string, string>, remote: ReadonlyMap<string, string>, base: ReadonlyMap<string, string>): FileSyncPlan {
  const plan: FileSyncPlan = { upload: [], download: [], conflicts: [], rejected: [], skipped: [] };
  const paths = new Set([...local.keys(), ...remote.keys(), ...base.keys()]);
  for (const path of [...paths].sort()) {
    if (!isTextBookPath(path)) {
      const mine = local.get(path);
      const theirs = remote.get(path);
      if ((mine !== undefined || theirs !== undefined) && mine !== theirs) plan.skipped.push({ path, reason: "not-text" });
      continue;
    }
    if (!isSafeBookPath(path)) {
      plan.rejected.push(path);
      plan.skipped.push({ path, reason: "unsafe-path" });
      continue;
    }
    const mine = local.get(path) ?? null;
    const theirs = remote.get(path) ?? null;
    const before = base.get(path) ?? null;
    if (mine === theirs) continue;
    if (mine === before) plan.download.push({ path, hash: theirs });
    else if (theirs === before) plan.upload.push({ path, hash: mine });
    else plan.conflicts.push(path);
  }
  return plan;
}

export interface SyncStoresInput {
  local: BookStore;
  remote: BookStore;
  /** Manifest of the last successful sync (empty map for the first one). */
  base: ReadonlyMap<string, string>;
  /** How to settle a path changed on both sides; `skip` leaves it for later. */
  resolveConflict?: (path: string) => "local" | "remote" | "skip";
  message?: string;
  /**
   * Called after every chunk committed to either side: `done` files applied (found missing, or skipped) so far, out of `total`
   * planned. A sync with nothing to do never calls it.
   */
  onProgress?: (done: number, total: number) => void;
  /** The biggest file (bytes of its content) the sync moves; a bigger one is skipped and reported (default `SYNC_MAX_FILE_BYTES`). */
  maxFileBytes?: number;
}

export interface SyncStoresResult {
  uploaded: string[];
  downloaded: string[];
  conflicts: string[];
  /** Paths left out because they are not safe repository paths. */
  rejected: string[];
  /**
   * Every file the sync did not move and why, in path order: a file over the size limit (`too-large`, with its `size`), an unsafe
   * path (`unsafe-path`, the same ones as `rejected`) and a file that is not text (`not-text`). A skipped file does not fail the
   * sync, never enters a commit, and is not remembered in `base`, so that the next sync says it again until it can be moved.
   */
  skipped: SyncSkippedFile[];
  /** New base to remember for the next sync. */
  base: Map<string, string>;
}

/** Changes in one commit: far below the 5000 the personal server accepts. */
export const SYNC_CHUNK_CHANGES = 400;
/** Content in one commit, about: far below the 64 MiB the personal server accepts once the JSON is encoded. */
export const SYNC_CHUNK_BYTES = 24 * 1024 * 1024;
/** The biggest file the personal server accepts (8 MiB): a bigger one in a commit makes the server refuse the whole commit. */
export const SYNC_MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Files read from the other side at a time: the paths one server request may ask for. */
const READ_BATCH = 50;

const encoder = new TextEncoder();

async function readFiles(store: BookStore, paths: string[]): Promise<Map<string, BookFileContent>> {
  const files = new Map<string, BookFileContent>();
  if (store.readMany) {
    for (const file of await store.readMany(paths)) files.set(file.path, file);
  } else {
    for (const path of paths) {
      const file = await store.read(path);
      if (file) files.set(path, file);
    }
  }
  return files;
}

/** The other side refused to send this much (HTTP 413, as the personal server does for what it is asked to read). */
function isPayloadTooLarge(error: unknown): boolean {
  const flags = error as { status?: unknown; code?: unknown } | null;
  return typeof error === "object" && error !== null && (flags?.status === 413 || flags?.code === "payload_too_large");
}

/**
 * `readFiles`, except that a store that refuses to send what it was asked for because it is too much does not fail the sync:
 * the request is halved until the refused file is alone, and that file is handed to `tooLarge` (its size is not known).
 */
async function readFilesSkippingRefused(store: BookStore, paths: string[], tooLarge: (path: string) => void): Promise<Map<string, BookFileContent>> {
  try {
    return await readFiles(store, paths);
  } catch (error) {
    if (!isPayloadTooLarge(error)) throw error;
    if (paths.length === 1) {
      tooLarge(paths[0]);
      return new Map();
    }
    const middle = Math.ceil(paths.length / 2);
    const files = await readFilesSkippingRefused(store, paths.slice(0, middle), tooLarge);
    for (const [path, file] of await readFilesSkippingRefused(store, paths.slice(middle), tooLarge)) files.set(path, file);
    return files;
  }
}

/**
 * Two-way sync of the text files of two book stores (browser working copy ⇄ personal server).
 *
 * Each side is committed in chunks of at most `SYNC_CHUNK_CHANGES` changes and about `SYNC_CHUNK_BYTES` of content, so a
 * book of any size passes the limits of one request; every chunk is atomic and carries compare-and-swap hashes, so a
 * concurrent change aborts the sync. The remote side goes first, then the local one. A failure in the middle leaves the
 * chunks before it applied and nothing else: running the sync again completes it without conflicts, because its plan is
 * computed again from the manifests of both sides, and a file that is already equal on both is skipped.
 */
export async function syncBookStores(input: SyncStoresInput): Promise<SyncStoresResult> {
  const [localEntries, remoteEntries] = await Promise.all([input.local.list(), input.remote.list()]);
  const local = new Map(localEntries.map((entry) => [entry.path, entry.hash]));
  const remote = new Map(remoteEntries.map((entry) => [entry.path, entry.hash]));
  const sizes = (entries: BookFileEntry[]) => new Map(entries.flatMap((entry) => (typeof entry.size === "number" ? [[entry.path, entry.size] as const] : [])));
  const localSizes = sizes(localEntries);
  const remoteSizes = sizes(remoteEntries);
  const limit = typeof input.maxFileBytes === "number" && Number.isFinite(input.maxFileBytes) && input.maxFileBytes > 0 ? input.maxFileBytes : SYNC_MAX_FILE_BYTES;
  const plan = planFileSync(local, remote, input.base);
  const skipped: SyncSkippedFile[] = [...plan.skipped];
  const upload = [...plan.upload];
  const download = [...plan.download];
  const unresolved: string[] = [];
  for (const path of plan.conflicts) {
    const choice = input.resolveConflict?.(path) ?? "skip";
    if (choice === "local") upload.push({ path, hash: local.get(path) ?? null });
    else if (choice === "remote") download.push({ path, hash: remote.get(path) ?? null });
    else unresolved.push(path);
  }
  const message = input.message ?? "Sync with the personal server";
  const total = upload.length + download.length;
  let settled = 0;

  /**
   * Copies the entries from `source` to `target`, reading a batch at a time and committing a chunk at a time. A file over the
   * size limit never goes into a commit (the other side would refuse the whole commit): it is skipped, and the rest goes on.
   */
  const apply = async (source: BookStore, target: BookStore, entries: Array<{ path: string; hash: string | null }>, targetHashes: ReadonlyMap<string, string>, sourceSizes: ReadonlyMap<string, number>): Promise<string[]> => {
    const applied: string[] = [];
    let pending: BookFileChange[] = [];
    let pendingBytes = 0;
    /** Files settled without a change: not found when read, or skipped. */
    let missing = 0;
    const flush = async () => {
      if (!pending.length && !missing) return;
      if (pending.length) {
        await target.commit(pending, message);
        applied.push(...pending.map((change) => change.path));
      }
      settled += pending.length + missing;
      pending = [];
      pendingBytes = 0;
      missing = 0;
      try {
        input.onProgress?.(settled, total);
      } catch {
        // A progress listener must never break a sync that already applied part of its changes.
      }
    };
    for (let start = 0; start < entries.length; start += READ_BATCH) {
      const group = entries.slice(start, start + READ_BATCH);
      const tooLarge = new Set<string>();
      for (const entry of group) {
        const listed = sourceSizes.get(entry.path);
        if (entry.hash !== null && listed !== undefined && listed > limit) {
          tooLarge.add(entry.path);
          skipped.push({ path: entry.path, reason: "too-large", size: listed });
        }
      }
      const wanted = group.filter((entry) => entry.hash !== null && !tooLarge.has(entry.path)).map((entry) => entry.path);
      const files = wanted.length
        ? await readFilesSkippingRefused(source, wanted, (path) => {
          tooLarge.add(path);
          skipped.push({ path, reason: "too-large" });
        })
        : new Map<string, BookFileContent>();
      for (const entry of group) {
        if (tooLarge.has(entry.path)) {
          missing += 1;
          continue;
        }
        const expectedHash = targetHashes.get(entry.path) ?? null;
        let change: BookFileChange;
        let bytes = 0;
        if (entry.hash === null) change = { path: entry.path, content: null, expectedHash };
        else {
          const file = files.get(entry.path);
          if (!file) {
            missing += 1;
            continue;
          }
          bytes = encoder.encode(file.content).byteLength;
          if (bytes > limit) {
            skipped.push({ path: entry.path, reason: "too-large", size: bytes });
            missing += 1;
            continue;
          }
          change = { path: entry.path, content: file.content, expectedHash };
        }
        if (pending.length && (pending.length >= SYNC_CHUNK_CHANGES || pendingBytes + bytes > SYNC_CHUNK_BYTES)) await flush();
        pending.push(change);
        pendingBytes += bytes;
      }
    }
    await flush();
    return applied;
  };

  const uploaded = await apply(input.local, input.remote, upload, remote, localSizes);
  const downloaded = await apply(input.remote, input.local, download, local, remoteSizes);

  const uploadedPaths = new Set(uploaded);
  const downloadedPaths = new Set(downloaded);
  const rejected = new Set(plan.rejected);
  const unresolvedPaths = new Set(unresolved);
  const next = new Map<string, string>();
  for (const path of new Set([...local.keys(), ...remote.keys(), ...input.base.keys()])) {
    if (rejected.has(path)) continue;
    if (unresolvedPaths.has(path)) {
      const previous = input.base.get(path);
      if (previous) next.set(path, previous);
      continue;
    }
    const hash = uploadedPaths.has(path) ? local.get(path) : downloadedPaths.has(path) ? remote.get(path) : local.get(path) === remote.get(path) ? local.get(path) : input.base.get(path);
    if (hash) next.set(path, hash);
  }
  skipped.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { uploaded, downloaded, conflicts: unresolved, rejected: plan.rejected, skipped, base: next };
}
