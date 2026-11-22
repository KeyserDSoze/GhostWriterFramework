import { summarizeAutopilotState, type AutopilotState, type AutopilotStateSummary } from "narrarium-engine";

/**
 * What the page shows about the status and the statistics of a book's autopilot: the summary the last `state` event carried
 * when it is not older than the state that was downloaded, so those parts follow a run without a new download. Nothing is shown
 * for a book whose autopilot was not downloaded (or was reset): a summary kept from before does not count.
 *
 * The pause that waits, the limits of the run and where the book is published change without the state being written, so the
 * `updatedAt` of the summary does not move when they do: an event with the same `updatedAt` as the downloaded state is the newer
 * one, and the newest event seen is the one that counts. `downloaded` is the summary the download came with (what the engine
 * says of its own session): the state alone cannot say any of those.
 */
export function latestSummary(state: AutopilotState | null, live: AutopilotStateSummary | undefined, downloaded?: AutopilotStateSummary | null): AutopilotStateSummary | null {
  if (!state) return null;
  if (live && live.updatedAt >= state.updatedAt) return live;
  return downloaded && downloaded.updatedAt === state.updatedAt ? downloaded : summarizeAutopilotState(state);
}
