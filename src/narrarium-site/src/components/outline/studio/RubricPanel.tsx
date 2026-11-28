import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Gauge, RefreshCw } from "lucide-react";
import { designCriterionLabel, type AutopilotDesign, type AutopilotState } from "narrarium-engine";
import { Button } from "@/components/ui/button";
import { voteText } from "@/autopilot/format";
import { chapterReviewCounts, criterionRows, readerNameOf, type RubricSubjectView, type RubricView } from "@/outline/designReviewModel";

export interface RubricPanelProps {
  view: RubricView;
  state: AutopilotState | null;
  /** The titles of the chapters, by number. */
  titles: ReadonlyMap<number, string>;
  /** The titles of the pitches, by id. */
  pitchTitles: ReadonlyMap<string, string>;
  /** Whether a review of a chapter can be asked now, and why not. */
  canReview: boolean;
  disabled: boolean;
  onReviewChapter: (chapter: number) => void;
}

/** How a subject went: «up 0.8 since the first review», or that it did not move. Text, never only a colour or an arrow. */
function Trend({ subject }: { subject: RubricSubjectView }) {
  const { t } = useTranslation();
  if (subject.trend === null) return null;
  const amount = Math.abs(subject.trend);
  return <span data-rubric-trend={subject.trend > 0 ? "up" : subject.trend < 0 ? "down" : "flat"}>{subject.trend > 0 ? t("designReview.rubric.trendUp", { amount }) : subject.trend < 0 ? t("designReview.rubric.trendDown", { amount }) : t("designReview.rubric.trendFlat")}</span>;
}

/** The twelve criteria of a subject, each with its score and, where the judge said it, why and what it would do instead. */
function Criteria({ subject, label }: { subject: RubricSubjectView; label: string }) {
  const { t, i18n } = useTranslation();
  const details = new Map((subject.criteria ?? subject.weak).map((entry) => [entry.criterion, entry]));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{t("designReview.rubric.caption", { subject: label })}</caption>
        <thead>
          <tr className="border-b border-layer text-xs text-muted-foreground">
            <th scope="col" className="py-1 pr-3 font-medium">{t("designReview.rubric.criterion")}</th>
            <th scope="col" className="py-1 pr-3 font-medium">{t("designReview.rubric.scoreColumn")}</th>
            <th scope="col" className="py-1 font-medium">{t("designReview.rubric.reason")}</th>
          </tr>
        </thead>
        <tbody>
          {criterionRows(subject.scores).map(({ criterion, score, weak }) => {
            const detail = details.get(criterion);
            return (
              <tr key={criterion} data-criterion={criterion} data-weak={weak ? "" : undefined} className="border-b border-layer/60 align-top">
                <th scope="row" className="py-1.5 pr-3 font-medium">{designCriterionLabel(criterion, i18n.language)}</th>
                <td className="whitespace-nowrap py-1.5 pr-3">{score === null ? t("designReview.notApplicable") : weak ? t("designReview.scoreWeak", { score }) : t("designReview.score", { score })}</td>
                <td className="py-1.5">
                  {detail?.reason && <p>{detail.reason}</p>}
                  {detail && detail.proposals.length > 0 && (
                    <p className="mt-1 text-muted-foreground"><span className="font-medium">{t("designReview.rubric.proposals")}:</span> {detail.proposals.join(" · ")}</p>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A subject that was judged: closed, its name with its overall, how many weak points it has and, for a chapter, the panel's verdict; opened, how it went, its twelve criteria and its review
 * by review. `heading` is what the closed row says when it is not the name of the subject.
 */
function Subject({ subject, label, heading, verdict, summary, open, extra }: { subject: RubricSubjectView; label: string; heading?: string; verdict?: "ok" | "revise"; summary?: string; open?: boolean; extra?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <li data-rubric-subject={subject.key}>
      <details open={open} className="rounded-xl border border-layer bg-background p-3">
        <summary className="cursor-pointer text-sm">
          <span className="font-medium">{heading ?? label}</span>
          <span className="text-muted-foreground"> · {voteText(subject.overall)}{subject.weak.length ? ` · ${t("designReview.rubric.weakCount", { count: subject.weak.length })}` : ""}{verdict === "revise" ? ` · ${t("designReview.rubric.verdict.revise")}` : ""}</span>
        </summary>
        <p className="mt-1 text-sm">
          <span className="font-medium">{t("designReview.rubric.overall")}: {voteText(subject.overall)}</span>
          {subject.previous !== null && <> · {t("designReview.rubric.previous", { score: subject.previous })}</>}
          {subject.trend !== null && <> · <Trend subject={subject} /></>}
          {" · "}{subject.weak.length ? t("designReview.rubric.weakCount", { count: subject.weak.length }) : t("designReview.rubric.noWeak")}
        </p>
        {summary && <p className="mt-1 text-sm text-muted-foreground">{summary}</p>}
        <div className="mt-2 space-y-3">
          <Criteria subject={subject} label={label} />
          {subject.history.length > 1 && (
            <div>
              <h4 className="text-xs font-medium text-muted-foreground">{t("designReview.rubric.evolution")}</h4>
              <ol className="mt-1 text-sm">
                {subject.history.map((entry, index) => <li key={`${entry.round}-${entry.at}-${index}`}>{t("designReview.rubric.evolutionRow", { round: index + 1, score: voteText(entry.overall) })}</li>)}
              </ol>
            </div>
          )}
          {extra}
        </div>
      </details>
    </li>
  );
}

/** The rubric of the subjects that were judged: the design, the readers, the chapters and the pitches, each with its twelve scores and how they went round after round. */
export function RubricPanel({ view, state, titles, pitchTitles, canReview, disabled, onReviewChapter }: RubricPanelProps) {
  const { t } = useTranslation();
  const design = state?.design as AutopilotDesign | undefined;
  const counts = chapterReviewCounts(design);
  const group = (title: string, subjects: RubricSubjectView[], render: (subject: RubricSubjectView) => ReactNode) =>
    subjects.length > 0 && (
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <ul className="space-y-2">{subjects.map(render)}</ul>
      </div>
    );
  return (
    <section aria-labelledby="studio-rubric-title" data-design-rubric className="space-y-3 rounded-2xl border border-layer bg-card p-4 shadow-sm sm:p-5">
      <h2 id="studio-rubric-title" className="flex items-center gap-2 text-lg font-semibold"><Gauge className="h-5 w-5 text-primary" aria-hidden="true" />{t("designReview.rubric.title")}</h2>
      <p className="max-w-3xl text-sm text-muted-foreground">{t("designReview.rubric.intro")}</p>
      {view.design && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">{t("designReview.rubric.design")}</h3>
          <ul><Subject subject={view.design} label={t("designReview.rubric.design")} heading={t("designReview.rubric.criteria")} open /></ul>
        </div>
      )}
      {group(t("designReview.rubric.readers"), view.readers, (subject) => <Subject key={subject.key} subject={subject} label={readerNameOf(state, subject.id ?? "")} />)}
      {view.chapters.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">{t("designReview.rubric.chapters")}</h3>
          <p className="text-xs text-muted-foreground">{t("designReview.rubric.reviewed", { count: counts.reviewed, weak: counts.weak })}</p>
          <ul className="space-y-2">
            {view.chapters.map((subject) => {
              const number = subject.chapter ?? 0;
              const review = design?.reviewed?.[String(number)];
              const title = titles.get(number);
              const label = t("designReview.rubric.chapter", { number, title: title ? ` «${title}»` : "" });
              return (
                <Subject
                  key={subject.key}
                  subject={subject}
                  label={label}
                  verdict={review?.verdict}
                  summary={review ? `${t(`designReview.rubric.verdict.${review.verdict}`)}${review.summary ? ` — ${review.summary}` : ""}` : undefined}
                  extra={canReview ? (
                    <Button type="button" size="sm" variant="outline" data-rubric-review={number} disabled={disabled} aria-label={t("designReview.rubric.reviewChapter", { number })} onClick={() => onReviewChapter(number)}>
                      <RefreshCw className="h-4 w-4" aria-hidden="true" />{t("designReview.request.chapter")}
                    </Button>
                  ) : undefined}
                />
              );
            })}
          </ul>
        </div>
      )}
      {group(t("designReview.rubric.pitches"), view.pitches, (subject) => <Subject key={subject.key} subject={subject} label={t("designReview.alternatives.pitch", { id: subject.id ?? "", title: pitchTitles.get(subject.id ?? "") ?? "" })} />)}
    </section>
  );
}
