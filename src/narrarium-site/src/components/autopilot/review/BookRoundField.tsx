import { useTranslation } from "react-i18next";
import type { BookRoundMode } from "narrarium-engine";
import { REVIEW_BOOK_ROUND_SERVER_VERSION } from "@/autopilot/reviewPolicy";

export interface BookRoundFieldProps {
  /** The start of the ids of the fields: the card and the dialog each have their own. */
  id: string;
  value: BookRoundMode;
  onChange: (mode: BookRoundMode) => void;
  /** Nothing can be edited (a run goes on, or the policy is not the author's to change here). */
  disabled: boolean;
  /** The personal server that runs the book predates the book-level round: it would end the review where it always did. */
  unsupported: boolean;
  /** The level of the heading under the one of the card or the dialog. */
  headingLevel?: 3 | 4;
}

const MODES: readonly BookRoundMode[] = ["off", "apply", "ask"];

/**
 * What a review does when every chapter has its targets and the director's vote of the whole book does not (#113), in the Review tab of the configuration and in «Review the book
 * again»: nothing more (it ends there, as it always did), or a book-level round: the director lists the corrections across the chapters (which to change, what in each and why) and the
 * review carries them out, or shows them first and carries out those the author chooses. One choice out of three, each with a line that says what it does; nothing can be chosen when the
 * personal server would not know it, and the part says why.
 */
export function BookRoundField({ id, value, onChange, disabled, unsupported, headingLevel = 3 }: BookRoundFieldProps) {
  const { t } = useTranslation();
  const Heading = headingLevel === 3 ? "h3" : "h4";
  const headingId = `${id}-book-round-title`;
  const off = disabled || unsupported;
  return (
    <section data-book-round-field="" aria-labelledby={headingId} className="space-y-3 rounded-lg border p-3">
      <div className="space-y-1">
        <Heading id={headingId} className="text-sm font-semibold">{t("autopilot.review.bookRound.title")}</Heading>
        <p className="text-xs text-muted-foreground">{t("autopilot.review.bookRound.intro")}</p>
      </div>
      {unsupported && <p data-review-old-server-book-round="" className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-2 text-xs font-medium">{t("autopilot.review.bookRound.oldServer", { version: REVIEW_BOOK_ROUND_SERVER_VERSION })}</p>}
      <div role="radiogroup" aria-labelledby={headingId} className="space-y-1">
        {MODES.map((mode) => (
          <label key={mode} className="flex min-h-11 cursor-pointer items-start gap-2 rounded-md py-1 text-sm sm:min-h-0">
            <input
              type="radio"
              name={`${id}-book-round`}
              data-book-round-mode={mode}
              className="mt-1 h-4 w-4 shrink-0 accent-primary"
              checked={(unsupported ? "off" : value) === mode}
              disabled={off}
              aria-labelledby={`${id}-book-round-${mode}-label`}
              aria-describedby={`${id}-book-round-${mode}-hint`}
              onChange={() => onChange(mode)}
            />
            <span className="min-w-0">
              <span id={`${id}-book-round-${mode}-label`} className="block font-medium">{t(`autopilot.review.bookRound.${mode}.label`)}</span>
              <span id={`${id}-book-round-${mode}-hint`} className="block text-xs text-muted-foreground">{t(`autopilot.review.bookRound.${mode}.hint`)}</span>
            </span>
          </label>
        ))}
      </div>
    </section>
  );
}
