import { isSafeBookPath, isTextBookPath } from "../book/paths.js";
import type { BookFileChange, BookStore } from "../book/store.js";

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

/**
 * Two-way sync of the text files of two book stores (browser working copy ⇄ personal server).
 * Each side is committed atomically with compare-and-swap; a concurrent change aborts the sync.
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

  const toRemote: BookFileChange[] = [];
  for (const entry of upload) {
    if (entry.hash === null) toRemote.push({ path: entry.path, content: null, expectedHash: remote.get(entry.path) ?? null });
    else {
      const file = await input.local.read(entry.path);
      if (file) toRemote.push({ path: entry.path, content: file.content, expectedHash: remote.get(entry.path) ?? null });
    }
  }
  const toLocal: BookFileChange[] = [];
  for (const entry of download) {
    if (entry.hash === null) toLocal.push({ path: entry.path, content: null, expectedHash: local.get(entry.path) ?? null });
    else {
      const file = await input.remote.read(entry.path);
      if (file) toLocal.push({ path: entry.path, content: file.content, expectedHash: local.get(entry.path) ?? null });
    }
  }
  if (toRemote.length) await input.remote.commit(toRemote, message);
  if (toLocal.length) await input.local.commit(toLocal, message);

  const next = new Map<string, string>();
  for (const path of new Set([...local.keys(), ...remote.keys(), ...input.base.keys()])) {
    if (plan.rejected.includes(path)) continue;
    if (unresolved.includes(path)) {
      const previous = input.base.get(path);
      if (previous) next.set(path, previous);
      continue;
    }
    const uploaded = toRemote.some((change) => change.path === path);
    const downloaded = toLocal.some((change) => change.path === path);
    const hash = uploaded ? local.get(path) : downloaded ? remote.get(path) : local.get(path) === remote.get(path) ? local.get(path) : input.base.get(path);
    if (hash) next.set(path, hash);
  }
  return { uploaded: toRemote.map((change) => change.path), downloaded: toLocal.map((change) => change.path), conflicts: unresolved, rejected: plan.rejected, base: next };
}
