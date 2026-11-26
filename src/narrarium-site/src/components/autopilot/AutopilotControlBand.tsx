import { useMemo, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AutopilotActivity, AutopilotState, AutopilotStateSummary, AutopilotStatus } from "narrarium-engine";
import { chapterCycle, stepSpendOf, type ChapterCycle } from "@/autopilot/bandModel";
import { planReviewMode } from "@/autopilot/planApprovalModel";
import { useBookAutopilotView } from "@/autopilot/hooks";
import { retryWaitOf, type RetryWait } from "@/autopilot/retry";
import { useAutopilotStore } from "@/autopilot/store";
import { isProfileProblemStop } from "@/autopilot/stopReason";
import { useAutopilotControl, type AutopilotControl } from "@/autopilot/useAutopilotControl";
import { useTextDetail } from "@/autopilot/useLiveText";
import { AttemptNow } from "@/components/autopilot/band/Attempt";
import { CampaignChip, CycleList, FrozenChangesChip, HostChip, PhaseList, PreviewLine, ProgressBars, SignalAge, StatusMessage, StatusPill, StepElapsed, StepNow } from "@/components/autopilot/band/parts";
import { CostLine } from "@/components/autopilot/costs/CostLine";
import { LastDone } from "@/components/autopilot/live/LastDone";
import { LiveAnnouncer, TextDetailToggle } from "@/components/autopilot/live/LiveControls";
import { StreamLines } from "@/components/autopilot/live/StreamLines";
import { useReserveSpace } from "@/hooks/useReserveSpace";
import { useMoney } from "@/costs/useMoney";
import { useSettingsStore } from "@/store/settingsStore";
import { cn } from "@/lib/utils";

const NO_ACTIVITIES: AutopilotActivity[] = [];

/** Everything the band shows of a book, worked out once from what the page already has: the control of the run, the saved state, the log of the steps. */
export interface BandModel {
  bookId: string;
  bookName: string;
  control: AutopilotControl;
  summary: AutopilotStateSummary;
  status: AutopilotStatus;
  state: AutopilotState | null;
  activities: AutopilotActivity[];
  host: "browser" | "server";
  /** The run belongs to a device this client cannot command. */
  elsewhere: boolean;
  running: boolean;
  completed: boolean;
  cycle: ChapterCycle | null;
  currency: string | undefined;
  /** The message of the autopilot about its state, when it is not said anywhere else: not while a step runs, not when a notice of its own says it. */
  message: string | null;
  /** The wait before the next attempt of a step that failed, while the run waits: the same object for as long as the summary is. */
  wait: RetryWait | null;
  /** What the step that runs has spent so far, when the activity says it (`stepSpendOf`); `null` for a step that has not told, which is every step until it ends. */
  stepSpend: { cost: number } | null;
}

/** The model of the band of a book, or `null` while its autopilot has no state. */
export function useBandModel(bookId: string): BandModel | null {
  const control = useAutopilotControl(bookId);
  const view = useBookAutopilotView(bookId);
  const book = useSettingsStore((store) => store.settings.books.find((entry) => entry.id === bookId));
  // Followed live: a change of the currency or of a rate in the settings shows at once in what the band says of the costs.
  const money = useMoney();
  const liveActivity = useAutopilotStore((store) => store.live[bookId]?.activity ?? null);
  const summary = control.summary;
  const state = view.snapshot?.state ?? null;
  const cycle = useMemo(() => chapterCycle(state, liveActivity), [state, liveActivity]);
  const wait = useMemo(() => retryWaitOf(summary), [summary]);
  const stepSpend = useMemo(() => stepSpendOf(liveActivity), [liveActivity]);
  if (!summary) return null;

  const status = summary.status;
  // A plan that waits for the author, to be approved or made again with the changes asked, has its own screen, which says it.
  const awaitingPlan = planReviewMode(state, control.running) !== null;
  // The message is said once, and where it is the one that tells it: a step that runs says itself, the plan that waits has its notice, a question has its card,
  // the profile files and the error have theirs, and a book that is complete says so in its status and its result.
  const quiet = control.running || awaitingPlan || Boolean(summary.question) || isProfileProblemStop(summary) || status === "error" || status === "completed";
  return {
    bookId,
    bookName: book?.name ?? bookId,
    control,
    summary,
    status,
    state,
    activities: view.snapshot?.activities ?? NO_ACTIVITIES,
    host: book?.autopilotHost === "server" ? "server" : "browser",
    elsewhere: control.running && !control.controllable,
    running: control.running,
    completed: status === "completed",
    cycle,
    currency: summary.stats.currency ?? money.display,
    message: !quiet && summary.message ? summary.message : null,
    wait,
    stepSpend,
  };
}

/** How much of the band a page has room for: all of it, with the commands beside the figures (`full`); the state, the step and the progress, with the commands under them (`slim`); or a few short rows (`compact`: the status with the chapters and the time, the title of the step in a row as wide as the band, the progress as a bar). The rest is in `AutopilotBandDetails`. */
export type BandVariant = "full" | "slim" | "compact";

export interface AutopilotControlBandProps {
  bookId: string;
  variant?: BandVariant;
  /** The bar of quick commands, when the band holds it (the page keeps it in a bar at the bottom when the band is compact). */
  commands?: ReactNode;
}

/** Where it runs and, for a book on the server that runs, how long ago it was last heard of. For a run of another device, who runs it, so that the band does not claim the run is its own. */
function HostLine({ model }: { model: BandModel }) {
  const { t } = useTranslation();
  const { bookId, summary, running, elsewhere, control } = model;
  const host = elsewhere ? control.runnerHost ?? "server" : model.host;
  return (
    <>
      <HostChip host={host} runnerLabel={elsewhere ? control.runnerLabel ?? t(`autopilot.host.${host}`) : null} />
      {model.host === "server" && running && !elsewhere && <SignalAge bookId={bookId} summary={summary} />}
    </>
  );
}

/**
 * The band at the top of the page of the autopilot, under the header of the app. It answers three questions at a glance: what the autopilot is
 * doing now (its state, where it runs, the step, how long it has gone on), how far it is (the chapters and the scenes, the phases, the cycle of the
 * chapter in progress), and what the author can do (the quick commands, composed here and not written again). Then, in a line, what it costs.
 *
 * It follows the store by itself, in small parts that are not drawn again for what they do not show: the text that streams is read by one line of
 * its own and the timer ticks in a leaf, so the page and the band stay still while the text arrives.
 */
export function AutopilotControlBand({ bookId, variant = "full", commands }: AutopilotControlBandProps) {
  const { t } = useTranslation();
  const model = useBandModel(bookId);
  const [detail] = useTextDetail();
  const wrapper = useRef<HTMLDivElement>(null);
  useReserveSpace(wrapper, "--top-reserve", Boolean(model));
  if (!model) return null;
  const { summary, status, running, completed } = model;
  const compact = variant === "compact";
  const full = variant === "full";
  // «Last done» is in the band where the band has room for it (beside the step, under the commands); elsewhere it is in the details of the Overview.
  const lastDone = full && detail === "full" ? <LastDone bookId={bookId} className={commands ? "border-t pt-3" : undefined} /> : null;

  const statusRow = (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
      <StatusPill status={status} />
      <HostLine model={model} />
      <FrozenChangesChip count={summary.frozenChanges} />
      <CampaignChip campaign={summary.campaign} spent={summary.stats} />
      <TextDetailToggle labelled className="ml-auto" />
    </div>
  );

  return (
    <div ref={wrapper} data-autopilot-band-wrapper className="sticky top-0 z-20 bg-background pb-3 pt-1">
      <section data-autopilot-band data-compact={compact ? "" : undefined} tabIndex={-1} aria-label={t("autopilot.band.label", { book: model.bookName })} className="rounded-2xl border border-layer bg-card shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {compact ? (
          <div className="space-y-2 p-3">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <StatusPill status={status} />
              {summary.progress.chapters > 0 && <span className="text-xs font-medium tabular-nums text-muted-foreground">{t("autopilot.band.phases.chapters", { done: summary.progress.chaptersDone, total: summary.progress.chapters })}</span>}
              <FrozenChangesChip count={summary.frozenChanges} />
              <CampaignChip campaign={summary.campaign} spent={summary.stats} />
              {running && <StepElapsed bookId={bookId} className="ml-auto" />}
            </div>
            {running ? <StepNow bookId={bookId} compact hideElapsed wait={model.wait} /> : model.message ? <StatusMessage compact>{model.message}</StatusMessage> : null}
            <ProgressBars summary={summary} scenes={false} bare />
          </div>
        ) : (
          <div className={cn("gap-4 p-3 sm:p-4", full ? "grid grid-cols-[minmax(0,1fr)_auto]" : "space-y-3")}>
            <div className="min-w-0 space-y-3">
              {statusRow}
              {running ? <StepNow bookId={bookId} showPreview={full} wait={model.wait} model={!full} /> : model.message ? <StatusMessage>{model.message}</StatusMessage> : null}
              <ProgressBars summary={summary} />
              {full && summary.progress.chapters > 0 && <PhaseList summary={summary} />}
              {full && model.cycle && <CycleList cycle={model.cycle} />}
              {/* Which model the step asks now, beside what it costs: the two lines that say where the money goes. */}
              {full && running && !model.wait && <AttemptNow bookId={bookId} className="-mb-1.5" />}
              {full && !completed && <CostLine model={model} />}
              {!commands && lastDone}
            </div>
            {commands && <div className={cn("min-w-0", full ? "max-w-[22rem] space-y-3" : "border-t pt-3")}>{commands}{lastDone}</div>}
          </div>
        )}
      </section>
      {/* Its own voice, beside the one status of the band (the step): what the step answers, and what is done. */}
      <LiveAnnouncer bookIds={[bookId]} />
    </div>
  );
}

/**
 * What the band of a page that has little room does not have, for the Overview tab: the text that streams, the last steps done, the phases, the cycle of
 * the chapter, what it costs, and, on a phone, where it runs, «Show the text», the scenes and how a book that is complete went. The same parts as the band,
 * with the same figures; the band does not repeat them.
 */
export function AutopilotBandDetails({ bookId, variant }: { bookId: string; variant: Exclude<BandVariant, "full"> }) {
  const model = useBandModel(bookId);
  const [detail] = useTextDetail();
  if (!model) return null;
  const { summary, running, completed } = model;
  const compact = variant === "compact";
  const text = detail === "full";
  return (
    <div data-band-details className="space-y-3 rounded-2xl border border-layer bg-card p-3 shadow-sm">
      {/* The compact band of a phone has no room for «Show the text»: it is here, over the lines and the list it shows, as big as a finger. */}
      {compact && <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"><HostLine model={model} /><TextDetailToggle labelled className="ml-auto min-h-11" /></div>}
      {running && (text ? <StreamLines bookId={bookId} preview /> : <PreviewLine bookId={bookId} />)}
      {text && <LastDone bookId={bookId} />}
      {compact && <ProgressBars summary={summary} chapters={false} />}
      {summary.progress.chapters > 0 && <PhaseList summary={summary} />}
      {model.cycle && <CycleList cycle={model.cycle} />}
      {!completed && <CostLine model={model} />}
    </div>
  );
}
