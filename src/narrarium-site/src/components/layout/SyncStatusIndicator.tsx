import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Check, Cloud, CloudAlert, CloudOff, CloudUpload, KeyRound, Loader2, RefreshCw, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { LocalTime } from "@/components/ui/local-time";
import { syncOneAccountReplica, useAccountSyncStore } from "@/account/accountSync";
import { useConnectionStore } from "@/account/connectionStore";
import { isFailureStatus, needsAttention, summarizeSyncStatus, type SyncBackendStatus, type SyncIndicatorState, type SyncIndicatorSummary } from "@/account/syncStatus";
import type { AccountSyncBackendKind, LocalReplicaState } from "@/account/types";
import { formatLocalDateTime, formatLocalTime, isLocalToday } from "@/lib/formatDateTime";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/store/uiStore";

const STATE_ICON: Record<SyncIndicatorState, typeof Cloud> = {
  synced: Cloud,
  syncing: Loader2,
  pending: CloudUpload,
  "needs-login": KeyRound,
  failed: CloudAlert,
  "remote-offline": CloudOff,
  "device-offline": WifiOff,
};

const STATUS_ICON: Partial<Record<LocalReplicaState["status"], typeof Cloud>> = {
  idle: Check,
  syncing: Loader2,
  dirty: CloudUpload,
  ahead: CloudUpload,
  behind: CloudUpload,
  diverged: CloudAlert,
  "needs-auth": KeyRound,
  offline: CloudOff,
  error: CloudAlert,
};

const AMBER_TEXT = "text-amber-800 dark:text-amber-300";
const AMBER_BUTTON = `border border-amber-500/50 bg-amber-500/10 hover:bg-amber-500/20 hover:text-amber-800 dark:hover:text-amber-300 ${AMBER_TEXT}`;

function subscribeToConnectivity(notify: () => void): () => void {
  window.addEventListener("online", notify);
  window.addEventListener("offline", notify);
  return () => {
    window.removeEventListener("online", notify);
    window.removeEventListener("offline", notify);
  };
}

const isBrowserOffline = () => navigator.onLine === false;

function describeState(summary: SyncIndicatorSummary, t: TFunction, language: string): string {
  if (summary.state !== "synced") return t(`syncStatus.tooltip.${summary.state}`, { backend: summary.focus?.name ?? "" });
  const syncedAt = summary.lastSyncAtUtc;
  if (!syncedAt) return t("syncStatus.tooltip.syncedUnknown");
  return isLocalToday(syncedAt)
    ? t("syncStatus.tooltip.synced", { time: formatLocalTime(syncedAt, language) })
    : t("syncStatus.tooltip.syncedOn", { time: formatLocalDateTime(syncedAt, language) });
}

/** Text for a screen-reader live region: only the way into an attention state and the way back to synced. */
function useAnnouncement(summary: SyncIndicatorSummary, t: TFunction): string {
  const { state, visible } = summary;
  const backend = summary.focus?.name ?? "";
  const [message, setMessage] = useState("");
  const previous = useRef(state);
  const unresolved = useRef(visible && needsAttention(state));

  useEffect(() => {
    if (!visible) {
      previous.current = state;
      unresolved.current = false;
      setMessage("");
      return;
    }
    if (previous.current === state) return;
    previous.current = state;
    if (needsAttention(state)) {
      unresolved.current = true;
      setMessage(t(`syncStatus.announce.${state}`, { backend }));
    } else if (state === "synced" && unresolved.current) {
      unresolved.current = false;
      setMessage(t("syncStatus.announce.synced"));
    } else {
      setMessage("");
    }
  }, [state, visible, backend, t]);

  return message;
}

export function SyncStatusIndicator() {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const configuration = useConnectionStore((store) => store.configuration);
  const syncing = useAccountSyncStore((store) => store.syncing);
  const reportedOffline = useUiStore((store) => store.authActivity) === "offline";
  const browserOffline = useSyncExternalStore(subscribeToConnectivity, isBrowserOffline, () => false);
  const summary = useMemo(() => summarizeSyncStatus({ configuration, syncing, deviceOffline: browserOffline || reportedOffline }), [configuration, syncing, browserOffline, reportedOffline]);
  const [syncingBackend, setSyncingBackend] = useState<AccountSyncBackendKind | null>(null);
  const announcement = useAnnouncement(summary, t);
  const summaryId = useId();

  async function syncBackend(kind: AccountSyncBackendKind) {
    setSyncingBackend(kind);
    try { await syncOneAccountReplica(kind); }
    catch { /* The failure is recorded on the service and shown here and on the Account & Sync page. */ }
    finally { setSyncingBackend(null); }
  }

  const { state } = summary;
  const StateIcon = STATE_ICON[state];
  const stateLabel = t(`syncStatus.state.${state}`);
  const summaryText = describeState(summary, t, language);

  return (
    <>
      <span role="status" className="sr-only">{announcement}</span>
      {summary.visible && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              data-sync-state={state}
              aria-label={t("syncStatus.button", { state: stateLabel })}
              title={summaryText}
              className={cn("h-9 gap-1.5 px-2 text-xs", needsAttention(state) ? AMBER_BUTTON : "text-muted-foreground hover:text-foreground")}
            >
              <StateIcon aria-hidden="true" className={cn("h-4 w-4", state === "syncing" && "motion-safe:animate-spin")} />
              {needsAttention(state) && <span className="hidden md:inline">{stateLabel}</span>}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-1rem)]" aria-describedby={summaryId}>
            <DropdownMenuLabel>{t("syncStatus.popover.title")}</DropdownMenuLabel>
            <p id={summaryId} className="px-2 pb-2 text-xs text-muted-foreground">{summaryText}</p>
            {summary.backends.length === 0 && <p className="border-t px-2 py-2 text-xs text-muted-foreground">{t("syncStatus.popover.noServices")}</p>}
            {summary.backends.map((entry) => (
              <BackendSection
                key={entry.backend}
                entry={entry}
                disabled={syncing || state === "device-offline"}
                busy={syncingBackend === entry.backend || entry.replica.status === "syncing"}
                onSync={() => void syncBackend(entry.backend)}
              />
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild className="cursor-pointer gap-2">
              <Link to="/app/account-sync"><Cloud className="h-4 w-4" aria-hidden="true" />{t("accountSync.title")}</Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );
}

function BackendSection({ entry, disabled, busy, onSync }: { entry: SyncBackendStatus; disabled: boolean; busy: boolean; onSync: () => void }) {
  const { t } = useTranslation();
  const { replica } = entry;
  const StatusIcon = STATUS_ICON[replica.status] ?? Cloud;
  const failed = Boolean(replica.errorKind) && isFailureStatus(replica.status);
  const syncLabel = busy ? t("syncStatus.popover.syncingNow") : t("syncStatus.popover.syncNow");
  return (
    <DropdownMenuGroup aria-label={entry.name} className="border-t px-1 py-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="text-sm font-medium">{entry.name}</span>
        <span className={cn("inline-flex items-center gap-1 text-xs", isFailureStatus(replica.status) ? `font-medium ${AMBER_TEXT}` : "text-muted-foreground")}>
          <StatusIcon aria-hidden="true" className={cn("h-3.5 w-3.5", replica.status === "syncing" && "motion-safe:animate-spin")} />
          {t(`accountSync.state.${replica.status}`, { defaultValue: replica.status, service: entry.name })}
        </span>
      </div>
      <p className="px-1 pt-1 text-xs text-muted-foreground">
        {replica.lastSuccessfulSyncAtUtc ? <>{t("syncStatus.popover.lastSync")}: <LocalTime value={replica.lastSuccessfulSyncAtUtc} /></> : t("syncStatus.popover.notSyncedYet")}
      </p>
      {failed && (
        <div className="px-1 pt-1 text-xs">
          <p><span className="font-medium">{t("syncStatus.popover.lastError")}:</span> {t(`accountSync.error.${replica.errorKind}`, { defaultValue: replica.errorKind, service: entry.name })}</p>
          {replica.lastErrorMessage && <p className="mt-1 break-words font-mono text-xs text-muted-foreground">{replica.lastErrorMessage}</p>}
        </div>
      )}
      <div className="mt-1">
        {replica.status === "needs-auth" && (
          <DropdownMenuItem asChild className="cursor-pointer gap-2 text-xs">
            <Link to="/app/account-sync">
              <KeyRound aria-hidden="true" className="h-3.5 w-3.5" />
              {t("accountSync.card.reconnectService", { service: entry.name })}
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          className="cursor-pointer gap-2 text-xs"
          disabled={disabled || busy}
          aria-label={`${syncLabel}: ${entry.name}`}
          onSelect={(event) => { event.preventDefault(); onSync(); }}
        >
          <RefreshCw aria-hidden="true" className={cn("h-3.5 w-3.5", busy && "motion-safe:animate-spin")} />
          {syncLabel}
        </DropdownMenuItem>
      </div>
    </DropdownMenuGroup>
  );
}
