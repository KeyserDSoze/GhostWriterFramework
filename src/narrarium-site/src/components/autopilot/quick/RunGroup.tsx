import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { ChevronDown, CircleHelp, Loader2, Pause, Play, SkipForward, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { QUICK_CONTROLS_SERVER_VERSION } from "@/autopilot/quickControls";
import type { QuickModel } from "@/components/autopilot/quick/model";
import { MENU_CONTENT, MENU_ITEM, MenuText, Reason } from "@/components/autopilot/quick/parts";

/**
 * The first group of the bar: what runs. A run that goes on has a pause (after the step, which is what a click does, or at the end of the
 * chapter, or taken back) and a stop. One that is stopped has Resume and a menu to run one step, one chapter, or until the author stops it.
 */
export function RunGroup({ model, profileHintId }: { model: QuickModel; profileHintId?: string }) {
  return model.control.running ? <Running model={model} /> : <Stopped model={model} profileHintId={profileHintId} />;
}

function Running({ model }: { model: QuickModel }) {
  const { t } = useTranslation();
  const { commands, busy, pausing, unreachable, pausePending, named, ids } = model;
  const explained = unreachable ? ids.remote : undefined;
  // The pause after the step is already asked for: asking again changes nothing, and the button says it waits.
  const waitingForStep = pausePending === "after-step";
  const old = !model.serverControls;
  const tooOld = t("autopilot.quick.serverTooOld", { version: QUICK_CONTROLS_SERVER_VERSION });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex">
        <Button
          size="sm"
          variant="outline"
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
              variant="outline"
              className="rounded-l-none border-l-0 px-2"
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
      <Button
        size="sm"
        variant="ghost"
        title={t("autopilot.stopHint")}
        aria-label={named(t("autopilot.actions.stop"))}
        aria-describedby={explained ?? ids.stopHint}
        disabled={pausing || unreachable}
        onClick={() => void commands.stop()}
      >
        {busy === "stop" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Square className="h-4 w-4" aria-hidden />}{t("autopilot.actions.stop")}
      </Button>
      <span id={ids.stopHint} className="sr-only">{t("autopilot.stopHint")}</span>
    </div>
  );
}

function Stopped({ model, profileHintId }: { model: QuickModel; profileHintId?: string }) {
  const { t } = useTranslation();
  const { commands, busy, acting, noAi, awaitingPlan, completed, summary, named, ids, variant } = model;
  if (summary.question) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild size="sm" variant="outline">
          <Link to={{ pathname: model.pageHref, hash: "autopilot-question" }} aria-label={named(t("autopilot.quick.run.answer"))}>
            <CircleHelp className="h-4 w-4" aria-hidden />{t("autopilot.quick.run.answer")}
          </Link>
        </Button>
      </div>
    );
  }
  // A book that is complete has nothing left to run in the live panel; on its page the author may have asked for more chapters.
  if (completed && variant === "dock") return null;
  const old = !model.serverControls;
  const tooOld = t("autopilot.quick.serverTooOld", { version: QUICK_CONTROLS_SERVER_VERSION });
  const blocked = acting || noAi;
  const described = [model.profileStop ? profileHintId : undefined, noAi ? ids.noAi : undefined].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant={completed ? "outline" : "default"} aria-label={named(awaitingPlan ? t("autopilot.actions.approvePlan") : t("autopilot.actions.resume"))} aria-describedby={described} disabled={blocked} onClick={() => void commands.resume()}>
        {busy === "start" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
        {awaitingPlan ? t("autopilot.actions.approvePlan") : t("autopilot.actions.resume")}
      </Button>
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
      {noAi && (
        <Reason id={ids.noAi} className="max-w-none">
          {t("autopilot.quick.needsAi")} <Link className="underline" to="/app/settings/ai-integrations">{t("settingsSection.aiIntegrationsTitle")}</Link>
        </Reason>
      )}
    </div>
  );
}
