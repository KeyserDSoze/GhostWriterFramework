import { formatLabel, type ReaderLabels } from "../reader-i18n.js";
import type { ReaderChapter, ReaderFigure } from "../reader-protocol.js";
import type { OpenedReader } from "../reader-session.js";
import { rangeFromPoints, rangeInBlock, resolveRange } from "./anchors.js";
import {
  LINE_HEIGHTS,
  MARGINS,
  ReaderStore,
  ReaderStoreError,
  TEXT_SIZES,
  WIDTHS,
  sortInBookOrder,
  type Annotation,
  type ReaderPlace,
  type ReaderPrefs,
  type TextRange,
} from "./store.js";
import { READER_FONTS } from "./themes.js";

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

const BASE_FONT_PX = 18;

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`The reader's page has no #${id}.`);
  return element as T;
}

function create<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

function htmlTextLength(html: string): number {
  return html.replace(/<[^>]*>/g, "").replace(/&[a-z#0-9]+;/gi, " ").length;
}

export class EReader {
  private readonly labels: ReaderLabels;
  private readonly store: ReaderStore;
  private readonly chapters: ReaderChapter[];
  private prefs: ReaderPrefs;
  private chapterIndex = 0;
  private page = 0;
  private pageCount = 1;
  private pageWidth = 1;
  private place: ReaderPlace | null = null;
  private readonly chapterLengths: number[];
  private readonly totalLength: number;
  private readonly figureUrls = new Map<string, Promise<string>>();
  private pendingRange: TextRange | null = null;
  private editing: Annotation | null = null;
  private saveTimer: number | undefined;
  private trackScheduled = false;
  private announceTimer: number | undefined;
  private readonly dateFormat: Intl.DateTimeFormat;

  private readonly app = byId<HTMLElement>("reader-app");
  private readonly viewport = byId<HTMLElement>("reader-text");
  private readonly flow = byId<HTMLElement>("er-flow");
  private readonly live = byId<HTMLElement>("er-live");
  private readonly bookmarkButton = byId<HTMLButtonElement>("er-bookmark");
  private readonly previousButton = byId<HTMLButtonElement>("er-previous");
  private readonly nextButton = byId<HTMLButtonElement>("er-next");
  private readonly selectionTools = byId<HTMLElement>("er-selection");

  constructor(private readonly opened: OpenedReader, private readonly boot: EReaderBoot, storage: StorageLike) {
    this.labels = boot.labels;
    this.store = new ReaderStore(storage, boot.bookId);
    this.chapters = opened.bundle.chapters;
    this.prefs = this.store.readPrefs();
    this.chapterLengths = this.chapters.map((chapter) => chapter.scenes.reduce((sum, scene) => sum + htmlTextLength(scene.html), 0));
    this.totalLength = Math.max(1, this.chapterLengths.reduce((sum, length) => sum + length, 0));
    this.dateFormat = new Intl.DateTimeFormat(boot.uiLanguage, { dateStyle: "medium", timeStyle: "short" });
  }

  start(): void {
    this.app.hidden = false;
    this.bindControls();
    this.bindSettings();
    this.bindDialogs();
    this.bindReading();
    this.applyPrefs(false);
    this.renderBookLinks();
    const saved = this.store.readPosition();
    const index = saved ? this.chapters.findIndex((chapter) => chapter.slug === saved.chapter) : -1;
    if (index >= 0 && saved) this.showChapter(index, { place: saved, focus: false });
    else this.showChapter(0, { at: "start", focus: false });
  }

  // ── Chapters ──────────────────────────────────────────────────────────

  private showChapter(index: number, target: { at?: "start" | "end"; place?: ReaderPlace; scene?: string; focus: boolean }): void {
    if (this.chapters.length === 0) {
      this.flow.replaceChildren(create("p", "ereader-chapter__empty", this.labels.noChapters));
      byId("er-chapter-title").textContent = "";
      this.previousButton.disabled = this.nextButton.disabled = this.bookmarkButton.disabled = true;
      return;
    }
    this.chapterIndex = Math.max(0, Math.min(this.chapters.length - 1, index));
    const chapter = this.chapters[this.chapterIndex];
    this.flow.replaceChildren(this.renderChapter(chapter));
    this.applyAnnotations();
    byId("er-chapter-title").textContent = `${chapter.number}. ${chapter.title}`;
    this.layout();
    if (target.place && target.place.chapter === chapter.slug) this.goToPlace(target.place);
    else if (target.scene) this.goToPlace({ chapter: chapter.slug, scene: target.scene, block: 0 }, true);
    else if (target.at === "end") this.goToEnd();
    else this.goToStart();
    this.trackPosition();
    if (target.focus) {
      const heading = this.flow.querySelector<HTMLElement>(".ereader-chapter__title");
      heading?.focus({ preventScroll: true });
      this.announce(formatLabel(this.labels.chapterAnnounce, { number: chapter.number, title: chapter.title }));
    }
  }

  private renderChapter(chapter: ReaderChapter): HTMLElement {
    const article = create("article", "ereader-chapter");
    article.dataset.chapter = chapter.slug;
    const head = create("header", "ereader-chapter__head");
    head.append(create("p", "ereader-chapter__number", formatLabel(this.labels.chapterLabel, { number: chapter.number })));
    const title = create("h1", "ereader-chapter__title", chapter.title);
    title.tabIndex = -1;
    head.append(title);
    article.append(head);
    if (chapter.figure) article.append(this.renderFigure(chapter.figure));
    if (chapter.scenes.length === 0) article.append(create("p", "ereader-chapter__empty", this.labels.emptyChapter));
    for (const scene of chapter.scenes) {
      const section = create("section", "ereader-scene");
      section.dataset.scene = scene.slug;
      section.append(create("h2", "ereader-scene__title", scene.title));
      if (scene.figure) section.append(this.renderFigure(scene.figure));
      const text = create("div", "ereader-scene__text");
      // The core's renderer: no raw HTML and no unsafe URL reach this string.
      text.innerHTML = scene.html;
      [...text.children].forEach((block, position) => {
        (block as HTMLElement).dataset.block = String(position);
      });
      section.append(text);
      article.append(section);
    }
    const end = create("nav", "ereader-chapter__end");
    end.setAttribute("aria-label", this.labels.contents);
    const next = this.chapters[this.chapterIndex + 1];
    if (next) {
      const button = create("button", "ereader-text-button", `${this.labels.nextChapter}: ${next.title}`);
      button.type = "button";
      button.addEventListener("click", () => this.showChapter(this.chapterIndex + 1, { at: "start", focus: true }));
      end.append(button);
    } else {
      end.append(create("p", "ereader-chapter__empty", this.labels.endOfBook));
    }
    article.append(end);
    return article;
  }

  private renderFigure(figure: ReaderFigure): HTMLElement {
    const element = create("figure", "ereader-figure");
    const frame = create("div", "ereader-figure__frame");
    const ratio = /^(\d+):(\d+)$/.exec(figure.aspectRatio ?? "");
    if (ratio) frame.style.aspectRatio = `${ratio[1]} / ${ratio[2]}`;
    element.append(frame);
    if (figure.caption) element.append(create("figcaption", undefined, figure.caption));
    let url = this.figureUrls.get(figure.path);
    if (!url) {
      url = this.opened.loadArtifact(figure.path).then((bytes) => URL.createObjectURL(new Blob([bytes.slice()], { type: figure.type })));
      this.figureUrls.set(figure.path, url);
    }
    url.then((src) => {
      const image = create("img");
      image.alt = figure.alt;
      image.src = src;
      image.addEventListener("load", () => this.relayoutKeepingPlace(), { once: true });
      frame.replaceChildren(image);
      frame.style.aspectRatio = "";
    }).catch(() => {
      frame.textContent = figure.alt;
    });
    return element;
  }

  // ── Layout and position ───────────────────────────────────────────────

  private get paged(): boolean {
    return this.prefs.mode === "paged";
  }

  private layout(): void {
    const top = this.app.querySelector<HTMLElement>(".ereader-bar--top")?.offsetHeight ?? 0;
    const bottom = this.app.querySelector<HTMLElement>(".ereader-bar--bottom")?.offsetHeight ?? 0;
    // In the scrolling column the bars stay on screen: what gets the focus in the text is scrolled clear of them (scroll-margin in the
    // CSS; a scroll-padding on the page would also move the page when a button of the sticky bars gets the focus).
    document.documentElement.style.setProperty("--er-top-bar", `${top}px`);
    document.documentElement.style.setProperty("--er-bottom-bar", `${bottom}px`);
    if (!this.paged) {
      this.flow.style.removeProperty("--er-column-width");
      this.flow.style.removeProperty("--er-column-gap");
      this.flow.style.removeProperty("--er-side-pad");
      this.pageCount = 1;
      this.page = 0;
      return;
    }
    const width = this.viewport.clientWidth || window.innerWidth;
    const fontPx = (BASE_FONT_PX * TEXT_SIZES[this.prefs.size]) / 100;
    const margin = MARGINS[this.prefs.margin] * 16;
    const measure = WIDTHS[this.prefs.width] ? WIDTHS[this.prefs.width] * fontPx : Number.POSITIVE_INFINITY;
    const column = Math.max(160, Math.min(width - 2 * margin, measure));
    const side = Math.max(0, (width - column) / 2);
    this.flow.style.setProperty("--er-column-width", `${column}px`);
    this.flow.style.setProperty("--er-column-gap", `${2 * side}px`);
    this.flow.style.setProperty("--er-side-pad", `${side}px`);
    this.pageWidth = width;
    this.pageCount = Math.max(1, Math.ceil((this.viewport.scrollWidth - 2) / width));
  }

  private relayoutKeepingPlace(): void {
    const place = this.place;
    this.layout();
    if (place) this.goToPlace(place);
    this.updateProgress();
  }

  private blockElement(place: ReaderPlace): HTMLElement | null {
    return this.flow.querySelector<HTMLElement>(`[data-scene="${CSS.escape(place.scene)}"] [data-block="${place.block}"]`);
  }

  private goToPlace(place: ReaderPlace, sceneStart = false): void {
    const target = sceneStart
      ? this.flow.querySelector<HTMLElement>(`[data-scene="${CSS.escape(place.scene)}"]`)
      : this.blockElement(place) ?? this.flow.querySelector<HTMLElement>(`[data-scene="${CSS.escape(place.scene)}"]`);
    if (!target) {
      this.goToStart();
      return;
    }
    if (this.paged) {
      const left = target.getBoundingClientRect().left - this.viewport.getBoundingClientRect().left + this.viewport.scrollLeft;
      this.setPage(Math.floor((left + 4) / this.pageWidth));
    } else {
      const top = target.getBoundingClientRect().top + window.scrollY;
      const bar = this.app.querySelector<HTMLElement>(".ereader-bar--top")?.offsetHeight ?? 0;
      window.scrollTo({ top: Math.max(0, top - bar - 12), behavior: "auto" });
    }
  }

  private goToStart(): void {
    if (this.paged) this.setPage(0);
    else window.scrollTo({ top: 0, behavior: "auto" });
  }

  private goToEnd(): void {
    if (this.paged) this.setPage(this.pageCount - 1);
    else window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
  }

  /** Pages turn at once, as on an e-reader: no animation to wait for, nothing that moves for who asked for less motion. */
  private setPage(page: number): void {
    this.page = Math.max(0, Math.min(this.pageCount - 1, page));
    this.viewport.scrollTo({ left: this.page * this.pageWidth, behavior: "auto" });
    this.updateNavigation();
  }

  /** The block at the top of what is on screen: the reading position. */
  private currentPlace(): ReaderPlace | null {
    const chapter = this.chapters[this.chapterIndex];
    if (!chapter) return null;
    const viewportBox = this.viewport.getBoundingClientRect();
    const top = this.paged ? viewportBox.top : (this.app.querySelector<HTMLElement>(".ereader-bar--top")?.getBoundingClientRect().bottom ?? 0);
    const bottom = this.paged ? viewportBox.bottom : (this.app.querySelector<HTMLElement>(".ereader-bar--bottom")?.getBoundingClientRect().top ?? window.innerHeight);
    const blocks = [...this.flow.querySelectorAll<HTMLElement>("[data-block]")];
    let found: HTMLElement | undefined;
    let spanning: HTMLElement | undefined;
    for (const block of blocks) {
      // A block split over two pages (or two columns) has one box per column: the one on this page counts.
      const boxes = this.paged ? [...block.getClientRects()] : [block.getBoundingClientRect()];
      const onScreen = boxes.find((box) => box.right > viewportBox.left + 1 && box.left < viewportBox.right - 1 && box.bottom > top + 1 && box.top < bottom - 1);
      if (!onScreen) continue;
      // On a page, the position is the first block that STARTS on it, so that going back to it opens this page and not the one before.
      const startsHere = !this.paged || (boxes[0] === onScreen);
      if (startsHere) {
        found = block;
        break;
      }
      spanning ??= block;
    }
    found ??= spanning;
    if (!found) {
      const first = blocks[0];
      return first ? this.placeOf(first) : { chapter: chapter.slug, scene: chapter.scenes[0]?.slug ?? "", block: 0 };
    }
    return this.placeOf(found);
  }

  private placeOf(block: HTMLElement): ReaderPlace {
    return {
      chapter: this.chapters[this.chapterIndex].slug,
      scene: block.closest<HTMLElement>("[data-scene]")?.dataset.scene ?? "",
      block: Number(block.dataset.block ?? 0),
    };
  }

  private trackPosition(): void {
    if (this.paged) this.page = Math.round(this.viewport.scrollLeft / this.pageWidth);
    const place = this.currentPlace();
    if (place) this.place = place;
    this.updateProgress();
    this.updateNavigation();
    this.updateBookmarkButton();
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.savePosition(), 400);
  }

  private savePosition(): void {
    // From the screen as it is now: a page turned an instant ago may not have been tracked yet.
    if (this.chapters.length > 0) this.place = this.currentPlace() ?? this.place;
    if (!this.place || !this.place.scene) return;
    try {
      this.store.writePosition(this.place);
    } catch {
      // The position is a convenience: a full storage does not interrupt the reading.
    }
  }

  private scheduleTrack(): void {
    if (this.trackScheduled) return;
    this.trackScheduled = true;
    window.requestAnimationFrame(() => {
      this.trackScheduled = false;
      this.trackPosition();
    });
  }

  private updateProgress(): void {
    const before = this.chapterLengths.slice(0, this.chapterIndex).reduce((sum, length) => sum + length, 0);
    let within = 0;
    if (this.place) {
      for (const block of this.flow.querySelectorAll<HTMLElement>("[data-block]")) {
        const place = this.placeOf(block);
        if (place.scene === this.place.scene && place.block === this.place.block) break;
        within += (block.textContent ?? "").length;
      }
    }
    const percent = Math.min(100, Math.round(((before + within) / this.totalLength) * 100));
    byId("er-progress-text").textContent = formatLabel(this.labels.progressText, { chapter: this.chapterIndex + 1, chapters: this.chapters.length, percent });
    byId("er-page-text").textContent = this.paged ? `· ${formatLabel(this.labels.pageText, { page: this.page + 1, pages: this.pageCount })}` : "";
    const bar = byId("er-progress");
    bar.setAttribute("aria-valuenow", String(percent));
    bar.setAttribute("aria-valuetext", `${percent}%`);
    byId("er-progress-fill").style.width = `${percent}%`;
  }

  private updateNavigation(): void {
    const first = this.chapterIndex === 0 && (!this.paged || this.page === 0);
    const last = this.chapterIndex === this.chapters.length - 1 && (!this.paged || this.page >= this.pageCount - 1);
    this.previousButton.disabled = first;
    this.nextButton.disabled = last;
    byId("er-previous-label").textContent = this.paged ? this.labels.previousPage : this.labels.previousChapter;
    byId("er-next-label").textContent = this.paged ? this.labels.nextPage : this.labels.nextChapter;
    if (this.paged) byId("er-page-text").textContent = `· ${formatLabel(this.labels.pageText, { page: this.page + 1, pages: this.pageCount })}`;
  }

  private forward(): void {
    if (this.paged && this.page < this.pageCount - 1) {
      this.setPage(this.page + 1);
      return;
    }
    if (this.chapterIndex < this.chapters.length - 1) this.showChapter(this.chapterIndex + 1, { at: "start", focus: !this.paged });
    else this.announce(this.labels.endOfBook);
  }

  private backward(): void {
    if (this.paged && this.page > 0) {
      this.setPage(this.page - 1);
      return;
    }
    if (this.chapterIndex > 0) this.showChapter(this.chapterIndex - 1, { at: this.paged ? "end" : "start", focus: !this.paged });
    else this.announce(this.labels.startOfBook);
  }

  /** In the scrolling column: a screen further, and the next chapter from the bottom of this one. */
  private scrollScreen(direction: 1 | -1): void {
    const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
    const atTop = window.scrollY <= 0;
    if (direction > 0 && atBottom) return this.forward();
    if (direction < 0 && atTop) {
      if (this.chapterIndex > 0) this.showChapter(this.chapterIndex - 1, { at: "end", focus: false });
      return;
    }
    const bars = (this.app.querySelector<HTMLElement>(".ereader-bar--top")?.offsetHeight ?? 0) + (this.app.querySelector<HTMLElement>(".ereader-bar--bottom")?.offsetHeight ?? 0);
    window.scrollBy({ top: direction * Math.max(80, window.innerHeight - bars - 48), behavior: reducedMotion() ? "auto" : "smooth" });
  }

  // ── Controls ──────────────────────────────────────────────────────────

  private bindControls(): void {
    this.previousButton.addEventListener("click", () => this.backward());
    this.nextButton.addEventListener("click", () => this.forward());
    this.bookmarkButton.addEventListener("click", () => this.toggleBookmark());
    byId("er-highlight").addEventListener("click", () => this.annotateSelection("highlight"));
    byId("er-note").addEventListener("click", () => this.annotateSelection("note"));
    document.getElementById("reader-forget")?.addEventListener("click", () => {
      this.opened.forgetPassword();
      this.announce(this.labels.passwordForgotten);
    });

    document.addEventListener("keydown", (event) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (isTyping(event.target) || document.querySelector("dialog[open]")) return;
      if (event.key === "Escape") {
        this.hideSelectionTools();
        return;
      }
      if (this.paged) {
        const keys: Record<string, () => void> = {
          ArrowRight: () => this.forward(),
          PageDown: () => this.forward(),
          ArrowLeft: () => this.backward(),
          PageUp: () => this.backward(),
          " ": () => (event.shiftKey ? this.backward() : this.forward()),
          Home: () => this.setPage(0),
          End: () => this.setPage(this.pageCount - 1),
        };
        const action = keys[event.key];
        if (action && !(event.target instanceof HTMLButtonElement && event.key === " ")) {
          event.preventDefault();
          action();
        }
        return;
      }
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        this.scrollScreen(event.key === "ArrowRight" ? 1 : -1);
      }
    });

    // Swipe: a horizontal stroke of a finger turns the page (or the chapter in the scrolling column). The buttons do the same with one tap.
    let stroke: { x: number; y: number; at: number } | null = null;
    this.viewport.addEventListener("pointerdown", (event) => {
      stroke = event.pointerType === "touch" ? { x: event.clientX, y: event.clientY, at: Date.now() } : null;
    });
    this.viewport.addEventListener("pointercancel", () => {
      stroke = null;
    });
    this.viewport.addEventListener("pointerup", (event) => {
      if (!stroke || event.pointerType !== "touch") return;
      const dx = event.clientX - stroke.x;
      const dy = event.clientY - stroke.y;
      const quick = Date.now() - stroke.at < 900;
      stroke = null;
      if (this.hasSelection() || !quick || Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
      if (dx < 0) this.forward();
      else this.backward();
    });

    window.addEventListener("scroll", () => {
      if (!this.paged) this.scheduleTrack();
    }, { passive: true });
    this.viewport.addEventListener("scroll", () => {
      if (this.paged) this.scheduleTrack();
    }, { passive: true });
    let resizeTimer: number | undefined;
    window.addEventListener("resize", () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => this.relayoutKeepingPlace(), 150);
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.savePosition();
    });
    window.addEventListener("pagehide", () => this.savePosition());
  }

  private announce(message: string): void {
    window.clearTimeout(this.announceTimer);
    this.live.textContent = "";
    this.announceTimer = window.setTimeout(() => {
      this.live.textContent = message;
    }, 60);
  }

  private guard(action: () => void): boolean {
    try {
      action();
      return true;
    } catch (error) {
      if (error instanceof ReaderStoreError) {
        this.announce(this.labels.storageFull);
        return false;
      }
      throw error;
    }
  }

  // ── Bookmarks ─────────────────────────────────────────────────────────

  private updateBookmarkButton(): void {
    const marked = Boolean(this.place && this.store.findBookmark(this.place));
    this.bookmarkButton.setAttribute("aria-pressed", marked ? "true" : "false");
    this.bookmarkButton.title = marked ? this.labels.bookmarkRemove : this.labels.bookmarkAdd;
  }

  private toggleBookmark(): void {
    const place = this.currentPlace();
    if (!place) return;
    const existing = this.store.findBookmark(place);
    if (existing) {
      if (this.guard(() => this.store.removeBookmark(existing.id))) this.announce(this.labels.bookmarkRemoved);
    } else {
      const excerpt = (this.blockElement(place)?.textContent ?? "").replace(/\s+/g, " ").trim();
      if (this.guard(() => this.store.addBookmark(place, excerpt))) this.announce(this.labels.bookmarkAdded);
    }
    this.place = place;
    this.updateBookmarkButton();
  }

  private chapterLabel(slug: string): string {
    const chapter = this.chapters.find((entry) => entry.slug === slug);
    return chapter ? `${formatLabel(this.labels.chapterLabel, { number: chapter.number })} · ${chapter.title}` : slug;
  }

  private order() {
    return {
      chapters: this.chapters.map((chapter) => chapter.slug),
      scenes: Object.fromEntries(this.chapters.map((chapter) => [chapter.slug, chapter.scenes.map((scene) => scene.slug)])),
    };
  }

  private goTo(place: ReaderPlace): void {
    const index = this.chapters.findIndex((chapter) => chapter.slug === place.chapter);
    if (index < 0) return;
    (document.querySelector("dialog[open]") as HTMLDialogElement | null)?.close();
    this.showChapter(index, { place, focus: false });
    this.blockElement(place)?.setAttribute("tabindex", "-1");
    this.blockElement(place)?.focus({ preventScroll: true });
  }

  private renderNotesDialog(): void {
    const order = this.order();
    const bookmarks = sortInBookOrder(this.store.listBookmarks(), order);
    const bookmarkList = byId("er-bookmark-list");
    bookmarkList.replaceChildren();
    if (bookmarks.length === 0) bookmarkList.append(create("li", "ereader-empty", this.labels.noBookmarks));
    for (const bookmark of bookmarks) {
      const item = create("li");
      const where = this.chapterLabel(bookmark.chapter);
      const go = create("button", "ereader-item__go");
      go.type = "button";
      go.append(create("span", "ereader-item__where", where));
      if (bookmark.excerpt) go.append(create("span", "ereader-item__quote", `“${bookmark.excerpt.slice(0, 120)}${bookmark.excerpt.length > 120 ? "…" : ""}”`));
      go.append(create("span", "ereader-item__meta", formatLabel(this.labels.savedOn, { date: this.dateFormat.format(new Date(bookmark.createdAt)) })));
      go.addEventListener("click", () => this.goTo(bookmark));
      const remove = create("button", "ereader-text-button", this.labels.deleteItem);
      remove.type = "button";
      remove.setAttribute("aria-label", formatLabel(this.labels.deleteBookmarkNamed, { label: `${where}, ${bookmark.excerpt.slice(0, 60)}` }));
      remove.addEventListener("click", () => {
        if (!this.guard(() => this.store.removeBookmark(bookmark.id))) return;
        this.afterListDeletion(item, "er-bookmarks-title");
        this.updateBookmarkButton();
      });
      item.append(go, remove);
      bookmarkList.append(item);
    }

    const annotations = sortInBookOrder(this.store.listAnnotations(), order);
    const annotationList = byId("er-annotation-list");
    annotationList.replaceChildren();
    if (annotations.length === 0) annotationList.append(create("li", "ereader-empty", this.labels.noNotes));
    for (const annotation of annotations) {
      const item = create("li");
      const where = this.chapterLabel(annotation.chapter);
      const go = create("button", "ereader-item__go");
      go.type = "button";
      go.append(create("span", "ereader-item__where", where));
      go.append(create("span", "ereader-item__quote", `“${annotation.quote.replace(/\s+/g, " ").slice(0, 160)}${annotation.quote.length > 160 ? "…" : ""}”`));
      if (annotation.note) go.append(create("span", "ereader-item__note", annotation.note));
      if (this.isDetached(annotation)) go.append(create("span", "ereader-item__meta", this.labels.detached));
      go.append(create("span", "ereader-item__meta", formatLabel(this.labels.savedOn, { date: this.dateFormat.format(new Date(annotation.updatedAt)) })));
      go.addEventListener("click", () => this.goTo({ chapter: annotation.chapter, scene: annotation.scene, block: annotation.startBlock }));
      const actions = create("div", "ereader-item__actions");
      const edit = create("button", "ereader-text-button", this.labels.editNote);
      edit.type = "button";
      edit.addEventListener("click", () => this.openNoteEditor(annotation));
      const remove = create("button", "ereader-text-button", this.labels.deleteItem);
      remove.type = "button";
      remove.setAttribute("aria-label", formatLabel(this.labels.deleteNoteNamed, { label: annotation.quote.replace(/\s+/g, " ").slice(0, 60) }));
      remove.addEventListener("click", () => {
        if (!this.guard(() => this.store.removeAnnotation(annotation.id))) return;
        this.afterListDeletion(item, "er-annotations-title");
        this.applyAnnotations();
      });
      actions.append(edit, remove);
      item.append(go, actions);
      annotationList.append(item);
    }
  }

  /** After a deletion in a list: the focus goes to the next entry (or the heading), and the deletion is said. */
  private afterListDeletion(item: HTMLElement, headingId: string): void {
    const next = (item.nextElementSibling ?? item.previousElementSibling)?.querySelector<HTMLElement>("button");
    const list = item.parentElement;
    item.remove();
    if (list && list.children.length === 0) this.renderNotesDialog();
    if (next && next.isConnected) next.focus();
    else {
      const heading = byId(headingId);
      heading.tabIndex = -1;
      heading.focus();
    }
    this.announce(this.labels.deleted);
  }

  // ── Highlights and notes ──────────────────────────────────────────────

  private sceneBlocks(scene: string): string[] {
    return [...this.flow.querySelectorAll<HTMLElement>(`[data-scene="${CSS.escape(scene)}"] [data-block]`)].map((block) => block.textContent ?? "");
  }

  private isDetached(annotation: Annotation): boolean {
    if (annotation.chapter !== this.chapters[this.chapterIndex]?.slug) return false;
    return this.flow.querySelector(`mark[data-annotation="${CSS.escape(annotation.id)}"]`) === null;
  }

  private clearMarks(): void {
    for (const mark of [...this.flow.querySelectorAll("mark.ereader-mark")]) {
      const parent = mark.parentNode;
      if (!parent) continue;
      mark.replaceWith(...mark.childNodes);
      parent.normalize();
    }
  }

  private applyAnnotations(): void {
    this.clearMarks();
    const chapter = this.chapters[this.chapterIndex];
    if (!chapter) return;
    for (const annotation of this.store.listAnnotations(chapter.slug)) {
      const blocks = this.sceneBlocks(annotation.scene);
      const range = resolveRange(blocks, annotation);
      if (!range) continue;
      if (range.startBlock !== annotation.startBlock || range.startOffset !== annotation.startOffset || range.endBlock !== annotation.endBlock || range.endOffset !== annotation.endOffset) {
        this.guard(() => this.store.moveAnnotation(annotation.id, range));
      }
      for (let block = range.startBlock; block <= range.endBlock; block += 1) {
        const part = rangeInBlock(blocks, range, block);
        const element = this.blockElement({ chapter: chapter.slug, scene: annotation.scene, block });
        if (part && element) this.wrap(element, part.start, part.end, annotation);
      }
    }
  }

  private wrap(block: HTMLElement, start: number, end: number, annotation: Annotation): void {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const targets: Array<{ node: Text; from: number; to: number }> = [];
    let offset = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const nodeEnd = offset + node.data.length;
      if (nodeEnd > start && offset < end) targets.push({ node, from: Math.max(start, offset) - offset, to: Math.min(end, nodeEnd) - offset });
      offset = nodeEnd;
    }
    for (const { node, from, to } of targets) {
      let target = node;
      if (to < target.data.length) target.splitText(to);
      if (from > 0) target = target.splitText(from);
      const mark = create("mark", "ereader-mark");
      mark.dataset.annotation = annotation.id;
      mark.dataset.kind = annotation.kind;
      if (annotation.note) mark.title = annotation.note;
      target.replaceWith(mark);
      mark.append(target);
    }
  }

  private hasSelection(): boolean {
    const selection = window.getSelection();
    return Boolean(selection && !selection.isCollapsed && selection.toString().trim());
  }

  /** The selection as a range of one scene, or null. */
  private selectionRange(): TextRange | null {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const point = (node: Node | null, offset: number) => {
      if (!node) return null;
      const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
      const block = element?.closest<HTMLElement>("[data-block]");
      const scene = block?.closest<HTMLElement>("[data-scene]");
      if (!block || !scene || !this.flow.contains(block)) return null;
      const measure = document.createRange();
      measure.selectNodeContents(block);
      measure.setEnd(node, offset);
      return { scene: scene.dataset.scene ?? "", block: Number(block.dataset.block), offset: measure.toString().length };
    };
    const anchor = point(selection.anchorNode, selection.anchorOffset);
    const focus = point(selection.focusNode, selection.focusOffset);
    if (!anchor || !focus || anchor.scene !== focus.scene) return null;
    const blocks = this.sceneBlocks(anchor.scene);
    const range = rangeFromPoints(blocks, anchor, focus);
    return range ? { chapter: this.chapters[this.chapterIndex].slug, scene: anchor.scene, ...range } : null;
  }

  private hideSelectionTools(): void {
    this.selectionTools.hidden = true;
  }

  private annotateSelection(kind: "highlight" | "note"): void {
    const range = this.selectionRange() ?? this.pendingRange;
    this.hideSelectionTools();
    if (!range) return;
    if (kind === "highlight") {
      if (this.guard(() => this.store.addAnnotation(range, "highlight"))) {
        window.getSelection()?.removeAllRanges();
        this.applyAnnotations();
        this.announce(this.labels.highlightAdded);
      }
      return;
    }
    this.openNoteEditor(null, range);
  }

  private openNoteEditor(annotation: Annotation | null, range?: TextRange): void {
    this.editing = annotation;
    this.pendingRange = annotation ? null : range ?? null;
    const quote = annotation?.quote ?? range?.quote ?? "";
    byId("er-note-quote").textContent = quote;
    (byId<HTMLTextAreaElement>("er-note-text")).value = annotation?.note ?? "";
    byId("er-note-delete").hidden = !annotation;
    const dialog = byId<HTMLDialogElement>("er-note-dialog");
    const notes = byId<HTMLDialogElement>("er-notes");
    // Opened from the list of notes: the list comes back when the editor closes.
    notes.dataset.reopen = notes.open ? "true" : "";
    (document.querySelector("dialog[open]") as HTMLDialogElement | null)?.close();
    dialog.returnValue = "";
    dialog.showModal();
    byId<HTMLTextAreaElement>("er-note-text").focus();
  }

  /** A note on the whole block where the reader is: notes without selecting, from the keyboard too. */
  private noteAtPosition(): void {
    const place = this.currentPlace();
    if (!place) return;
    const blocks = this.sceneBlocks(place.scene);
    const range = rangeFromPoints(blocks, { block: place.block, offset: 0 }, { block: place.block, offset: blocks[place.block]?.length ?? 0 });
    if (range) this.openNoteEditor(null, { chapter: place.chapter, scene: place.scene, ...range });
  }

  private bindReading(): void {
    let selectionTimer: number | undefined;
    document.addEventListener("selectionchange", () => {
      window.clearTimeout(selectionTimer);
      selectionTimer = window.setTimeout(() => {
        const range = this.selectionRange();
        this.pendingRange = range;
        this.selectionTools.hidden = !range;
      }, 120);
    });
    this.flow.addEventListener("click", (event) => {
      const mark = (event.target as Element | null)?.closest?.("mark.ereader-mark") as HTMLElement | null;
      if (!mark || this.hasSelection()) return;
      const annotation = this.store.listAnnotations().find((entry) => entry.id === mark.dataset.annotation);
      if (annotation) this.openNoteEditor(annotation);
    });
    const dialog = byId<HTMLDialogElement>("er-note-dialog");
    byId("er-note-delete").addEventListener("click", () => {
      if (this.editing && this.guard(() => this.store.removeAnnotation(this.editing!.id))) {
        this.announce(this.labels.deleted);
        this.applyAnnotations();
      }
      this.editing = null;
      dialog.close("deleted");
    });
    dialog.addEventListener("close", () => {
      const text = byId<HTMLTextAreaElement>("er-note-text").value;
      if (dialog.returnValue === "save") {
        const saved = this.editing
          ? this.guard(() => this.store.updateNote(this.editing!.id, text))
          : this.pendingRange
            ? this.guard(() => this.store.addAnnotation(this.pendingRange!, "note", text))
            : false;
        if (saved) {
          window.getSelection()?.removeAllRanges();
          this.applyAnnotations();
          this.announce(this.labels.noteSaved);
        }
      }
      this.editing = null;
      this.pendingRange = null;
      const notes = byId<HTMLDialogElement>("er-notes");
      if (notes.dataset.reopen === "true") {
        notes.dataset.reopen = "";
        this.renderNotesDialog();
        notes.showModal();
      }
    });
    byId("er-note-here").addEventListener("click", () => this.noteAtPosition());
  }

  // ── Dialogs ───────────────────────────────────────────────────────────

  private bindDialogs(): void {
    const open = (dialogId: string, trigger: HTMLElement, prepare: () => void) => {
      trigger.addEventListener("click", () => {
        prepare();
        const dialog = byId<HTMLDialogElement>(dialogId);
        dialog.showModal();
        trigger.setAttribute("aria-expanded", "true");
        dialog.addEventListener("close", () => {
          trigger.setAttribute("aria-expanded", "false");
          if (!document.querySelector("dialog[open]") && document.activeElement === document.body) trigger.focus();
        }, { once: true });
      });
    };
    open("er-contents", byId("er-open-contents"), () => this.renderContents());
    open("er-notes", byId("er-open-notes"), () => this.renderNotesDialog());
    open("er-settings", byId("er-open-settings"), () => this.syncSettingsForm());
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-close-dialog]")) {
      button.addEventListener("click", () => button.closest("dialog")?.close());
    }
    for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog.ereader-dialog")) {
      // A click on the backdrop (outside the box) closes it, as Escape does.
      dialog.addEventListener("click", (event) => {
        if (event.target !== dialog) return;
        const box = dialog.getBoundingClientRect();
        const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
        if (!inside) dialog.close();
      });
    }
  }

  private renderContents(): void {
    const list = byId("er-toc");
    list.replaceChildren();
    this.chapters.forEach((chapter, index) => {
      const item = create("li");
      const button = create("button");
      button.type = "button";
      button.append(create("span", "ereader-toc__number", String(chapter.number)), create("span", undefined, chapter.title));
      if (index === this.chapterIndex) button.setAttribute("aria-current", "page");
      button.addEventListener("click", () => {
        byId<HTMLDialogElement>("er-contents").close();
        this.showChapter(index, { at: "start", focus: true });
      });
      item.append(button);
      if (index === this.chapterIndex && chapter.scenes.length > 1) {
        const scenes = create("ol");
        scenes.setAttribute("aria-label", this.labels.scenesOfChapter);
        for (const scene of chapter.scenes) {
          const sceneItem = create("li");
          const sceneButton = create("button", undefined, scene.title);
          sceneButton.type = "button";
          if (this.place?.scene === scene.slug) sceneButton.setAttribute("aria-current", "location");
          sceneButton.addEventListener("click", () => {
            byId<HTMLDialogElement>("er-contents").close();
            this.showChapter(index, { scene: scene.slug, focus: false });
            const heading = this.flow.querySelector<HTMLElement>(`[data-scene="${CSS.escape(scene.slug)}"] .ereader-scene__title`);
            if (heading) {
              heading.tabIndex = -1;
              heading.focus({ preventScroll: true });
            }
          });
          sceneItem.append(sceneButton);
          scenes.append(sceneItem);
        }
        item.append(scenes);
      }
      list.append(item);
    });
    window.requestAnimationFrame(() => list.querySelector<HTMLElement>("[aria-current='page']")?.focus());
  }

  private renderBookLinks(): void {
    const list = byId("er-book-link-list");
    const items: HTMLElement[] = [];
    const epub = this.opened.versionFile.epub;
    if (epub) {
      const button = create("button", "ereader-text-button", this.labels.downloadEpub);
      button.type = "button";
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          const bytes = await this.opened.loadArtifact(epub.path);
          const url = URL.createObjectURL(new Blob([bytes.slice()], { type: "application/epub+zip" }));
          const link = create("a");
          link.href = url;
          link.download = `${this.opened.bundle.book.title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "book"}.epub`;
          document.body.append(link);
          link.click();
          link.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
        } finally {
          button.disabled = false;
        }
      });
      items.push(button);
    }
    if (this.boot.canonHref) {
      const link = create("a", undefined, this.labels.bookOverview);
      link.href = this.boot.canonHref;
      items.push(link);
    }
    list.replaceChildren(...items.map((element) => {
      const item = create("li");
      item.append(element);
      return item;
    }));
    byId("er-book-links").hidden = items.length === 0;
  }

  // ── Settings ──────────────────────────────────────────────────────────

  private applyPrefs(keepPlace: boolean): void {
    const place = keepPlace ? this.place : null;
    const prefs = this.prefs;
    document.documentElement.dataset.theme = prefs.theme;
    this.app.dataset.mode = prefs.mode;
    this.app.dataset.sceneTitles = prefs.sceneTitles ? "shown" : "hidden";
    const style = this.flow.style;
    style.setProperty("--er-font-size", `${(BASE_FONT_PX * TEXT_SIZES[prefs.size]) / 100}px`);
    style.setProperty("--er-leading", String(LINE_HEIGHTS[prefs.leading]));
    style.setProperty("--er-margin", `${MARGINS[prefs.margin]}rem`);
    style.setProperty("--er-measure", WIDTHS[prefs.width] ? `${WIDTHS[prefs.width]}em` : "none");
    style.setProperty("--er-align", prefs.align === "justify" ? "justify" : "start");
    style.setProperty("--er-hyphens", prefs.align === "justify" ? "auto" : "manual");
    document.documentElement.style.setProperty("--er-book-font", READER_FONTS[prefs.font]);
    if (!keepPlace) return;
    this.layout();
    if (place) this.goToPlace(place);
    this.trackPosition();
  }

  private savePrefs(): void {
    this.guard(() => this.store.writePrefs(this.prefs));
  }

  private syncSettingsForm(): void {
    const form = byId<HTMLFormElement>("er-settings-form");
    const set = (name: string, value: string) => {
      const input = form.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
      if (input) input.checked = true;
    };
    set("theme", this.prefs.theme);
    set("font", this.prefs.font);
    set("width", String(this.prefs.width));
    set("align", this.prefs.align);
    set("mode", this.prefs.mode);
    byId<HTMLInputElement>("er-scene-titles").checked = this.prefs.sceneTitles;
    const steps: Record<"size" | "leading" | "margin", { value: string; max: number }> = {
      size: { value: `${TEXT_SIZES[this.prefs.size]}%`, max: TEXT_SIZES.length - 1 },
      leading: { value: String(LINE_HEIGHTS[this.prefs.leading]), max: LINE_HEIGHTS.length - 1 },
      margin: { value: formatLabel(this.labels.levelOf, { level: this.prefs.margin + 1, levels: MARGINS.length }), max: MARGINS.length - 1 },
    };
    for (const [name, step] of Object.entries(steps) as Array<["size" | "leading" | "margin", { value: string; max: number }]>) {
      byId(`er-${name}-value`).textContent = step.value;
      for (const button of form.querySelectorAll<HTMLButtonElement>(`[data-step="${name}"]`)) {
        const direction = Number(button.dataset.direction);
        button.disabled = direction < 0 ? this.prefs[name] <= 0 : this.prefs[name] >= step.max;
      }
    }
  }

  private bindSettings(): void {
    const form = byId<HTMLFormElement>("er-settings-form");
    form.addEventListener("submit", (event) => event.preventDefault());
    form.addEventListener("change", (event) => {
      const input = event.target as HTMLInputElement;
      const next = { ...this.prefs };
      if (input.name === "theme") next.theme = input.value as ReaderPrefs["theme"];
      else if (input.name === "font") next.font = input.value as ReaderPrefs["font"];
      else if (input.name === "width") next.width = Number(input.value);
      else if (input.name === "align") next.align = input.value as ReaderPrefs["align"];
      else if (input.name === "mode") next.mode = input.value as ReaderPrefs["mode"];
      else if (input.name === "sceneTitles") next.sceneTitles = input.checked;
      else return;
      this.prefs = next;
      this.applyPrefs(true);
      this.savePrefs();
      this.syncSettingsForm();
    });
    for (const button of form.querySelectorAll<HTMLButtonElement>("[data-step]")) {
      button.addEventListener("click", () => {
        const name = button.dataset.step as "size" | "leading" | "margin";
        const limits = { size: TEXT_SIZES.length, leading: LINE_HEIGHTS.length, margin: MARGINS.length };
        this.prefs = { ...this.prefs, [name]: Math.max(0, Math.min(limits[name] - 1, this.prefs[name] + Number(button.dataset.direction))) };
        this.applyPrefs(true);
        this.savePrefs();
        this.syncSettingsForm();
        if (button.disabled) (form.querySelector<HTMLButtonElement>(`[data-step="${name}"]:not(:disabled)`))?.focus();
      });
    }
    byId("er-reset").addEventListener("click", () => {
      this.prefs = this.store.resetPrefs();
      this.applyPrefs(true);
      this.syncSettingsForm();
    });
  }
}

export function startEReader(opened: OpenedReader, boot: EReaderBoot, storage: StorageLike): EReader {
  const reader = new EReader(opened, boot, storage);
  reader.start();
  return reader;
}
