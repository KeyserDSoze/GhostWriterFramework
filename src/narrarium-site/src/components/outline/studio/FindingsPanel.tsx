import { forwardRef } from "react";
import { useTranslation } from "react-i18next";
import { Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/autopilot/format";
import type { FindingView, FindingsView } from "@/outline/designReviewModel";

export type FindingAction = "fix" | "mine" | "dismiss" | "reopen";

export interface FindingsPanelProps {
  view: FindingsView;
  /** Something holds the book: the buttons wait. */
  disabled: boolean;
  /** The design cannot be made again (chapters are written): a fix is not offered. */
  fixBlocked: boolean;
  onDecide: (finding: FindingView, action: FindingAction) => void;
}

const SEVERITY_STYLE = { critical: "border-red-600/60 text-red-800 dark:text-red-300", major: "border-amber-600/60 text-amber-900 dark:text-amber-300", minor: "border-layer text-muted-foreground" } as const;

function Finding({ view, disabled, fixBlocked, onDecide }: { view: FindingView } & Pick<FindingsPanelProps, "disabled" | "fixBlocked" | "onDecide">) {
  const { t } = useTranslation();
  const { finding } = view;
  const chapters = finding.chapters.join(", ");
  const requires = finding.requires.join(", ");
  const text = finding.text.length > 90 ? `${finding.text.slice(0, 90)}…` : finding.text;
  const act = (action: FindingAction, label: string, key: string, variant: "default" | "outline" | "ghost" = "outline") => (
    <Button type="button" size="sm" variant={variant} data-finding-action={action} disabled={disabled || (action === "fix" && fixBlocked)} aria-label={t(`designReview.findings.${key}`, { text })} onClick={() => onDecide(view, action)}>{label}</Button>
  );
  return (
    <li data-finding={finding.id} data-finding-severity={finding.severity} data-finding-status={finding.status} className="space-y-1.5 rounded-xl border border-layer bg-background p-3">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLE[finding.severity]}`}>{t(`designReview.severity.${finding.severity}`)}</span>
        <span className="font-medium">{t(`designReview.kind.${finding.kind}`)}</span>
        <span className="text-muted-foreground">· {finding.chapters.length ? t(finding.chapters.length === 1 ? "designReview.findings.whereOne" : "designReview.findings.where", { chapters }) : t("designReview.findings.whole")}</span>
        <span className="text-xs text-muted-foreground">· {t(`designReview.findings.source.${finding.source}`)}</span>
      </p>
      <p className="text-sm">{finding.text}</p>
      {finding.proposal && <p className="text-sm text-muted-foreground">{t("designReview.findings.proposal", { text: finding.proposal })}</p>}
      {finding.requires.length > 0 && <p className="text-xs text-muted-foreground">{t(finding.requires.length === 1 ? "designReview.findings.reviseOne" : "designReview.findings.revise", { chapters: requires })}</p>}
      {finding.owner === "author" && <p className="text-xs font-medium">{t("designReview.findings.authors")}</p>}
      {finding.owner === "both" && <p className="text-xs font-medium">{t("designReview.findings.both")}</p>}
      {finding.decision && finding.status !== "fixed" && (
        <p className="text-xs text-muted-foreground">
          {finding.decision.reason
            ? t("designReview.findings.decision", { who: t(`designReview.findings.who.${finding.decision.by}`), reason: finding.decision.reason })
            : t("designReview.findings.decisionNoReason", { who: t(`designReview.findings.who.${finding.decision.by}`) })}
          {" · "}{formatDate(finding.decision.at)}
        </p>
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        {view.canFix && act("fix", t("designReview.findings.fix"), "fixLabel", "default")}
        {view.canTake && act("mine", t("designReview.findings.mine"), "mineLabel")}
        {view.canDismiss && act("dismiss", t("designReview.findings.dismiss"), "dismissLabel", "ghost")}
        {view.canReopen && act("reopen", t("designReview.findings.reopen"), "reopenLabel", "ghost")}
      </div>
      {view.canFix && fixBlocked === false && <p className="text-xs text-muted-foreground">{t("designReview.findings.fixHint")}</p>}
    </li>
  );
}

/**
 * The findings of the analysis of the whole structure: what does not hold together, where, which chapters to revise and what to do; and what the author can do about each one,
 * with one click: ask the autopilot to fix it, handle it herself, or say it is not a problem. A finding that concerns only entries she wrote is hers: the autopilot only proposes.
 */
export const FindingsPanel = forwardRef<HTMLHeadingElement, FindingsPanelProps>(function FindingsPanel({ view, disabled, fixBlocked, onDecide }, headingRef) {
  const { t } = useTranslation();
  const total = view.open.length + view.fixing.length + view.mine.length + view.dismissed.length + view.fixed.length;
  const groups: Array<{ key: "open" | "fixing" | "mine" | "dismissed" | "fixed"; collapsed: boolean }> = [
    { key: "open", collapsed: false },
    { key: "fixing", collapsed: false },
    { key: "mine", collapsed: false },
    { key: "dismissed", collapsed: true },
    { key: "fixed", collapsed: true },
  ];
  return (
    <section aria-labelledby="studio-findings-title" data-design-findings className="space-y-3 rounded-2xl border border-layer bg-card p-4 shadow-sm sm:p-5">
      <h2 id="studio-findings-title" ref={headingRef} tabIndex={-1} className="flex items-center gap-2 text-lg font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"><Wrench className="h-5 w-5 text-primary" aria-hidden="true" />{t("designReview.findings.title")}</h2>
      <p className="max-w-3xl text-sm text-muted-foreground">{t("designReview.findings.intro")}</p>
      <p className="text-xs text-muted-foreground">
        {t("designReview.findings.analysed", { date: formatDate(view.analysedAt) })}
        {view.summary && <> {view.summary}</>}
      </p>
      {total === 0 && <p data-findings-none className="text-sm font-medium">{t("designReview.findings.none")}</p>}
      {view.open.length > 0 && <p data-findings-counts className="text-sm font-medium">{t("designReview.findings.counts", view.counts)}</p>}
      {groups.map(({ key, collapsed }) => {
        const list = view[key];
        if (!list.length) return null;
        const items = <ul className="space-y-2">{list.map((entry) => <Finding key={entry.finding.id} view={entry} disabled={disabled} fixBlocked={fixBlocked} onDecide={onDecide} />)}</ul>;
        return collapsed ? (
          <details key={key} data-finding-group={key} className="space-y-2">
            <summary className="cursor-pointer text-sm font-semibold">{t(`designReview.findings.groups.${key}`)} ({list.length})</summary>
            <div className="mt-2">{items}</div>
          </details>
        ) : (
          <div key={key} data-finding-group={key} className="space-y-2">
            <h3 className="text-sm font-semibold">{t(`designReview.findings.groups.${key}`)} ({list.length})</h3>
            {items}
          </div>
        );
      })}
    </section>
  );
});
