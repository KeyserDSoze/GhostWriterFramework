import { useEffect } from "react";
import { Link, useLocation, useNavigate, useRouteError } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { localRuns } from "@/autopilot/localRuns";
import { isStaleChunkError, noteStaleChunk } from "@/lib/staleBuild";
import { applyUpdateNow } from "@/pwa";
import { useAppUpdateStore } from "@/store/appUpdateStore";
import { cn } from "@/lib/utils";

/**
 * A route that could not be shown. A page of an older version whose files are gone after a deployment says that a new version is available and
 * leaves the reload to the author (the update prompt, which knows the autopilots that run in this tab); any other error is shown as it is, and its
 * «Retry» never reloads the document over an autopilot that runs here (it opens the page again instead). `inShell`: a page of the app, shown in
 * the shell, which stays as it is (the sidebar, the live panel and the runs go on).
 */
export function RouteErrorFallback({ inShell = false }: { inShell?: boolean }) {
  const { t } = useTranslation();
  const error = useRouteError();
  const navigate = useNavigate();
  const location = useLocation();
  const stale = isStaleChunkError(error);
  useEffect(() => { if (stale) noteStaleChunk(error); }, [stale, error]);
  const message = stale ? t("pwa.staleDescription") : error instanceof Error ? error.message : String(error ?? t("common.loadFailed"));
  // With an autopilot that runs in this tab the reload is the author's choice, in the update prompt, which says what it stops.
  const retry = () => {
    const runs = localRuns().length > 0;
    if (stale) {
      if (runs) useAppUpdateStore.getState().openPrompt();
      else void applyUpdateNow(false);
    } else if (runs) navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true });
    else window.location.reload();
  };
  const box = (
    <div className={cn("max-w-lg rounded-3xl border border-layer bg-card p-6 text-center shadow-xl", inShell && "mx-auto mt-6")}>
      <h1 className="font-serif text-2xl font-semibold">{stale ? t("pwa.updateTitle") : t("common.loadFailed")}</h1>
      <p className="mt-3 text-sm text-muted-foreground">{message}</p>
      <div className="mt-6 flex justify-center gap-3">
        <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={retry}>{stale ? t("pwa.reloadNow") : t("common.retry")}</button>
        <Link className="rounded-xl bg-primary px-4 py-2 text-sm text-primary-foreground" to={inShell ? "/app/books" : "/"}>{t("public.returnHome")}</Link>
      </div>
    </div>
  );
  return inShell ? <div role="alert" data-route-error>{box}</div> : (
    <main className="flex min-h-[100dvh] items-center justify-center bg-background p-6" role="alert" data-route-error>
      {box}
    </main>
  );
}
