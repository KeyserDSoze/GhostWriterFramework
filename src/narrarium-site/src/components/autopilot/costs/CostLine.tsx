import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { AutopilotActivity } from "narrarium-engine";
import { budgetUse } from "@/autopilot/bandModel";
import { liveStepCost, runCost, runIdOf, type CostView } from "@/autopilot/costModel";
import { formatCost, formatCount } from "@/autopilot/format";
import { useAutopilotStore } from "@/autopilot/store";
import { useTaskCosts } from "@/autopilot/taskCosts";
import type { BandModel } from "@/components/autopilot/AutopilotControlBand";
import { ProgressBar } from "@/components/autopilot/band/parts";
import { CostWarnings } from "@/components/autopilot/costs/CostWarnings";
import { RelabelSuggestion } from "@/components/autopilot/costs/RelabelSuggestion";
import { ServerCurrencyNote } from "@/components/autopilot/costs/ServerCurrencyNote";
import { EstimatedMoney, MoneyText, estimatePhrase } from "@/components/costs/MoneyText";
import { useCostsStore } from "@/costs/costsStore";
import { usageRows } from "@/costs/legacyCosts";
import { moneyKey } from "@/costs/money";
import { localMonth } from "@/costs/period";
import { inMonth, summarize } from "@/costs/usageViews";
import { useMoney } from "@/costs/useMoney";
import { cn } from "@/lib/utils";
import "@/i18n/costs";

const NO_ACTIVITIES: AutopilotActivity[] = [];

/**
 * What the step that runs has spent so far: what this browser recorded of its calls (with, apart, the estimate of the calls whose tokens were not reported),
 * else what the engine says of it (`stepSpendOf`), in the currency the run recorded.
 */
function stepNow(model: BandModel, live: AutopilotActivity | null, view: CostView | null, recorded: string, relabels: ReturnType<typeof useMoney>["relabels"]): { money: CostView["money"]; estimated: CostView["estimated"]; calls: number | null } | null {
  if (view && (view.calls || Object.keys(view.money).length)) return { money: view.money, estimated: view.estimated, calls: view.calls };
  if (!model.stepSpend) return null;
  return { money: { [moneyKey(recorded, live?.startedAt, relabels)]: model.stepSpend.cost }, estimated: {}, calls: null };
}

/**
 * What the autopilot of a book costs, in the band (spec P2): first the line it always had, the autopilot's own count against the budget (its cost, its tokens,
 * its calls, and the calls whose cost or tokens are not known, now with the models to fix and the estimate apart), with what the step that runs has spent so far
 * beside the total; then the book: what this run, this month and every use of the book to date cost (the ledger of this browser and of the devices it syncs
 * with, the Copilot and the other uses included); then, once, the offer to relabel a currency the run recorded by mistake, and for a book on the personal
 * server, that its numbers are the server's and how to send it the currency of the settings. Every amount goes through the one formatter, followed live.
 */
export const CostLine = memo(function CostLine({ model, className }: { model: BandModel; className?: string }) {
  const { t } = useTranslation();
  const money = useMoney();
  const { bookId, summary, host, running } = model;
  const activities = model.activities ?? NO_ACTIVITIES;
  const { stats } = summary;
  const recorded = stats.currency ?? money.display;
  const use = budgetUse(stats, model.state?.options ?? null);
  const tasks = useTaskCosts((state) => state.tasks);
  const live = useAutopilotStore((state) => state.live[bookId]?.activity ?? null);
  const file = useCostsStore((state) => state.file);
  const rows = useMemo(() => usageRows(file, money.display).filter((row) => row.bookId === bookId), [file, money.display, bookId]);
  const autopilotRows = useMemo(() => rows.filter((row) => row.source === "autopilot"), [rows]);
  const month = localMonth(new Date());
  const toDate = useMemo(() => summarize(rows, undefined, money.relabels), [rows, money.relabels]);
  const thisMonth = useMemo(() => summarize(rows, (row) => inMonth(row, month), money.relabels), [rows, month, money.relabels]);
  const runId = runIdOf(summary.runner?.runId, activities);
  const run = useMemo(() => runCost(bookId, runId, activities, running ? live : null, tasks, recorded, money.relabels), [bookId, runId, activities, running, live, tasks, recorded, money.relabels]);
  const step = running ? stepNow(model, live, liveStepCost(bookId, live, tasks, money.relabels), recorded, money.relabels) : null;
  const stepEstimate = step ? estimatePhrase(t, money, null, step.estimated) : "";
  const server = host === "server";
  const costText = (value: number) => formatCost(value, recorded);

  return (
    <>
      <div data-band-usage className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-xs", className)}>
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-muted-foreground">{t("autopilot.band.usage.cost")}</span>
          <span className="font-semibold tabular-nums">
            {use.cost.limit !== null ? t("autopilot.band.usage.costOf", { value: costText(use.cost.value), budget: costText(use.cost.limit) }) : costText(use.cost.value)}
          </span>
          {step && (
            <span data-band-step-cost className="tabular-nums text-muted-foreground">
              ({t("autopilot.band.usage.step", { value: money.totals(step.money, { empty: "—" }) })}{step.calls !== null ? ` · ${t("costs.figures.calls", { count: step.calls, value: formatCount(step.calls) })}` : ""}{stepEstimate ? ` · ${stepEstimate}` : ""})
            </span>
          )}
          {use.cost.limit !== null && use.cost.ratio !== null && <ProgressBar label={t("autopilot.band.usage.costBar")} now={use.cost.value} max={use.cost.limit} valueText={t("autopilot.band.usage.costOf", { value: costText(use.cost.value), budget: costText(use.cost.limit) })} className="w-16" thin />}
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
        <CostWarnings usageUnknown={stats.usageUnknownCalls ?? 0} costUnknown={stats.costUnknownCalls ?? 0} rows={autopilotRows} />
      </div>
      <div data-band-book-costs className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
        <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
          <span className="text-muted-foreground">{t("costs.band.run")}</span>
          <MoneyText totals={run.money} empty="—" className="font-semibold" />
          {run.calls !== null && run.calls > 0 && <span className="tabular-nums text-muted-foreground">{t("costs.figures.calls", { count: run.calls, value: formatCount(run.calls) })}</span>}
          <EstimatedMoney totals={run.estimated} className="text-muted-foreground" />
          {run.source === "autopilot" && <span className="text-muted-foreground">{t(server ? "costs.band.fromServer" : "costs.band.fromAutopilot")}</span>}
        </span>
        <span className="inline-flex items-baseline gap-x-1.5">
          <span className="text-muted-foreground">{t("costs.thisMonth")}</span>
          <MoneyText totals={thisMonth.money} empty="—" className="font-semibold" />
        </span>
        <span className="inline-flex items-baseline gap-x-1.5">
          <span className="text-muted-foreground">{t("costs.band.toDate")}</span>
          <MoneyText totals={toDate.money} empty="—" className="font-semibold" />
        </span>
        {server && <span data-band-server-costs className="basis-full text-muted-foreground">{t("costs.band.serverNote")}</span>}
      </div>
      <RelabelSuggestion recorded={recorded} display={money.display} />
      {server && recorded !== money.display && <ServerCurrencyNote recorded={recorded} currency={money.display} className="basis-full" />}
    </>
  );
});
