import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { BookOpen, ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";
import type { AutopilotState, PlannedChapter } from "narrarium-engine";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Rounds } from "@/components/autopilot/map/ChapterRounds";
import { arrowStep, chapterNeighbours, FIRST_SCENES, moreScenes, sceneNumber, sceneTitle } from "@/autopilot/chapterReading";
import { useChapterScenes, type SceneFile } from "@/autopilot/chapterText";
import { voteText } from "@/autopilot/format";
import { chapterScores, type ChapterScore } from "@/autopilot/resultModel";
import { readerSceneHtml, splitMarkdown } from "@/narrarium/readerText";
import { useSettingsStore } from "@/store/settingsStore";
import { cn } from "@/lib/utils";
import type { BookEntry, ReaderSettings } from "@/types/settings";

const NO_CHAPTERS: readonly PlannedChapter[] = [];

/** The faces the reader of the app offers, so that a chapter is read here as it is read there. */
const FONT_FAMILIES: Record<ReaderSettings["fontFamily"], string> = {
  serif: "Georgia, 'Times New Roman', Times, serif",
  sans: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
};

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** A condition that has lasted `ms`: a short wait shows nothing, so that a chapter read at once does not flash a message. */
function useAfter(waiting: boolean, ms: number): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!waiting) {
      setLate(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setLate(true), ms);
    return () => window.clearTimeout(timer);
  }, [waiting, ms]);
  return waiting && late;
}

/** A scene as the reader shows it: its title, from its frontmatter or its file name, and its text as the reader's rules make it HTML (no images, no links to the canon). */
function sceneView(scene: SceneFile, lineBreaks: ReaderSettings["lineBreakMode"]): { title: string | null; html: string } {
  return { title: sceneTitle(scene.path, splitMarkdown(scene.text).frontmatterRecord.title), html: readerSceneHtml(scene.text, scene.path, lineBreaks) };
}

function Scene({ scene, index, id, lineBreaks }: { scene: SceneFile; index: number; id: string; lineBreaks: ReaderSettings["lineBreakMode"] }) {
  const { t } = useTranslation();
  const view = useMemo(() => sceneView(scene, lineBreaks), [scene, lineBreaks]);
  const number = sceneNumber(scene.path) ?? index + 1;
  return (
    <section aria-labelledby={id} data-reading-scene={scene.path} className={cn("space-y-3", index > 0 && "border-t border-layer pt-6")}>
      <h3 id={id} tabIndex={-1} className={cn("rounded-sm text-xs font-semibold uppercase tracking-wide text-muted-foreground", focusRing)}>
        {view.title ? t("autopilot.result.reading.sceneTitled", { number, title: view.title }) : t("autopilot.result.reading.scene", { number })}
      </h3>
      <div className="doc-prose reader-prose [overflow-wrap:anywhere]" dangerouslySetInnerHTML={{ __html: view.html }} />
    </section>
  );
}

/**
 * The scenes of the chapter, as many as have been asked for: the first few, and then more each time the reader comes near the end of what is drawn (when the browser says so) or presses
 * the button, which is always there for the keyboard and for a screen reader. A long chapter is drawn as it is read, never all at once. The button gives the focus to the first scene it
 * adds, so that the reading goes on from there.
 */
function ReadingScenes({ scenes, root, lineBreaks }: { scenes: readonly SceneFile[]; root: HTMLElement | null; lineBreaks: ReaderSettings["lineBreakMode"] }) {
  const { t } = useTranslation();
  const base = useId();
  const [shown, setShown] = useState(FIRST_SCENES);
  const sentinel = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const focusScene = useRef<number | null>(null);
  const count = Math.min(shown, scenes.length);
  const left = scenes.length - count;

  const more = useCallback((focusNew: boolean) => {
    if (focusNew) focusScene.current = count;
    setShown(moreScenes(count, scenes.length));
  }, [count, scenes.length]);

  useEffect(() => {
    if (focusScene.current === null) return;
    const target = document.getElementById(`${base}-scene-${focusScene.current}`);
    focusScene.current = null;
    target?.focus();
  }, [count, base]);

  useEffect(() => {
    const target = sentinel.current;
    if (left <= 0 || !target || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) more(document.activeElement === button.current);
    }, { root, rootMargin: "0px 0px 600px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [left, root, more]);

  return (
    <div className="space-y-6">
      {scenes.slice(0, count).map((scene, index) => <Scene key={scene.path} scene={scene} index={index} id={`${base}-scene-${index}`} lineBreaks={lineBreaks} />)}
      {left > 0 ? (
        <div ref={sentinel} className="flex justify-center">
          <Button ref={button} type="button" variant="outline" className="min-h-11" data-reading-more="" onClick={() => more(true)}>{t("autopilot.result.reading.more", { count: left })}</Button>
        </div>
      ) : (
        <p data-reading-end="" className="border-t border-layer pt-4 text-center text-xs text-muted-foreground">{t("autopilot.result.reading.end")}</p>
      )}
    </div>
  );
}

/**
 * What the director and the readers said of the chapter: its final score, the readers' average (with when they read it: the chapter as it is now, or before its last corrections, and in
 * which round) and the rounds of its review, as the map's panel tells them. Numbers only: nothing the director or the readers wrote about the story is in the window.
 */
function ChapterVotes({ chapter, score }: { chapter: PlannedChapter; score: ChapterScore | null }) {
  const { t } = useTranslation();
  const reading = score?.readersReading;
  const when = reading
    ? t(reading.current ? (reading.round !== undefined ? "autopilot.result.scores.readersNowRound" : "autopilot.result.scores.readersNow") : (reading.round !== undefined ? "autopilot.result.scores.readersBeforeRound" : "autopilot.result.scores.readersBefore"), { round: reading.round })
    : null;
  const rounds = chapter.rounds ?? [];
  const hasVotes = score !== null && (score.final !== null || score.readers !== null);
  return (
    <div className="space-y-4">
      {hasVotes ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 lg:grid-cols-1">
          {score.final !== null && (
            <div>
              <dt className="text-xs text-muted-foreground">{t("autopilot.result.reading.votes.final")}</dt>
              <dd data-reading-final="" className="font-serif text-2xl font-semibold tabular-nums">{voteText(score.final)}</dd>
            </div>
          )}
          {score.readers !== null && (
            <div>
              <dt className="text-xs text-muted-foreground">{t("autopilot.result.reading.votes.readers")}</dt>
              <dd data-reading-readers="" className="font-serif text-2xl font-semibold tabular-nums">{voteText(score.readers)}</dd>
              {when && <dd className="text-xs text-muted-foreground">{when}</dd>}
            </div>
          )}
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">{t("autopilot.result.reading.votes.none")}</p>
      )}
      {rounds.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("autopilot.chapterPanel.rounds.title")}</h4>
          <Rounds rounds={rounds} />
        </div>
      )}
    </div>
  );
}

/**
 * A button to the chapter before or after: always in the page's order of tabs (without a chapter to go to it is only marked, not turned off, so that the focus stays on it). On a phone it is
 * its arrow alone, so that the two and the link to the page fit one row; its name, which says the chapter it leads to, is the same.
 */
function StepButton({ target, label, text, icon, onGo }: { target: string | null; label: string; text: string; icon: ReactNode; onGo: (slug: string) => void }) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      aria-label={label}
      aria-disabled={target === null || undefined}
      className={cn("min-h-11 min-w-11 sm:min-h-9 sm:min-w-0", target === null && "cursor-not-allowed opacity-50")}
      onClick={() => {
        if (target !== null) onGo(target);
      }}
    >
      {icon}<span className="hidden sm:inline">{text}</span>
    </Button>
  );
}

export interface ChapterReadingModalProps {
  bookId: string;
  /** The book and its working branch: the scenes are read from its working copy in this browser. */
  book: BookEntry;
  branch: string;
  state: AutopilotState;
  /** The chapters the book has, by their folder: the window goes only among them. */
  linkedSlugs: ReadonlySet<string>;
  /** The folder of the chapter shown. */
  slug: string;
  onNavigate: (slug: string) => void;
  onClose: () => void;
  /** The link that opened the window: the focus goes back to it when the window closes. */
  returnFocusTo?: HTMLElement | null;
  /** The clicks on the links of the window, which take the place of its step in the history (`useBackGestureClose`, held by what shows the window, which is there while it opens and closes). */
  onLinkClick?: (event: MouseEvent<HTMLElement>) => void;
}

/**
 * A chapter of the finished book read in a window over the result, so that it can be read at once and the page is not left: its scenes in order, read-only, in the type of the reader
 * of the app (its face, size, line height and line breaks), drawn as they are read; its votes and the rounds of its review beside the text on a wide screen and above it on a narrow
 * one; the way to its page; the buttons and the arrow keys to the chapter before and after. Escape closes it, and so does the back gesture on a phone (its step in the history is kept by what shows it); the focus goes back to the link.
 * The text is read from the working copy in this browser, one folder of it, and nothing else of the book: no canon, no secret, and the names in the text are plain text.
 */
export default function ChapterReadingModal({ bookId, book, branch, state, linkedSlugs, slug, onNavigate, onClose, returnFocusTo, onLinkClick }: ChapterReadingModalProps) {
  const { t } = useTranslation();
  const chapters = state.plan?.chapters ?? NO_CHAPTERS;
  const chapter = useMemo(() => chapters.find((entry) => entry.slug === slug), [chapters, slug]);
  const around = useMemo(() => chapterNeighbours(chapters, linkedSlugs, slug), [chapters, linkedSlugs, slug]);
  const left = state.options.review?.readersExcluded;
  const score = useMemo(() => (chapter ? chapterScores([chapter], new Set(left))[0] ?? null : null), [chapter, left]);
  const text = useChapterScenes(book, branch, slug, state.version);
  const reader = useSettingsStore((store) => store.settings.reader);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [announced, setAnnounced] = useState(false);
  const [votesOpen, setVotesOpen] = useState(false);
  const votesId = useId();
  const waiting = useAfter(text.status === "loading", 150);

  // A chapter is read from its top.
  useEffect(() => {
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
  }, [slug]);

  // The chapter went from the plan while the window was open: there is nothing to read.
  useEffect(() => {
    if (!chapter) onClose();
  }, [chapter, onClose]);

  const go = useCallback((target: string | null) => {
    if (target === null) return;
    setAnnounced(true);
    onNavigate(target);
  }, [onNavigate]);

  if (!chapter) return null;
  const title = chapter.title.trim() ? t("autopilot.chapterPanel.title", { number: chapter.number, title: chapter.title }) : t("autopilot.chapterPanel.untitled", { number: chapter.number });
  const name = chapter.title.trim() ? `${chapter.number} · ${chapter.title.trim()}` : String(chapter.number);
  const neighbour = (target: string | null) => {
    const entry = chapters.find((candidate) => candidate.slug === target);
    return entry ? (entry.title.trim() ? `${entry.number} · ${entry.title.trim()}` : String(entry.number)) : "";
  };
  const chapterHref = `/app/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(slug)}`;
  const lineBreaks = reader?.lineBreakMode ?? "book";
  const typography = { fontFamily: FONT_FAMILIES[reader?.fontFamily ?? "serif"] ?? FONT_FAMILIES.serif, fontSize: `${Math.min(30, Math.max(15, reader?.fontSize ?? 19))}px`, lineHeight: reader?.lineHeight ?? 1.75 };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const step = arrowStep(event);
    if (step === 0) return;
    event.preventDefault();
    go(step < 0 ? around.previous : around.next);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        bare
        hideCloseButton
        data-chapter-reading=""
        onClickCapture={onLinkClick}
        onKeyDown={onKeyDown}
        onOpenAutoFocus={(event) => {
          // The reading area takes the focus, so that the keys of a page (space, page down) read the chapter at once.
          event.preventDefault();
          scrollerRef.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (returnFocusTo?.isConnected) returnFocusTo.focus();
        }}
        className="inset-0 flex h-dvh w-full flex-col overflow-hidden rounded-none border-0 p-0 sm:inset-auto sm:left-1/2 sm:top-6 sm:h-[calc(100dvh-3rem)] sm:w-[calc(100%-2rem)] sm:max-w-5xl sm:-translate-x-1/2 sm:rounded-2xl sm:border"
      >
        <div className="shrink-0 space-y-2 border-b border-layer px-4 py-3">
          <div className="flex items-start gap-2">
            <DialogTitle className="min-w-0 flex-1 pt-1.5 font-serif text-xl font-semibold leading-snug [overflow-wrap:anywhere]">{title}</DialogTitle>
            <DialogClose asChild>
              <Button type="button" variant="ghost" size="icon" className="h-11 w-11 shrink-0 sm:h-10 sm:w-10" aria-label={t("common.close")}>
                <X className="h-5 w-5" aria-hidden="true" />
              </Button>
            </DialogClose>
          </div>
          <DialogDescription className="text-sm text-muted-foreground max-sm:sr-only">{t("autopilot.result.reading.description", { position: around.position, total: around.total })}</DialogDescription>
          <div className="flex flex-wrap items-center gap-2">
            <StepButton target={around.previous} label={around.previous !== null ? t("autopilot.result.reading.previousLabel", { chapter: neighbour(around.previous) }) : t("autopilot.result.reading.noPrevious")} text={t("autopilot.result.reading.previous")} icon={<ChevronLeft className="h-4 w-4" aria-hidden="true" />} onGo={go} />
            <StepButton target={around.next} label={around.next !== null ? t("autopilot.result.reading.nextLabel", { chapter: neighbour(around.next) }) : t("autopilot.result.reading.noNext")} text={t("autopilot.result.reading.next")} icon={<ChevronRight className="h-4 w-4" aria-hidden="true" />} onGo={go} />
            <Button asChild size="sm" variant="outline" className="min-h-11 sm:min-h-9">
              <Link to={chapterHref} data-reading-open=""><BookOpen className="h-4 w-4" aria-hidden="true" />{t("autopilot.result.reading.open")}</Link>
            </Button>
          </div>
        </div>
        <p role="status" data-reading-announce="" className="sr-only">{announced ? t("autopilot.result.reading.announce", { position: around.position, total: around.total, chapter: name }) : ""}</p>
        <div
          ref={(node) => {
            scrollerRef.current = node;
            setScroller(node);
          }}
          role="region"
          aria-label={title}
          tabIndex={0}
          className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain focus-visible:ring-inset", focusRing)}
        >
          <div className="grid gap-6 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <aside aria-label={t("autopilot.result.reading.votes.title")} className="min-w-0 space-y-3 lg:col-start-2 lg:row-start-1">
              <button type="button" aria-expanded={votesOpen} aria-controls={votesId} onClick={() => setVotesOpen((value) => !value)} className={cn("inline-flex min-h-11 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted lg:hidden", focusRing)}>
                {votesOpen ? t("autopilot.result.reading.votes.hide") : t("autopilot.result.reading.votes.show")}
              </button>
              <div id={votesId} className={cn(votesOpen ? "block" : "hidden lg:block")}>
                <h3 className="mb-3 hidden text-xs font-semibold uppercase tracking-wide text-muted-foreground lg:block">{t("autopilot.result.reading.votes.title")}</h3>
                <ChapterVotes chapter={chapter} score={score} />
              </div>
            </aside>
            <article aria-label={t("autopilot.result.reading.text")} aria-busy={text.status === "loading"} data-reading-text="" style={typography} className="mx-auto w-full min-w-0 max-w-prose lg:col-start-1 lg:row-start-1">
              {text.status === "loading" && waiting && (
                <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />{t("autopilot.result.reading.loading")}</p>
              )}
              {text.status === "failed" && <p role="alert" className="text-sm text-muted-foreground">{text.missing ? t("autopilot.result.reading.missing") : t("autopilot.result.reading.failed")}</p>}
              {text.status === "ready" && text.scenes.length === 0 && <p className="text-sm text-muted-foreground">{t("autopilot.result.reading.empty")}</p>}
              {text.status === "ready" && text.scenes.length > 0 && <ReadingScenes key={slug} scenes={text.scenes} root={scroller} lineBreaks={lineBreaks} />}
            </article>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
