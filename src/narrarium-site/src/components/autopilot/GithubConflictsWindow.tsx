import { useEffect, useMemo } from "react";
import { useBackGestureClose } from "@/components/layout/historyStep";
import { GithubConflictsDialog } from "@/components/autopilot/GithubConflictsDialog";
import { useConflictsWindow } from "@/autopilot/githubConflictsWindow";

/**
 * The window of the conflicts with GitHub of a book, shown once by the page of its autopilot when a control asks for it (`GithubConflictsAction`). It belongs to the page and not to the
 * control, which goes away when the conflicts are resolved; it closes when the page is left.
 */
export function GithubConflictsWindow({ bookId }: { bookId: string }) {
  const open = useConflictsWindow((state) => state.bookId === bookId);
  const opener = useConflictsWindow((state) => state.opener);
  const close = useConflictsWindow((state) => state.close);
  const returnFocusTo = useMemo(() => ({ current: opener }), [opener]);
  // On a phone the window covers the screen: the back gesture closes it instead of leaving the page.
  useBackGestureClose(open, close, "github-conflicts");
  useEffect(() => () => {
    if (useConflictsWindow.getState().bookId === bookId) useConflictsWindow.getState().close();
  }, [bookId]);
  return <GithubConflictsDialog bookId={bookId} open={open} onOpenChange={(next) => { if (!next) close(); }} returnFocusTo={returnFocusTo} />;
}
