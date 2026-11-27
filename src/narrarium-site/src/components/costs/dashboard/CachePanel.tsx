import { useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { MoneyText } from "@/components/costs/MoneyText";
import { cacheLines, cacheTotals } from "@/costs/cacheModel";
import type { UsageRow } from "@/costs/ledger";
import type { CostRelabel } from "@/types/settings";
import "@/i18n/costs";

/** The lines it lists open in full; more are folded. */
const OPEN_LINES = 5;

/**
 * What the providers' prompt caches did for the rows the filters keep: the share of the input that was served from a cache, and the money that saved against the full input rate, in all and for each
 * model and use. Nothing while there is no input to speak of; a sentence, and where to set the cached price, while no call reported a cached token.
 */
export function CachePanel({ rows, integrationName, relabels }: { rows: readonly UsageRow[]; integrationName: (integrationId: string) => string; relabels?: readonly CostRelabel[] }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const locale = i18n.resolvedLanguage || i18n.language || "en";
  const totals = useMemo(() => cacheTotals(rows, relabels), [rows, relabels]);
  const lines = useMemo(() => cacheLines(rows, relabels), [rows, relabels]);
  if (totals.inputTokens <= 0) return null;
  const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  const count = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });
  const hasSaved = Object.values(totals.saved).some((value) => value > 0);
  const served = lines.filter((line) => line.cachedTokens > 0);
  return (
    <section data-costs-cache aria-labelledby={`${id}-title`} className="rounded-xl border px-3 py-2 text-sm">
      <h2 id={`${id}-title`} className="text-sm font-semibold">{t("costs.cache.title")}</h2>
      {totals.cachedTokens > 0 ? (
        <p data-cache-summary className="mt-1">
          {t("costs.cache.summary", { share: percent.format(totals.share), cached: count.format(totals.cachedTokens), input: count.format(totals.inputTokens) })}{" "}
          {hasSaved ? <>{t("costs.cache.saved")} <MoneyText totals={totals.saved} className="font-semibold" />.</> : t("costs.cache.noSaving")}
        </p>
      ) : (
        <p data-cache-none className="mt-1 text-muted-foreground">
          {t("costs.cache.none")}{" "}
          <Link to="/app/settings/ai-integrations" className="font-medium text-primary underline underline-offset-2">{t("costs.cache.setPrices")}</Link>
        </p>
      )}
      {served.length > 0 && (
        <details open={served.length <= OPEN_LINES} className="mt-1">
          <summary className="flex min-h-11 cursor-pointer items-center text-xs font-medium text-muted-foreground sm:min-h-8">{t("costs.cache.by", { count: served.length })}</summary>
          <ul className="grid gap-1.5">
            {served.map((line) => {
              const saved = Object.values(line.saved).some((value) => value > 0);
              return (
                <li key={`${line.integrationId}\u0000${line.model}\u0000${line.source}`} data-cache-line className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-md bg-muted/30 px-2 py-1">
                  <span className="min-w-0 break-all font-medium">{line.model}</span>
                  <span className="text-xs text-muted-foreground">{[line.integrationId ? integrationName(line.integrationId) : "", t(`costs.source.${line.source}`, { defaultValue: line.source })].filter(Boolean).join(" · ")}</span>
                  <span className="ml-auto tabular-nums">{t("costs.cache.line", { share: percent.format(line.share), cached: count.format(line.cachedTokens), input: count.format(line.inputTokens) })}</span>
                  {saved && <span className="text-xs text-muted-foreground">{t("costs.cache.savedShort")} <MoneyText totals={line.saved} /></span>}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </section>
  );
}
