import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import "@/i18n/githubApp";
import { UsePersonalTokenButton, usePersonalTokenDialog } from "@/components/book/UsePersonalTokenButton";
import type { SavedBookToken } from "@/components/book/BookTokenDialog";
import { bookUsesAppToken } from "@/github/githubAccessModel";
import { useSettingsStore } from "@/store/settingsStore";
import type { BookEntry } from "@/types/settings";

/**
 * The warning for a book that a personal server runs while its token is the GitHub app's: the server keeps a copy of the token for days and cannot renew an
 * 8-hour token (it has no client secret, and never receives the refresh token). It is shown where the book is handed to the server and in the book's settings, and it
 * carries the fix: a button that asks for a personal access token for the book in place (checked with GitHub, saved for the book, given to the server that runs it).
 * Nothing is shown for a book whose token is a personal access token, which is what the warning goes away with. `onSaved` tells the page what was saved.
 */
export function GitHubServerTokenNotice({ book, onSaved }: { book: BookEntry; onSaved?: (saved: SavedBookToken) => void }) {
  const { t } = useTranslation();
  const settings = useSettingsStore((state) => state.settings);
  const token = usePersonalTokenDialog(book, onSaved);
  const uses = bookUsesAppToken(book, settings);
  // The dialog stays until it is closed, also when the token it saved makes the warning go.
  if (!uses && !token.isOpen) return null;
  return (
    <>
      {uses && (
        <div role="note" className="space-y-2 rounded-md border border-amber-600/40 bg-amber-50/60 p-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200" data-testid="github-server-token-notice">
          <p className="flex items-start gap-2">
            <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <span><span className="font-medium">{t("accountSync.github.server.warning")}</span> {t("accountSync.github.server.warningLong")}</span>
          </p>
          <UsePersonalTokenButton book={book} onOpen={token.open} />
        </div>
      )}
      {token.dialog}
    </>
  );
}
