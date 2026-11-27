import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Loader2, Play } from "lucide-react";
import type { AutopilotErrorDetail } from "narrarium-engine";
import { Button } from "@/components/ui/button";
import { ROUTING_LIMIT_BOUNDS, limitKeyOf, raiseFor, routingBudgetOfError, type RoutingLimitRaise } from "@/assistant/routingLimitRaise";
import { saveRoutingLimitRaise } from "@/assistant/routingLimitSave";
import { formatWhole } from "@/autopilot/format";
import { useSendAiConfiguration } from "@/autopilot/sendAiConfiguration";
import { formatMoney } from "@/costs/money";
import { useSettingsStore } from "@/store/settingsStore";

export const ROUTING_OPTIONS_HREF = "/app/settings/ai-router#routing-options";

/**
 * A step whose first model failed and whose fallbacks a routing limit of the AI Router left out (`detail.budget`, whatever the kind of the failure): which limit, what the fallbacks
 * needed and what the limit allows, where the limit is, and the raise that lets them be tried in one click. The limit is raised in the settings, where the value it replaces is
 * remembered (with «Put back»); a run on the personal server gets the new configuration first, since the server routes with the one it was sent; then the run resumes. The refusal
 * of an older engine (kind `budget`, without the numbers) keeps the words and the way to the limits.
 */
export function RoutingLimitNotice({ detail, ended, host, disabled, resume }: { detail: AutopilotErrorDetail; ended: boolean; host: "browser" | "server"; disabled: boolean; resume: () => Promise<boolean> }) {
  const { t } = useTranslation();
  const settings = useSettingsStore((state) => state.settings);
  const server = useSendAiConfiguration();
  const [raised, setRaised] = useState<RoutingLimitRaise | null>(null);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState("");
  const budget = routingBudgetOfError(detail);
  const open = (
    <Button asChild size="sm" variant="outline">
      <Link to={ROUTING_OPTIONS_HREF}>{t("autopilot.failure.routingLimit.open")}</Link>
    </Button>
  );
  if (!budget) {
    return (
      <div data-routing-limit-notice className="space-y-2 text-sm">
        <p>{t("autopilot.failure.routingLimit.unknown")}</p>
        <div className="flex flex-wrap items-center gap-2">{open}</div>
      </div>
    );
  }
  const key = limitKeyOf(budget);
  const value = (amount: number) => (budget.limit === "tokens" ? formatWhole(amount) : formatMoney(amount, settings.costCurrency || "USD"));
  const current = settings.routingExecution[key];
  const raise = ended ? raiseFor(budget, settings.routingExecution) : null;
  const holds = current >= budget.estimated;

  async function raiseAndResume() {
    if (!raise || working) return;
    setWorking(true);
    setProblem("");
    try {
      await saveRoutingLimitRaise(raise);
      setRaised(raise);
      if (host === "server" && !(await server.send())) {
        setProblem(t("autopilot.failure.routingLimit.serverFailed"));
        return;
      }
      await resume();
    } finally {
      setWorking(false);
    }
  }

  return (
    <div data-routing-limit-notice data-limit={key} className="space-y-2 text-sm">
      <p>{t(`autopilot.failure.routingLimit.${budget.limit}`, { estimated: value(budget.estimated), allowed: value(budget.allowed), field: t(`routing.${key}`) })}</p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {[["estimated", budget.estimated], ["allowed", budget.allowed]].map(([label, amount]) => (
          <Fragment key={label as string}>
            <dt className="text-muted-foreground">{t(`autopilot.failure.routingLimit.${label}`)}</dt>
            <dd className="font-medium tabular-nums" data-routing-limit-value={label}>{value(amount as number)}</dd>
          </Fragment>
        ))}
      </dl>
      {!raised && !raise && (holds
        ? <p data-routing-limit-holds>{t("autopilot.failure.routingLimit.nowHolds", { value: value(current) })}</p>
        : budget.estimated > ROUTING_LIMIT_BOUNDS[key].max && <p data-routing-limit-too-high>{t("autopilot.failure.routingLimit.tooHigh", { max: value(ROUTING_LIMIT_BOUNDS[key].max) })}</p>)}
      <div className="flex flex-wrap items-center gap-2">
        {raise && (
          <Button size="sm" data-routing-limit-raise disabled={disabled || working} onClick={() => void raiseAndResume()}>
            {working ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}
            {t("autopilot.failure.routingLimit.raiseAndResume", { value: value(raise.to) })}
          </Button>
        )}
        {open}
      </div>
      {raise && <p className="text-xs text-muted-foreground">{t("autopilot.failure.routingLimit.raiseHint", { from: value(raise.from) })}</p>}
      <p role="status" data-routing-limit-status className={raised || problem ? "text-xs font-medium" : "sr-only"}>
        {raised ? t("autopilot.failure.routingLimit.raisedRun", { from: value(raised.from), to: value(raised.to) }) : ""}
        {problem ? ` ${problem}` : ""}
      </p>
    </div>
  );
}
