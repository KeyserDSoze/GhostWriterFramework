import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { ChevronDown, CircleHelp, Loader2, Pause, Play, Plus, SkipForward, Square, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { QUICK_CONTROLS_SERVER_VERSION } from "@/autopilot/quickControls";
import { autopilotSettingsHref } from "@/autopilot/pageRoute";
import type { RetryWait } from "@/autopilot/retry";
import type { QuickModel } from "@/components/autopilot/quick/model";
import { MENU_CONTENT, MENU_ITEM, MenuText, Reason } from "@/components/autopilot/quick/parts";

/**
 * The first group of the bar: what runs. A run that goes on has a pause (after the step, which is what a click does, or at the end of the
 * chapter, or taken back) and a stop; while it waits to try a failed step again, «Retry now» ends the wait. One that is stopped has Resume and
 * a menu to run one step, one chapter, or until the author stops it.
 * The one main action is the one with the colour of the main action, and it changes with the state: Pause, Approve the plan and continue,
 * Resume, Answer the question, Retry; for a book that is complete, Add chapters (the configuration is where more chapters are asked for), or
 * Write the new chapters once the settings ask for more than the plan has. `runExtra` is whatever the page puts next to it (Read chapter 4);
 * `trailing` ends the row (the button that opens the other groups of a bar that is condensed).
 */
export function RunGroup({ model, profileHintId, runExtra, trailing }: { model: QuickModel; profileHintId?: string; runExtra?: ReactNode; trailing?: ReactNode }) {
  return model.control.running ? <Running model={model} trailing={trailing} /> : <Stopped model={model} profileHintId={profileHintId} runExtra={runExtra} trailing={trailing} />;
}

/**
 * «Retry now», while the run waits: it ends the wait (a quick one or one of «Retry later») and the attempt starts at once. It is busy, not disabled, while the
 * command is on its way, so that the focus stays on it; when the wait is over the button goes, and the focus goes to the pause, where a keyboard goes on.
 * What it came to is said by the status of the bar.
 */
function RetryNow({ model, wait, pause, explained }: { model: QuickModel; wait: RetryWait; pause: RefObject<HTMLButtonElement | null>; explained?: string }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLButtonElement>(null);
  const pending = model.busy === "retry-now";
  useLayoutEffect(() => {
    const element = ref.current;
    return () => {
      if (!element || element !== document.activeElement) return;
      const next = pause.current;
      if (next && !next.disabled) next.focus({ preventScroll: true });
      else document.querySelector<HTMLElement>("[data-autopilot-band]")?.focus({ preventScroll: true });
    };
  }, [pause]);
  return (
    <Button
      ref={ref}
      size="sm"
      variant="outline"
      aria-label={model.named(t("autopilot.retry.now"))}
      aria-describedby={explained}
      aria-disabled={pending || undefined}
      disabled={model.unreachable}
      onClick={() => { if (!pending) void model.commands.retryNow(wait.at); }}
    >
      {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}{t("autopilot.retry.now")}
    </Button>
  );
}

function Running({ model, trailing }: { model: QuickModel; trailing?: ReactNode }) {
  const { t } = useTranslation();
  const { commands, busy, pausing, unreachable, pausePending, named, ids } = model;
  const pauseButton = useRef<HTMLButtonElement>(null);
  const explained = unreachable ? ids.remote : undefined;
  // The pause after the step is already asked for: asking again changes nothing, and the button says it waits.
  const waitingForStep = pausePending === "after-step";
  const old = !model.serverControls;
  const tooOld = t("autopilot.quick.serverTooOld", { version: QUICK_CONTROLS_SERVER_VERSION });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex">
        <Button
          ref={pauseButton}
          size="sm"
          className="rounded-r-none"
          aria-label={named(t("autopilot.actions.pause"))}
          aria-describedby={explained}
          disabled={pausing || unreachable || waitingForStep}
          onClick={() => void commands.pause("after-step")}
        >
          {busy === "pause" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Pause className="h-4 w-4" aria-hidden />}{t("autopilot.actions.pause")}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              className="rounded-l-none border-l border-primary-foreground/30 px-2"
              aria-label={named(t("autopilot.quick.run.pauseMore"))}
              title={t("autopilot.quick.run.pauseMore")}
              aria-describedby={explained}
              disabled={pausing || unreachable}
            >
              <ChevronDown className="h-4 w-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className={MENU_CONTENT}>
            <DropdownMenuItem className={MENU_ITEM} disabled={waitingForStep} onSelect={() => void commands.pause("after-step")}>
              <MenuText label={t("autopilot.quick.run.pauseStep")} hint={waitingForStep ? t("autopilot.quick.run.pauseAsked") : undefined} disabled={waitingForStep} />
            </DropdownMenuItem>
            <DropdownMenuItem className={MENU_ITEM} disabled={old || pausePending !== null} onSelect={() => void commands.pause("after-chapter")}>
              <MenuText label={t("autopilot.quick.run.pauseChapter")} hint={old ? tooOld : pausePending !== null ? t("autopilot.quick.run.pauseAsked") : undefined} disabled={old || pausePending !== null} />
            </DropdownMenuItem>
            {pausePending !== null && (
              <DropdownMenuItem className={MENU_ITEM} disabled={old} onSelect={() => void commands.cancelPause()}>
                <MenuText label={t("autopilot.quick.run.pauseCancel")} hint={old ? tooOld : undefined} disabled={old} />
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {model.wait && model.serverRetry && <RetryNow model={model} wait={model.wait} pause={pauseButton} explained={explained} />}
      <Button
        size="sm"
        variant="ghost"
        title={t("autopilot.stopHint")}
        aria-label={named(t("autopilot.actions.stop"))}
        aria-describedby={explained ?? ids.stopHint}
        disabled={pausing || unreachable}
        onClick={() => void commands.stop()}
      >
        {busy === "stop" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Square className="h-4 w-4 fill-current" aria-hidden />}{t("autopilot.actions.stop")}
      </Button>
      <span id={ids.stopHint} className="sr-only">{t("autopilot.stopHint")}</span>
      {trailing}
    </div>
  );
}

function Stopped({ model, profileHintId, runExtra, trailing }: { model: QuickModel; profileHintId?: string; runExtra?: ReactNode; trailing?: ReactNode }) {
  const { t } = useTranslation();
  const { commands, busy, acting, noAi, awaitingPlan, completed, summary, named, ids, variant } = model;
  if (summary.question) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild size="sm">
          <Link to={{ pathname: model.pageHref, hash: "autopilot-question" }} aria-label={named(t("autopilot.quick.run.answer"))}>
            <CircleHelp className="h-4 w-4" aria-hidden />{t("autopilot.quick.run.answer")}
          </Link>
        </Button>
        {trailing}
      </div>
    );
  }
  // A book that is complete has nothing left to run in the live panel; on its page the author adds chapters, in the settings.
  if (completed && variant === "dock") return null;
  // The settings ask for more chapters than the plan has: resuming extends the plan (the engine does it when the run starts), so the main action is to write them.
  const extending = completed && Boolean(model.state?.plan && model.state.brief.targetChapters > model.state.plan.chapters.length);
  // On the page of every book, a book that is complete leads to its result, which its live page shows first.
  if (completed && !extending && variant === "hub") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild size="sm">
          <Link to={model.pageHref} aria-label={named(t("autopilot.hub.openResult"))}>
            <Trophy className="h-4 w-4" aria-hidden />{t("autopilot.hub.openResult")}
          </Link>
        </Button>
        {trailing}
      </div>
    );
  }
  if (completed && !extending) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild size="sm">
          <Link to={{ pathname: autopilotSettingsHref(model.bookId), hash: "autopilot-chapters" }} aria-label={named(t("autopilot.actions.addChapters"))}>
            <Plus className="h-4 w-4" aria-hidden />{t("autopilot.actions.addChapters")}
          </Link>
        </Button>
        {runExtra}
        {trailing}
      </div>
    );
  }
  const old = !model.serverControls;
  const tooOld = t("autopilot.quick.serverTooOld", { version: QUICK_CONTROLS_SERVER_VERSION });
  const blocked = acting || noAi;
  // A run that never started is started, not resumed: the card of the page of every book says it (the page of the book has its own invitation).
  const starting = variant === "hub" && summary.status === "idle";
  const main = extending ? t("autopilot.actions.writeNewChapters") : awaitingPlan ? t("autopilot.actions.approvePlan") : summary.status === "error" ? t("autopilot.actions.retry") : starting ? t("autopilot.actions.start") : t("autopilot.actions.resume");
  const described = [model.profileStop ? profileHintId : undefined, noAi ? ids.noAi : undefined].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" aria-label={named(main)} aria-describedby={described} disabled={blocked} onClick={() => void commands.resume()}>
        {busy === "start" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
        {main}
      </Button>
      {runExtra}
      {!completed && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" aria-label={named(t("autopilot.quick.run.menu"))} aria-describedby={noAi ? ids.noAi : undefined} disabled={blocked}>
              <SkipForward className="h-4 w-4" aria-hidden />{t("autopilot.quick.run.menu")}<ChevronDown className="h-4 w-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className={MENU_CONTENT}>
            <DropdownMenuItem className={MENU_ITEM} disabled={old} onSelect={() => void commands.runOne("step")}>
              <MenuText label={t("autopilot.quick.run.step")} hint={old ? tooOld : undefined} disabled={old} />
            </DropdownMenuItem>
            <DropdownMenuItem className={MENU_ITEM} disabled={old} onSelect={() => void commands.runOne("chapter")}>
              <MenuText label={t("autopilot.quick.run.chapter")} hint={old ? tooOld : undefined} disabled={old} />
            </DropdownMenuItem>
            <DropdownMenuItem className={MENU_ITEM} onSelect={() => void commands.resume()}>
              <MenuText label={t("autopilot.quick.run.untilStopped")} />
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {trailing}
      {noAi && (
        <Reason id={ids.noAi} className="max-w-none">
          {t("autopilot.quick.needsAi")} <Link className="underline" to="/app/settings/ai-integrations">{t("settingsSection.aiIntegrationsTitle")}</Link>
        </Reason>
      )}
    </div>
  );
}
