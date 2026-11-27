import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2, RotateCcw, X } from "lucide-react";
import "@/i18n/pageCopilot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AssistantAction, PageChangeRow, PageChangesReview as Review } from "@/assistant/store";
import { cn } from "@/lib/utils";

type PageChangesAction = Extract<AssistantAction, { kind: "apply-file-updates" | "undo-file-updates" }> & { review: Review };

export interface PageChangesReviewProps {
  action: PageChangesAction;
  busy: boolean;
  /** The Copilot's tool for this proposal is on, and the proposal is still valid. */
  enabled: boolean;
  onApply: () => void;
  onDiscard: () => void;
  onUndo: () => void;
}

/** The pages whose rows are fields of one thing (the director, a criterion, a fact of an entry): their names are said in the author's language. */
const NAMED_ROWS = new Set(["director", "evaluation-style", "canon"]);

const CHANGE_STYLE: Record<PageChangeRow["change"], string> = {
  created: "text-emerald-800 dark:text-emerald-300",
  edited: "text-sky-800 dark:text-sky-300",
  "turned-on": "text-emerald-800 dark:text-emerald-300",
  "turned-off": "text-amber-800 dark:text-amber-300",
  removed: "text-destructive",
  unchanged: "text-muted-foreground",
};

/**
 * The review of a proposal for a page, before it is applied: every thing of the page (every reader, the built-in ones included) with what it is now, what it
 * will be, and what changes, what changes first. Apply writes it all in one commit; Discard drops it; once applied, Undo puts back what was there. The table
 * is a real table (caption, column and row headers) in a region that the keyboard can scroll; the outcome is announced, and the focus goes to it.
 */
export default function PageChangesReview({ action, busy, enabled, onApply, onDiscard, onUndo }: PageChangesReviewProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const captionId = useId();
  const statusRef = useRef<HTMLParagraphElement | null>(null);
  const applied = action.kind === "undo-file-updates";
  const wasApplied = useRef(applied);
  const [outcome, setOutcome] = useState("");
  const page = action.review.page;
  const rows = action.review.rows;
  const changed = rows.filter((row) => row.change !== "unchanged");
  const count = (change: PageChangeRow["change"]) => rows.filter((row) => row.change === change).length;
  const summary = (["created", "edited", "turned-on", "turned-off", "removed"] as const).filter((change) => count(change) > 0).map((change) => t(`pageCopilot.review.counts.${change}`, { count: count(change) })).join(" · ");
  const switches = rows.some((row) => row.before !== undefined || row.after !== undefined);
  const total = rows.filter((row) => row.after !== null).length;
  const on = rows.filter((row) => row.after === true).length;

  // Applying and undoing are said where the review is, and the focus goes there: the buttons the author pressed are gone.
  useEffect(() => {
    if (applied === wasApplied.current) return;
    wasApplied.current = applied;
    setOutcome(applied ? t("pageCopilot.review.applied", { summary }) : t("pageCopilot.review.undone"));
    statusRef.current?.focus();
  }, [applied, summary, t]);

  const name = (row: PageChangeRow) => (NAMED_ROWS.has(page) ? t(`pageCopilot.review.names.${page}.${row.id}`, { defaultValue: row.name }) : row.name);
  const kind = (value: string) => t(`pageCopilot.review.kinds.${value}`, { defaultValue: t(`readerPersonas.types.${value}`, { defaultValue: value }) });
  const state = (value: boolean | null | undefined) => (value === null || value === undefined ? t("pageCopilot.review.none") : value ? t("pageCopilot.review.on") : t("pageCopilot.review.off"));
  const changeText = (row: PageChangeRow) => {
    const fields = row.fields?.length ? `: ${row.fields.map((field) => t(`pageCopilot.review.fields.${field}`, { defaultValue: field })).join(", ")}` : "";
    const switched = row.change === "edited" && row.before !== row.after && row.before !== undefined ? ` · ${row.after ? t("pageCopilot.review.changes.turned-on") : t("pageCopilot.review.changes.turned-off")}` : "";
    return `${t(`pageCopilot.review.changes.${row.change}`)}${fields}${switched}`;
  };

  return (
    <section aria-labelledby={headingId} data-page-review={page} data-review-state={applied ? "applied" : "pending"} className="mt-2 space-y-2 rounded-xl border bg-muted/30 p-3 text-xs">
      <div className="space-y-0.5">
        <h3 id={headingId} className="text-sm font-semibold">{t(`pageCopilot.review.title.${page}`, { defaultValue: t("pageCopilot.review.title.default") })}</h3>
        <p className="text-muted-foreground">
          {summary || t("pageCopilot.review.nothing")}
          {switches && <> · {t("pageCopilot.review.after", { total, on })}</>}
        </p>
      </div>
      <div role="region" aria-labelledby={captionId} tabIndex={0} className="max-h-80 overflow-auto rounded-lg border bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <table className="w-full border-collapse text-left text-xs">
          <caption id={captionId} className="sr-only">{t("pageCopilot.review.caption", { title: t(`pageCopilot.review.title.${page}`, { defaultValue: t("pageCopilot.review.title.default") }), changed: changed.length, count: rows.length })}</caption>
          <thead className="sticky top-0 bg-muted text-muted-foreground">
            <tr>
              <th scope="col" className="px-2 py-1.5 font-medium">{t(`pageCopilot.review.item.${page}`, { defaultValue: t("pageCopilot.review.item.default") })}</th>
              {switches && <th scope="col" className="px-2 py-1.5 font-medium">{t("pageCopilot.review.state")}</th>}
              <th scope="col" className="px-2 py-1.5 font-medium">{t("pageCopilot.review.change")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} data-change={row.change} className={cn("border-t align-top", row.change !== "unchanged" && "bg-primary/5")}>
                <th scope="row" className="px-2 py-1.5 font-medium">
                  <span className="block">{name(row)}</span>
                  {(row.kind || row.builtin) && <span className="block font-normal text-muted-foreground">{[row.kind ? kind(row.kind) : "", row.builtin ? t("pageCopilot.review.builtin") : ""].filter(Boolean).join(" · ")}</span>}
                </th>
                {switches && (
                  <td className="whitespace-nowrap px-2 py-1.5">
                    {row.before === row.after
                      ? state(row.after)
                      : <>{state(row.before)} <span aria-hidden="true">→</span><span className="sr-only"> {t("pageCopilot.review.becomes")} </span> <span className="font-medium">{state(row.after)}</span></>}
                  </td>
                )}
                <td className={cn("px-2 py-1.5", CHANGE_STYLE[row.change])}>
                  {row.from !== undefined || row.to !== undefined ? <span className="block text-foreground">{row.from ?? ""} <span aria-hidden="true">→</span><span className="sr-only"> {t("pageCopilot.review.becomes")} </span> {row.to ?? ""}</span> : null}
                  <span>{changeText(row)}</span>
                  {row.kept && <span className="block text-muted-foreground">{t("pageCopilot.review.kept")}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {applied ? (
          <>
            <Badge variant="secondary"><Check className="mr-1 h-3.5 w-3.5" aria-hidden="true" />{t("pageCopilot.review.appliedBadge")}</Badge>
            <Button size="sm" variant="outline" onClick={onUndo} disabled={busy || !enabled}>{busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden="true" />}{t("pageCopilot.review.undo")}</Button>
          </>
        ) : (
          <>
            <Button size="sm" onClick={onApply} disabled={busy || !enabled || !changed.length}>{busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Check className="mr-1 h-3.5 w-3.5" aria-hidden="true" />}{t("pageCopilot.review.apply")}</Button>
            <Button size="sm" variant="outline" onClick={onDiscard} disabled={busy}><X className="mr-1 h-3.5 w-3.5" aria-hidden="true" />{t("pageCopilot.review.discard")}</Button>
          </>
        )}
      </div>
      <p ref={statusRef} tabIndex={-1} role="status" className="text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{outcome}</p>
    </section>
  );
}
