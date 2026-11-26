import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AutopilotLiveOptions, AutopilotPublishMode } from "narrarium-engine";
import { useToast } from "@/components/ui/use-toast";
import { loadAutopilotRuntime } from "@/autopilot/loader";
import type { HandoverRequest } from "@/autopilot/handover";
import type { AutopilotOperationKind, BookOperation } from "@/autopilot/operations";
import type { PauseCommand, RunOneKind } from "@/autopilot/quickControls";
import type { AutopilotRuntime } from "@/autopilot/runtime";
import { useAutopilotStore } from "@/autopilot/store";
import type { SyncOutcome } from "@/autopilot/store";

export type AutopilotActionName = "start" | "pause" | "stop" | "intervene" | "answer" | "configure" | "reset" | "move" | "sync" | "refresh" | "cancel-pause" | "options" | "publish" | "handover" | "retry-now" | "conflicts";

/** How long the outcome of «Retry now» stays on the screen, once said. */
const RETRY_OUTCOME_MS = 10_000;

/** What «Retry now» came to: whether a wait was skipped (`false`: it was already over), and which wait it was. */
export interface RetryOutcome {
  skipped: boolean;
  /** The time of the attempt the wait was for (`summary.retry.at`), so that the outcome is not taken for one of a later wait. */
  waitAt: string | null;
}

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
  // A decision about a frozen chapter is an answer about it, as the answer to its question would be.
  frozen: "answer",
  // The Synopsis applied to the book is the author's decision about the changes of its entries, as the answers to their questions would be.
  campaign: "answer",
  // The author is settling the conflicts with GitHub: nothing else holds the book, and no other button reads as busy for it.
  githubConflicts: "conflicts",
};

/** What a person asks of the autopilot with one click: each returns whether it was done (a failure is already said in a toast). */
export interface AutopilotCommands {
  /** Pause the run (`after-step`, `after-chapter`, `now`), or take back a pause that waits (`cancel`). */
  pause: (mode: PauseCommand) => Promise<boolean>;
  /** «Retry now»: end the wait before the next attempt of the step that failed; what it came to is `retried`. */
  retryNow: (waitAt: string | null) => Promise<boolean>;
  /** Stop now: the request in flight is abandoned. */
  stop: () => Promise<boolean>;
  cancelPause: () => Promise<boolean>;
  /** Resume, with no limit. */
  resume: () => Promise<boolean>;
  /** Run one step, or one chapter, and pause. */
  runOne: (kind: RunOneKind) => Promise<boolean>;
  /** Where the book is published, from the next step or chapter, also while a run goes on. */
  setPublish: (mode: AutopilotPublishMode) => Promise<boolean>;
  updateOptions: (options: AutopilotLiveOptions) => Promise<boolean>;
  /** Publish the book to GitHub now, and say how it went. */
  publishNow: () => Promise<boolean>;
  /** Take back a switch of the autopilot to the other side that still waits for the step to end, or close one that is over. */
  cancelHandover: () => Promise<boolean>;
  dismissHandover: () => Promise<boolean>;
  /**
   * Plan the move of the autopilot to the other side; `saveSettings` keeps the author's settings when the book changes hands. A failure
   * that `onError` handles (it answers `true`: a consent that is missing opens the flow that asks for it) is not said in a toast.
   */
  handover: (request: HandoverRequest, options?: { saveSettings?: () => Promise<unknown>; onError?: (error: unknown) => boolean }) => Promise<boolean>;
}

/**
 * Run an autopilot action through the lazily loaded runtime, with error toasts. `busy` names what holds the book: an
 * action of this component, or an operation another component (the page, the dock) or another tab started on the
 * same book, so every component disables what conflicts and shows what is going on.
 *
 * `commands` are the quick commands of the bar, each one an action of its own. A command that goes to a run this client cannot reach (the
 * run belongs to another device: `reach.unreachable`) is never sent. Commands that start a run are not held back by it: they are the way
 * to take it over, which the author confirms.
 */
export function useAutopilotActions(bookId: string | undefined, reach: { unreachable?: boolean } = {}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [busy, setBusy] = useState<AutopilotActionName | null>(null);
  const [retried, setRetried] = useState<RetryOutcome | null>(null);
  const operation: BookOperation | null = useAutopilotStore((state) => (bookId ? state.views[bookId]?.operation ?? null : null));
  const reachable = !reach.unreachable;
  // The outcome of «Retry now» is said once, and then goes: it is about a moment.
  useEffect(() => {
    if (!retried) return undefined;
    const timer = window.setTimeout(() => setRetried(null), RETRY_OUTCOME_MS);
    return () => window.clearTimeout(timer);
  }, [retried]);

  const run = useCallback(async (name: AutopilotActionName, action: (runtime: AutopilotRuntime, bookId: string) => Promise<unknown>, success?: string, onError?: (error: unknown) => boolean): Promise<boolean> => {
    if (!bookId) return false;
    setBusy(name);
    try {
      const runtime = await loadAutopilotRuntime();
      await action(runtime, bookId);
      if (success) toast({ title: success });
      return true;
    } catch (error) {
      // The caller may handle a failure better than a toast (a consent that is missing opens the flow that asks for it).
      if (onError?.(error)) return false;
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

  const commands = useMemo<AutopilotCommands>(() => {
    const reached = (name: AutopilotActionName, action: (runtime: AutopilotRuntime, id: string) => Promise<unknown>, success?: string, onError?: (error: unknown) => boolean) => (reachable ? run(name, action, success, onError) : Promise.resolve(false));
    return {
      pause: (mode) => reached(mode === "cancel" ? "cancel-pause" : "pause", (runtime, id) => runtime.pause(id, mode)),
      retryNow: (waitAt) => reached("retry-now", async (runtime, id) => setRetried({ skipped: await runtime.retryNow(id), waitAt })),
      stop: () => reached("stop", (runtime, id) => runtime.pause(id, "now")),
      cancelPause: () => reached("cancel-pause", (runtime, id) => runtime.pause(id, "cancel")),
      resume: () => run("start", (runtime, id) => runtime.start(id)),
      runOne: (kind) => run("start", (runtime, id) => runtime.runOne(id, kind)),
      setPublish: (mode) => reached("options", (runtime, id) => runtime.updateOptions(id, { publishEvery: mode }), t("autopilot.quick.publish.saved", { mode: t(`autopilot.quick.publish.mode.${mode}`) })),
      updateOptions: (options) => reached("options", (runtime, id) => runtime.updateOptions(id, options)),
      publishNow: () => run("publish", async (runtime, id) => {
        const outcome: SyncOutcome = await runtime.publishNow(id);
        if (!outcome.ok) throw new Error(outcome.message);
      }, t("autopilot.where.published")),
      cancelHandover: () => run("handover", (runtime, id) => runtime.cancelHandover(id)),
      dismissHandover: () => run("handover", async (runtime, id) => runtime.dismissHandover(id)),
      handover: (request, options = {}) => reached("handover", (runtime, id) => runtime.armHandover(id, request, { saveSettings: options.saveSettings }), undefined, options.onError),
    };
  }, [reachable, run, t]);

  return { busy: busy ?? (operation ? ACTION_OF_OPERATION[operation.kind] : null), run, operation, commands, retried };
}
