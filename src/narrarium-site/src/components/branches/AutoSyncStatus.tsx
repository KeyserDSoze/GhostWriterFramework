import { useTranslation } from "react-i18next";
import { useBranchSyncStore, type CycleSummary } from "@/branches/syncStore";
import { RepositoryError, repositoryErrorDescription, type RepositoryErrorKind } from "@/repository/repositoryError";
import type { AutoSyncMode } from "@/types/settings";
import "@/i18n/branches";

/** "3 minutes ago", "now", in the person's language. */
export function relativeTime(at: number, now: number, locale: string): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const seconds = Math.round((at - now) / 1000);
  if (Math.abs(seconds) < 60) return format.format(0, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  return Math.abs(hours) < 24 ? format.format(hours, "hour") : format.format(Math.round(hours / 24), "day");
}

/** What a cycle did, in words: each thing it did, or that there was nothing to do. */
export function summaryWords(summary: CycleSummary, t: (key: string, options?: Record<string, unknown>) => string): string {
  const parts = [
    summary.pulled ? t("branches.autoSync.pulled", { count: summary.pulledFiles }) : "",
    summary.pushed ? t("branches.autoSync.pushed") : "",
    summary.published ? t("branches.autoSync.published") : "",
    summary.downloaded ? t("branches.autoSync.downloaded", { count: summary.downloaded }) : "",
    summary.attention ? t("branches.autoSync.attention", { count: summary.attention }) : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : t("branches.autoSync.nothing");
}

/**
 * The automatic sync of a book in two short lines, for the menu of the sync pill and the switcher (it loads with them, not with the shell): its mode (off said plainly), and what the last cycle did
 * and when (or that it is running, waiting for the autopilot, or could not reach GitHub and when it tries again). Nothing it does goes unsaid.
 */
export function AutoSyncStatus({ bookId, mode, pending, className }: { bookId: string; mode: AutoSyncMode; pending?: boolean; className?: string }) {
  const { t, i18n } = useTranslation();
  const state = useBranchSyncStore((store) => store.books[bookId]);
  const locale = i18n.resolvedLanguage || i18n.language;
  const now = Date.now();
  const summary = state?.lastSummary;
  let line: string;
  if (state?.status === "running") line = t("branches.autoSync.running");
  else if (state?.status === "autopilot") line = t("branches.autoSync.autopilot");
  else if (summary?.failed) {
    const reason = repositoryErrorDescription(new RepositoryError("", summary.failed as RepositoryErrorKind, "list"), t);
    const retry = state?.pausedUntil && state.pausedUntil > now ? relativeTime(state.pausedUntil, now, locale) : t("branches.autoSync.soon");
    line = t("branches.autoSync.failed", { when: relativeTime(summary.at, now, locale), reason, retry });
  } else if (summary) line = t("branches.autoSync.last", { when: relativeTime(summary.at, now, locale), what: summaryWords(summary, t) });
  else line = t("branches.autoSync.never");
  return (
    <div className={className} data-testid="auto-sync-status">
      <p className={mode === "off" ? "font-medium text-foreground" : undefined}>{t(`branches.autoSync.mode.${mode}`)}</p>
      {mode !== "off" || summary ? <p>{line}</p> : null}
      {pending && <p>{t("branches.pendingMenu")}</p>}
    </div>
  );
}
