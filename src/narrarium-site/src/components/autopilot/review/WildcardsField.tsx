import { useTranslation } from "react-i18next";
import { OptionalNumberField } from "@/components/autopilot/review/ReviewFields";
import { WILDCARDS_SERVER_VERSION, type ReviewForm } from "@/autopilot/reviewPolicy";

/** The fields of the room that are one text each. */
export type WildcardsTextField = "wildcardsVoices" | "wildcardsRounds" | "wildcardsMoney";

export interface WildcardsFieldProps {
  /** The start of the ids of the fields. */
  id: string;
  form: Pick<ReviewForm, "wildcardsDesign" | "wildcardsPlateau" | "wildcardsVoices" | "wildcardsRounds" | "wildcardsMoney" | "bookRound">;
  /** A switch changed. */
  onSwitch: (patch: Pick<ReviewForm, "wildcardsDesign"> | Pick<ReviewForm, "wildcardsPlateau">) => void;
  /** A number changed, as it was typed. */
  onText: (field: WildcardsTextField, value: string) => void;
  /** What is wrong with a number, when it shows. */
  problems: Partial<Record<WildcardsTextField, string | null>>;
  /** Where the focus goes for a problem. */
  inputRef: (field: WildcardsTextField, element: HTMLInputElement | null) => void;
  /** Nothing can be edited (a run goes on, or the policy is not the author's to change here). */
  disabled: boolean;
  /** The personal server that runs the book predates the room in the autopilot: it would consult nobody. */
  unsupported: boolean;
  /** The currency of the money cap. */
  currency: string;
  /** What one consultation costs, in words (`null`: not said, the room is off). */
  estimate: string | null;
}

/**
 * The room of the wildcards in the autopilot (#127), in the Review tab of the configuration: consulted before the review of a design, and when a review of the book stalls, the
 * director triaging what it gives; the voices of a consultation, the consultations at a stall of one review and the money cap of one. Never a score, never a gate: the part says so,
 * says that the stall needs a round for the book as a whole, and what a consultation costs. Nothing can be chosen when the personal server would not know it, and the part says why.
 */
export function WildcardsField({ id, form, onSwitch, onText, problems, inputRef, disabled, unsupported, currency, estimate }: WildcardsFieldProps) {
  const { t } = useTranslation();
  const headingId = `${id}-wildcards-title`;
  const off = disabled || unsupported;
  const design = !unsupported && form.wildcardsDesign === true;
  const plateau = !unsupported && form.wildcardsPlateau === true;
  const room = design || plateau;
  const switches = [
    { key: "design" as const, on: design, change: (checked: boolean) => onSwitch({ wildcardsDesign: checked }) },
    { key: "plateau" as const, on: plateau, change: (checked: boolean) => onSwitch({ wildcardsPlateau: checked }) },
  ];
  return (
    <section data-wildcards-field="" aria-labelledby={headingId} className="space-y-3 rounded-lg border p-3">
      <div className="space-y-1">
        <h3 id={headingId} className="text-sm font-semibold">{t("autopilot.review.wildcards.title")}</h3>
        <p className="text-xs text-muted-foreground">{t("autopilot.review.wildcards.intro")}</p>
      </div>
      {unsupported && <p data-review-old-server-wildcards="" className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-2 text-xs font-medium">{t("autopilot.review.wildcards.oldServer", { version: WILDCARDS_SERVER_VERSION })}</p>}
      <div className="space-y-1">
        {switches.map((entry) => (
          <label key={entry.key} className="flex min-h-11 cursor-pointer items-start gap-2 rounded-md py-1 text-sm sm:min-h-0">
            <input
              type="checkbox"
              data-wildcards-switch={entry.key}
              className="mt-1 h-4 w-4 shrink-0 accent-primary"
              checked={entry.on}
              disabled={off}
              aria-labelledby={`${id}-wildcards-${entry.key}-label`}
              aria-describedby={`${id}-wildcards-${entry.key}-hint`}
              onChange={(event) => entry.change(event.target.checked)}
            />
            <span className="min-w-0">
              <span id={`${id}-wildcards-${entry.key}-label`} className="block font-medium">{t(`autopilot.review.wildcards.${entry.key}.label`)}</span>
              <span id={`${id}-wildcards-${entry.key}-hint`} className="block text-xs text-muted-foreground">{t(`autopilot.review.wildcards.${entry.key}.hint`)}</span>
            </span>
          </label>
        ))}
      </div>
      {plateau && (form.bookRound ?? "off") === "off" && (
        <p data-wildcards-needs-book-round="" className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-2 text-xs font-medium">{t("autopilot.review.wildcards.needsBookRound")}</p>
      )}
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-3">
        <OptionalNumberField
          ref={(element) => inputRef("wildcardsVoices", element)}
          id={`${id}-wildcardsVoices`}
          value={form.wildcardsVoices ?? ""}
          label={t("autopilot.review.wildcards.voices.label")}
          placeholder={t("autopilot.review.wildcards.voices.placeholder")}
          hint={t("autopilot.review.wildcards.voices.hint")}
          problem={problems.wildcardsVoices ?? null}
          disabled={off || !room}
          onChange={(value) => onText("wildcardsVoices", value)}
        />
        <OptionalNumberField
          ref={(element) => inputRef("wildcardsRounds", element)}
          id={`${id}-wildcardsRounds`}
          value={form.wildcardsRounds ?? ""}
          label={t("autopilot.review.wildcards.rounds.label")}
          placeholder={t("autopilot.review.wildcards.rounds.placeholder")}
          hint={t("autopilot.review.wildcards.rounds.hint")}
          problem={problems.wildcardsRounds ?? null}
          disabled={off || !plateau}
          onChange={(value) => onText("wildcardsRounds", value)}
        />
        <OptionalNumberField
          ref={(element) => inputRef("wildcardsMoney", element)}
          id={`${id}-wildcardsMoney`}
          value={form.wildcardsMoney ?? ""}
          label={t("autopilot.review.wildcards.money.label", { currency })}
          placeholder={t("autopilot.review.unlimited")}
          hint={t("autopilot.review.wildcards.money.hint")}
          problem={problems.wildcardsMoney ?? null}
          unit={currency}
          decimals
          disabled={off || !room}
          onChange={(value) => onText("wildcardsMoney", value)}
        />
      </div>
      {room && estimate && <p data-wildcards-estimate="" className="text-xs text-muted-foreground">{estimate}</p>}
    </section>
  );
}
