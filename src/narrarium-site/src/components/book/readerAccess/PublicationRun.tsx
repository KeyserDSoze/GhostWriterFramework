import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, RefreshCw, XCircle } from "lucide-react";
import "@/i18n/readerRun";
import "@/i18n/readerUpdate";
import { Button } from "@/components/ui/button";
import { LocalTime } from "@/components/ui/local-time";
import type { RunFailureInfo } from "@/readerAccess/runFailure";
import { allRunsUrl, durationMs, isEnded, phaseOf, runUrl, splitDuration, type PublicationPhase, type TrackedPublication } from "@/readerRun/model";
import type { PublicationLive } from "@/readerRun/store";
import type { OutsideCheckResult } from "@/readerUpdate/outsideCheck";

const ICON: Record<PublicationPhase, typeof Loader2> = { waiting: Loader2, queued: Loader2, running: Loader2, "action-required": AlertTriangle, succeeded: CheckCircle2, failed: XCircle, cancelled: AlertTriangle, "not-found": AlertTriangle };

/** A clock that moves once a second while something is going and the tab is seen, so that the duration of a run counts up without anything being announced. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) { setNow(Date.now()); return undefined; }
    const tick = () => { if (document.visibilityState !== "hidden") setNow(Date.now()); };
    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

interface Props {
  owner: string;
  repo: string;
  tracked: TrackedPublication;
  live: PublicationLive;
  going: boolean;
  /** Asks GitHub now. */
  onRefresh: () => void;
  /** Why the run failed, when it did and it has been read: the cause is said in words under the state. */
  failure?: RunFailureInfo | null;
  /** What the check from outside found for this publication, and whether it is running. */
  outside?: { result: OutsideCheckResult | null; running: boolean } | null;
  /** The check from outside can be made (there is a published address). */
  onCheckOutside?: () => void;
}

/**
 * The live state of the publication that was just started: which run of the workflow it is, what it is doing now (queued, running with its current step,
 * ended), when it started and how long it has taken, with the link that opens the run on GitHub in a new tab and the list of all runs. It polls (see
 * `usePublicationRun`) and this only shows what it found: the state is written in words, the polite announcement changes only when the state does (never on
 * every poll), and nothing here depends on colour alone.
 */
export function PublicationRun({ owner, repo, tracked, live, going, onRefresh, failure, outside, onCheckOutside }: Props) {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const now = useNow(going);
  const phase = phaseOf(tracked, now);
  const Icon = ICON[phase];
  const spinning = phase === "waiting" || phase === "queued" || phase === "running";
  const duration = durationMs(tracked, now);
  const split = duration === null ? null : splitDuration(duration);
  const durationText = split ? (split.minutes > 0 ? t("readerRun.minutesSeconds", split) : t("readerRun.secondsOnly", split)) : null;
  const language = i18n.resolvedLanguage ?? i18n.language;
  const checked = live.checkedAt ? new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(live.checkedAt) : null;

  // The polite announcement: one sentence for each state the publication goes through, read out when it changes. What was already there when the card opened
  // is not read out unless it is still going (a finished publication of hours ago is not news).
  const [announcement, setAnnouncement] = useState("");
  const previous = useRef<PublicationPhase | null>(null);
  useEffect(() => {
    if (previous.current === phase) return;
    const first = previous.current === null;
    previous.current = phase;
    if (first && isEnded(tracked.state)) return;
    setAnnouncement(t(`readerRun.announce.${phase}`));
  }, [phase, t, tracked.state]);

  const secondsLeft = live.nextAt ? Math.max(1, Math.round((live.nextAt - now) / 1000)) : 0;
  const problem = live.problem === "permission" ? t("readerRun.permission")
    : live.problem ? t(`readerRun.${live.problem === "rate-limit" ? "rateLimit" : live.problem === "network" ? "network" : "other"}`, { seconds: secondsLeft }) : null;

  return (
    <section aria-labelledby={titleId} className="space-y-2 rounded-md border p-3 text-sm" data-testid="reader-publication" data-phase={phase} data-run-id={tracked.runId ?? ""}>
      <h3 id={titleId} className="font-medium">{t("readerRun.title")}</h3>
      <p className="flex items-start gap-2 font-medium" data-testid="reader-publication-state">
        <Icon aria-hidden="true" className={`mt-0.5 h-4 w-4 shrink-0 ${spinning ? "animate-spin motion-reduce:animate-none" : ""} ${phase === "failed" || phase === "cancelled" || phase === "not-found" ? "text-destructive" : ""}`} />
        <span>{t(`readerRun.phase.${phase}`)}</span>
      </p>
      {phase === "running" && tracked.step && (
        <p className="ml-6 text-xs" data-testid="reader-publication-step">
          {tracked.step.step ? t("readerRun.step", { index: tracked.step.index, total: tracked.step.total, name: tracked.step.step }) : t("readerRun.stepJob", { job: tracked.step.job })}
        </p>
      )}
      <dl className="ml-6 grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-muted-foreground">{t("readerRun.started")}</dt>
        <dd>{tracked.startedAt ? <LocalTime value={tracked.startedAt} /> : t("readerRun.notStarted")}</dd>
        <dt className="text-muted-foreground">{t("readerRun.duration")}</dt>
        <dd data-testid="reader-publication-duration">{durationText === null ? "—" : phase === "running" || phase === "queued" ? t("readerRun.durationSoFar", { value: durationText }) : durationText}</dd>
      </dl>
      {phase === "action-required" && (
        <div className="ml-6 space-y-1 rounded-md border border-amber-600/50 bg-amber-50 p-2 text-xs text-amber-950 dark:bg-amber-950/30 dark:text-amber-100" data-testid="reader-publication-approval">
          <p>{t("readerRun.approval.why")}</p>
          <p className="font-medium">{t("readerRun.approval.action")}</p>
          <p>{t("readerRun.approval.cure")}</p>
        </div>
      )}
      {phase === "failed" && failure && <p className="ml-6 text-xs" data-testid="reader-publication-cause" data-cause={failure.cause}>{t(`readerUpdate.runFailure.${failure.cause}.title`)}</p>}
      {phase === "succeeded" && outside && (
        <p className="ml-6 text-xs" data-testid="reader-publication-outside" role="status">
          {outside.running ? t("readerRun.outside.running")
            : outside.result?.kind === "protected" ? t("readerRun.outside.protected")
              : outside.result?.kind === "epub-exposed" ? t("readerRun.outside.exposed", { status: outside.result.status })
                : outside.result?.kind === "not-protected" ? t("readerRun.outside.notProtected")
                  : outside.result?.kind === "unreachable" ? t("readerRun.outside.unreadable") : null}
        </p>
      )}
      <div className="ml-6 flex flex-wrap items-center gap-x-4 gap-y-1">
        {tracked.runId !== undefined && (
          <a className="inline-flex min-h-6 items-center gap-1 font-medium underline underline-offset-2" href={runUrl(owner, repo, tracked.runId)} target="_blank" rel="noopener noreferrer">
            {t("readerRun.openRun")}<ExternalLink aria-hidden="true" className="h-3.5 w-3.5" /><span className="sr-only"> {t("readerRun.opensNewTab")}</span>
          </a>
        )}
        <a className="inline-flex min-h-6 items-center gap-1 font-medium underline underline-offset-2" href={allRunsUrl(owner, repo)} target="_blank" rel="noopener noreferrer">
          {t("readerRun.allRuns")}<ExternalLink aria-hidden="true" className="h-3.5 w-3.5" /><span className="sr-only"> {t("readerRun.opensNewTab")}</span>
        </a>
        {phase === "succeeded" && onCheckOutside && !outside?.running && (
          <Button type="button" size="sm" variant="outline" onClick={onCheckOutside}>{t("readerRun.outside.check")}</Button>
        )}
        {going && <Button type="button" size="sm" variant="ghost" onClick={onRefresh}><RefreshCw aria-hidden="true" className="mr-1 h-4 w-4" />{t("readerRun.refreshNow")}</Button>}
      </div>
      <div className="ml-6 space-y-0.5 text-xs text-muted-foreground">
        {going && <p>{live.paused ? t("readerRun.paused") : t("readerRun.autoRefresh")}</p>}
        {going && !live.paused && <p>{t("readerRun.stopped")}</p>}
        {checked && going && <p>{t("readerRun.checked", { time: checked })}</p>}
        {problem && <p role="status" className="text-foreground" data-testid="reader-publication-problem" data-problem={live.problem}>{problem}</p>}
      </div>
      <p role="status" aria-live="polite" className="sr-only" data-testid="reader-publication-announce">{announcement}</p>
    </section>
  );
}
