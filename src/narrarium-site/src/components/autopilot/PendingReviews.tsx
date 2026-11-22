import "@/i18n/frozen";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Lock } from "lucide-react";
import type { PendingFrozenReview } from "narrarium-engine";

/**
 * The decisions about changed chapters that wait for the autopilot (`state.pendingReviews`), in the order it takes them: what it will do with each
 * chapter, and whether it is doing it, or does it at its next step (while a run goes on) or at its next run. Nothing when none waits.
 */
export function PendingReviews({ reviews, running }: { reviews: readonly PendingFrozenReview[] | undefined; running: boolean }) {
  const { t } = useTranslation();
  const id = useId();
  if (!reviews?.length) return null;
  // In the order of the book, as the autopilot takes them (a chapter's text before its outline).
  const ordered = [...reviews].sort((left, right) => left.number - right.number || (left.kind === right.kind ? 0 : left.kind === "frozen" ? -1 : 1));
  return (
    <section aria-labelledby={`${id}-title`} data-pending-reviews className="space-y-2 rounded-2xl border border-layer bg-card p-4 shadow-sm">
      <h2 id={`${id}-title`} className="flex items-center gap-2 text-sm font-semibold"><Lock className="h-4 w-4 text-primary" aria-hidden="true" />{t("autopilot.frozen.queue.title")}</h2>
      <ul className="space-y-1 text-sm">
        {ordered.map((review) => (
          <li key={review.id}>
            <span className="font-medium">{t("autopilot.frozen.queue.item", { number: review.number, action: t(`frozen.actions.${review.action}`) })}</span>
            <span className="text-muted-foreground"> — {t(review.started ? "autopilot.frozen.queue.started" : running ? "autopilot.frozen.queue.nextStep" : "autopilot.frozen.queue.nextRun")}{review.auto ? ` · ${t("autopilot.frozen.queue.auto")}` : ""}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
