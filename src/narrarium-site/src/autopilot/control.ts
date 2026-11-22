import type { AutopilotSnapshot, AutopilotStateSummary, AutopilotStatus } from "narrarium-engine";

/** Why this client cannot command the run: `other-host`, the book runs on another device or on the server, which this client does not control. */
export type ControlReason = "other-host";

export interface AutopilotControl {
  /** What the page shows of the status and statistics: the newer of the downloaded state and the last `state` event. */
  summary: AutopilotStateSummary | null;
  status: AutopilotStatus | undefined;
  /** The autopilot of the book runs: here, in another tab, on the server or somewhere else. */
  running: boolean;
  /** This client can pause, stop and steer the run (a run of another tab is commanded through the tab that runs it). */
  controllable: boolean;
  reason: ControlReason | null;
  /** Who runs it, as the stored state names it ("My server", "Browser · Android"); null when it is not known. */
  runnerLabel: string | null;
  runnerHost: "browser" | "server" | null;
  /**
   * How long ago the run was last heard of, in milliseconds: the newer of the heartbeat saved in its state and the last event
   * received for the book. Null unless the run is elsewhere. It will be the periodic heartbeat of the engine when there is one.
   */
  heartbeatAge: number | null;
  /** The run recorded as active is one this client cannot command: the author may start it here instead (`start({ force: true })`). */
  canTakeOver: boolean;
}

export interface AutopilotControlInput {
  snapshot: AutopilotSnapshot | null;
  /** The book runs in another tab of this browser (its Web Lock is held elsewhere). */
  busyInAnotherTab: boolean;
  summary: AutopilotStateSummary | null;
  /** When something was last received for the book (milliseconds since the epoch). */
  lastSignal: number | undefined;
}

/** Who can command the autopilot of a book right now, given what is known of it. Shared by the page and the dock. */
export function selectAutopilotControl(input: AutopilotControlInput, now: number): AutopilotControl {
  const status = input.summary?.status;
  const recorded = status === "running" ? input.summary?.runner ?? null : null;
  // A run of this tab (or of the server, for a book it hosts: its snapshot says so), or of another tab, whose commands go through the channel.
  const controllable = Boolean(input.snapshot?.running) || input.busyInAnotherTab;
  const running = controllable || status === "running";
  const elsewhere = running && !controllable;
  const runner = elsewhere ? recorded : null;
  let heartbeatAge: number | null = null;
  if (elsewhere) {
    const heartbeat = runner ? Date.parse(runner.heartbeatAt) : Number.NaN;
    const freshest = Math.max(Number.isFinite(heartbeat) ? heartbeat : 0, input.lastSignal ?? 0);
    heartbeatAge = freshest > 0 ? Math.max(0, now - freshest) : null;
  }
  return {
    summary: input.summary,
    status,
    running,
    controllable,
    reason: elsewhere ? "other-host" : null,
    runnerLabel: runner?.label || null,
    runnerHost: runner?.host ?? null,
    heartbeatAge,
    canTakeOver: elsewhere,
  };
}
