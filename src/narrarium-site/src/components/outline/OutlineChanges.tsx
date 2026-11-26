import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRightLeft, CheckCheck, ChevronDown, ChevronUp, FileMinus2, FilePen, FilePlus2, History, Info } from "lucide-react";
import { groupOutlineChanges, type OutlineChangeState } from "narrarium-engine";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatAgo, formatCount, formatDateTime } from "@/autopilot/format";
import { isToldOutcome } from "@/outline/outlineModel";
import type { WhatChanged, WhatChangedOutcome, WhatChangedRow } from "@/outline/whatChanged";

/** The outcomes that are said as a sentence for their chapters together (the engine's rule, grouped as `groupOutlineChanges` groups a series), besides the told ones. */
const GROUP_SENTENCES: readonly WhatChangedOutcome[] = ["replan", "unplan", "stays", "extends"];

/** How a row's outcome reads: what needs the author is amber, what the autopilot already took into account or does by itself is quiet. */
const OUTCOME_TONE: Partial<Record<WhatChangedOutcome, string>> = {
  ask: "text-amber-800 dark:text-amber-300",
  auto: "text-amber-800 dark:text-amber-300",
  notify: "text-foreground",
  later: "text-foreground",
};

function KindIcon({ change }: { change: WhatChangedRow["change"] }) {
  const className = "h-3.5 w-3.5 shrink-0";
  if (change === "created") return <FilePlus2 className={className} aria-hidden="true" />;
  if (change === "moved") return <ArrowRightLeft className={className} aria-hidden="true" />;
  if (change === "removed") return <FileMinus2 className={className} aria-hidden="true" />;
  return <FilePen className={className} aria-hidden="true" />;
}

/** What happened to the entry, in words: «New», «Moved from chapter 4 and changed»… */
export function changeKindText(t: (key: string, options?: Record<string, unknown>) => string, row: Pick<WhatChangedRow, "change" | "from" | "edited">): string {
  if (row.change === "moved") return t(row.edited ? "outline.changes.kind.movedEdited" : "outline.changes.kind.moved", { from: formatCount(row.from ?? 0) });
  return t(`outline.changes.kind.${row.change}`);
}

/**
 * The label of a chapter of the list that changed, for its card: what the autopilot will do (a change it has not followed yet), else what happened. `null`: the card
 * says it already (a chapter planned again has its own status), or nothing is worth a label (what the journal tells as far as it goes back, before any review).
 */
export function changeBadge(t: (key: string, options?: Record<string, unknown>) => string, row: WhatChangedRow, view: Pick<WhatChanged, "since">): string | null {
  if (row.outcome === "replan" || row.outcome === "unplan" || row.outcome === "stays") return null;
  if (row.pending) return t(`outline.changes.badge.${row.outcome}`);
  if (view.since.kind === "always" || !row.fresh) return null;
  return t(`outline.changes.badge.${row.outcome}`);
}

export interface OutlineChangesProps {
  view: WhatChanged;
  /** The state of the book's autopilot as the page read it: the sentences of the groups are the engine's rule on it. */
  autopilot: OutlineChangeState | null;
  /** The Synopsis has no entry left: deleting all of it is not deleting every chapter. */
  outlineEmpty: boolean;
  busy: boolean;
  /** The chapters with an entry on the page: the others have no card to go to. */
  hasEntry: (number: number) => boolean;
  onReveal: (number: number) => void;
  onMarkReviewed: () => void;
}

/**
 * «What changed» on the Synopsis page: the chapters the autopilot has not followed yet and what else changed (see `whatChanged`), each with what happened, who did
 * it, when, and what the autopilot will do about it. The sentences of the groups are the engine's rule, as the page says it after a save. Folded once the author
 * marked everything as reviewed; the summary line still counts what the autopilot has not followed yet.
 */
export function OutlineChanges({ view, autopilot, outlineEmpty, busy, hasEntry, onReveal, onMarkReviewed }: OutlineChangesProps) {
  const { t } = useTranslation();
  const id = useId();
  const listId = `${id}-list`;
  const headingId = `${id}-title`;
  const [open, setOpen] = useState<boolean | null>(null);
  const fresh = view.rows.some((row) => row.fresh && (row.pending || view.since.kind !== "always"));
  const expanded = open ?? fresh;
  const pending = view.rows.filter((row) => row.pending);
  const now = Date.now();
  const say = (key: string, options?: Record<string, unknown>) => t(key, options) as string;

  const told = pending.filter((row) => row.outcome !== "extends");
  const groups = groupOutlineChanges(autopilot, told.map((row) => ({ number: row.number, entry: row.change === "removed" ? "removed" as const : "changed" as const })), { outlineEmpty });
  const extending = pending.filter((row) => row.outcome === "extends").map((row) => row.number);
  const sentences: string[] = [];
  for (const group of groups) {
    const numbers = group.numbers.map(formatCount);
    if (isToldOutcome(group.outcome)) sentences.push(t(`outline.written.${group.outcome}`, { count: group.numbers.length, numbers }));
    else if (GROUP_SENTENCES.includes(group.outcome)) sentences.push(t(`outline.changes.groups.${group.outcome}`, { count: group.numbers.length, numbers }));
  }
  if (extending.length) sentences.push(t("outline.changes.groups.extends", { count: extending.length, numbers: extending.map(formatCount) }));

  const introKey = `outline.changes.intro.${view.mode}.${view.since.kind}`;
  const intro = t(introKey, view.since.kind === "always" ? {} : { date: formatDateTime(view.since.at) });

  return (
    <section aria-labelledby={headingId} data-outline-changes="" className="space-y-3 rounded-2xl border border-layer bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <h2 id={headingId} className="flex flex-wrap items-center gap-2 text-base font-semibold">
            <History className="h-4 w-4 text-primary" aria-hidden="true" />
            {t("outline.changes.title")}
            <Badge variant="outline">{t("outline.changes.count", { count: view.rows.length })}</Badge>
            {pending.length > 0 && view.mode === "plan" && <Badge variant="outline" className="border-amber-500/50 text-amber-900 dark:text-amber-200">{t("outline.changes.pending", { count: pending.length })}</Badge>}
          </h2>
          <p className="max-w-3xl text-sm text-muted-foreground">{intro}</p>
        </div>
        <Button type="button" variant="ghost" size="sm" aria-expanded={expanded} aria-controls={listId} onClick={() => setOpen(!expanded)}>
          {expanded ? <ChevronUp className="h-4 w-4" aria-hidden="true" /> : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
          {expanded ? t("outline.changes.hide") : t("outline.changes.show")}
        </Button>
      </div>

      <div id={listId} hidden={!expanded} className="space-y-3">
        {sentences.length > 0 && (
          <ul className="space-y-1 text-sm">
            {sentences.map((sentence, index) => (
              <li key={index} className="flex items-start gap-1.5"><Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" /><span className="min-w-0">{sentence}</span></li>
            ))}
          </ul>
        )}
        <ol className="space-y-1.5">
          {view.rows.map((row) => {
            const label = `${t("outline.changes.chapter", { number: row.number })}${row.title ? ` — ${row.title}` : ""}`;
            const outcome = t(`outline.changes.outcome.${row.outcome}`);
            return (
              <li key={row.number} data-outline-change={row.number} className="flex flex-col gap-1 rounded-xl border border-layer/70 px-3 py-2 sm:flex-row sm:items-start sm:gap-3">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="text-sm font-medium">
                    {hasEntry(row.number)
                      ? <button type="button" className="inline-flex min-h-6 items-center text-left underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11" aria-label={`${t("outline.changes.goTo", { number: row.number })}${row.title ? ` — ${row.title}` : ""}`} onClick={() => onReveal(row.number)}>{label}</button>
                      : <span>{label}</span>}
                  </p>
                  <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1 font-medium text-foreground"><KindIcon change={row.change} />{changeKindText(say, row)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{row.by ? t(`outline.changes.by.${row.by}`) : t("outline.changes.unknown")}</span>
                    {row.at && (
                      <>
                        <span aria-hidden="true">·</span>
                        <time dateTime={row.at} title={formatDateTime(row.at)}>{formatAgo(now - Date.parse(row.at))}</time>
                      </>
                    )}
                    {row.series > 1 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{t("outline.changes.earlier", { count: row.series - 1 })}</span>
                      </>
                    )}
                  </p>
                </div>
                <p className={`text-xs sm:max-w-[45%] sm:text-right ${OUTCOME_TONE[row.outcome] ?? "text-muted-foreground"}`}>{outcome}</p>
              </li>
            );
          })}
        </ol>
        {view.unreviewed && (
          <div className="flex flex-wrap items-center gap-2">
            {view.unreviewed && (
              <Button type="button" size="sm" variant="outline" onClick={onMarkReviewed} disabled={busy} aria-describedby={`${id}-reviewed-hint`}>
                <CheckCheck className="h-4 w-4" aria-hidden="true" />{t("outline.changes.markReviewed")}
              </Button>
            )}
            {view.unreviewed && <p id={`${id}-reviewed-hint`} className="w-full text-xs text-muted-foreground">{t("outline.changes.markReviewedHint")}</p>}
          </div>
        )}
      </div>
    </section>
  );
}
