import { summarizeAutopilotState, type AutopilotState, type AutopilotStateSummary } from "narrarium-engine";

/**
 * What the page shows about the status and the statistics of a book's autopilot: the summary the last `state` event
 * carried when it is newer than the state that was downloaded, so those parts follow a run without a new download.
 * Nothing is shown for a book whose autopilot was not downloaded (or was reset): a summary kept from before does not count.
 */
export function latestSummary(state: AutopilotState | null, live: AutopilotStateSummary | undefined): AutopilotStateSummary | null {
  if (!state) return null;
  return live && live.updatedAt > state.updatedAt ? live : summarizeAutopilotState(state);
}
