import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Gauge, Info } from "lucide-react";
import { autopilotPresetSkeleton, isItalian, type AutopilotPresetId, type AutopilotState, type EstimateCapability } from "narrarium-engine";
import { Card } from "@/components/autopilot/Card";
import { EstimateWarnings, RangeText, Stat, useLocale, useRoleNames, useWhyUnknown } from "@/components/autopilot/config/EstimateParts";
import { callsByRole, estimateRun, groupWarnings, type SetupFormValues } from "@/autopilot/runEstimate";
import { formatMinutes, formatMoney, formatTokens, formatWhole, roundMinutesRange, roundMoneyRange, roundRange, type Range } from "@/autopilot/runEstimateFormat";
import { useBookAutopilotView } from "@/autopilot/hooks";
import { useRunEstimateSources, type RunEstimateInputs } from "@/autopilot/useRunEstimate";
import type { BookStructure } from "@/types/book";
import type { BookEntry } from "@/types/settings";

/** The pause in the typing after which the figures are worked out again: a fast typist makes one calculation, not one for every key. */
export const PREVIEW_PAUSE_MS = 350;
/** A longer pause, after the figures changed, before a screen reader is told what they are: calmly, once, and never one line for each key. */
export const ANNOUNCE_PAUSE_MS = 1200;

/** The value of something that changes, once it has not changed for `delay` milliseconds. The first value is there at once. */
function useSettled<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (Object.is(value, settled)) return undefined;
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, settled, delay]);
  return settled;
}

export interface RunPreviewProps {
  inputs: RunEstimateInputs;
  /** The brief and the options as they are in the form now, saved or not. */
  form: SetupFormValues;
  /** The author has changed something: only then is what the page works out told to a screen reader. */
  dirty: boolean;
  bookId: string;
  /** The size the book was created from, while the autopilot has no state of its own: the size recommends its rounds of review. */
  startPreset?: AutopilotPresetId | null;
}

/**
 * What to expect from a run, worked out before it starts from the form as it is (saved or not), the director's rounds, the outline, the models and where the book is. The
 * figures follow every change after a short pause in the typing and are never in a live region; what they come to is said once, calmly, a little later. The estimate is the
 * engine's own: this card shows it, rounded outward to two figures so that none of them says more than it knows, and says in words what it cannot say.
 */
export function RunPreview({ inputs, form, dirty, bookId, startPreset }: RunPreviewProps) {
  const { t } = useTranslation();
  const locale = useLocale();
  const settled = useSettled(form, PREVIEW_PAUSE_MS);
  const { estimate, basis } = useMemo(() => estimateRun(inputs.sources, settled), [inputs.sources, settled]);
  const { sources } = inputs;
  const host = inputs.host;
  const roles = useMemo(() => callsByRole(estimate), [estimate]);
  const groups = useMemo(() => groupWarnings(estimate.warnings), [estimate]);

  const calls = roundRange(estimate.calls);
  const input = roundRange(estimate.inputTokens);
  const output = roundRange(estimate.outputTokens);
  const currency = estimate.cost?.currency || sources.currency || "USD";
  const cost = estimate.cost ? roundMoneyRange(estimate.cost) : null;
  const minutes = estimate.minutes ? roundMinutesRange(estimate.minutes) : null;
  const money = (value: number) => formatMoney(value, currency, locale);
  const whole = (value: number) => formatWhole(value, locale);
  const tokens = (value: number) => formatTokens(value, locale);
  const duration = (value: number) => formatMinutes(value, locale);
  const { roleName } = useRoleNames();

  // The engine's own sentences come in Italian for an Italian book and in English for every other, whatever the book's language is: that is the language to mark them with.
  const textLanguage = isItalian(estimate.language) ? "it" : "en";
  const rest = estimate.chaptersToWrite < estimate.chapters;
  const nothingLeft = estimate.chaptersToWrite === 0 && estimate.calls.max === 0;
  const headline = rest
    ? t("autopilot.estimate.remaining", { count: estimate.chaptersToWrite, total: estimate.chapters, words: whole(estimate.words) })
    : t("autopilot.estimate.chapters", { count: estimate.chapters, words: whole(estimate.words) });

  // What the cost and the time are, when they are not known: why, and what can be said all the same.
  const why = useWhyUnknown(estimate, basis);
  const pricedParts = (Object.keys(estimate.capabilities) as EstimateCapability[]).filter((capability) => estimate.capabilities[capability].calls.max > 0 && estimate.capabilities[capability].cost);
  const pricedPart: Range | null = estimate.cost || pricedParts.length === 0 ? null : roundMoneyRange({
    min: pricedParts.reduce((total, capability) => total + (estimate.capabilities[capability].cost?.min ?? 0), 0),
    max: pricedParts.reduce((total, capability) => total + (estimate.capabilities[capability].cost?.max ?? 0), 0),
  });

  // The director's rounds, and the size the form is: a size recommends rounds, and never writes them. The review policy of the form gives others.
  const preset = startPreset ? autopilotPresetSkeleton(startPreset) : undefined;
  const policyRounds = form.options.review?.maxRounds;
  const rounds = policyRounds ?? sources.book.directorRounds;
  const directorHref = `/app/books/${encodeURIComponent(bookId)}/director`;

  // What a screen reader is told, once the figures stopped moving: the same figures in words, and how many problems there are.
  const problems = groups.filter((group) => group.severity === "error").length;
  const callsText = calls.min === calls.max ? whole(calls.min) : `${whole(calls.min)} ${t("autopilot.estimate.to")} ${whole(calls.max)}`;
  const costText = cost ? (cost.min === cost.max ? money(cost.min) : `${money(cost.min)} ${t("autopilot.estimate.to")} ${money(cost.max)}`) : t("autopilot.estimate.notKnown");
  const timeText = minutes ? (minutes.min === minutes.max ? duration(minutes.min) : `${duration(minutes.min)} ${t("autopilot.estimate.to")} ${duration(minutes.max)}`) : t("autopilot.estimate.notEstimated");
  const outcome = `${t("autopilot.estimate.announceTitle")} ${t("autopilot.estimate.announce", { book: headline, calls: callsText, cost: costText, time: timeText })}${problems ? ` ${t("autopilot.estimate.announceErrors", { count: problems })}` : ""}`;
  const [announced, setAnnounced] = useState("");
  // What a reader of the page already has: the figures it opened with, and the ones that were told. Only a change from them, after the author changed something, is news.
  const known = useRef(outcome);
  useEffect(() => {
    if (!dirty) {
      known.current = outcome;
      return undefined;
    }
    if (outcome === known.current) return undefined;
    const timer = window.setTimeout(() => {
      known.current = outcome;
      setAnnounced(outcome);
    }, ANNOUNCE_PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [outcome, dirty]);

  const serverNote = host === "server" ? (inputs.server.status === "ready" ? "models" : inputs.server.status === "unavailable" ? "unavailable" : "asking") : null;
  const oneDecimal = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);

  return (
    <Card id="autopilot-estimate" title={t("autopilot.estimate.title")} icon={<Gauge className="h-4 w-4 text-primary" aria-hidden="true" />}>
      <p className="text-sm text-muted-foreground">{t("autopilot.estimate.intro")}</p>
      <p
        data-estimate="book"
        data-chapters={estimate.chapters}
        data-to-write={estimate.chaptersToWrite}
        data-words={estimate.words}
        className="text-sm font-medium"
      >
        {nothingLeft ? t("autopilot.estimate.nothingLeft") : headline}
      </p>

      {!nothingLeft && (
        <>
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <Stat name="calls" label={t("autopilot.estimate.stats.calls")} real={estimate.calls} shown={calls} format={whole} unknown="" />
            <Stat name="input-tokens" label={t("autopilot.estimate.stats.inputTokens")} real={estimate.inputTokens} shown={input} format={tokens} unknown="" />
            <Stat name="output-tokens" label={t("autopilot.estimate.stats.outputTokens")} real={estimate.outputTokens} shown={output} format={tokens} unknown="" />
            <Stat
              name="cost"
              label={t("autopilot.estimate.stats.cost")}
              real={estimate.cost ? { min: estimate.cost.min, max: estimate.cost.max } : null}
              shown={cost}
              format={money}
              unknown={t("autopilot.estimate.notKnown")}
              why={why.cost}
              more={pricedPart && <p data-estimate="priced-part" className="text-xs text-muted-foreground">{t("autopilot.estimate.costPartial", { cost: pricedPart.min === pricedPart.max ? money(pricedPart.min) : `${money(pricedPart.min)} ${t("autopilot.estimate.to")} ${money(pricedPart.max)}` })}</p>}
            />
            <Stat name="minutes" label={t("autopilot.estimate.stats.minutes")} real={estimate.minutes} shown={minutes} format={duration} unknown={t("autopilot.estimate.notEstimated")} why={why.minutes} />
          </dl>

          <p className="text-xs text-muted-foreground">{t("autopilot.estimate.interval", { rounds })}</p>
          {rounds !== undefined && (
            <div data-estimate="rounds" className="space-y-1 text-xs text-muted-foreground">
              <p>{policyRounds !== undefined ? t("autopilot.estimate.rounds.policy", { count: policyRounds, director: sources.book.directorRounds ?? 2 }) : t("autopilot.estimate.rounds.director", { count: rounds })}</p>
              {preset && policyRounds === undefined && preset.maxReviewRounds !== rounds && (
                <p data-estimate="preset-rounds">{t("autopilot.estimate.rounds.preset", { preset: t(`autopilot.presets.${preset.id}.name`), count: preset.maxReviewRounds, rounds })}</p>
              )}
              <Link to={directorHref} className="flex min-h-11 w-fit items-center font-medium text-foreground underline underline-offset-4">{t("autopilot.estimate.rounds.open")}</Link>
            </div>
          )}

          <table className="w-full table-fixed border-collapse text-sm">
            <caption className="sr-only">{t("autopilot.estimate.byRole")}</caption>
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th scope="col" className="w-[38%] py-1 pr-2 font-medium sm:w-[30%]">{t("autopilot.estimate.role")}</th>
                <th scope="col" className="py-1 pr-2 font-medium">{t("autopilot.estimate.model")}</th>
                <th scope="col" className="w-[28%] py-1 text-right font-medium sm:w-[28%]">{t("autopilot.estimate.calls")}</th>
              </tr>
            </thead>
            <tbody>
              {roles.map((entry) => {
                const shown = roundRange(entry.calls);
                return (
                  <tr key={entry.role} data-role={entry.role} data-min={entry.calls.min} data-max={entry.calls.max} className="border-b last:border-b-0">
                    <th scope="row" className="py-1.5 pr-2 text-left align-top font-medium">{roleName(entry.role)}</th>
                    <td className="break-words py-1.5 pr-2 align-top text-muted-foreground">
                      {entry.models.map((model, index) => <span key={model}>{index > 0 && ", "}<bdi>{model}</bdi></span>)}
                      {entry.missing && <span className="text-destructive">{entry.models.length > 0 && ", "}{t("autopilot.estimate.noModelShort")}</span>}
                    </td>
                    <td className="py-1.5 text-right align-top tabular-nums"><RangeText range={shown} format={whole} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      <EstimateWarnings groups={groups} host={host} ai={sources.ai} textLanguage={textLanguage} />

      <ul className="space-y-1.5 empty:hidden">
        {serverNote && <li data-note="server" className="flex gap-1.5 text-xs text-muted-foreground"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{t(`autopilot.estimate.server.${serverNote}`)}</li>}
        {!inputs.reading && !sources.book.read && <li data-note="unread" className="flex gap-1.5 text-xs text-muted-foreground"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{t("autopilot.estimate.unread")}</li>}
        {basis.measuredModels.length > 0 && <li data-note="measured" className="flex gap-1.5 text-xs text-muted-foreground"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{t("autopilot.estimate.basis.speed", { count: basis.speedSamples })}</li>}
        {basis.tokensPerWord && <li data-note="tokens" className="flex gap-1.5 text-xs text-muted-foreground"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{t("autopilot.estimate.basis.tokens", { count: basis.tokensPerWord.samples, value: oneDecimal(basis.tokensPerWord.value) })}</li>}
      </ul>

      <details data-estimate="assumptions" className="rounded-lg border">
        <summary className="flex min-h-11 cursor-pointer items-center px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t("autopilot.estimate.assumptions.title")}</summary>
        <ul className="list-disc space-y-1.5 px-3 pb-3 pl-7 text-xs text-muted-foreground">
          {estimate.assumptions.map((sentenceOfEngine) => <li key={sentenceOfEngine} lang={textLanguage}>{sentenceOfEngine}</li>)}
          {sources.canonEntries > 0 && <li>{t("autopilot.estimate.assumptions.canon", { count: sources.canonEntries })}</li>}
        </ul>
      </details>

      <p role="status" data-estimate="announcement" className="sr-only">{announced}</p>
    </Card>
  );
}


/** The preview of a book's run: it gathers what the estimate needs (the models, the log, the files, where the book is) and shows it. */
export function BookRunPreview({ book, branch, structure, state, form, dirty, scaletta }: { book: BookEntry; branch: string; structure: BookStructure | undefined; state: AutopilotState | null; form: SetupFormValues; dirty: boolean; scaletta?: string }) {
  const view = useBookAutopilotView(book.id);
  const inputs = useRunEstimateSources({ book, branch, structure, state, activities: view.snapshot?.activities, scaletta });
  return <RunPreview inputs={inputs} form={form} dirty={dirty} bookId={book.id} startPreset={state ? null : book.startPreset} />;
}
