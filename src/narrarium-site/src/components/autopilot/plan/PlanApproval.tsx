import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { BookOpenCheck, CheckCircle2, ClipboardList, Loader2, Play, RotateCcw, Users, XCircle } from "lucide-react";
import { outlineChapterPath, type AutopilotActivity, type AutopilotState, type ReaderReaction } from "narrarium-engine";
import { Button } from "@/components/ui/button";
import { useQuickModel } from "@/components/autopilot/quick/model";
import { useGhostwriterName } from "@/components/autopilot/PlanChapters";
import { ApprovalChapter } from "@/components/autopilot/plan/ApprovalChapter";
import { PlanRestCost } from "@/components/autopilot/plan/PlanRestCost";
import { ChapterWindowControls, useChapterWindow } from "@/components/autopilot/map/ChapterWindow";
import { formatCount } from "@/autopilot/format";
import { castMember, castPaths, changeEffect, outlineOrigins, pendingPlanChanges, planReviews, premiseOf, type OutlineOrigin, type PlanReview, type PlanReviewMode } from "@/autopilot/planApprovalModel";
import { useBookFiles } from "@/autopilot/useBookFiles";
import { cn } from "@/lib/utils";

/** The chapters the screen draws at once: each is open, with its synopsis, its events and its scenes. */
export const APPROVAL_PAGE_SIZE = 20;
const STORY_DESIGN = "story-design.md";
const NO_ORIGINS: ReadonlyMap<number, OutlineOrigin> = new Map();

/** A part of the screen, named by its title (a region a screen reader can go to). */
function Part({ title, icon, children, className }: { title: string; icon: ReactNode; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn("space-y-3", className)}>
      <h3 id={id} className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{icon}{title}</h3>
      {children}
    </section>
  );
}

const VERDICT_ICON = { approve: CheckCircle2, revise: RotateCcw, rewrite: XCircle } as const;
const VERDICT_STYLE = {
  approve: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  revise: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  rewrite: "bg-red-500/15 text-red-800 dark:text-red-300",
} as const;

/** The verdict of a review of the plan in words, with an icon: the colour only helps. */
function Verdict({ verdict }: { verdict: PlanReview["verdict"] }) {
  const { t } = useTranslation();
  const Icon = VERDICT_ICON[verdict];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold", VERDICT_STYLE[verdict])}>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{t(`autopilot.approval.director.verdict.${verdict}`)}
    </span>
  );
}

/** The director's vote on the plan as a score card, and every review of the planning that led to it, oldest first (its words are said once: in the card for a single review, in the list for more). */
function DirectorVote({ reviews }: { reviews: PlanReview[] }) {
  const { t } = useTranslation();
  const last = reviews[reviews.length - 1];
  if (!last) return <p className="text-sm text-muted-foreground">{t("autopilot.approval.director.noVote")}</p>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="flex items-baseline gap-1.5">
          <span data-plan-score className="font-serif text-4xl font-semibold leading-none tabular-nums">{formatCount(last.score)}</span>
          <span className="text-sm text-muted-foreground">{t("autopilot.approval.director.outOf")}</span>
        </p>
        <Verdict verdict={last.verdict} />
      </div>
      {reviews.length === 1 && last.text && <p className="whitespace-pre-line text-sm">{last.text}</p>}
      {reviews.length > 1 && (
        <ol aria-label={t("autopilot.approval.director.reviews")} className="space-y-2 border-l-2 border-layer pl-3">
          {reviews.map((review) => (
            <li key={review.number} className="space-y-1 text-sm">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{t("autopilot.approval.director.review", { number: review.number })}</span>
                <Verdict verdict={review.verdict} />
                <span className="tabular-nums text-muted-foreground">{formatCount(review.score)}/10</span>
              </p>
              {review.text && <p className="text-muted-foreground">{review.text}</p>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** A reader's reaction to the plan as a card: the name, the interest (in figures and as a bar), the reaction, the doubts and the wishes. */
function ReaderCard({ reaction }: { reaction: ReaderReaction }) {
  const { t } = useTranslation();
  const id = useId();
  const list = (title: string, items: string[], key: string) => (items.length ? (
    <div className="space-y-1">
      <h5 id={`${id}-${key}`} className="text-xs font-semibold text-muted-foreground">{title}</h5>
      <ul aria-labelledby={`${id}-${key}`} className="list-disc space-y-0.5 pl-5 text-sm">{items.map((item, index) => <li key={index}>{item}</li>)}</ul>
    </div>
  ) : null);
  return (
    <article aria-labelledby={`${id}-name`} className="space-y-2 rounded-xl border border-layer bg-background/60 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 id={`${id}-name`} className="text-sm font-semibold">{reaction.name}</h4>
        <span className="text-xs font-medium tabular-nums">{t("autopilot.approval.readers.interest", { score: reaction.interest })}</span>
      </div>
      <div aria-hidden="true" className="h-1.5 w-full rounded-full bg-muted ring-1 ring-inset ring-border">
        <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(0, Math.min(10, reaction.interest)) * 10}%` }} />
      </div>
      {reaction.reaction && <p className="text-sm">{reaction.reaction}</p>}
      {list(t("autopilot.approval.readers.concerns"), reaction.concerns, "concerns")}
      {list(t("autopilot.approval.readers.wishes"), reaction.wishes, "wishes")}
    </article>
  );
}

export interface PlanApprovalProps {
  bookId: string;
  mode: PlanReviewMode;
  state: AutopilotState;
  activities: readonly AutopilotActivity[];
}

/**
 * The approval of the plan, in place of the history while the plan waits for the author: the idea, the logline and the premise of the book, the cast
 * the autopilot created, the director's vote on the plan with its reviews, the readers' reactions as cards, and every chapter open, with the way to
 * ask for a change of each. It ends with the action that approves the plan (the band has it at the top, and on a phone the bar at the bottom), or,
 * once changes were asked, with the one that makes the plan again with them.
 *
 * What it shows is in the saved state and the log of the steps; the premise, the cast and who wrote the entries of the outline are read from the
 * few files that hold them (never the whole book).
 */
export const PlanApproval = memo(function PlanApproval({ bookId, mode, state, activities }: PlanApprovalProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const plan = state.plan!;
  const chapters = plan.chapters;
  const model = useQuickModel(bookId, "page");
  const ghostwriterName = useGhostwriterName(bookId);
  const reviews = useMemo(() => planReviews(activities), [activities]);
  const cast = useMemo(() => castPaths(activities), [activities]);
  // Whether the history still has the concept: without it, who the autopilot created cannot be told, and the cast is not shown.
  const conceptKnown = useMemo(() => activities.some((activity) => activity.task === "concept" && activity.status === "succeeded"), [activities]);
  const effect = useMemo(() => changeEffect(plan), [plan]);
  const changes = pendingPlanChanges(plan);

  // The chapters on the screen, a window of them for a long plan.
  const view = useChapterWindow(chapters, APPROVAL_PAGE_SIZE, 0);
  const [closedMode, setClosedMode] = useState(false);
  const [toggled, setToggled] = useState<ReadonlySet<number>>(() => new Set());
  const isOpen = useCallback((number: number) => closedMode === toggled.has(number), [closedMode, toggled]);
  const toggle = useCallback((number: number) => setToggled((current) => {
    const next = new Set(current);
    if (!next.delete(number)) next.add(number);
    return next;
  }), []);
  const anyOpen = view.visible.some((index) => isOpen(chapters[index].number));
  const setAll = (open: boolean) => {
    setClosedMode(!open);
    setToggled(new Set());
  };

  // The few files the screen reads: the story design, the characters the concept created, the entries of the outline of the chapters on the screen.
  const outlinePaths = useMemo(() => view.visible.map((index) => outlineChapterPath(chapters[index].number)), [view.visible, chapters]);
  const paths = useMemo(() => [STORY_DESIGN, ...cast, ...outlinePaths], [cast, outlinePaths]);
  const { files } = useBookFiles(bookId, paths, state.version);
  const premise = useMemo(() => premiseOf(files?.get(STORY_DESIGN)), [files]);
  const members = useMemo(() => (files ? cast.map((path) => castMember(path, files.get(path))) : []), [files, cast]);
  const [origins, setOrigins] = useState<ReadonlyMap<number, OutlineOrigin>>(NO_ORIGINS);
  useEffect(() => {
    if (!files) return undefined;
    let current = true;
    const entries = outlinePaths.flatMap((path) => {
      const content = files.get(path);
      return content === undefined ? [] : [{ path, content }];
    });
    void outlineOrigins(entries).then((found) => {
      if (current) setOrigins(found);
    }).catch(() => undefined);
    return () => {
      current = false;
    };
  }, [files, outlinePaths]);

  // What was asked is said once, where a screen reader hears it.
  const [sent, setSent] = useState<number | null>(null);
  const onSent = useCallback((number: number) => setSent(number), []);

  // A jump to a chapter takes the focus to its title once it is on the screen.
  const listRef = useRef<HTMLOListElement>(null);
  const [focusNumber, setFocusNumber] = useState<number | null>(null);
  useEffect(() => {
    if (focusNumber === null) return;
    listRef.current?.querySelector<HTMLElement>(`[data-plan-approval-chapter="${focusNumber}"] h4`)?.focus();
    setFocusNumber(null);
  }, [focusNumber, view.visible]);

  const reviewed = reviews[reviews.length - 1];
  const lead = mode === "revise"
    ? t("autopilot.approval.reviseLead")
    : !reviewed
      ? t("autopilot.approval.lead")
      : plan.rounds > 0
        ? t("autopilot.approval.leadVoteRounds", { score: formatCount(reviewed.score), count: plan.rounds })
        : t("autopilot.approval.leadVote", { score: formatCount(reviewed.score) });
  const acting = model?.acting ?? false;
  const blocked = acting || Boolean(model?.noAi);
  const goOn = () => void model?.commands.resume();
  const starting = model?.busy === "start";

  return (
    <section data-plan-approval aria-labelledby={titleId} className="space-y-6 rounded-2xl border border-layer bg-card p-4 shadow-sm sm:p-5">
      <header className="space-y-3">
        <h2 id={titleId} className="flex items-center gap-2 font-serif text-2xl font-semibold tracking-tight">
          <BookOpenCheck className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />{t(mode === "revise" ? "autopilot.approval.reviseTitle" : "autopilot.approval.title")}
        </h2>
        <p className="max-w-3xl text-sm">{lead}</p>
        {mode === "revise" && (
          <div className="space-y-3">
            <ul aria-label={t("autopilot.approval.changes")} className="list-disc space-y-1 pl-5 text-sm">
              {changes.map((change, index) => <li key={index} className="break-words">{change}</li>)}
            </ul>
            <Button className="min-h-11 sm:min-h-10" disabled={blocked} onClick={goOn}>
              {starting ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}{t("autopilot.approval.reviseAction")}
            </Button>
          </div>
        )}
        <p role="status" className="text-sm font-medium text-emerald-800 dark:text-emerald-300">{sent !== null ? t("autopilot.approval.change.sent", { number: sent }) : ""}</p>
      </header>

      <Part title={t("autopilot.approval.concept.title")} icon={<ClipboardList className="h-4 w-4" aria-hidden="true" />}>
        <dl className="space-y-2 text-sm">
          {state.brief.idea.trim() && <Fact term={t("autopilot.approval.concept.idea")}>{state.brief.idea}</Fact>}
          {state.concept.logline && <Fact term={t("autopilot.approval.concept.logline")} strong>{state.concept.logline}</Fact>}
          {premise && <Fact term={t("autopilot.approval.concept.premise")}>{premise}</Fact>}
        </dl>
      </Part>

      {conceptKnown && (
        <Part title={t("autopilot.approval.cast.title")} icon={<Users className="h-4 w-4" aria-hidden="true" />}>
          <p className="text-xs text-muted-foreground">{t(cast.length ? "autopilot.approval.cast.hint" : "autopilot.approval.cast.none")}</p>
          {members.length > 0 && (
            <ul className="grid gap-2 sm:grid-cols-2">
              {members.map((member) => (
                <li key={member.path} className="min-w-0 rounded-lg border border-layer bg-background/60 px-3 py-2 text-sm">
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    <Link to={`/app/books/${encodeURIComponent(bookId)}/canon/characters/${encodeURIComponent(member.slug)}`} className="inline-flex min-h-6 items-center font-semibold underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11">{member.name}</Link>
                    {member.role && <span className="text-xs text-muted-foreground">{t(`autopilot.approval.cast.role.${member.role}`)}</span>}
                  </p>
                  {member.line && <p className="break-words text-muted-foreground">{member.line}</p>}
                </li>
              ))}
            </ul>
          )}
        </Part>
      )}

      <Part title={t("autopilot.approval.director.title")} icon={<BookOpenCheck className="h-4 w-4" aria-hidden="true" />}>
        <DirectorVote reviews={reviews} />
      </Part>

      <Part title={t("autopilot.approval.readers.title")} icon={<Users className="h-4 w-4" aria-hidden="true" />}>
        {plan.readerReactions.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2">{plan.readerReactions.map((reaction) => <ReaderCard key={reaction.slug} reaction={reaction} />)}</div>
        ) : (
          <p className="text-sm text-muted-foreground">{t(state.options.readersOnPlan === false ? "autopilot.approval.readers.off" : "autopilot.approval.readers.none")}</p>
        )}
        {plan.skippedReaders?.length ? <p className="text-xs text-muted-foreground">{t("autopilot.approval.readers.skipped", { count: plan.skippedReaders.length, names: plan.skippedReaders.join(", ") })}</p> : null}
      </Part>

      <Part title={t("autopilot.approval.chapters.title")} icon={<ClipboardList className="h-4 w-4" aria-hidden="true" />}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">{t("autopilot.approval.chapters.count", { count: chapters.length })}</p>
          <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-9" onClick={() => setAll(!anyOpen)}>
            {t(anyOpen ? "autopilot.approval.chapters.collapseAll" : "autopilot.approval.chapters.expandAll")}
          </Button>
        </div>
        <ChapterWindowControls window={view} onJumped={(index) => setFocusNumber(chapters[index].number)} />
        <ol ref={listRef} className="space-y-3">
          {view.visible.map((index) => {
            const chapter = chapters[index];
            return (
              <li key={`${chapter.number}:${chapter.slug}`}>
                <ApprovalChapter bookId={bookId} chapter={chapter} open={isOpen(chapter.number)} onToggle={toggle} origin={origins.get(chapter.number)} ghostwriter={chapter.ghostwriter ? ghostwriterName(chapter.ghostwriter) : undefined} effect={effect} onSent={onSent} />
              </li>
            );
          })}
        </ol>
      </Part>

      <footer className="flex flex-wrap items-center gap-3 border-t border-layer pt-4">
        <p className="mr-auto text-sm text-muted-foreground">{t(mode === "revise" ? "autopilot.approval.endRevise" : "autopilot.approval.end")}</p>
        <PlanRestCost bookId={bookId} mode={mode} state={state} activities={activities} />
        {mode === "approve" && (
          <Button className="min-h-11 sm:min-h-10" disabled={blocked} onClick={goOn}>
            {starting ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}{t("autopilot.actions.approvePlan")}
          </Button>
        )}
      </footer>
    </section>
  );
});

function Fact({ term, children, strong = false }: { term: string; children: ReactNode; strong?: boolean }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs font-semibold text-muted-foreground">{term}</dt>
      <dd className={cn("whitespace-pre-line break-words", strong && "font-serif text-base")}>{children}</dd>
    </div>
  );
}
