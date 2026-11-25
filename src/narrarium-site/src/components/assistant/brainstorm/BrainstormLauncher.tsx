import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n/brainstorm";
import { useAssistantStore, type BrainstormingTarget } from "@/assistant/store";
import { BrainstormMark } from "@/components/assistant/brainstorm/BrainstormMark";
import { Button } from "@/components/ui/button";

/** Brainstorming's button in the launcher of the shell: the Copilot's pill, in the accent of the mode. */
function BrainstormLauncherButton({ target }: { target: BrainstormingTarget }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      data-brainstorm-launcher=""
      className="brainstorm-accent flex shrink-0 items-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-lg transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      title={t("brainstorm.openHint")}
      onClick={() => useAssistantStore.getState().startBrainstorming(target)}
    >
      <BrainstormMark className="h-4 w-4" />{t("brainstorm.open")}
    </button>
  );
}

/** Brainstorming's button on the Synopsis page, beside the page's own actions. */
export function BrainstormPageButton({ target }: { target: BrainstormingTarget | null }) {
  const { t } = useTranslation();
  return (
    <Button
      type="button"
      data-brainstorm-open=""
      className="brainstorm-accent"
      disabled={!target}
      title={t("brainstorm.openHint")}
      onClick={() => { if (target) useAssistantStore.getState().startBrainstorming(target); }}
    >
      <BrainstormMark className="h-4 w-4" />{t("brainstorm.open")}
    </Button>
  );
}

/**
 * While the Synopsis page of a book is open, the launcher of the shell has Brainstorming's button too, once the book can be brainstormed (`target`);
 * leaving the page (`pageBookId` is the book of the page) takes it away and ends Brainstorming, so the Copilot is the Copilot again everywhere else.
 * The book read again after a change, which makes `target` absent for a moment, ends nothing.
 */
export function useBrainstormLauncher(pageBookId: string, target: BrainstormingTarget | null): void {
  const bookId = target?.bookId ?? "";
  const title = target?.title ?? "";
  useEffect(() => {
    if (!bookId) return;
    const current = { bookId, title };
    useAssistantStore.getState().setPageLauncher(() => <BrainstormLauncherButton target={current} />);
    return () => useAssistantStore.getState().setPageLauncher(null);
  }, [bookId, title]);
  useEffect(() => {
    if (!pageBookId) return;
    return () => {
      const state = useAssistantStore.getState();
      if (state.brainstorming?.bookId === pageBookId) state.stopBrainstorming();
    };
  }, [pageBookId]);
}
