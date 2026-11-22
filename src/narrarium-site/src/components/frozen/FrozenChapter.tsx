import "@/i18n/frozen";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Loader2, Lock, LockOpen, Play, TriangleAlert } from "lucide-react";
import type { FrozenAction, FrozenChapterChanges } from "narrarium-engine";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FROZEN_SERVER_VERSION } from "@/autopilot/frozenChapters";
import { autopilotLiveHref } from "@/autopilot/pageRoute";
import type { FrozenChapterModel } from "@/components/frozen/useFrozenChapter";

/** The decisions that call the AI: they wait in the queue for the autopilot's next run. */
const AI_ACTIONS: readonly FrozenAction[] = ["review-and-update", "review-only", "rewrite-to-outline"];

function dayOf(iso: string, language: string): string {
  try {
    return new Intl.DateTimeFormat(language || "en", { dateStyle: "medium" }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

/**
 * The freeze of the chapter, where the page shows what the chapter is: when it was frozen and by whom (in words, with a lock), the switch that
 * freezes it by hand or takes the record away (after a confirmation), and what the last of those did.
 */
export function FrozenChapterBar({ frozen }: { frozen: FrozenChapterModel | null }) {
  const { t, i18n } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  if (!frozen) return null;
  const { record } = frozen;
  return (
    <div className="flex flex-wrap items-center gap-2" data-frozen-bar>
      {record && (
        <span data-frozen-badge title={t("frozen.badge.help")} className="inline-flex items-center gap-1.5 rounded-full border border-layer bg-muted/40 px-2.5 py-1 text-xs font-medium">
          <Lock className="h-3.5 w-3.5" aria-hidden="true" />
          {t(record.by === "author" ? "frozen.badge.author" : "frozen.badge.autopilot", { date: dayOf(record.at, i18n.language) })}
        </span>
      )}
      {!record && frozen.problem && (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/5 px-2.5 py-1 text-xs font-medium" title={frozen.problem}>
          <TriangleAlert className="h-3.5 w-3.5 text-amber-700 dark:text-amber-500" aria-hidden="true" />
          {t("frozen.badge.problem")}
        </span>
      )}
      <Button type="button" size="sm" variant="outline" className="h-8" disabled={frozen.busy || frozen.serverUnsupported} onClick={() => (record ? setConfirming(true) : void frozen.setFrozen(true))}>
        {record ? <LockOpen className="h-3.5 w-3.5" aria-hidden="true" /> : <Lock className="h-3.5 w-3.5" aria-hidden="true" />}
        {t(record ? "frozen.toggle.unfreeze" : "frozen.toggle.freeze")}
      </Button>
      <p role="status" className="text-xs text-muted-foreground empty:hidden">{frozen.outcome ?? ""}</p>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent role="alertdialog" className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("frozen.unfreeze.title")}</DialogTitle>
            <DialogDescription>{t("frozen.unfreeze.description")}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => setConfirming(false)}>{t("common.cancel")}</Button>
            <Button type="button" onClick={() => { setConfirming(false); void frozen.setFrozen(false); }}>{t("frozen.unfreeze.confirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function changedLines(t: (key: string, options?: Record<string, unknown>) => string, changed: FrozenChapterChanges): string[] {
  return [
    changed.modified.length ? t("frozen.change.modified", { list: changed.modified.join(", ") }) : "",
    changed.added.length ? t("frozen.change.added", { list: changed.added.join(", ") }) : "",
    changed.removed.length ? t("frozen.change.removed", { list: changed.removed.join(", ") }) : "",
    changed.body ? t("frozen.change.body") : "",
  ].filter(Boolean);
}

/**
 * Under the editor of a frozen chapter that changed since it was frozen: what changed, and the decisions the author can take about it, each with
 * what it does (a review waits in the queue for the autopilot's next run, which the author can start from here), or the decision already queued.
 */
export function FrozenChangeNotice({ frozen }: { frozen: FrozenChapterModel | null }) {
  const { t } = useTranslation();
  const id = useId();
  if (!frozen?.record || !frozen.changed) return null;
  const titleId = `${id}-title`;
  const lines = changedLines(t, frozen.changed);
  const { actions, pending } = frozen;
  return (
    <section aria-labelledby={titleId} data-frozen-notice className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
      <h2 id={titleId} className="flex items-center gap-2 text-sm font-semibold">
        <Lock className="h-4 w-4 text-amber-700 dark:text-amber-500" aria-hidden="true" />
        {t("frozen.change.title")}
      </h2>
      {lines.length > 0 && (
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {lines.map((line) => <li key={line}>{line}</li>)}
        </ul>
      )}
      {frozen.serverUnsupported ? (
        <p className="text-sm">{t("frozen.server.unsupported", { version: FROZEN_SERVER_VERSION })}</p>
      ) : frozen.inHands ? (
        <p className="text-sm">{t("frozen.change.inHands")}</p>
      ) : pending ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">{t("frozen.queued.title", { action: t(`frozen.actions.${pending.action}`) })}</p>
          <p className="text-sm text-muted-foreground">{t(frozen.running ? "frozen.queued.running" : "frozen.queued.next")}</p>
          <div className="flex flex-wrap gap-2">
            {!frozen.running && frozen.hasAutopilot && (
              <Button type="button" size="sm" disabled={frozen.busy} onClick={() => void frozen.start()}>
                <Play className="h-3.5 w-3.5" aria-hidden="true" />{t("frozen.queued.start")}
              </Button>
            )}
            <Button asChild size="sm" variant="outline">
              <Link to={autopilotLiveHref(frozen.bookId)}>{t("frozen.queued.follow")}</Link>
            </Button>
          </div>
        </div>
      ) : frozen.checking ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{t("frozen.change.checking")}</p>
      ) : (
        <div className="space-y-2">
          <p className="text-sm">{t("frozen.change.intro")}</p>
          <ul className="grid gap-3 sm:grid-cols-3">
            {actions.map((action) => (
              <li key={action} className="space-y-1">
                <Button type="button" size="sm" variant={action === "mark-reviewed" ? "outline" : "default"} className="h-auto min-h-9 w-full justify-start whitespace-normal py-1.5 text-left" disabled={frozen.busy} aria-describedby={`${id}-${action}`} onClick={() => void frozen.decide(action)}>
                  {t(`frozen.actions.${action}`)}
                </Button>
                <p id={`${id}-${action}`} className="text-xs text-muted-foreground">{t(`frozen.actionHelp.${action}`)}</p>
              </li>
            ))}
          </ul>
          {actions.some((action) => AI_ACTIONS.includes(action)) && <p className="text-xs text-muted-foreground">{t("frozen.change.queuedAi")}</p>}
          {actions.length === 1 && actions[0] === "mark-reviewed" && <p className="text-xs text-muted-foreground">{t("frozen.change.notInPlan")}</p>}
        </div>
      )}
    </section>
  );
}
