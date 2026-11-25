import { describe, expect, it } from "vitest";
import {
  AUTOMATIC_THROTTLE_MS,
  CRITICAL_RATE_LIMIT,
  DEFAULT_BACKGROUND_BRANCHES,
  LOW_RATE_LIMIT,
  MAX_BACKGROUND_BRANCHES,
  MAX_BACKOFF_MS,
  PERIODIC_INTERVAL_MS,
  cycleMayStart,
  decideBranchAction,
  outcomeIsVisible,
  pauseAfterFailure,
  periodicDelay,
  rateLimitAllows,
  selectBranchesToSync,
  triggerRuns,
  type BranchFacts,
} from "@/branches/autoSyncPolicy";
import { recordBranchUse, keepBranchInSync } from "@/branches/memory";
import type { BookBranchMemory } from "@/types/settings";

const NOW = Date.parse("2026-11-24T12:00:00.000Z");

describe("when a cycle runs", () => {
  it("follows the mode: never by itself when off, on opening and focus, and periodically only when chosen; the person always", () => {
    expect((["open", "switch", "created", "focus", "online", "periodic"] as const).filter((trigger) => triggerRuns("off", trigger))).toEqual([]);
    expect(triggerRuns("off", "manual")).toBe(true);
    expect((["open", "switch", "created", "focus", "online", "periodic", "manual"] as const).filter((trigger) => triggerRuns("open-focus", trigger))).toEqual(["open", "switch", "created", "focus", "online", "manual"]);
    expect(triggerRuns("periodic", "periodic")).toBe(true);
  });

  it("is not repeated by a focus or a tick within a minute, waits out a pause, and never makes the person wait", () => {
    expect(cycleMayStart("focus", { now: NOW, lastCycleAt: NOW - AUTOMATIC_THROTTLE_MS + 1 })).toBe(false);
    expect(cycleMayStart("periodic", { now: NOW, lastCycleAt: NOW - AUTOMATIC_THROTTLE_MS })).toBe(true);
    expect(cycleMayStart("open", { now: NOW, lastCycleAt: NOW - 1 })).toBe(true);
    expect(cycleMayStart("switch", { now: NOW, pausedUntil: NOW + 1 })).toBe(false);
    expect(cycleMayStart("manual", { now: NOW, lastCycleAt: NOW, pausedUntil: NOW + 60_000 })).toBe(true);
  });

  it("comes every five minutes, twice as late after each failure in a row, never later than an hour", () => {
    expect(periodicDelay(0)).toBe(PERIODIC_INTERVAL_MS);
    expect(periodicDelay(1)).toBe(2 * PERIODIC_INTERVAL_MS);
    expect(periodicDelay(3)).toBe(8 * PERIODIC_INTERVAL_MS);
    expect(periodicDelay(30)).toBe(MAX_BACKOFF_MS);
  });

  it("waits after a failure by its kind: the reset of a rate limit, a while after a secondary limit, growing for the network, nothing for a credential", () => {
    expect(pauseAfterFailure("rate-limit", 1, NOW, { rateLimitReset: NOW + 900_000 })).toBe(NOW + 900_000);
    expect(pauseAfterFailure("rate-limit", 1, NOW)).toBe(NOW + 15 * 60_000);
    expect(pauseAfterFailure("abuse-limit", 1, NOW, { retryAfterSeconds: 30 })).toBe(NOW + 30_000);
    expect(pauseAfterFailure("network", 1, NOW)).toBe(NOW + 120_000);
    expect(pauseAfterFailure("network", 3, NOW)).toBe(NOW + 480_000);
    expect(pauseAfterFailure("service-unavailable", 20, NOW)).toBe(NOW + MAX_BACKOFF_MS);
    expect(pauseAfterFailure("not-found", 1, NOW)).toBe(NOW + 10 * 60_000);
    for (const kind of ["credential-invalid", "no-credential", "abort"]) expect(pauseAfterFailure(kind, 1, NOW)).toBeNull();
  });

  it("keeps the hour's requests: everything, the current branch only, or nothing until the reset", () => {
    expect(rateLimitAllows(null, NOW)).toBe("all");
    expect(rateLimitAllows({ remaining: LOW_RATE_LIMIT, resetAt: NOW + 1 }, NOW)).toBe("all");
    expect(rateLimitAllows({ remaining: LOW_RATE_LIMIT - 1, resetAt: NOW + 1 }, NOW)).toBe("current");
    expect(rateLimitAllows({ remaining: CRITICAL_RATE_LIMIT - 1, resetAt: NOW + 1 }, NOW)).toBe("none");
    expect(rateLimitAllows({ remaining: 0, resetAt: NOW }, NOW)).toBe("all");
  });
});

describe("which branches a cycle looks at", () => {
  const at = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
  function memoryOf(names: string[], extra: (memory: BookBranchMemory) => BookBranchMemory = (memory) => memory): BookBranchMemory {
    let memory: BookBranchMemory | undefined;
    names.forEach((name, index) => { memory = recordBranchUse(memory, name, at(names.length - index)); });
    return extra(memory!);
  }
  const everywhere = (names: string[]) => ({ localCopies: new Set(names), listed: new Map(names.map((name) => [name, `sha-${name}`])) });

  it("puts the current branch first, then the most recently used ones, up to four", () => {
    const names = ["a", "b", "c", "d", "e", "f", "current"];
    const picked = selectBranchesToSync({ current: "current", memory: memoryOf(names), ...everywhere(names), allows: "all" });
    expect(picked).toEqual([{ name: "current", role: "current" }, ...["f", "e", "d", "c"].map((name) => ({ name, role: "background" }))]);
    expect(picked).toHaveLength(1 + DEFAULT_BACKGROUND_BRANCHES);
  });

  it("adds the branches the person pinned, first, without the ones excluded, and never more than ten in the background", () => {
    const names = Array.from({ length: 14 }, (_, index) => `b${String(index).padStart(2, "0")}`);
    const pinned = memoryOf(names, (memory) => [0, 1, 2].reduce((next, index) => keepBranchInSync(next, names[index], true, at(0)), keepBranchInSync(memory, "b13", false, at(0))));
    const picked = selectBranchesToSync({ current: "b12", memory: pinned, ...everywhere(names), allows: "all" }).map((entry) => entry.name);
    expect(picked).toEqual(["b12", "b02", "b01", "b00", "b11", "b10", "b09", "b08"]);
    const allPinned = memoryOf(names, (memory) => names.reduce((next, name) => keepBranchInSync(next, name, true, at(0)), memory));
    expect(selectBranchesToSync({ current: "x", memory: allPinned, ...everywhere(names), allows: "all" })).toHaveLength(1 + MAX_BACKGROUND_BRANCHES);
  });

  it("leaves out a branch that is neither here nor on GitHub (made on another device, not published yet)", () => {
    const picked = selectBranchesToSync({ current: "main", memory: memoryOf(["elsewhere", "here", "on-github"]), localCopies: new Set(["main", "here"]), listed: new Map([["main", "1"], ["on-github", "2"]]), allows: "all" });
    expect(picked.map((entry) => entry.name)).toEqual(["main", "on-github", "here"]);
  });

  it("looks at the current branch alone when the hour is running out, and at none when it has run out", () => {
    const names = ["a", "main"];
    expect(selectBranchesToSync({ current: "main", memory: memoryOf(names), ...everywhere(names), allows: "current" })).toEqual([{ name: "main", role: "current" }]);
    expect(selectBranchesToSync({ current: "main", memory: memoryOf(names), ...everywhere(names), allows: "none" })).toEqual([]);
  });
});

describe("what a branch needs", () => {
  const facts = (patch: Partial<BranchFacts>): BranchFacts => ({ hasCopy: true, localHeadSha: "base", dirty: 0, ahead: 0, listedHeadSha: "base", ...patch });
  const free = { role: "current" as const, mayPush: true, mayPull: true };

  it("nothing when GitHub and the copy agree and nothing is waiting, or when GitHub's list did not say", () => {
    expect(decideBranchAction(facts({}), free)).toBe("none");
    expect(decideBranchAction(facts({ listedHeadSha: undefined, dirty: 3 }), free)).toBe("none");
  });

  it("a push only when GitHub did not move, a pull only into a clean copy", () => {
    expect(decideBranchAction(facts({ dirty: 1 }), free)).toBe("push");
    expect(decideBranchAction(facts({ ahead: 2 }), free)).toBe("push");
    expect(decideBranchAction(facts({ listedHeadSha: "newer" }), free)).toBe("pull");
  });

  it("diverged, for the person, when GitHub moved and the copy has work: never a merge or an overwrite", () => {
    expect(decideBranchAction(facts({ listedHeadSha: "newer", dirty: 1 }), free)).toBe("diverged");
    expect(decideBranchAction(facts({ listedHeadSha: "newer", ahead: 1 }), free)).toBe("diverged");
  });

  it("waits instead of pulling under unsaved edits, or of pushing while the server's autopilot runs", () => {
    expect(decideBranchAction(facts({ listedHeadSha: "newer" }), { ...free, mayPull: false })).toBe("hold");
    expect(decideBranchAction(facts({ dirty: 1 }), { ...free, mayPush: false })).toBe("hold");
  });

  it("publishes a branch made here, never one GitHub lost, and never over a branch of the same name with another history", () => {
    expect(decideBranchAction(facts({ pendingHeadSha: "base", listedHeadSha: null }), free)).toBe("publish");
    expect(decideBranchAction(facts({ pendingHeadSha: "base", listedHeadSha: "base" }), free)).toBe("publish");
    expect(decideBranchAction(facts({ pendingHeadSha: "base", listedHeadSha: "other" }), free)).toBe("name-taken");
    expect(decideBranchAction(facts({ pendingHeadSha: "base", listedHeadSha: null }), { ...free, mayPush: false })).toBe("hold");
    expect(decideBranchAction(facts({ listedHeadSha: null, dirty: 1 }), free)).toBe("gone");
  });

  it("downloads in the background a branch GitHub has and this device does not, never the current one (opening it does)", () => {
    expect(decideBranchAction({ hasCopy: false, dirty: 0, ahead: 0, listedHeadSha: "x" }, { ...free, role: "background" })).toBe("download");
    expect(decideBranchAction({ hasCopy: false, dirty: 0, ahead: 0, listedHeadSha: "x" }, free)).toBe("none");
    expect(decideBranchAction({ hasCopy: false, dirty: 0, ahead: 0, listedHeadSha: null }, { ...free, role: "background" })).toBe("none");
  });

  it("is silent about what cannot lose anything, and says everything else", () => {
    expect((["synced", "pulled", "pushed", "published", "downloaded", "held", "busy"] as const).filter(outcomeIsVisible)).toEqual([]);
    expect((["diverged", "gone", "name-taken", "failed"] as const).every(outcomeIsVisible)).toBe(true);
  });
});
