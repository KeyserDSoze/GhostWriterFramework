import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { AlertTriangle, Coins } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EstimatedMoney, MoneyText, estimatePhrase } from "@/components/costs/MoneyText";
import { useCostsStore } from "@/costs/costsStore";
import { localMonth, USAGE_SOURCES, type UsageRow } from "@/costs/ledger";
import { EARLIER, usageRows } from "@/costs/legacyCosts";
import { emptyBucket, type BookUsage } from "@/costs/model";
import { viewMoney, type MoneyTotals } from "@/costs/money";
import { useMoney } from "@/costs/useMoney";
import { inMonth, summarize, summarizeBy, type UsageSummary } from "@/costs/usageViews";
import { useSettingsStore } from "@/store/settingsStore";
import "@/i18n/costs";

function useNumber() {
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language;
  return useMemo(() => {
    const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
    const hours = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
    return { whole: (value: number) => whole.format(Math.round(value || 0)), hours: (value: number) => hours.format(value || 0) };
  }, [locale]);
}

/** The amount in the display currency that a total comes to, for ordering: what cannot be converted counts after what can. */
function orderValue(totals: MoneyTotals, money: ReturnType<typeof useMoney>): number {
  const view = viewMoney(totals, money);
  return (view.shown?.amount ?? 0) + view.others.reduce((sum, other) => sum + other.amount * 1e-9, 0);
}

/** The figures of a summary in a line: calls, tasks, tokens, and what is not known of them (counted, never hidden). */
function Figures({ summary }: { summary: UsageSummary }) {
  const { t } = useTranslation();
  const number = useNumber();
  const money = useMoney();
  const estimatedTokens = summary.estimatedInputTokens + summary.estimatedOutputTokens;
  const estimate = estimatePhrase(t, money, estimatedTokens > 0 ? number.whole(estimatedTokens) : null, summary.estimated);
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <p className="tabular-nums">
        {[
          summary.calls ? t("costs.figures.calls", { count: summary.calls, value: number.whole(summary.calls) }) : null,
          summary.tasks ? t("costs.figures.tasks", { count: summary.tasks, value: number.whole(summary.tasks) }) : null,
          t("costs.figures.tokens", { input: number.whole(summary.inputTokens), cached: number.whole(summary.cachedTokens), output: number.whole(summary.outputTokens) }),
        ].filter(Boolean).join(" · ")}
      </p>
      {(summary.unpricedCalls > 0 || summary.unknownUsageCalls > 0) && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 font-medium text-amber-800 dark:text-amber-300">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {summary.unpricedCalls > 0 && <span>{t("costs.figures.unpriced", { count: summary.unpricedCalls })}</span>}
          {summary.unknownUsageCalls > 0 && <span>{t("costs.figures.unknownUsage", { count: summary.unknownUsageCalls })}{estimate ? ` (${estimate})` : ""}</span>}
          {summary.unknownUsageCalls <= 0 && <EstimatedMoney totals={summary.estimated} />}
        </p>
      )}
    </div>
  );
}

/** A summary as a row of a list: its name, its money, its figures. */
function SummaryRow({ name, summary }: { name: string; summary: UsageSummary }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 rounded-lg border bg-muted/10 px-3 py-2">
      <div className="min-w-0 flex-1 basis-48">
        <p className="break-words text-sm font-medium">{name}</p>
        <Figures summary={summary} />
      </div>
      <MoneyText totals={summary.money} className="shrink-0 text-sm font-semibold" />
    </li>
  );
}

function BookCard({ bookId, name, rows, legacy, month }: { bookId: string; name: string; rows: UsageRow[]; legacy: BookUsage | undefined; month: string }) {
  const { t } = useTranslation();
  const number = useNumber();
  const { relabels } = useMoney();
  const total = useMemo(() => summarize(rows, undefined, relabels), [rows, relabels]);
  const thisMonth = useMemo(() => summarize(rows, (row) => inMonth(row, month), relabels), [rows, month, relabels]);
  const bySource = useMemo(() => summarizeBy(rows, (row) => (row.writer === EARLIER ? null : row.source), undefined, relabels), [rows, relabels]);
  const earlier = useMemo(() => summarize(rows, (row) => row.writer === EARLIER, relabels), [rows, relabels]);
  const byModel = useMemo(() => summarizeBy(rows, (row) => (row.writer === EARLIER ? null : row.model || null), undefined, relabels), [rows, relabels]);
  const media = { ...emptyBucket(), ...legacy };
  const titleId = `costs-book-${bookId || "none"}`;
  return (
    <Card aria-labelledby={titleId}>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0">
        <CardTitle id={titleId} className="min-w-0 break-words text-base">{name}</CardTitle>
        <div className="text-right">
          <MoneyText totals={total.money} className="text-lg font-semibold" note />
          <p className="text-xs text-muted-foreground">{t("costs.thisMonth")}: <MoneyText totals={thisMonth.money} /></p>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <Figures summary={total} />
        {bySource.size > 0 && (
          <section aria-label={t("costs.bySource")}>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("costs.bySource")}</h3>
            <ul className="space-y-1.5">
              {USAGE_SOURCES.filter((source) => bySource.has(source)).map((source) => <SummaryRow key={source} name={t(`costs.source.${source}`)} summary={bySource.get(source)!} />)}
              {[...bySource.keys()].filter((source) => !(USAGE_SOURCES as readonly string[]).includes(source)).map((source) => <SummaryRow key={source} name={source} summary={bySource.get(source)!} />)}
            </ul>
          </section>
        )}
        {byModel.size > 0 && (
          <section aria-label={t("costs.perModel")}>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("costs.perModel")}</h3>
            <ul className="space-y-1.5">{[...byModel.entries()].sort((left, right) => right[1].calls - left[1].calls).map(([model, summary]) => <SummaryRow key={model} name={model} summary={summary} />)}</ul>
          </section>
        )}
        {earlier.rows > 0 && (
          <section aria-label={t("costs.earlier.title")} className="rounded-lg border border-dashed px-3 py-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-medium">{t("costs.earlier.title")}</h3>
              <MoneyText totals={earlier.money} className="text-sm font-semibold" />
            </div>
            <p className="text-xs text-muted-foreground">{t("costs.earlier.hint")}</p>
          </section>
        )}
        {(media.imageCount > 0 || media.ttsChars > 0 || media.sttHours > 0) && (
          <p className="text-xs text-muted-foreground">{t("costs.mediaDetails", { images: number.whole(media.imageCount), chars: number.whole(media.ttsChars), hours: number.hours(media.sttHours) })}</p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * What the AI calls of every book cost: what this browser knows of them, which is every device it syncs with. Every amount in the currency it was priced
 * in, shown in the currency of the settings where it is that one or has a rate (see `costs/money.ts`); different currencies are never added.
 */
export function CostsPage() {
  const { t } = useTranslation();
  const money = useMoney();
  const file = useCostsStore((s) => s.file);
  const books = useSettingsStore((s) => s.settings.books);
  const rows = useMemo(() => usageRows(file, money.display), [file, money.display]);
  const month = localMonth(new Date());
  const total = useMemo(() => summarize(rows, undefined, money.relabels), [rows, money.relabels]);
  const thisMonth = useMemo(() => summarize(rows, (row) => inMonth(row, month), money.relabels), [rows, month, money.relabels]);
  const bySource = useMemo(() => summarizeBy(rows, (row) => (row.writer === EARLIER ? null : row.source), undefined, money.relabels), [rows, money.relabels]);
  const byBook = useMemo(() => {
    const groups = new Map<string, UsageRow[]>();
    for (const row of rows) groups.set(row.bookId, [...(groups.get(row.bookId) ?? []), row]);
    return [...groups.entries()]
      .map(([bookId, bookRows]) => ({ bookId, rows: bookRows, money: summarize(bookRows, undefined, money.relabels).money }))
      .sort((left, right) => orderValue(right.money, money) - orderValue(left.money, money) || left.bookId.localeCompare(right.bookId));
  }, [rows, money]);
  const nameOf = (bookId: string) => (bookId ? books.find((book) => book.id === bookId)?.name ?? file.books[bookId]?.bookName ?? bookId : t("costs.noBook"));

  return (
    <div className="flex flex-col gap-5">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 font-serif text-2xl font-semibold"><Coins className="h-5 w-5" aria-hidden="true" />{t("costs.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("costs.intro")}</p>
        <p className="text-sm text-muted-foreground">
          {t("costs.shownIn", { currency: money.display })}{" "}
          <Link to="/app/settings/costs" className="font-medium text-primary underline underline-offset-2">{t("costs.changeCurrency")}</Link>
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">{t("costs.grandTotal")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <dl className="grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">{t("costs.toDate")}</dt>
              <dd><MoneyText totals={total.money} className="text-xl font-semibold" note /></dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("costs.thisMonth")}</dt>
              <dd><MoneyText totals={thisMonth.money} className="text-xl font-semibold" note /></dd>
            </div>
          </dl>
          <Figures summary={total} />
          {bySource.size > 0 && (
            <section aria-label={t("costs.bySource")}>
              <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("costs.bySource")}</h2>
              <ul className="space-y-1.5">
                {USAGE_SOURCES.filter((source) => bySource.has(source)).map((source) => <SummaryRow key={source} name={t(`costs.source.${source}`)} summary={bySource.get(source)!} />)}
              </ul>
            </section>
          )}
        </CardContent>
      </Card>

      <div>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{t("costs.perBook")}</h2>
        {byBook.length === 0 ? (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{t("costs.empty")}</p>
        ) : (
          <div className="space-y-3">
            {byBook.map((book) => <BookCard key={book.bookId || "none"} bookId={book.bookId} name={nameOf(book.bookId)} rows={book.rows} legacy={file.books[book.bookId]} month={month} />)}
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">{t("costs.serverNote")}</p>
      </div>
    </div>
  );
}
