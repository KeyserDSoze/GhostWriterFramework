import { memo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, ChevronRight, CheckCircle2, Circle, CircleDot, CircleHelp, Laptop, Loader2, Lock, Pause, Server, XCircle } from "lucide-react";
import type { AutopilotActivity, AutopilotOptions, AutopilotStateSummary, AutopilotStatus } from "narrarium-engine";
import { useElapsed, useNow } from "@/autopilot/hooks";
import { CYCLE_STAGES, bandPhases, budgetUse, cycleItems, type ChapterCycle } from "@/autopilot/bandModel";
import { formatCountdown, secondsLeft } from "@/autopilot/errorModel";
import { STATUS_BADGE, activityTitle, formatAgo, formatBytes, formatCost, formatCount, formatDuration } from "@/autopilot/format";
import { waitLineText, type RetryWait } from "@/autopilot/retry";
import { lastSignalAt, useAutopilotStore } from "@/autopilot/store";
import { useTextDetail } from "@/autopilot/useLiveText";
import { StreamLines } from "@/components/autopilot/live/StreamLines";
import { cn } from "@/lib/utils";

const STATUS_ICON: Record<AutopilotStatus, typeof Circle> = {
  idle: Circle,
  running: Loader2,
  paused: Pause,
  "waiting-author": CircleHelp,
  error: XCircle,
  completed: CheckCircle2,
};

/** What the autopilot is, in words with an icon: the icon is only decoration, the colour only helps. */
export function StatusPill({ status }: { status: AutopilotStatus }) {
  const { t } = useTranslation();
  const Icon = STATUS_ICON[status];
  return (
    <span data-band-status className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm font-semibold", STATUS_BADGE[status])}>
      <Icon className={cn("h-4 w-4 shrink-0", status === "running" && "animate-spin")} aria-hidden="true" />
      {t(`autopilot.status.${status}`)}
    </span>
  );
}

/**
 * How many frozen chapters changed and wait for the author (the summary's `frozenChanges`, which the engine counts before every step and when
 * asked): nothing when none does.
 */
export function FrozenChangesChip({ count }: { count: number | undefined }) {
  const { t } = useTranslation();
  if (!count) return null;
  return (
    <span data-frozen-changes className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-800 dark:text-amber-200">
      <Lock className="h-3 w-3 shrink-0" aria-hidden="true" />
      {t("autopilot.frozen.changed", { count })}
    </span>
  );
}

/** Where it runs: this browser or the server; for a run of another device, who runs it, so that the band does not claim the run is its own. */
export function HostChip({ host, runnerLabel }: { host: "browser" | "server"; runnerLabel?: string | null }) {
  const { t } = useTranslation();
  const Icon = host === "server" ? Server : Laptop;
  return (
    <span data-band-host className="inline-flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">{runnerLabel ?? t(`autopilot.host.${host}`)}</span>
    </span>
  );
}

/** How long ago the run was last heard of: the newer of the heartbeat it saved and the last event this tab received. It ticks by itself, so the band does not redraw for it. */
export function SignalAge({ bookId, summary }: { bookId: string; summary: AutopilotStateSummary | null }) {
  const { t } = useTranslation();
  const now = useNow(10_000, true);
  const beat = Date.parse(summary?.runner?.heartbeatAt ?? "");
  const freshest = Math.max(Number.isFinite(beat) ? beat : 0, lastSignalAt(bookId) ?? 0);
  if (!freshest) return null;
  return <span data-band-signal className="text-xs text-muted-foreground">{t("autopilot.control.lastSignal", { age: formatAgo(Math.max(0, now - freshest)) })}</span>;
}

/** How long the step has been going on. A leaf of its own: it ticks every second and nothing around it is drawn again for that. */
function ElapsedTime({ since, className }: { since: string; className?: string }) {
  const elapsed = useElapsed(since);
  return <span data-band-elapsed className={cn("shrink-0 text-xs tabular-nums text-muted-foreground", className)}>{formatDuration(elapsed)}</span>;
}

/** The time of the step that runs, where the band keeps it apart from the title (on a phone it is in the first row). Reads the start of the step from the store by itself. */
export function StepElapsed({ bookId, className }: { bookId: string; className?: string }) {
  const since = useAutopilotStore((state) => state.live[bookId]?.activity?.startedAt ?? null);
  return since ? <ElapsedTime since={since} className={className} /> : null;
}

/** How much of the end of the text that streams the band shows, on one line. The timeline shows the text whole, and only when it has more than this to show. */
export const PREVIEW_CHARACTERS = 120;

/** The end of the text, the words that are being written now, on one line. */
export function previewTail(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= PREVIEW_CHARACTERS) return flat;
  const cut = flat.slice(flat.length - PREVIEW_CHARACTERS);
  const space = cut.indexOf(" ");
  return `…${space > 0 && space < 24 ? cut.slice(space + 1) : cut}`;
}

/**
 * The text that streams, on one line. It follows the store by itself, so the page and the rest of the band are not drawn again for every chunk. Not read out: it is not live.
 * While a step answers with a value (the bytes come in) the tail of a scene that was written before is not what is going on now, and the line of the answer takes its place.
 */
export function PreviewLine({ bookId }: { bookId: string }) {
  const preview = useAutopilotStore((state) => state.live[bookId]?.preview ?? "");
  const answering = useAutopilotStore((state) => state.live[bookId]?.bytes !== undefined);
  const tail = previewTail(preview);
  if (!tail || answering) return null;
  return <p data-band-preview className="truncate font-serif text-xs italic text-muted-foreground">{tail}</p>;
}

/**
 * «The model is answering… (12 KB)», for a step that answers with a value: the bytes of the reply that have arrived, which is all that is known of it (never a word). It follows
 * the store by itself and is never read out: the one status of the row says the step and only the step, and a number that changes every second is not announced.
 */
export function ModelAnswering({ bookId, short = false }: { bookId: string; short?: boolean }) {
  const { t } = useTranslation();
  const bytes = useAutopilotStore((state) => state.live[bookId]?.bytes);
  if (bytes === undefined) return null;
  const size = formatBytes(bytes);
  return <p data-band-progress className="truncate text-xs text-muted-foreground">{short ? t("autopilot.band.answeringShort", { size }) : t("autopilot.band.answering", { size })}</p>;
}

export function whereOf(t: (key: string, options?: Record<string, unknown>) => string, activity: Pick<AutopilotActivity, "chapterNumber" | "sceneNumber">): string | null {
  if (activity.chapterNumber === undefined) return null;
  return activity.sceneNumber === undefined
    ? t("autopilot.band.where.chapter", { chapter: activity.chapterNumber })
    : t("autopilot.band.where.chapterScene", { chapter: activity.chapterNumber, scene: activity.sceneNumber });
}

/**
 * The text that streams, in the row of the step: its last lines (see `StreamLines`), or, with «Show the text» off, the one line of the band as
 * it always was. Neither is read out.
 */
function NowText({ bookId }: { bookId: string }) {
  const [detail] = useTextDetail();
  return detail === "full" ? <StreamLines bookId={bookId} preview /> : <PreviewLine bookId={bookId} />;
}

/** The time left before a quick retry, beside the line of the wait: a timer that is not read out as it ticks (the line says when the wait begins and ends). */
function WaitLeft({ at }: { at: string }) {
  const { t, i18n } = useTranslation();
  const now = useNow(1000, true);
  const seconds = secondsLeft(at, now);
  if (seconds === null) return null;
  return <span role="timer" data-band-wait-left className="shrink-0 text-xs tabular-nums text-muted-foreground">{seconds > 0 ? t("autopilot.failure.countdown.in", { time: formatCountdown(seconds, i18n.resolvedLanguage ?? i18n.language) }) : t("autopilot.failure.countdown.now")}</span>;
}

/** The line of a wait: drawn again once a minute in a long one, so that its day stays right past midnight (the words change then, and only then). */
function WaitText({ wait }: { wait: RetryWait }) {
  const { t, i18n } = useTranslation();
  useNow(60_000, wait.long);
  return <>{waitLineText(t, wait, i18n.resolvedLanguage ?? i18n.language)}</>;
}

/**
 * What the autopilot does now: the title of the step, where in the book it is and how long it has gone on, as the one status of the band that is
 * announced (it changes when the step does). It follows the activity of the store, which stays the same object while the text streams. While the run
 * waits to try a failed step again (`wait`) it says so in one line: which retry, or which restart and not before when. `countdown` adds the time left
 * of a quick wait, in a timer of its own, where nothing else says it (the mini-player: on the page the error panel counts down).
 */
export const StepNow = memo(function StepNow({ bookId, compact = false, showPreview = true, announce = true, hideElapsed = false, wait = null, countdown = false }: { bookId: string; compact?: boolean; showPreview?: boolean; announce?: boolean; hideElapsed?: boolean; wait?: RetryWait | null; countdown?: boolean }) {
  const { t } = useTranslation();
  const activity = useAutopilotStore((state) => state.live[bookId]?.activity ?? null);
  const step = wait ? null : activity;
  const where = step ? whereOf(t, step) : null;
  return (
    <div data-band-now data-band-waiting={wait ? (wait.long ? "long" : "short") : undefined} className="min-w-0 space-y-1">
      <div className={cn("flex min-w-0 gap-x-2", compact ? "items-center" : "flex-wrap items-baseline")}>
        {!compact && <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-primary">{t("autopilot.band.now")}</span>}
        <p role={announce ? "status" : undefined} className={cn("min-w-0 flex-1 text-sm font-medium leading-snug", compact ? "line-clamp-2 break-words" : "basis-48")}>
          {wait ? <WaitText wait={wait} /> : step ? activityTitle(t, step) : t("autopilot.current.preparing")}
        </p>
        {!compact && where && <span data-band-where className="shrink-0 text-xs text-muted-foreground">{where}</span>}
        {step && !hideElapsed && <ElapsedTime since={step.startedAt} />}
        {wait && countdown && !wait.long && <WaitLeft at={wait.at} />}
      </div>
      {!compact && showPreview && !wait && <NowText bookId={bookId} />}
      {!wait && <ModelAnswering bookId={bookId} short={compact} />}
    </div>
  );
});

/** What the status of the band says while nothing runs: the message the autopilot left, once. */
export function StatusMessage({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  return <p data-band-now data-band-message className={cn("min-w-0 text-sm leading-snug", compact && "line-clamp-2 break-words")}>{children}</p>;
}

/** A real progress bar: its name, its numbers in words for a screen reader, and the numbers in figures for the eye. `name` is the accessible name when it has to say more than the label. */
export function ProgressBar({ label, name, now, max, valueText, text, className, thin = false }: { label: string; name?: string; now: number; max: number; valueText: string; text?: string; className?: string; thin?: boolean }) {
  const percent = max > 0 ? Math.min(100, Math.max(0, (now / max) * 100)) : 0;
  return (
    <div className={cn("min-w-0", className)}>
      {text !== undefined && (
        <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
          <span className="truncate text-muted-foreground">{label}</span>
          <span className="shrink-0 font-semibold tabular-nums">{text}</span>
        </div>
      )}
      <div role="progressbar" aria-label={name ?? label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={now} aria-valuetext={valueText} className={cn("overflow-hidden rounded-full bg-muted ring-1 ring-inset ring-border", thin ? "h-1.5" : "h-2")}>
        <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

/**
 * How far the book is, for the chapters and for the scenes. Nothing before a plan exists: there is nothing to count. `context` says whose bars they are
 * when there are two sets of them on the screen (the band and the mini-player), so that a screen reader can tell them apart. `bare` draws the bars
 * without the words and the figures above them, for a place that writes the figures itself.
 */
export const ProgressBars = memo(function ProgressBars({ summary, chapters = true, scenes = true, className, context, bare = false }: { summary: AutopilotStateSummary; chapters?: boolean; scenes?: boolean; className?: string; context?: string; bare?: boolean }) {
  const { t } = useTranslation();
  const { progress } = summary;
  if (progress.chapters === 0) return null;
  const both = chapters && scenes && progress.scenes > 0;
  const named = (label: string) => (context ? t("autopilot.band.named", { label, context }) : undefined);
  return (
    <div className={cn("grid gap-x-4 gap-y-2", both && "sm:grid-cols-2", className)}>
      {chapters && (
        <ProgressBar
          label={t("autopilot.progress.chapters")}
          name={named(t("autopilot.progress.chapters"))}
          now={progress.chaptersDone}
          max={progress.chapters}
          valueText={t("autopilot.band.chaptersValue", { done: progress.chaptersDone, total: progress.chapters })}
          text={bare ? undefined : `${progress.chaptersDone}/${progress.chapters}`}
        />
      )}
      {scenes && progress.scenes > 0 && (
        <ProgressBar
          label={t("autopilot.progress.scenes")}
          name={named(t("autopilot.progress.scenes"))}
          now={progress.scenesWritten}
          max={progress.scenes}
          valueText={t("autopilot.band.scenesValue", { done: progress.scenesWritten, total: progress.scenes })}
          text={bare ? undefined : `${progress.scenesWritten}/${progress.scenes}`}
        />
      )}
    </div>
  );
});

/** The phases of the book as a short list: what is done has a check, what is in progress has a dot and a word for it, and a screen reader is told which is which. */
export const PhaseList = memo(function PhaseList({ summary }: { summary: AutopilotStateSummary }) {
  const { t } = useTranslation();
  const steps = bandPhases(summary.phase);
  const label = (key: string) => (key === "chapters" ? t("autopilot.band.phases.chapters", { done: summary.progress.chaptersDone, total: summary.progress.chapters }) : key === "final" ? t("autopilot.band.phases.final") : t(`autopilot.phase.${key}`));
  return (
    <ol aria-label={t("autopilot.band.phases.label")} className="flex flex-wrap items-center gap-x-0.5 gap-y-1 text-xs">
      {steps.map((step, index) => (
        <li key={step.key} aria-current={step.state === "current" ? "step" : undefined} className="inline-flex items-center gap-0.5">
          <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium", step.state === "current" ? "bg-primary text-primary-foreground" : step.state === "done" ? "bg-primary/15 text-accent-foreground" : "bg-muted text-muted-foreground")}>
            {step.state === "done" ? <Check className="h-3 w-3" aria-hidden="true" /> : step.state === "current" ? <CircleDot className="h-3 w-3" aria-hidden="true" /> : null}
            {label(step.key)}
            {step.state === "done" && <span className="sr-only">{" "}{t("autopilot.band.phases.done")}</span>}
            {step.state === "current" && <span className="sr-only">{" "}{t("autopilot.band.phases.current")}</span>}
          </span>
          {index < steps.length - 1 && <ChevronRight className="h-3 w-3 text-muted-foreground" aria-hidden="true" />}
        </li>
      ))}
    </ol>
  );
});

/** The steps of the chapter in progress, with the current one marked by a shape and a word, not by its colour alone. */
export const CycleList = memo(function CycleList({ cycle }: { cycle: ChapterCycle }) {
  const { t } = useTranslation();
  const items = cycleItems(cycle);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <ol aria-label={t("autopilot.band.cycle.label", { chapter: cycle.chapterNumber })} className="flex flex-wrap items-center gap-x-0.5 gap-y-1 text-xs">
        {items.map((item, index) => (
          <li key={item.stage} aria-current={item.state === "current" ? "step" : undefined} className="inline-flex items-center gap-0.5">
            <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium", item.state === "current" ? "bg-primary text-primary-foreground" : item.state === "done" ? "bg-primary/15 text-accent-foreground" : "bg-muted text-muted-foreground")}>
              {item.state === "done" ? <Check className="h-3 w-3" aria-hidden="true" /> : item.state === "current" ? <CircleDot className="h-3 w-3" aria-hidden="true" /> : <Circle className="h-3 w-3" aria-hidden="true" />}
              {t(`autopilot.band.cycle.${item.stage}`)}
              {item.state === "done" && <span className="sr-only">{" "}{t("autopilot.band.cycle.done")}</span>}
              {item.state === "current" && <span className="sr-only">{" "}{t("autopilot.band.cycle.current")}</span>}
            </span>
            {index < CYCLE_STAGES.length - 1 && <ChevronRight className="h-3 w-3 text-muted-foreground" aria-hidden="true" />}
          </li>
        ))}
      </ol>
      {cycle.round !== null && cycle.round > 1 && <span className="text-xs font-medium text-muted-foreground">{t("autopilot.band.cycle.round", { round: cycle.round })}</span>}
    </div>
  );
});

/**
 * What it costs and how much it uses, in one line: the cost against the budget (a bar when there is one), the tokens, the calls, and the notices of the
 * calls the totals cannot be sure of. The reasons for those notices are one click away, so that the line stays a line.
 */
export const UsageLine = memo(function UsageLine({ summary, options, currency, className }: { summary: AutopilotStateSummary; options: AutopilotOptions | null; currency: string | undefined; className?: string }) {
  const { t } = useTranslation();
  const { stats } = summary;
  const use = budgetUse(stats, options);
  const usageUnknown = stats.usageUnknownCalls ?? 0;
  const costUnknown = stats.costUnknownCalls ?? 0;
  return (
    <div data-band-usage className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-xs", className)}>
      <span className="inline-flex items-center gap-2">
        <span className="text-muted-foreground">{t("autopilot.band.usage.cost")}</span>
        <span className="font-semibold tabular-nums">
          {use.cost.limit !== null ? t("autopilot.band.usage.costOf", { value: formatCost(use.cost.value, currency), budget: formatCost(use.cost.limit, currency) }) : formatCost(use.cost.value, currency)}
        </span>
        {use.cost.limit !== null && use.cost.ratio !== null && <ProgressBar label={t("autopilot.band.usage.costBar")} now={use.cost.value} max={use.cost.limit} valueText={t("autopilot.band.usage.costOf", { value: formatCost(use.cost.value, currency), budget: formatCost(use.cost.limit, currency) })} className="w-16" thin />}
      </span>
      <span className="inline-flex items-center gap-2">
        <span className="tabular-nums">
          {use.tokens.limit !== null
            ? t("autopilot.band.usage.tokensOf", { value: formatCount(use.tokens.value), budget: formatCount(use.tokens.limit) })
            : t("autopilot.band.usage.tokens", { value: formatCount(use.tokens.value) })}
        </span>
        {use.tokens.limit !== null && <ProgressBar label={t("autopilot.band.usage.tokensBar")} now={use.tokens.value} max={use.tokens.limit} valueText={t("autopilot.band.usage.tokensOf", { value: formatCount(use.tokens.value), budget: formatCount(use.tokens.limit) })} className="w-16" thin />}
      </span>
      <span className="tabular-nums">{t("autopilot.band.usage.calls", { count: stats.aiCalls })}</span>
      {usageUnknown > 0 && <span className="inline-flex items-center gap-1 font-medium text-amber-800 dark:text-amber-300"><AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{t("autopilot.progress.usageUnknown", { count: usageUnknown })}</span>}
      {costUnknown > 0 && <span className="inline-flex items-center gap-1 font-medium text-amber-800 dark:text-amber-300"><AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{t("autopilot.progress.costUnknown", { count: costUnknown })}</span>}
      {(usageUnknown > 0 || costUnknown > 0) && (
        <details className="basis-full text-muted-foreground">
          <summary className="inline-flex cursor-pointer items-center rounded-sm underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t("autopilot.band.usage.why")}</summary>
          <div className="mt-1 space-y-1">
            {usageUnknown > 0 && <p>{t("autopilot.progress.usageUnknownHint")}</p>}
            {costUnknown > 0 && <p>{t("autopilot.progress.costUnknownHint")}</p>}
          </div>
        </details>
      )}
    </div>
  );
});
