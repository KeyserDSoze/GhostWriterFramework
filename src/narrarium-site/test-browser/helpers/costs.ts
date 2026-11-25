import { useCostsStore } from "@/costs/costsStore";
import { emptyCostsFile } from "@/costs/model";
import { resetUsageRecorder } from "@/costs/recordUsage";

/** The costs of this tab, empty: nothing stored, nothing on its way, no task counted, and the book open in the app (none without one). */
export function resetCosts(current?: { bookId: string; bookName: string }): void {
  resetUsageRecorder();
  const empty = emptyCostsFile();
  useCostsStore.setState({ file: empty, persisted: empty, currentBookId: current?.bookId, currentBookName: current?.bookName, dirty: false, revision: 0 });
}
