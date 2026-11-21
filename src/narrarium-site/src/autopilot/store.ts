import { create } from "zustand";
import type { AutopilotActivity, AutopilotEvent, AutopilotSnapshot, AutopilotStateSummary, InterventionInput, ServerBookSummary, ServerInfo, ServerUpdateInfo } from "narrarium-engine";

export type AutopilotHostKind = "browser" | "server";
export type ServerConnectionStatus = "disabled" | "connecting" | "online" | "offline" | "error";

export interface BookSyncStatus {
  at: string;
  ok: boolean;
  /** `synced`, `published`, `local-changes`, `conflicts:<n>` or an error message. */
  message: string;
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
}

export interface FeedEntry {
  event: AutopilotEvent;
  bookTitle: string;
}

export interface LivePreview {
  activity: AutopilotActivity;
  characters: number;
  preview: string;
}

export interface ServerConnectionState {
  status: ServerConnectionStatus;
  info: ServerInfo | null;
  message: string | null;
  books: ServerBookSummary[];
  /** Release check made once per connection (a newer verified server version, if any). */
  updates: ServerUpdateInfo | null;
}

interface AutopilotStoreState {
  views: Record<string, BookAutopilotView>;
  /** Everything that happened, across books, oldest first (streaming previews excluded). */
  feed: FeedEntry[];
  live: Record<string, LivePreview | null>;
  summaries: Record<string, AutopilotStateSummary>;
  server: ServerConnectionState;
  dockOpen: boolean;
  dockTab: "live" | "book";
  setDockOpen: (open: boolean) => void;
  setDockTab: (tab: "live" | "book") => void;
  patchView: (bookId: string, patch: Partial<BookAutopilotView>) => void;
  ingest: (event: AutopilotEvent, bookTitle: string) => void;
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

export function emptyView(bookId: string): BookAutopilotView {
  return { bookId, snapshot: null, loading: false, error: null, busyInAnotherTab: false, server: null, sync: null };
}

export const useAutopilotStore = create<AutopilotStoreState>()((set) => ({
  views: {},
  feed: initialFeed(),
  live: {},
  summaries: {},
  server: { status: "disabled", info: null, message: null, books: [], updates: null },
  dockOpen: initialDockOpen(),
  dockTab: "live",
  setDockOpen: (open) => {
    try {
      localStorage.setItem(DOCK_KEY, open ? "open" : "closed");
    } catch {
      // Storage may be unavailable; the dock still works for this session.
    }
    set({ dockOpen: open });
  },
  setDockTab: (tab) => set({ dockTab: tab }),
  patchView: (bookId, patch) => set((state) => ({ views: { ...state.views, [bookId]: { ...(state.views[bookId] ?? emptyView(bookId)), ...patch } } })),
  ingest: (event, bookTitle) => set((state) => {
    if (event.type === "task-progress") {
      const current = state.live[event.bookId];
      if (!current || current.activity.id !== event.activityId) return {};
      return { live: { ...state.live, [event.bookId]: { ...current, characters: event.characters, preview: event.preview } } };
    }
    if (event.type === "state") return { summaries: { ...state.summaries, [event.bookId]: event.state } };
    let live = state.live;
    if (event.type === "task-started") live = { ...live, [event.bookId]: { activity: event.activity, characters: 0, preview: "" } };
    else if (event.type === "task-finished" || event.type === "run-ended") live = { ...live, [event.bookId]: null };
    const duplicate = state.feed.some((entry) => entry.event.bookId === event.bookId && entry.event.seq === event.seq && entry.event.at === event.at);
    return { live, feed: duplicate ? state.feed : [...state.feed, { event, bookTitle }].slice(-MAX_FEED) };
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
  | { type: "pause"; mode: "now" | "after-step" }
  | { type: "intervene"; input: InterventionInput };

export type AutopilotChannelMessage =
  | { kind: "event"; event: AutopilotEvent; bookTitle: string }
  | { kind: "command"; id: string; bookId: string; command: RelayedCommand }
  | { kind: "command-result"; id: string; ok: boolean; error?: string };

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
