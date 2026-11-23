import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import "@/i18n/githubApp";
import { bookUsesAppToken } from "@/github/githubAccessModel";
import { useSettingsStore } from "@/store/settingsStore";
import type { BookEntry } from "@/types/settings";

/**
 * The warning for a book that a personal server runs while its token is the GitHub app's: the server keeps a copy of the token for days and cannot renew an
 * 8-hour token (it has no client secret, and never receives the refresh token). It is shown where the book is handed to the server and in the book's settings.
 * Nothing is shown for a book whose token is a personal access token.
 */
export function GitHubServerTokenNotice({ book }: { book: BookEntry }) {
  const { t } = useTranslation();
  const settings = useSettingsStore((state) => state.settings);
  if (!bookUsesAppToken(book, settings)) return null;
  return (
    <p role="note" className="flex items-start gap-2 rounded-md border border-amber-600/40 bg-amber-50/60 p-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200" data-testid="github-server-token-notice">
      <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <span><span className="font-medium">{t("accountSync.github.server.warning")}</span> {t("accountSync.github.server.warningLong")}</span>
    </p>
  );
}
