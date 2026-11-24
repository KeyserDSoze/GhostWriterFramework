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
export declare const TEXT_SIZES: readonly [80, 90, 100, 112, 125, 140, 160, 180, 200];
export declare const LINE_HEIGHTS: readonly [1.3, 1.45, 1.6, 1.75, 1.9, 2.1];
/** Inline margins of the page, in rem. */
export declare const MARGINS: readonly [0.75, 1.25, 2, 3];
/** Longest line, in em (0: the whole width). */
export declare const WIDTHS: readonly [28, 34, 40, 0];
export declare const DEFAULT_PREFS: ReaderPrefs;
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
export declare class ReaderStoreError extends Error {
    constructor(cause: unknown);
}
export declare class ReaderStore {
    private readonly storage;
    readonly bookId: string;
    private readonly now;
    private readonly prefix;
    constructor(storage: StorageLike, bookId: string, now?: () => Date);
    private read;
    private write;
    private list;
    readPrefs(): ReaderPrefs;
    writePrefs(prefs: ReaderPrefs): void;
    resetPrefs(): ReaderPrefs;
    readPosition(): ReaderPosition | null;
    writePosition(place: ReaderPlace): void;
    listBookmarks(): Bookmark[];
    findBookmark(place: ReaderPlace): Bookmark | undefined;
    addBookmark(place: ReaderPlace, excerpt: string): Bookmark;
    removeBookmark(id: string): boolean;
    listAnnotations(chapter?: string): Annotation[];
    addAnnotation(range: TextRange, kind: Annotation["kind"], note?: string): Annotation;
    /** Changes the note of an annotation (an empty note makes it a plain highlight); returns the updated one. */
    updateNote(id: string, note: string): Annotation | undefined;
    /** Moves an annotation to where its text is now (see `anchors.ts`). */
    moveAnnotation(id: string, range: Pick<TextRange, "startBlock" | "startOffset" | "endBlock" | "endOffset">): void;
    removeAnnotation(id: string): boolean;
}
/** Book order: the chapters in the order given, then the scenes in the order given, then the block, then the offset. */
export declare function sortInBookOrder<T extends {
    chapter: string;
    scene: string;
    block?: number;
    startBlock?: number;
    startOffset?: number;
}>(items: T[], order: {
    chapters: string[];
    scenes: Record<string, string[]>;
}): T[];
export {};
//# sourceMappingURL=store.d.ts.map