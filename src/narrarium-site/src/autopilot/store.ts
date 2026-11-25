import { create } from "zustand";
import { applyLiveAttempt, applyLiveProgress, normalizeLive, startLive } from "narrarium-engine";
import type { AutopilotEvent, AutopilotLive, AutopilotLiveOptions, AutopilotMessageCode, AutopilotSnapshot, AutopilotStateSummary, AutopilotStatus, FrozenAction, FrozenChangeKind, InterventionInput, ServerBookSummary, ServerInfo, ServerStreamMessage, ServerUpdateInfo, SyncSkippedFile } from "narrarium-engine";
import type { HandoverPlan, HandoverSide } from "@/autopilot/handover";
import type { BookOperation } from "@/autopilot/operations";
import type { PersonalServerSettings } from "@/types/settings";

export type AutopilotHostKind = "browser" | "server";
/** `reconnecting`: the connection was online and went quiet or closed, and is being opened again. */
export type ServerConnectionStatus = "disabled" | "connecting" | "online" | "offline" | "error" | "reconnecting";

/** `partial`: the sync went through, but some files could not be moved (see `SyncOutcome.skipped`): it is not "all synced". */
export type SyncOutcomeKind = "synced" | "up-to-date" | "published" | "partial" | "local-changes" | "conflicts" | "error";
/** What happened to a file on one side since the last sync: it was edited, it is new there, or it was deleted there. */
export type ConflictSide = "modified" | "added" | "deleted";

/** A file that changed differently on both sides, and what each side did to it. Sizes are in bytes, when they could be read. */
export interface SyncConflict {
  path: string;
  local: ConflictSide;
  remote: ConflictSide;
  localBytes?: number;
  remoteBytes?: number;
}

/** How a sync with the personal server ended. Only `synced`, `up-to-date` and `published` are `ok`. */
export interface SyncOutcome {
  ok: boolean;
  kind: SyncOutcomeKind;
  /** Paths changed on both sides and not settled. */
  conflicts: string[];
  /** The same files with what happened on each side. */
  conflictDetails: SyncConflict[];
  /** Files the sync did not move, and why (too large, not a safe path, not text): said again at every sync until they can be moved. Absent in a status from before this was reported. */
  skipped?: SyncSkippedFile[];
  /** In the language of the app: what happened, or why it failed. */
  message: string;
  /** No base was ever saved for this book and server: nothing is deleted, files missing on one side are copied back. */
  firstSync: boolean;
  uploaded: number;
  downloaded: number;
  /** The base for the next sync could not be saved (storage full or blocked): the next sync will not see deletions. */
  baseSaved: boolean;
}

export interface BookSyncStatus extends SyncOutcome {
  at: string;
}

export interface BookAutopilotView {
  bookId: string;
  snapshot: AutopilotSnapshot | null;
  loading: boolean;
  error: string | null;
  /** Running in another tab of this browser (its Web Lock is held elsewhere). */
  busyInAnotherTab: boolean;
  /** Server-side summary when the book is hosted on the personal server. */
  server: ServerBookSummary | null;
  sync: BookSyncStatus | null;
  /** What holds the book right now (a move, a sync, a start…): the same for every component showing the book. */
  operation: BookOperation | null;
  /** The plan to move the autopilot of the book to the other side (browser or server): an intention of this tab, not saved anywhere. */
  handover: HandoverPlan | null;
}

export interface FeedEntry {
  event: AutopilotEvent;
  bookTitle: string;
}

/**
 * What the panels show of the step that runs: the engine's live part (`AutopilotLive`), changed by the engine's one rule (`applyLiveProgress`, and
 * `applyLiveAttempt` for the candidate of the route that the call asks, `trying`), as the session's `snapshot().live` is. The text of a call (its prose, or the
 * JSON of a structured reply, `json`) never goes back to nothing until the call ends, its count never goes down within an attempt, the bytes of a structured
 * reply say «answering» only while it has no text, and a new call of the step starts from nothing.
 */
export type LivePreview = AutopilotLive;

export interface ServerConnectionState {
  status: ServerConnectionStatus;
  info: ServerInfo | null;
  message: string | null;
  books: ServerBookSummary[];
  /** Release check made once per connection (a newer verified server version, if any). */
  updates: ServerUpdateInfo | null;
  /**
   * The connection the status above belongs to: the address, token and pinned identity the runtime
   * follows. What is being typed in the settings is not connected until the runtime picked it up.
   * `online` means this server proved the pinned identity and accepted the token.
   */
  connection: PersonalServerSettings | null;
}

/** A request to open the flow of "Where it runs" for a book on its page (the quick commands ask for it when a consent is missing). */
export interface WhereIntent {
  bookId: string;
  side: HandoverSide;
  /** When it was asked: a second request for the same book is a new one. */
  at: number;
}

interface AutopilotStoreState {
  views: Record<string, BookAutopilotView>;
  /** Everything that happened, across books, oldest first (streaming previews excluded). */
  feed: FeedEntry[];
  live: Record<string, LivePreview | null>;
  summaries: Record<string, AutopilotStateSummary>;
  server: ServerConnectionState;
  dockOpen: boolean;
  /** The live panel brought back on a page of the autopilot, which hides it by itself (the page shows everything the panel would). Not saved: every visit to those pages starts without it. */
  pageDockOpen: boolean;
  dockTab: "live" | "book";
  /** The book the author chose to command from the live tab of the dock, among the ones that could be (null: the default). */
  dockFocusBook: string | null;
  whereIntent: WhereIntent | null;
  setDockOpen: (open: boolean) => void;
  setPageDockOpen: (open: boolean) => void;
  setDockTab: (tab: "live" | "book") => void;
  setDockFocusBook: (bookId: string | null) => void;
  setWhereIntent: (intent: WhereIntent | null) => void;
  patchView: (bookId: string, patch: Partial<BookAutopilotView>) => void;
  ingest: (event: AutopilotEvent, bookTitle: string) => void;
  /** What another tab that runs the book says of its step (the live part, read as any live part from elsewhere): kept only while this tab follows no step of the book. */
  seedLive: (bookId: string, live: unknown) => void;
  setServer: (patch: Partial<ServerConnectionState>) => void;
  clearFeed: () => void;
}

const MAX_FEED = 500;
const PERSISTED_FEED = 150;
const DOCK_KEY = "narrarium-autopilot-dock-v1";
const FEED_KEY = "narrarium-autopilot-feed-v1";

/** The live feed survives reloads on this device, so the dock keeps showing what happened. */
function initialFeed(): FeedEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(FEED_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is FeedEntry => Boolean(entry && typeof entry === "object" && typeof entry.bookTitle === "string" && entry.event && typeof entry.event.bookId === "string" && typeof entry.event.type === "string"))
      .slice(-PERSISTED_FEED);
  } catch {
    return [];
  }
}

function initialDockOpen(): boolean {
  try {
    return localStorage.getItem(DOCK_KEY) === "open";
  } catch {
    return false;
  }
}

/**
 * The step a snapshot says runs, for a book whose panels follow none (a page opened while it ran, a connection that came back after a gap): its live
 * part, so that what it writes is shown again at once and the events that follow go on from it. Nothing when the panels follow a step already, when
 * the snapshot says nothing runs, or when the events said that step ended.
 */
function liveFromSnapshot(state: Pick<AutopilotStoreState, "live" | "feed">, bookId: string, snapshot: Pick<AutopilotSnapshot, "running" | "live"> | null): LivePreview | null {
  if (!snapshot?.running || state.live[bookId]) return null;
  const live = normalizeLive(snapshot.live);
  if (!live || live.activity.status !== "running") return null;
  const ended = state.feed.some((entry) => entry.event.bookId === bookId && entry.event.type === "task-finished" && entry.event.activity.id === live.activity.id);
  return ended ? null : live;
}

export function emptyView(bookId: string): BookAutopilotView {
  return { bookId, snapshot: null, loading: false, error: null, busyInAnotherTab: false, server: null, sync: null, operation: null, handover: null };
}

/** When something was last heard of each book (any event, even a streamed word), by this tab. Not state: it changes with every event. */
const signals = new Map<string, number>();

/** Milliseconds since the epoch of the last event received for a book, or `undefined`. */
export function lastSignalAt(bookId: string): number | undefined {
  return signals.get(bookId);
}

/** How the last run of a book ended, as its `run-ended` event said, and when this tab heard it. */
export interface RunEnd {
  status: AutopilotStatus;
  message: string | null;
  code?: AutopilotMessageCode;
  at: number;
}

/** The last `run-ended` heard for each book (a handover tells a pause it asked for from a stop for another reason). Not state: nothing shows it. */
const runEnds = new Map<string, RunEnd>();

export function lastRunEnd(bookId: string): RunEnd | undefined {
  return runEnds.get(bookId);
}

export const useAutopilotStore = create<AutopilotStoreState>()((set) => ({
  views: {},
  feed: initialFeed(),
  live: {},
  summaries: {},
  server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null },
  dockOpen: initialDockOpen(),
  pageDockOpen: false,
  dockTab: "book",
  dockFocusBook: null,
  whereIntent: null,
  setDockFocusBook: (bookId) => set({ dockFocusBook: bookId }),
  setWhereIntent: (intent) => set({ whereIntent: intent }),
  setDockOpen: (open) => {
    try {
      localStorage.setItem(DOCK_KEY, open ? "open" : "closed");
    } catch {
      // Storage may be unavailable; the dock still works for this session.
    }
    set({ dockOpen: open });
  },
  setPageDockOpen: (open) => set({ pageDockOpen: open }),
  setDockTab: (tab) => set({ dockTab: tab }),
  patchView: (bookId, patch) => set((state) => {
    const views = { ...state.views, [bookId]: { ...(state.views[bookId] ?? emptyView(bookId)), ...patch } };
    const seeded = patch.snapshot ? liveFromSnapshot(state, bookId, patch.snapshot) : null;
    return seeded ? { views, live: { ...state.live, [bookId]: seeded } } : { views };
  }),
  ingest: (event, bookTitle) => set((state) => {
    signals.set(event.bookId, Date.now());
    if (event.type === "run-ended") runEnds.set(event.bookId, { status: event.status, message: event.message ?? null, ...(event.code ? { code: event.code } : {}), at: Date.now() });
    // What a call is writing, and which candidate of the route it asks, only change the live part: neither is an entry of the feed.
    if (event.type === "task-progress" || event.type === "call-attempt") {
      const current = state.live[event.bookId];
      if (!current || current.activity.id !== event.activityId) return {};
      const next = event.type === "call-attempt" ? applyLiveAttempt(current, event) : applyLiveProgress(current, event);
      return next === current ? {} : { live: { ...state.live, [event.bookId]: next } };
    }
    if (event.type === "state") return { summaries: { ...state.summaries, [event.bookId]: event.state } };
    let live = state.live;
    if (event.type === "task-started") live = { ...live, [event.bookId]: startLive(event.activity) };
    else if (event.type === "task-finished" || event.type === "run-ended") live = { ...live, [event.bookId]: null };
    const duplicate = state.feed.some((entry) => entry.event.bookId === event.bookId && entry.event.seq === event.seq && entry.event.at === event.at);
    return { live, feed: duplicate ? state.feed : [...state.feed, { event, bookTitle }].slice(-MAX_FEED) };
  }),
  seedLive: (bookId, value) => set((state) => {
    const seeded = liveFromSnapshot(state, bookId, { running: true, live: value as LivePreview | null });
    return seeded ? { live: { ...state.live, [bookId]: seeded } } : {};
  }),
  setServer: (patch) => set((state) => ({ server: { ...state.server, ...patch } })),
  clearFeed: () => set({ feed: [] }),
}));

let feedWrite: ReturnType<typeof setTimeout> | null = null;

function writeFeed(): void {
  if (feedWrite) clearTimeout(feedWrite);
  feedWrite = null;
  try {
    localStorage.setItem(FEED_KEY, JSON.stringify(useAutopilotStore.getState().feed.slice(-PERSISTED_FEED)));
  } catch {
    // Without storage the feed simply starts empty after a reload.
  }
}

useAutopilotStore.subscribe((state, previous) => {
  if (state.feed === previous.feed || feedWrite) return;
  feedWrite = setTimeout(writeFeed, 1000);
});

// Keep the latest events when the page is reloaded or closed before the debounced write.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => { if (feedWrite) writeFeed(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && feedWrite) writeFeed(); });
}

/** Latest meaningful event, optionally for one book (for the bottom-right ticker). */
export function latestFeedEntry(feed: FeedEntry[], bookId?: string): FeedEntry | undefined {
  for (let index = feed.length - 1; index >= 0; index -= 1) {
    const entry = feed[index];
    if (!bookId || entry.event.bookId === bookId) return entry;
  }
  return undefined;
}

// ─── Cross-tab channel ───────────────────────────────────────────────────────
// A run belongs to the tab holding the book's Web Lock. Other tabs of the same browser
// follow it through this channel and relay pause/intervention commands to it.

export type RelayedCommand =
  | { type: "pause"; mode: "now" | "after-step" | "after-chapter" }
  | { type: "cancel-pause" }
  | { type: "retry-now" }
  | { type: "update-options"; options: AutopilotLiveOptions }
  | { type: "intervene"; input: InterventionInput }
  | { type: "resolve-frozen"; number: number; action: FrozenAction; options?: { kind?: FrozenChangeKind; note?: string } }
  | { type: "set-frozen"; slug: string; frozen: boolean };

/** What the tab that holds the live connection tells the others about it. */
export type SharedServerState = Pick<ServerConnectionState, "status" | "info" | "message" | "books" | "updates">;

/**
 * `server-*` messages carry the live connection to the personal server: a browser keeps one for all its tabs (the server
 * accepts a few per token), and its leader tab tells the others what arrives. `stream` names the connection (a hash: the token is never sent).
 */
export type AutopilotChannelMessage =
  | { kind: "event"; event: AutopilotEvent; bookTitle: string }
  | { kind: "command"; id: string; bookId: string; command: RelayedCommand }
  /** `result` is what the command answers, when it answers something (whether «Retry now» skipped a wait). */
  | { kind: "command-result"; id: string; ok: boolean; error?: string; result?: boolean }
  | { kind: "server-message"; stream: string; message: ServerStreamMessage }
  | { kind: "server-state"; stream: string; state: SharedServerState }
  | { kind: "server-state-request"; stream: string }
  | { kind: "server-reconnect"; stream: string }
  | { kind: "server-reconnected"; stream: string }
  /** A tab that opened while another one runs the book asks what it shows of the step (the candidate of the route the call asks included): the tab that runs the book answers with `live`. */
  | { kind: "live-request"; bookId: string }
  | { kind: "live"; bookId: string; live: LivePreview }
  | { kind: "synced"; bookId: string; sync: BookSyncStatus };

/** The bits of `BroadcastChannel` the runtime uses. */
export type AutopilotChannel = Pick<BroadcastChannel, "postMessage" | "addEventListener" | "removeEventListener">;

const CHANNEL_NAME = "narrarium-autopilot-v1";
let channel: BroadcastChannel | null | undefined;

/** The tab-shared channel (one instance per tab, so a tab never receives its own messages). */
export function autopilotChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL_NAME) : null;
  (channel as (BroadcastChannel & { unref?: () => void }) | null)?.unref?.();
  channel?.addEventListener("message", (message: MessageEvent<AutopilotChannelMessage>) => {
    const data = message.data;
    if (data?.kind === "event" && data.event && typeof data.event.bookId === "string") useAutopilotStore.getState().ingest(data.event, data.bookTitle);
    else if (data?.kind === "live" && typeof data.bookId === "string") useAutopilotStore.getState().seedLive(data.bookId, data.live);
  });
  return channel;
}

export function shareAutopilotEvent(event: AutopilotEvent, bookTitle: string): void {
  try {
    autopilotChannel()?.postMessage({ kind: "event", event, bookTitle } satisfies AutopilotChannelMessage);
  } catch {
    // Another tab missing an update only delays its view until the next refresh.
  }
}
