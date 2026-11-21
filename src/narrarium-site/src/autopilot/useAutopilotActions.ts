import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/components/ui/use-toast";
import { loadAutopilotRuntime } from "@/autopilot/loader";
import type { AutopilotOperationKind, BookOperation } from "@/autopilot/operations";
import type { AutopilotRuntime } from "@/autopilot/runtime";
import { useAutopilotStore } from "@/autopilot/store";

export type AutopilotActionName = "start" | "pause" | "stop" | "intervene" | "answer" | "configure" | "reset" | "move" | "sync" | "refresh";

/** The action a person sees for an operation that holds the book. */
const ACTION_OF_OPERATION: Record<AutopilotOperationKind, AutopilotActionName> = {
  start: "start",
  answer: "answer",
  configure: "configure",
  reset: "reset",
  intervene: "intervene",
  moveToServer: "move",
  moveToBrowser: "move",
  sync: "sync",
};

/**
 * Run an autopilot action through the lazily loaded runtime, with error toasts. `busy` names what holds the book: an
 * action of this component, or an operation another component (the page, the dock) or another tab started on the
 * same book, so every component disables what conflicts and shows what is going on.
 */
export function useAutopilotActions(bookId: string | undefined) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [busy, setBusy] = useState<AutopilotActionName | null>(null);
  const operation: BookOperation | null = useAutopilotStore((state) => (bookId ? state.views[bookId]?.operation ?? null : null));

  const run = useCallback(async (name: AutopilotActionName, action: (runtime: AutopilotRuntime, bookId: string) => Promise<unknown>, success?: string): Promise<boolean> => {
    if (!bookId) return false;
    setBusy(name);
    try {
      const runtime = await loadAutopilotRuntime();
      await action(runtime, bookId);
      if (success) toast({ title: success });
      return true;
    } catch (error) {
      const runtime = await loadAutopilotRuntime().catch(() => null);
      toast({
        title: t(name === "start" ? "autopilot.errors.start" : "autopilot.errors.action"),
        description: runtime ? runtime.describeError(error) : error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
      return false;
    } finally {
      setBusy(null);
    }
  }, [bookId, t, toast]);

  return { busy: busy ?? (operation ? ACTION_OF_OPERATION[operation.kind] : null), run, operation };
}
