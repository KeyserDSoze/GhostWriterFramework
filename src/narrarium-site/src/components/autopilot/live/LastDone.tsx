import { memo, useId } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Ban, CheckCircle2, XCircle } from "lucide-react";
import type { ActivityStatus, AutopilotActivity } from "narrarium-engine";
import { activityTitle, formatAgo } from "@/autopilot/format";
import { useNow } from "@/autopilot/hooks";
import { LAST_DONE, taskHref } from "@/autopilot/liveText";
import { useLastDone } from "@/autopilot/useLiveText";
import { cn } from "@/lib/utils";

/** A target a finger can hit on a phone (44 px), and a pointer elsewhere (at least 24 px). */
export const TOUCH_TARGET = "min-h-11 [@media(min-width:640px)_and_(pointer:fine)]:min-h-6";

/** How a step ended, as a shape (and a colour that only helps): the word is said beside it for a screen reader. */
function OutcomeIcon({ status }: { status: ActivityStatus }) {
  if (status === "failed") return <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" aria-hidden="true" />;
  if (status === "cancelled") return <Ban className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-500" aria-hidden="true" />;
  return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />;
}

/** One step that is over: how it ended, its title in words and how long ago, as a way to it on the Autopilot page. The time is kept fresh by this leaf. */
const DoneLink = memo(function DoneLink({ bookId, activity }: { bookId: string; activity: AutopilotActivity }) {
  const { t } = useTranslation();
  const now = useNow(30_000);
  const ended = Date.parse(activity.endedAt ?? "");
  return (
    <Link
      to={taskHref(bookId, activity.id)}
      data-last-done-item={activity.status}
      className={cn("flex items-start gap-2 rounded-md px-1.5 py-1 text-sm transition hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", TOUCH_TARGET)}
    >
      <OutcomeIcon status={activity.status} />
      <span className="min-w-0 flex-1 break-words leading-5 [overflow-wrap:anywhere]">
        <span className="sr-only">{t(`autopilot.activity.status.${activity.status}`)}: </span>
        {activityTitle(t, activity)}
      </span>
      {Number.isFinite(ended) && <span className="shrink-0 text-xs leading-5 text-muted-foreground">{formatAgo(Math.max(0, now - ended))}</span>}
    </Link>
  );
});

/**
 * «Last done»: the last steps of a book that are over (three), the newest first, each with how it ended, its title in words and how long ago, and each
 * a link to the step on the Autopilot page, opened and focused there. Nothing when no step is over yet.
 */
export const LastDone = memo(function LastDone({ bookId, limit = LAST_DONE, className }: { bookId: string; limit?: number; className?: string }) {
  const { t } = useTranslation();
  const id = useId();
  const steps = useLastDone(bookId, limit);
  if (!steps.length) return null;
  return (
    <div data-last-done className={cn("min-w-0", className)}>
      <p id={id} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("autopilot.liveText.lastDone")}</p>
      <ul aria-labelledby={id} className="-mx-1.5 mt-0.5 space-y-0.5">
        {steps.map((activity) => <li key={activity.id}><DoneLink bookId={bookId} activity={activity} /></li>)}
      </ul>
    </div>
  );
});
