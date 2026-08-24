import { useTranslation } from "react-i18next";

export function RouteLoadingFallback() {
  const { t } = useTranslation();
  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-background p-6" role="status" aria-live="polite" aria-busy="true">
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-primary/30 border-t-primary" aria-hidden="true" />
      <span className="ml-3 text-sm text-muted-foreground">{t("common.loading")}</span>
    </main>
  );
}
