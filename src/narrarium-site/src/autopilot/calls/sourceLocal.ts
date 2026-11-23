import type { AiCallStore } from "narrarium-engine";
import type { CallsSource } from "@/autopilot/calls/source";

/** The store of this browser is read in the same tab: a view that follows a running call asks it twice a second. */
export const LOCAL_POLL_MS = 500;

/** The task headers a page asks for at once when it does not say. */
export const DEFAULT_PAGE = 50;

/**
 * The records of a book that runs in this browser, read from its store (`AiCallStore`, the browser's IndexedDB; the engine's `MemoryAiCallStore` in
 * tests). The store answers in its own terms; this only names them as the pages ask.
 */
export function localCallsSource(store: AiCallStore, options: { notRecording?: boolean } = {}): CallsSource {
  return {
    available: true,
    reason: null,
    pollMs: LOCAL_POLL_MS,
    ...(options.notRecording ? { notRecording: true } : {}),
    listTasks: (bookId, page = {}) => store.listTasks(bookId, { ...(page.before === undefined ? {} : { before: page.before }), limit: page.limit ?? DEFAULT_PAGE }),
    readTask: (bookId, activityId) => store.readTask(bookId, activityId),
    readText: async (bookId, callId, field, options = {}) => {
      const chunk = await store.readText(bookId, callId, field, options.from ?? 0, options.attempt);
      return chunk && { text: chunk.text, from: chunk.from, next: chunk.next, done: chunk.complete };
    },
    keep: (bookId, activityId, pinned) => store.keep(bookId, activityId, pinned),
    deleteAll: (bookId) => store.deleteBook(bookId),
  };
}
