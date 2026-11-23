import "@/i18n/githubConflicts";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { GitMerge } from "lucide-react";
import { serverSupportsGithubConflicts } from "narrarium-engine";
import { Button } from "@/components/ui/button";
import { useConflictsWindow } from "@/autopilot/githubConflictsWindow";
import { useServerConnection } from "@/autopilot/serverConnection";
import { cn } from "@/lib/utils";

/**
 * The way to settle the conflicts of a book on the personal server with GitHub, wherever the page says they are (the error panel, «Where it runs»): a button that asks the page for the
 * window that does it (`GithubConflictsWindow`, which the page shows once, so that the window outlives this button). A server that is known not to have the feature (it announced its features and this is not one) cannot do it: the author is told to update it, with the way to the
 * server's settings, and nothing is asked of it. A server whose features are not known yet (it is connecting, or cannot be reached) gets the button: the window finds out.
 */
export function GithubConflictsAction({ bookId, variant = "default", className }: { bookId: string; variant?: "default" | "outline"; className?: string }) {
  const { t } = useTranslation();
  const info = useServerConnection().info;
  const open = useConflictsWindow((state) => state.open);

  if (info && !serverSupportsGithubConflicts(info)) {
    return (
      <div data-github-conflicts-old-server className={cn("space-y-1.5 text-sm", className)}>
        <p>{t("githubConflicts.oldServer.text")}</p>
        <Button asChild size="sm" variant="outline" className="min-h-11 whitespace-normal">
          <Link to="/app/settings/server">{t("githubConflicts.oldServer.link")}</Link>
        </Button>
      </div>
    );
  }
  return (
    <Button size="sm" variant={variant} className="min-h-11 whitespace-normal" aria-haspopup="dialog" onClick={(event) => open(bookId, event.currentTarget)}>
      <GitMerge className="h-4 w-4" aria-hidden="true" />
      {t("githubConflicts.resolve")}
    </Button>
  );
}
