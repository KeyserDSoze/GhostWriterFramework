import { memo, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Gauge, Info } from "lucide-react";
import type { AiRuntimeConfig, AutopilotActivity, AutopilotState } from "narrarium-engine";
import { ActionLink, Stat, WarningBox, isolate, rowOf, uniqueRoles, useLocale, useRoleNames, useWhyUnknown } from "@/components/autopilot/config/EstimateParts";
import { estimateRest, restProblems, type RestProblem, type RunEstimate } from "@/autopilot/runEstimate";
import { formatMinutes, formatMoney, formatTokens, formatWhole, roundMinutesRange, roundMoneyRange, roundRange } from "@/autopilot/runEstimateFormat";
import { autopilotSettingsHref } from "@/autopilot/pageRoute";
import type { PlanReviewMode } from "@/autopilot/planApprovalModel";
import { useRunEstimateSources, type RunEstimateInputs } from "@/autopilot/useRunEstimate";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { useBookStructure } from "@/hooks/useBookStructure";
import type { BookStructure } from "@/types/book";
import type { BookEntry } from "@/types/settings";

/** True once the screen it is on has been drawn: the work that is not needed to draw it waits for the next frame and for the task after it. */
function useAfterFirstPaint(): boolean {
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    let timer = 0;
    let frame = 0;
    const later = () => {
      timer = window.setTimeout(() => setDrawn(true), 0);
    };
    if (typeof window.requestAnimationFrame === "function") frame = window.requestAnimationFrame(later);
    else later();
    return () => {
      if (frame && typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, []);
  return drawn;
}

/** The part of the card every state has: a region named by its title. */
function Frame({ state, children }: { state: "working" | "ready"; children: ReactNode }) {
  const { t } = useTranslation();
  const titleId = useId();
  return (
    <section data-plan-rest data-state={state} aria-labelledby={titleId} className="w-full basis-full space-y-3 rounded-xl border border-layer bg-background/60 p-3 sm:p-4">
      <h3 id={titleId} className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        <Gauge className="h-4 w-4" aria-hidden="true" />{t("autopilot.approval.rest.title")}
      </h3>
      {children}
    </section>
  );
}

function Working({ asking = false }: { asking?: boolean }) {
  const { t } = useTranslation();
  return <p className="text-sm text-muted-foreground">{t(asking ? "autopilot.estimate.server.asking" : "autopilot.approval.rest.working")}</p>;
}

/**
 * The problems of the models, each said once, in the words of the page, with the way to put it right: a role with no model, a window that is too small for the prompts of some roles,
 * a limit on the replies that is shorter than theirs. One role or two have a button each, to their own row of the AI Router; more have one, to the first of the rows.
 */
function RestProblems({ problems, host, ai }: { problems: readonly RestProblem[]; host: "browser" | "server"; ai: AiRuntimeConfig | null }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const { roleName, roleNames } = useRoleNames();
  if (problems.length === 0) return null;
  const whole = (value: number) => formatWhole(value, locale);
  const about = (value: number) => formatWhole(roundRange({ min: value, max: value }).min, locale);

  const buttons = (problem: RestProblem): ReactNode => {
    if (host === "server") return <ActionLink to="/app/settings/server">{t("autopilot.estimate.actions.server")}</ActionLink>;
    if (problem.code === "noModel" && (ai?.aiIntegrations.length ?? 0) === 0) return <ActionLink to="/app/settings/ai-integrations">{t("autopilot.estimate.actions.integrations")}</ActionLink>;
    const roles = uniqueRoles(problem.capabilities);
    if (roles.length > 2) return <ActionLink to={`/app/settings/ai-router#router-row-${problem.capabilities[0]}`}>{t("autopilot.approval.rest.router")}</ActionLink>;
    return roles.map((role) => <ActionLink key={role} to={`/app/settings/ai-router#router-row-${rowOf(role, problem.capabilities)}`}>{t("autopilot.estimate.actions.routerRow", { role: roleName(role) })}</ActionLink>);
  };

  const sentence = (problem: RestProblem): string => {
    switch (problem.code) {
      case "noModel": return t(host === "server" ? "autopilot.estimate.warning.noModelServer" : "autopilot.estimate.warning.noModel", { roles: roleNames(problem.capabilities) });
      case "smallWindow": return t(problem.severity === "error" ? "autopilot.approval.rest.smallWindow" : "autopilot.approval.rest.tightWindow", { model: isolate(problem.model), window: whole(problem.window), roles: roleNames(problem.capabilities), prompt: about(problem.prompt) });
      case "smallOutput": return t("autopilot.approval.rest.smallOutput", { model: isolate(problem.model), limit: whole(problem.limit), roles: roleNames(problem.capabilities), reply: about(problem.reply) });
    }
  };

  return (
    <ul aria-label={t("autopilot.estimate.warnings.label")} className="space-y-2">
      {problems.map((problem, index) => (
        <WarningBox key={`${problem.code}:${index}`} code={problem.code} severity={problem.severity} capabilities={problem.capabilities} buttons={buttons(problem)}>
          {sentence(problem)}
        </WarningBox>
      ))}
    </ul>
  );
}

function safely(sources: RunEstimateInputs["sources"], state: AutopilotState): RunEstimate | null {
  try {
    return estimateRest(sources, state);
  } catch {
    return null;
  }
}

export interface PlanRestCostProps {
  bookId: string;
  mode: PlanReviewMode;
  state: AutopilotState;
  activities: readonly AutopilotActivity[];
}

/**
 * What the rest of the run will cost, at the end of the plan that waits for the author: the calls, the tokens, the cost and the time of writing the chapters that are left,
 * worked out in memory from the plan as it is (its chapters and its scenes, not the numbers of the brief), the options of the run, the director's rounds, the Outline and the
 * models of the place where the book runs: the estimate of the setup form's preview, for this plan. It waits for the screen to be drawn, reads only the few files the preview
 * reads, and is made once for each version of the plan the state saved. Its figures are not in a live region: they are there to be read when the author gets to them.
 */
export const PlanRestCost = memo(function PlanRestCost({ bookId, mode, state, activities }: PlanRestCostProps) {
  const { book, structure } = useBookStructure(bookId);
  const { branch, ready } = useWorkingBranch(bookId);
  const drawn = useAfterFirstPaint();
  if (!book) return null;
  // A book that runs on the personal server does not need a working copy in this browser: its files, when they cannot be read here, are typical sizes.
  if (!drawn || (!ready && book.autopilotHost !== "server")) return <Frame state="working"><Working /></Frame>;
  return <RestOfThePlan book={book} branch={branch} structure={structure} mode={mode} state={state} activities={activities} />;
});

interface RestOfThePlanProps extends Omit<PlanRestCostProps, "bookId"> {
  book: BookEntry;
  branch: string;
  structure: BookStructure | undefined;
}

function RestOfThePlan({ book, branch, structure, mode, state, activities }: RestOfThePlanProps) {
  // A version of the plan is what the state saved: the same version seen again (another copy of the state, a log that was read again) is the same plan, and the same figures.
  const version = state.version;
  const lastStep = activities[activities.length - 1]?.id ?? "";
  /* eslint-disable react-hooks/exhaustive-deps */
  const planned = useMemo(() => state, [version]);
  const steps = useMemo(() => activities, [activities.length, lastStep]);
  /* eslint-enable react-hooks/exhaustive-deps */
  const inputs = useRunEstimateSources({ book, branch, structure, state: planned, activities: steps });
  const asking = inputs.host === "server" && (inputs.server.status === "idle" || inputs.server.status === "loading");
  const waiting = inputs.reading || asking;
  const { book: files, ai, language, currency, canonEntries } = inputs.sources;
  /* eslint-disable react-hooks/exhaustive-deps */
  const result = useMemo(() => (waiting ? null : safely(inputs.sources, planned)), [waiting, files, ai, language, currency, canonEntries, planned, steps]);
  /* eslint-enable react-hooks/exhaustive-deps */
  if (waiting) return <Frame state="working"><Working asking={asking} /></Frame>;
  if (!result || result.estimate.chaptersToWrite === 0) return null;
  return <RestFigures bookId={book.id} mode={mode} inputs={inputs} result={result} />;
}

function RestFigures({ bookId, mode, inputs, result }: { bookId: string; mode: PlanReviewMode; inputs: RunEstimateInputs; result: RunEstimate }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const { estimate, basis } = result;
  const { sources, host } = inputs;
  // A role with no model is said by its problem, right under the figures: they do not say it again.
  const why = useWhyUnknown(estimate, basis, true);

  const calls = roundRange(estimate.calls);
  const sent = { min: estimate.inputTokens.min + estimate.outputTokens.min, max: estimate.inputTokens.max + estimate.outputTokens.max };
  const tokens = roundRange(sent);
  const currency = estimate.cost?.currency || sources.currency || "USD";
  const cost = estimate.cost ? roundMoneyRange(estimate.cost) : null;
  const minutes = estimate.minutes ? roundMinutesRange(estimate.minutes) : null;
  const whole = (value: number) => formatWhole(value, locale);
  const inWords = (value: number) => formatTokens(value, locale);
  const money = (value: number) => formatMoney(value, currency, locale);
  const duration = (value: number) => formatMinutes(value, locale);
  const rest = estimate.chaptersToWrite < estimate.chapters;
  const headline = rest
    ? t("autopilot.estimate.remaining", { count: estimate.chaptersToWrite, total: estimate.chapters, words: whole(estimate.words) })
    : t("autopilot.estimate.chapters", { count: estimate.chapters, words: whole(estimate.words) });
  const problems = restProblems(estimate.warnings);
  const note = (name: string, text: string) => <li key={name} data-note={name} className="flex gap-1.5 text-xs text-muted-foreground"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{text}</li>;
  const notes = [
    host === "server" && inputs.server.status === "unavailable" ? note("server", t("autopilot.estimate.server.unavailable")) : null,
    !sources.book.read ? note("unread", t("autopilot.estimate.unread")) : null,
    basis.measuredModels.length > 0 ? note("measured", t("autopilot.estimate.basis.speed", { count: basis.speedSamples })) : null,
  ].filter(Boolean);

  return (
    <Frame state="ready">
      <p data-estimate="book" data-chapters={estimate.chapters} data-to-write={estimate.chaptersToWrite} data-words={estimate.words} className="text-sm font-medium">{headline}</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        <Stat name="calls" label={t("autopilot.estimate.stats.calls")} real={estimate.calls} shown={calls} format={whole} unknown="" />
        <Stat name="tokens" label={t("autopilot.approval.rest.tokens")} real={sent} shown={tokens} format={inWords} unknown="" />
        <Stat name="cost" label={t("autopilot.estimate.stats.cost")} real={estimate.cost ? { min: estimate.cost.min, max: estimate.cost.max } : null} shown={cost} format={money} unknown={t("autopilot.estimate.notKnown")} why={why.cost} />
        <Stat name="minutes" label={t("autopilot.estimate.stats.minutes")} real={estimate.minutes} shown={minutes} format={duration} unknown={t("autopilot.estimate.notEstimated")} why={why.minutes} />
      </dl>
      {mode === "revise" && <p className="text-xs text-muted-foreground">{t("autopilot.approval.rest.again")}</p>}
      <RestProblems problems={problems} host={host} ai={sources.ai} />
      {notes.length > 0 && <ul className="space-y-1.5">{notes}</ul>}
      <p className="text-xs text-muted-foreground">{t("autopilot.approval.rest.intro")}</p>
      <Link to={`${autopilotSettingsHref(bookId)}#autopilot-estimate`} className="flex min-h-11 w-fit items-center rounded-sm font-medium text-foreground underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">{t("autopilot.approval.rest.full")}</Link>
    </Frame>
  );
}
