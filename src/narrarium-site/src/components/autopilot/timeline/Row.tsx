import { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Ban, CheckCircle2, Loader2, RotateCw, XCircle } from "lucide-react";
import type { ActivityStatus, AutopilotActivity } from "narrarium-engine";
import { EventIcon } from "@/components/autopilot/AutopilotFeed";
import { KindIcon } from "@/components/autopilot/KindIcon";
import { isErrorKind } from "@/autopilot/errorModel";
import { TONE_BORDER, TONE_TEXT, activityTitle, formatClock, formatCost, formatCount, formatDateTime, formatDuration, presentFeedEvent } from "@/autopilot/format";
import type { TimelineMarker, TimelineNote, TimelineRow, TimelineStep } from "@/autopilot/timelineModel";
import { taskElementId } from "@/autopilot/liveText";
import { TaskCallsEntry } from "@/components/autopilot/calls/TaskCallsEntry";
import { cn } from "@/lib/utils";

/** The icon of how a step went: a shape for each outcome, so that colour is never the only thing that tells. */
function StatusIcon({ status }: { status: ActivityStatus }) {
  if (status === "running") return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" aria-hidden="true" />;
  if (status === "succeeded") return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden="true" />;
  if (status === "cancelled") return <Ban className="h-3.5 w-3.5 shrink-0 text-amber-700 dark:text-amber-600" aria-hidden="true" />;
  return <XCircle className="h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400" aria-hidden="true" />;
}

/** The steps that write something: what they leave is the text of the book, and its summary is told as such. */
const WRITES = new Set(["write", "repair", "revise"]);

const badge = "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium";

/** `covered` is the result of the step: a detail that is already in it is not told again. */
function NoteLine({ note, currency, covered }: { note: TimelineNote; currency?: string; covered?: string }) {
  const { t } = useTranslation();
  const view = presentFeedEvent(t, note.event, currency);
  if (!view) return null;
  const detail = view.detail && !(covered && covered.includes(view.detail.trim())) ? view.detail : undefined;
  return (
    <li className={cn("flex gap-2 border-l-2 pl-2", TONE_BORDER[view.tone])}>
      <EventIcon event={note.event} className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", TONE_TEXT[view.tone])} />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug">{view.text}</p>
        {detail && <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-muted-foreground">{detail}</p>}
      </div>
    </li>
  );
}

/** What a step holds, drawn only once it is opened. */
function StepBody({ step, currency }: { step: TimelineStep; currency?: string }) {
  const { t } = useTranslation();
  const { last } = step;
  const many = step.attempts.length > 1;
  const latest = (pick: (activity: AutopilotActivity) => string | undefined) => [...step.attempts].reverse().map((attempt) => pick(attempt.activity)).find(Boolean);
  const model = latest((activity) => activity.model ?? activity.errorDetail?.model);
  const provider = latest((activity) => activity.provider ?? activity.errorDetail?.provider);
  const endpoint = latest((activity) => activity.errorDetail?.endpoint);
  const facts = [
    formatDateTime(step.startedAt),
    model,
    provider,
    endpoint,
    step.tokens ? t("autopilot.timeline.row.tokens", { input: formatCount(step.tokens.input), output: formatCount(step.tokens.output), cached: formatCount(step.tokens.cached) }) : "",
    step.cost > 0 ? formatCost(step.cost, currency) : "",
    last.host ? t(`autopilot.host.${last.host}`) : "",
  ].filter(Boolean);
  const attemptsId = `${step.key}-attempts`;
  return (
    <div className="space-y-2 border-t px-3 py-2 text-xs">
      {last.summary && (
        <div className="space-y-0.5">
          <p className="font-medium">{WRITES.has(last.task) ? t("autopilot.timeline.row.written") : t("autopilot.timeline.row.result")}</p>
          <p className={cn("whitespace-pre-wrap", WRITES.has(last.task) && "font-serif italic text-muted-foreground")}>{last.summary}</p>
        </div>
      )}
      {!many && last.error && (
        <div className="space-y-0.5 text-destructive">
          {isErrorKind(last.errorKind) && <p className="font-medium">{t(`autopilot.failure.kind.${last.errorKind}.title`)}</p>}
          <p className="whitespace-pre-wrap break-words">{last.error}</p>
        </div>
      )}
      {last.reason && <p className="text-muted-foreground"><span className="font-medium text-foreground/80">{t("autopilot.why")}:</span> {last.reason}</p>}
      {last.next && <p className="text-muted-foreground"><span className="font-medium text-foreground/80">{t("autopilot.next")}:</span> {last.next}</p>}
      {step.notes.length > 0 && (
        <div className="space-y-1">
          <p className="font-medium">{t("autopilot.timeline.row.notes")}</p>
          <ul className="space-y-1.5">{step.notes.map((note) => <NoteLine key={note.key} note={note} currency={currency} covered={last.summary} />)}</ul>
        </div>
      )}
      {many && (
        <div className="space-y-1">
          <p id={attemptsId} className="font-medium">{t("autopilot.timeline.row.attemptsTitle")}</p>
          <ol aria-labelledby={attemptsId} className="space-y-1.5">
            {step.attempts.map((attempt, index) => {
              const activity = attempt.activity;
              const retry = attempt.retry ? presentFeedEvent(t, attempt.retry.event, currency) : null;
              const { attempt: retried, retries } = activity.errorDetail ?? {};
              return (
                <li key={activity.id} id={index > 0 ? taskElementId(activity.id) : undefined} tabIndex={index > 0 ? -1 : undefined} className="scroll-mt-8 space-y-0.5 rounded-md focus:outline-none focus:ring-2 focus:ring-ring">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <StatusIcon status={activity.status} />
                    <span className="font-medium">{t("autopilot.timeline.row.attempt", { number: index + 1 })}</span>
                    <span className="text-muted-foreground">{t(`autopilot.activity.status.${activity.status}`)}{activity.status === "failed" && isErrorKind(activity.errorKind) ? ` · ${t(`autopilot.failure.kind.${activity.errorKind}.short`)}` : ""} · {formatClock(activity.startedAt)}{activity.endedAt ? ` · ${formatDuration(Date.parse(activity.endedAt) - Date.parse(activity.startedAt))}` : ""}</span>
                  </p>
                  {activity.error && <p className="whitespace-pre-wrap break-words pl-5 text-destructive">{activity.error}</p>}
                  {retry && <p className="flex items-start gap-1.5 pl-5 text-muted-foreground"><RotateCw className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{retry.text}</p>}
                  {!retry && typeof retried === "number" && typeof retries === "number" && <p className="flex items-start gap-1.5 pl-5 text-muted-foreground"><RotateCw className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span>{t("autopilot.timeline.row.retryOf", { attempt: retried, retries })}</span></p>}
                </li>
              );
            })}
          </ol>
        </div>
      )}
      <p className="text-muted-foreground">{facts.join(" · ")}</p>
      {last.changedPaths && last.changedPaths.length > 0 && (
        <div>
          <p className="font-medium">{t("autopilot.activity.changed")}</p>
          <ul className="mt-0.5 space-y-0.5 font-mono text-xs text-muted-foreground">{last.changedPaths.map((path) => <li key={path} className="break-all">{path}</li>)}</ul>
        </div>
      )}
      <TaskCallsEntry activityIds={step.attempts.map((attempt) => attempt.activity.id)} />
    </div>
  );
}

/**
 * A step: its line, which opens what it holds. Its line carries the anchor of the step (`#task-<id>` of its first attempt; each later attempt has its
 * own in what it holds), so that a link to it from the mini-player, the band or the page of every book lands on it. `revealed` is the step such a link
 * points at: it opens, and its line shows where the focus is even after a click.
 */
function StepRow({ step, currency, revealed = false }: { step: TimelineStep; currency?: string; revealed?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(revealed);
  useEffect(() => {
    if (revealed) setOpen(true);
  }, [revealed]);
  const warnings = step.notes.filter((note) => note.tone === "warning" || note.tone === "critical").length;
  const failed = step.status === "failed";
  return (
    <li data-timeline-row="step">
      <details className="rounded-lg border" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary id={taskElementId(step.key)} data-revealed={revealed ? "" : undefined} className={cn("flex scroll-mt-8 cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden", revealed && "focus:outline-none focus:ring-2 focus:ring-ring")}>
          <StatusIcon status={step.status} />
          <span className="min-w-0 flex-1 basis-40 text-sm">{activityTitle(t, step.last)}</span>
          {step.attempts.length > 1 && <span className={cn(badge, "bg-muted text-muted-foreground")}>{t("autopilot.timeline.row.attempts", { count: step.attempts.length })}</span>}
          {warnings > 0 && <span className={cn(badge, "bg-amber-500/15 text-amber-800 dark:text-amber-300")}>{t("autopilot.timeline.row.warnings", { count: warnings })}</span>}
          {/* How it went is said in words: for a step that worked only a screen reader needs them, the icon says it to the eye. */}
          {failed && isErrorKind(step.last.errorKind) ? (
            <span className={cn(badge, "inline-flex items-center gap-1 bg-red-500/15 text-red-800 dark:text-red-300")}>
              <KindIcon kind={step.last.errorKind} className="h-3.5 w-3.5 shrink-0" />
              <span className="sr-only">{t("autopilot.activity.status.failed")} </span>
              {t(`autopilot.failure.kind.${step.last.errorKind}.short`)}
            </span>
          ) : (
            <span className={step.status === "succeeded" ? "sr-only" : cn(badge, failed ? "bg-red-500/15 text-red-800 dark:text-red-300" : "bg-amber-500/15 text-amber-800 dark:text-amber-300")}>{t(`autopilot.activity.status.${step.status}`)}</span>
          )}
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatDuration(step.durationMs)}</span>
          {step.cost > 0 && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatCost(step.cost, currency)}</span>}
        </summary>
        {open && <StepBody step={step} currency={currency} />}
      </details>
    </li>
  );
}

/** A note of the run: a run that started or ended, a notice of no step. What it says in full is under it, when it is opened. */
function MarkerRow({ marker, currency }: { marker: TimelineMarker; currency?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const view = presentFeedEvent(t, marker.event, currency);
  if (!view) return null;
  const head = (
    <>
      <EventIcon event={marker.event} className={cn("h-3.5 w-3.5 shrink-0", TONE_TEXT[view.tone])} />
      <span className="min-w-0 flex-1 text-sm leading-snug">{view.text}</span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatClock(marker.at)}</span>
    </>
  );
  return (
    <li data-timeline-row="marker" className={cn("rounded-r-md border-l-2 bg-muted/20", TONE_BORDER[view.tone])}>
      {view.detail ? (
        <details onToggle={(event) => setOpen(event.currentTarget.open)}>
          <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 [&::-webkit-details-marker]:hidden">{head}</summary>
          {open && <p className="whitespace-pre-wrap break-words px-2.5 pb-2 text-xs text-muted-foreground">{view.detail}</p>}
        </details>
      ) : (
        <div className="flex items-center gap-2 px-2.5 py-1.5">{head}</div>
      )}
    </li>
  );
}

/** A row is drawn again only when what it shows changed: a step by its version, a note of the run by its identity. */
export const TimelineRowView = memo(function TimelineRowView({ row, currency, revealed = false }: { row: TimelineRow; currency?: string; revealed?: boolean }) {
  return row.kind === "step" ? <StepRow step={row} currency={currency} revealed={revealed} /> : <MarkerRow marker={row} currency={currency} />;
}, (before, after) => before.currency === after.currency && before.revealed === after.revealed && before.row.kind === after.row.kind && (before.row.kind === "step" ? before.row.version === (after.row as TimelineStep).version : before.row.key === after.row.key));
