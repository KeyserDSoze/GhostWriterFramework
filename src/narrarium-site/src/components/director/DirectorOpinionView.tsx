import type { ReactNode } from "react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, CircleHelp, ListChecks, MessageSquareQuote, RotateCcw, Sparkles, ThumbsUp, TriangleAlert, XCircle } from "lucide-react";
import type { TFunction } from "i18next";
import type { DirectorOpinion, DirectorVerdict } from "narrarium-engine";
import { Badge } from "@/components/ui/badge";
import { formatCost, formatCount } from "@/autopilot/format";
import { cn } from "@/lib/utils";

const VERDICT_STYLE: Record<DirectorVerdict, string> = {
  approve: "border-transparent bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  revise: "border-transparent bg-amber-500/15 text-amber-800 dark:text-amber-300",
  rewrite: "border-transparent bg-red-500/15 text-red-800 dark:text-red-300",
};

const VERDICT_ICON: Record<DirectorVerdict, typeof CheckCircle2> = { approve: CheckCircle2, revise: RotateCcw, rewrite: XCircle };

const SEVERITY_STYLE = {
  critical: "border-transparent bg-red-500/15 text-red-800 dark:text-red-300",
  major: "border-transparent bg-amber-500/15 text-amber-800 dark:text-amber-300",
  minor: "border-transparent bg-muted text-muted-foreground",
} as const;

/** The verdict in words, with an icon (the colour only helps), and the score when it is given. */
export function DirectorVerdictBadge({ verdict, score, className }: { verdict: DirectorVerdict; score?: number; className?: string }) {
  const { t } = useTranslation();
  const Icon = VERDICT_ICON[verdict];
  return (
    <Badge className={cn("gap-1", VERDICT_STYLE[verdict], className)}>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {t(`director.opinion.verdict.${verdict}`)}{score ? ` · ${formatCount(score)}/10` : ""}
    </Badge>
  );
}

/** Where the score is on its scale, from 0 to 10: a picture of the number it sits beside, so it is hidden from screen readers. */
function ScoreScale({ score }: { score: number }) {
  const percent = Math.min(100, Math.max(0, score * 10));
  return (
    <div aria-hidden="true" className="relative h-2 w-full max-w-56 rounded-full bg-muted ring-1 ring-inset ring-border">
      <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
    </div>
  );
}

function Section({ icon, title, items, children }: { icon: ReactNode; title: string; items?: string[]; children?: ReactNode }) {
  const id = useId();
  if (items && !items.length) return null;
  return (
    <section aria-labelledby={id} className="space-y-1.5">
      <h4 id={id} className="flex items-center gap-1.5 text-sm font-semibold">{icon}{title}</h4>
      {items ? <ul className="list-disc space-y-1 pl-5 text-sm">{items.map((item, index) => <li key={index}>{item}</li>)}</ul> : children}
    </section>
  );
}

/** What the opinion cost, in one line, said only for what the provider told: never a cost of zero for one it did not. */
function costLine(t: TFunction, opinion: DirectorOpinion): string | null {
  const tokens = opinion.usage ? (opinion.usage.inputTokens ?? 0) + (opinion.usage.outputTokens ?? 0) : 0;
  const parts = [
    opinion.cost ? t("director.card.cost", { cost: formatCost(opinion.cost, opinion.currency) }) : null,
    tokens > 0 ? t("director.card.tokens", { tokens: formatCount(tokens) }) : null,
    opinion.model?.trim() || null,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(" · ") : null;
}

/**
 * The director's opinion as a score card: the score first, large, with its scale and the verdict; then the answer to the question, the summary, the
 * strong and the weak points side by side, the decisions, the next steps and the questions for the author; and what it cost.
 */
export function DirectorOpinionView({ opinion }: { opinion: DirectorOpinion }) {
  const { t } = useTranslation();
  const cost = costLine(t, opinion);
  return (
    <div className="space-y-4">
      <div data-score-card className="flex flex-wrap items-center gap-4 rounded-2xl border border-layer bg-muted/30 p-4">
        <div className="min-w-16 text-center">
          <p className="font-serif text-5xl font-semibold leading-none tabular-nums">{formatCount(opinion.score)}</p>
          <p className="mt-1 text-xs font-medium text-muted-foreground">{t("director.card.scale")}</p>
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <DirectorVerdictBadge verdict={opinion.verdict} />
          <ScoreScale score={opinion.score} />
          <p className="text-xs text-muted-foreground">{opinion.directorName} · {opinion.targetTitle}</p>
        </div>
      </div>
      {opinion.answer && (
        <div className="rounded-xl border-l-4 border-primary bg-primary/5 p-3">
          <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-primary"><MessageSquareQuote className="h-3.5 w-3.5" aria-hidden="true" />{t("director.opinion.answer")}</p>
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{opinion.answer}</p>
        </div>
      )}
      {opinion.summary && <p className="whitespace-pre-wrap text-sm leading-relaxed">{opinion.summary}</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Section icon={<ThumbsUp className="h-4 w-4 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />} title={t("director.opinion.strengths")} items={opinion.strengths} />
        {opinion.concerns.length > 0 && (
          <Section icon={<TriangleAlert className="h-4 w-4 text-amber-700 dark:text-amber-500" aria-hidden="true" />} title={t("director.opinion.concerns")}>
            <ul className="space-y-2">
              {opinion.concerns.map((concern, index) => (
                <li key={index} className="rounded-lg border p-2.5 text-sm">
                  <div className="flex flex-wrap items-start gap-2">
                    <Badge className={SEVERITY_STYLE[concern.severity]}>{t(`director.opinion.severity.${concern.severity}`)}</Badge>
                    <p className="min-w-0 flex-1">{concern.issue}</p>
                  </div>
                  {concern.evidence && <blockquote className="mt-1.5 border-l-2 pl-2 font-serif text-xs italic text-muted-foreground">«{concern.evidence}»</blockquote>}
                  {concern.suggestion && <p className="mt-1.5 text-xs"><span className="font-medium" aria-hidden="true">→</span> {concern.suggestion}</p>}
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
      <Section icon={<Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />} title={t("director.opinion.decisions")} items={opinion.decisions} />
      <Section icon={<ListChecks className="h-4 w-4 text-sky-700 dark:text-sky-400" aria-hidden="true" />} title={t("director.opinion.nextSteps")} items={opinion.nextSteps} />
      <Section icon={<CircleHelp className="h-4 w-4 text-muted-foreground" aria-hidden="true" />} title={t("director.opinion.questions")} items={opinion.questionsForAuthor} />
      {cost && <p className="text-xs text-muted-foreground">{cost}</p>}
    </div>
  );
}
