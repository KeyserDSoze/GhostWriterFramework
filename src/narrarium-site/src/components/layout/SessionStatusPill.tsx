import { useTranslation } from "react-i18next";
import { CloudOff, Loader2, Save, WifiOff } from "lucide-react";
import { useUiStore } from "@/store/uiStore";
import { useConnectionStore } from "@/account/connectionStore";
import { useAccountSyncStore } from "@/account/accountSync";
import type { AccountSyncBackendKind } from "@/account/types";

function backendLabel(backend: AccountSyncBackendKind): string {
  return backend === "google-drive" ? "Google Drive" : backend === "onedrive" ? "OneDrive" : "GitHub";
}

export function SessionStatusPill() {
  const { t } = useTranslation();
  const activity = useUiStore((s) => s.authActivity);
  const configuration = useConnectionStore((state) => state.configuration);
  const syncing = useAccountSyncStore((state) => state.syncing);
  const replicas = [configuration.google, configuration.microsoft, configuration.github].filter((connection) => connection?.replica.enabled);
  const needsAuth = replicas.find((connection) => connection?.replica.status === "needs-auth");
  const failed = replicas.find((connection) => connection?.replica.status === "error");
  const replicaOffline = replicas.find((connection) => connection?.replica.status === "offline");
  const pending = replicas.some((connection) => ["dirty", "ahead", "behind", "diverged"].includes(connection?.replica.status ?? ""));

  const offline = activity === "offline";
  if (!offline && !syncing && !needsAuth && !failed && !replicaOffline && !pending) return null;
  const label = syncing
    ? "Saved locally · Syncing"
    : needsAuth
      ? `Saved locally · ${backendLabel(needsAuth.backend)} needs login`
      : failed
        ? `Saved locally · ${backendLabel(failed.backend)} sync failed`
        : replicaOffline
          ? `Saved locally · ${backendLabel(replicaOffline.backend)} is offline`
          : pending
            ? "Saved locally · Sync pending"
            : replicas.length
              ? `Saved locally · ${replicas.length} remote${replicas.length === 1 ? "" : "s"} synced`
              : "Saved locally";
  const warning = offline || Boolean(needsAuth || failed || replicaOffline);
  return (
    <div className="pointer-events-none fixed left-1/2 top-16 z-[70] -translate-x-1/2">
      <div
        className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium shadow-lg backdrop-blur ${
          warning
            ? "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300"
            : "border-primary/30 bg-card/95 text-foreground"
        }`}
      >
        {offline ? <WifiOff className="h-3.5 w-3.5" /> : syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> : needsAuth || failed || replicaOffline ? <CloudOff className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
        <span>{offline ? `${t("session.offline")} · ${label}` : activity === "refreshing" ? t("session.refreshing") : label}</span>
      </div>
    </div>
  );
}
