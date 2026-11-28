import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { BookOpen, Check, Clock, FileText, MessageCircle, SkipForward, Sparkles, X } from "lucide-react";
import "@/i18n/annotationsPage";
import { Button } from "@/components/ui/button";
import { TagLabel } from "@/components/annotations/TagLabel";
import { resolveTag, type Annotation, type AnnotationStatus, type ResolvedTag } from "@/annotations/model";
import type { NoteItem } from "@/annotations/notesView";
import { loadPassed, savePassed, swipeAction, triageActionOfKey, triageQueue, type TriageAction } from "@/annotations/triage";
import { cn } from "@/lib/utils";

const BUTTON = "[@media(pointer:coarse)]:h-11";

/** True when the key press is meant for something else: a field being typed in, or a window (a dialog, a menu) that is open on top of the triage. */
function pressBelongsElsewhere(event: KeyboardEvent): boolean {
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))) return true;
  return document.querySelector('[role="dialog"],[role="alertdialog"],[role="menu"]') !== null;
}

/**
 * The triage of the notes: ONE note at a time, so that a long list is cleared without scrolling. For each: handled, later, dismiss, fix it with the AI, think
 * about it with the AI, open its paragraph, or skip it for now; every action has a button and a key (H, L, D, F, R, P, S), and on a touch screen a swipe
 * (right: handled, left: later) as an extra. It tells a screen reader what happened and how many are left, keeps the focus on the next note, and resumes:
 * what was decided is in the notes themselves and the notes skipped are kept on this device.
 */
export function TriageFlow({ bookId, items, catalog, chapter, onStatus, onFix, onReason, onExit }: {
  bookId: string;
  items: readonly NoteItem[];
  catalog: readonly ResolvedTag[];
  /** Only the notes of this chapter, or all of them. */
  chapter: string;
  onStatus: (annotation: Annotation, status: AnnotationStatus) => Promise<void>;
  onFix: (annotation: Annotation) => void;
  onReason: (annotation: Annotation) => void;
  onExit: () => void;
}) {
  const { t } = useTranslation();
  const [passed, setPassed] = useState<ReadonlySet<string>>(() => loadPassed(typeof localStorage === "undefined" ? undefined : localStorage, bookId));
  const [announcement, setAnnouncement] = useState("");
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const total = useRef<number | null>(null);

  const queue = useMemo(() => triageQueue(items, passed, chapter), [items, passed, chapter]);
  const current = queue[0];
  if (total.current === null && items.length) total.current = queue.length;
  const size = Math.max(total.current ?? 0, queue.length);
  const position = Math.min(size, size - queue.length + 1);
  const later = items.filter((item) => item.annotation.status === "later" && (!chapter || item.annotation.chapter === chapter)).length;

  const remember = useCallback((next: ReadonlySet<string>) => {
    setPassed(next);
    savePassed(typeof localStorage === "undefined" ? undefined : localStorage, bookId, next);
  }, [bookId]);

  useEffect(() => { heading.current?.focus({ preventScroll: false }); }, [current?.annotation.id]);

  const act = useCallback(async (action: TriageAction) => {
    if (!current || busy) return;
    const { annotation } = current;
    if (action === "fix") { onFix(annotation); return; }
    if (action === "reason") { onReason(annotation); return; }
    if (action === "paragraph") {
      const link = document.querySelector<HTMLAnchorElement>("[data-triage-paragraph]");
      link?.click();
      return;
    }
    if (action === "skip") {
      remember(new Set(passed).add(annotation.id));
      setAnnouncement(t("annotationsPage.triage.skipped", { count: Math.max(0, queue.length - 1) }));
      return;
    }
    setBusy(true);
    try {
      await onStatus(annotation, action);
      setAnnouncement(t("annotationsPage.triage.done", { status: t(`annotations.status.${action}`), count: Math.max(0, queue.length - 1) }));
    } finally {
      setBusy(false);
    }
  }, [busy, current, onFix, onReason, onStatus, passed, queue.length, remember, t]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = triageActionOfKey(event);
      if (!action || pressBelongsElsewhere(event)) return;
      event.preventDefault();
      void act(action);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act]);

  if (!current) {
    return (
      <section aria-labelledby="triage-done" className="space-y-3 rounded-xl border bg-card p-4 sm:p-6" data-triage-done="">
        <h2 id="triage-done" ref={heading} tabIndex={-1} className="text-xl font-semibold focus-visible:outline-none">{t("annotationsPage.triage.allDone")}</h2>
        <p className="text-muted-foreground">{later > 0 ? t("annotationsPage.triage.laterLeft", { count: later }) : t("annotationsPage.triage.nothingLeft")}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={onExit} className={BUTTON}>{t("annotationsPage.triage.backToList")}</Button>
          {passed.size > 0 && <Button type="button" variant="outline" onClick={() => { total.current = null; remember(new Set()); }} className={BUTTON}>{t("annotationsPage.triage.startOver", { count: passed.size })}</Button>}
        </div>
        <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
      </section>
    );
  }

  const { annotation } = current;
  const tag = resolveTag(catalog, annotation.tag, t("annotations.tag.missing"));
  const paragraphHref = current.sceneNumber ? `/app/books/${bookId}/chapters/${annotation.chapter}/paragraphs/${current.sceneNumber}` : undefined;
  const keys: Array<{ action: TriageAction; key: string; icon: typeof Check; label: string; variant: "default" | "outline" | "secondary" | "ghost" }> = [
    { action: "handled", key: "h", icon: Check, label: t("annotationsPage.mark.handled"), variant: "default" },
    { action: "later", key: "l", icon: Clock, label: t("annotationsPage.mark.later"), variant: "outline" },
    { action: "fix", key: "f", icon: Sparkles, label: t("annotationsPage.triage.retry"), variant: "secondary" },
    { action: "reason", key: "r", icon: MessageCircle, label: t("annotationsPage.reasonTogether"), variant: "outline" },
    { action: "dismissed", key: "d", icon: X, label: t("annotationsPage.mark.dismissed"), variant: "outline" },
    { action: "skip", key: "s", icon: SkipForward, label: t("annotationsPage.triage.skip"), variant: "ghost" },
  ];

  return (
    <section aria-labelledby="triage-title" className="space-y-4" data-triage="">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="triage-title" className="text-lg font-semibold">{t("annotationsPage.triage.title")}</h2>
        <Button type="button" size="sm" variant="ghost" onClick={onExit} className={cn("ml-auto", BUTTON)}>{t("annotationsPage.triage.exit")}</Button>
      </div>
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground" data-triage-position="">{t("annotationsPage.triage.position", { position, total: size })}</p>
        <div role="progressbar" aria-label={t("annotationsPage.triage.progress")} aria-valuemin={0} aria-valuemax={size} aria-valuenow={position - 1} aria-valuetext={t("annotationsPage.triage.position", { position, total: size })} className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary transition-[width]" style={{ width: `${size ? ((position - 1) / size) * 100 : 0}%` }} />
        </div>
      </div>

      <article
        className="touch-pan-y space-y-3 rounded-xl border border-layer bg-card p-4 shadow-sm transition-transform sm:p-6"
        style={{ transform: offset ? `translateX(${offset}px)` : undefined }}
        data-triage-note={annotation.id}
        onPointerDown={(event) => { if (event.pointerType === "touch") drag.current = { x: event.clientX, y: event.clientY }; }}
        onPointerMove={(event) => { if (drag.current) setOffset(Math.max(-120, Math.min(120, (event.clientX - drag.current.x) / 2))); }}
        onPointerUp={(event) => {
          const start = drag.current;
          drag.current = null;
          setOffset(0);
          const action = start ? swipeAction(event.clientX - start.x, event.clientY - start.y) : null;
          if (action) void act(action);
        }}
        onPointerCancel={() => { drag.current = null; setOffset(0); }}
      >
        <h3 ref={heading} tabIndex={-1} className="flex flex-wrap items-center gap-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <TagLabel tag={tag} showScope />
          <span className="text-muted-foreground">{current.chapterTitle} · {current.sceneNumber ? `${current.sceneNumber} · ` : ""}{current.sceneTitle}</span>
        </h3>
        <blockquote className="border-l-4 border-primary/40 pl-3 font-serif text-base sm:text-lg">{annotation.quote}</blockquote>
        {annotation.comment && <p className="whitespace-pre-wrap break-words">{annotation.comment}</p>}
      </article>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="group" aria-label={t("annotationsPage.triage.actions")}>
        {keys.map(({ action, key, icon: Icon, label, variant }) => (
          <Button key={action} type="button" variant={variant} disabled={busy} onClick={() => void act(action)} aria-keyshortcuts={key.toUpperCase()} className={cn("justify-start", BUTTON)} data-triage-action={action}>
            <Icon aria-hidden="true" />{label}<kbd className="ml-auto hidden rounded border px-1.5 text-xs text-muted-foreground sm:inline">{key.toUpperCase()}</kbd>
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {paragraphHref && <Button asChild size="sm" variant="outline" className={BUTTON}><Link to={paragraphHref} data-triage-paragraph="" aria-keyshortcuts="P"><FileText aria-hidden="true" />{t("annotationsPage.openParagraph")}<kbd className="ml-2 hidden rounded border px-1.5 text-xs text-muted-foreground sm:inline">P</kbd></Link></Button>}
        <Button asChild size="sm" variant="outline" className={BUTTON}><Link to={`/app/books/${bookId}/reader`} state={{ annotationId: annotation.id }}><BookOpen aria-hidden="true" />{t("annotationsPage.showInReader")}</Link></Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("annotationsPage.triage.hint")}</p>
      <p role="status" aria-live="polite" className="sr-only" data-triage-status="">{announcement}</p>
    </section>
  );
}
