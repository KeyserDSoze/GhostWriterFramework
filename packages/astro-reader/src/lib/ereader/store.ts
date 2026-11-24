/**
 * What the reader keeps on the device, all in localStorage under the id of the book (`narrarium-reader:<bookId>:...`): the reading
 * settings, the position, the bookmarks, the highlights and notes. Each value is versioned JSON; a value that cannot be read is treated as
 * empty, never as an error, and an entry that is not well formed is dropped on reading.
 */

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type ReaderTheme = "light" | "sepia" | "dark" | "auto";
export type ReaderFont = "serif" | "classic" | "sans" | "readable";
export type ReaderMode = "scroll" | "paged";
export type ReaderAlign = "start" | "justify";

export interface ReaderPrefs {
  theme: ReaderTheme;
  font: ReaderFont;
  /** Index in TEXT_SIZES. */
  size: number;
  /** Index in LINE_HEIGHTS. */
  leading: number;
  /** Index in MARGINS. */
  margin: number;
  /** Index in WIDTHS. */
  width: number;
  align: ReaderAlign;
  mode: ReaderMode;
  sceneTitles: boolean;
}

/** Percentages of the base text size (18px). */
export const TEXT_SIZES = [80, 90, 100, 112, 125, 140, 160, 180, 200] as const;
export const LINE_HEIGHTS = [1.3, 1.45, 1.6, 1.75, 1.9, 2.1] as const;
/** Inline margins of the page, in rem. */
export const MARGINS = [0.75, 1.25, 2, 3] as const;
/** Longest line, in em (0: the whole width). */
export const WIDTHS = [28, 34, 40, 0] as const;

export const DEFAULT_PREFS: ReaderPrefs = {
  theme: "auto",
  font: "serif",
  size: 2,
  leading: 2,
  margin: 1,
  width: 1,
  align: "start",
  mode: "scroll",
  sceneTitles: true,
};

/** Where a block of text is: a chapter, a scene of it, the n-th block (paragraph, quote, list...) of the scene. */
export interface ReaderPlace {
  chapter: string;
  scene: string;
  block: number;
}

export interface ReaderPosition extends ReaderPlace {
  at: string;
}

export interface Bookmark extends ReaderPlace {
  id: string;
  /** The first words of the block, to recognize it in the list. */
  excerpt: string;
  createdAt: string;
}

/** A range of text in one scene: from (startBlock, startOffset) to (endBlock, endOffset), offsets in the blocks' text. */
export interface TextRange {
  chapter: string;
  scene: string;
  startBlock: number;
  startOffset: number;
  endBlock: number;
  endOffset: number;
  /** The text of the range: it finds the place again when the text around it changes. */
  quote: string;
}

export interface Annotation extends TextRange {
  id: string;
  kind: "highlight" | "note";
  note?: string;
  createdAt: string;
  updatedAt: string;
}

const VERSION = 1;

function clampIndex(value: unknown, length: number, fallback: number): number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < length ? (value as number) : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function isPlace(value: Record<string, unknown>): boolean {
  return typeof value.chapter === "string" && Boolean(value.chapter) && typeof value.scene === "string" && Number.isInteger(value.block) && (value.block as number) >= 0;
}

function isRange(value: Record<string, unknown>): boolean {
  return typeof value.chapter === "string" && typeof value.scene === "string" && typeof value.quote === "string"
    && [value.startBlock, value.startOffset, value.endBlock, value.endOffset].every((entry) => Number.isInteger(entry) && (entry as number) >= 0);
}

function newId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class ReaderStoreError extends Error {
  constructor(cause: unknown) {
    super("The reader could not save on this device.");
    this.name = "ReaderStoreError";
    this.cause = cause;
  }
}

export class ReaderStore {
  private readonly prefix: string;

  constructor(private readonly storage: StorageLike, readonly bookId: string, private readonly now: () => Date = () => new Date()) {
    this.prefix = `narrarium-reader:${bookId}:`;
  }

  private read(name: string): Record<string, unknown> | null {
    try {
      const raw = this.storage.getItem(this.prefix + name);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  private write(name: string, value: Record<string, unknown>): void {
    try {
      this.storage.setItem(this.prefix + name, JSON.stringify({ v: VERSION, ...value }));
    } catch (error) {
      throw new ReaderStoreError(error);
    }
  }

  private list<T>(name: string, valid: (entry: Record<string, unknown>) => boolean): T[] {
    const value = this.read(name);
    const items = Array.isArray(value?.items) ? value.items : [];
    return items.filter((entry): entry is T => Boolean(entry && typeof entry === "object" && valid(entry as Record<string, unknown>)));
  }

  readPrefs(): ReaderPrefs {
    const saved = this.read("prefs") ?? {};
    return {
      theme: oneOf(saved.theme, ["light", "sepia", "dark", "auto"], DEFAULT_PREFS.theme),
      font: oneOf(saved.font, ["serif", "classic", "sans", "readable"], DEFAULT_PREFS.font),
      size: clampIndex(saved.size, TEXT_SIZES.length, DEFAULT_PREFS.size),
      leading: clampIndex(saved.leading, LINE_HEIGHTS.length, DEFAULT_PREFS.leading),
      margin: clampIndex(saved.margin, MARGINS.length, DEFAULT_PREFS.margin),
      width: clampIndex(saved.width, WIDTHS.length, DEFAULT_PREFS.width),
      align: oneOf(saved.align, ["start", "justify"], DEFAULT_PREFS.align),
      mode: oneOf(saved.mode, ["scroll", "paged"], DEFAULT_PREFS.mode),
      sceneTitles: typeof saved.sceneTitles === "boolean" ? saved.sceneTitles : DEFAULT_PREFS.sceneTitles,
    };
  }

  writePrefs(prefs: ReaderPrefs): void {
    this.write("prefs", { ...prefs });
  }

  resetPrefs(): ReaderPrefs {
    try {
      this.storage.removeItem(`${this.prefix}prefs`);
    } catch {
      // Nothing saved, nothing to remove.
    }
    return { ...DEFAULT_PREFS };
  }

  readPosition(): ReaderPosition | null {
    const saved = this.read("position");
    return saved && isPlace(saved) ? { chapter: String(saved.chapter), scene: String(saved.scene), block: Number(saved.block), at: String(saved.at ?? "") } : null;
  }

  writePosition(place: ReaderPlace): void {
    this.write("position", { chapter: place.chapter, scene: place.scene, block: place.block, at: this.now().toISOString() });
  }

  listBookmarks(): Bookmark[] {
    return this.list<Bookmark>("bookmarks", (entry) => typeof entry.id === "string" && isPlace(entry));
  }

  findBookmark(place: ReaderPlace): Bookmark | undefined {
    return this.listBookmarks().find((entry) => entry.chapter === place.chapter && entry.scene === place.scene && entry.block === place.block);
  }

  addBookmark(place: ReaderPlace, excerpt: string): Bookmark {
    const existing = this.findBookmark(place);
    if (existing) return existing;
    const bookmark: Bookmark = { id: newId(), chapter: place.chapter, scene: place.scene, block: place.block, excerpt: excerpt.slice(0, 160), createdAt: this.now().toISOString() };
    this.write("bookmarks", { items: [...this.listBookmarks(), bookmark] });
    return bookmark;
  }

  removeBookmark(id: string): boolean {
    const items = this.listBookmarks();
    const kept = items.filter((entry) => entry.id !== id);
    if (kept.length === items.length) return false;
    this.write("bookmarks", { items: kept });
    return true;
  }

  listAnnotations(chapter?: string): Annotation[] {
    const all = this.list<Annotation>("annotations", (entry) => typeof entry.id === "string" && (entry.kind === "highlight" || entry.kind === "note") && isRange(entry));
    return chapter ? all.filter((entry) => entry.chapter === chapter) : all;
  }

  addAnnotation(range: TextRange, kind: Annotation["kind"], note?: string): Annotation {
    const at = this.now().toISOString();
    const annotation: Annotation = { ...range, id: newId(), kind, ...(note?.trim() ? { note: note.trim() } : {}), createdAt: at, updatedAt: at };
    if (kind === "note" && !annotation.note) annotation.kind = "highlight";
    this.write("annotations", { items: [...this.listAnnotations(), annotation] });
    return annotation;
  }

  /** Changes the note of an annotation (an empty note makes it a plain highlight); returns the updated one. */
  updateNote(id: string, note: string): Annotation | undefined {
    let updated: Annotation | undefined;
    const items = this.listAnnotations().map((entry) => {
      if (entry.id !== id) return entry;
      const text = note.trim();
      updated = { ...entry, kind: text ? "note" : "highlight", updatedAt: this.now().toISOString() };
      if (text) updated.note = text;
      else delete updated.note;
      return updated;
    });
    if (updated) this.write("annotations", { items });
    return updated;
  }

  /** Moves an annotation to where its text is now (see `anchors.ts`). */
  moveAnnotation(id: string, range: Pick<TextRange, "startBlock" | "startOffset" | "endBlock" | "endOffset">): void {
    const items = this.listAnnotations().map((entry) => (entry.id === id ? { ...entry, ...range } : entry));
    this.write("annotations", { items });
  }

  removeAnnotation(id: string): boolean {
    const items = this.listAnnotations();
    const kept = items.filter((entry) => entry.id !== id);
    if (kept.length === items.length) return false;
    this.write("annotations", { items: kept });
    return true;
  }
}

/** Book order: the chapters in the order given, then the scenes in the order given, then the block, then the offset. */
export function sortInBookOrder<T extends { chapter: string; scene: string; block?: number; startBlock?: number; startOffset?: number }>(
  items: T[],
  order: { chapters: string[]; scenes: Record<string, string[]> },
): T[] {
  const chapterIndex = (slug: string) => {
    const index = order.chapters.indexOf(slug);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  const sceneIndex = (chapter: string, scene: string) => {
    const index = order.scenes[chapter]?.indexOf(scene) ?? -1;
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  return [...items].sort((left, right) =>
    chapterIndex(left.chapter) - chapterIndex(right.chapter)
    || sceneIndex(left.chapter, left.scene) - sceneIndex(right.chapter, right.scene)
    || (left.block ?? left.startBlock ?? 0) - (right.block ?? right.startBlock ?? 0)
    || (left.startOffset ?? 0) - (right.startOffset ?? 0));
}
