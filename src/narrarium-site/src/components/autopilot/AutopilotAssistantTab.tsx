import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ExternalLink, PanelBottomOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { parseAppRoute } from "@/assistant/context";
import { useAutopilotStore } from "@/autopilot/store";
import { AutopilotFeed } from "@/components/autopilot/AutopilotFeed";

/** The Copilot's "Autopilot" tab: everything the autopilot does, next to the conversation. */
export function AutopilotAssistantTab({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  const location = useLocation();
  const setDockOpen = useAutopilotStore((state) => state.setDockOpen);
  const route = parseAppRoute(location.pathname);
  const bookId = "bookId" in route ? route.bookId : undefined;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline">
          <Link to={bookId ? `/app/books/${encodeURIComponent(bookId)}/autopilot` : "/app/autopilot"} onClick={onNavigate}><ExternalLink className="h-3.5 w-3.5" />{t("autopilot.openPage")}</Link>
        </Button>
        <Button size="sm" variant="ghost" onClick={() => { setDockOpen(true); onNavigate?.(); }}><PanelBottomOpen className="h-3.5 w-3.5" />{t("autopilot.openDock")}</Button>
      </div>
      <AutopilotFeed showBook limit={150} />
    </div>
  );
}
