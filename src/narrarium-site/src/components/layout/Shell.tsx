import { Outlet, useLocation } from "react-router-dom";
import { Suspense, lazy, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Sidebar, MobileSidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { DossierDock } from "./DossierDock";
import { FloatingActions } from "./FloatingActions";
import { useSettings } from "@/drive/useSettings";
import { useSettingsStore } from "@/store/settingsStore";
import { useTokenRefresh } from "@/hooks/useTokenRefresh";
import { useCostsSync } from "@/costs/useCostsSync";
import { useCostsStore } from "@/costs/costsStore";
import { useClipboardSync } from "@/clipboard/useClipboardSync";
import { parseAppRoute } from "@/assistant/context";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const AssistantPanel = lazy(() =>
  import("@/components/assistant/AssistantPanel").then((module) => ({ default: module.AssistantPanel })),
);

export function Shell() {
  const { load } = useSettings();
  const { t, i18n } = useTranslation();
  const { cloudLoaded, syncStatus, settings } = useSettingsStore();
  const location = useLocation();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useTokenRefresh();
  useCostsSync();
  useClipboardSync();

  useEffect(() => {
    const route = parseAppRoute(location.pathname);
    const bookId = "bookId" in route ? route.bookId : undefined;
    const book = bookId ? settings.books.find((b) => b.id === bookId) : undefined;
    useCostsStore.getState().setCurrentBook(bookId, book?.name);
  }, [location.pathname, settings.books]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (cloudLoaded && settings.ui.language && i18n.resolvedLanguage !== settings.ui.language) {
      void i18n.changeLanguage(settings.ui.language);
    }
  }, [cloudLoaded, i18n, settings.ui.language]);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  if (!cloudLoaded) {
    return (
      <div className="flex h-[100dvh] flex-col items-center justify-center gap-4 bg-background p-6 text-center">
        {syncStatus === "error" ? (
          <>
            <p className="font-semibold">{t("shell.loadError")}</p>
            <p className="max-w-md text-sm text-muted-foreground">{t("shell.loadErrorHint")}</p>
            <Button onClick={() => void load()}>{t("shell.retry")}</Button>
          </>
        ) : (
          <>
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">{t("shell.loadingSettings")}</p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-background">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Topbar onOpenMobileNav={() => setMobileNavOpen(true)} />
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
      <DossierDock />
      <FloatingActions />
      <Suspense fallback={null}>
        <AssistantPanel />
      </Suspense>

      <Dialog open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <DialogContent className="left-0 top-0 h-[100dvh] max-w-none translate-x-0 translate-y-0 rounded-none border-r p-0 data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:left-0 sm:top-0 sm:max-w-sm sm:translate-x-0 sm:translate-y-0 sm:rounded-none">
          <MobileSidebar onNavigate={() => setMobileNavOpen(false)} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
