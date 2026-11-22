import { useTranslation } from "react-i18next";
import { AlertTriangle, ArrowRightLeft, Check, Flag, Hourglass, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isHandoverCancellable, isHandoverOver, type HandoverPlan } from "@/autopilot/handover";
import type { QuickModel } from "@/components/autopilot/quick/model";
import { Chip } from "@/components/autopilot/quick/parts";
import { cn } from "@/lib/utils";

const PHASE_KEYS: Record<Exclude<HandoverPlan["phase"], "armed" | "running-there">, string> = {
  pausing: "pausing",
  moving: "moving",
  starting: "starting",
  returning: "returning",
  done: "done",
  failed: "failed",
};

/**
 * The second group of the bar: what is pending or going on, one chip each (a pause that waits, the limits of the run, a switch of the autopilot
 * to the other side), in a polite live region that is announced when one changes. It holds nothing that changes with every step, so it is not
 * read out at every event. A switch that waits for the step to end is the reason of the pause after the step: the switch says it, and the pause
 * does not say it a second time.
 */
export function StatusChips({ model }: { model: QuickModel }) {
  const { t } = useTranslation();
  const { commands, named, pausePending, limits, handover, pausing } = model;
  const running = model.control.running;
  return (
    <div role="status" aria-live="polite" aria-atomic="false" className="flex flex-wrap gap-1.5 empty:hidden">
      {running && pausePending && !(pausePending === "after-step" && handover?.phase === "armed") && (
        <Chip
          icon={<Hourglass className="h-3.5 w-3.5" />}
          action={model.unreachable ? undefined : { label: named(t("autopilot.quick.run.pauseCancel")), onClick: () => void commands.cancelPause(), disabled: pausing }}
        >
          {pausePending === "after-step" ? t("autopilot.quick.status.pauseStep") : t("autopilot.quick.status.pauseChapter")}
        </Chip>
      )}
      {running && limits?.steps ? <Chip icon={<Flag className="h-3.5 w-3.5" />}>{t("autopilot.quick.status.stepLimit", { count: limits.steps })}</Chip> : null}
      {running && limits?.chapters ? <Chip icon={<Flag className="h-3.5 w-3.5" />}>{t("autopilot.quick.status.chapterLimit", { count: limits.chapters })}</Chip> : null}
      {handover && <HandoverChip model={model} plan={handover} />}
    </div>
  );
}

function HandoverChip({ model, plan }: { model: QuickModel; plan: HandoverPlan }) {
  const { t } = useTranslation();
  const { commands, named } = model;
  const side = plan.to;
  const base = "autopilot.quick.handover";
  const over = isHandoverOver(plan);
  const text =
    plan.phase === "armed" ? t(`${base}.${plan.returnAfterSteps ? "armedReturn" : "armed"}.${side}`)
    : plan.phase === "running-there" ? t(`${base}.runningThere.${side}`, { count: plan.returnAfterSteps ?? 1 })
    : t(`${base}.${PHASE_KEYS[plan.phase]}.${side}`);
  const icon = plan.phase === "done" ? <Check className="h-3.5 w-3.5" /> : plan.phase === "failed" ? <AlertTriangle className="h-3.5 w-3.5" /> : plan.phase === "armed" ? <ArrowRightLeft className="h-3.5 w-3.5" /> : <Loader2 className="h-3.5 w-3.5 animate-spin" />;
  const action = isHandoverCancellable(plan)
    ? { label: named(t(`${base}.cancel.${side}`)), onClick: () => void commands.cancelHandover() }
    : over
      ? { label: named(t(`${base}.dismiss`)), onClick: () => void commands.dismissHandover() }
      : undefined;
  return <Chip tone={plan.phase === "failed" ? "critical" : plan.phase === "done" ? "ok" : "info"} icon={icon} action={action}>{text}</Chip>;
}

/**
 * A switch that failed: why, where the book is and that nothing was lost, and the way to the flow of “Where it runs” (where the files that
 * changed on both sides are settled, and what is sent to the server is chosen). A book that could not be moved stays where it was, stopped;
 * one that failed after it had moved (it could not start there, the way back failed) is not moved back: it is already on the other side, and
 * the hint says so. The chip above says that it failed; this says why and what to do. On the page it is an alert; in the live panel the chip
 * is announced and the reason is only text, so that the same failure is not announced twice.
 */
export function HandoverFailure({ model }: { model: QuickModel }) {
  const { t } = useTranslation();
  const { handover, commands, named } = model;
  if (handover?.phase !== "failed") return null;
  const base = "autopilot.quick.handover";
  const moved = model.host === handover.to;
  return (
    <div role={model.variant === "page" ? "alert" : undefined} className={cn("space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs")}>
      {handover.error && <p className="break-words font-medium">{handover.error}</p>}
      <p className="text-muted-foreground">{moved ? t(`${base}.failedHintMoved.${handover.to}`) : t(`${base}.failedHint`)}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" aria-label={named(t(`${base}.openWhere`))} onClick={() => model.openWhere(handover.to)}>{t(`${base}.openWhere`)}</Button>
        <Button size="sm" variant="ghost" aria-label={named(t(`${base}.dismiss`))} onClick={() => void commands.dismissHandover()}>{t(`${base}.dismiss`)}</Button>
      </div>
    </div>
  );
}
