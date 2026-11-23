import { Suspense, createContext, lazy, useContext, useId } from "react";
import { useTranslation } from "react-i18next";
import { MessagesSquare } from "lucide-react";
import "@/i18n/autopilotCalls";
import { useCallsSource } from "@/autopilot/calls/sourceHook";
import { useCallsView } from "@/components/autopilot/calls/callsView";
import { TARGET } from "@/components/autopilot/calls/ui";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The task view itself: its own chunk, loaded the first time a step is opened. */
const TaskCalls = lazy(() => import("@/components/autopilot/calls/TaskCalls"));

/** What the history gives the task views it holds: the book, and its one status line for what the reader does (a copy). */
export interface CallsTimeline {
  bookId: string;
  /** Says `text` at once in the status line of the history: the answer to something the reader did. */
  announce: (text: string) => void;
}

export const CallsTimelineContext = createContext<CallsTimeline | null>(null);

/**
 * The messages a step exchanged with the AI (the calls of each of its attempts, `activityIds`, oldest first), drawn by the task view, which loads with
 * them. Nothing where the records cannot be read in this build. `running` for the step that runs: its calls are followed while they stream.
 */
export function TaskCallsEntry({ activityIds, running = false }: { activityIds: readonly string[]; running?: boolean }) {
  const { t } = useTranslation();
  const timeline = useContext(CallsTimelineContext);
  const source = useCallsSource(timeline?.bookId ?? "");
  if (!timeline || activityIds.length === 0 || source.reason === "unwired") return null;
  return (
    <Suspense fallback={<p className="text-xs text-muted-foreground">{t("autopilot.calls.loading")}</p>}>
      <TaskCalls bookId={timeline.bookId} activityIds={activityIds} running={running} announce={timeline.announce} />
    </Suspense>
  );
}

/**
 * The messages of the step that runs, behind a button of its block: they load when the reader opens them, and they stay open for that step (its row
 * opens on them when it ends).
 */
export function LiveCallsToggle({ activityId }: { activityId: string }) {
  const { t } = useTranslation();
  const timeline = useContext(CallsTimelineContext);
  const source = useCallsSource(timeline?.bookId ?? "");
  const open = useCallsView((state) => state.live[activityId] ?? false);
  const setLive = useCallsView((state) => state.setLive);
  const region = useId();
  if (!timeline || source.reason === "unwired") return null;
  return (
    <div className="space-y-2 pt-1">
      <Button type="button" variant="outline" size="sm" aria-expanded={open} aria-controls={region} onClick={() => setLive(activityId, !open)} data-live-calls-toggle className={cn("h-auto", TARGET)}>
        <MessagesSquare aria-hidden="true" />
        {open ? t("autopilot.calls.hide") : t("autopilot.calls.show")}
      </Button>
      <div id={region}>{open && <TaskCallsEntry activityIds={[activityId]} running />}</div>
    </div>
  );
}
