import type { PublishingRun, RunProgress, RunState } from "@/readerAccess/api";

/**
 * The publication that the author just started (a click on «Publish» / «Publish again», a password change, or the commit of «Update the reader») and the run
 * of the Pages workflow that it made. Nothing here reads GitHub or the clock by itself: the matching of a run to its action, the pace of the poll and the
 * words of the state are pure, so each one is held by a test.
 *
 * How an action is tied to ITS run (GitHub answers a dispatch with no run id):
 *  - a push (the commit of «Update the reader») makes a run of the event `push` whose `head_sha` is that commit: nothing else can be it;
 *  - a dispatch makes a run of the event `workflow_dispatch` on the branch it was started on, with an id GREATER than the newest run that existed before it
 *    (run ids only grow, and unlike the two clocks they do not disagree). When the newest id could not be read before, the clock stands in: a run created
 *    after the click, with a little room for the difference between the browser's clock and GitHub's;
 *  - a run that was already going when the card opened (`observed`) is followed by its id.
 */
export type PublicationTrigger = "dispatch" | "push" | "observed";

export interface TrackedPublication {
  /** `since`, which is unique for the repository: a new action replaces the one before it. */
  trigger: PublicationTrigger;
  branch: string;
  /** The commit that a push published. */
  headSha?: string;
  /** The id of the newest run before the action (`0`: none); `null` when it could not be read. */
  baselineRunId: number | null;
  /** The browser's clock at the action (ISO). */
  since: string;
  runId?: number;
  state?: RunState;
  createdAt?: string;
  startedAt?: string;
  updatedAt?: string;
  step?: RunProgress;
  /** Lookups that found nothing yet: the pace slows down as they go. */
  lookups: number;
  /** The outside check of the published reader was run for this publication (once). */
  outsideChecked?: boolean;
  /** When this device last saw the run in an end state (ms): old ones are forgotten. */
  endedAt?: number;
}

export const CLOCK_ROOM_MS = 30_000;
/** A run that GitHub has not made after this long is reported as not found (and polling stops: nothing is publishing). */
export const NOT_FOUND_AFTER_MS = 3 * 60_000;
export const POLL_MS = 20_000;
export const BACKOFF_MAX_MS = 5 * 60_000;
/** A finished publication stays on the card across reloads for this long. */
export const KEEP_ENDED_MS = 6 * 3_600_000;
const FIRST_LOOKUPS_MS = [3_000, 5_000, 8_000, 13_000];

export function isEnded(state: RunState | undefined): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

const EVENT: Record<PublicationTrigger, string | null> = { dispatch: "workflow_dispatch", push: "push", observed: null };

/** The event whose runs are listed to look for the run of this action (`null`: any). */
export function eventOf(trigger: PublicationTrigger): string | null {
  return EVENT[trigger];
}

/** The run that this action made among `runs` (newest first, as GitHub lists them), or `null` when GitHub has not made it yet. */
export function matchPublicationRun(runs: readonly PublishingRun[], tracked: Pick<TrackedPublication, "trigger" | "branch" | "headSha" | "baselineRunId" | "since" | "runId">): PublishingRun | null {
  if (tracked.runId !== undefined) return runs.find((run) => run.id === tracked.runId) ?? null;
  const event = EVENT[tracked.trigger];
  const since = Date.parse(tracked.since);
  const found = runs.filter((run) => {
    if (event && run.event !== event) return false;
    if (tracked.trigger === "push") return run.headSha === tracked.headSha;
    if (run.branch !== tracked.branch) return false;
    if (tracked.baselineRunId !== null) return run.id > tracked.baselineRunId;
    return Number.isFinite(since) ? Date.parse(run.createdAt) >= since - CLOCK_ROOM_MS : false;
  });
  return found.sort((left, right) => left.id - right.id)[tracked.trigger === "push" ? found.length - 1 : 0] ?? null;
}

/** The tracked publication with what a poll read of its run. A state that has ended is never taken back to going. */
export function withRun(tracked: TrackedPublication, run: PublishingRun, step: RunProgress | null | undefined, now: number): TrackedPublication {
  const ended = isEnded(run.state);
  return {
    ...tracked,
    runId: run.id,
    state: run.state,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    step: ended ? undefined : step === undefined ? tracked.step : step ?? undefined,
    ...(ended ? { endedAt: tracked.endedAt ?? now } : {}),
  };
}

/** What the card says of the run: GitHub has not made it yet (`waiting`), it is going, it ended, or it never appeared (`not-found`). */
export type PublicationPhase = RunState | "waiting" | "not-found";

export function phaseOf(tracked: TrackedPublication, now: number): PublicationPhase {
  if (tracked.state) return tracked.state;
  return now - Date.parse(tracked.since) > NOT_FOUND_AFTER_MS ? "not-found" : "waiting";
}

/** Whether anything is left to wait for: nothing is polled for a publication that ended or that GitHub never made. */
export function isGoing(tracked: TrackedPublication | null | undefined, now: number): boolean {
  if (!tracked) return false;
  const phase = phaseOf(tracked, now);
  // A run held for approval is not over: it goes on as soon as someone approves it, so it is still followed.
  return phase === "waiting" || phase === "queued" || phase === "running" || phase === "action-required";
}

/**
 * The wait before the next look: a quick few while the run is not there yet, then every 20 seconds; after a refusal for the rate limit or a network failure it
 * doubles (20 s, 40 s, 80 s … at most 5 minutes) and goes back to normal at the first answer. `retryAfterMs` (from GitHub's own reset time) is never undercut.
 */
export function nextDelayMs(input: { matched: boolean; lookups: number; failures: number; retryAfterMs?: number }): number {
  if (input.failures > 0) return Math.max(Math.min(POLL_MS * 2 ** input.failures, BACKOFF_MAX_MS), Math.min(input.retryAfterMs ?? 0, BACKOFF_MAX_MS));
  if (!input.matched) return FIRST_LOOKUPS_MS[input.lookups] ?? POLL_MS;
  return POLL_MS;
}

/** The address of a run on GitHub, and of the list of the runs of the reader's workflow. */
export function runUrl(owner: string, repo: string, runId: number): string {
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}`;
}

export function allRunsUrl(owner: string, repo: string): string {
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/deploy-reader-pages.yml`;
}

/** How long a run has taken: from its start to its end (`updatedAt`), or to `now` while it goes. `null` until it has started. */
export function durationMs(tracked: Pick<TrackedPublication, "state" | "startedAt" | "updatedAt">, now: number): number | null {
  if (!tracked.startedAt) return null;
  const start = Date.parse(tracked.startedAt);
  if (!Number.isFinite(start)) return null;
  const end = isEnded(tracked.state) ? Date.parse(tracked.updatedAt ?? "") : now;
  return Number.isFinite(end) ? Math.max(0, end - start) : null;
}

/** A duration as `{minutes, seconds}`, rounded to the second. */
export function splitDuration(ms: number): { minutes: number; seconds: number } {
  const total = Math.round(ms / 1000);
  return { minutes: Math.floor(total / 60), seconds: total % 60 };
}
