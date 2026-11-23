import { useCallback, useEffect, useRef, useState } from "react";
import type { AiCallTask } from "narrarium-engine";
import type { CallsSource } from "@/autopilot/calls/source";
import { pollWhileVisible } from "@/autopilot/calls/sourcePoll";

/** A step that is over and still has a call that says it runs (its record was not ended yet) is asked again this many times, then left as it is. */
const SETTLE_READS = 10;

export interface CallTaskState {
  task: AiCallTask | null;
  loading: boolean;
  error: unknown;
  reload(): void;
}

const runs = (task: AiCallTask | null) => Boolean(task && (task.header.status === "running" || task.calls.some((call) => call.status === "running")));

/**
 * The record of one task (a step's attempt) and its calls, read when the view opens and asked again while it runs (`running`: its step runs; or a call of
 * it still says it runs), at the pace of the source and never while the page is hidden. A step that is over is asked again only a few times for a call
 * whose end has not landed yet.
 */
export function useCallTask(source: CallsSource, bookId: string, activityId: string, running: boolean, epoch = 0): CallTaskState {
  const [state, setState] = useState<{ task: AiCallTask | null; loading: boolean; error: unknown }>({ task: null, loading: true, error: null });
  const [reload, setReload] = useState(0);
  const live = useRef(running);
  live.current = running;

  useEffect(() => {
    let cancelled = false;
    let settle = SETTLE_READS;
    setState((before) => (before.loading ? before : { ...before, loading: true }));
    const read = async (): Promise<boolean> => {
      try {
        const task = await source.readTask(bookId, activityId);
        if (cancelled) return false;
        setState({ task, loading: false, error: null });
        if (live.current) return true;
        if (!runs(task)) return false;
        settle -= 1;
        return settle > 0;
      } catch (error) {
        if (cancelled) return false;
        setState((before) => ({ ...before, loading: false, error }));
        throw error;
      }
    };
    const stop = pollWhileVisible(read, source.pollMs || 1000);
    return () => {
      cancelled = true;
      stop();
    };
  }, [source, bookId, activityId, reload, epoch]);

  // A step that starts running again after the view opened (it never does today, but a record can be behind) is followed again.
  const was = useRef(running);
  useEffect(() => {
    if (running && !was.current) setReload((key) => key + 1);
    was.current = running;
  }, [running]);

  const retry = useCallback(() => setReload((key) => key + 1), []);
  return { task: state.task, loading: state.loading, error: state.error, reload: retry };
}
