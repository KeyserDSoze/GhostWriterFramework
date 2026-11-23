import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Github } from "lucide-react";
import "@/i18n/githubApp";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { GitHubServerTokenNotice } from "@/components/book/GitHubServerTokenNotice";
import { useConnectionStore } from "@/account/connectionStore";
import { bookCredentialLines } from "@/github/githubAccessModel";
import { GITHUB_APP_SLUG } from "@/config/publicClients";
import { installAppUrl } from "@/github/githubAppInstall";
import { useAppInstallations } from "@/github/useAppInstallations";
import { useSettingsStore } from "@/store/settingsStore";
import { bookStorageMode, type BookEntry } from "@/types/settings";

/** The card of a book's settings that says which GitHub token the book uses (and why), whether the app reaches its repository, and warns about a server-run book on an app token. */
export function BookGitHubAccess({ book }: { book: BookEntry }) {
  const { t } = useTranslation();
  const settings = useSettingsStore((state) => state.settings);
  const connection = useConnectionStore((state) => state.configuration.github);
  const [line] = bookCredentialLines([book], settings, null, connection?.identity?.username);
  const app = line?.source === "app" && connection?.credentialKind === "app";
  const installs = useAppInstallations(connection?.token, Boolean(app && connection?.token));
  if (bookStorageMode(book) !== "github" || !line) return null;
  const [withReach] = bookCredentialLines([book], settings, installs.status === "ready" ? installs.installations : null, connection?.identity?.username);
  const reach = withReach?.reach;
  const problem = reach === "not-installed" || reach === "outside-selection" || reach === "suspended";
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Github aria-hidden="true" className="h-4 w-4" />{t("accountSync.github.book.title")}</CardTitle>
        <CardDescription>{t("accountSync.github.book.uses", { uses: t(`accountSync.github.books.uses.${line.source ?? "none"}`) })}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {app && reach && (reach === "all" || reach === "selected") && <p className="text-muted-foreground" role="status">{t("accountSync.github.books.reachable", { repo: `${book.owner}/${book.repo}` })}</p>}
        {app && problem && (
          <p role="status" className="flex flex-wrap items-center gap-x-2 text-amber-800 dark:text-amber-300">
            <span>{reach === "outside-selection" ? t("accountSync.github.books.outside", { repo: `${book.owner}/${book.repo}` }) : reach === "suspended" ? t("accountSync.github.install.suspended", { account: book.owner }) : t("accountSync.github.books.notInstalled", { owner: book.owner, repo: `${book.owner}/${book.repo}`, who: withReach?.ownAccount ? t("accountSync.github.books.whoUser") : t("accountSync.github.books.whoOrganization", { owner: book.owner }) })}</span>
            {GITHUB_APP_SLUG && <a className="inline-flex min-h-6 items-center font-medium underline underline-offset-2" href={installAppUrl()} target="_blank" rel="noopener noreferrer">{t("accountSync.github.install.choose")}<span className="sr-only"> {t("accountSync.github.install.opensNewTab")}</span></a>}
          </p>
        )}
        <GitHubServerTokenNotice book={book} />
        <p className="text-xs text-muted-foreground">{t("accountSync.github.book.change")} <Link className="font-medium underline underline-offset-2" to="/app/account-sync">{t("accountSync.github.book.link")}</Link></p>
      </CardContent>
    </Card>
  );
}
