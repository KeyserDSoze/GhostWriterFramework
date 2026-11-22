import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Ban, CheckCircle2, Cloud, Flag, Info, Loader2, Play, Sparkles, XCircle } from "lucide-react";
import type { AutopilotEvent, AutopilotStatus } from "narrarium-engine";
import { Badge } from "@/components/ui/badge";
import { useElapsed } from "@/autopilot/hooks";
import { TONE_BORDER, TONE_TEXT, STATUS_BADGE, activityTitle, formatClock, formatDuration, presentFeedEvent } from "@/autopilot/format";
import { useAutopilotStore, type LivePreview } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { cn } from "@/lib/utils";

export function AutopilotStatusBadge({ status, className }: { status: AutopilotStatus | null | undefined; className?: string }) {
  const { t } = useTranslation();
  if (!status) return <Badge variant="outline" className={className}>{t("autopilot.notStarted")}</Badge>;
  return (
    <Badge className={cn(STATUS_BADGE[status], className)}>
      {status === "running" && <span className="mr-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden />}
      {t(`autopilot.status.${status}`)}
    </Badge>
  );
}

/** What the autopilot is doing right now, with the text it is streaming. */
export function AutopilotLiveCard({ preview, bookTitle, className }: { preview: LivePreview; bookTitle?: string; className?: string }) {
  const { t } = useTranslation();
  const elapsed = useElapsed(preview.activity.startedAt);
  const activity = preview.activity;
  return (
    <div className={cn("rounded-xl border border-primary/30 bg-primary/5 p-3", className)} aria-live="polite">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-primary">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>{t("autopilot.feed.now")}</span>
        {bookTitle && <span className="min-w-0 truncate normal-case tracking-normal text-muted-foreground">· {bookTitle}</span>}
        <span className="ml-auto shrink-0 tabular-nums normal-case tracking-normal text-muted-foreground">{formatDuration(elapsed)}</span>
      </div>
      <p className="mt-1.5 text-sm font-medium leading-snug">{activityTitle(t, activity)}</p>
      {activity.reason && <p className="mt-1 text-xs text-muted-foreground"><span className="font-medium text-foreground/80">{t("autopilot.why")}:</span> {activity.reason}</p>}
      {activity.next && <p className="mt-0.5 text-xs text-muted-foreground"><span className="font-medium text-foreground/80">{t("autopilot.next")}:</span> {activity.next}</p>}
      {preview.preview && (
        <p className="mt-2 max-h-32 overflow-hidden whitespace-pre-wrap rounded-md bg-background/70 p-2 font-serif text-xs italic leading-relaxed text-muted-foreground [mask-image:linear-gradient(to_bottom,transparent,black_35%)]">
          {preview.preview}
        </p>
      )}
      {preview.characters > 0 && <p className="mt-1 text-xs tabular-nums text-muted-foreground">{t("autopilot.characters", { count: preview.characters })}</p>}
    </div>
  );
}

function EventIcon({ event, className }: { event: AutopilotEvent; className?: string }) {
  if (event.type === "run-started") return <Play className={className} />;
  if (event.type === "run-ended") return <Flag className={className} />;
  if (event.type === "sync") return <Cloud className={className} />;
  if (event.type === "task-finished") {
    if (event.activity.status === "succeeded") return <CheckCircle2 className={className} />;
    if (event.activity.status === "cancelled") return <Ban className={className} />;
    return <XCircle className={className} />;
  }
  if (event.type === "insight") {
    if (event.tone === "warning" || event.tone === "critical") return <AlertTriangle className={className} />;
    if (event.tone === "ok") return <Sparkles className={className} />;
  }
  return <Info className={className} />;
}

/**
 * Everything the autopilot did, newest first: finished steps with their result, the director's and
 * readers' insights, sync notices, and the step running now with its live text.
 */
export function AutopilotFeed({ bookId, showBook = false, limit = 200, className, emptyText }: { bookId?: string; showBook?: boolean; limit?: number; className?: string; emptyText?: string }) {
  const { t } = useTranslation();
  const feed = useAutopilotStore((state) => state.feed);
  const live = useAutopilotStore((state) => state.live);
  const books = useSettingsStore((state) => state.settings.books);
  const currency = useSettingsStore((state) => state.settings.costCurrency);
  const titles = useMemo(() => new Map(books.map((book) => [book.id, book.name])), [books]);
  const entries = useMemo(() => feed
    .filter((entry) => (bookId ? entry.event.bookId === bookId : titles.has(entry.event.bookId)) && entry.event.type !== "task-started")
    .slice(-limit)
    .reverse(), [feed, bookId, limit, titles]);
  const running = useMemo(() => Object.entries(live)
    .filter((entry): entry is [string, LivePreview] => Boolean(entry[1]) && (bookId ? entry[0] === bookId : titles.has(entry[0]))), [live, bookId, titles]);

  return (
    <div className={cn("space-y-3", className)}>
      {running.map(([id, preview]) => <AutopilotLiveCard key={preview.activity.id} preview={preview} bookTitle={showBook ? titles.get(id) ?? id : undefined} />)}
      {entries.length === 0 && running.length === 0 ? (
        <p className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">{emptyText ?? t("autopilot.feedEmpty")}</p>
      ) : (
        <ol className="space-y-1.5">
          {entries.map((entry) => {
            const view = presentFeedEvent(t, entry.event, currency);
            if (!view) return null;
            return (
              <li key={`${entry.event.bookId}:${entry.event.seq}:${entry.event.at}`} className={cn("flex gap-2 rounded-r-md border-l-2 bg-muted/20 py-1.5 pl-2.5 pr-2", TONE_BORDER[view.tone])}>
                <EventIcon event={entry.event} className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", TONE_TEXT[view.tone])} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm leading-snug">{view.text}</p>
                  {view.detail && <p className={cn("mt-0.5 whitespace-pre-wrap break-words text-xs text-muted-foreground", !view.full && "line-clamp-3")}>{view.detail}</p>}
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    <span className="tabular-nums">{formatClock(entry.event.at)}</span>
                    {showBook && <span> · {titles.get(entry.event.bookId) ?? entry.bookTitle}</span>}
                    {view.meta && <span> · {view.meta}</span>}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
