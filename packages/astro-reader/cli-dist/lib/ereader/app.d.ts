import { type ReaderLabels } from "../reader-i18n.js";
import type { OpenedReader } from "../reader-session.js";
/**
 * The full-page e-reader: one chapter at a time, in a scrolling column or in pages, with the contents, the progress, several bookmarks,
 * highlights and notes anchored to the scenes, and the reading settings, all kept on the device under the id of the book.
 */
export interface EReaderBoot {
    bookId: string;
    labels: ReaderLabels;
    uiLanguage: string;
    bookLanguage: string;
    canonHref: string | null;
}
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export declare class EReader {
    private readonly opened;
    private readonly boot;
    private readonly labels;
    private readonly store;
    private readonly chapters;
    private prefs;
    private chapterIndex;
    private page;
    private pageCount;
    private pageWidth;
    private place;
    private readonly chapterLengths;
    private readonly totalLength;
    private readonly figureUrls;
    private pendingRange;
    private editing;
    private saveTimer;
    private trackScheduled;
    private announceTimer;
    private readonly dateFormat;
    private readonly app;
    private readonly viewport;
    private readonly flow;
    private readonly live;
    private readonly bookmarkButton;
    private readonly previousButton;
    private readonly nextButton;
    private readonly selectionTools;
    constructor(opened: OpenedReader, boot: EReaderBoot, storage: StorageLike);
    start(): void;
    private showChapter;
    private renderChapter;
    private renderFigure;
    private get paged();
    private layout;
    private relayoutKeepingPlace;
    private blockElement;
    private goToPlace;
    private goToStart;
    private goToEnd;
    /** Pages turn at once, as on an e-reader: no animation to wait for, nothing that moves for who asked for less motion. */
    private setPage;
    /** The block at the top of what is on screen: the reading position. */
    private currentPlace;
    private placeOf;
    private trackPosition;
    private savePosition;
    private scheduleTrack;
    private updateProgress;
    private updateNavigation;
    private forward;
    private backward;
    /** In the scrolling column: a screen further, and the next chapter from the bottom of this one. */
    private scrollScreen;
    private bindControls;
    private announce;
    private guard;
    private updateBookmarkButton;
    private toggleBookmark;
    private chapterLabel;
    private order;
    private goTo;
    private renderNotesDialog;
    /** After a deletion in a list: the focus goes to the next entry (or the heading), and the deletion is said. */
    private afterListDeletion;
    private sceneBlocks;
    private isDetached;
    private clearMarks;
    private applyAnnotations;
    private wrap;
    private hasSelection;
    /** The selection as a range of one scene, or null. */
    private selectionRange;
    private hideSelectionTools;
    private annotateSelection;
    private openNoteEditor;
    /** A note on the whole block where the reader is: notes without selecting, from the keyboard too. */
    private noteAtPosition;
    private bindReading;
    private bindDialogs;
    private renderContents;
    private renderBookLinks;
    private applyPrefs;
    private savePrefs;
    private syncSettingsForm;
    private bindSettings;
}
export declare function startEReader(opened: OpenedReader, boot: EReaderBoot, storage: StorageLike): EReader;
export {};
//# sourceMappingURL=app.d.ts.map