import { forwardRef, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AutopilotOptions, AutopilotState, EstimateResult } from "narrarium-engine";
import { BudgetOutlook } from "@/components/costs/budget/BudgetOutlook";
import { outlookOf } from "@/costs/budgetOutlook";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLocale } from "@/components/autopilot/config/EstimateParts";
import { estimateDelta, estimateRun, withoutReaderTargets, type EstimateFigures, type EstimateSources } from "@/autopilot/runEstimate";
import { hasReaderTargets } from "@/autopilot/reviewPolicy";
import { formatMinutes, formatMoney, formatWhole, roundMinutesRange, roundMoneyRange, roundRange, type Range } from "@/autopilot/runEstimateFormat";
import { useBookAutopilotView } from "@/autopilot/hooks";
import { useRunEstimateSources } from "@/autopilot/useRunEstimate";
import type { ReviewProblem } from "@/autopilot/reviewPolicy";
import type { BookStructure } from "@/types/book";
import type { BookEntry } from "@/types/settings";
import { cn } from "@/lib/utils";

/** The parts that the «Review» card of the configuration and the dialog «Review the book again» share: a number that may be left blank, and the estimate in one line. */

export interface OptionalNumberFieldProps {
  id: string;
  label: string;
  value: string;
  /** What a blank field means («7, the director's», «no cap»): shown in the field while it is blank. */
  placeholder: string;
  /** The line that says what the value does: always there, under the field. */
  hint: string;
  /** What is wrong with the value, when it shows. */
  problem?: string | null;
  /** A unit after the field (a currency, «/10»). */
  unit?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  /** Numbers with decimals (a vote, money) or whole ones. */
  decimals?: boolean;
}

/**
 * A number of the review that may be left blank (blank: the default the placeholder says). The text is kept as it is typed, a decimal comma too, and checked by the form,
 * which says what is wrong under the field: nothing is rounded or cut to fit. Its explanation is its description, read with it.
 */
export const OptionalNumberField = forwardRef<HTMLInputElement, OptionalNumberFieldProps>(function OptionalNumberField({ id, label, value, placeholder, hint, problem, unit, disabled, onChange, decimals = false }, ref) {
  const hintId = `${id}-hint`;
  const problemId = `${id}-problem`;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id} className="text-xs font-medium">{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          ref={ref}
          id={id}
          type="text"
          inputMode={decimals ? "decimal" : "numeric"}
          autoComplete="off"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={problem ? true : undefined}
          aria-describedby={[hintId, problem ? problemId : ""].filter(Boolean).join(" ")}
          className={cn("h-9 min-w-0 flex-1", problem && "border-destructive")}
          onChange={(event) => onChange(event.target.value)}
        />
        {unit && <span className="shrink-0 text-xs text-muted-foreground">{unit}</span>}
      </div>
      <p id={hintId} className="text-xs text-muted-foreground">{hint}</p>
      {problem && <p id={problemId} className="text-xs font-medium text-destructive">{problem}</p>}
    </div>
  );
});

/** What is wrong with a field of the review, in words. */
export function useProblemText(): (problem: ReviewProblem | undefined, range: { min: number; max: number }) => string | null {
  const { t } = useTranslation();
  return (problem, range) => (problem ? t(`autopilot.review.problems.${problem}`, range) : null);
}

/** The figures of an estimate in one line, rounded outward as the preview rounds them: the calls, the cost (or that it is not known), the time (or that it is not estimated). */
export function estimateFigures(estimate: EstimateFigures, locale: string, currency: string, words: { to: string; notKnown: string; notEstimated: string }): { calls: string; cost: string; time: string } {
  const range = (value: Range, format: (value: number) => string) => (value.min === value.max ? format(value.min) : `${format(value.min)} ${words.to} ${format(value.max)}`);
  return {
    calls: range(roundRange(estimate.calls), (value) => formatWhole(value, locale)),
    cost: estimate.cost ? range(roundMoneyRange(estimate.cost), (value) => formatMoney(value, estimate.cost?.currency || currency, locale)) : words.notKnown,
    time: estimate.minutes ? range(roundMinutesRange(estimate.minutes), (value) => formatMinutes(value, locale)) : words.notEstimated,
  };
}

/** The estimate in one line, with its label: «About 40 to 90 AI calls · $0.30 to $0.80 · 12 to 30 min». */
export function EstimateLine({ label, estimate, currency, multiplier, extra }: { label: string; estimate: EstimateResult; currency: string; multiplier?: ReactNode; extra?: ReactNode }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const figures = estimateFigures(estimate, locale, currency, { to: t("autopilot.estimate.to"), notKnown: t("autopilot.estimate.notKnown"), notEstimated: t("autopilot.estimate.notEstimated") });
  return (
    <div data-review-estimate className="space-y-1 rounded-lg border bg-muted/30 p-2.5 text-xs">
      <p className="font-medium text-foreground">{label}{multiplier}</p>
      <p className="text-muted-foreground">{t("autopilot.review.estimate.figures", figures)}</p>
      {extra}
    </div>
  );
}

/**
 * The estimate of the run with the values of the form, made by the engine from everything known of the book (its models, its log, its files): what the review card shows
 * once a value of the review changed. The figures are the run's, as the preview of the configuration says them.
 */
export function FormRunEstimate({ book, branch, structure, state, options, brief }: { book: BookEntry; branch: string; structure: BookStructure | undefined; state: AutopilotState | null; options: AutopilotOptions; brief: AutopilotState["brief"] }) {
  const { t } = useTranslation();
  const view = useBookAutopilotView(book.id);
  const inputs = useRunEstimateSources({ book, branch, structure, state, activities: view.snapshot?.activities });
  const { estimate } = useMemo(() => estimateRun(inputs.sources, { brief, options }), [inputs.sources, brief, options]);
  // What the targets for the readers add: the same run without them, taken from this one.
  const aimed = options.readers && hasReaderTargets(options.review);
  const delta = useMemo(() => (aimed ? estimateDelta(estimate, estimateRun(inputs.sources, { brief, options: withoutReaderTargets(options) }).estimate) : null), [aimed, estimate, inputs.sources, brief, options]);
  // A finished book has no run left to estimate: the values are for the chapters still to come and for a review of the book.
  if (estimate.calls.max === 0) return <p data-review-estimate="nothing" className="rounded-lg border bg-muted/30 p-2.5 text-xs text-muted-foreground">{t("autopilot.review.estimate.nothing")}</p>;
  return (
    <>
      <EstimateLine label={t("autopilot.review.estimate.run")} estimate={estimate} currency={sourcesCurrency(inputs.sources)} extra={aimed ? <ReadersDelta delta={delta} currency={sourcesCurrency(inputs.sources)} /> : undefined} />
      <BudgetOutlook bookId={book.id} {...outlookOf(estimate, sourcesCurrency(inputs.sources))} />
    </>
  );
}

/** What the targets for the readers add to the estimate, in one line (or that they add no call): the figures of the run less the figures of the run without them. */
export function ReadersDelta({ delta, currency }: { delta: EstimateFigures | null; currency: string }) {
  const { t } = useTranslation();
  const locale = useLocale();
  if (!delta) return <p data-review-readers-delta="none" className="text-muted-foreground">{t("autopilot.review.readers.deltaNone")}</p>;
  const figures = estimateFigures(delta, locale, currency, { to: t("autopilot.estimate.to"), notKnown: t("autopilot.estimate.notKnown"), notEstimated: t("autopilot.estimate.notEstimated") });
  return <p data-review-readers-delta="" className="font-medium text-foreground">{t("autopilot.review.readers.delta", figures)}</p>;
}

function sourcesCurrency(sources: EstimateSources): string {
  return sources.currency || "USD";
}
