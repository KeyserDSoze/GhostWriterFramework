import { useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, CircleDashed } from "lucide-react";
import { readerTargetsFrom, type AutopilotState, type PlannedChapter } from "narrarium-engine";
import { useActiveReaders } from "@/autopilot/useActiveReaders";
import { bookTargets, type TargetRow } from "@/autopilot/resultModel";
import { voteText } from "@/autopilot/format";
import { cn } from "@/lib/utils";
import type { BookStructure } from "@/types/book";

/** Whether the row's target is reached: the vote is at it, and no chapter is under it. A row without a target, or of a reader that does not count, is neither. */
function reached(row: TargetRow): boolean | null {
  if (row.target === null || !row.counts) return null;
  return row.vote !== null && row.vote >= row.target && row.under === 0;
}

/**
 * Where the finished book stands against the targets: the director's (the vote of the whole book, and the chapters under its target), the readers' average (of the last vote the
 * readers gave each chapter) and each reader that has a target or does not count, each with its target, how many chapters are under it and whether it is reached (said in words
 * and with an icon, never by colour alone). It says how many chapters the readers last read before their corrections: the readers' vote of those is of an earlier text, the
 * answer to «the director gave 9 and the readers a low vote».
 */
export function TargetsBlock({ bookId, state, structure }: { bookId: string; state: AutopilotState; structure?: BookStructure }) {
  const { t } = useTranslation();
  const titleId = useId();
  const options = state.options;
  const active = useActiveReaders(bookId, structure, options.maxReaders);
  const targets = useMemo(() => readerTargetsFrom(options.review), [options.review]);
  const chapters: readonly Pick<PlannedChapter, "score" | "rounds">[] = state.plan?.chapters ?? [];
  // The director's target: the policy's, else its approval score (read from its file, so nothing is said before it is).
  const directorTarget = options.review?.targetScore ?? active.director.approvalScore;
  const model = useMemo(() => bookTargets({ chapters, book: state.finalReview?.score ?? null, directorTarget, ...(targets ? { readers: targets } : {}) }), [chapters, state.finalReview?.score, directorTarget, targets]);
  const names = useMemo(() => new Map(active.readers.map((reader) => [reader.slug, reader.name] as const)), [active.readers]);
  if (!active.ready || model.rows.length < 2) return null;

  const subject = (row: TargetRow): string => (row.kind === "director" ? t("autopilot.result.targets.director") : row.kind === "average" ? t("autopilot.result.targets.average") : names.get(row.slug ?? "") ?? row.slug ?? "");
  return (
    <div data-result-targets="" className="min-w-0 space-y-3">
      <h3 id={titleId} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("autopilot.result.targets.title")}</h3>
      <div role="region" aria-labelledby={titleId} tabIndex={0} className="relative overflow-x-auto rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <table aria-labelledby={titleId} className="w-full border-collapse text-sm">
          <caption className="sr-only">{t("autopilot.result.targets.caption")}</caption>
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th scope="col" className="px-2 py-1.5 text-left font-medium">{t("autopilot.result.targets.subject")}</th>
              <th scope="col" className="px-2 py-1.5 text-right font-medium">{t("autopilot.result.targets.now")}</th>
              <th scope="col" className="px-2 py-1.5 text-right font-medium">{t("autopilot.result.targets.target")}</th>
              <th scope="col" className="px-2 py-1.5 text-right font-medium">{t("autopilot.result.targets.chapters")}</th>
              <th scope="col" className="px-2 py-1.5 text-left font-medium">{t("autopilot.result.targets.status")}</th>
            </tr>
          </thead>
          <tbody>
            {model.rows.map((row) => {
              const done = reached(row);
              return (
                <tr key={`${row.kind}:${row.slug ?? ""}`} data-target-row={row.kind === "reader" ? row.slug : row.kind} className="border-b last:border-b-0">
                  <th scope="row" className="min-w-[8rem] px-2 py-1 text-left font-normal">{subject(row)}</th>
                  <td className="px-2 py-1 text-right tabular-nums">{voteText(row.vote)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{row.counts ? (row.target === null ? <span className="text-muted-foreground">{t("autopilot.result.targets.noTarget")}</span> : voteText(row.target)) : <span aria-hidden="true">—</span>}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{row.target === null || !row.counts ? <span aria-hidden="true">—</span> : t("autopilot.result.targets.under", { count: row.under, total: row.of })}</td>
                  <td className="px-2 py-1">
                    {!row.counts
                      ? <span className="text-muted-foreground">{t("autopilot.result.targets.notCounted")}</span>
                      : done === null
                        ? <span aria-hidden="true">—</span>
                        : (
                          <span data-target-status={done ? "reached" : "missed"} className={cn("inline-flex items-center gap-1 font-medium", done ? "text-emerald-800 dark:text-emerald-300" : "text-amber-800 dark:text-amber-300")}>
                            {done ? <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" /> : <CircleDashed className="h-4 w-4 shrink-0" aria-hidden="true" />}
                            {done ? t("autopilot.result.targets.reached") : t("autopilot.result.targets.missed")}
                          </span>
                        )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {model.before > 0 && <p data-targets-before="" className="text-xs font-medium">{t("autopilot.result.targets.before", { count: model.before })}</p>}
      <p className="text-xs text-muted-foreground">{t("autopilot.result.targets.hint")}</p>
    </div>
  );
}
