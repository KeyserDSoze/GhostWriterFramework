import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { localRuns, subscribeLocalRuns } from "@/autopilot/localRuns";
import { ServerAiNote } from "@/components/autopilot/ServerAiNote";
import type { AppSettings } from "@/types/settings";

/**
 * What a change of the router does to the autopilots that run now, said where it is made. A run of this tab asks its models with the routing of the tab, as the author sees it: a change applies to its next call,
 * saved or not; saved, it also reaches a run of another tab of this browser and the run that resumes after a reload. A book whose autopilot runs on the personal server asks with the configuration sent to the server:
 * its note says what the server holds and sends the current one on request.
 */
export function RouterRunNote({ settings }: { settings: AppSettings }) {
  const { t } = useTranslation();
  const runs = useSyncExternalStore(subscribeLocalRuns, localRuns, localRuns);
  const onServer = settings.books.some((book) => book.autopilotHost === "server");
  if (runs.length === 0 && !onServer) return null;
  return (
    <div className="space-y-2">
      {runs.length > 0 && <p data-router-run-note role="note" className="rounded-md border border-dashed p-3 text-xs">{t("routing.runNote")}</p>}
      {onServer && <ServerAiNote />}
    </div>
  );
}
