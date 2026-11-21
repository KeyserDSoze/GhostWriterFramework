import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useBookAutopilotView } from "@/autopilot/hooks";
import { cn } from "@/lib/utils";

/**
 * What holds the book right now (a move, a sync, a start…), in words and announced politely: the page and the dock show the
 * same line, and whatever conflicts with it is disabled. The live region is always there, so a screen reader hears it appear.
 */
export function OperationNotice({ bookId, className }: { bookId: string; className?: string }) {
  const { t } = useTranslation();
  const operation = useBookAutopilotView(bookId).operation;
  return (
    <div role="status" aria-live="polite" className={cn("empty:hidden", className)}>
      {operation && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
          <span>{t(`autopilot.operation.${operation.kind}`)}</span>
        </p>
      )}
    </div>
  );
}
