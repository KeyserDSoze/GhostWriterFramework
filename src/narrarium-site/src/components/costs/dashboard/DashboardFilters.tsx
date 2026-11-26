import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ALL, activeFilters, type DashboardFilters, type FilterOptions, type PeriodFilter } from "@/costs/dashboardModel";
import { cn } from "@/lib/utils";

const SELECT = "h-9 w-full min-w-0 rounded-md border border-field bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11";

function Field({ id, label, children, className }: { id: string; label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid min-w-0 gap-1", className)}>
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

const pad = (value: number) => String(value).padStart(2, "0");
const dayOf = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/**
 * The filters of the dashboard, in one dense bar: the period (this month, the last 30 days, all time, or from a day to a day), and the book, the use, the
 * task (Brainstorming among them), the model, the integration and the currency. Each lists what the rows have; «All» is every one. On a wide screen they are
 * one row; on a phone only the period is in sight, and «More filters» (with how many are set) opens the rest.
 */
export function DashboardFiltersBar({ filters, options, onChange, bookName, integrationName, compact = false }: {
  filters: DashboardFilters;
  options: FilterOptions;
  onChange: (filters: DashboardFilters) => void;
  bookName: (bookId: string) => string;
  integrationName: (integrationId: string) => string;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [more, setMore] = useState(false);
  const set = <K extends keyof DashboardFilters>(key: K, value: DashboardFilters[K]) => onChange({ ...filters, [key]: value });
  const period = filters.period;
  const setPeriod = (kind: PeriodFilter["kind"]) => {
    if (kind === "custom") {
      const today = new Date();
      set("period", { kind, from: dayOf(new Date(today.getFullYear(), today.getMonth(), 1)), to: dayOf(today) });
    } else set("period", { kind } as PeriodFilter);
  };
  const select = (key: "bookId" | "source" | "capability" | "model" | "integrationId" | "currency", label: string, values: readonly string[], name: (value: string) => string, width: string) => (
    <Field id={`${id}-${key}`} label={label} className={compact ? undefined : width}>
      <select id={`${id}-${key}`} value={filters[key]} onChange={(event) => set(key, event.target.value)} className={SELECT}>
        <option value={ALL}>{t("costs.dashboard.filters.all")}</option>
        {values.map((value) => <option key={value} value={value}>{name(value)}</option>)}
      </select>
    </Field>
  );
  const active = activeFilters(filters);
  const others = (
    <>
      {select("bookId", t("costs.dashboard.filters.book"), options.bookIds, bookName, "w-36")}
      {select("source", t("costs.dashboard.filters.source"), options.sources, (value) => t(`costs.source.${value}`, { defaultValue: value }), "w-28")}
      {select("capability", t("costs.dashboard.filters.capability"), options.capabilities, (value) => t(`routing.task.${value}`, { defaultValue: value }), "w-32")}
      {select("model", t("costs.dashboard.filters.model"), options.models, (value) => value, "w-32")}
      {select("integrationId", t("costs.dashboard.filters.integration"), options.integrationIds, integrationName, "w-28")}
      {select("currency", t("costs.dashboard.filters.currency"), options.currencies, (value) => value, "w-20")}
    </>
  );
  const clear = active > 0 && (
    <Button type="button" variant="ghost" size="sm" className="min-h-11 justify-self-start sm:min-h-9" onClick={() => onChange({ ...filters, bookId: ALL, source: ALL, capability: ALL, model: ALL, integrationId: ALL, currency: ALL })}>
      <X className="mr-1 h-3.5 w-3.5" aria-hidden="true" />{t("costs.dashboard.filters.clear")}{" "}
      <span className="sr-only">({t("costs.dashboard.filters.active", { count: active })})</span>
    </Button>
  );
  const periodFields = (
    <>
      <Field id={`${id}-period`} label={t("costs.dashboard.filters.period")} className={compact ? "col-span-2" : "w-32"}>
        <select id={`${id}-period`} value={period.kind} onChange={(event) => setPeriod(event.target.value as PeriodFilter["kind"])} className={SELECT}>
          {(["month", "30d", "all", "custom"] as const).map((kind) => <option key={kind} value={kind}>{t(`costs.dashboard.filters.periods.${kind}`)}</option>)}
        </select>
      </Field>
      {period.kind === "custom" && (
        <>
          <Field id={`${id}-from`} label={t("costs.dashboard.filters.from")} className={compact ? undefined : "w-36"}>
            <input id={`${id}-from`} type="date" value={period.from} max={period.to} onChange={(event) => set("period", { ...period, from: event.target.value })} className={SELECT} />
          </Field>
          <Field id={`${id}-to`} label={t("costs.dashboard.filters.to")} className={compact ? undefined : "w-36"}>
            <input id={`${id}-to`} type="date" value={period.to} min={period.from} onChange={(event) => set("period", { ...period, to: event.target.value })} className={SELECT} />
          </Field>
        </>
      )}
    </>
  );

  if (!compact) {
    return (
      <section data-dashboard-filters aria-label={t("costs.dashboard.filters.label")} className="flex flex-wrap items-end gap-2">
        {periodFields}
        {others}
        {clear}
      </section>
    );
  }
  return (
    <section data-dashboard-filters aria-label={t("costs.dashboard.filters.label")} className="grid grid-cols-2 items-end gap-2">
      {periodFields}
      <Button type="button" variant="outline" size="sm" className="col-span-2 min-h-11 justify-between" aria-expanded={more} aria-controls={`${id}-more`} onClick={() => setMore((open) => !open)}>
        <span>{t("costs.dashboard.filters.more")}{active > 0 ? ` · ${t("costs.dashboard.filters.active", { count: active })}` : ""}</span>
        <ChevronDown className={cn("h-4 w-4 transition-transform motion-reduce:transition-none", more && "rotate-180")} aria-hidden="true" />
      </Button>
      <div id={`${id}-more`} className={cn("col-span-2 grid grid-cols-2 gap-2", !more && "hidden")}>
        {others}
        {clear && <div className="col-span-2">{clear}</div>}
      </div>
    </section>
  );
}
