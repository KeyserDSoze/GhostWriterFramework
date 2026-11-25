import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Highlighter, ListChecks, MessageSquareOff, MessageSquareText, MoreHorizontal } from "lucide-react";
import "@/i18n/annotations";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useSelectionMenuStore } from "@/components/editor/selectionMenuStore";
import { useBookAnnotations } from "@/annotations/useBookAnnotations";
import { AnnotationsFileError, deviceTag } from "@/annotations/repository";
import { annotationStatus, createAnnotationId, isPendingStatus, type Annotation, type AnnotationTagDefinition } from "@/annotations/model";
import { anchorFromRange, listPosition } from "@/annotations/anchoring";
import { annotateShortcutLabel, isAnnotateShortcut, isMacPlatform, isTypingTarget } from "@/annotations/shortcut";
import { AnnotateDialog, type AnnotateRequest } from "@/components/annotations/AnnotateDialog";
import { AnnotationEditorDialog, type AnnotationEditTarget } from "@/components/annotations/AnnotationEditorDialog";
import { AnchorNotice } from "@/components/annotations/AnchorNotice";
import { TagLabel } from "@/components/annotations/TagLabel";
import { usePublicNotice } from "@/components/annotations/usePublicNotice";
import { ReaderAnnotationMenu, type ReaderMenuApi, type ReaderMenuContext } from "@/components/annotations/reader/ReaderAnnotationMenu";
import { readerSelectionOf, showPendingPassage, type ReaderSelection } from "@/components/annotations/reader/readerSelection";
import { useLocatedAnnotations, type LocatedAnnotation, type ReaderScene } from "@/components/annotations/reader/useLocatedAnnotations";

const LAST_TAG_KEY = "narrarium-annotations-last-tag";

function lastTag(): string | undefined {
  try { return localStorage.getItem(LAST_TAG_KEY) ?? undefined; } catch { return undefined; }
}

function rememberTag(id: string): void {
  try { localStorage.setItem(LAST_TAG_KEY, id); } catch { /* the next annotation starts from the first tag */ }
}

function idsOf(element: Element): string[] {
  const ids = (element.getAttribute("data-annotation-ids") ?? "").split(" ").filter(Boolean);
  if (ids.length) return ids;
  const id = element.getAttribute("data-annotation-id");
  return id ? [id] : [];
}

function markOf(flow: Element, id: string): Element | null {
  return Array.from(flow.querySelectorAll("mark.reader-annotation")).find((mark) => idsOf(mark).includes(id)) ?? null;
}

interface TooltipState {
  ids: string[];
  rect: DOMRect;
}

export interface ReaderAnnotationsInput {
  bookId: string | undefined;
  scenes: readonly ReaderScene[] | null;
  flowRef: RefObject<HTMLElement | null>;
  show: boolean;
  onToggleShow: () => void;
  /** The chapter on the screen, for the panel of the reader. */
  currentChapter: string | undefined;
  /** Turns the pages of the reader to the one that shows `element`. */
  jumpToElement: (element: Element) => void;
  /** An annotation to show once the text is ready (a link from the list of a chapter). */
  initialAnnotationId?: string;
}

/**
 * The annotations in the reader: their marks in the text, the indicator of the scenes that have some, the tooltip of a mark, the toolbar of a selection
 * on a touch screen, «Annotate» in the menu of a selection, the shortcut, the dialogs (annotate, edit, the panel of the chapter) and the notice of a
 * public repository. The page draws what this returns where it belongs.
 */
export function useReaderAnnotations(input: ReaderAnnotationsInput) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { bookId, scenes, flowRef, show, onToggleShow, currentChapter, jumpToElement, initialAnnotationId } = input;
  const data = useBookAnnotations(bookId);
  const { located, marked, pendingByScene, texts } = useLocatedAnnotations({ scenes, chapters: data.chapters, catalog: data.catalog, show });
  const notice = usePublicNotice(data.book);
  const coarse = useMediaQuery("(pointer: coarse)");
  const mac = isMacPlatform();
  const shortcut = annotateShortcutLabel(mac);
  const [selection, setSelection] = useState<ReaderSelection | null>(null);
  const [annotateRequest, setAnnotateRequest] = useState<(AnnotateRequest & { selection: ReaderSelection }) | null>(null);
  const [editTargets, setEditTargets] = useState<AnnotationEditTarget[] | null>(null);
  const [panel, setPanel] = useState<{ chapter: string; paragraph?: string } | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const byId = useMemo(() => new Map(located.map((item) => [item.annotation.id, item])), [located]);

  // The selection of the reader, followed as it changes. A selection that goes away stays a moment, so that a tap on the toolbar still finds it.
  useEffect(() => {
    let timer = 0;
    const update = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const next = readerSelectionOf(flowRef.current, window.getSelection());
        if (next) setSelection(next);
        else timer = window.setTimeout(() => setSelection(readerSelectionOf(flowRef.current, window.getSelection())), 400);
      }, 80);
    };
    document.addEventListener("selectionchange", update);
    return () => {
      document.removeEventListener("selectionchange", update);
      window.clearTimeout(timer);
    };
  }, [flowRef]);

  useEffect(() => {
    showPendingPassage(annotateRequest?.selection.range ?? null);
    return () => showPendingPassage(null);
  }, [annotateRequest]);

  const sceneHref = useCallback((chapter: string, paragraph: string) => {
    const scene = scenes?.find((entry) => entry.chapterSlug === chapter && entry.paragraphSlug === paragraph);
    return scene ? `/app/books/${bookId}/chapters/${chapter}/paragraphs/${scene.paragraphNumber}` : undefined;
  }, [bookId, scenes]);

  const describeFailure = useCallback((error: unknown, chapter?: string) => {
    if (error instanceof AnnotationsFileError) {
      return error.problem === "newer-version"
        ? t("annotations.reader.newerVersion", { chapter: chapter ?? error.path })
        : t("annotations.reader.unreadable", { chapter: chapter ?? error.path, path: error.path, detail: error.message });
    }
    return error instanceof Error ? error.message : String(error);
  }, [t]);

  const annotate = useCallback(async (current: ReaderSelection, tagId: string, note: string): Promise<boolean> => {
    if (!(await notice.confirm("annotation"))) return false;
    try {
      const now = new Date().toISOString();
      await data.saveAnnotation({
        id: createAnnotationId(),
        chapter: current.chapterSlug,
        paragraph: current.paragraphSlug,
        ...current.anchor,
        tag: tagId,
        comment: note,
        status: "open",
        createdAt: now,
        updatedAt: now,
        createdOnDevice: await deviceTag(),
      });
      rememberTag(tagId);
      window.getSelection()?.removeAllRanges();
      setSelection(null);
      toast({ title: t("annotations.reader.saved") });
      return true;
    } catch (error) {
      toast({ title: t("annotations.reader.saveFailed"), description: describeFailure(error, current.chapterSlug), variant: "destructive" });
      return false;
    }
  }, [data, describeFailure, notice, t, toast]);

  const createBookTag = useCallback(async (tag: AnnotationTagDefinition): Promise<boolean> => {
    if (!(await notice.confirm("tag"))) return false;
    try {
      await data.saveBookTag(tag);
      return true;
    } catch (error) {
      toast({ title: t("annotations.reader.saveFailed"), description: describeFailure(error), variant: "destructive" });
      return false;
    }
  }, [data, describeFailure, notice, t, toast]);

  /** A change of an annotation; one found again elsewhere is written where it is now, so that it is found exactly the next time. */
  const update = useCallback(async (annotation: Annotation): Promise<boolean> => {
    const item = byId.get(annotation.id);
    const scene = item && scenes ? scenes.find((entry) => entry.chapterSlug === annotation.chapter && entry.paragraphSlug === item.match.paragraph) : undefined;
    let next = annotation;
    if (item && item.match.state === "moved" && scene) {
      const anchor = anchorFromRange(texts.get(scene.path) ?? "", item.match.start, item.match.end);
      if (anchor && anchor.quote === annotation.quote) next = { ...annotation, paragraph: item.match.paragraph, prefix: anchor.prefix, suffix: anchor.suffix, offset: anchor.offset };
    }
    try {
      await data.saveAnnotation(next);
      return true;
    } catch (error) {
      toast({ title: t("annotations.reader.saveFailed"), description: describeFailure(error, annotation.chapter), variant: "destructive" });
      return false;
    }
  }, [byId, data, describeFailure, scenes, t, texts, toast]);

  const remove = useCallback(async (annotation: Pick<Annotation, "id" | "chapter">): Promise<boolean> => {
    try {
      await data.deleteAnnotation(annotation);
      toast({ title: t("annotations.reader.deleted") });
      return true;
    } catch (error) {
      toast({ title: t("annotations.reader.saveFailed"), description: describeFailure(error, annotation.chapter), variant: "destructive" });
      return false;
    }
  }, [data, describeFailure, t, toast]);

  const openAnnotate = useCallback((current: ReaderSelection, options: { note?: string; newTag?: boolean } = {}) => {
    setTooltip(null);
    setAnnotateRequest({ selection: current, quote: current.anchor.quote, tagId: lastTag(), note: options.note, newTag: options.newTag });
  }, []);

  const edit = useCallback((ids: string[]) => {
    const targets = ids.map((id) => byId.get(id)).filter((item): item is LocatedAnnotation => Boolean(item))
      .map((item) => ({ annotation: item.annotation, state: item.match.state, sceneHref: sceneHref(item.annotation.chapter, item.match.paragraph) }));
    if (!targets.length) return;
    setTooltip(null);
    setEditTargets(targets);
  }, [byId, sceneHref]);

  // The shortcut: only with text of the reader selected, never where keys type.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isAnnotateShortcut(event, mac) || isTypingTarget(event.target)) return;
      const current = readerSelectionOf(flowRef.current, window.getSelection());
      if (!current) return;
      event.preventDefault();
      openAnnotate(current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [flowRef, mac, openAnnotate]);

  // «Annotate» in the menu of a selection, and edit or delete on a mark. The menu reads what it needs when an item is used.
  const api = useRef<ReaderMenuApi>({ catalog: [], shortcut, annotate, openDialog: () => undefined, edit: () => undefined, remove: async () => undefined });
  api.current = {
    catalog: data.catalog,
    shortcut,
    annotate,
    openDialog: (current, options) => openAnnotate(current, options),
    edit,
    remove: async (ids) => {
      if (!window.confirm(t("annotations.edit.deleteConfirm"))) return;
      for (const id of ids) {
        const item = byId.get(id);
        if (item) await remove(item.annotation);
      }
    },
  };
  useEffect(() => useSelectionMenuStore.getState().register({
    id: "reader-annotations",
    capture: (target, current): ReaderMenuContext | null => {
      const flow = flowRef.current;
      if (!flow) return null;
      const passage = readerSelectionOf(flow, current);
      if (passage) return { kind: "selection", selection: passage };
      const mark = target instanceof Element ? target.closest("[data-annotation-id]") : null;
      return mark && flow.contains(mark) ? { kind: "mark", ids: idsOf(mark) } : null;
    },
    render: ({ context, close, touch, menuX }) => <ReaderAnnotationMenu context={context as ReaderMenuContext} close={close} touch={touch} menuX={menuX} api={api} />,
    ownsTouchSelection: (current) => Boolean(current && !current.isCollapsed && current.anchorNode && flowRef.current?.contains(current.anchorNode)),
  }), [flowRef]);

  // The tooltip of a mark: on hover (after a moment) and on focus of its button; Escape dismisses it, and the pointer can move onto it.
  const tooltipHover = useRef(false);
  useEffect(() => {
    const flow = flowRef.current;
    if (!flow) return;
    let showTimer = 0;
    let hideTimer = 0;
    const markAt = (target: EventTarget | null) => (target instanceof Element ? target.closest("[data-annotation-id]") : null);
    const over = (event: MouseEvent) => {
      const mark = markAt(event.target);
      if (!mark || !flow.contains(mark)) return;
      window.clearTimeout(hideTimer);
      window.clearTimeout(showTimer);
      showTimer = window.setTimeout(() => setTooltip({ ids: idsOf(mark), rect: mark.getBoundingClientRect() }), 250);
    };
    const out = (event: MouseEvent) => {
      if (!markAt(event.target)) return;
      window.clearTimeout(showTimer);
      hideTimer = window.setTimeout(() => { if (!tooltipHover.current) setTooltip(null); }, 200);
    };
    const focusIn = (event: FocusEvent) => {
      const icon = event.target instanceof Element ? event.target.closest(".reader-annotation-icon") : null;
      if (icon) setTooltip({ ids: idsOf(icon), rect: icon.getBoundingClientRect() });
    };
    const focusOut = (event: FocusEvent) => {
      if (event.target instanceof Element && event.target.closest(".reader-annotation-icon")) setTooltip(null);
    };
    flow.addEventListener("mouseover", over);
    flow.addEventListener("mouseout", out);
    flow.addEventListener("focusin", focusIn);
    flow.addEventListener("focusout", focusOut);
    return () => {
      window.clearTimeout(showTimer);
      window.clearTimeout(hideTimer);
      flow.removeEventListener("mouseover", over);
      flow.removeEventListener("mouseout", out);
      flow.removeEventListener("focusin", focusIn);
      flow.removeEventListener("focusout", focusOut);
    };
  }, [flowRef, scenes]);
  useEffect(() => {
    if (!tooltip) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setTooltip(null); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tooltip]);

  /**
   * A click in the text: on a mark or its button it opens the annotation (and does not turn the page). A click that ends a selection made over a mark
   * is the selection's; the button of an annotation opens it even while a passage is selected (a tap on a button leaves the selection where it was).
   */
  const handleClick = useCallback((target: HTMLElement): boolean => {
    const mark = target.closest("[data-annotation-id]");
    if (!mark || !flowRef.current?.contains(mark)) return false;
    const icon = mark.classList.contains("reader-annotation-icon");
    if (!icon && window.getSelection()?.toString().trim()) return false;
    if (icon) window.getSelection()?.removeAllRanges();
    edit(idsOf(mark));
    return true;
  }, [edit, flowRef]);

  const showAnnotation = useCallback((id: string) => {
    const flow = flowRef.current;
    const mark = flow ? markOf(flow, id) : null;
    if (!flow || !mark) return false;
    jumpToElement(mark);
    const icon = Array.from(flow.querySelectorAll<HTMLElement>(".reader-annotation-icon")).find((button) => button.dataset.annotationId === id);
    window.requestAnimationFrame(() => icon?.focus({ preventScroll: true }));
    return true;
  }, [flowRef, jumpToElement]);

  // A link from the list of a chapter: the annotation is shown once its mark is in the text.
  const shownInitial = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!initialAnnotationId || shownInitial.current === initialAnnotationId || !marked.size) return;
    const timer = window.setTimeout(() => { if (showAnnotation(initialAnnotationId)) shownInitial.current = initialAnnotationId; }, 150);
    return () => window.clearTimeout(timer);
  }, [initialAnnotationId, marked, showAnnotation]);

  const pendingTotal = useMemo(() => located.filter((item) => isPendingStatus(annotationStatus(item.annotation.status))).length, [located]);

  const sceneIndicator = useCallback((scene: ReaderScene | undefined): ReactNode => {
    if (!show || !scene) return null;
    const items = pendingByScene.get(scene.path);
    if (!items?.length) return null;
    return (
      <button
        type="button"
        className="reader-scene-annotations mb-3 inline-flex min-h-6 items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-0.5 font-sans text-xs font-medium text-primary hover:bg-primary/20 [@media(pointer:coarse)]:min-h-11"
        aria-label={t("annotations.reader.sceneIndicator", { count: items.length })}
        onClick={() => setPanel({ chapter: scene.chapterSlug, paragraph: scene.paragraphSlug })}
      >
        <Highlighter className="h-3.5 w-3.5" aria-hidden="true" />
        {t("annotations.reader.sceneIndicatorShort", { count: items.length })}
      </button>
    );
  }, [pendingByScene, show, t]);

  const headerControls = (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={!selection}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => { if (selection) openAnnotate(selection); }}
        title={t("annotations.shortcutHint", { keys: shortcut })}
        aria-keyshortcuts={mac ? "Meta+Alt+A" : "Control+Alt+M"}
      >
        {/* On a phone the labels are read, not shown: the header keeps its rows. */}
        <Highlighter className="h-4 w-4" aria-hidden="true" /><span className="sr-only sm:not-sr-only">{t("annotations.annotate")}</span>
      </Button>
      <Button variant="outline" size="sm" onClick={() => setPanel({ chapter: currentChapter ?? scenes?.[0]?.chapterSlug ?? "" })} disabled={!scenes?.length}>
        <ListChecks className="h-4 w-4" aria-hidden="true" /><span className="sr-only sm:not-sr-only">{t("annotations.reader.panel")}</span>{pendingTotal > 0 && <span className="rounded-full bg-primary/15 px-1.5 text-xs font-semibold tabular-nums">{pendingTotal}</span>}
      </Button>
      <Button variant="outline" size="icon" title={show ? t("annotations.reader.hideMarks") : t("annotations.reader.showMarks")} aria-label={show ? t("annotations.reader.hideMarks") : t("annotations.reader.showMarks")} onClick={onToggleShow}>
        {show ? <MessageSquareText className="h-4 w-4" aria-hidden="true" /> : <MessageSquareOff className="h-4 w-4" aria-hidden="true" />}
      </Button>
    </>
  );

  const tooltipItems = tooltip ? tooltip.ids.map((id) => byId.get(id)).filter((item): item is LocatedAnnotation => Boolean(item)) : [];
  const panelItems = panel ? located
    .filter((item) => item.annotation.chapter === panel.chapter && (!panel.paragraph || item.match.paragraph === panel.paragraph || item.annotation.paragraph === panel.paragraph))
    .sort((left, right) => sceneOrder(scenes, left) - sceneOrder(scenes, right) || listPosition(left.annotation, left.match) - listPosition(right.annotation, right.match)) : [];
  const panelChapterTitle = panel ? scenes?.find((scene) => scene.chapterSlug === panel.chapter)?.chapterTitle ?? panel.chapter : "";

  const overlays = (
    <>
      {coarse && selection && !annotateRequest && !editTargets && typeof document !== "undefined" && createPortal(
        <SelectionToolbar selection={selection} onAnnotate={() => openAnnotate(selection)} />,
        document.body,
      )}
      {tooltip && tooltipItems.length > 0 && typeof document !== "undefined" && createPortal(
        <div
          role="tooltip"
          className="fixed z-[110] max-w-xs rounded-lg border border-layer bg-popover p-3 text-sm text-popover-foreground shadow-xl"
          style={tooltipPosition(tooltip.rect)}
          onMouseEnter={() => { tooltipHover.current = true; }}
          onMouseLeave={() => { tooltipHover.current = false; setTooltip(null); }}
        >
          {tooltipItems.map((item) => (
            <div key={item.annotation.id} className="space-y-1 [&+&]:mt-2 [&+&]:border-t [&+&]:pt-2">
              <TagLabel tag={item.tag} />
              <p className="whitespace-pre-wrap break-words">{item.annotation.comment || <span className="text-muted-foreground">{t("annotations.mark.noNote")}</span>}</p>
              <p className="text-xs text-muted-foreground">{t(`annotations.status.${annotationStatus(item.annotation.status)}`)}</p>
              <AnchorNotice state={item.match.state} compact className="text-xs" />
            </div>
          ))}
        </div>,
        document.body,
      )}
      <AnnotateDialog
        request={annotateRequest}
        catalog={data.catalog}
        onClose={() => setAnnotateRequest(null)}
        onSave={async ({ tagId, note }) => (annotateRequest ? annotate(annotateRequest.selection, tagId, note) : false)}
        onCreateTag={createBookTag}
      />
      <AnnotationEditorDialog targets={editTargets} catalog={data.catalog} onClose={() => setEditTargets(null)} onSave={update} onDelete={remove} />
      <Dialog open={Boolean(panel)} onOpenChange={(open) => { if (!open) setPanel(null); }}>
        <DialogContent className="z-[120] max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("annotations.reader.panelTitle", { chapter: panelChapterTitle })}</DialogTitle>
            <DialogDescription>{t("annotations.reader.panelDescription")}</DialogDescription>
          </DialogHeader>
          {panelItems.length === 0 ? (
            <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">{t("annotations.reader.panelEmpty")}</p>
          ) : (
            <ul className="space-y-3">
              {panelItems.map((item) => (
                <li key={item.annotation.id} className="space-y-2 rounded-xl border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <TagLabel tag={item.tag} />
                    <span className="text-xs text-muted-foreground">{t(`annotations.status.${annotationStatus(item.annotation.status)}`)}</span>
                  </div>
                  <blockquote className="line-clamp-3 border-l-2 border-primary/40 pl-2 font-serif text-sm">{item.annotation.quote}</blockquote>
                  {item.annotation.comment && <p className="whitespace-pre-wrap break-words text-sm">{item.annotation.comment}</p>}
                  <AnchorNotice state={item.match.state} className="text-xs" />
                  <div className="flex flex-wrap gap-2">
                    {item.match.state !== "orphaned" && (
                      <Button size="sm" variant="outline" className="[@media(pointer:coarse)]:h-11" onClick={() => { setPanel(null); window.setTimeout(() => showAnnotation(item.annotation.id), 0); }}>{t("annotations.reader.show")}</Button>
                    )}
                    <Button size="sm" variant="outline" className="[@media(pointer:coarse)]:h-11" onClick={() => { setPanel(null); edit([item.annotation.id]); }}>{t("annotations.edit.action")}</Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {panel && (
            <Button asChild variant="link" className="justify-start px-0">
              <Link to={`/app/books/${bookId}/chapters/${panel.chapter}/annotations${panel.paragraph ? `?scene=${encodeURIComponent(panel.paragraph)}` : ""}`}>{t("annotations.reader.openList")}</Link>
            </Button>
          )}
        </DialogContent>
      </Dialog>
      {notice.element}
    </>
  );

  return { marked, sceneIndicator, headerControls, overlays, handleClick, annotations: data };
}

function sceneOrder(scenes: readonly ReaderScene[] | null, item: LocatedAnnotation): number {
  const index = scenes?.findIndex((scene) => scene.chapterSlug === item.annotation.chapter && scene.paragraphSlug === item.match.paragraph) ?? -1;
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function tooltipPosition(rect: DOMRect): React.CSSProperties {
  const width = 320;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const below = rect.bottom + 8;
  return below + 140 > window.innerHeight ? { left, bottom: Math.max(8, window.innerHeight - rect.top + 8) } : { left, top: below };
}

/**
 * The toolbar of a selection on a touch screen: under the selection (the browser's own menu is above it), two 44 px buttons: Annotate and the other
 * actions on the text (the menu of the app).
 */
function SelectionToolbar({ selection, onAnnotate }: { selection: ReaderSelection; onAnnotate: () => void }) {
  const { t } = useTranslation();
  const rects = Array.from(selection.range.getClientRects());
  const last = rects[rects.length - 1] ?? selection.range.getBoundingClientRect();
  const height = 52;
  const width = 220;
  const below = last.bottom + 12;
  const top = below + height > window.innerHeight - 8 ? Math.max(8, (rects[0]?.top ?? last.top) - height - 56) : below;
  const left = Math.max(8, Math.min(last.left + last.width / 2 - width / 2, window.innerWidth - width - 8));
  const openMenu = () => useSelectionMenuStore.getState().openMenu?.(left, top + height, document.body);
  return (
    <div
      role="toolbar"
      aria-label={t("annotations.toolbar.label")}
      className="fixed z-[100] flex items-center gap-1 rounded-full border border-layer bg-popover p-1 text-popover-foreground shadow-xl"
      style={{ left, top }}
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
    >
      <Button type="button" size="sm" className="h-11 rounded-full px-4" onClick={onAnnotate}>
        <Highlighter aria-hidden="true" />{t("annotations.toolbar.annotate")}
      </Button>
      <Button type="button" size="icon" variant="ghost" className="h-11 w-11 rounded-full" aria-label={t("annotations.toolbar.more")} onClick={openMenu}>
        <MoreHorizontal aria-hidden="true" />
      </Button>
    </div>
  );
}
