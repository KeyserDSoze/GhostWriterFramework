import type { TFunction } from "i18next";
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

export function formatClock(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatDateTime(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
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
  return new Intl.NumberFormat(undefined, { notation: value >= 100_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

export function formatCost(value: number | undefined, currency: string | undefined): string {
  if (!value) return "—";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD", maximumFractionDigits: value < 1 ? 4 : 2 }).format(value);
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

export function syncStatusText(t: TFunction, sync: BookSyncStatus | null): string | null {
  if (!sync) return null;
  if (sync.message === "synced") return t("autopilot.where.synced");
  if (sync.message === "published") return t("autopilot.where.published");
  if (sync.message === "local-changes") return t("autopilot.where.localChanges");
  if (sync.message.startsWith("conflicts:")) return t("autopilot.where.conflicts");
  return sync.message;
}
