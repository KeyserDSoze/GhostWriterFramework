import i18next, { type TFunction } from "i18next";
import type { AutopilotEvent, AutopilotStateSummary, AutopilotStatus, InsightTone } from "narrarium-engine";
import type { BookSyncStatus } from "@/autopilot/store";

export type FeedTone = InsightTone;

export const TONE_BORDER: Record<FeedTone, string> = {
  ok: "border-l-emerald-500",
  info: "border-l-sky-500",
  warning: "border-l-amber-500",
  critical: "border-l-red-500",
};

export const TONE_TEXT: Record<FeedTone, string> = {
  ok: "text-emerald-600 dark:text-emerald-400",
  info: "text-sky-600 dark:text-sky-400",
  warning: "text-amber-600 dark:text-amber-400",
  critical: "text-red-600 dark:text-red-400",
};

export const STATUS_BADGE: Record<AutopilotStatus, string> = {
  idle: "border-transparent bg-muted text-muted-foreground",
  running: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  paused: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300",
  "waiting-author": "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300",
  error: "border-transparent bg-red-500/15 text-red-700 dark:text-red-300",
  completed: "border-transparent bg-primary/15 text-primary",
};

/** The language of the app, not the one of the browser: dates and numbers read like the rest of the screen. */
function locale(): string | undefined {
  return i18next.resolvedLanguage || i18next.language || undefined;
}

export function formatClock(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatDateTime(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" });
}

/** "now", "25 seconds ago", "4 minutes ago", "3 hours ago", "10 days ago" (and the same in the other language). */
export function formatAgo(milliseconds: number): string {
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: "auto" });
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  if (seconds < 10) return rtf.format(0, "second");
  if (seconds < 60) return rtf.format(-seconds, "second");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  return rtf.format(-Math.floor(hours / 24), "day");
}

/** "300 B", "1.2 KB", "3.4 MB". */
export function formatBytes(bytes: number): string {
  const number = (value: number, fraction: number) => new Intl.NumberFormat(locale(), { maximumFractionDigits: fraction }).format(value);
  if (bytes < 1024) return `${number(bytes, 0)} B`;
  if (bytes < 1024 * 1024) return `${number(bytes / 1024, 1)} KB`;
  return `${number(bytes / (1024 * 1024), 1)} MB`;
}

export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return "—";
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat(locale(), { notation: value >= 100_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

export function formatCost(value: number | undefined, currency: string | undefined): string {
  if (!value) return "—";
  try {
    return new Intl.NumberFormat(locale(), { style: "currency", currency: currency || "USD", maximumFractionDigits: value < 1 ? 4 : 2 }).format(value);
  } catch {
    return `${value.toFixed(value < 1 ? 4 : 2)} ${currency ?? ""}`.trim();
  }
}

/** "Writing · Chapters approved: 1/3 · Words: 4,200"; once completed the status badge already says so. */
export function autopilotSummaryLine(t: TFunction, summary: AutopilotStateSummary): string {
  return [
    summary.phase === "completed" ? "" : t(`autopilot.phase.${summary.phase}`),
    `${t("autopilot.progress.chapters")}: ${summary.progress.chaptersDone}/${summary.progress.chapters}`,
    `${t("autopilot.progress.words")}: ${formatCount(summary.progress.words)}`,
  ].filter(Boolean).join(" · ");
}

export interface FeedPresentation {
  tone: FeedTone;
  text: string;
  detail?: string;
  meta?: string;
}

/** How an autopilot event reads in the feed, in the UI language where the engine gives a code. */
export function presentFeedEvent(t: TFunction, event: AutopilotEvent, currency?: string): FeedPresentation | null {
  switch (event.type) {
    case "run-started":
      return { tone: "info", text: t("autopilot.feed.runStarted", { host: t(`autopilot.host.${event.host}`) }) };
    case "run-ended":
      return {
        tone: event.status === "completed" ? "ok" : event.status === "error" ? "critical" : event.status === "waiting-author" ? "warning" : "info",
        text: t("autopilot.feed.runEnded", { status: t(`autopilot.status.${event.status}`) }),
        detail: event.message ?? undefined,
      };
    case "task-finished": {
      const activity = event.activity;
      const tone: FeedTone = activity.status === "succeeded" ? "ok" : activity.status === "failed" ? "critical" : "warning";
      const meta = [activity.model, activity.cost ? formatCost(activity.cost, currency) : ""].filter(Boolean).join(" · ");
      return {
        tone,
        text: activity.status === "succeeded" ? activity.title : `${activity.title} — ${t(`autopilot.activity.status.${activity.status}`)}`,
        detail: activity.status === "succeeded" ? activity.summary : activity.error,
        meta: meta || undefined,
      };
    }
    case "insight":
    case "sync":
      return { tone: event.tone, text: event.code ? t(`autopilot.insight.${event.code}`, { defaultValue: event.title }) : event.title, detail: event.detail };
    default:
      return null;
  }
}

/** What the last sync of a book came to, in the language of the app; each outcome reads differently. */
export function syncStatusText(t: TFunction, sync: BookSyncStatus | null): string | null {
  if (!sync) return null;
  switch (sync.kind) {
    case "synced": return t("autopilot.where.synced");
    case "up-to-date": return t("autopilot.where.upToDate");
    case "published": return t("autopilot.where.published");
    case "local-changes": return t("autopilot.where.localChanges");
    case "conflicts": return t("autopilot.where.conflicts", { count: sync.conflicts.length });
    default: return sync.message;
  }
}
