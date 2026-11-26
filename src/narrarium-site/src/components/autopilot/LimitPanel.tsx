import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleStop, Coins, Loader2, Play, Repeat } from "lucide-react";
import { REVIEW_MAX_CAMPAIGN_ROUNDS, type AutopilotLimitReached, type AutopilotStateSummary } from "narrarium-engine";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAutopilotActions } from "@/autopilot/useAutopilotActions";
import { formatCost, formatWhole, voteText } from "@/autopilot/format";
import { LIMIT_PANEL_ID, MAX_MONEY_CAP, MAX_TOKEN_CAP, typedNumber } from "@/autopilot/reviewPolicy";
import { BudgetLimitPanel } from "@/components/costs/budget/BudgetLimitPanel";
import { isAppliedCap } from "@/costs/budgetCaps";
import { useCostsStore } from "@/costs/costsStore";
import { usageRows } from "@/costs/legacyCosts";
import { useBudgetLines } from "@/costs/useBudgets";
import { useMoney } from "@/costs/useMoney";
import { cn } from "@/lib/utils";

/** A new cap a person is likely to want: half as much again, rounded up to a figure that reads well (a whole unit of money, a thousand tokens). */
export function suggestedCap(limit: AutopilotLimitReached): number {
  const raised = Math.max(limit.limit * 1.5, limit.used * 1.25, limit.kind === "money" ? 1 : 1000);
  return limit.kind === "money" ? Math.ceil(raised) : Math.ceil(raised / 1000) * 1000;
}

/**
 * When a limit stopped the run (`summary.limitReached`), what it was, with its numbers, and the ways on with one click: the money cap of the book (it never resets: the book's
 * cost over all its runs is compared) and the token cap are raised to a new value, which starts the autopilot again; the rounds of a review of the book allowed since the start
 * are given again for as many more as the author says, which starts it again; and a review of the book can be stopped (cancelled) instead. Nothing when no limit stopped it.
 */
export function LimitPanel({ bookId, summary }: { bookId: string; summary: AutopilotStateSummary }) {
  const { t } = useTranslation();
  const id = useId();
  const { run, busy } = useAutopilotActions(bookId);
  const limit = summary.limitReached;
  const review = summary.campaign?.reason === "review-target" ? summary.campaign.review : undefined;
  const [value, setValue] = useState("");
  // A stop at the cap the budgets gave the autopilot is the budget's: its panel names the budget and raises it (the cap would only be given again at the next start).
  const file = useCostsStore((state) => state.file);
  const display = useMoney().display;
  const rows = useMemo(() => usageRows(file, display), [file, display]);
  const { lines } = useBudgetLines(rows);
  const applied = limit?.kind === "money" ? isAppliedCap(bookId, limit.limit) : null;
  const budgetLine = applied ? lines.find((line) => line.scope === applied.binding.scope && line.bookId === applied.binding.bookId && line.period === applied.binding.period && line.currency === applied.binding.currency) : undefined;
  // The value offered again only for another stop: a summary that arrives while the author types does not take back what was typed.
  const stopKey = limit ? `${limit.kind}|${limit.used}|${limit.limit}|${limit.at}` : "";
  useEffect(() => {
    if (!limit) return;
    setValue(limit.kind === "review-rounds" ? String(limit.limit) : String(suggestedCap(limit)));
    // `stopKey` stands for the stop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopKey]);
  if (!limit || summary.status === "running") return null;
  if (budgetLine) return <BudgetLimitPanel bookId={bookId} summary={summary} line={budgetLine} />;

  const currency = limit.currency ?? summary.stats.currency;
  const typed = typedNumber(value);
  const max = limit.kind === "money" ? MAX_MONEY_CAP : limit.kind === "tokens" ? MAX_TOKEN_CAP : REVIEW_MAX_CAMPAIGN_ROUNDS;
  // A new cap must be over what was used (else the run stops again at once); more rounds, at least one.
  const floor = limit.kind === "review-rounds" ? 1 : limit.used;
  const valid = typed !== null && Number.isFinite(typed) && typed <= max && (limit.kind === "review-rounds" ? Number.isInteger(typed) && typed >= 1 : typed > floor) && (limit.kind !== "tokens" || Number.isInteger(typed));
  const amount = (figure: number) => (limit.kind === "money" ? formatCost(figure, currency) : formatWhole(figure));
  const problem = value.trim() === "" || valid ? null : limit.kind === "review-rounds" ? t("autopilot.limit.problems.rounds", { max }) : t("autopilot.limit.problems.cap", { used: amount(limit.used) });

  const go = () => {
    if (!valid || typed === null) return;
    const options = limit.kind === "money" ? { budgetLimit: typed } : limit.kind === "tokens" ? { budgetTokens: typed } : { review: { campaignMaxRounds: typed } };
    void run("start", (runtime, target) => runtime.start(target, { options }));
  };
  const stop = () => void run("answer", (runtime, target) => runtime.cancelRevisionCampaign(target));

  const Icon = limit.kind === "review-rounds" ? Repeat : Coins;
  return (
    <section id={LIMIT_PANEL_ID} tabIndex={-1} aria-labelledby={`${id}-title`} data-limit-panel={limit.kind} className="space-y-3 rounded-2xl border border-amber-500/50 bg-amber-500/5 p-4 shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <h2 id={`${id}-title`} className="flex items-center gap-2 text-base font-semibold"><Icon className="h-4 w-4 text-amber-800 dark:text-amber-300" aria-hidden="true" />{t(`autopilot.limit.title.${limit.kind}`)}</h2>
      <p className="text-sm">{t(`autopilot.limit.body.${limit.kind}`, { used: amount(limit.used), limit: amount(limit.limit), count: limit.used })}</p>
      {review && (
        <p data-limit-review className="text-sm text-muted-foreground">
          {t("autopilot.limit.review", { round: review.round, target: voteText(review.targetScore), lowest: voteText(review.lowest), book: voteText(review.book) })}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-[10rem] flex-col gap-1">
          <Label htmlFor={`${id}-value`} className="text-xs font-medium">{t(`autopilot.limit.field.${limit.kind}`, { currency })}</Label>
          <Input id={`${id}-value`} type="text" inputMode={limit.kind === "money" ? "decimal" : "numeric"} value={value} onChange={(event) => setValue(event.target.value)} aria-invalid={problem ? true : undefined} aria-describedby={problem ? `${id}-problem` : `${id}-hint`} className={cn("h-9 w-40", problem && "border-destructive")} />
        </div>
        <Button type="button" size="sm" onClick={go} disabled={!valid || busy !== null} data-limit-go="">
          {busy === "start" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}
          {limit.kind === "review-rounds" ? t("autopilot.limit.goRounds", { count: valid && typed !== null ? typed : limit.limit }) : t("autopilot.limit.goCap", { amount: valid && typed !== null ? amount(typed) : "…" })}
        </Button>
        {summary.campaign?.reason === "review-target" && (
          <Button type="button" size="sm" variant="outline" onClick={stop} disabled={busy !== null} data-limit-stop="">
            <CircleStop className="h-4 w-4" aria-hidden="true" />{t("autopilot.limit.stop")}
          </Button>
        )}
      </div>
      {problem ? <p id={`${id}-problem`} className="text-xs font-medium text-destructive">{problem}</p> : <p id={`${id}-hint`} className="text-xs text-muted-foreground">{t(`autopilot.limit.hint.${limit.kind}`)}</p>}
    </section>
  );
}
