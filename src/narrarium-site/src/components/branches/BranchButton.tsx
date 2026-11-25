import { GitBranch, RefreshCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { outcomeIsVisible } from "@/branches/autoSyncPolicy";
import { useBranchSyncStore } from "@/branches/syncStore";
import type { AutoSyncMode } from "@/types/settings";
import "@/i18n/branchesShell";

export interface BranchButtonProps {
  bookId: string;
  branch: string;
  /** Made on this device and not on GitHub yet. */
  pending: boolean;
  mode: AutoSyncMode;
  onOpen: () => void;
}

/**
 * The branch of the book on the screen, in the top bar next to the sync pill: its name, and what concerns it (not published yet, automatic sync off, waiting
 * for the person, syncing). It opens the switcher. On a phone only the icon shows; the name is in the button's name all the same. Its accessible name starts
 * with the words it shows, so that it can be spoken as it reads.
 */
export function BranchButton({ bookId, branch, pending, mode, onOpen }: BranchButtonProps) {
  const { t } = useTranslation();
  const running = useBranchSyncStore((state) => state.books[bookId]?.status === "running");
  const outcome = useBranchSyncStore((state) => state.books[bookId]?.branches[branch]?.outcome);
  const attention = Boolean(outcome && outcomeIsVisible(outcome));
  const tags = [pending ? t("branchesShell.trigger.pending") : "", mode === "off" ? t("branchesShell.trigger.off") : "", attention ? t("branchesShell.trigger.attention") : "", running ? t("branchesShell.trigger.syncing") : ""].filter(Boolean);
  const label = t("branchesShell.trigger.label", { branch, state: tags.length ? `, ${tags.join(", ")}` : "" });
  return (
    <button
      type="button"
      data-testid="branch-button"
      aria-haspopup="dialog"
      aria-label={label}
      title={label}
      onClick={onOpen}
      className="inline-flex min-h-7 min-w-0 shrink-0 sm:shrink items-center gap-1 rounded-full border px-2 py-1 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-9"
    >
      <GitBranch className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="hidden max-w-[11rem] truncate sm:inline">{branch}</span>
      {pending && <span className="hidden shrink-0 rounded bg-sky-500/15 px-1 font-medium text-sky-800 dark:text-sky-200 md:inline">{t("branchesShell.trigger.pending")}</span>}
      {mode === "off" && <span className="hidden shrink-0 rounded bg-muted px-1 font-medium text-muted-foreground md:inline">{t("branchesShell.trigger.off")}</span>}
      {attention && <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />}
      {running && <RefreshCcw className="h-3 w-3 shrink-0 motion-safe:animate-spin" aria-hidden="true" />}
    </button>
  );
}
