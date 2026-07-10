import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { parseDocument } from "yaml";
import { AlertCircle, BookOpen, Bookmark, BookmarkPlus, ChevronLeft, ChevronRight, Eye, EyeOff, Image as ImageIcon, Maximize2, Minimize2, Settings, Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/use-toast";
import { useBookStructure } from "@/hooks/useBookStructure";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { useSettings } from "@/drive/useSettings";
import { useSettingsStore } from "@/store/settingsStore";
import { loadBinaryFileContent, loadFileContent, slugToTitle } from "@/github/githubClient";
import { canonSectionMeta, CANON_SECTION_ORDER, type CanonSection } from "@/lib/canonSections";
import { resolveBookExportSettings, resolveBookToken, type BookEntry, type BookExportSettings, type ReaderBookmark, type ReaderSettings } from "@/types/settings";
import type { BookFile, BookStructure, Chapter, Paragraph } from "@/types/book";
import { paragraphSeparator, presentMetadata, type PresentedMetadata } from "@/export/metadataPresentation";

const PAGE_GAP = 32;

interface MarkdownParts {
  frontmatter: string;
  frontmatterRecord: Record<string, unknown>;
  body: string;
}

interface ReaderImage {
  url: string;
  alt: string;
  path?: string;
}

interface ReaderEntity {
  section: CanonSection | string;
  name: string;
  path: string;
  imagePath?: string;
}

interface ReaderParagraph {
  paragraph: Paragraph;
  chapterSlug: string;
  chapterTitle: string;
  frontmatter: string;
  frontmatterRecord: Record<string, unknown>;
  html: string;
  text: string;
  images: ReaderImage[];
}

interface ReaderChapter {
  chapter: Chapter;
  frontmatter: string;
  frontmatterRecord: Record<string, unknown>;
  images: ReaderImage[];
  paragraphs: ReaderParagraph[];
}

interface ReaderBook {
  title: string;
  frontmatterRecord: Record<string, unknown>;
  coverUrl?: string;
  coverPath?: string;
  chapters: ReaderChapter[];
}

interface LogicalPosition {
  bookId: string;
  chapterSlug: string;
  paragraphNumber: string;
  offset: number;
}

interface EntityDetails {
  entity: ReaderEntity;
  html: string;
  frontmatterEntries: Array<{ key: string; value: string }>;
  imageUrl?: string;
}

export function ReaderPreviewPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { bookId } = useParams<{ bookId: string }>();
  const { settings, patchSettings } = useSettingsStore();
  const { save } = useSettings();
  const { book, structure, loading, error, reload } = useBookStructure(bookId);
  const { branch } = useWorkingBranch(bookId);
  const readerSettings = settings.reader;
  const presentationSettings = useMemo(() => (book ? resolveBookExportSettings(book) : null), [book]);
  const token = book ? resolveBookToken(book, settings) : "";
  const [readerBook, setReaderBook] = useState<ReaderBook | null>(null);
  const [busy, setBusy] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [pageWidth, setPageWidth] = useState(0);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [currentPosition, setCurrentPosition] = useState<LogicalPosition | null>(null);
  const [entityDetails, setEntityDetails] = useState<EntityDetails | null>(null);
  const [entityLoading, setEntityLoading] = useState(false);
  const [entityError, setEntityError] = useState("");
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const flowRef = useRef<HTMLElement | null>(null);
  const pendingPositionRef = useRef<LogicalPosition | null>(null);
  const entityImageUrlsRef = useRef<string[]>([]);

  const entities = useMemo(() => collectEntities(structure), [structure]);
  const bookBookmarks = useMemo(
    () => settings.reader.bookmarks.filter((entry) => entry.bookId === bookId),
    [bookId, settings.reader.bookmarks],
  );

  useEffect(() => {
    if (!book || !structure || !token) return;
    let active = true;
    const objectUrls: string[] = [];
    setBusy(true);
    void loadReaderBook({
      book,
      structure,
      token,
      branch,
      readerSettings,
      presentationSettings: presentationSettings ?? resolveBookExportSettings({} as BookEntry),
      entities,
      objectUrls,
    })
      .then((loaded) => {
        if (active) {
          setReaderBook(loaded);
          setPageIndex(0);
        }
      })
      .catch((err) => {
        if (active) toast({ title: t("reader.loadFailed"), description: String(err), variant: "destructive" });
      })
      .finally(() => { if (active) setBusy(false); });
    return () => {
      active = false;
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [book, branch, entities, presentationSettings, readerSettings.lineBreakMode, readerSettings.showFrontmatter, readerSettings.showImages, readerSettings.showRichEntityLinks, structure, t, toast, token]);

  useEffect(() => () => {
    entityImageUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    entityImageUrlsRef.current = [];
  }, []);

  useEffect(() => {
    if (!readerSettings.fullScreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setReaderFullScreen(false);
    };
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) setReaderFullScreen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
    };
  }, [readerSettings.fullScreen]);

  function recalculatePages() {
    const viewport = viewportRef.current;
    const flow = flowRef.current;
    if (!viewport || !flow) return;
    const width = Math.max(1, viewport.clientWidth);
    setPageWidth(width);
    window.requestAnimationFrame(() => {
      const total = Math.max(1, Math.ceil((flow.scrollWidth + PAGE_GAP) / (width + PAGE_GAP)));
      setPageCount(total);
      setPageIndex((current) => Math.min(current, total - 1));
      const pending = pendingPositionRef.current;
      if (pending) {
        pendingPositionRef.current = null;
        window.requestAnimationFrame(() => jumpToPosition(pending));
      }
    });
  }

  useLayoutEffect(() => {
    recalculatePages();
  }, [readerBook, readerSettings.fontFamily, readerSettings.fontSize, readerSettings.fullScreen, readerSettings.lineBreakMode, readerSettings.lineHeight, readerSettings.pageMargin]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => recalculatePages());
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [readerBook, readerSettings.fontFamily, readerSettings.fontSize, readerSettings.fullScreen, readerSettings.lineBreakMode, readerSettings.lineHeight, readerSettings.pageMargin, pageIndex, pageWidth, pageCount]);

  const resolveCurrentPosition = useCallback((): LogicalPosition | null => {
    const viewport = viewportRef.current;
    if (!viewport || !bookId) return null;
    const viewportRect = viewport.getBoundingClientRect();
    const elements = Array.from(viewport.querySelectorAll<HTMLElement>("[data-reader-paragraph]"));
    let bestEl: HTMLElement | null = null;
    let bestRectIndex = 0;
    let bestRectCount = 1;
    let bestScore = 0;

    for (const el of elements) {
      const rects = Array.from(el.getClientRects());
      for (let index = 0; index < rects.length; index++) {
        const rect = rects[index];
        const horizontal = Math.max(0, Math.min(rect.right, viewportRect.right) - Math.max(rect.left, viewportRect.left));
        const vertical = Math.max(0, Math.min(rect.bottom, viewportRect.bottom) - Math.max(rect.top, viewportRect.top));
        const score = horizontal * vertical;
        if (score > bestScore) {
          bestEl = el;
          bestRectIndex = index;
          bestRectCount = Math.max(1, rects.length);
          bestScore = score;
        }
      }
    }

    const target = bestEl ?? elements[0];
    if (!target) return null;
    const chapterSlug = target.dataset.chapterSlug;
    const paragraphNumber = target.dataset.paragraphNumber;
    if (!chapterSlug || !paragraphNumber) return null;
    const textLength = Number(target.dataset.textLength || "0");
    const ratio = bestScore > 0 && bestRectCount > 1 ? bestRectIndex / Math.max(1, bestRectCount - 1) : 0;
    return { bookId, chapterSlug, paragraphNumber, offset: Math.max(0, Math.round(textLength * ratio)) };
  }, [bookId]);

  useEffect(() => {
    setCurrentPosition(resolveCurrentPosition());
  }, [pageIndex, pageWidth, pageCount, readerBook, resolveCurrentPosition]);

  function patchReaderSettings(patch: Partial<ReaderSettings>) {
    pendingPositionRef.current = resolveCurrentPosition() ?? currentPosition;
    patchSettings({ reader: { ...settings.reader, ...patch } });
    void save();
  }

  function setReaderFullScreen(enabled: boolean) {
    patchReaderSettings({ fullScreen: enabled });
    if (enabled) {
      void document.documentElement.requestFullscreen?.().catch(() => undefined);
    } else if (document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => undefined);
    }
  }

  function go(delta: number) {
    setPageIndex((current) => Math.max(0, Math.min(pageCount - 1, current + delta)));
  }

  function handleReaderClick(event: React.MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const entityButton = target.closest("[data-reader-entity-path]") as HTMLElement | null;
    if (entityButton) {
      event.preventDefault();
      event.stopPropagation();
      const path = entityButton.dataset.readerEntityPath;
      const entity = entities.find((entry) => entry.path === path);
      if (entity) void openEntity(entity);
      return;
    }
    if (target.closest("button,a,input,select,textarea,label")) return;
    const rect = event.currentTarget.getBoundingClientRect();
    go(event.clientX - rect.left > rect.width / 2 ? 1 : -1);
  }

  function jumpToPosition(position: LogicalPosition) {
    const viewport = viewportRef.current;
    const flow = flowRef.current;
    if (!viewport || !flow || !pageWidth) return;
    const elements = Array.from(flow.querySelectorAll<HTMLElement>("[data-reader-paragraph]"));
    const target = elements.find((el) => el.dataset.chapterSlug === position.chapterSlug && el.dataset.paragraphNumber === position.paragraphNumber);
    if (!target) return;
    const viewportRect = viewport.getBoundingClientRect();
    const rects = Array.from(target.getClientRects());
    const textLength = Number(target.dataset.textLength || "0");
    const ratio = textLength > 0 ? Math.max(0, Math.min(1, position.offset / textLength)) : 0;
    const rect = rects[Math.min(rects.length - 1, Math.round(ratio * Math.max(0, rects.length - 1)))] ?? target.getBoundingClientRect();
    const delta = rect.left - viewportRect.left;
    const nextPage = Math.max(0, Math.min(pageCount - 1, pageIndex + Math.round(delta / (pageWidth + PAGE_GAP))));
    setPageIndex(nextPage);
    setBookmarksOpen(false);
  }

  function addBookmark() {
    const position = resolveCurrentPosition() ?? currentPosition;
    if (!position || !readerBook) return;
    const paragraph = findReaderParagraph(readerBook, position.chapterSlug, position.paragraphNumber);
    const bookmark: ReaderBookmark = {
      id: crypto.randomUUID(),
      ...position,
      label: paragraph ? `${paragraph.chapterTitle} · ${paragraph.paragraph.number}` : t("reader.bookmark"),
      preview: paragraph?.text.slice(position.offset, position.offset + 160).trim(),
      createdAt: new Date().toISOString(),
    };
    patchSettings({ reader: { ...settings.reader, bookmarks: [bookmark, ...settings.reader.bookmarks] } });
    void save();
    toast({ title: t("reader.bookmarkAdded") });
  }

  function deleteBookmark(id: string) {
    patchSettings({ reader: { ...settings.reader, bookmarks: settings.reader.bookmarks.filter((entry) => entry.id !== id) } });
    void save();
  }

  async function openEntity(entity: ReaderEntity) {
    if (!book || !token) return;
    setEntityDetails(null);
    setEntityError("");
    setEntityLoading(true);
    try {
      const details = await loadEntityDetails({ entity, book, token, branch, objectUrls: entityImageUrlsRef.current });
      setEntityDetails(details);
    } catch (err) {
      setEntityError(String(err));
    } finally {
      setEntityLoading(false);
    }
  }

  if (!book) return <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertDescription>{t("bookPage.notFound")}</AlertDescription></Alert>;
  if (loading && !structure) return <ReaderSkeleton />;
  if (error && !structure) return <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertDescription className="flex flex-wrap items-center gap-3"><span>{error}</span><Button size="sm" variant="outline" onClick={() => reload()}>{t("common.reloadBook")}</Button></AlertDescription></Alert>;

  const fullScreen = readerSettings.fullScreen;
  const rootClass = fullScreen
    ? "fixed inset-0 z-[90] flex flex-col bg-background p-0"
    : "flex h-[calc(100dvh-6.5rem)] min-h-[560px] flex-col gap-4";

  return (
    <div className={rootClass}>
      {!fullScreen && <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs uppercase tracking-[0.24em] text-muted-foreground">{t("reader.title")}</p>
          <h1 className="truncate font-serif text-2xl font-semibold tracking-tight sm:text-3xl">{readerBook?.title ?? structure?.title ?? book.name}</h1>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1">
          <Button variant="outline" size="sm" onClick={() => go(-1)} disabled={pageIndex <= 0}><ChevronLeft className="h-4 w-4" />{t("reader.previous")}</Button>
          <Button variant="outline" size="sm" onClick={() => go(1)} disabled={pageIndex >= pageCount - 1}>{t("reader.next")}<ChevronRight className="h-4 w-4" /></Button>
          <Button variant="outline" size="sm" onClick={addBookmark}><BookmarkPlus className="mr-1 h-4 w-4" />{t("reader.addBookmark")}</Button>
          <Button variant="outline" size="sm" onClick={() => setBookmarksOpen(true)}><Bookmark className="mr-1 h-4 w-4" />{bookBookmarks.length}</Button>
          <Button asChild variant="outline" size="sm"><Link to="/app/reader-settings" state={{ returnTo: `/app/books/${book.id}/reader` }}><Settings className="mr-1 h-4 w-4" />{t("reader.settingsTitle")}</Link></Button>
          <Button variant="outline" size="icon" title={readerSettings.showImages ? t("reader.hideImages") : t("reader.showImages")} onClick={() => patchReaderSettings({ showImages: !readerSettings.showImages })}>
            {readerSettings.showImages ? <ImageIcon className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </Button>
          <Button variant="outline" size="icon" title={readerSettings.showRichEntityLinks ? t("reader.hideEntityLinks") : t("reader.showEntityLinks")} onClick={() => patchReaderSettings({ showRichEntityLinks: !readerSettings.showRichEntityLinks })}>
            {readerSettings.showRichEntityLinks ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </Button>
          <Button variant="outline" size="icon" title={t("reader.fullscreen")} onClick={() => setReaderFullScreen(true)}>
            <Maximize2 className="h-4 w-4" />
          </Button>
        </div>
      </div>}

      <div className={fullScreen ? "min-h-0 flex-1 bg-card text-card-foreground" : "min-h-0 flex-1 rounded-[2rem] border bg-card p-2 text-card-foreground shadow-sm sm:p-3"}>
        {busy || !readerBook ? <ReaderSkeleton /> : (
          <div className="flex h-full min-h-0 flex-col">
            <div
              className={fullScreen ? "relative min-h-0 flex-1 cursor-pointer overflow-hidden bg-background" : "relative min-h-0 flex-1 cursor-pointer overflow-hidden rounded-[2rem] border bg-background/70 shadow-inner"}
              onClick={handleReaderClick}
              style={{ padding: `${readerSettings.pageMargin}px` }}
            >
              {fullScreen && readerSettings.showExitFullscreenButton && (
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  className="absolute right-3 top-3 z-30 h-9 w-9 rounded-full border bg-background/85 text-foreground shadow-lg backdrop-blur transition hover:bg-background sm:right-5 sm:top-5"
                  title={t("reader.exitFullscreen")}
                  aria-label={t("reader.exitFullscreen")}
                  onClick={(event) => {
                    event.stopPropagation();
                    setReaderFullScreen(false);
                  }}
                >
                  <Minimize2 className="h-4 w-4" />
                </Button>
              )}
              <div ref={viewportRef} className="h-full overflow-hidden">
              <article
                ref={flowRef}
                className="reader-page-flow h-full transition-transform duration-200 ease-out"
                style={{
                  columnGap: `${PAGE_GAP}px`,
                  columnWidth: pageWidth ? `${pageWidth}px` : undefined,
                  width: pageWidth ? `${pageWidth}px` : undefined,
                  fontFamily: readerFontFamily(readerSettings.fontFamily),
                  fontSize: `${readerSettings.fontSize}px`,
                  lineHeight: readerSettings.lineHeight,
                  transform: `translateX(-${pageIndex * (pageWidth + PAGE_GAP)}px)`,
                }}
              >
                <ReaderCover title={readerBook.title} coverUrl={readerBook.coverUrl} />
                <ReaderMetadata entries={presentMetadata(readerBook.frontmatterRecord, presentationSettings?.metadataVisibility.book ?? [])} />
                {readerBook.chapters.map((entry) => (
                  <section key={entry.chapter.slug} className="reader-chapter">
                    <header className="reader-chapter-title mb-8 text-center">
                      <BookOpen className="mx-auto h-6 w-6 opacity-50" />
                      <h2 className="mt-3 font-serif text-4xl font-semibold leading-tight tracking-tight">{entry.chapter.title}</h2>
                    </header>
                    <ReaderMetadata entries={presentMetadata(entry.frontmatterRecord, presentationSettings?.metadataVisibility.chapter ?? [])} />
                    {readerSettings.showFrontmatter && entry.frontmatter.trim() && <ReaderFrontmatter value={entry.frontmatter} />}
                    {entry.paragraphs.map((paragraph, paragraphIndex) => (
                      <section
                        key={paragraph.paragraph.path}
                        data-reader-paragraph=""
                        data-chapter-slug={paragraph.chapterSlug}
                        data-paragraph-number={paragraph.paragraph.number}
                        data-text-length={paragraph.text.length}
                        className="reader-paragraph"
                      >
                        <ReaderMetadata entries={presentMetadata(paragraph.frontmatterRecord, presentationSettings?.metadataVisibility.paragraph ?? [])} />
                        {readerSettings.showFrontmatter && paragraph.frontmatter.trim() && <ReaderFrontmatter value={paragraph.frontmatter} />}
                        <div className="doc-prose reader-prose" dangerouslySetInnerHTML={{ __html: paragraph.html }} />
                        {readerSettings.showImages && paragraph.images.length > 0 && <ReaderImages images={paragraph.images} />}
                        {paragraphIndex < entry.paragraphs.length - 1 && presentationSettings && paragraphSeparator(presentationSettings) && <div className="my-10 text-center text-xl tracking-[0.5em] text-muted-foreground/60">{paragraphSeparator(presentationSettings)}</div>}
                      </section>
                    ))}
                    {readerSettings.showImages && entry.images.length > 0 && <ReaderImages images={entry.images} chapter />}
                  </section>
                ))}
              </article>
              </div>
            </div>
            {!fullScreen && <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <span>{currentPosition ? bookmarkLabel(readerBook, currentPosition) : t("reader.cover")}</span>
              <span>{t("reader.pageOf", { page: pageIndex + 1, pages: pageCount })}</span>
            </div>}
          </div>
        )}
      </div>

      <Dialog open={bookmarksOpen} onOpenChange={setBookmarksOpen}>
        <DialogContent className="max-h-[80dvh] overflow-auto sm:max-w-2xl">
          <div className="space-y-4">
            <div>
              <p className="font-serif text-2xl font-semibold">{t("reader.bookmarks")}</p>
              <p className="text-sm text-muted-foreground">{t("reader.bookmarksDescription")}</p>
            </div>
            {bookBookmarks.length === 0 ? (
              <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">{t("reader.noBookmarks")}</p>
            ) : bookBookmarks.map((entry) => (
              <div key={entry.id} className="flex items-start gap-3 rounded-xl border p-3">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => jumpToPosition(entry)}>
                  <p className="font-medium">{entry.label}</p>
                  {entry.preview && <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{entry.preview}</p>}
                  <p className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">{new Date(entry.createdAt).toLocaleString()}</p>
                </button>
                <Button variant="ghost" size="icon" onClick={() => deleteBookmark(entry.id)} aria-label={t("reader.deleteBookmark")}><Trash2 className="h-4 w-4 text-destructive" /></Button>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={entityLoading || Boolean(entityDetails) || Boolean(entityError)} onOpenChange={(open) => { if (!open) { setEntityDetails(null); setEntityError(""); setEntityLoading(false); } }}>
        <DialogContent className="z-[120] max-h-[88dvh] overflow-auto sm:max-w-3xl">
          {entityLoading ? (
            <ReaderSkeleton />
          ) : entityError ? (
            <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertDescription>{entityError}</AlertDescription></Alert>
          ) : entityDetails ? (
            <EntityDetailsView details={entityDetails} />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ReaderCover({ title, coverUrl }: { title: string; coverUrl?: string }) {
  return (
    <section className="reader-cover flex h-full break-after-column flex-col items-center justify-center text-center">
      {coverUrl ? (
        <img src={coverUrl} alt={title} className="max-h-[76%] max-w-[82%] rounded-2xl object-contain shadow-2xl" />
      ) : (
        <div className="flex h-[70%] w-[72%] flex-col items-center justify-center rounded-3xl border bg-muted/30 p-8 shadow-inner">
          <BookOpen className="mb-6 h-16 w-16 opacity-40" />
          <h2 className="font-serif text-5xl font-semibold leading-tight">{title}</h2>
        </div>
      )}
    </section>
  );
}

function ReaderFrontmatter({ value }: { value: string }) {
  return <pre className="reader-frontmatter mb-6 whitespace-pre-wrap rounded-xl border bg-muted/70 p-3 font-mono text-xs leading-5 text-muted-foreground">{value.trim()}</pre>;
}

function ReaderMetadata({ entries }: { entries: PresentedMetadata[] }) {
  if (!entries.length) return null;
  return (
    <div className="reader-metadata mb-5 whitespace-pre-wrap text-sm leading-5 text-muted-foreground">
      {entries.map((entry) => entry.value).join("\n")}
    </div>
  );
}

function ReaderImages({ images, chapter }: { images: ReaderImage[]; chapter?: boolean }) {
  return (
    <div className={chapter ? "reader-images reader-chapter-images" : "reader-images"}>
      {images.map((image) => (
        <figure key={`${image.path ?? image.url}-${image.alt}`} className="reader-image my-8 break-inside-avoid text-center">
          <img src={image.url} alt={image.alt} className="mx-auto max-h-[72vh] max-w-full rounded-2xl object-contain shadow-lg" />
          {image.alt && <figcaption className="mt-2 text-xs text-muted-foreground">{image.alt}</figcaption>}
        </figure>
      ))}
    </div>
  );
}

function EntityDetailsView({ details }: { details: EntityDetails }) {
  const { t } = useTranslation();
  const meta = canonSectionMeta(details.entity.section);
  const Icon = meta?.icon;
  return (
    <article className="space-y-4">
      <div className="flex items-start gap-4">
        {details.imageUrl && <img src={details.imageUrl} alt={details.entity.name} className="h-24 w-24 shrink-0 rounded-xl object-cover ring-1 ring-border" />}
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1 text-[10px] uppercase tracking-[0.22em] text-muted-foreground">{Icon && <Icon className="h-3.5 w-3.5" />}{meta ? t(meta.labelKey) : details.entity.section}</p>
          <h2 className="font-serif text-3xl font-semibold leading-tight">{details.entity.name}</h2>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{details.entity.path}</p>
        </div>
      </div>
      {details.frontmatterEntries.length > 0 && (
        <div className="grid gap-2 rounded-xl border bg-muted/30 p-3 sm:grid-cols-2">
          {details.frontmatterEntries.map((entry) => (
            <div key={entry.key} className="min-w-0">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{entry.key}</p>
              <p className="break-words text-sm">{entry.value}</p>
            </div>
          ))}
        </div>
      )}
      <div className="doc-prose" dangerouslySetInnerHTML={{ __html: details.html }} />
    </article>
  );
}

async function loadReaderBook(input: {
  book: BookEntry;
  structure: BookStructure;
  token: string;
  branch: string;
  readerSettings: ReaderSettings;
  presentationSettings: BookExportSettings;
  entities: ReaderEntity[];
  objectUrls: string[];
}): Promise<ReaderBook> {
  const { marked } = await import("marked");
  const rawBook = await loadFileContent(input.token, input.book.owner, input.book.repo, "book.md", input.branch).catch(() => "");
  const bookDoc = splitMarkdown(rawBook);
  const cover = input.structure.bookCoverPath
    ? await loadImageUrl(input, input.structure.bookCoverPath, input.structure.title).catch(() => undefined)
    : undefined;
  const chapters = await Promise.all(input.structure.chapters.map(async (chapter) => {
    const chapterPath = `${chapter.path}/chapter.md`;
    const rawChapter = await loadFileContent(input.token, input.book.owner, input.book.repo, chapterPath, input.branch).catch(() => "");
    const chapterDoc = splitMarkdown(rawChapter);
    const paragraphs = await Promise.all(chapter.paragraphs.map(async (paragraph) => {
      const rawParagraph = await loadFileContent(input.token, input.book.owner, input.book.repo, paragraph.path, input.branch).catch(() => "");
      const paragraphDoc = splitMarkdown(rawParagraph);
      const rendered = await renderReaderMarkdown({
        rawBody: paragraphDoc.body,
        filePath: paragraph.path,
        fallbackAlt: paragraph.title,
        input,
        marked,
      });
      const structureImage = input.readerSettings.showImages && paragraph.imagePath ? await loadImageUrl(input, paragraph.imagePath, paragraph.title).catch(() => undefined) : undefined;
      return {
        paragraph,
        chapterSlug: chapter.slug,
        chapterTitle: chapter.title,
        frontmatter: paragraphDoc.frontmatter,
        frontmatterRecord: paragraphDoc.frontmatterRecord,
        html: rendered.html,
        text: rendered.text,
        images: [...rendered.images, ...(structureImage ? [structureImage] : [])],
      };
    }));
    const structureImage = input.readerSettings.showImages && chapter.imagePath ? await loadImageUrl(input, chapter.imagePath, chapter.title).catch(() => undefined) : undefined;
    return {
      chapter,
      frontmatter: chapterDoc.frontmatter,
      frontmatterRecord: chapterDoc.frontmatterRecord,
      images: [...(structureImage ? [structureImage] : [])],
      paragraphs,
    };
  }));
  return { title: input.structure.title || input.book.name || input.book.repo, frontmatterRecord: bookDoc.frontmatterRecord, coverPath: input.structure.bookCoverPath, coverUrl: cover?.url, chapters };
}

async function renderReaderMarkdown(input: {
  rawBody: string;
  filePath: string;
  fallbackAlt: string;
  input: {
    book: BookEntry;
    token: string;
    branch: string;
    readerSettings: ReaderSettings;
    entities: ReaderEntity[];
    objectUrls: string[];
  };
  marked: typeof import("marked")["marked"];
}): Promise<{ html: string; text: string; images: ReaderImage[] }> {
  const extracted = extractMarkdownImages(input.rawBody, input.filePath);
  const readerBody = normalizeReaderLineBreaks(extracted.body, input.input.readerSettings.lineBreakMode);
  const html = input.marked.parse(readerBody, { async: false }) as string;
  const linkedHtml = input.input.readerSettings.showRichEntityLinks ? linkEntityHtml(html, input.input.entities) : html;
  const images = input.input.readerSettings.showImages
    ? (await Promise.all(extracted.images.map((image) => loadImageUrl(input.input, image.path, image.alt || input.fallbackAlt).catch(() => undefined)))).filter(Boolean) as ReaderImage[]
    : [];
  return { html: linkedHtml, text: markdownToPlainText(readerBody), images };
}

function normalizeReaderLineBreaks(markdown: string, mode: ReaderSettings["lineBreakMode"]): string {
  if (mode === "source") return markdown.trim();
  const blocks = markdown.replace(/\r\n/g, "\n").split(/\n\s*\n+/);
  const output: string[] = [];
  const prose: string[] = [];

  function flushProse() {
    const text = prose.join(" ").replace(/\s+/g, " ").trim();
    if (text) output.push(text);
    prose.length = 0;
  }

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (isPreservedMarkdownBlock(trimmed)) {
      flushProse();
      output.push(trimmed);
      continue;
    }
    const compact = trimmed.split("\n").map((line) => line.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    if (!compact) continue;
    if (mode === "dialogue" && isDialogueParagraph(compact)) {
      flushProse();
      output.push(compact);
      continue;
    }
    prose.push(compact);
  }
  flushProse();
  return output.join("\n\n").trim();
}

function isPreservedMarkdownBlock(block: string): boolean {
  return /^(#{1,6}\s+|```|~~~|>\s+|[-*+]\s+|\d+\.\s+|---+$|\*\*\*+$)/m.test(block.trim());
}

function isDialogueParagraph(text: string): boolean {
  const trimmed = text.trim();
  return /^[«“"—–]/.test(trimmed);
}

async function loadEntityDetails(input: { entity: ReaderEntity; book: BookEntry; token: string; branch: string; objectUrls: string[] }): Promise<EntityDetails> {
  const { marked } = await import("marked");
  const raw = await loadFileContent(input.token, input.book.owner, input.book.repo, input.entity.path, input.branch);
  const parts = splitMarkdown(raw);
  const imageUrl = input.entity.imagePath ? (await loadImageUrl(input, input.entity.imagePath, input.entity.name).catch(() => undefined))?.url : undefined;
  return {
    entity: input.entity,
    html: marked.parse(parts.body, { async: false }) as string,
    frontmatterEntries: frontmatterEntries(parts.frontmatterRecord),
    imageUrl,
  };
}

function splitMarkdown(raw: string): MarkdownParts {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: "", frontmatterRecord: {}, body: raw.trim() };
  let frontmatterRecord: Record<string, unknown> = {};
  try {
    const parsed = parseDocument(match[1]).toJSON();
    if (parsed && typeof parsed === "object") frontmatterRecord = parsed as Record<string, unknown>;
  } catch {
    frontmatterRecord = {};
  }
  return { frontmatter: match[1] ?? "", frontmatterRecord, body: (match[2] ?? "").trim() };
}

function extractMarkdownImages(body: string, filePath: string): { body: string; images: Array<{ path: string; alt: string }> } {
  const images: Array<{ path: string; alt: string }> = [];
  const cleaned = body.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_full, alt: string, src: string) => {
    images.push({ path: resolveMarkdownAssetPath(src, filePath), alt });
    return "";
  });
  return { body: cleaned, images };
}

function collectEntities(structure: BookStructure | undefined): ReaderEntity[] {
  if (!structure) return [];
  const entities: ReaderEntity[] = [];
  for (const section of CANON_SECTION_ORDER) {
    const files = (structure as unknown as Record<string, BookFile[]>)[section] ?? [];
    for (const file of files) {
      const slug = (file.path.split("/").pop() ?? "").replace(/\.md$/i, "");
      entities.push({ section, name: file.name ?? slugToTitle(slug), path: file.path, imagePath: file.imagePath });
    }
  }
  return entities;
}

function linkEntityHtml(html: string, entities: ReaderEntity[]): string {
  if (!entities.length || typeof DOMParser === "undefined") return html;
  const candidates = entities
    .map((entity) => ({ entity, name: entity.name.trim() }))
    .filter((entry) => entry.name.length >= 3)
    .sort((a, b) => b.name.length - a.name.length);
  if (!candidates.length) return html;
  const byName = new Map(candidates.map((entry) => [entry.name.toLocaleLowerCase(), entry.entity]));
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])(${candidates.map((entry) => escapeRegExp(entry.name)).join("|")})(?=$|[^\\p{L}\\p{N}_])`, "giu");
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstElementChild;
  if (!root) return html;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    const parent = node.parentElement;
    if (parent && !parent.closest("a,button,script,style,code,pre")) textNodes.push(node as Text);
    node = walker.nextNode();
  }
  for (const textNode of textNodes) {
    const text = textNode.nodeValue ?? "";
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    let last = 0;
    let changed = false;
    const fragment = doc.createDocumentFragment();
    while ((match = pattern.exec(text))) {
      const prefix = match[1] ?? "";
      const label = match[2] ?? "";
      const start = match.index + prefix.length;
      const entity = byName.get(label.toLocaleLowerCase());
      if (!entity) continue;
      fragment.append(text.slice(last, start));
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "reader-entity-link";
      button.textContent = text.slice(start, start + label.length);
      button.setAttribute("data-reader-entity-path", entity.path);
      button.setAttribute("data-reader-entity-section", entity.section);
      button.setAttribute("data-reader-entity-name", entity.name);
      fragment.append(button);
      last = start + label.length;
      changed = true;
    }
    if (changed) {
      fragment.append(text.slice(last));
      textNode.parentNode?.replaceChild(fragment, textNode);
    }
  }
  return root.innerHTML;
}

async function loadImageUrl(input: { token: string; book?: BookEntry; owner?: string; repo?: string; branch: string; objectUrls: string[] }, path: string, alt: string): Promise<ReaderImage | undefined> {
  if (/^(https?:|data:|blob:)/i.test(path)) return { url: path, alt, path };
  const owner = input.owner ?? input.book?.owner;
  const repo = input.repo ?? input.book?.repo;
  if (!owner || !repo) return undefined;
  const bytes = await loadBinaryFileContent(input.token, owner, repo, path, input.branch).catch(() => null);
  if (!bytes) return undefined;
  const url = URL.createObjectURL(new Blob([bytesToArrayBuffer(bytes)], { type: imageMimeType(path) }));
  input.objectUrls.push(url);
  return { url, alt, path };
}

function resolveMarkdownAssetPath(src: string, filePath: string): string {
  const clean = src.replace(/^['"]|['"]$/g, "");
  if (/^(https?:|data:|blob:)/i.test(clean)) return clean;
  if (!clean.startsWith(".")) return clean.replace(/^\/+/, "");
  const parts = filePath.split("/").slice(0, -1);
  for (const part of clean.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function frontmatterEntries(frontmatter: Record<string, unknown>): Array<{ key: string; value: string }> {
  return Object.entries(frontmatter)
    .filter(([key]) => !["title", "name", "id", "type"].includes(key))
    .map(([key, value]) => ({ key, value: formatFrontmatterValue(value) }))
    .filter((entry) => entry.value.trim());
}

function formatFrontmatterValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(formatFrontmatterValue).filter(Boolean).join(", ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return value == null ? "" : String(value);
}

function findReaderParagraph(book: ReaderBook, chapterSlug: string, paragraphNumber: string): ReaderParagraph | undefined {
  return book.chapters.find((chapter) => chapter.chapter.slug === chapterSlug)?.paragraphs.find((paragraph) => paragraph.paragraph.number === paragraphNumber);
}

function bookmarkLabel(book: ReaderBook, position: LogicalPosition): string {
  const paragraph = findReaderParagraph(book, position.chapterSlug, position.paragraphNumber);
  return paragraph ? `${paragraph.chapterTitle} · ${paragraph.paragraph.number}` : position.chapterSlug;
}

function readerFontFamily(value: string): string {
  if (value === "sans") return "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  if (value === "mono") return "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
  return "Georgia, 'Times New Roman', Times, serif";
}

function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#>*_~\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function imageMimeType(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  if (extension === "svg") return "image/svg+xml";
  return "image/png";
}

function ReaderSkeleton() {
  return <div className="h-full min-h-0 space-y-4"><Skeleton className="h-16 w-full" /><Skeleton className="h-[70%] w-full rounded-[2rem]" /></div>;
}
