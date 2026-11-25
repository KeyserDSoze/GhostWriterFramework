import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import type { AutopilotActivity } from "narrarium-engine";
import { stepCost, type CostView } from "@/autopilot/costModel";
import { formatCount } from "@/autopilot/format";
import { useTaskCosts } from "@/autopilot/taskCosts";
import { PriceFix } from "@/components/autopilot/costs/PriceFix";
import { MoneyText, estimatePhrase } from "@/components/costs/MoneyText";
import { useMoney } from "@/costs/useMoney";
import "@/i18n/costs";

/** What a step cost, every attempt of it (retries, and the fallbacks that were billed): from this browser's record of its calls, or the engine's record of it. */
export function useStepCost(attempts: readonly AutopilotActivity[], recordedCurrency: string | undefined): CostView {
  const tasks = useTaskCosts((state) => state.tasks);
  const money = useMoney();
  const currency = recordedCurrency || money.display;
  return useMemo(() => stepCost(undefined, attempts, tasks, currency, money.relabels), [attempts, tasks, currency, money.relabels]);
}

/** «€0.0040 · 3 calls»: the cost of a step on its line, and its calls when this browser counted them. Nothing for a step that spent nothing. */
export function StepCostBadge({ view }: { view: CostView }) {
  const { t } = useTranslation();
  if (view.source === "none") return null;
  return (
    <span data-step-cost className="inline-flex shrink-0 items-center gap-1 text-xs tabular-nums text-muted-foreground">
      <MoneyText totals={view.money} empty="—" />
      {view.calls !== null && view.calls > 0 && <span>{`· ${t("costs.figures.calls", { count: view.calls, value: formatCount(view.calls) })}`}</span>}
      {(view.unpricedCalls > 0 || view.unknownUsageCalls > 0) && (
        <span className="inline-flex items-center text-amber-800 dark:text-amber-300">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="sr-only">{t("costs.step.notKnown")}</span>
        </span>
      )}
    </span>
  );
}

/**
 * What a step cost, in its card: the money (by currency, through the one formatter), the calls with the retries and the fallbacks that were billed, the tokens
 * that were measured, apart from them the estimate of the calls whose tokens were not reported, the models without a price with their fix, and where these
 * numbers come from (this browser's record, the engine's, or the personal server's summary).
 */
export function StepCostFacts({ view, server }: { view: CostView; server: boolean }) {
  const { t } = useTranslation();
  const money = useMoney();
  if (view.source === "none") return null;
  const estimate = estimatePhrase(t, money, view.estimatedTokens > 0 ? formatCount(view.estimatedTokens) : null, view.estimated);
  const tokens = view.inputTokens + view.outputTokens > 0 ? t("costs.step.tokens", { input: formatCount(view.inputTokens), cached: formatCount(view.cachedTokens), output: formatCount(view.outputTokens) }) : "";
  return (
    <div data-step-cost-facts className="space-y-1">
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-medium text-foreground/80">{t("costs.step.cost")}</span>
        <MoneyText totals={view.money} empty="—" className="font-semibold text-foreground" />
        {view.calls !== null && <span className="text-muted-foreground">{t("costs.figures.calls", { count: view.calls, value: formatCount(view.calls) })}</span>}
        {tokens && <span className="text-muted-foreground">{tokens}</span>}
        <span className="text-muted-foreground">{t(view.source === "device" ? "costs.step.fromDevice" : server ? "costs.step.fromServer" : view.source === "mixed" ? "costs.step.fromMixed" : "costs.step.fromAutopilot")}</span>
      </p>
      {view.unknownUsageCalls > 0 && (
        <p className="text-muted-foreground">{t("costs.figures.unknownUsage", { count: view.unknownUsageCalls })}{estimate ? ` · ${estimate}` : ""}</p>
      )}
      {view.unpriced.length > 0 && (
        <div className="space-y-1">
          <p className="text-muted-foreground">{t("costs.figures.unpriced", { count: view.unpricedCalls })}</p>
          <ul className="space-y-1">
            {view.unpriced.map((entry) => (
              <li key={`${entry.integrationId}:${entry.model}`} className="space-y-1">
                <p className="font-medium">{entry.model}</p>
                <PriceFix integrationId={entry.integrationId} model={entry.model} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
