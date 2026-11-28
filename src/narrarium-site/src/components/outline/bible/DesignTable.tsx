import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { OUTLINE_DESIGN_FIELDS, OUTLINE_DESIGN_KEY_FIELDS, OUTLINE_DESIGN_LABELS, designText, isDesignEmpty, type DesignFinding, type OutlineChapterEntry, type OutlineDesignKey } from "narrarium-engine";
import "@/i18n/bibleStudio";
import "@/i18n/outline";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const KEY = new Set<OutlineDesignKey>(OUTLINE_DESIGN_KEY_FIELDS);

/** What a field of a design holds as one text (`""` for a gap): a list joined, a flag that is on said, the text trimmed. */
export function cellText(entry: OutlineChapterEntry, key: OutlineDesignKey): string {
  const value = entry.design?.[key];
  if (value === undefined || value === null) return "";
  if (typeof value === "boolean") return value ? "✓" : "";
  return Array.isArray(value) ? value.join("; ") : String(value).trim();
}

/** The chapters the filters leave: pure, so that the table and its tests agree. */
export function filterDesigns(entries: readonly OutlineChapterEntry[], findings: readonly DesignFinding[], filters: { search: string; gaps: boolean; findings: boolean; field: OutlineDesignKey | "" }): OutlineChapterEntry[] {
  const withFindings = new Set(findings.map((finding) => finding.chapter).filter((chapter): chapter is number => chapter !== undefined));
  const search = filters.search.trim().toLowerCase();
  return entries.filter((entry) => {
    if (filters.gaps && !OUTLINE_DESIGN_KEY_FIELDS.some((key) => !cellText(entry, key))) return false;
    if (filters.findings && !withFindings.has(entry.number)) return false;
    if (filters.field && cellText(entry, filters.field)) return false;
    if (search && !`${entry.number} ${entry.title} ${designText(entry.design, 100_000)}`.toLowerCase().includes(search)) return false;
    return true;
  });
}

/**
 * The design of every chapter at once: a row for each chapter of the Synopsis and a column for each field of the design, the gaps marked (in words, not only in colour) and
 * the fields every design needs flagged, with filters (a search, only the chapters with a gap in a needed field, only those with a finding, only those missing one field).
 */
export default function DesignTable({ entries, findings, onShowEntry }: { entries: readonly OutlineChapterEntry[]; findings: readonly DesignFinding[]; onShowEntry: (number: number) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const [filters, setFilters] = useState<{ search: string; gaps: boolean; findings: boolean; field: OutlineDesignKey | "" }>({ search: "", gaps: false, findings: false, field: "" });
  const sorted = useMemo(() => [...entries].sort((left, right) => left.number - right.number), [entries]);
  const shown = useMemo(() => filterDesigns(sorted, findings, filters), [sorted, findings, filters]);
  const counts = useMemo(() => {
    const byChapter = new Map<number, number>();
    for (const finding of findings) if (finding.chapter !== undefined) byChapter.set(finding.chapter, (byChapter.get(finding.chapter) ?? 0) + 1);
    return byChapter;
  }, [findings]);
  const anyDesign = sorted.some((entry) => !isDesignEmpty(entry.design));
  const filtered = filters.search || filters.gaps || filters.findings || filters.field;
  const caption = t("bibleStudio.table.caption", { shown: shown.length, total: sorted.length });

  if (!sorted.length || !anyDesign) return <p className="text-sm text-muted-foreground">{t("bibleStudio.table.empty")}</p>;
  return (
    <div className="space-y-3" data-design-table>
      <p className="max-w-3xl text-sm text-muted-foreground">{t("bibleStudio.table.intro")}</p>
      <fieldset className="flex flex-wrap items-end gap-x-4 gap-y-2 rounded-xl border p-3">
        <legend className="px-1 text-xs font-semibold">{t("bibleStudio.table.filters.label")}</legend>
        <div className="space-y-1">
          <Label htmlFor={`${id}-search`} className="text-xs font-medium">{t("bibleStudio.table.filters.search")}</Label>
          <Input id={`${id}-search`} type="search" value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} className="h-9 w-56" />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-field`} className="text-xs font-medium">{t("bibleStudio.table.filters.field")}</Label>
          <select id={`${id}-field`} value={filters.field} onChange={(event) => setFilters({ ...filters, field: event.target.value as OutlineDesignKey | "" })} className="h-9 rounded-md border border-field bg-background px-2 text-sm">
            <option value="">{t("bibleStudio.table.filters.anyField")}</option>
            {OUTLINE_DESIGN_FIELDS.map((field) => <option key={field.key} value={field.key}>{t(`outline.design.fields.${field.key}`, { defaultValue: OUTLINE_DESIGN_LABELS[field.key] })}</option>)}
          </select>
        </div>
        <label className="flex min-h-6 items-center gap-2 text-xs [@media(pointer:coarse)]:min-h-11"><input type="checkbox" checked={filters.gaps} onChange={(event) => setFilters({ ...filters, gaps: event.target.checked })} className="h-4 w-4" />{t("bibleStudio.table.filters.gaps")}</label>
        <label className="flex min-h-6 items-center gap-2 text-xs [@media(pointer:coarse)]:min-h-11"><input type="checkbox" checked={filters.findings} onChange={(event) => setFilters({ ...filters, findings: event.target.checked })} className="h-4 w-4" />{t("bibleStudio.table.filters.findings")}</label>
        {filtered && <Button type="button" size="sm" variant="ghost" onClick={() => setFilters({ search: "", gaps: false, findings: false, field: "" })}>{t("bibleStudio.table.filters.reset")}</Button>}
      </fieldset>
      <p role="status" className="text-xs text-muted-foreground">{caption}</p>
      {shown.length === 0
        ? <p className="text-sm text-muted-foreground">{t("bibleStudio.table.nothing")}</p>
        : (
          <div role="region" tabIndex={0} aria-label={caption} className="max-h-[70vh] overflow-auto rounded-xl border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <table className="w-max min-w-full border-collapse text-xs">
              <caption className="sr-only">{caption}</caption>
              <thead className="sticky top-0 z-10 bg-muted">
                <tr>
                  <th scope="col" className="sticky left-0 z-20 min-w-40 bg-muted p-2 text-left font-semibold">{t("bibleStudio.table.chapter")}</th>
                  {OUTLINE_DESIGN_FIELDS.map((field) => (
                    <th key={field.key} scope="col" data-field={field.key} className="min-w-36 p-2 text-left font-semibold">
                      {t(`outline.design.fields.${field.key}`, { defaultValue: OUTLINE_DESIGN_LABELS[field.key] })}
                      {KEY.has(field.key) && <span className="ml-1 font-normal text-muted-foreground">({t("bibleStudio.table.key")})</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((entry) => (
                  <tr key={entry.number} data-design-row={entry.number} className="border-t align-top">
                    <th scope="row" className="sticky left-0 z-10 bg-background p-2 text-left font-medium">
                      <button type="button" className="inline-flex min-h-6 items-center text-left underline underline-offset-4 [@media(pointer:coarse)]:min-h-11" aria-label={t("bibleStudio.table.show", { number: entry.number })} onClick={() => onShowEntry(entry.number)}>{entry.number}. {entry.title || "—"}</button>
                      {(counts.get(entry.number) ?? 0) > 0 && <span data-design-findings className="mt-0.5 block text-amber-800 dark:text-amber-300">{t("bibleStudio.table.findings", { count: counts.get(entry.number) })}</span>}
                    </th>
                    {OUTLINE_DESIGN_FIELDS.map((field) => {
                      const text = cellText(entry, field.key);
                      const gap = !text && field.kind !== "flag";
                      const label = t(`outline.design.fields.${field.key}`, { defaultValue: OUTLINE_DESIGN_LABELS[field.key] });
                      return (
                        <td key={field.key} data-gap={gap ? (KEY.has(field.key) ? "key" : "yes") : undefined} className={cn("p-2", gap && KEY.has(field.key) && "bg-amber-500/15")}>
                          {text
                            ? <span className="line-clamp-4 whitespace-pre-line" title={text}>{text}</span>
                            : gap ? <span className="text-muted-foreground"><span aria-hidden="true">—</span><span className="sr-only">{t("bibleStudio.table.cell", { field: label, number: entry.number })}: {t("bibleStudio.table.gap")}</span></span> : <span className="text-muted-foreground" aria-hidden="true">·</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}
