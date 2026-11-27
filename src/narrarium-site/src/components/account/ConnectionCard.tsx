import { useId } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Trash2, Unplug } from "lucide-react";
import "@/i18n/accountSyncStatus";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { LocalTime } from "@/components/ui/local-time";
import { Switch } from "@/components/ui/switch";
import { isFailureStatus } from "@/account/syncStatus";
import { syncErrorView } from "@/account/syncErrorView";
import { canCheckNow, primarySyncAction, syncCardState } from "@/account/syncCardState";
import { effectiveAutoSync, type AutoSyncMode } from "@/account/autoSync";
import { formatLocalDateTime, formatLocalTime, isLocalToday, isReadableInstant } from "@/lib/formatDateTime";
import type { CredentialMode } from "@/account/credentialMode";

export interface ConnectionCardProps {
  title: string;
  icon: React.ReactNode;
  connected: boolean;
  credentials?: React.ReactNode;
  enabled?: boolean;
  status?: string;
  errorKind?: string;
  errorMessage?: string;
  lastSync?: string;
  detail?: string;
  busy: boolean;
  connectDisabled?: boolean;
  hideConnect?: boolean;
  /** How the connection was made (session or long-lived credentials), and whether the auth proxy serves the service: the sentence of a sign-in that ended says which. */
  credentialMode?: CredentialMode | null;
  brokerAvailable?: boolean | null;
  onUpgrade?: () => void | Promise<void>;
  /** This device has changes that have not reached every service yet. */
  localDirty?: boolean;
  /** How this service relates to the general automatic-sync setting, and what that setting is. */
  autoMode?: AutoSyncMode;
  autoSyncAll?: boolean;
  onFollowGeneral?: () => void | Promise<void>;
  onToggle?: (enabled: boolean) => void | Promise<void>;
  onConnect: () => void | Promise<void>;
  onReconnect?: () => void | Promise<void>;
  onSync: () => void | Promise<void>;
  onDisconnect: () => void | Promise<void>;
  onDelete: () => void | Promise<void>;
  children?: React.ReactNode;
}

/**
 * A service of Account & Sync (Google Drive, OneDrive, GitHub). A sign-in that ended is one sentence and ONE action: «Sign in to Google Drive again on this
 * device», with why it ended and how to make it last; any other failure keeps its own sentence and the details GitHub, Google or Microsoft gave.
 */
export function ConnectionCard(props: ConnectionCardProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const toggleId = useId();
  const state = t(`accountSync.state.${props.status ?? "idle"}`, { defaultValue: props.status ?? "idle", service: props.title });
  const failed = Boolean(props.errorKind && isFailureStatus(props.status));
  const view = syncErrorView({ errorKind: props.errorKind, status: props.status, mode: props.credentialMode ?? null, brokerAvailable: props.brokerAvailable ?? null });
  const signInAgain = props.connected && view.kind === "sign-in-again";
  const reconnect = props.onReconnect ?? props.onConnect;
  const sync = syncCardState({ connected: props.connected, enabled: Boolean(props.enabled), status: props.status, errorKind: props.errorKind, localDirty: Boolean(props.localDirty), lastCheck: props.lastSync });
  const primary = primarySyncAction(sync);
  const mode = props.autoMode ?? (props.enabled ? "on" : "off");
  const general = props.autoSyncAll !== false;
  const stateWord = (on: boolean) => t(on ? "accountSyncStatus.auto.stateOn" : "accountSyncStatus.auto.stateOff");
  const autoNote = mode === "inherit" ? t("accountSyncStatus.auto.inherit", { state: stateWord(general) }) : t("accountSyncStatus.auto.own", { state: stateWord(effectiveAutoSync(mode, general)) });
  const checked = sync.kind === "all-synced" ? sync.lastCheck : undefined;
  const checkedText = checked && isReadableInstant(checked)
    ? (isLocalToday(checked) ? t("accountSyncStatus.sync.allSynced", { time: formatLocalTime(checked, language) }) : t("accountSyncStatus.sync.allSyncedDate", { date: formatLocalDateTime(checked, language) }))
    : null;
  const stateText = sync.kind === "all-synced" ? checkedText
    : sync.kind === "pending" ? t(`accountSyncStatus.sync.pending.${sync.reason}`, { service: props.title })
    : sync.kind === "syncing" ? t("accountSyncStatus.sync.syncing")
    : sync.kind === "off" ? t("accountSyncStatus.sync.off")
    : sync.kind === "offline" ? t("accountSyncStatus.sync.offline")
    : sync.kind === "error" ? t("accountSyncStatus.sync.error")
    : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">{props.icon}{props.title}</CardTitle>
        <CardDescription>{props.detail ?? (props.connected ? t("accountSync.card.status", { state }) : t("accountSync.card.notConnected"))}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {props.connected && stateText && (
          <p role="status" className="flex items-start gap-2 text-sm font-medium" data-testid="sync-state" data-state={sync.kind}>
            {sync.kind === "all-synced" ? <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" /> : sync.kind === "syncing" ? <Loader2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" /> : null}
            {sync.kind === "all-synced" && checked && checkedText ? <time dateTime={checked} title={checked}>{stateText}</time> : <span>{stateText}</span>}
          </p>
        )}
        {props.lastSync && (sync.kind !== "all-synced" || !checkedText) && <p className="text-xs text-muted-foreground">{t("accountSync.card.lastSync")}: <LocalTime value={props.lastSync} /></p>}
        {signInAgain && view.kind === "sign-in-again" && (
          <section aria-labelledby={`${toggleId}-signin`} className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm" data-testid="sign-in-again">
            <h4 id={`${toggleId}-signin`} className="flex items-start gap-2 font-semibold"><AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{t("accountSyncStatus.signIn.title", { service: props.title })}</h4>
            <p>{t(`accountSyncStatus.signIn.why.${view.why}`, { service: props.title })}</p>
            {view.offerLongLived && <p className="text-xs text-muted-foreground">{t("accountSyncStatus.signIn.offerLongLived")}</p>}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" className="h-auto min-h-8 whitespace-normal py-1.5 text-left" onClick={() => void reconnect()} disabled={props.connectDisabled || props.busy}>{t("accountSyncStatus.signIn.action", { service: props.title })}</Button>
              {view.offerLongLived && props.onUpgrade && <Button size="sm" variant="outline" className="h-auto min-h-8 whitespace-normal py-1.5 text-left" onClick={() => void props.onUpgrade?.()} disabled={props.busy}>{t("accountSync.credentials.upgrade")}</Button>}
            </div>
            {props.errorMessage && (
              <details className="text-xs text-muted-foreground">
                <summary className="inline-flex min-h-6 cursor-pointer items-center underline underline-offset-2">{t("accountSyncStatus.technicalDetails")}</summary>
                <p className="mt-1 break-words font-mono">{props.errorMessage}</p>
              </details>
            )}
          </section>
        )}
        {failed && !signInAgain && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs">
            <p className="font-medium">{t("accountSync.card.lastError")}</p>
            <p>{t(`accountSync.error.${props.errorKind}`, { defaultValue: props.errorKind, service: props.title })}</p>
            {props.errorMessage && <p className="mt-1 break-words font-mono text-xs text-muted-foreground">{props.errorMessage}</p>}
          </div>
        )}
        {props.connected && props.credentials}
        {props.connected ? (
          <>
            <div className="space-y-1 rounded-md border p-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor={toggleId}>{t("accountSync.card.dataSync")}</Label>
                <Switch id={toggleId} checked={Boolean(props.enabled)} onCheckedChange={(enabled) => void props.onToggle?.(enabled)} aria-describedby={`${toggleId}-note`} />
              </div>
              <p id={`${toggleId}-note`} className="text-xs text-muted-foreground">{autoNote}</p>
              {mode !== "inherit" && props.onFollowGeneral && <Button size="sm" variant="ghost" className="h-auto min-h-6 px-1 py-0.5 text-xs underline" onClick={() => void props.onFollowGeneral?.()}>{t("accountSyncStatus.auto.followGeneral")}</Button>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {primary && <Button size="sm" onClick={() => void props.onSync()} disabled={props.busy}><RefreshCw className="mr-1 h-4 w-4" />{t(primary === "sync" ? "accountSyncStatus.sync.sync" : "accountSyncStatus.sync.tryAgain")}</Button>}
              {canCheckNow(sync) && !primary && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => void props.onSync()} disabled={props.busy} aria-describedby={`${toggleId}-check`}>{t("accountSyncStatus.sync.checkNow")}</Button>
                  <span id={`${toggleId}-check`} className="text-xs text-muted-foreground">{t("accountSyncStatus.sync.checkNowHint")}</span>
                </>
              )}
              <Button size="sm" variant="outline" onClick={() => void props.onDisconnect()}><Unplug className="mr-1 h-4 w-4" />{t("accountSync.card.disconnect")}</Button>
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => void props.onDelete()}><Trash2 className="mr-1 h-4 w-4" />{t("accountSync.card.deleteRemote")}</Button>
            </div>
          </>
        ) : props.hideConnect ? null : (
          <Button onClick={() => void props.onConnect()} disabled={props.busy || props.connectDisabled}>{props.busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}{t("accountSync.card.connect")}</Button>
        )}
        {props.children}
      </CardContent>
    </Card>
  );
}
