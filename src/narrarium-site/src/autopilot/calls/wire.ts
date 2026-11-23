import { pickAiRuntimeConfig, type AiCallBegin, type AiCallEnd, type AiCallField, type AiCallPruneResult, type AiCallStore, type AiCallTask, type AiCallTaskDraft, type AiCallTaskPage, type AiCallTextChunk, type AiCallTotals, type AutopilotSessionConfig } from "narrarium-engine";
import { currentRepositoryScopeIdentity } from "@/repository/repositoryOperationScope";
import { useSettingsStore } from "@/store/settingsStore";
import { isRecording } from "@/autopilot/calls/recording";
import type { IndexedDbAiCallStore } from "@/autopilot/calls/store";

/**
 * Where the browser's AI call store meets the rest of the site. This module is small on purpose: the store is loaded on first use (a chunk of its own, never part of the
 * entry), and what is here is what the code that creates a session needs: `wireBrowserCalls`, and the store for whoever reads it (`getAiCallStore`, and its state for a view).
 * The host of the browser (the copies, the copy of a server's records, the deletion) is `calls/host.ts`.
 */

/**
 * Whether the browser's session records the calls of a task: it hands the engine the store (`AutopilotSessionConfig.calls`). The engine that records them is in this build,
 * so it is `true`; `wireBrowserCalls` adds nothing when it is `false`, and the autopilot then runs as it did before the records.
 */
export const ENGINE_RECORDS_CALLS = true;

/**
 * The fields that the session's configuration takes for the AI calls: they are the engine's own (a typed spread of this into `new AutopilotSession({ … })` stops compiling the
 * day the engine renames one). `callsSecrets` is a getter, read when each call starts.
 */
export type BrowserCallsConfig = Pick<AutopilotSessionConfig, "calls" | "callsSecrets" | "callsAccountScope">;

/** How long a failure to open the database is remembered before the next try. */
const RETRY_AFTER_FAILURE_MS = 30_000;

/** The store of this browser as a view sees it: not asked for yet, opening, open, or not to be had here (no IndexedDB, a private window that refuses it, a database another tab blocks). */
export interface CallsStoreState {
  status: "idle" | "opening" | "ready" | "none";
  store: IndexedDbAiCallStore | null;
}

let opened: Promise<IndexedDbAiCallStore | null> | null = null;
let failedAt = 0;
let state: CallsStoreState = { status: "idle", store: null };
const stateListeners = new Set<() => void>();

function setState(next: CallsStoreState): void {
  state = next;
  for (const listener of [...stateListeners]) listener();
}

/** The state of the browser's store now (for `useSyncExternalStore`): the same object until it changes. */
export function callsStoreState(): CallsStoreState {
  return state;
}

/** Calls `listener` when the state of the store changes. Returns what stops it. */
export function subscribeCallsStore(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

/** The browser's store when it is open, and `null` otherwise: for the code that cannot wait for it (the copies read it at each call). Never opens it. */
export function openedAiCallStore(): IndexedDbAiCallStore | null {
  return state.store;
}

/**
 * The browser's AI call store, opened on first use and once for the tab, or `null` when this browser does not let it (no IndexedDB, a private window that refuses it,
 * a database that another tab blocks): the autopilot then runs as it always did, and nothing here throws. A failure is remembered for half a minute and tried again.
 */
export function getAiCallStore(): Promise<IndexedDbAiCallStore | null> {
  if (opened && failedAt && Date.now() - failedAt > RETRY_AFTER_FAILURE_MS) {
    opened = null;
    failedAt = 0;
  }
  if (!opened) {
    if (state.status !== "ready") setState({ status: "opening", store: null });
    opened = import("@/autopilot/calls/store")
      .then(({ IndexedDbAiCallStore: Store }) => Store.open())
      .then(
        (store) => {
          failedAt = 0;
          setState({ status: "ready", store });
          return store;
        },
        () => {
          failedAt = Date.now();
          setState({ status: "none", store: null });
          return null;
        },
      );
  }
  return opened;
}

/** Forgets the store that was opened (a test opens its own). */
export function resetAiCallStoreForTests(): void {
  opened = null;
  failedAt = 0;
  state = { status: "idle", store: null };
}

/**
 * The keys and tokens that the site knows and that no record may keep: the keys of the author's AI integrations, as the engine's client sends them, and the
 * GitHub tokens and the token of the personal server. The recorder replaces each of them in every text before it is written. Read when it is asked, so that a key
 * the author changes during a run is known to the next call.
 */
export function browserCallsSecrets(): string[] {
  const settings = useSettingsStore.getState().settings;
  const found = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) found.add(value.trim());
  };
  try {
    for (const integration of pickAiRuntimeConfig(settings).aiIntegrations) add(integration.apiKey);
  } catch {
    // A configuration that cannot be read has no keys to give; the ones below are still known.
  }
  add(settings.azureOpenAI?.apiKey);
  for (const integration of settings.aiIntegrations ?? []) add(integration.apiKey);
  add(settings.defaultGitHubToken);
  for (const token of settings.extraGitHubTokens ?? []) add(token.token);
  add(settings.personalServer?.token);
  return [...found];
}

/** The writes of the sessions that the facades of the store have given to the browser's store and that are not over: the engine does not wait for the store, so a run can end before its records do. */
const inflight = new Set<Promise<unknown>>();

function tracked<T>(work: Promise<T>): Promise<T> {
  inflight.add(work);
  void work.then(() => inflight.delete(work), () => inflight.delete(work));
  return work;
}

/** Resolves when every write that a session has made through the facades is over, those it starts meanwhile included: what a test, or a check in a real browser, waits for before it reads what a run recorded. */
export async function callsWritesSettled(): Promise<void> {
  while (inflight.size) await Promise.allSettled([...inflight]);
}

const NOTHING_PRUNED: AiCallPruneResult = { dropped: [], bytes: 0, pinnedTasks: 0, pinnedBytes: 0, overBudget: false };
const NO_TOTALS: AiCallTotals = { bytes: 0, tasks: 0, calls: 0, pinnedTasks: 0, pinnedBytes: 0 };

/**
 * A store for a session that is made now, for the account the page is in now: it opens the real store when a call is first written, and writes for that
 * account for ever (what a session of an account that the page has left writes is dropped). A browser that does not let the store open gets a store that keeps
 * nothing and fails at nothing, so that the run goes on. Views read through it while the real store is still opening.
 */
export function callsStoreFacade(identity: string): AiCallStore {
  let bound: Promise<AiCallStore | null> | null = null;
  const target = () => (bound ??= getAiCallStore().then((store) => store?.bind(identity) ?? null));
  return {
    begin(begin: AiCallBegin) {
      return tracked((async () => {
        await (await target())?.begin(begin);
      })());
    },
    append(callId: string, attempt: number, offset: number, text: string) {
      return tracked((async () => {
        await (await target())?.append(callId, attempt, offset, text);
      })());
    },
    end(callId: string, final: AiCallEnd) {
      return tracked((async () => {
        await (await target())?.end(callId, final);
      })());
    },
    saveTask(draft: AiCallTaskDraft) {
      return tracked((async () => {
        await (await target())?.saveTask(draft);
      })());
    },
    async listTasks(bookId: string, page: { before?: string; limit: number }): Promise<AiCallTaskPage> {
      return (await (await target())?.listTasks(bookId, page)) ?? { tasks: [], next: null };
    },
    async readTask(bookId: string, activityId: string): Promise<AiCallTask | null> {
      return (await (await target())?.readTask(bookId, activityId)) ?? null;
    },
    async readText(bookId: string, callId: string, field: AiCallField, from: number, attempt?: number): Promise<AiCallTextChunk | null> {
      return (await (await target())?.readText(bookId, callId, field, from, attempt)) ?? null;
    },
    keep(bookId: string, activityId: string, pinned: boolean) {
      return tracked((async () => {
        await (await target())?.keep(bookId, activityId, pinned);
      })());
    },
    deleteBook(bookId: string) {
      return tracked((async () => {
        await (await target())?.deleteBook(bookId);
      })());
    },
    prune(bookId: string, budget: number): Promise<AiCallPruneResult> {
      return tracked((async () => (await (await target())?.prune(bookId, budget)) ?? NOTHING_PRUNED)());
    },
    async totals(bookId: string): Promise<AiCallTotals> {
      return (await (await target())?.totals(bookId)) ?? NO_TOTALS;
    },
  };
}

/**
 * The fields to add to the configuration of the browser's `AutopilotSession`: the store of the AI calls, for the account the page is in (and that account, which is what the
 * records say they belong to), and the secrets that no record may keep. It is spread into the configuration where the session is made. It adds nothing, and the autopilot
 * runs as it did without the records, when the recording is turned off for the book on this device (`recording.ts`), in a browser without IndexedDB, while
 * `ENGINE_RECORDS_CALLS` is `false`, and when `enabled` says no. A browser whose IndexedDB refuses to open gets a store that keeps nothing. Nothing here opens the database:
 * that happens when the first call is written.
 */
export function wireBrowserCalls(options: { bookId?: string; enabled?: boolean } = {}): BrowserCallsConfig {
  if (!(options.enabled ?? ENGINE_RECORDS_CALLS)) return {};
  if (typeof indexedDB === "undefined") return {};
  if (options.bookId !== undefined && !isRecording(options.bookId)) return {};
  const identity = currentRepositoryScopeIdentity();
  return { calls: callsStoreFacade(identity), callsSecrets: browserCallsSecrets, callsAccountScope: identity };
}
