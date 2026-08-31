import { useTranslation } from "react-i18next";
import { CloudOff, Loader2, Save, WifiOff } from "lucide-react";
import { useUiStore } from "@/store/uiStore";
import { useConnectionStore } from "@/account/connectionStore";
import { useAccountSyncStore } from "@/account/accountSync";

export function SessionStatusPill() {
  const { t } = useTranslation();
  const activity = useUiStore((s) => s.authActivity);
  const configuration = useConnectionStore((state) => state.configuration);
  const syncing = useAccountSyncStore((state) => state.syncing);
  const replicas = [configuration.google, configuration.microsoft, configuration.github].filter((connection) => connection?.replica.enabled);
  const needsAuth = replicas.find((connection) => connection?.replica.status === "needs-auth");
  const pending = replicas.some((connection) => ["dirty", "error", "offline", "ahead", "behind", "diverged"].includes(connection?.replica.status ?? ""));

  const offline = activity === "offline";
  const label = syncing
    ? "Saved locally · Syncing"
    : needsAuth
      ? `Saved locally · ${needsAuth.backend} needs login`
      : pending
        ? "Saved locally · Sync pending"
        : replicas.length
          ? `Saved locally · ${replicas.length} remote${replicas.length === 1 ? "" : "s"} synced`
          : "Saved locally";
  return (
    <div className="pointer-events-none fixed left-1/2 top-16 z-[70] -translate-x-1/2">
      <div
        className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium shadow-lg backdrop-blur ${
          offline
            ? "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300"
            : "border-primary/30 bg-card/95 text-foreground"
        }`}
      >
        {offline ? <WifiOff className="h-3.5 w-3.5" /> : syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> : needsAuth ? <CloudOff className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
        <span>{offline ? `${t("session.offline")} · ${label}` : activity === "refreshing" ? t("session.refreshing") : label}</span>
      </div>
    </div>
  );
}
