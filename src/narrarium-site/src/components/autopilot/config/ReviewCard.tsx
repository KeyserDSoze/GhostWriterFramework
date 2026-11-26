import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Target } from "lucide-react";
import { DIRECTOR_FILE, REVIEW_MAX_CAMPAIGN_ROUNDS, REVIEW_MAX_ROUNDS, defaultDirector, parseDirector, type AutopilotOptions, type AutopilotState } from "narrarium-engine";
import { Card } from "@/components/autopilot/Card";
import { FormRunEstimate, OptionalNumberField, useProblemText } from "@/components/autopilot/review/ReviewFields";
import { useBookFiles } from "@/autopilot/useBookFiles";
import { MAX_MONEY_CAP, MAX_TOKEN_CAP, REVIEW_SERVER_VERSION, TARGET_MAX, TARGET_MIN, readReviewForm, type ReviewField, type ReviewForm } from "@/autopilot/reviewPolicy";
import { formatCount } from "@/autopilot/format";
import { useMoney } from "@/costs/useMoney";
import type { BookStructure } from "@/types/book";
import type { BookEntry } from "@/types/settings";
import { isAppliedCap } from "@/costs/budgetCaps";
import "@/i18n/costs";

const ID = "autopilot-review";
const FIELDS: ReviewField[] = ["target", "rounds", "readerRounds", "campaignRounds", "money", "tokens"];

export interface ReviewCardHandle {
  /** Show every problem, and give the focus to the first field that has one. */
  showProblems: () => void;
}

export interface ReviewCardProps {
  book: BookEntry;
  form: ReviewForm;
  onChange: (form: ReviewForm) => void;
  /** Something holds the book, or a run goes on (the review is not a setting a run can change). */
  locked: boolean;
  /** The personal server that runs the book predates the review policy: the score and the rounds are the director's, and cannot be chosen here. */
  policyUnsupported: boolean;
  /** The simulated readers read the chapters (`options.readers`): their rounds mean something only then. */
  readers: boolean;
  /** What the book spent so far (`stats.cost`, every run's), in the currency of its prices (`stats.currency`). */
  spent: number;
  spentCurrency?: string;
  /** The values of the form differ from the saved ones: the estimate of the run with them is shown. */
  changed: boolean;
  /** What the estimate of the run reads, with the options as the form makes them. */
  estimate: { branch?: string; structure?: BookStructure; state: AutopilotState | null; options: AutopilotOptions; brief: AutopilotState["brief"] };
}

/**
 * «Review» in the configuration: how far the autopilot goes before it approves a chapter and the book, and how much it may spend. The score to reach (5 to 10 by halves,
 * blank: the director's), the rounds of review of a chapter (blank: the director's), the rounds the simulated readers read in (blank: the first only), the rounds a review
 * of the book makes before it waits for the author (blank: no limit), the money cap of the book in the currency of the settings and the token cap (blank: none), each
 * with one line that says what it does. What the book spent is next to the money cap, which never resets: it is raised. Once a value changed, the estimate of the run
 * with the new values is under the fields. A personal server that predates the policy keeps the director's values, and says so.
 */
const ReviewCard = forwardRef<ReviewCardHandle, ReviewCardProps>(function ReviewCard({ book, form, onChange, locked, policyUnsupported, readers, spent, spentCurrency, changed, estimate }, ref) {
  const { t } = useTranslation();
  const money = useMoney();
  const problemText = useProblemText();
  const inputs = useRef<Partial<Record<ReviewField, HTMLInputElement | null>>>({});
  const [touched, setTouched] = useState<ReadonlySet<ReviewField>>(new Set());
  const [focusAsked, setFocusAsked] = useState(0);
  const reading = readReviewForm(form);

  // The director's score and rounds are what a blank field means: read from its profile, the defaults of its language when the book has none.
  const language = estimate.structure?.language;
  const directorFiles = useBookFiles(book.id, [DIRECTOR_FILE]);
  const director = useMemo(() => {
    const text = directorFiles.files?.get(DIRECTOR_FILE);
    return text === undefined ? defaultDirector(language) : parseDirector(text, language);
  }, [directorFiles.files, language]);

  useImperativeHandle(ref, () => ({
    showProblems: () => {
      setTouched(new Set(FIELDS));
      setFocusAsked((count) => count + 1);
    },
  }), []);
  useEffect(() => {
    if (!focusAsked) return;
    const first = FIELDS.find((field) => reading.problems[field]);
    if (first) inputs.current[first]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusAsked]);

  const change = (field: ReviewField, value: string) => {
    setTouched((current) => new Set(current).add(field));
    onChange({ ...form, [field]: value });
  };
  const problemOf = (field: ReviewField, min: number, max: number) => (touched.has(field) ? problemText(reading.problems[field], { min, max }) : null);
  const policyOff = locked || policyUnsupported;
  // The cap is in the currency the book's costs are counted in; a book that spent nothing yet has the settings' currency.
  const currency = spentCurrency || money.display;
  const field = (name: ReviewField) => ({ id: `${ID}-${name}`, value: form[name], ref: (element: HTMLInputElement | null) => { inputs.current[name] = element; } });

  return (
    <Card id={ID} title={t("autopilot.review.title")} icon={<Target className="h-4 w-4 text-primary" aria-hidden="true" />}>
      <p className="text-sm text-muted-foreground">{t("autopilot.review.intro")}</p>
      {policyUnsupported && <p data-review-old-server className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-2 text-xs font-medium">{t("autopilot.review.oldServer", { version: REVIEW_SERVER_VERSION })}</p>}
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
        <OptionalNumberField
          {...field("target")}
          label={t("autopilot.review.target.label")}
          placeholder={t("autopilot.review.target.placeholder", { score: formatCount(director.approvalScore) })}
          hint={t("autopilot.review.target.hint")}
          problem={problemOf("target", TARGET_MIN, TARGET_MAX)}
          unit="/10"
          decimals
          disabled={policyOff}
          onChange={(value) => change("target", value)}
        />
        <OptionalNumberField
          {...field("rounds")}
          label={t("autopilot.review.rounds.label")}
          placeholder={t("autopilot.review.rounds.placeholder", { count: director.maxReviewRounds })}
          hint={t("autopilot.review.rounds.hint")}
          problem={problemOf("rounds", 1, REVIEW_MAX_ROUNDS)}
          disabled={policyOff}
          onChange={(value) => change("rounds", value)}
        />
        <OptionalNumberField
          {...field("readerRounds")}
          label={t("autopilot.review.readerRounds.label")}
          placeholder={t("autopilot.review.readerRounds.placeholder")}
          hint={readers ? t("autopilot.review.readerRounds.hint") : t("autopilot.review.readerRounds.off")}
          problem={problemOf("readerRounds", 1, REVIEW_MAX_ROUNDS)}
          disabled={policyOff || !readers}
          onChange={(value) => change("readerRounds", value)}
        />
        <OptionalNumberField
          {...field("campaignRounds")}
          label={t("autopilot.review.campaignRounds.label")}
          placeholder={t("autopilot.review.unlimited")}
          hint={t("autopilot.review.campaignRounds.hint")}
          problem={problemOf("campaignRounds", 1, REVIEW_MAX_CAMPAIGN_ROUNDS)}
          disabled={policyOff}
          onChange={(value) => change("campaignRounds", value)}
        />
        <OptionalNumberField
          {...field("money")}
          label={t("autopilot.review.money.label", { currency })}
          placeholder={t("autopilot.review.unlimited")}
          hint={`${t("autopilot.review.money.hint", { spent: money.amount(spent, spentCurrency, { zero: "amount" }) })}${isAppliedCap(book.id, reading.budgetLimit) ? ` ${t("costs.budget.capHint")}` : ""}`}
          problem={problemOf("money", 0, MAX_MONEY_CAP)}
          unit={currency}
          decimals
          disabled={locked}
          onChange={(value) => change("money", value)}
        />
        <OptionalNumberField
          {...field("tokens")}
          label={t("autopilot.review.tokens.label")}
          placeholder={t("autopilot.review.unlimited")}
          hint={t("autopilot.review.tokens.hint")}
          problem={problemOf("tokens", 0, MAX_TOKEN_CAP)}
          disabled={locked}
          onChange={(value) => change("tokens", value)}
        />
      </div>
      {changed && reading.valid && estimate.branch !== undefined && (
        <FormRunEstimate
          book={book}
          branch={estimate.branch}
          structure={estimate.structure}
          state={estimate.state}
          brief={estimate.brief}
          options={{ ...estimate.options, budgetLimit: reading.budgetLimit, budgetTokens: reading.budgetTokens, ...(Object.keys(reading.policy).length && !policyUnsupported ? { review: reading.policy } : { review: undefined }) }}
        />
      )}
    </Card>
  );
});

export default ReviewCard;
