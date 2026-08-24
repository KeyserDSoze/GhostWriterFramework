import { Link, useRouteError } from "react-router-dom";
import { useTranslation } from "react-i18next";

export function RouteErrorFallback() {
  const { t } = useTranslation();
  const error = useRouteError();
  const message = error instanceof Error ? error.message : String(error ?? t("common.loadFailed"));
  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-background p-6" role="alert">
      <div className="max-w-lg rounded-3xl border bg-card p-6 text-center shadow-xl">
        <h1 className="font-serif text-2xl font-semibold">{t("common.loadFailed")}</h1>
        <p className="mt-3 text-sm text-muted-foreground">{message}</p>
        <div className="mt-6 flex justify-center gap-3">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => window.location.reload()}>{t("common.retry")}</button>
          <Link className="rounded-xl bg-primary px-4 py-2 text-sm text-primary-foreground" to="/">{t("public.returnHome")}</Link>
        </div>
      </div>
    </main>
  );
}
