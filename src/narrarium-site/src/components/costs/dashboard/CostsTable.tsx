import { Fragment, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, ChevronRight } from "lucide-react";
import { BookSettings } from "@/components/costs/dashboard/BookSettings";
import { BudgetMeter } from "@/components/costs/dashboard/BudgetMeter";
import { Sparkline } from "@/components/costs/dashboard/Sparkline";
import type { BookAutopilot } from "@/components/costs/dashboard/useBookAutopilots";
import { EstimatedMoney, MoneyText } from "@/components/costs/MoneyText";
import type { BudgetLine } from "@/costs/budgets";
import type { DashboardGroup, GroupBy, SortDirection, SortKey } from "@/costs/dashboardModel";
import { useMoney } from "@/costs/useMoney";
import { cn } from "@/lib/utils";
import type { AIIntegration, BookEntry } from "@/types/settings";

export interface TableProps {
  groups: readonly DashboardGroup[];
  by: GroupBy;
  nameOf: (key: string) => string;
  sort: { key: SortKey; direction: SortDirection };
  onSort: (key: SortKey) => void;
  caption: string;
  books: readonly BookEntry[];
  autopilots: Record<string, BookAutopilot>;
  integrations: readonly AIIntegration[];
  /** The limits of the budgets against what was spent: a book's own are in its row, and all of them in its settings. */
  budgetLines: readonly BudgetLine[];
  /** A table on a wide screen; stacked cards on a phone. */
  wide: boolean;
}

function useFigures() {
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language || "en";
  return useMemo(() => {
    const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
    const compact = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });
    return { whole: (value: number) => whole.format(value || 0), compact: (value: number) => compact.format(value || 0) };
  }, [locale]);
}

/** What a book run on the personal server spent by the server's own summary: told apart, never added to the totals of the ledger. */
export function ServerLine({ autopilot }: { autopilot: BookAutopilot | undefined }) {
  const { t } = useTranslation();
  const money = useMoney();
  const figures = useFigures();
  const stats = autopilot?.stats;
  if (!stats) return null;
  return (
    <p data-server-summary className="text-xs font-normal text-muted-foreground">
      {t("costs.dashboard.server.row", {
        spend: money.amount(stats.cost, stats.currency, { zero: "amount" }),
        calls: t("costs.figures.calls", { count: stats.aiCalls, value: figures.whole(stats.aiCalls) }),
        tokens: figures.compact(stats.inputTokens + stats.outputTokens),
      })}
    </p>
  );
}

/** The calls the money of a row cannot be sure of, in words: never hidden. */
function Unknowns({ group }: { group: DashboardGroup }) {
  const { t } = useTranslation();
  const { unpricedCalls, unknownUsageCalls } = group.summary;
  if (!unpricedCalls && !unknownUsageCalls) return null;
  return (
    <span className="ml-auto flex max-w-[15rem] items-start justify-end gap-1 text-right text-xs text-amber-800 dark:text-amber-300">
      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
      <span>{[unpricedCalls ? t("costs.figures.unpriced", { count: unpricedCalls }) : "", unknownUsageCalls ? t("costs.figures.unknownUsage", { count: unknownUsageCalls }) : ""].filter(Boolean).join(" · ")}</span>
    </span>
  );
}

function SortHeader({ column, label, sort, onSort, align = "right" }: { column: SortKey; label: string; sort: TableProps["sort"]; onSort: (key: SortKey) => void; align?: "left" | "right" }) {
  const active = sort.key === column;
  const Icon = !active ? ArrowUpDown : sort.direction === "ascending" ? ArrowUp : ArrowDown;
  return (
    <th scope="col" aria-sort={active ? sort.direction : "none"} className={cn("whitespace-nowrap px-2 py-1.5 font-medium", align === "right" ? "text-right" : "text-left")}>
      <button type="button" onClick={() => onSort(column)} className={cn("inline-flex min-h-6 items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", align === "right" && "flex-row-reverse", active && "text-foreground")}>
        <span>{label}</span>
        <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
      </button>
    </th>
  );
}

/**
 * The rows of the dashboard: a dense table on a wide screen (its headers sort it, `aria-sort` says how), stacked cards on a phone. A row of a book opens
 * the settings of the book at a glance; a book on the personal server says what the server's own summary counts, apart.
 */
export function CostsTable({ groups, by, nameOf, sort, onSort, caption, books, autopilots, integrations, budgetLines, wide }: TableProps) {
  const { t } = useTranslation();
  const figures = useFigures();
  const id = useId();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const bookOf = (key: string) => (by === "books" && key ? books.find((book) => book.id === key) : undefined);
  const toggle = (key: string) => setOpen((current) => ({ ...current, [key]: !current[key] }));
  const nameHeader = t(`costs.dashboard.table.name.${by}`);
  const ownLines = (bookId: string) => budgetLines.filter((line) => line.scope === "book" && line.bookId === bookId);

  const nameCell = (group: DashboardGroup, detailsId: string) => {
    const book = bookOf(group.key);
    const name = nameOf(group.key);
    return (
      <>
        {book ? (
          <button type="button" aria-expanded={Boolean(open[group.key])} aria-controls={detailsId} onClick={() => toggle(group.key)} className="inline-flex min-h-6 items-center gap-1 rounded-sm text-left font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11">
            <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 transition-transform motion-reduce:transition-none", open[group.key] && "rotate-90")} aria-hidden="true" />
            <span className="min-w-0 break-words">{name}</span>{" "}
            <span className="sr-only">— {t("costs.dashboard.table.settingsWord")}</span>
          </button>
        ) : <span className="font-medium">{name}</span>}
        {book?.autopilotHost === "server" && <ServerLine autopilot={autopilots[book.id]} />}
      </>
    );
  };

  if (!wide) {
    return (
      <div className="space-y-2">
        <ul data-costs-cards aria-label={caption} className="space-y-2">
          {groups.map((group, index) => {
            const detailsId = `${id}-details-${index}`;
            const book = bookOf(group.key);
            const { summary } = group;
            return (
              <li key={group.key || "none"} data-costs-row={group.key} className="rounded-xl border bg-card p-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">{nameCell(group, detailsId)}</div>
                  <div className="shrink-0 text-right">
                    <MoneyText totals={summary.money} empty="—" className="block font-semibold" />
                    <EstimatedMoney totals={summary.estimated} className="block text-xs text-muted-foreground" />
                  </div>
                </div>
                <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
                  <div><dt className="text-muted-foreground">{t("costs.dashboard.table.tasks")}</dt><dd className="tabular-nums">{figures.whole(summary.tasks)}</dd></div>
                  <div><dt className="text-muted-foreground">{t("costs.dashboard.table.calls")}</dt><dd className="tabular-nums">{figures.whole(summary.calls)}</dd></div>
                  <div><dt className="text-muted-foreground">{t("costs.dashboard.table.tokens")}</dt><dd className="tabular-nums">{figures.compact(summary.inputTokens + summary.outputTokens)}</dd></div>
                </dl>
                <div className="mt-2 flex flex-wrap items-end justify-between gap-2">
                  <Sparkline points={group.trend} />
                  {book && <BudgetMeter autopilot={autopilots[book.id]} name={book.name} lines={ownLines(book.id)} />}
                </div>
                <Unknowns group={group} />
                {book && open[group.key] && <div id={detailsId} className="mt-2 border-t pt-2"><BookSettings book={book} autopilot={autopilots[book.id]} models={group.models} integrations={integrations} budgetLines={budgetLines} /></div>}
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  const columns = by === "books" ? 7 : 6;
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <table data-costs-table className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
          <tr>
            <SortHeader column="name" label={nameHeader} sort={sort} onSort={onSort} align="left" />
            <SortHeader column="spend" label={t("costs.dashboard.table.spend")} sort={sort} onSort={onSort} />
            <SortHeader column="tasks" label={t("costs.dashboard.table.tasks")} sort={sort} onSort={onSort} />
            <SortHeader column="calls" label={t("costs.dashboard.table.calls")} sort={sort} onSort={onSort} />
            <SortHeader column="tokens" label={t("costs.dashboard.table.tokens")} sort={sort} onSort={onSort} />
            <th scope="col" className="px-2 py-1.5 text-left font-medium">{t("costs.dashboard.table.trend")}</th>
            {by === "books" && <th scope="col" className="px-2 py-1.5 text-left font-medium">{t("costs.dashboard.table.budget")}</th>}
          </tr>
        </thead>
        <tbody>
          {groups.map((group, index) => {
            const detailsId = `${id}-details-${index}`;
            const book = bookOf(group.key);
            const { summary } = group;
            return (
              <Fragment key={group.key || "none"}>
                <tr data-costs-row={group.key} className="border-b last:border-b-0 hover:bg-muted/30">
                  <th scope="row" className="max-w-[18rem] px-2 py-1.5 text-left align-top font-normal">{nameCell(group, detailsId)}</th>
                  <td className="px-2 py-1.5 text-right align-top">
                    <MoneyText totals={summary.money} empty="—" className="whitespace-nowrap font-semibold" />
                    <EstimatedMoney totals={summary.estimated} className="block text-xs text-muted-foreground" />
                    <Unknowns group={group} />
                  </td>
                  <td className="px-2 py-1.5 text-right align-top tabular-nums">{figures.whole(summary.tasks)}</td>
                  <td className="px-2 py-1.5 text-right align-top tabular-nums">{figures.whole(summary.calls)}</td>
                  <td className="px-2 py-1.5 text-right align-top tabular-nums" title={figures.whole(summary.inputTokens + summary.outputTokens)}>{figures.compact(summary.inputTokens + summary.outputTokens)}</td>
                  <td className="px-2 py-1.5 align-middle"><Sparkline points={group.trend} /></td>
                  {by === "books" && <td className="px-2 py-1.5 align-top">{book ? <BudgetMeter autopilot={autopilots[book.id]} name={book.name} lines={ownLines(book.id)} /> : null}</td>}
                </tr>
                {book && open[group.key] && (
                  <tr id={detailsId} className="border-b bg-muted/20">
                    <td colSpan={columns} className="px-3 py-2">
                      <BookSettings book={book} autopilot={autopilots[book.id]} models={group.models} integrations={integrations} budgetLines={budgetLines} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
