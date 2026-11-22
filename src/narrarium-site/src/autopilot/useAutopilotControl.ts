import { useMemo } from "react";
import { useBookAutopilotView, useNow } from "@/autopilot/hooks";
import { selectAutopilotControl, type AutopilotControl, type AutopilotControlInput } from "@/autopilot/control";
import { lastSignalAt, useAutopilotStore } from "@/autopilot/store";
import { latestSummary } from "@/autopilot/summary";

export { selectAutopilotControl };
export type { AutopilotControl, AutopilotControlInput, ControlReason } from "@/autopilot/control";

/** Who can command the autopilot of a book, kept fresh: the page and the dock both read it, so they never disagree. */
export function useAutopilotControl(bookId: string | undefined): AutopilotControl {
  const view = useBookAutopilotView(bookId);
  const liveSummary = useAutopilotStore((store) => (bookId ? store.summaries[bookId] : undefined));
  const snapshot = view.snapshot;
  const summary = useMemo(() => latestSummary(snapshot?.state ?? null, liveSummary, snapshot?.summary), [snapshot?.state, snapshot?.summary, liveSummary]);
  const input: AutopilotControlInput = { snapshot, busyInAnotherTab: view.busyInAnotherTab, summary, lastSignal: bookId ? lastSignalAt(bookId) : undefined };
  // The age reads "4 minutes ago": a run elsewhere is looked at again every half minute.
  useNow(30_000, selectAutopilotControl(input, 0).canTakeOver);
  return selectAutopilotControl(input, Date.now());
}
