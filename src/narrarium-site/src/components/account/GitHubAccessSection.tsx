import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ExternalLink, KeyRound, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import "@/i18n/githubApp";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { credentialMode } from "@/account/credentialMode";
import type { LocalGitHubConnection } from "@/account/types";
import { GITHUB_APP_CLIENT_ID, GITHUB_APP_SLUG } from "@/config/publicClients";
import { bookCredentialLines, githubSignInAvailable, type BookCredentialLine } from "@/github/githubAccessModel";
import { installAppUrl, type AppInstallation } from "@/github/githubAppInstall";
import { useAppInstallations } from "@/github/useAppInstallations";
import { useBrokerAvailability } from "@/hooks/useBrokerAvailability";
import { useSettings } from "@/drive/useSettings";
import { useSettingsStore } from "@/store/settingsStore";

const LINK = "inline-flex min-h-6 items-center gap-1 font-medium text-foreground underline underline-offset-2";

function ExternalAnchor({ href, children }: { href: string; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <a className={LINK} href={href} target="_blank" rel="noopener noreferrer">
      {children}<ExternalLink aria-hidden="true" className="h-3.5 w-3.5" /><span className="sr-only"> {t("accountSync.github.install.opensNewTab")}</span>
    </a>
  );
}

export interface GitHubAccessSectionProps {
  connection: LocalGitHubConnection | undefined;
  /** The sign-in is for the device (remembered) or for this tab: the page keeps the switch. */
  rememberMe: boolean;
  onRememberChange: (value: boolean) => void;
  onConnect: () => void;
  starting: boolean;
  startError: string | null;
  pat: string;
  onPatChange: (value: string) => void;
  onConnectPat: () => void;
  busy: boolean;
}

/**
 * The inside of the GitHub card of Account & Sync: «Connect with GitHub» (recommended, when this site has it) and «Use a personal access token
 * (advanced)», where the GitHub app is installed (and which books it cannot reach yet), which token each book uses, and the one preference that moves the
 * connection ahead of the default token. The page keeps the card's own parts (state, sync switch, Disconnect, Reconnect).
 */
export function GitHubAccessSection(props: GitHubAccessSectionProps) {
  const { t } = useTranslation();
  const { save } = useSettings();
  const settings = useSettingsStore((state) => state.settings);
  const broker = useBrokerAvailability("github");
  const available = githubSignInAvailable(broker, GITHUB_APP_CLIENT_ID);
  const { connection } = props;
  const app = connection?.credentialKind === "app";
  const installs = useAppInstallations(connection?.token, app && Boolean(connection?.token));
  const rememberId = useId();
  const patId = "github-pat";
  const installed = installs.status === "ready" || installs.status === "error" || installs.status === "loading" ? installs.installations : null;
  const lines = bookCredentialLines(settings.books, settings, installed, connection?.identity?.username);
  const needsReconnect = Boolean(connection && app && (connection.replica.status === "needs-auth" || (!connection.refreshToken && (connection.accessTokenExpiry ?? 0) < Date.now())));

  const setPrefer = (value: boolean) => {
    useSettingsStore.getState().patchSettings({ githubPreferConnection: value ? true : undefined });
    void save().catch(() => undefined);
  };

  const connectBlock = (
    <div className="space-y-2">
      {available === true && (
        <>
          {!(app && needsReconnect) && (
            <>
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium"><span>{t("accountSync.github.connect")}</span><span className="rounded-full border px-2 py-0.5 text-xs font-medium text-muted-foreground">{t("accountSync.github.recommended")}</span></p>
              <p className="text-xs text-muted-foreground">{t("accountSync.github.connectHelp")}</p>
            </>
          )}
          <div className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm">
            <div className="min-w-0"><Label htmlFor={rememberId}>{t("accountSync.github.remember")}</Label><p className="text-xs text-muted-foreground">{t("accountSync.github.rememberHelp")}</p></div>
            <Switch id={rememberId} checked={props.rememberMe} onCheckedChange={props.onRememberChange} />
          </div>
          <Button size="sm" onClick={props.onConnect} disabled={props.starting || props.busy}>
            {props.starting ? <Loader2 aria-hidden="true" className="mr-1 h-4 w-4 animate-spin motion-reduce:animate-none" /> : <ShieldCheck aria-hidden="true" className="mr-1 h-4 w-4" />}
            {props.starting ? t("accountSync.github.starting") : needsReconnect ? t("accountSync.github.reconnect") : t("accountSync.github.connect")}
          </Button>
        </>
      )}
      {available === null && <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />{t("accountSync.github.checking")}</p>}
      {available === false && <p className="text-xs text-amber-800 dark:text-amber-300">{t("accountSync.github.notEnabled")}</p>}
      <div role="status" className="min-h-0 text-xs text-destructive">{props.startError}</div>
    </div>
  );

  const patBlock = (
    <details className="rounded-md border p-2" open={!connection || connection.credentialKind === "pat" ? available === false : false}>
      <summary className="flex min-h-6 cursor-pointer items-center gap-2 text-sm font-medium"><KeyRound aria-hidden="true" className="h-4 w-4" />{t("accountSync.github.pat.summary")}</summary>
      <div className="mt-2 space-y-2">
        <p className="text-xs text-muted-foreground">{t("accountSync.github.pat.help")}</p>
        <Label htmlFor={patId}>{t("accountSync.github.pat.label")}</Label>
        <div className="flex gap-2">
          <Input id={patId} type="password" autoComplete="off" value={props.pat} onChange={(event) => props.onPatChange(event.target.value)} placeholder={t("accountSync.github.pat.placeholder")} />
          <Button variant="outline" onClick={props.onConnectPat} disabled={!props.pat.trim() || props.busy}>{t("accountSync.github.pat.button")}</Button>
        </div>
      </div>
    </details>
  );

  return (
    <div className="space-y-3 border-t pt-3" data-testid="github-access">
      {connection && app && (
        <div className="space-y-1 text-xs">
          <p className="text-sm font-medium">{t("accountSync.github.app.connected", { user: connection.identity?.username ?? "GitHub" })}</p>
          {!needsReconnect && <p className="text-muted-foreground">{credentialMode({ refreshToken: connection.refreshToken, rememberMe: connection.rememberMe }) === "long-lived" ? t("accountSync.github.app.longLived") : t("accountSync.github.app.memoryOnly")}</p>}
          {needsReconnect && <p className="flex items-start gap-2 font-medium text-amber-800 dark:text-amber-300"><AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{t("accountSync.github.app.needsReconnect")}</p>}
          <p className="text-muted-foreground">{t("accountSync.github.app.revokeNote")}</p>
        </div>
      )}
      {connection && !app && (
        <div className="space-y-1 text-xs">
          <p className="text-sm font-medium">{t("accountSync.github.pat.connected", { user: connection.identity?.username ?? "GitHub" })}</p>
          {available === true && <p className="text-muted-foreground">{t("accountSync.github.pat.upgrade")}</p>}
        </div>
      )}

      {(!connection || !app || needsReconnect) && connectBlock}
      {app && <InstallBlock installs={installs} installations={installed} />}
      {!app || needsReconnect ? patBlock : null}

      {connection && lines.length > 0 && (
        <section aria-labelledby={`${rememberId}-books`} className="space-y-2">
          <h3 id={`${rememberId}-books`} className="text-sm font-medium">{t("accountSync.github.books.title")}</h3>
          <ul className="space-y-1 text-xs" aria-label={t("accountSync.github.books.sectionLabel")}>
            {lines.map((line) => <BookLine key={line.bookId} line={line} />)}
          </ul>
          <div className="flex items-start justify-between gap-3 rounded-md border p-2">
            <div className="min-w-0"><Label htmlFor={`${rememberId}-prefer`}>{t("accountSync.github.prefer.label")}</Label><p className="text-xs text-muted-foreground">{t("accountSync.github.prefer.help")}</p><p className="mt-1 text-xs text-muted-foreground">{t("accountSync.github.prefer.order")}</p></div>
            <Switch id={`${rememberId}-prefer`} checked={Boolean(settings.githubPreferConnection)} onCheckedChange={setPrefer} />
          </div>
        </section>
      )}
    </div>
  );
}

function BookLine({ line }: { line: BookCredentialLine }) {
  const { t } = useTranslation();
  const uses = t(`accountSync.github.books.uses.${line.source ?? "none"}`);
  return (
    <li className="space-y-0.5">
      <p>{t("accountSync.github.books.line", { book: line.name, uses })}</p>
      {line.reach && <ReachNote line={line} />}
      {line.serverWithAppToken && <p className="flex items-start gap-2 text-amber-800 dark:text-amber-300"><AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />{t("accountSync.github.server.warning")}</p>}
    </li>
  );
}

function ReachNote({ line }: { line: BookCredentialLine }) {
  const { t } = useTranslation();
  const link = GITHUB_APP_SLUG ? <ExternalAnchor href={installAppUrl()}>{t("accountSync.github.install.choose")}</ExternalAnchor> : null;
  if (line.reach === "all" || line.reach === "selected") return <p className="text-muted-foreground">{t("accountSync.github.books.reachable", { repo: `${line.owner}/${line.repo}` })}</p>;
  if (line.reach === "suspended") return <p className="text-amber-800 dark:text-amber-300">{t("accountSync.github.install.suspended", { account: line.owner })}</p>;
  if (line.reach === "outside-selection") return <p className="flex flex-wrap items-center gap-x-2 text-amber-800 dark:text-amber-300"><span>{t("accountSync.github.books.outside", { repo: `${line.owner}/${line.repo}` })}</span>{link}</p>;
  return <p className="flex flex-wrap items-center gap-x-2 text-amber-800 dark:text-amber-300"><span>{t("accountSync.github.books.notInstalled", { owner: line.owner, repo: `${line.owner}/${line.repo}`, who: line.ownAccount ? t("accountSync.github.books.whoUser") : t("accountSync.github.books.whoOrganization", { owner: line.owner }) })}</span>{link}</p>;
}

function InstallBlock({ installs, installations }: { installs: ReturnType<typeof useAppInstallations>; installations: AppInstallation[] | null }) {
  const { t } = useTranslation();
  const slug = GITHUB_APP_SLUG;
  const loading = installs.status === "loading";
  const none = installs.status === "ready" && installs.installations.length === 0;
  const errorKey = installs.status === "error" ? ({ reconnect: "reconnect", sso: "sso", "rate-limit": "rateLimit", network: "network", unknown: "unknown" } as const)[installs.reason] : null;
  const firstManage = installations?.find((entry) => !entry.suspended) ?? installations?.[0];
  return (
    <section aria-labelledby="github-install-title" className="space-y-2 rounded-md border p-2">
      <h3 id="github-install-title" className="text-sm font-medium">{t("accountSync.github.install.title")}</h3>
      <p className="text-xs text-muted-foreground">{t("accountSync.github.install.intro")}</p>
      <div role="status" aria-live="polite" className="space-y-1 text-xs">
        {loading && !installations && <p className="flex items-center gap-2 text-muted-foreground"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />{t("accountSync.github.install.loading")}</p>}
        {none && <p className="text-amber-800 dark:text-amber-300">{t("accountSync.github.install.none")}</p>}
        {errorKey && <p className="flex items-start gap-2 font-medium text-amber-800 dark:text-amber-300"><AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{t(`accountSync.github.install.error.${errorKey}`, { status: installs.status === "error" ? installs.httpStatus : undefined })}</p>}
      </div>
      {installations && installations.length > 0 && (
        <ul className="space-y-1 text-xs">
          {installations.map((installation) => (
            <li key={installation.id} className="space-y-0.5">
              <p>{installation.suspended ? t("accountSync.github.install.suspended", { account: installation.account }) : installation.selection === "all" ? t("accountSync.github.install.all", { account: installation.account }) : installation.repositories.length === 0 ? t("accountSync.github.install.selectedNone", { account: installation.account }) : t("accountSync.github.install.selected", { count: installation.repositories.length, account: installation.account })}</p>
              {installation.selection === "selected" && installation.repositories.length > 0 && (
                <ul aria-label={t("accountSync.github.install.repositories", { account: installation.account })} className="ml-4 list-disc break-all text-muted-foreground">{installation.repositories.map((name) => <li key={name}>{name}</li>)}</ul>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">{t("accountSync.github.install.organization")}</p>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        {slug && <ExternalAnchor href={firstManage ? firstManage.settingsUrl : installAppUrl(slug)}>{firstManage ? t("accountSync.github.install.manage") : t("accountSync.github.install.choose")}</ExternalAnchor>}
        <Button size="sm" variant="outline" onClick={installs.reload} disabled={loading}>
          <RefreshCw aria-hidden="true" className={`mr-1 h-4 w-4 ${loading ? "animate-spin motion-reduce:animate-none" : ""}`} />{loading ? t("accountSync.github.install.refreshing") : t("accountSync.github.install.refresh")}
        </Button>
      </div>
    </section>
  );
}
