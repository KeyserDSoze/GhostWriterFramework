import { bookStorageMode, type BookEntry } from "@/types/settings";

/** The tabs of a book's settings, in the order they are shown. */
export const BOOK_SETTINGS_TABS = ["general", "github", "reader", "export", "audit"] as const;
export type BookSettingsTab = (typeof BOOK_SETTINGS_TABS)[number];

export const DEFAULT_BOOK_SETTINGS_TAB: BookSettingsTab = "general";

const ALIASES: Record<string, BookSettingsTab> = {
  "online-reader": "reader",
  "reader-access": "reader",
  repository: "github",
  branch: "github",
  metadata: "general",
};

/** The tab a link to `#…` selects (`#github`, `#reader`, …), or `undefined` for anything else. */
export function bookSettingsTabOfHash(hash: string): BookSettingsTab | undefined {
  let id: string;
  try { id = decodeURIComponent(hash.replace(/^#/, "")).trim().toLowerCase(); } catch { return undefined; }
  if ((BOOK_SETTINGS_TABS as readonly string[]).includes(id)) return id as BookSettingsTab;
  return ALIASES[id];
}

export function bookSettingsHash(tab: BookSettingsTab): string {
  return `#${tab}`;
}

/**
 * What a tab can do for this book. A book that lives only on this device has a GitHub tab that offers to connect it, and an Online reader tab that says
 * why it is not available yet: neither is hidden, so the settings are the same places for every book.
 */
export interface BookSettingsTabState {
  tab: BookSettingsTab;
  /** The tab has its content. `false`: it is shown with the reason (`reason`) instead. */
  available: boolean;
  reason?: "needs-github";
}

export function bookSettingsTabState(book: Pick<BookEntry, "storageMode">): BookSettingsTabState[] {
  const github = bookStorageMode(book as BookEntry) === "github";
  return BOOK_SETTINGS_TABS.map((tab) => (tab === "reader" && !github ? { tab, available: false, reason: "needs-github" as const } : { tab, available: true }));
}
