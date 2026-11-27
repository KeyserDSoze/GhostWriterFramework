import { useCallback, useEffect, useRef } from "react";
import type { Octokit } from "@octokit/rest";
import { getPublishingRun, listPublishingRuns, readRunProgress, type PublishingRun, type RepositoryRef } from "@/readerAccess/api";
import { ReaderFlowError } from "@/readerAccess/errors";
import { eventOf, isEnded, isGoing, matchPublicationRun, nextDelayMs, withRun, type PublicationTrigger, type TrackedPublication } from "@/readerRun/model";
import { IDLE_LIVE, publicationKey, usePublicationStore, type PublicationLive } from "@/readerRun/store";

/** Looking again at a tab that just became visible is at once, unless GitHub was asked this moment (a flicker of the tab asks nothing). */
const VISIBLE_ROOM_MS = 2_000;

export interface BeginPublication { trigger: PublicationTrigger; branch: string; headSha?: string; baselineRunId?: number | null; runId?: number }

function problemOf(error: unknown): NonNullable<PublicationLive["problem"]> {
  const failure = error instanceof ReaderFlowError ? error.failure : null;
  if (!failure) return "other";
  return failure.kind === "rate-limit" ? "rate-limit" : failure.kind === "network" ? "network" : failure.kind === "permission" || failure.kind === "credential" || failure.kind === "sso" ? "permission" : "other";
}

function retryAfterOf(error: unknown, now: number): number | undefined {
  const failure = error instanceof ReaderFlowError ? error.failure : null;
  if (failure?.kind !== "rate-limit" || !failure.resetAt) return undefined;
  const wait = Date.parse(failure.resetAt) - now;
  return Number.isFinite(wait) && wait > 0 ? wait : undefined;
}

interface Options {
  repo: RepositoryRef;
  octokit: () => Octokit | null;
  /** GitHub can be asked (a credential it accepts, online). */
  enabled: boolean;
  /** A publication ended (or never appeared): the caller reads what changed (the runs, the failure, the outside check). */
  onEnded?: (publication: TrackedPublication) => void;
}

/**
 * The live state of the publication that this repository's reader is following. The poll runs only while a publication is going (nothing publishing: no
 * request at all), every 20 seconds once its run is known and a little faster while GitHub has not made the run yet; it stops when the tab is hidden and looks
 * again at once when the tab is visible; it slows down on a refusal for the rate limit; and it ends with the run. What it found is kept (see `store`), so a
 * reload goes on from there.
 */
export function usePublicationRun({ repo, octokit, enabled, onEnded }: Options) {
  const key = publicationKey(repo.owner, repo.repo);
  const tracked = usePublicationStore((state) => state.entries[key]) ?? null;
  const live = usePublicationStore((state) => state.live[key]) ?? IDLE_LIVE;
  const going = isGoing(tracked, Date.now());
  const trackedId = tracked ? `${tracked.since}|${tracked.trigger}` : null;
  const ended = useRef(onEnded);
  ended.current = onEnded;
  const octokitRef = useRef(octokit);
  octokitRef.current = octokit;

  const begin = useCallback((input: BeginPublication) => {
    usePublicationStore.getState().begin(key, { trigger: input.trigger, branch: input.branch, ...(input.headSha ? { headSha: input.headSha } : {}), baselineRunId: input.baselineRunId ?? null, since: new Date().toISOString(), ...(input.runId !== undefined ? { runId: input.runId } : {}), lookups: 0 });
  }, [key]);

  useEffect(() => {
    if (!going || !enabled || typeof document === "undefined") return undefined;
    const store = usePublicationStore.getState;
    let timer: number | undefined;
    let stopped = false;
    let inFlight = false;
    let lastAsked = 0;

    const finish = () => {
      const current = store().entries[key];
      store().setLive(key, { nextAt: null });
      if (current) ended.current?.(current);
    };

    const ask = async () => {
      if (stopped || inFlight) return;
      const client = octokitRef.current();
      const current = store().entries[key];
      if (!client || !current) return;
      inFlight = true;
      lastAsked = Date.now();
      let delay: number;
      try {
        let run: PublishingRun | null;
        if (current.runId !== undefined) run = await getPublishingRun(client, repo, current.runId);
        else {
          const event = eventOf(current.trigger);
          run = matchPublicationRun(await listPublishingRuns(client, repo, { ...(event ? { event } : {}), perPage: 30 }), current);
        }
        if (stopped) return;
        const progress = run && !isEnded(run.state) ? await readRunProgress(client, repo, run.id).catch(() => undefined) : null;
        if (stopped) return;
        const now = Date.now();
        if (run) store().update(key, (before) => withRun(before, run, progress, now));
        else store().update(key, (before) => ({ ...before, lookups: before.lookups + 1 }));
        store().setLive(key, { failures: 0, problem: null, nextAt: null, checkedAt: now });
        const after = store().entries[key];
        if (!after || !isGoing(after, Date.now())) { finish(); return; }
        delay = nextDelayMs({ matched: after.runId !== undefined, lookups: after.lookups, failures: 0 });
      } catch (error) {
        if (stopped) return;
        const failures = (store().live[key]?.failures ?? 0) + 1;
        const problem = problemOf(error);
        // A credential GitHub refuses, or a missing permission, will not change by asking again: the card says so and stops asking.
        if (problem === "permission") { store().setLive(key, { failures, problem, nextAt: null }); return; }
        delay = nextDelayMs({ matched: current.runId !== undefined, lookups: current.lookups, failures, retryAfterMs: retryAfterOf(error, Date.now()) });
        store().setLive(key, { failures, problem, nextAt: Date.now() + delay });
      } finally {
        inFlight = false;
      }
      schedule(delay);
    };

    const schedule = (delay: number) => {
      window.clearTimeout(timer);
      if (stopped) return;
      if (document.visibilityState === "hidden") { store().setLive(key, { paused: true }); return; }
      timer = window.setTimeout(() => { void ask(); }, delay);
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") { window.clearTimeout(timer); store().setLive(key, { paused: true }); return; }
      store().setLive(key, { paused: false });
      window.clearTimeout(timer);
      if (Date.now() - lastAsked >= VISIBLE_ROOM_MS) void ask(); else schedule(VISIBLE_ROOM_MS);
    };

    document.addEventListener("visibilitychange", onVisibility);
    // The first look is at once (a reload goes on from where it was); a tab that opens hidden waits until it is seen.
    if (document.visibilityState === "hidden") store().setLive(key, { paused: true }); else void ask();
    return () => { stopped = true; window.clearTimeout(timer); document.removeEventListener("visibilitychange", onVisibility); };
  // `going` and `trackedId` decide whether a poll exists and for which publication; the rest is read from the store when it is needed.
  }, [going, trackedId, enabled, key, repo]);

  /** Asks GitHub now, without waiting for the next turn (the «Check now» of the card). */
  const refreshNow = useCallback(async () => {
    const client = octokitRef.current();
    const current = usePublicationStore.getState().entries[key];
    if (!client || !current) return;
    try {
      let run: PublishingRun | null;
      if (current.runId !== undefined) run = await getPublishingRun(client, repo, current.runId);
      else { const event = eventOf(current.trigger); run = matchPublicationRun(await listPublishingRuns(client, repo, { ...(event ? { event } : {}), perPage: 30 }), current); }
      const progress = run && !isEnded(run.state) ? await readRunProgress(client, repo, run.id).catch(() => undefined) : null;
      const now = Date.now();
      if (run) usePublicationStore.getState().update(key, (before) => withRun(before, run, progress, now));
      usePublicationStore.getState().setLive(key, { failures: 0, problem: null, checkedAt: now });
      const after = usePublicationStore.getState().entries[key];
      if (after && !isGoing(after, Date.now())) ended.current?.(after);
    } catch (error) {
      usePublicationStore.getState().setLive(key, { problem: problemOf(error) });
    }
  }, [key, repo]);

  return { tracked, live, going, begin, refreshNow, forget: () => usePublicationStore.getState().forget(key) };
}
