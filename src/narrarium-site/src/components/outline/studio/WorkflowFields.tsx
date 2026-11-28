import { useId } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n/design";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ALTERNATIVES_MAX, ALTERNATIVES_MIN, DESIGN_REVIEW_SERVER_VERSION, type WorkflowForm, type WorkflowProblem } from "@/outline/designReviewModel";

export interface WorkflowFieldsProps {
  form: WorkflowForm;
  onChange: (patch: Partial<WorkflowForm>) => void;
  /** The personal server that runs the book has the reviews of a design: without it the boxes are off and the design is the plain one. */
  supported: boolean;
  /** The alternatives are proposed before the concept: once it is made of a pitch there are none to propose. */
  alternativesAllowed: boolean;
  problem: WorkflowProblem | null;
}

interface ChoiceProps {
  id: string;
  type: "checkbox" | "radio";
  name?: string;
  checked: boolean;
  disabled?: boolean;
  label: string;
  hint: string;
  hook: Record<string, string>;
  onChange: (checked: boolean) => void;
}

/** A box or a button of the form: what it says is its name, and what it does is its description, so that a screen reader says them apart and the box is named by its title alone. */
function Choice({ id, type, name, checked, disabled, label, hint, hook, onChange }: ChoiceProps) {
  return (
    <div className="min-w-0">
      <label className="flex cursor-pointer items-center gap-2 py-1 text-sm font-medium has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-70">
        <input id={id} type={type} name={name} {...hook} className="h-4 w-4 shrink-0 accent-primary" checked={checked} disabled={disabled} aria-describedby={`${id}-hint`} onChange={(event) => onChange(event.target.checked)} />
        <span>{label}</span>
      </label>
      <p id={`${id}-hint`} className="pb-2 pl-6 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

/**
 * What a design run does besides designing the chapters, as the dialog «Design the book» asks it: the alternative pitches (how many, and who chooses), the review of every chapter, the
 * analysis of the structure and the rubric. Each box is described by what it does; the whole is off, and says why, on a personal server that does not have them.
 */
export function WorkflowFields({ form, onChange, supported, alternativesAllowed, problem }: WorkflowFieldsProps) {
  const { t } = useTranslation();
  const id = useId();
  const proposing = form.alternatives && alternativesAllowed;
  return (
    <fieldset data-design-reviews-fieldset="" disabled={!supported} className="space-y-2 rounded-xl border border-layer p-3">
      <legend className="px-1 text-sm font-semibold">{t("designReview.dialog.legend")}</legend>
      <p className="text-xs text-muted-foreground">{t("designReview.dialog.intro")}</p>
      {!supported && <p data-design-reviews-old-server="" className="text-xs font-medium">{t("designReview.oldServer", { version: DESIGN_REVIEW_SERVER_VERSION })}</p>}
      <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
        <div className="min-w-0 space-y-1">
          <Choice
            id={`${id}-alt`}
            type="checkbox"
            checked={proposing}
            disabled={!alternativesAllowed}
            label={t("designReview.dialog.alternatives.label")}
            hint={alternativesAllowed ? t("designReview.dialog.alternatives.hint") : t("designReview.dialog.alternatives.used")}
            hook={{ "data-design-alternatives": "" }}
            onChange={(checked) => onChange({ alternatives: checked })}
          />
          {proposing && (
            <div className="space-y-2 pl-6">
              <div className="flex min-w-0 flex-col gap-1">
                <Label htmlFor={`${id}-count`} className="text-xs font-medium">{t("designReview.dialog.alternatives.count")}</Label>
                <Input
                  id={`${id}-count`}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={form.alternativeCount}
                  aria-invalid={problem ? true : undefined}
                  aria-describedby={`${id}-count-hint${problem ? ` ${id}-count-problem` : ""}`}
                  className="h-9 w-24"
                  onChange={(event) => onChange({ alternativeCount: event.target.value })}
                />
                <p id={`${id}-count-hint`} className="text-xs text-muted-foreground">{t("designReview.dialog.alternatives.countHint", { min: ALTERNATIVES_MIN, max: ALTERNATIVES_MAX })}</p>
                {problem && <p id={`${id}-count-problem`} className="text-xs font-medium text-destructive">{t("designReview.dialog.alternatives.problem", { min: ALTERNATIVES_MIN, max: ALTERNATIVES_MAX })}</p>}
              </div>
              <fieldset className="min-w-0">
                <legend className="text-xs font-medium">{t("designReview.dialog.choice.label")}</legend>
                {(["director", "author"] as const).map((who) => (
                  <Choice
                    key={who}
                    id={`${id}-choice-${who}`}
                    type="radio"
                    name={`${id}-choice`}
                    checked={form.pitchChoice === who}
                    label={t(`designReview.dialog.choice.${who}`)}
                    hint={t(`designReview.dialog.choice.${who}Hint`)}
                    hook={{ "data-design-choice": who }}
                    onChange={() => onChange({ pitchChoice: who })}
                  />
                ))}
              </fieldset>
            </div>
          )}
        </div>
        {(["chapterReview", "coherence", "rubric"] as const).map((key) => (
          <Choice
            key={key}
            id={`${id}-${key}`}
            type="checkbox"
            checked={form[key]}
            label={t(`designReview.dialog.${key}.label`)}
            hint={t(`designReview.dialog.${key}.hint`)}
            hook={{ "data-design-workflow": key }}
            onChange={(checked) => onChange({ [key]: checked })}
          />
        ))}
      </div>
    </fieldset>
  );
}
