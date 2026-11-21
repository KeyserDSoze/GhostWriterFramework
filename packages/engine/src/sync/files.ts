import { isSafeBookPath, isTextBookPath } from "../book/paths.js";
import type { BookFileChange, BookFileContent, BookStore } from "../book/store.js";

export type SyncDirection = "upload" | "download";

export interface FileSyncPlan {
  /** Changed only on this side: send to the other side (`null` hash = delete there). */
  upload: Array<{ path: string; hash: string | null }>;
  /** Changed only on the other side: apply here (`null` hash = delete here). */
  download: Array<{ path: string; hash: string | null }>;
  /** Changed differently on both sides since the last sync. */
  conflicts: string[];
  /** Paths a manifest listed that are not safe repository paths (`../x.md`, `.git/…`, absolute): never synced. */
  rejected: string[];
}

/**
 * Three-way plan between a local and a remote manifest (path → content hash), using the
 * manifest of the last successful sync as the common base.
 */
export function planFileSync(local: ReadonlyMap<string, string>, remote: ReadonlyMap<string, string>, base: ReadonlyMap<string, string>): FileSyncPlan {
  const plan: FileSyncPlan = { upload: [], download: [], conflicts: [], rejected: [] };
  const paths = new Set([...local.keys(), ...remote.keys(), ...base.keys()]);
  for (const path of [...paths].sort()) {
    if (!isTextBookPath(path)) continue;
    if (!isSafeBookPath(path)) {
      plan.rejected.push(path);
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
   * Called after every chunk committed to either side: `done` files applied (or found missing) so far, out of `total`
   * planned. A sync with nothing to do never calls it.
   */
  onProgress?: (done: number, total: number) => void;
}

export interface SyncStoresResult {
  uploaded: string[];
  downloaded: string[];
  conflicts: string[];
  /** Paths left out because they are not safe repository paths. */
  rejected: string[];
  /** New base to remember for the next sync. */
  base: Map<string, string>;
}

/** Changes in one commit: far below the 5000 the personal server accepts. */
export const SYNC_CHUNK_CHANGES = 400;
/** Content in one commit, about: far below the 64 MiB the personal server accepts once the JSON is encoded. */
export const SYNC_CHUNK_BYTES = 24 * 1024 * 1024;
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
  const plan = planFileSync(local, remote, input.base);
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

  /** Copies the entries from `source` to `target`, reading a batch at a time and committing a chunk at a time. */
  const apply = async (source: BookStore, target: BookStore, entries: Array<{ path: string; hash: string | null }>, targetHashes: ReadonlyMap<string, string>): Promise<string[]> => {
    const applied: string[] = [];
    let pending: BookFileChange[] = [];
    let pendingBytes = 0;
    let missing = 0;
    const flush = async () => {
      if (!pending.length) return;
      await target.commit(pending, message);
      applied.push(...pending.map((change) => change.path));
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
      const wanted = group.filter((entry) => entry.hash !== null).map((entry) => entry.path);
      const files = wanted.length ? await readFiles(source, wanted) : new Map<string, BookFileContent>();
      for (const entry of group) {
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
          change = { path: entry.path, content: file.content, expectedHash };
          bytes = encoder.encode(file.content).byteLength;
        }
        if (pending.length && (pending.length >= SYNC_CHUNK_CHANGES || pendingBytes + bytes > SYNC_CHUNK_BYTES)) await flush();
        pending.push(change);
        pendingBytes += bytes;
      }
    }
    await flush();
    return applied;
  };

  const uploaded = await apply(input.local, input.remote, upload, remote);
  const downloaded = await apply(input.remote, input.local, download, local);

  const uploadedPaths = new Set(uploaded);
  const downloadedPaths = new Set(downloaded);
  const rejected = new Set(plan.rejected);
  const skipped = new Set(unresolved);
  const next = new Map<string, string>();
  for (const path of new Set([...local.keys(), ...remote.keys(), ...input.base.keys()])) {
    if (rejected.has(path)) continue;
    if (skipped.has(path)) {
      const previous = input.base.get(path);
      if (previous) next.set(path, previous);
      continue;
    }
    const hash = uploadedPaths.has(path) ? local.get(path) : downloadedPaths.has(path) ? remote.get(path) : local.get(path) === remote.get(path) ? local.get(path) : input.base.get(path);
    if (hash) next.set(path, hash);
  }
  return { uploaded, downloaded, conflicts: unresolved, rejected: plan.rejected, base: next };
}
