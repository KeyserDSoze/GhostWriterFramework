import type { BookStore } from "narrarium-engine";
import type { ConflictSide, SyncConflict } from "@/autopilot/store";

/** Sizes are read for this many conflicts at most: a first sync of two diverged books can have thousands. */
export const CONFLICT_SIZES_LIMIT = 100;

/** A book store that remembers the manifest it listed last, so a sync's plan can be explained without listing again. */
export function recordedManifest(store: BookStore): { store: BookStore; hashes: () => ReadonlyMap<string, string> } {
  let listed = new Map<string, string>();
  const recorded: BookStore = {
    async list() {
      const entries = await store.list();
      listed = new Map(entries.map((entry) => [entry.path, entry.hash]));
      return entries;
    },
    read: (path) => store.read(path),
    commit: (changes, message) => store.commit(changes, message),
  };
  if (store.readMany) recorded.readMany = (paths) => store.readMany!(paths);
  return { store: recorded, hashes: () => listed };
}

/** What happened to a file on one side since the last sync. A conflict is never "unchanged" on either side. */
export function sideOf(now: string | undefined, before: string | undefined): ConflictSide {
  if (now === undefined) return "deleted";
  return before === undefined ? "added" : "modified";
}

const encoder = new TextEncoder();

async function sizesOf(store: BookStore, paths: string[]): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  try {
    const files = store.readMany ? await store.readMany(paths) : (await Promise.all(paths.map((path) => store.read(path)))).filter((file) => file !== null);
    for (const file of files) if (file) sizes.set(file.path, encoder.encode(file.content).length);
  } catch {
    // Sizes are only a help to choose: without them the list is just as usable.
  }
  return sizes;
}

/** The files that changed on both sides, with what each side did to them and, for the first few, how big each version is. */
export async function describeConflicts(input: {
  conflicts: string[];
  local: { store: BookStore; hashes: ReadonlyMap<string, string> };
  remote: { store: BookStore; hashes: ReadonlyMap<string, string> };
  base: ReadonlyMap<string, string>;
}): Promise<SyncConflict[]> {
  if (!input.conflicts.length) return [];
  const sample = input.conflicts.slice(0, CONFLICT_SIZES_LIMIT);
  const [localSizes, remoteSizes] = await Promise.all([sizesOf(input.local.store, sample), sizesOf(input.remote.store, sample)]);
  return input.conflicts.map((path) => {
    const before = input.base.get(path);
    const detail: SyncConflict = { path, local: sideOf(input.local.hashes.get(path), before), remote: sideOf(input.remote.hashes.get(path), before) };
    const localBytes = localSizes.get(path);
    const remoteBytes = remoteSizes.get(path);
    if (localBytes !== undefined) detail.localBytes = localBytes;
    if (remoteBytes !== undefined) detail.remoteBytes = remoteBytes;
    return detail;
  });
}
