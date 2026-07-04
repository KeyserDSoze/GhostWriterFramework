import { useTranslation } from "react-i18next";
import { Loader2, WifiOff } from "lucide-react";
import { useUiStore } from "@/store/uiStore";

export function SessionStatusPill() {
  const { t } = useTranslation();
  const activity = useUiStore((s) => s.authActivity);
  if (activity === "idle") return null;

  const offline = activity === "offline";
  return (
    <div className="pointer-events-none fixed left-1/2 top-16 z-[70] -translate-x-1/2">
      <div
        className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium shadow-lg backdrop-blur ${
          offline
            ? "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300"
            : "border-primary/30 bg-card/95 text-foreground"
        }`}
      >
        {offline ? <WifiOff className="h-3.5 w-3.5" /> : <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
        <span>{offline ? t("session.offline") : t("session.refreshing")}</span>
      </div>
    </div>
  );
}
