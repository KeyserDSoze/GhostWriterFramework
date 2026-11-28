import { useId } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Lightbulb } from "lucide-react";
import { Button } from "@/components/ui/button";
import { voteText } from "@/autopilot/format";
import type { AlternativesView, PitchView } from "@/outline/designReviewModel";

export interface AlternativesPanelProps {
  view: AlternativesView;
  /** Something holds the book: the buttons wait. */
  disabled: boolean;
  onChoose: (pitch: PitchView) => void;
}

const FIELDS = ["premise", "protagonist", "stakes", "twist", "tone", "difference"] as const;

/** One pitch: what it says, how the director and the readers judged it, and the button that chooses it. */
function Pitch({ view, selected, choosable, disabled, onChoose }: { view: PitchView; selected: AlternativesView["selected"]; choosable: boolean; disabled: boolean; onChoose: (pitch: PitchView) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const { pitch } = view;
  const judged = [...(view.director ? [view.director] : []), ...view.readers];
  return (
    <li data-pitch={pitch.id} data-pitch-chosen={view.chosen ? "" : undefined} className={`rounded-xl border p-3 ${view.chosen ? "border-emerald-600/50 bg-emerald-500/5" : "border-layer bg-background"}`}>
      <article aria-labelledby={`${id}-title`} className="space-y-2">
        <h3 id={`${id}-title`} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base font-semibold">
          <span>{t("designReview.alternatives.pitch", { id: pitch.id, title: pitch.title })}</span>
          {view.chosen && <span className="rounded-full border border-emerald-600/50 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:text-emerald-300">{t("designReview.alternatives.chosen")}</span>}
          {view.recommended && <span className="rounded-full border border-primary/40 px-2 py-0.5 text-xs font-medium text-primary">{t("designReview.alternatives.recommended")}</span>}
        </h3>
        <p className="text-sm">{pitch.logline}</p>
        <p data-pitch-scores className="text-xs text-muted-foreground">
          {t("designReview.alternatives.director", { score: view.director?.overall != null ? voteText(view.director.overall) : t("designReview.alternatives.noScore") })}
          {view.readers.length > 0 && <> · {t("designReview.alternatives.readers", { score: view.readersMean !== null ? voteText(view.readersMean) : t("designReview.alternatives.noScore") })}</>}
        </p>
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">{t("designReview.alternatives.details")}</summary>
          <dl className="mt-2 space-y-1.5">
            {FIELDS.map((field) => (
              <div key={field}>
                <dt className="text-xs font-medium text-muted-foreground">{t(`designReview.alternatives.fields.${field}`)}</dt>
                <dd>{pitch[field]}</dd>
              </div>
            ))}
          </dl>
        </details>
        {judged.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer font-medium">{t("designReview.alternatives.judgements")}</summary>
            <ul className="mt-2 space-y-1">
              {judged.map((entry) => <li key={entry.by}>{t("designReview.alternatives.judgement", { name: entry.name, score: entry.overall !== null ? voteText(entry.overall) : t("designReview.alternatives.noScore"), note: entry.note })}</li>)}
            </ul>
          </details>
        )}
        {choosable && !view.chosen && (
          <Button type="button" size="sm" variant={selected ? "outline" : "default"} data-pitch-choose={pitch.id} disabled={disabled} aria-label={t(selected ? "designReview.alternatives.chooseAnotherLabel" : "designReview.alternatives.chooseLabel", { title: pitch.title })} onClick={() => onChoose(view)}>
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />{selected ? t("designReview.alternatives.chooseAnother") : t("designReview.alternatives.choose")}
          </Button>
        )}
      </article>
    </li>
  );
}

/**
 * The alternative pitches of the design: what the Brainstormer proposed, what the readers and the director said of each, the one that was chosen with its reason, and, while it
 * is the author's to choose (or to change her mind), the button that chooses.
 */
export function AlternativesPanel({ view, disabled, onChoose }: AlternativesPanelProps) {
  const { t } = useTranslation();
  const chosen = view.pitches.find((entry) => entry.chosen);
  const recommended = view.pitches.find((entry) => entry.recommended);
  return (
    <section aria-labelledby="studio-alternatives-title" data-design-alternatives className="space-y-3 rounded-2xl border border-layer bg-card p-4 shadow-sm sm:p-5">
      <h2 id="studio-alternatives-title" className="flex items-center gap-2 text-lg font-semibold"><Lightbulb className="h-5 w-5 text-primary" aria-hidden="true" />{t("designReview.alternatives.title")}</h2>
      <p className="max-w-3xl text-sm text-muted-foreground">{t("designReview.alternatives.intro")}</p>
      {view.waiting && recommended && (
        <div data-pitch-waiting="" className="space-y-1 rounded-lg border border-primary/40 bg-primary/5 p-3">
          <h3 className="text-sm font-semibold">{t("designReview.alternatives.waiting")}</h3>
          <p className="text-sm">{t("designReview.alternatives.waitingBody", { title: recommended.pitch.title, reason: view.recommended?.reason ?? "" })}</p>
        </div>
      )}
      {view.selected && chosen && (
        <p data-pitch-selection className="text-sm font-medium">
          {view.selected.reason
            ? t("designReview.alternatives.chosenReason", { who: t(`designReview.alternatives.chosenBy.${view.selected.by}`), reason: view.selected.reason })
            : t("designReview.alternatives.chosenNoReason", { who: t(`designReview.alternatives.chosenBy.${view.selected.by}`) })}
        </p>
      )}
      <ul className="space-y-3">
        {view.pitches.map((entry) => <Pitch key={entry.pitch.id} view={entry} selected={view.selected} choosable={view.choosable} disabled={disabled} onChoose={onChoose} />)}
      </ul>
      {!view.choosable && <p className="text-xs text-muted-foreground">{t("designReview.alternatives.lockedHint")}</p>}
    </section>
  );
}
