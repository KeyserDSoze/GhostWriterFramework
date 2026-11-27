import { describe, expect, it } from "vitest";
import type { PublishingRun } from "@/readerAccess/api";
import { BACKOFF_MAX_MS, NOT_FOUND_AFTER_MS, POLL_MS, allRunsUrl, durationMs, eventOf, isGoing, matchPublicationRun, nextDelayMs, phaseOf, runUrl, splitDuration, withRun, type TrackedPublication } from "@/readerRun/model";
import { RUN_STORAGE_KEY, readStoredPublications } from "@/readerRun/store";

const run = (id: number, patch: Partial<PublishingRun> = {}): PublishingRun => ({ id, state: "queued", event: "workflow_dispatch", branch: "main", headSha: `sha-${id}`, createdAt: "2026-11-27T10:00:00Z", startedAt: "2026-11-27T10:00:00Z", updatedAt: "2026-11-27T10:00:00Z", url: "", ...patch });
const tracked = (patch: Partial<TrackedPublication> = {}): TrackedPublication => ({ trigger: "dispatch", branch: "main", baselineRunId: 100, since: "2026-11-27T10:00:05Z", lookups: 0, ...patch });

describe("which run an action made", () => {
  it("is the first workflow_dispatch run on the branch after the newest run that existed before the click, whatever the clocks say", () => {
    const runs = [run(104, { event: "push" }), run(103), run(100), run(99)];
    expect(matchPublicationRun(runs, tracked())?.id).toBe(103);
    // A run of an earlier click (id not above the baseline) is never taken for this one, even if its time is later than the click's by the browser's clock.
    expect(matchPublicationRun([run(100, { createdAt: "2026-11-27T10:05:00Z" })], tracked())).toBeNull();
    expect(matchPublicationRun([], tracked())).toBeNull();
  });

  it("takes the oldest of the runs the click made when there are several (a double click), and ignores the other events and the other branches", () => {
    expect(matchPublicationRun([run(106), run(105), run(104, { branch: "feature/x" }), run(103, { event: "schedule" })], tracked())?.id).toBe(105);
  });

  it("falls back to the clock, with room for the difference between two clocks, only when the newest run before the click could not be read", () => {
    const unknown = tracked({ baselineRunId: null, since: "2026-11-27T10:00:30Z" });
    expect(matchPublicationRun([run(7, { createdAt: "2026-11-27T10:00:10Z" })], unknown)?.id).toBe(7);
    expect(matchPublicationRun([run(7, { createdAt: "2026-11-27T09:58:00Z" })], unknown)).toBeNull();
  });

  it("is, for a push, the push run of that very commit and nothing else, the newest one when it was run again", () => {
    const push = tracked({ trigger: "push", headSha: "abc", baselineRunId: null });
    const runs = [run(9, { event: "push", headSha: "other" }), run(8, { event: "workflow_dispatch", headSha: "abc" }), run(7, { event: "push", headSha: "abc" }), run(6, { event: "push", headSha: "abc" })];
    expect(matchPublicationRun(runs, push)?.id).toBe(7);
    expect(matchPublicationRun([run(9, { event: "push", headSha: "zzz" })], push)).toBeNull();
  });

  it("follows a run that was already going by its id", () => {
    expect(matchPublicationRun([run(5), run(4)], tracked({ trigger: "observed", runId: 4 }))?.id).toBe(4);
    expect(matchPublicationRun([run(5)], tracked({ trigger: "observed", runId: 4 }))).toBeNull();
    expect(eventOf("dispatch")).toBe("workflow_dispatch");
    expect(eventOf("push")).toBe("push");
    expect(eventOf("observed")).toBeNull();
  });
});

describe("the state of a publication", () => {
  const now = Date.parse("2026-11-27T10:01:00Z");

  it("is waiting until a run is found, then the run's own state, and never goes back from an end", () => {
    expect(phaseOf(tracked(), now)).toBe("waiting");
    const found = withRun(tracked(), run(103, { state: "running" }), { job: "build", step: "Build", index: 3, total: 6 }, now);
    expect(found).toMatchObject({ runId: 103, state: "running", step: { step: "Build" } });
    expect(phaseOf(found, now)).toBe("running");
    const ended = withRun(found, run(103, { state: "succeeded", updatedAt: "2026-11-27T10:02:10Z" }), null, now);
    expect(ended).toMatchObject({ state: "succeeded", endedAt: now });
    expect(ended.step).toBeUndefined();
    expect(isGoing(ended, now)).toBe(false);
  });

  it("is not found when GitHub has made no run in three minutes, and then nothing is waited for", () => {
    const late = Date.parse("2026-11-27T10:00:05Z") + NOT_FOUND_AFTER_MS + 1;
    expect(phaseOf(tracked(), late)).toBe("not-found");
    expect(isGoing(tracked(), late)).toBe(false);
    expect(isGoing(tracked(), now)).toBe(true);
    expect(isGoing(null, now)).toBe(false);
    for (const state of ["queued", "running"] as const) expect(isGoing(tracked({ state, runId: 1 }), late)).toBe(true);
    for (const state of ["succeeded", "failed", "cancelled"] as const) expect(isGoing(tracked({ state, runId: 1 }), now)).toBe(false);
  });

  it("counts the time a run has taken: to now while it goes, to its last update when it ended", () => {
    const base = { startedAt: "2026-11-27T10:00:00Z", updatedAt: "2026-11-27T10:02:10Z" };
    expect(durationMs({ ...base, state: "running" }, Date.parse("2026-11-27T10:01:00Z"))).toBe(60_000);
    expect(durationMs({ ...base, state: "succeeded" }, Date.parse("2026-11-27T11:00:00Z"))).toBe(130_000);
    expect(durationMs({ state: "queued" }, now)).toBeNull();
    expect(splitDuration(130_400)).toEqual({ minutes: 2, seconds: 10 });
    expect(splitDuration(4_000)).toEqual({ minutes: 0, seconds: 4 });
  });

  it("gives the address of the run, and of all the runs of the publishing workflow", () => {
    expect(runUrl("me", "book", 123)).toBe("https://github.com/me/book/actions/runs/123");
    expect(allRunsUrl("me", "book")).toBe("https://github.com/me/book/actions/workflows/deploy-reader-pages.yml");
  });
});

describe("how often GitHub is asked", () => {
  it("is quick while the run is not there yet, then every 20 seconds", () => {
    expect([0, 1, 2, 3, 4, 9].map((lookups) => nextDelayMs({ matched: false, lookups, failures: 0 }))).toEqual([3_000, 5_000, 8_000, 13_000, POLL_MS, POLL_MS]);
    expect(nextDelayMs({ matched: true, lookups: 0, failures: 0 })).toBe(POLL_MS);
  });

  it("doubles after each refusal, up to five minutes, and never asks sooner than GitHub's own reset time says", () => {
    expect([1, 2, 3, 4, 5, 9].map((failures) => nextDelayMs({ matched: true, lookups: 0, failures }))).toEqual([40_000, 80_000, 160_000, BACKOFF_MAX_MS, BACKOFF_MAX_MS, BACKOFF_MAX_MS]);
    expect(nextDelayMs({ matched: true, lookups: 0, failures: 1, retryAfterMs: 120_000 })).toBe(120_000);
    expect(nextDelayMs({ matched: true, lookups: 0, failures: 1, retryAfterMs: 3_600_000 })).toBe(BACKOFF_MAX_MS);
  });
});

describe("what survives a reload", () => {
  const storage = (value: unknown) => ({ getItem: (key: string) => (key === RUN_STORAGE_KEY ? JSON.stringify(value) : null) });
  const now = Date.parse("2026-11-27T12:00:00Z");

  it("keeps a publication that is going and one that ended a little while ago, and drops the old and the malformed", () => {
    const kept = readStoredPublications(storage({
      "me/going": tracked({ runId: 3, state: "running" }),
      "me/recent": tracked({ runId: 4, state: "succeeded", endedAt: now - 3_600_000 }),
      "me/old": tracked({ runId: 5, state: "failed", endedAt: now - 7 * 3_600_000 }),
      "me/broken": { trigger: "nope" },
      "me/also": "text",
    }), now);
    expect(Object.keys(kept).sort()).toEqual(["me/going", "me/recent"]);
  });

  it("reads nothing from a storage that is empty, absent or not JSON", () => {
    expect(readStoredPublications(undefined, now)).toEqual({});
    expect(readStoredPublications({ getItem: () => null }, now)).toEqual({});
    expect(readStoredPublications({ getItem: () => "{not json" }, now)).toEqual({});
  });
});
