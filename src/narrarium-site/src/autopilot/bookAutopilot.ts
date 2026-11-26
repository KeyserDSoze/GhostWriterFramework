import type { AutopilotLimitReached, AutopilotOptions, AutopilotStats, AutopilotStatus } from "narrarium-engine";
import type { useAutopilotStore } from "@/autopilot/store";

/** What the dashboard says of a book's autopilot: its options (the budget among them), its status and the autopilot's own count of what it spent. */
export interface BookAutopilot {
  /** `false` while its saved state is being read; `true` once it is known (and `status` is `null` for a book whose autopilot never started). */
  read: boolean;
  /** Its state could not be read (a personal server that does not answer): nothing is said of it, and it is not «being read» for ever. */
  unavailable?: boolean;
  status: AutopilotStatus | null;
  options: AutopilotOptions | null;
  /** The autopilot's own count, the one its budget is compared with: the personal server's summary for a book that runs there. */
  stats: AutopilotStats | null;
  publish: "off" | "chapter" | "step" | null;
  /** The limit that stopped the run, with the numbers the stop compared (the engine's `limitReached`): the money cap, the token cap, the rounds of a review. */
  limitReached: AutopilotLimitReached | null;
}

type Store = ReturnType<typeof useAutopilotStore.getState>;

/** The newest of what the store holds of a book: the live summary when it is newer than the saved state, else the saved state. Pure, for the tests. */
export function bookAutopilotOf(store: Pick<Store, "views" | "summaries">, bookId: string): BookAutopilot {
  const view = store.views[bookId];
  const snapshot = view?.snapshot;
  const state = snapshot?.state ?? null;
  const live = store.summaries[bookId];
  const fresh = live && (!state || live.updatedAt >= state.updatedAt) ? live : snapshot?.summary ?? null;
  if (!snapshot && !live) return { read: false, status: null, options: null, stats: null, publish: null, limitReached: null };
  return {
    read: true,
    status: fresh?.status ?? state?.status ?? null,
    options: state?.options ?? null,
    stats: fresh?.stats ?? state?.stats ?? null,
    publish: fresh?.publish ?? state?.options.publishEvery ?? null,
    // A start takes the limit away, so the newest of the two says whether it still holds.
    limitReached: (fresh ? fresh.limitReached : state?.limitReached) ?? null,
  };
}
