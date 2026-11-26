import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Compass } from "lucide-react";
import { OUTLINE_DESIGN_FIELDS, type OutlineChapterDesign, type OutlineDesignKey } from "narrarium-engine";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { designDraftOf, designOfDraft, filledDesignFields, type DesignDraft } from "@/outline/designModel";
import { cn } from "@/lib/utils";

/** The fields written on one line; the others are texts of several lines (a list: one item per line). */
const SHORT: ReadonlySet<OutlineDesignKey> = new Set(["setting", "time"]);

/**
 * The design of an entry (`design:`): closed, a line that says how much of it there is; open, its fields, each named with its chapter for a screen reader. A list is
 * a line per item. What the author types is a draft of the entry, saved with its text.
 */
export function DesignSection({ number, design, draft, onChange, busy }: { number: number; design: OutlineChapterDesign | undefined; draft: DesignDraft | undefined; onChange: (draft: DesignDraft) => void; busy?: boolean }) {
  const { t } = useTranslation();
  const id = useId();
  const [open, setOpen] = useState(false);
  const values = draft ?? designDraftOf(design);
  const filled = filledDesignFields(draft ? designOfDraft(draft) : design);
  const panelId = `${id}-design`;
  const set = (key: OutlineDesignKey, value: string | boolean) => onChange({ ...values, [key]: value });
  return (
    <div data-outline-design={number} className="rounded-xl border border-dashed border-layer">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((now) => !now)}
        className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-medium hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9"
      >
        {open ? <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" /> : <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />}
        <Compass className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <span>{t("outline.design.toggle", { number })}</span>
        <span className="ml-auto text-xs font-normal text-muted-foreground">{filled ? t("outline.design.filled", { count: filled, total: OUTLINE_DESIGN_FIELDS.length }) : t("outline.design.empty")}</span>
      </button>
      {open && (
        <div id={panelId} className="grid gap-3 border-t px-3 pb-3 pt-3 md:grid-cols-2">
          <p className="text-xs text-muted-foreground md:col-span-2">{t("outline.design.intro")}</p>
          {OUTLINE_DESIGN_FIELDS.map(({ key, kind }) => {
            const fieldId = `${id}-${key}`;
            const label = t(`outline.design.fields.${key}`);
            const name = t("outline.design.fieldOf", { field: label, number });
            if (kind === "flag") {
              return (
                <label key={key} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm md:col-span-2 sm:min-h-8">
                  <input type="checkbox" className="h-4 w-4 accent-primary" checked={values[key] === true} disabled={busy} aria-label={name} onChange={(event) => set(key, event.target.checked)} />
                  {label}
                </label>
              );
            }
            const value = typeof values[key] === "string" ? (values[key] as string) : "";
            return (
              <div key={key} className={cn("space-y-1", (key === "goal" || key === "notes" || key === "events" || key === "scenes") && "md:col-span-2")}>
                <Label htmlFor={fieldId} className="text-xs text-muted-foreground">{label}{kind === "list" && <span className="font-normal"> · {t("outline.design.onePerLine")}</span>}</Label>
                {SHORT.has(key)
                  ? <Input id={fieldId} aria-label={name} value={value} disabled={busy} onChange={(event) => set(key, event.target.value)} className="h-9" />
                  : <AutoTextarea id={fieldId} aria-label={name} value={value} minRows={kind === "list" ? 2 : 1} maxHeight={320} disabled={busy} onChange={(event) => set(key, event.target.value)} className="text-sm leading-6" />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
