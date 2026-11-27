import type { Ref } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { OptionalNumberField } from "@/components/autopilot/review/ReviewFields";
import type { ActiveReader } from "@/autopilot/useActiveReaders";
import { REVIEW_TARGETS_SERVER_VERSION, READER_TARGET_MAX, READER_TARGET_MIN } from "@/autopilot/reviewPolicy";
import { cn } from "@/lib/utils";

export interface ReaderTargetsFieldsProps {
  /** The start of the ids of the fields: the card and the dialog each have their own. */
  id: string;
  /** The readers that read the book in a run, with the weights the director gives them. */
  readers: readonly ActiveReader[];
  /** The files that say who the readers are are being read. */
  loading: boolean;
  /** The simulated readers do not read in this book: no target of theirs can be reached. */
  readersOff: boolean;
  /** The personal server that runs the book predates the targets: it would ignore them. */
  unsupported: boolean;
  /** Nothing can be edited (a run goes on, or the policy is not the author's to change here). */
  disabled: boolean;
  /** What is typed: the average, the target of each reader by its slug, and the readers that do not count. */
  average: string;
  targets: Readonly<Record<string, string>>;
  excluded: readonly string[];
  /** What is wrong with a value, in words, when it shows. */
  averageProblem: string | null;
  readerProblems: Readonly<Record<string, string>>;
  onAverage: (value: string) => void;
  onTarget: (slug: string, value: string) => void;
  onCounts: (slug: string, counts: boolean) => void;
  /** Where the focus goes when the average has something wrong (the card does it). */
  averageRef?: Ref<HTMLInputElement>;
  /** The level of the heading under the one of the card or the dialog. */
  headingLevel?: 3 | 4;
}

/**
 * The targets for the readers, in the Review tab of the configuration and in «Review the book again»: the average of the readers that count, and a table with each active reader
 * of the book: the weight the director gives it (read only: it is its profile's), the vote it must reach and whether it counts in the average and in the targets. Each
 * field says in a line what it does. A reader that does not count keeps its row (it is still read and shown), and its target is not asked of it. Nothing here is
 * edited when the readers do not read, when none is active, or when the personal server would ignore it: the part says why instead.
 */
export function ReaderTargetsFields(props: ReaderTargetsFieldsProps) {
  const { id, readers, loading, readersOff, unsupported, disabled, average, targets, excluded, averageProblem, readerProblems, onAverage, onTarget, onCounts, averageRef, headingLevel = 3 } = props;
  const { t } = useTranslation();
  const Heading = headingLevel === 3 ? "h3" : "h4";
  const headingId = `${id}-readers-title`;
  const stopped = readersOff || unsupported;
  const empty = !loading && readers.length === 0;
  const off = disabled || stopped || empty;
  const left = new Set(excluded);
  return (
    <section data-reader-targets="" aria-labelledby={headingId} className="space-y-3 rounded-lg border p-3">
      <div className="space-y-1">
        <Heading id={headingId} className="text-sm font-semibold">{t("autopilot.review.readers.title")}</Heading>
        <p className="text-xs text-muted-foreground">{t("autopilot.review.readers.intro")}</p>
      </div>
      {unsupported && <p data-review-old-server-targets="" className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-2 text-xs font-medium">{t("autopilot.review.readers.oldServer", { version: REVIEW_TARGETS_SERVER_VERSION })}</p>}
      {readersOff && <p data-readers-off="" className="text-xs font-medium">{t("autopilot.review.readers.off")}</p>}
      {!readersOff && empty && <p data-readers-none="" className="text-xs font-medium">{t("autopilot.review.readers.none")}</p>}
      <OptionalNumberField
        ref={averageRef}
        id={`${id}-average`}
        label={t("autopilot.review.readers.average.label")}
        value={average}
        placeholder={t("autopilot.review.readers.average.placeholder")}
        hint={t("autopilot.review.readers.average.hint")}
        problem={averageProblem}
        unit="/10"
        decimals
        disabled={off}
        onChange={onAverage}
      />
      {loading && <p role="status" className="text-xs text-muted-foreground">{t("autopilot.review.readers.loading")}</p>}
      {readers.length > 0 && (
        <div className="space-y-1.5">
          <div role="region" aria-label={t("autopilot.review.readers.table.label")} tabIndex={0} className="relative overflow-x-auto rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <table data-reader-table="" className="w-full border-collapse text-sm">
              <caption className="sr-only">{t("autopilot.review.readers.table.label")}</caption>
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th scope="col" className="px-1.5 py-1.5 text-left font-medium sm:px-2">{t("autopilot.review.readers.table.reader")}</th>
                  <th scope="col" className="px-1.5 py-1.5 text-right font-medium sm:px-2">{t("autopilot.review.readers.table.weight")}</th>
                  <th scope="col" className="px-1.5 py-1.5 text-left font-medium sm:px-2">{t("autopilot.review.readers.table.target")}</th>
                  <th scope="col" className="px-1.5 py-1.5 text-left font-medium sm:px-2">{t("autopilot.review.readers.table.counts")}</th>
                </tr>
              </thead>
              <tbody>
                {readers.map((reader) => {
                  const counts = !left.has(reader.slug);
                  const problem = readerProblems[reader.slug];
                  const inputId = `${id}-target-${reader.slug}`;
                  const problemId = `${inputId}-problem`;
                  return (
                    <tr key={reader.slug} data-reader-row={reader.slug} className="border-b align-top last:border-b-0">
                      <th scope="row" className="min-w-[6rem] px-1.5 py-1.5 text-left font-medium sm:min-w-[8rem] sm:px-2">{reader.name}</th>
                      <td className="whitespace-nowrap px-1.5 py-1.5 text-right tabular-nums sm:px-2">
                        <span aria-hidden="true">×{reader.weight}</span>
                        <span className="sr-only">{t("autopilot.review.readers.table.weightText", { weight: reader.weight })}</span>
                      </td>
                      <td className="px-1.5 py-1 sm:px-2">
                        <div className="flex items-center gap-1.5">
                          <Input
                            id={inputId}
                            type="text"
                            inputMode="decimal"
                            autoComplete="off"
                            aria-label={t("autopilot.review.readers.table.targetLabel", { name: reader.name })}
                            aria-invalid={problem ? true : undefined}
                            aria-describedby={problem ? problemId : undefined}
                            value={targets[reader.slug] ?? ""}
                            placeholder={t("autopilot.review.readers.table.targetPlaceholder")}
                            disabled={off || !counts}
                            className={cn("h-9 w-16 sm:w-20", problem && "border-destructive")}
                            onChange={(event) => onTarget(reader.slug, event.target.value)}
                          />
                          <span aria-hidden="true" className="text-xs text-muted-foreground">/{READER_TARGET_MAX}</span>
                        </div>
                        {problem && <p id={problemId} className="mt-0.5 text-xs font-medium text-destructive">{problem}</p>}
                      </td>
                      <td className="px-1.5 py-1.5 sm:px-2">
                        <label className="flex min-h-9 min-w-9 cursor-pointer items-center gap-2 text-sm sm:min-w-0">
                          <input
                            type="checkbox"
                            data-reader-counts={reader.slug}
                            className="h-4 w-4 accent-primary"
                            aria-label={t("autopilot.review.readers.table.countsLabel", { name: reader.name })}
                            checked={counts}
                            disabled={off}
                            onChange={(event) => onCounts(reader.slug, event.target.checked)}
                          />
                          <span aria-hidden="true" className="hidden sm:inline">{counts ? t("autopilot.review.readers.table.yes") : t("autopilot.review.readers.table.no")}</span>
                        </label>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">{t("autopilot.review.readers.table.hint")}</p>
        </div>
      )}
    </section>
  );
}

/** The range a vote for a reader is from: what the text of a problem names. */
export const READER_TARGET_RANGE = { min: READER_TARGET_MIN, max: READER_TARGET_MAX } as const;
