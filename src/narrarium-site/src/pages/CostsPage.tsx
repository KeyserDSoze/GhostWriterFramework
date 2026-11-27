import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { AlertTriangle, Coins, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BudgetsPanel } from "@/components/costs/budget/BudgetsPanel";
import { CachePanel } from "@/components/costs/dashboard/CachePanel";
import { CostsTable } from "@/components/costs/dashboard/CostsTable";
import { DashboardFiltersBar } from "@/components/costs/dashboard/DashboardFilters";
import { useBookAutopilots } from "@/components/costs/dashboard/useBookAutopilots";
import { EstimatedMoney, MoneyText } from "@/components/costs/MoneyText";
import { unrecordedCosts } from "@/costs/budgets";
import { useBudgetLines } from "@/costs/useBudgets";
import { useCostsStore } from "@/costs/costsStore";
import { buildGroups, defaultFilters, filterRows, optionsOf, periodRange, sortGroups, todayOf, toCsv, type DashboardFilters, type GroupBy, type SortDirection, type SortKey } from "@/costs/dashboardModel";
import { USAGE_SOURCES } from "@/costs/ledger";
import { EARLIER, usageRows } from "@/costs/legacyCosts";
import { addRecordedMoney, type MoneyTotals } from "@/costs/money";
import { useMoney } from "@/costs/useMoney";
import { summarize } from "@/costs/usageViews";
import { useContainerWidth } from "@/hooks/useContainerWidth";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useSettingsStore } from "@/store/settingsStore";
import "@/i18n/costs";

const GROUPS: readonly GroupBy[] = ["books", "months", "sources"];
/** The room the page needs for its table (seven columns), and for its filters in one row: below them the rows are cards and the filters are folded. */
const TABLE_MIN_WIDTH = 760;
const FILTERS_ROW_MIN_WIDTH = 600;
const SORTS: readonly SortKey[] = ["spend", "name", "tasks", "calls", "tokens"];

/** The order a grouping starts with: the newest month first, the books and the uses that spent most first. */
function firstSort(by: GroupBy): { key: SortKey; direction: SortDirection } {
  return by === "months" ? { key: "name", direction: "descending" } : { key: "spend", direction: "descending" };
}

function download(text: string, name: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * The dashboard of the costs (spec point 4, «una cosa compatta … filtrabile … devo sapere sempre quanto sto spendendo»): every book, month or use in one
 * dense table, filtered by period, book, use, task, model, integration and currency, with the totals always in sight, the trend of each row, the budget of
 * each book's autopilot and its settings at a glance, and the rows as a CSV. Every amount in the currency it was priced in, shown by the one formatter of
 * money: currencies are never added, only converted at a rate of the settings, and marked. What the personal server counts of its books is told apart.
 */
export function CostsPage() {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const file = useCostsStore((state) => state.file);
  const books = useSettingsStore((state) => state.settings.books);
  const integrations = useSettingsStore((state) => state.settings.aiIntegrations);
  // How much room the page has, not how big the screen is: a tablet upright, or a laptop with the sidebar and the dossier open, has less room than its screen.
  const [column, setColumn] = useState<HTMLElement | null>(null);
  const { width } = useContainerWidth(column);
  const screenIsWide = useMediaQuery("(min-width: 640px)");
  const wide = width === null ? screenIsWide : width >= TABLE_MIN_WIDTH;
  const foldFilters = width === null ? !screenIsWide : width < FILTERS_ROW_MIN_WIDTH;
  const today = todayOf();
  const locale = i18n.resolvedLanguage || i18n.language || "en";
  const groupsId = useId();
  const [filters, setFilters] = useState<DashboardFilters>(defaultFilters);
  const [by, setBy] = useState<GroupBy>("books");
  const [sort, setSort] = useState(() => firstSort("books"));
  const [exported, setExported] = useState(false);

  const rows = useMemo(() => usageRows(file, money.display), [file, money.display]);
  const options = useMemo(() => optionsOf(rows, USAGE_SOURCES), [rows]);
  const kept = useMemo(() => filterRows(rows, filters, today), [rows, filters, today]);
  // The history of the rows the other filters keep, whatever the period: what the trend of a row shows.
  const history = useMemo(() => filterRows(rows, { ...filters, period: { kind: "all" } }, today), [rows, filters, today]);
  const totals = useMemo(() => summarize(kept, undefined, money.relabels), [kept, money.relabels]);
  const autopilots = useBookAutopilots(books);
  // The budgets count the autopilot of a book on the personal server by the server's own summary, for what the ledger of this browser does not hold of it.
  const unrecorded = useMemo(
    () => unrecordedCosts(rows, books.filter((book) => book.autopilotHost === "server").flatMap((book) => { const stats = autopilots[book.id]?.stats; return stats ? [{ bookId: book.id, currency: stats.currency || money.display, cost: stats.cost }] : []; })),
    [rows, books, autopilots, money.display],
  );
  const budgets = useBudgetLines(rows, unrecorded);

  const bookName = (bookId: string) => (bookId ? books.find((book) => book.id === bookId)?.name ?? file.books[bookId]?.bookName ?? bookId : t("costs.dashboard.noBook"));
  const integrationName = (integrationId: string) => integrations.find((entry) => entry.id === integrationId)?.name ?? integrationId;
  const monthName = (month: string) => {
    if (month === EARLIER) return t("costs.earlier.title");
    const [year, number] = month.split("-").map(Number);
    return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(new Date(year, number - 1, 1));
  };
  const nameOf = (key: string) => (by === "books" ? bookName(key) : by === "months" ? monthName(key) : t(`costs.source.${key}`, { defaultValue: key }));
  // A month sorts by its date, not by its name in words, and the «earlier» part comes before every month.
  const orderOf = (key: string) => (by === "months" ? (key === EARLIER ? "0000-00" : key) : nameOf(key));
  const groups = useMemo(
    () => sortGroups(buildGroups(kept, history, by, today, money.relabels), sort.key, sort.direction, orderOf, money),
    // `orderOf` reads the books, the language and the grouping: they are in the list, not the function, which is new at every draw.
    [kept, history, by, today, money, sort, books, file.books, locale],
  );

  // What the personal server counts of its books: its own summary, told apart and never added to the ledger. Its count is the autopilot's, which includes the steps
  // of the book that ran in a browser before the book moved to the server, and those are in the ledger of that browser too: adding the two would count them twice.
  const server = useMemo(() => {
    const served = books.filter((book) => book.autopilotHost === "server" && (filters.bookId === "" || filters.bookId === book.id));
    let spend: MoneyTotals = {};
    let count = 0;
    for (const book of served) {
      const stats = autopilots[book.id]?.stats;
      if (!stats) continue;
      count += 1;
      spend = addRecordedMoney(spend, stats.currency || money.display, stats.cost, undefined, money.relabels);
    }
    return { count, spend };
  }, [books, autopilots, filters.bookId, money.display, money.relabels]);

  // Said once the rows settle after a change of the filters or of the rows, never at the first draw.
  const [announced, setAnnounced] = useState("");
  const changed = useRef(false);
  const summaryText = t("costs.dashboard.results", { count: groups.length, spend: money.totals(totals.money, { empty: "—" }) });
  useEffect(() => {
    if (!changed.current) return;
    const timer = window.setTimeout(() => setAnnounced(summaryText), 400);
    return () => window.clearTimeout(timer);
  }, [summaryText]);
  const update = (next: DashboardFilters) => {
    changed.current = true;
    setExported(false);
    setFilters(next);
  };
  const regroup = (next: GroupBy) => {
    changed.current = true;
    setBy(next);
    setSort(firstSort(next));
  };
  const onSort = (key: SortKey) => setSort((current) => (current.key === key ? { key, direction: current.direction === "ascending" ? "descending" : "ascending" } : { key, direction: key === "name" ? "ascending" : "descending" }));

  const range = periodRange(filters.period, today);
  const periodText = filters.period.kind === "custom" && range ? `${range.from} – ${range.to}` : t(`costs.dashboard.filters.periods.${filters.period.kind}`);
  const caption = t("costs.dashboard.table.caption", { rows: t(`costs.dashboard.groupBy.${by}`).toLowerCase(), period: periodText.toLowerCase() });
  const figures = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const compact = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });

  return (
    <div ref={setColumn} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h1 className="flex items-center gap-2 font-serif text-2xl font-semibold"><Coins className="h-5 w-5" aria-hidden="true" />{t("costs.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("costs.dashboard.intro")}</p>
          <p className="text-xs text-muted-foreground">
            {t("costs.shownIn", { currency: money.display })}{" "}
            <Link to="/app/settings/costs" className="font-medium text-primary underline underline-offset-2">{t("costs.changeCurrency")}</Link>
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-9" disabled={!kept.length} aria-describedby={`${groupsId}-export`} onClick={() => { download(toCsv(kept, bookName, integrationName), `narrarium-costs-${today}.csv`); setExported(true); }}>
            <Download className="mr-1 h-4 w-4" aria-hidden="true" />{t("costs.dashboard.export")}
          </Button>
          <p id={`${groupsId}-export`} className="sr-only">{t("costs.dashboard.exportHint")}</p>
          <p role="status" className="text-xs text-muted-foreground">{exported ? t("costs.dashboard.exported") : ""}</p>
        </div>
      </div>

      <DashboardFiltersBar filters={filters} options={options} onChange={update} bookName={bookName} integrationName={integrationName} compact={foldFilters} />

      <section data-costs-totals aria-label={t("costs.dashboard.totals.label")} className="rounded-xl border bg-background/95 px-3 py-2 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:sticky sm:top-0 sm:z-10">
        <dl className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm">
          <div className="flex items-baseline gap-1.5">
            <dt className="text-xs text-muted-foreground">{t("costs.dashboard.totals.spend")}</dt>
            <dd className="flex flex-wrap items-baseline gap-x-1.5">
              <MoneyText totals={totals.money} empty="—" className="text-base font-semibold" />
              <EstimatedMoney totals={totals.estimated} className="text-xs text-muted-foreground" />
            </dd>
          </div>
          <div className="flex items-baseline gap-1.5"><dt className="text-xs text-muted-foreground">{t("costs.dashboard.totals.tasks")}</dt><dd className="tabular-nums">{figures.format(totals.tasks)}</dd></div>
          <div className="flex items-baseline gap-1.5"><dt className="text-xs text-muted-foreground">{t("costs.dashboard.totals.calls")}</dt><dd className="tabular-nums">{figures.format(totals.calls)}</dd></div>
          <div className="flex items-baseline gap-1.5"><dt className="text-xs text-muted-foreground">{t("costs.dashboard.totals.tokens")}</dt><dd className="tabular-nums" title={figures.format(totals.inputTokens + totals.outputTokens)}>{compact.format(totals.inputTokens + totals.outputTokens)}</dd></div>
          {(totals.unpricedCalls > 0 || totals.unknownUsageCalls > 0) && (
            <div className="flex items-baseline gap-1 text-xs text-amber-800 dark:text-amber-300">
              <dt className="sr-only">{t("costs.dashboard.totals.unknown")}</dt>
              <dd className="flex items-start gap-1">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                {[totals.unpricedCalls ? t("costs.figures.unpriced", { count: totals.unpricedCalls }) : "", totals.unknownUsageCalls ? t("costs.figures.unknownUsage", { count: totals.unknownUsageCalls }) : ""].filter(Boolean).join(" · ")}
              </dd>
            </div>
          )}
        </dl>
        {server.count > 0 && <p data-server-totals className="mt-1 text-xs text-muted-foreground">{t("costs.dashboard.server.totals", { count: server.count, spend: money.totals(server.spend, { empty: "—" }) })}</p>}
      </section>

      <CachePanel rows={kept} integrationName={integrationName} relabels={money.relabels} />

      <BudgetsPanel lines={budgets.lines} budgets={budgets.budgets} warnAt={budgets.warnAt} bookName={bookName} currency={money.display} rates={money.rates} serverBooks={books.some((book) => book.autopilotHost === "server")} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <fieldset className="inline-flex rounded-lg border p-0.5">
          <legend className="sr-only">{t("costs.dashboard.groupBy.label")}</legend>
          {GROUPS.map((group) => (
            <label key={group} className="relative">
              <input type="radio" name={`${groupsId}-rows`} value={group} checked={by === group} onChange={() => regroup(group)} className="peer sr-only" />
              <span className="inline-flex min-h-11 cursor-pointer items-center rounded-md px-3 text-sm peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring sm:min-h-8">{t(`costs.dashboard.groupBy.${group}`)}</span>
            </label>
          ))}
        </fieldset>
        {!wide && groups.length > 1 && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            {t("costs.dashboard.table.sortLabel")}
            <select value={sort.key} onChange={(event) => { const key = event.target.value as SortKey; setSort({ key, direction: key === "name" ? (by === "months" ? "descending" : "ascending") : "descending" }); }} className="h-11 rounded-md border border-field bg-background px-2 text-sm text-foreground">
              {SORTS.map((key) => <option key={key} value={key}>{t(`costs.dashboard.table.sorts.${key}`)}</option>)}
            </select>
          </label>
        )}
      </div>

      <p role="status" aria-live="polite" className="sr-only">{announced}</p>

      {groups.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{rows.length === 0 ? t("costs.empty") : t("costs.dashboard.table.emptyFiltered")}</p>
      ) : (
        <CostsTable groups={groups} by={by} nameOf={nameOf} sort={sort} onSort={onSort} caption={caption} books={books} autopilots={autopilots} integrations={integrations} budgetLines={budgets.lines} wide={wide} />
      )}
      <p className="text-xs text-muted-foreground">{t("costs.serverNote")}</p>
    </div>
  );
}
