import type { CallsSource } from "@/autopilot/calls/source";
import type { ServerCallsApi } from "@/autopilot/calls/copier";
import { DEFAULT_PAGE } from "@/autopilot/calls/sourceLocal";

/** A personal server is asked once a second about a call that is still running, and only while a view of it is open. */
export const SERVER_POLL_MS = 1000;

/**
 * What this source needs of the engine's client of the personal server (`NarrariumServerClient`): the methods that the server's feature `autopilot-calls` adds, with the client's
 * own names and signatures, so that the client itself is a `CallsClient`. The reads are those the copy of the server's records makes (`ServerCallsApi`); an answer of 404 is a task
 * or a call the server does not hold.
 */
export interface CallsClient extends ServerCallsApi {
  keepCallTask(bookId: string, activityId: string, pinned: boolean): Promise<unknown>;
  deleteCalls(bookId: string): Promise<unknown>;
}

/** What else a deletion of the records on the server takes with it: the copies of this device (the two go together). */
export interface ServerCallsSourceOptions {
  alsoDelete?: (bookId: string) => Promise<void>;
}

const notThere = (error: unknown) => error instanceof Error && (error as { status?: unknown }).status === 404;

/** The records of a book that runs on the personal server, read through its client. */
export function serverCallsSource(client: CallsClient, options: ServerCallsSourceOptions = {}): CallsSource {
  return {
    available: true,
    reason: null,
    pollMs: SERVER_POLL_MS,
    listTasks: (bookId, page = {}) => client.listCalls(bookId, { ...(page.before === undefined ? {} : { before: page.before }), limit: page.limit ?? DEFAULT_PAGE }),
    readTask: async (bookId, activityId) => {
      try {
        return await client.readCallTask(bookId, activityId);
      } catch (error) {
        if (notThere(error)) return null;
        throw error;
      }
    },
    readText: async (bookId, callId, field, read = {}) => {
      try {
        const chunk = await client.readCallText(bookId, callId, { field, from: read.from ?? 0, ...(read.attempt === undefined ? {} : { attempt: read.attempt }) });
        return chunk && { text: chunk.text, from: chunk.from, next: chunk.next, done: chunk.done };
      } catch (error) {
        if (notThere(error)) return null;
        throw error;
      }
    },
    keep: async (bookId, activityId, pinned) => {
      await client.keepCallTask(bookId, activityId, pinned);
    },
    deleteAll: async (bookId) => {
      await client.deleteCalls(bookId);
      await options.alsoDelete?.(bookId);
    },
  };
}
