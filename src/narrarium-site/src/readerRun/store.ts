import { create } from "zustand";
import { KEEP_ENDED_MS, isEnded, type TrackedPublication } from "@/readerRun/model";

/**
 * The publication that each repository's reader is following, kept on this device so that a reload goes on with it (it is not account data: a run belongs to
 * the moment and the device that started it). One per repository, `owner/repo` in lower case. A publication that ended stays for a few hours so that the card
 * still says how it went; anything older, or that does not have the shape, is dropped.
 */
export const RUN_STORAGE_KEY = "narrarium-reader-run-v1";

export const publicationKey = (owner: string, repo: string): string => `${owner}/${repo}`.toLowerCase();

function valid(value: unknown): value is TrackedPublication {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (record.trigger === "dispatch" || record.trigger === "push" || record.trigger === "observed")
    && typeof record.branch === "string" && typeof record.since === "string" && Number.isFinite(Date.parse(record.since))
    && (record.baselineRunId === null || typeof record.baselineRunId === "number") && typeof record.lookups === "number";
}

export function readStoredPublications(storage: Pick<Storage, "getItem"> | undefined, now: number): Record<string, TrackedPublication> {
  if (!storage) return {};
  try {
    const parsed = JSON.parse(storage.getItem(RUN_STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    const kept: Record<string, TrackedPublication> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!valid(value)) continue;
      if (isEnded(value.state) && now - (value.endedAt ?? now) > KEEP_ENDED_MS) continue;
      kept[key] = value;
    }
    return kept;
  } catch { return {}; }
}

function storage(): Storage | undefined {
  try { return typeof localStorage === "undefined" ? undefined : localStorage; } catch { return undefined; }
}

function write(entries: Record<string, TrackedPublication>): void {
  try { storage()?.setItem(RUN_STORAGE_KEY, JSON.stringify(entries)); } catch { /* a full or blocked storage only costs the survival of a reload */ }
}

/** How the poll of a publication is going, which is only about this page and is not kept. */
export interface PublicationLive {
  /** The tab is hidden: nothing is asked until it is visible again. */
  paused: boolean;
  /** Failed asks in a row (the rate limit, the network): the pace slows down with them. */
  failures: number;
  /** When the next ask is due (ms), while the wait is a backoff. */
  nextAt: number | null;
  /** The last time GitHub answered (ms). */
  checkedAt: number | null;
  /** The kind of the last refusal, for the words under the state. */
  problem: "rate-limit" | "network" | "permission" | "other" | null;
}

export const IDLE_LIVE: PublicationLive = { paused: false, failures: 0, nextAt: null, checkedAt: null, problem: null };

interface PublicationStore {
  entries: Record<string, TrackedPublication>;
  live: Record<string, PublicationLive>;
  begin: (key: string, publication: TrackedPublication) => void;
  update: (key: string, change: (current: TrackedPublication) => TrackedPublication) => void;
  setLive: (key: string, change: Partial<PublicationLive>) => void;
  forget: (key: string) => void;
}

export const usePublicationStore = create<PublicationStore>((set, get) => ({
  entries: readStoredPublications(storage(), Date.now()),
  live: {},
  begin: (key, publication) => {
    const entries = { ...get().entries, [key]: publication };
    write(entries);
    set({ entries, live: { ...get().live, [key]: IDLE_LIVE } });
  },
  update: (key, change) => {
    const current = get().entries[key];
    if (!current) return;
    const entries = { ...get().entries, [key]: change(current) };
    write(entries);
    set({ entries });
  },
  setLive: (key, change) => set({ live: { ...get().live, [key]: { ...(get().live[key] ?? IDLE_LIVE), ...change } } }),
  forget: (key) => {
    const entries = { ...get().entries };
    delete entries[key];
    write(entries);
    set({ entries });
  },
}));
