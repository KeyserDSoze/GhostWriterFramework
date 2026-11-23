import { callsCopier } from "./services";
import { startCopyScheduler, type CopyScheduler } from "./scheduler";
import { isCopyTargetKind } from "./types";
import { useSettingsStore } from "@/store/settingsStore";
import { useConnectionStore } from "@/account/connectionStore";

let scheduler: CopyScheduler | null = null;

/**
 * Starts the copying of the site, once: the books that have a target (`aiCallsCopy` in the account's settings) are copied from the local records.
 * The browser's host calls it when its records are open and calls `taskFinished` of the result when a task ends; the settings tab calls it too, so a
 * choice made there starts to work at once. It is safe to call twice.
 */
export function startCopiesRuntime(): CopyScheduler {
  if (scheduler) return scheduler;
  scheduler = startCopyScheduler({
    copier: callsCopier(),
    targets: () => useSettingsStore.getState().settings.books.flatMap((book) => (isCopyTargetKind(book.aiCallsCopy) ? [{ bookId: book.id, kind: book.aiCallsCopy }] : [])),
    events: typeof window !== "undefined" ? window : undefined,
    subscribeTokenRefresh: (listener) => {
      const tokens = () => `${useConnectionStore.getState().configuration.google?.accessToken ?? ""}|${useConnectionStore.getState().configuration.microsoft?.accessToken ?? ""}`;
      let last = tokens();
      return useConnectionStore.subscribe(() => {
        const now = tokens();
        if (now !== last) { last = now; listener(); }
      });
    },
  });
  return scheduler;
}

export function stopCopiesRuntimeForTests(): void {
  scheduler?.stop();
  scheduler = null;
}
