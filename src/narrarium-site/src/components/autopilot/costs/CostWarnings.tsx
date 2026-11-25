import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { pickAiRuntimeConfig, resolveAiCandidates } from "narrarium-engine";
import { formatCount } from "@/autopilot/format";
import { PriceFix } from "@/components/autopilot/costs/PriceFix";
import { estimatePhrase } from "@/components/costs/MoneyText";
import type { UsageRow } from "@/costs/ledger";
import { summarize, unpricedModels } from "@/costs/usageViews";
import { useMoney } from "@/costs/useMoney";
import { AUTOPILOT_TASKS } from "@/router/autopilotTasks";
import { useSettingsStore } from "@/store/settingsStore";
import type { AppSettings } from "@/types/settings";
import "@/i18n/costs";

/** A model the autopilot asks, or asked, without a price: with its calls when this browser counted them, `null` when it is only routed to the autopilot. */
export interface UnpricedEntry {
  integrationId: string;
  model: string;
  calls: number | null;
  capability?: string;
}

/** The models of the routes of the autopilot (every agent it asks, fallbacks included) that have no price in the settings: what a run on the server asks too. */
export function routedUnpriced(settings: AppSettings): Array<{ integrationId: string; model: string }> {
  const config = pickAiRuntimeConfig(settings);
  const found = new Map<string, { integrationId: string; model: string }>();
  for (const capability of AUTOPILOT_TASKS) {
    for (const candidate of resolveAiCandidates(config, capability)) {
      if (!candidate.pricing) found.set(`${candidate.integration.id}\u0000${candidate.model}`, { integrationId: candidate.integration.id, model: candidate.model });
    }
  }
  return [...found.values()];
}

/** The models to fix: those this browser counted calls of without a price, the most used first, then those routed to the autopilot without one. */
export function unpricedEntries(rows: readonly UsageRow[], routed: ReadonlyArray<{ integrationId: string; model: string }>): UnpricedEntry[] {
  const counted: UnpricedEntry[] = unpricedModels(rows).map((entry) => ({ ...entry, capability: rows.find((row) => row.model === entry.model && row.integrationId === entry.integrationId)?.capability }));
  const rest = routed.filter((entry) => !counted.some((known) => known.integrationId === entry.integrationId && known.model === entry.model)).map((entry) => ({ ...entry, calls: null }));
  return [...counted, ...rest];
}

/**
 * The calls whose cost the totals cannot be sure of, never hidden: how many have no price and how many have no count of their tokens (the engine's own counts,
 * as the line beside them), in a disclosure that says why, which models have no price (each with its fix: the price typed here, or the way to it), and what the
 * calls without a token count are estimated to have cost, marked as an estimate and never added to the cost. `rows` are the rows of the ledger of the book's
 * autopilot, which this browser recorded.
 */
export function CostWarnings({ usageUnknown, costUnknown, rows }: { usageUnknown: number; costUnknown: number; rows: readonly UsageRow[] }) {
  const { t } = useTranslation();
  const money = useMoney();
  const settings = useSettingsStore((state) => state.settings);
  const routed = useMemo(() => routedUnpriced(settings), [settings]);
  const entries = useMemo(() => unpricedEntries(rows, routed), [rows, routed]);
  const estimate = useMemo(() => summarize(rows, (row) => row.unknownUsageCalls > 0 || row.estimatedCost > 0, money.relabels), [rows, money.relabels]);
  const estimatedTokens = estimate.estimatedInputTokens + estimate.estimatedOutputTokens;
  const estimateText = estimatePhrase(t, money, estimatedTokens > 0 ? formatCount(estimatedTokens) : null, estimate.estimated);
  if (usageUnknown <= 0 && costUnknown <= 0) return null;
  return (
    <details data-cost-warnings className="group basis-full text-muted-foreground">
      <summary className="inline-flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        {usageUnknown > 0 && <span className="inline-flex items-center gap-1 font-medium text-amber-800 dark:text-amber-300"><AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{t("autopilot.progress.usageUnknown", { count: usageUnknown })}</span>}
        {costUnknown > 0 && <span className="inline-flex items-center gap-1 font-medium text-amber-800 dark:text-amber-300"><AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{t("autopilot.progress.costUnknown", { count: costUnknown })}</span>}
        <span className="underline underline-offset-4">{t("costs.fix.why")}</span>
      </summary>
      <div className="mt-1 space-y-2">
        {usageUnknown > 0 && (
          <div className="space-y-0.5">
            <p>{t("autopilot.progress.usageUnknownHint")}</p>
            {estimateText && <p data-cost-estimate className="font-medium text-foreground/80">{t("costs.fix.estimate", { estimate: estimateText })}</p>}
          </div>
        )}
        {costUnknown > 0 && <p>{t("autopilot.progress.costUnknownHint")}</p>}
        {costUnknown > 0 && entries.length > 0 && (
          <div className="space-y-1">
            <p className="font-medium text-foreground/80">{t("costs.fix.models")}</p>
            <ul className="space-y-2">
              {entries.map((entry) => {
                const integration = settings.aiIntegrations.find((candidate) => candidate.id === entry.integrationId);
                return (
                  <li key={`${entry.integrationId}:${entry.model}`} data-unpriced-model={entry.model} className="space-y-1 rounded-md border px-2 py-1.5">
                    <p className="text-foreground">
                      <span className="font-medium">{entry.model}</span>
                      {integration && <span className="text-muted-foreground">{` · ${integration.name}`}</span>}
                      <span className="text-muted-foreground">{` · ${entry.calls === null ? t("costs.fix.routed") : t("costs.figures.calls", { count: entry.calls, value: formatCount(entry.calls) })}`}</span>
                    </p>
                    <PriceFix integrationId={entry.integrationId} model={entry.model} capability={entry.capability} />
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}
