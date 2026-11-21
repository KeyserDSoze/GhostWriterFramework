import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/components/ui/use-toast";
import { loadAutopilotRuntime } from "@/autopilot/loader";
import type { AutopilotRuntime } from "@/autopilot/runtime";

export type AutopilotActionName = "start" | "pause" | "stop" | "intervene" | "answer" | "configure" | "reset" | "move" | "sync" | "refresh";

/** Run an autopilot action through the lazily loaded runtime, with one busy flag and error toasts. */
export function useAutopilotActions(bookId: string | undefined) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [busy, setBusy] = useState<AutopilotActionName | null>(null);

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

  return { busy, run };
}
