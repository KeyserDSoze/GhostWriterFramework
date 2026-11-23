import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { AiCallStore, ServerInfo } from "narrarium-engine";
import { callsStoreFacade, callsStoreState, getAiCallStore, subscribeCallsStore } from "@/autopilot/calls/wire";
import { useRecording } from "@/autopilot/calls/recording";
import { serverKeepsCalls, unavailableCallsSource, type CallsSource } from "@/autopilot/calls/source";
import { localCallsSource } from "@/autopilot/calls/sourceLocal";
import { serverCallsSource, type CallsClient } from "@/autopilot/calls/sourceServer";
import { useServerConnection } from "@/autopilot/serverConnection";
import { currentRepositoryScopeIdentity } from "@/repository/repositoryOperationScope";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";

/** Where a book's autopilot runs, and so where its records are kept. */
export type CallsHost = "browser" | "server";

/** Gives the source of a book's records: what tests and the checks of the interface in a real browser put in place of the hosts' stores. */
export type CallsSourceFactory = (bookId: string, host: CallsHost) => CallsSource | null | undefined;

let provided: CallsSourceFactory | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const current = () => provided;

/** Puts `factory` in place of the hosts' sources for every view that is open and every view that opens; `null` gives them back. */
export function provideCallsSources(factory: CallsSourceFactory | null): void {
  provided = factory;
  for (const listener of listeners) listener();
}

/** What the source of a host needs to know of the personal server: whether it is connected, and what it announces. */
export interface ServerState {
  online: boolean;
  info: Pick<ServerInfo, "features"> | null;
}

/** What the source of a book needs of this browser besides where the book runs. */
export interface HostCallsContext {
  /** This browser's store, for the account the page is in: `undefined` while it opens (the views read through a facade that waits for it), `null` when this browser keeps none. */
  store?: AiCallStore | null;
  /** The recording of the book is on for this device (default). */
  recording?: boolean;
  /** The account the page is in (default: the site's): the facade of a store that is still opening acts for it. */
  identity?: string;
  /** The engine's client of the connected server, for a book that runs there (default: the one of the settings' personal server, verified when it is first asked). */
  client?: CallsClient;
}

/**
 * The engine's client of the personal server of the settings, asked for when something is read: the server must prove the identity pinned in the settings first
 * (`verifiedClient`), and that is loaded only when a book of the server is looked at. Every method delegates to the client it gets then.
 */
export function connectedServerClient(): CallsClient {
  const client = async () => (await import("@/autopilot/serverIdentity")).verifiedClient();
  return {
    listCalls: async (bookId, page) => (await client()).listCalls(bookId, page),
    readCallTask: async (bookId, activityId) => (await client()).readCallTask(bookId, activityId),
    readCallText: async (bookId, callId, options) => (await client()).readCallText(bookId, callId, options),
    keepCallTask: async (bookId, activityId, pinned) => (await client()).keepCallTask(bookId, activityId, pinned),
    deleteCalls: async (bookId) => (await client()).deleteCalls(bookId),
  };
}

/** Deletes the records of a book on this device: what goes with a deletion on the personal server. */
async function deleteHere(bookId: string): Promise<void> {
  const store = await getAiCallStore();
  await store?.bind(currentRepositoryScopeIdentity()).deleteBook(bookId);
}

/**
 * The source of the records of a book by where it runs. A book on a personal server that is older than the records says so (`server-outdated`), one whose server is not
 * connected waits for it (`server-offline`), and one whose server answers is read through the engine's client of it. A book that runs in this browser is read from this
 * browser's store, or says that there is none (`no-store`: no IndexedDB, as in some private windows). When the recording of the book is turned off on this device the records
 * that were kept are read all the same, and the source says that nothing more is kept (`notRecording`): the messages are the author's to see and to delete.
 */
export function hostCallsSource(host: CallsHost, server: ServerState, context: HostCallsContext = {}): CallsSource {
  if (host === "server") {
    if (!server.online) return unavailableCallsSource("server-offline");
    if (!serverKeepsCalls(server.info)) return unavailableCallsSource("server-outdated");
    return serverCallsSource(context.client ?? connectedServerClient(), { alsoDelete: deleteHere });
  }
  if (context.store === null) return unavailableCallsSource("no-store");
  const store = context.store ?? callsStoreFacade(context.identity ?? currentRepositoryScopeIdentity());
  return localCallsSource(store, { notRecording: context.recording === false });
}

/** The account the page is in, drawn again when it changes (`currentRepositoryScopeIdentity` reads the account of the settings and the signed-in user). */
function useScopeIdentity(): string {
  useSettingsStore((state) => state.accountIdentity);
  useSettingsStore((state) => state.accountGeneration);
  useAuthStore((state) => state.user);
  return currentRepositoryScopeIdentity();
}

/** This browser's store for a book that runs here, as the views read it: opened when the view is first shown. `undefined` while it opens, `null` when this browser keeps none. */
function useBrowserCallsStore(enabled: boolean, identity: string): AiCallStore | null | undefined {
  const state = useSyncExternalStore(subscribeCallsStore, callsStoreState, callsStoreState);
  useEffect(() => {
    if (enabled) void getAiCallStore();
  }, [enabled]);
  // The store acts for the account the page is in: another account binds it again.
  return useMemo(() => (!enabled || state.status === "idle" || state.status === "opening" ? undefined : state.store ? state.store.bind(identity) : null), [enabled, state, identity]);
}

/** The source of the records of a book, as the views read them, followed as the book moves between hosts and the server comes and goes. */
export function useCallsSource(bookId: string): CallsSource {
  const host: CallsHost = useSettingsStore((state) => (state.settings.books.find((book) => book.id === bookId)?.autopilotHost === "server" ? "server" : "browser"));
  const factory = useSyncExternalStore(subscribe, current, current);
  const connection = useServerConnection();
  const online = connection.status === "online";
  const info = connection.info;
  const recording = useRecording(bookId);
  const identity = useScopeIdentity();
  const store = useBrowserCallsStore(host === "browser" && !factory, identity);
  return useMemo(() => factory?.(bookId, host) ?? hostCallsSource(host, { online, info }, { store, recording, identity }), [factory, bookId, host, online, info, store, recording, identity]);
}
