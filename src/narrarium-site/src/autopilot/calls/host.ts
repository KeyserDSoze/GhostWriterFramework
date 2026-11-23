import { currentRepositoryScopeIdentity } from "@/repository/repositoryOperationScope";
import { useSettingsStore } from "@/store/settingsStore";
import { isRecording } from "@/autopilot/calls/recording";
import { getAiCallStore, openedAiCallStore } from "@/autopilot/calls/wire";
import { isCopyTargetKind, type CopyErrorCode, type CopyOutbox, type CopyOutboxItem } from "@/autopilot/calls/copies/types";
import type { CopyReport, ServerCallsApi, ServerCallsCopier } from "@/autopilot/calls/copier";
import type { IndexedDbAiCallStore, TaskFinishedEvent } from "@/autopilot/calls/store";

/**
 * The host of the AI call records in this browser: what the store, the copies to a place of the author's choosing (GitHub, Google Drive, OneDrive), the copy of a personal
 * server's records and the deletion need from each other. It is loaded with the autopilot runtime and the settings tab; the store and everything the copies are made of are
 * chunks that load from here, when there is something to do.
 */

/** The outbox of the copies over the store's own (`store.outbox`): the same entries, in the copies' words (the time of the next try in milliseconds, the account the item was queued under). */
export function copyOutboxOf(store: IndexedDbAiCallStore, scope: () => string = currentRepositoryScopeIdentity): CopyOutbox {
  return {
    async put(item) {
      const identity = scope();
      // An item queued under another account is not this account's to keep: the account fence of the copies.
      if (item.scope !== undefined && item.scope !== null && item.scope !== identity) return;
      await store.bind(identity).outbox.put({ bookId: item.bookId, taskId: item.taskId, target: item.target, attempts: item.attempts, nextAt: item.nextAt > 0 ? new Date(item.nextAt).toISOString() : null, error: item.error });
    },
    async list(bookId) {
      const identity = scope();
      const entries = await store.bind(identity).outbox.list(bookId === undefined ? {} : { bookId });
      return entries.flatMap((entry): CopyOutboxItem[] => {
        if (!isCopyTargetKind(entry.target)) return [];
        const nextAt = entry.nextAt ? Date.parse(entry.nextAt) : 0;
        return [{ bookId: entry.bookId, taskId: entry.taskId, target: entry.target, attempts: entry.attempts, nextAt: Number.isFinite(nextAt) ? nextAt : 0, error: entry.error as CopyErrorCode | null, scope: identity }];
      });
    },
    async delete(bookId, taskId, target) {
      await store.bind(scope()).outbox.delete(bookId, taskId, target);
    },
  };
}

const bookOf = (bookId: string) => useSettingsStore.getState().settings.books.find((entry) => entry.id === bookId);

/** An answer of the personal server that says there is nothing there to delete: a server older than the records (501), or one that does not know the book (404). */
function nothingOnServer(error: unknown): boolean {
  const status = error instanceof Error ? (error as { status?: unknown }).status : undefined;
  return status === 501 || status === 404;
}

/**
 * Deletes the records of a book on this device and, when the book runs on the personal server, there too: the two go together, and a server that cannot be reached
 * leaves both as they are (the author is told, and tries again). Copies in a place the author chose stay until they are deleted there.
 */
export async function deleteBookRecords(bookId: string, host: "browser" | "server"): Promise<void> {
  if (host === "server") {
    const { verifiedClient } = await import("@/autopilot/serverIdentity");
    const client = await verifiedClient();
    await client.deleteCalls(bookId).catch((error: unknown) => {
      if (!nothingOnServer(error)) throw error;
    });
  }
  const store = await getAiCallStore();
  await store?.bind(currentRepositoryScopeIdentity()).deleteBook(bookId);
}

let hosted: Promise<IndexedDbAiCallStore | null> | null = null;

/** The copies of a finished task, when its book has a place to copy to: the task is queued and the copier goes. */
async function copyFinished({ bookId, activityId, scope }: TaskFinishedEvent): Promise<void> {
  if (scope !== currentRepositoryScopeIdentity()) return;
  const book = bookOf(bookId);
  if (!book || !isCopyTargetKind(book.aiCallsCopy)) return;
  const { startCopiesRuntime } = await import("@/autopilot/calls/copies/runtime");
  await startCopiesRuntime().taskFinished(bookId, activityId);
}

async function startHost(): Promise<IndexedDbAiCallStore | null> {
  const store = await getAiCallStore();
  if (!store) return null;
  const { configureCopyServices } = await import("@/autopilot/calls/copies/services");
  // The copies read the store at each call, for the account the page is in; what they queue is kept in the store's own outbox, so that a reload resumes it.
  configureCopyServices({
    store: () => openedAiCallStore()?.bind(currentRepositoryScopeIdentity()) ?? null,
    outbox: copyOutboxOf(store),
    deleteRecords: deleteBookRecords,
  });
  // A task is copied when it is saved as finished: whether the engine's session of this browser ended its step, or the copy of a server's records made it whole here.
  store.onTaskFinished((event) => {
    void copyFinished(event).catch(() => undefined);
  });
  startCopiesForBooksThatHaveAPlace();
  return store;
}

/**
 * The books that have a place to copy to are copied from what is here: what a closed page left in the outbox goes on, and what the store holds that was never copied is
 * queued. It is asked again at each call of `ensureCallsHost`, because the settings that say which books have a place may arrive after the host was first made ready.
 */
function startCopiesForBooksThatHaveAPlace(): void {
  if (!useSettingsStore.getState().settings.books.some((book) => isCopyTargetKind(book.aiCallsCopy))) return;
  void import("@/autopilot/calls/copies/runtime").then(({ startCopiesRuntime }) => startCopiesRuntime()).catch(() => undefined);
}

/**
 * Opens the store of this browser and gives the copies what the host owns: the store, its outbox and the deletion (`configureCopyServices`), and starts them for the books
 * that have a place to copy to. Called when the autopilot's session is made, when the app opens with such a book and when the settings tab is shown; it does all of it once.
 * Resolves with the store, or `null` when this browser keeps none, and never rejects.
 */
export function ensureCallsHost(): Promise<IndexedDbAiCallStore | null> {
  hosted ??= startHost().then(
    (store) => {
      if (!store) hosted = null;
      return store;
    },
    () => {
      hosted = null;
      return null;
    },
  );
  return hosted.then((store) => {
    if (store) startCopiesForBooksThatHaveAPlace();
    return store;
  });
}

const copiers = new Map<string, Promise<ServerCallsCopier | null>>();

/**
 * Copies the finished tasks that the personal server holds for a book into this browser's store (always local, whoever ran the book): call it when the server is attached
 * and when a run of the book ends, with the engine's client of the server, when the server announces `autopilot-calls`. The tasks that come are copied on to the place the author
 * chose, as the ones this browser ran. It does nothing for a book whose recording is turned off on this device. Resolves with how it went, and never rejects; `null` when
 * nothing was done.
 */
export async function copyServerCalls(bookId: string, api: ServerCallsApi, reason: "open" | "run-ended" = "open"): Promise<CopyReport | null> {
  if (!isRecording(bookId)) return null;
  const identity = currentRepositoryScopeIdentity();
  let made = copiers.get(identity);
  if (!made) {
    made = (async () => {
      const [store, { ServerCallsCopier: Copier }] = await Promise.all([ensureCallsHost(), import("@/autopilot/calls/copier")]);
      return store ? new Copier({ store, api, identity }) : null;
    })().catch(() => null);
    copiers.set(identity, made);
  }
  const copier = await made;
  if (!copier) {
    copiers.delete(identity);
    return null;
  }
  copier.useApi(api);
  return copier.catchUp(bookId, reason);
}

/** Forgets what the host started (a test starts it again with its own store). */
export function resetCallsHostForTests(): void {
  hosted = null;
  copiers.clear();
}
