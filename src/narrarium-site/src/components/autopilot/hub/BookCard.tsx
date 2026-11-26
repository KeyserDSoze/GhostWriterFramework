import { memo, useId } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Circle, CircleHelp, ClipboardCheck, Clapperboard, FileWarning, Loader2, Pause, Plane, Play, RefreshCcw, RotateCw, XCircle } from "lucide-react";
import type { AutopilotActivity } from "narrarium-engine";
import { Button } from "@/components/ui/button";
import { QuickCommands } from "@/components/autopilot/QuickCommands";
import { ProfileProblemsNotice, RunErrorNotice } from "@/components/autopilot/StopNotices";
import { CampaignChip, FrozenChangesChip, HostChip, ModelAnswering, ProgressBar } from "@/components/autopilot/band/parts";
import { LastDone } from "@/components/autopilot/live/LastDone";
import { StreamLines } from "@/components/autopilot/live/StreamLines";
import { ProgressRing } from "@/components/autopilot/hub/ProgressRing";
import { budgetUse } from "@/autopilot/bandModel";
import { isErrorKind } from "@/autopilot/errorModel";
import { activityTitle, formatAgo, formatCost, formatCount } from "@/autopilot/format";
import { useBookAutopilotView, useNow } from "@/autopilot/hooks";
import { chapterProgress, hubState, lastStep, lastVote, type HubState } from "@/autopilot/hubModel";
import { loadAutopilotRuntime } from "@/autopilot/loader";
import { autopilotLiveHref, autopilotSettingsHref } from "@/autopilot/pageRoute";
import { useAutopilotStore } from "@/autopilot/store";
import { useAutopilotControl } from "@/autopilot/useAutopilotControl";
import { useTextDetail } from "@/autopilot/useLiveText";
import { useMoney } from "@/costs/useMoney";
import type { BookEntry } from "@/types/settings";
import { cn } from "@/lib/utils";

const STATE_ICON: Record<HubState, typeof Circle> = {
  new: Circle,
  running: Loader2,
  retrying: RotateCw,
  paused: Pause,
  plan: ClipboardCheck,
  question: CircleHelp,
  profiles: FileWarning,
  error: XCircle,
  completed: CheckCircle2,
};

/** The colours of the states only help: every state has its words and its icon. The text is on `-800` (light) and `-300` (dark), as the band's. */
const STATE_STYLE: Record<HubState, string> = {
  new: "bg-muted text-foreground",
  running: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  retrying: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  paused: "bg-sky-500/15 text-sky-800 dark:text-sky-300",
  plan: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  question: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  profiles: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  error: "bg-red-500/15 text-red-800 dark:text-red-300",
  completed: "bg-primary/15 text-foreground",
};

/** The state of the book's autopilot, in words with an icon. The icon of a run spins only for whoever does not ask for less motion. */
export function HubStatus({ state }: { state: HubState }) {
  const { t } = useTranslation();
  const Icon = STATE_ICON[state];
  return (
    <span data-hub-state={state} className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm font-semibold", STATE_STYLE[state])}>
      <Icon className={cn("h-4 w-4 shrink-0", state === "running" && "motion-safe:animate-spin")} aria-hidden="true" />
      {t(`autopilot.hub.state.${state}`)}
    </span>
  );
}

/** The step and when it ended («… · 4 minutes ago»), kept fresh once a minute by this leaf: the card is not drawn again for it. */
function StepLine({ step }: { step: { activity: AutopilotActivity; now: boolean; at: string } }) {
  const { t } = useTranslation();
  const now = useNow(60_000, !step.now);
  const title = activityTitle(t, step.activity);
  if (step.now) return <>{t("autopilot.hub.now", { step: title })}</>;
  const time = Date.parse(step.at);
  return <>{Number.isFinite(time) ? t("autopilot.hub.ago", { step: title, ago: formatAgo(Math.max(0, now - time)) }) : title}</>;
}

const NO_ACTIVITIES: AutopilotActivity[] = [];

/**
 * The card of one book on the page of every book: its title; how far it is, as a ring beside the words; the state of its autopilot in words with
 * an icon; the step that runs, with the last lines of what it is writing, and the last steps that are over, each a way to it on the book's page
 * (with «Show the text» off, the last step and when); the director's last vote (and the readers'); what it cost against its budget; and the actions that are right
 * for the state, which are the quick commands of the book's own page (the same rules, the same checks, through the same runtime). It reads only
 * what the app already read of the book (the saved state, the summary of the last event, the log of the steps), each part from the store by
 * itself, so that the text a run streams draws again only its own card.
 */
export const BookCard = memo(function BookCard({ book }: { book: BookEntry }) {
  const { t } = useTranslation();
  const titleId = useId();
  const view = useBookAutopilotView(book.id);
  const control = useAutopilotControl(book.id);
  const runningStep = useAutopilotStore((store) => store.live[book.id]?.activity ?? null);
  const money = useMoney();
  const summary = control.summary;
  const state = view.snapshot?.state ?? null;
  const pending = !view.snapshot && !view.error;
  const failed = !view.snapshot && Boolean(view.error);
  const hub = hubState(summary, state);
  const progress = chapterProgress(summary);
  const vote = lastVote(state);
  const step = lastStep(view.snapshot?.activities ?? NO_ACTIVITIES, runningStep, hub === "running" || hub === "retrying");
  const host = book.autopilotHost === "server" ? "server" : "browser";
  const named = (label: string) => t("autopilot.quick.named", { label, context: book.name });
  const liveHref = autopilotLiveHref(book.id);
  const currency = summary?.stats.currency ?? money.display;
  const use = summary ? budgetUse(summary.stats, state?.options) : null;
  const error = summary?.status === "error" ? summary.lastError : null;
  // With «Show the text» the card says what the step is writing and the last steps that are over, which take the place of the last step and when.
  const [detail] = useTextDetail();
  const text = detail === "full" && Boolean(summary);
  const stepRow = step && (step.now || !text);

  return (
    <article aria-labelledby={titleId} aria-busy={pending || undefined} data-hub-book={book.id} className="flex h-full flex-col gap-3 rounded-2xl border border-layer bg-card p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <ProgressRing ratio={progress?.ratio ?? null} />
        <div className="min-w-0 flex-1 space-y-1.5">
          <h3 id={titleId} className="break-words font-serif text-lg font-semibold leading-snug">{book.name}</h3>
          <p className="text-sm text-muted-foreground">{progress ? t("autopilot.hub.progress.chapters", { done: progress.done, count: progress.total }) : t("autopilot.hub.progress.noPlan")}</p>
          {!pending && !failed && (
            <div className="flex flex-wrap items-center gap-2">
              <HubStatus state={hub} />
              <FrozenChangesChip count={summary?.frozenChanges} />
              <CampaignChip campaign={summary?.campaign} />
              <HostChip host={host} />
            </div>
          )}
        </div>
      </div>

      {pending && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 shrink-0 motion-safe:animate-spin" aria-hidden="true" />{t("autopilot.hub.loading")}
        </p>
      )}

      {failed && (
        <div className="space-y-2 text-sm">
          <p className="font-medium">{t("autopilot.hub.failed")}</p>
          <p className="break-words text-xs text-muted-foreground">{view.error}</p>
          <Button size="sm" variant="outline" className="min-h-11 sm:min-h-9" aria-label={named(t("autopilot.hub.retry"))} onClick={() => void loadAutopilotRuntime().then((runtime) => runtime.refresh(book.id)).catch(() => undefined)}>
            <RefreshCcw className="h-4 w-4" aria-hidden="true" />{t("autopilot.hub.retry")}
          </Button>
        </div>
      )}

      {view.snapshot && !state && <p className="text-sm text-muted-foreground">{t("autopilot.hub.neverStarted")}</p>}

      {summary && (stepRow || vote || use) && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          {stepRow && (
            <>
              <dt className="text-muted-foreground">{t("autopilot.hub.lastStep")}</dt>
              <dd className="min-w-0 break-words"><StepLine step={step} /></dd>
            </>
          )}
          {vote && (
            <>
              <dt className="text-muted-foreground">{t("autopilot.hub.vote")}</dt>
              <dd className="min-w-0 tabular-nums">
                {vote.kind === "book"
                  ? t("autopilot.hub.voteBook", { score: formatCount(vote.director) })
                  : [t("autopilot.hub.voteChapter", { score: formatCount(vote.director), number: vote.number }), vote.readers !== null ? t("autopilot.hub.voteReaders", { score: formatCount(vote.readers) }) : null].filter(Boolean).join(" · ")}
              </dd>
            </>
          )}
          {use && (
            <>
              <dt className="text-muted-foreground">{t("autopilot.hub.cost")}</dt>
              <dd className="min-w-0 space-y-1">
                <span className="tabular-nums">
                  {use.cost.limit !== null
                    ? t("autopilot.hub.costOf", { value: formatCost(use.cost.value, currency), budget: formatCost(use.cost.limit, currency) })
                    : use.tokens.limit !== null
                      ? formatCost(use.cost.value, currency)
                      : t("autopilot.hub.costFree", { value: formatCost(use.cost.value, currency) })}
                  {use.tokens.limit !== null && ` · ${t("autopilot.hub.tokensOf", { value: formatCount(use.tokens.value), budget: formatCount(use.tokens.limit) })}`}
                </span>
                {use.cost.limit !== null && (
                  <ProgressBar
                    label={t("autopilot.hub.budgetBar")}
                    name={named(t("autopilot.hub.budgetBar"))}
                    now={use.cost.value}
                    max={use.cost.limit}
                    valueText={t("autopilot.hub.costOf", { value: formatCost(use.cost.value, currency), budget: formatCost(use.cost.limit, currency) })}
                    className="max-w-48"
                    thin
                  />
                )}
              </dd>
            </>
          )}
        </dl>
      )}

      {text && runningStep && (
        <div className="space-y-1">
          <StreamLines bookId={book.id} />
          <ModelAnswering bookId={book.id} short />
        </div>
      )}
      {text && <LastDone bookId={book.id} />}

      {hub === "profiles" && <ProfileProblemsNotice bookId={book.id} message={summary?.message} compact />}
      {error && <RunErrorNotice bookId={book.id} message={error.message} kind={isErrorKind(error.kind ?? error.errorKind) ? error.kind ?? error.errorKind : undefined} />}

      <div className="mt-auto space-y-2">
        {summary && <QuickCommands bookId={book.id} variant="hub" heading={null} framed={false} />}
        <div className="flex flex-wrap gap-2">
          {view.snapshot && !state && (
            <Button asChild size="sm" className="min-h-11 sm:min-h-9">
              <Link to={autopilotSettingsHref(book.id)} aria-label={named(t("autopilot.hub.start"))}><Play className="h-4 w-4" aria-hidden="true" />{t("autopilot.hub.start")}</Link>
            </Button>
          )}
          {state && (
            <Button asChild size="sm" variant="outline" className="min-h-11 sm:min-h-9">
              <Link to={liveHref} aria-label={named(t("autopilot.hub.openLive"))}><Plane className="h-4 w-4" aria-hidden="true" />{t("autopilot.hub.openLive")}</Link>
            </Button>
          )}
          <Button asChild size="sm" variant="ghost" className="min-h-11 sm:min-h-9">
            <Link to={`/app/books/${encodeURIComponent(book.id)}/director`} aria-label={named(t("director.title"))}><Clapperboard className="h-4 w-4" aria-hidden="true" />{t("director.title")}</Link>
          </Button>
        </div>
      </div>
    </article>
  );
});
