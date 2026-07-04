import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, Share, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "narrarium-install-dismissed";

function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches
    || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

function isIos(): boolean {
  const ua = window.navigator.userAgent;
  const iOSDevice = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  return iOSDevice && isSafari;
}

export function InstallPrompt() {
  const { t } = useTranslation();
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [iosHint, setIosHint] = useState(false);

  useEffect(() => {
    if (isStandalone()) return;
    try { if (localStorage.getItem(DISMISS_KEY) === "1") return; } catch { /* ignore */ }

    // Android / Chromium: capture the deferred prompt.
    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setDeferred(null);
      setIosHint(false);
      try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* ignore */ }
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);

    // iOS Safari has no beforeinstallprompt → show a short "Add to Home Screen" hint.
    if (isIos()) setIosHint(true);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  function dismiss() {
    setDeferred(null);
    setIosHint(false);
    try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* ignore */ }
  }

  async function install() {
    if (!deferred) return;
    try {
      await deferred.prompt();
      await deferred.userChoice;
    } catch { /* ignore */ }
    dismiss();
  }

  if (!deferred && !iosHint) return null;

  return (
    <div className="fixed bottom-20 left-1/2 z-[75] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 rounded-2xl border bg-card p-4 text-card-foreground shadow-2xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{t("pwa.installTitle")}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {deferred ? t("pwa.installDescription") : t("pwa.iosInstallHint")}
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={dismiss} aria-label={t("pwa.installDismiss")}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      {deferred ? (
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={dismiss}>{t("pwa.installDismiss")}</Button>
          <Button onClick={() => void install()}>
            <Download className="mr-2 h-4 w-4" />
            {t("pwa.installNow")}
          </Button>
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Share className="h-4 w-4 shrink-0" />
          <span>{t("pwa.iosInstallSteps")}</span>
        </div>
      )}
    </div>
  );
}
