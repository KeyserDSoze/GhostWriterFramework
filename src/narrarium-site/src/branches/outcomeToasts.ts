import { createElement } from "react";
import i18n from "@/i18n";
import { toast } from "@/components/ui/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { outcomeIsVisible } from "@/branches/autoSyncPolicy";
import { useBranchSyncStore } from "@/branches/syncStore";
import { onWatchedBranch, watchedBranch } from "@/branches/watchedBranch";
import { RepositoryError, repositoryErrorDescription, type RepositoryErrorKind } from "@/repository/repositoryError";
import "@/i18n/branches";

/** Said once per state in this tab: a new state of GitHub or a new failure is said again. */
function sayOnce(key: string): boolean {
  try {
    if (sessionStorage.getItem(key)) return false;
    sessionStorage.setItem(key, "1");
  } catch { /* without sessionStorage it is said each time */ }
  return true;
}

/**
 * What only the person can settle about the branch this tab shows (GitHub moved while this device has work, the branch is gone or its name taken, a
 * failure), said once per state; the rest of what the sync does is silent here and shown in the menu of the pill. It loads with the branch sync, the only
 * thing that puts an outcome in the store. Returns what stops it.
 */
export function sayOutcomesOfWatchedBranch(): () => void {
  const check = () => {
    const watched = watchedBranch();
    if (!watched) return;
    const outcome = useBranchSyncStore.getState().books[watched.bookId]?.branches[watched.branch];
    if (!outcome || !outcomeIsVisible(outcome.outcome)) return;
    if (!sayOnce(`narrarium-branch-sync-said:${watched.bookId}:${watched.branch}:${outcome.outcome}:${outcome.remoteHeadSha ?? outcome.errorKind ?? ""}`)) return;
    const branch = watched.branch;
    const t = i18n.t.bind(i18n);
    if (outcome.outcome === "diverged") {
      const label = t("branches.outcome.syncNow");
      toast({ title: t("branches.outcome.divergedTitle", { branch }), description: t("branches.outcome.diverged"), action: createElement(ToastAction, { altText: label, onClick: () => watched.onSyncNow() }, label) });
    } else if (outcome.outcome === "failed") {
      const reason = repositoryErrorDescription(new RepositoryError("", (outcome.errorKind ?? "unknown") as RepositoryErrorKind, "compare"), t);
      toast({ title: t("branches.outcome.failedTitle", { branch }), description: t("branches.outcome.failed", { reason }), variant: "destructive" });
    } else {
      toast({ title: t(`branches.outcome.${outcome.outcome === "gone" ? "goneTitle" : "nameTakenTitle"}`, { branch }), description: t(`branches.outcome.${outcome.outcome === "gone" ? "gone" : "nameTaken"}`, { branch }) });
    }
  };
  check();
  onWatchedBranch(check);
  const stop = useBranchSyncStore.subscribe(check);
  return () => { stop(); onWatchedBranch(null); };
}
