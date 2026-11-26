import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DEFAULT_WARN_AT, MAX_BUDGET, typedAmount, validAmount, type BudgetLimits } from "@/costs/budgets";
import { CURRENCY_CODE } from "@/costs/rates";
import { formatMoney } from "@/costs/money";
import { cn } from "@/lib/utils";

interface Draft {
  currency: string;
  month: string;
  total: string;
}

const SELECT = "h-9 w-full min-w-0 rounded-md border border-field bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11";
const FIELD = "h-9 w-32 text-sm [@media(pointer:coarse)]:h-11";

const text = (value: number | undefined): string => (value === undefined ? "" : String(value));

/** The drafts of the form: one row for each currency with a limit, and one for `suggested` (the currency of the settings) when the scope has none. */
function draftsOf(limits: BudgetLimits, suggested: string): Draft[] {
  const drafts = Object.entries(limits).sort(([left], [right]) => left.localeCompare(right)).map(([currency, limit]) => ({ currency, month: text(limit.month), total: text(limit.total) }));
  return drafts.length ? drafts : [{ currency: suggested, month: "", total: "" }];
}

/** What a draft says as a limit, and whether it can be used: blank is no limit; anything else must be an amount over 0 up to what the engine takes. */
function readDraft(draft: Draft): { month?: number; total?: number; problems: { month?: true; total?: true } } {
  const problems: { month?: true; total?: true } = {};
  const result: { month?: number; total?: number } = {};
  for (const period of ["month", "total"] as const) {
    const value = typedAmount(draft[period]);
    if (value === null) continue;
    if (validAmount(value)) result[period] = value;
    else problems[period] = true;
  }
  return { ...result, problems };
}

/**
 * The form of a budget (spec point 5): for all the books (`bookId` empty) or one book, a limit per month and/or in total in each currency, and, for the budget of all of them, the
 * share it warns at and what counts against it (every use that was recorded, or the autopilot only). A blank field is no limit; a currency with none is dropped. Saving is the
 * person's act: nothing is written while they type.
 */
export function BudgetEditor({ bookId, name, limits, currency, global, onSave, onCancel, autoFocus = false }: {
  bookId: string;
  name: string;
  limits: BudgetLimits;
  /** The currency of the settings: the one a scope with no limit starts with. */
  currency: string;
  global?: { warnAt: number; counts: "all" | "autopilot" };
  onSave: (limits: BudgetLimits, options: { warnAt?: number; counts?: "all" | "autopilot" }) => void;
  onCancel: () => void;
  autoFocus?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const locale = i18n.resolvedLanguage || i18n.language || "en";
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { if (autoFocus) first.current?.focus(); }, [autoFocus]);
  const [drafts, setDrafts] = useState<Draft[]>(() => draftsOf(limits, currency));
  const [adding, setAdding] = useState("");
  const [warn, setWarn] = useState(String(global?.warnAt ?? DEFAULT_WARN_AT));
  const [counts, setCounts] = useState<"all" | "autopilot">(global?.counts ?? "all");
  const readings = useMemo(() => drafts.map(readDraft), [drafts]);
  const warnValue = Number(warn);
  const warnValid = !global || (/^\d{1,2}$/.test(warn.trim()) && warnValue >= 1 && warnValue <= 99);
  const code = adding.trim().toUpperCase();
  const canAdd = CURRENCY_CODE.test(code) && !drafts.some((draft) => draft.currency === code);
  const valid = warnValid && readings.every((reading) => Object.keys(reading.problems).length === 0);
  const hasLimits = readings.some((reading) => reading.month !== undefined || reading.total !== undefined);
  const set = (index: number, patch: Partial<Draft>) => setDrafts((current) => current.map((draft, at) => (at === index ? { ...draft, ...patch } : draft)));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    const next: BudgetLimits = {};
    drafts.forEach((draft, index) => {
      const { month, total } = readings[index];
      if (month !== undefined || total !== undefined) next[draft.currency] = { ...(month !== undefined ? { month } : {}), ...(total !== undefined ? { total } : {}) };
    });
    onSave(next, global ? { warnAt: Number(warn), counts } : {});
  };
  const add = () => {
    if (!canAdd) return;
    setDrafts((current) => [...current, { currency: code, month: "", total: "" }]);
    setAdding("");
  };

  return (
    <form data-budget-editor={bookId || "global"} onSubmit={submit} className="space-y-3 rounded-lg border bg-background p-3" aria-labelledby={`${id}-title`}>
      <div className="space-y-0.5">
        <h3 id={`${id}-title`} className="text-sm font-semibold">{bookId ? t("costs.budget.editor.titleBook", { name }) : t("costs.budget.editor.titleGlobal")}</h3>
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">{t(bookId ? "costs.budget.editor.hintBook" : "costs.budget.editor.hintGlobal")}</p>
      </div>
      <div className="space-y-2" aria-describedby={`${id}-hint`}>
        {drafts.map((draft, index) => {
          const reading = readings[index];
          return (
            <fieldset key={draft.currency} className="flex flex-wrap items-end gap-2">
              <legend className="sr-only">{t("costs.budget.editor.currencyLegend", { currency: draft.currency })}</legend>
              <span aria-hidden="true" className="w-10 pb-2 text-sm font-semibold [@media(pointer:coarse)]:pb-3">{draft.currency}</span>
              {(["month", "total"] as const).map((period) => (
                <div key={period} className="grid gap-1">
                  <Label htmlFor={`${id}-${draft.currency}-${period}`} className="text-xs font-medium">{t(`costs.budget.editor.${period}`, { currency: draft.currency })}</Label>
                  <Input
                    id={`${id}-${draft.currency}-${period}`}
                    type="text"
                    inputMode="decimal"
                    value={draft[period]}
                    placeholder={period === "month" ? "20" : "100"}
                    onChange={(event) => set(index, { [period]: event.target.value })}
                    aria-invalid={reading.problems[period] ? true : undefined}
                    aria-describedby={reading.problems[period] ? `${id}-${draft.currency}-problem` : undefined}
                    className={cn(FIELD, reading.problems[period] && "border-destructive")}
                    ref={index === 0 && period === "month" ? first : undefined}
                  />
                </div>
              ))}
              <Button type="button" variant="ghost" size="icon" className="h-9 w-9 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11" aria-label={t("costs.budget.editor.removeCurrency", { currency: draft.currency })} onClick={() => setDrafts((current) => current.filter((_, at) => at !== index))}>
                <Trash2 className="h-4 w-4 text-destructive" aria-hidden="true" />
              </Button>
              {(reading.problems.month || reading.problems.total) && <p id={`${id}-${draft.currency}-problem`} className="basis-full text-xs font-medium text-destructive">{t("costs.budget.editor.problem", { max: formatMoney(MAX_BUDGET, draft.currency, { locale }) })}</p>}
            </fieldset>
          );
        })}
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1">
            <Label htmlFor={`${id}-add`} className="text-xs font-medium">{t("costs.budget.editor.addCurrency")}</Label>
            <Input id={`${id}-add`} value={adding} onChange={(event) => setAdding(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }} placeholder="EUR" maxLength={3} autoCapitalize="characters" className={cn(FIELD, "w-24 uppercase")} />
          </div>
          <Button type="button" variant="outline" size="sm" className="min-h-9 [@media(pointer:coarse)]:min-h-11" disabled={!canAdd} onClick={add}>
            <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />{t("costs.budget.editor.add")}
          </Button>
        </div>
      </div>
      {global && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1">
            <Label htmlFor={`${id}-warn`} className="text-xs font-medium">{t("costs.budget.editor.warnAt")}</Label>
            <Input id={`${id}-warn`} type="text" inputMode="numeric" value={warn} onChange={(event) => setWarn(event.target.value)} aria-invalid={warnValid ? undefined : true} aria-describedby={`${id}-warn-hint`} className={cn(FIELD, "w-20", !warnValid && "border-destructive")} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`${id}-counts`} className="text-xs font-medium">{t("costs.budget.editor.counts")}</Label>
            <select id={`${id}-counts`} value={counts} onChange={(event) => setCounts(event.target.value as "all" | "autopilot")} className={cn(SELECT, "sm:w-64")}>
              <option value="all">{t("costs.budget.editor.countsAll")}</option>
              <option value="autopilot">{t("costs.budget.editor.countsAutopilot")}</option>
            </select>
          </div>
          <p id={`${id}-warn-hint`} className={cn("basis-full text-xs", warnValid ? "text-muted-foreground" : "font-medium text-destructive")}>{warnValid ? t("costs.budget.editor.warnHint") : t("costs.budget.editor.warnProblem")}</p>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" className="min-h-9 [@media(pointer:coarse)]:min-h-11" disabled={!valid}>{t(hasLimits ? "costs.budget.editor.save" : "costs.budget.editor.saveNone")}</Button>
        <Button type="button" variant="outline" size="sm" className="min-h-9 [@media(pointer:coarse)]:min-h-11" onClick={onCancel}>{t("costs.budget.editor.cancel")}</Button>
      </div>
    </form>
  );
}
