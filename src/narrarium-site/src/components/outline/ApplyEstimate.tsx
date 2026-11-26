import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Gauge, Info } from "lucide-react";
import type { AutopilotActivity, AutopilotState } from "narrarium-engine";
import { Stat, useLocale, useWhyUnknown } from "@/components/autopilot/config/EstimateParts";
import { estimateRest, type RunEstimate } from "@/autopilot/runEstimate";
import { formatMinutes, formatMoney, formatWhole, roundMinutesRange, roundMoneyRange, roundRange } from "@/autopilot/runEstimateFormat";
import { useRunEstimateSources, type RunEstimateInputs } from "@/autopilot/useRunEstimate";
import { useAutopilotStore } from "@/autopilot/store";
import { restEstimateState, rewriteEstimateState } from "@/outline/applyModel";
import type { BookStructure } from "@/types/book";
import type { BookEntry } from "@/types/settings";

const NO_ACTIVITIES: readonly AutopilotActivity[] = [];

export interface ApplyEstimateProps {
  book: BookEntry;
  branch: string;
  structure: BookStructure | undefined;
  state: AutopilotState;
  /** The chapters to rewrite. */
  numbers: readonly number[];
}

function safely(make: () => RunEstimate): RunEstimate | null {
  try {
    return make();
  } catch {
    return null;
  }
}

/**
 * What applying the Synopsis will cost: the chapters to rewrite, as an upper bound (the engine's estimate of writing each anew, which costs at least as much as
 * rewriting the scenes its new entry needs, without the simulated readers a rewrite skips), and then the rest of the plan (the chapters left, the ones the Synopsis
 * adds at the end, the director's judgement of the whole book). The engine's run estimate, with the models, the speeds and the files the setup form reads: the
 * place where the book runs decides which models. Loaded with the panel, never with the page.
 */
export const ApplyEstimate = memo(function ApplyEstimate({ book, branch, structure, state, numbers }: ApplyEstimateProps) {
  const { t } = useTranslation();
  const activities = useAutopilotStore((store) => store.views[book.id]?.snapshot?.activities) ?? NO_ACTIVITIES;
  const inputs = useRunEstimateSources({ book, branch, structure, state, activities });
  const asking = inputs.host === "server" && (inputs.server.status === "idle" || inputs.server.status === "loading");
  const waiting = inputs.reading || asking;
  const key = numbers.join(",");
  const { book: files, ai, language, currency, canonEntries } = inputs.sources;
  /* eslint-disable react-hooks/exhaustive-deps */
  const figures = useMemo(() => {
    if (waiting) return null;
    const chosen = new Set(numbers);
    const highest = (state.plan?.chapters ?? []).reduce((most, chapter) => Math.max(most, chapter.number), 0);
    const outline = inputs.sources.book.outline;
    // The book of the rewrite is the chapters of the plan, the chosen ones still to write: nothing the Synopsis adds at the end, which is the rest's.
    const only = { ...inputs.sources, book: { ...inputs.sources.book, outline: { entries: outline?.entries ?? 0, lastChapter: highest, words: outline?.words ?? 0 } } };
    const rewrite = chosen.size ? safely(() => estimateRest(only, rewriteEstimateState(state, chosen))) : null;
    const rest = safely(() => estimateRest(inputs.sources, restEstimateState(state, chosen.size > 0)));
    return { rewrite, rest: rest && rest.estimate.calls.max > 0 ? rest : null };
  }, [waiting, files, ai, language, currency, canonEntries, state, key]);
  /* eslint-enable react-hooks/exhaustive-deps */

  return (
    <section data-apply-estimate={waiting ? "working" : "ready"} aria-labelledby="outline-apply-estimate-title" className="space-y-3 rounded-xl border border-layer bg-background/60 p-3">
      <h3 id="outline-apply-estimate-title" className="flex items-center gap-2 text-sm font-semibold">
        <Gauge className="h-4 w-4 text-primary" aria-hidden="true" />{t("outline.apply.estimate.title")}
      </h3>
      {waiting || !figures ? (
        <p className="text-sm text-muted-foreground">{t(asking ? "autopilot.estimate.server.asking" : "autopilot.approval.rest.working")}</p>
      ) : (
        <>
          {figures.rewrite && <Figures name="rewrite" heading={t("outline.apply.estimate.rewrite", { count: numbers.length })} result={figures.rewrite} inputs={inputs} />}
          {figures.rest && <Figures name="rest" heading={t("outline.apply.estimate.rest", { count: figures.rest.estimate.chaptersToWrite })} result={figures.rest} inputs={inputs} />}
          {!figures.rewrite && !figures.rest && <p className="text-sm text-muted-foreground">{t("outline.apply.estimate.nothing")}</p>}
          <p className="flex gap-1.5 text-xs text-muted-foreground"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{t("outline.apply.estimate.bound")}</p>
          {inputs.host === "server" && inputs.server.status === "unavailable" && <p className="text-xs text-muted-foreground">{t("autopilot.estimate.server.unavailable")}</p>}
        </>
      )}
    </section>
  );
});

function Figures({ name, heading, result, inputs }: { name: string; heading: string; result: RunEstimate; inputs: RunEstimateInputs }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const { estimate, basis } = result;
  const why = useWhyUnknown(estimate, basis);
  const currency = estimate.cost?.currency || inputs.sources.currency || "USD";
  const whole = (value: number) => formatWhole(value, locale);
  return (
    <div data-apply-figures={name} className="space-y-2">
      <p className="text-sm font-medium">{heading}</p>
      <dl className="grid grid-cols-3 gap-x-4 gap-y-2">
        <Stat name="calls" label={t("autopilot.estimate.stats.calls")} real={estimate.calls} shown={roundRange(estimate.calls)} format={whole} unknown="" />
        <Stat name="cost" label={t("autopilot.estimate.stats.cost")} real={estimate.cost ? { min: estimate.cost.min, max: estimate.cost.max } : null} shown={estimate.cost ? roundMoneyRange(estimate.cost) : null} format={(value) => formatMoney(value, currency, locale)} unknown={t("autopilot.estimate.notKnown")} why={why.cost} />
        <Stat name="minutes" label={t("autopilot.estimate.stats.minutes")} real={estimate.minutes} shown={estimate.minutes ? roundMinutesRange(estimate.minutes) : null} format={(value) => formatMinutes(value, locale)} unknown={t("autopilot.estimate.notEstimated")} why={why.minutes} />
      </dl>
    </div>
  );
}

export default ApplyEstimate;
