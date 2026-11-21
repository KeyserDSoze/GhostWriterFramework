import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, CircleHelp, ListChecks, MessageSquareQuote, Sparkles, TriangleAlert } from "lucide-react";
import type { DirectorOpinion, DirectorVerdict } from "narrarium-engine";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const VERDICT_STYLE: Record<DirectorVerdict, string> = {
  approve: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  revise: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300",
  rewrite: "border-transparent bg-red-500/15 text-red-700 dark:text-red-300",
};

const SEVERITY_STYLE = {
  critical: "border-transparent bg-red-500/15 text-red-700 dark:text-red-300",
  major: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300",
  minor: "border-transparent bg-muted text-muted-foreground",
} as const;

export function DirectorVerdictBadge({ verdict, score, className }: { verdict: DirectorVerdict; score?: number; className?: string }) {
  const { t } = useTranslation();
  return <Badge className={cn(VERDICT_STYLE[verdict], className)}>{t(`director.opinion.verdict.${verdict}`)}{score ? ` · ${score}/10` : ""}</Badge>;
}

function Section({ icon, title, items }: { icon: ReactNode; title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <section className="space-y-1.5">
      <h4 className="flex items-center gap-1.5 text-sm font-semibold">{icon}{title}</h4>
      <ul className="list-disc space-y-1 pl-5 text-sm">{items.map((item, index) => <li key={index}>{item}</li>)}</ul>
    </section>
  );
}

/** The director's structured opinion, as returned by the shared engine. */
export function DirectorOpinionView({ opinion }: { opinion: DirectorOpinion }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <DirectorVerdictBadge verdict={opinion.verdict} score={opinion.score} />
        <span className="text-xs text-muted-foreground">{opinion.directorName} · {opinion.targetTitle}</span>
      </div>
      {opinion.answer && (
        <div className="rounded-xl border-l-4 border-primary bg-primary/5 p-3">
          <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-primary"><MessageSquareQuote className="h-3.5 w-3.5" />{t("director.opinion.answer")}</p>
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{opinion.answer}</p>
        </div>
      )}
      {opinion.summary && <p className="whitespace-pre-wrap text-sm leading-relaxed">{opinion.summary}</p>}
      <Section icon={<CheckCircle2 className="h-4 w-4 text-emerald-600" />} title={t("director.opinion.strengths")} items={opinion.strengths} />
      {opinion.concerns.length > 0 && (
        <section className="space-y-2">
          <h4 className="flex items-center gap-1.5 text-sm font-semibold"><TriangleAlert className="h-4 w-4 text-amber-600" />{t("director.opinion.concerns")}</h4>
          <ul className="space-y-2">
            {opinion.concerns.map((concern, index) => (
              <li key={index} className="rounded-lg border p-2.5 text-sm">
                <div className="flex flex-wrap items-start gap-2">
                  <Badge className={SEVERITY_STYLE[concern.severity]}>{t(`director.opinion.severity.${concern.severity}`)}</Badge>
                  <p className="min-w-0 flex-1">{concern.issue}</p>
                </div>
                {concern.evidence && <blockquote className="mt-1.5 border-l-2 pl-2 font-serif text-xs italic text-muted-foreground">«{concern.evidence}»</blockquote>}
                {concern.suggestion && <p className="mt-1.5 text-xs"><span className="font-medium">→</span> {concern.suggestion}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}
      <Section icon={<Sparkles className="h-4 w-4 text-primary" />} title={t("director.opinion.decisions")} items={opinion.decisions} />
      <Section icon={<ListChecks className="h-4 w-4 text-sky-600" />} title={t("director.opinion.nextSteps")} items={opinion.nextSteps} />
      <Section icon={<CircleHelp className="h-4 w-4 text-muted-foreground" />} title={t("director.opinion.questions")} items={opinion.questionsForAuthor} />
    </div>
  );
}
