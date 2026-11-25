import type { AutoSyncMode, BookBranchMemory } from "@/types/settings";

/**
 * The decisions of the automatic sync of the branches of a GitHub book, as pure functions: when a cycle runs, which branches it looks at and in which order,
 * and what each branch needs. The runtime (`@/branches/autoSync`) only gathers the facts, asks these, and carries out the answer.
 */

/** A periodic cycle runs this often while nothing fails; each failure in a row doubles it, up to `MAX_BACKOFF_MS`. */
export const PERIODIC_INTERVAL_MS = 5 * 60_000;
export const MAX_BACKOFF_MS = 60 * 60_000;
/** A focus, a reconnection or a periodic tick this close to the last cycle of the book starts none. */
export const AUTOMATIC_THROTTLE_MS = 60_000;
/** Branches brought along besides the current one, by how recently they were used, unless the person pinned or excluded some. */
export const DEFAULT_BACKGROUND_BRANCHES = 4;
/** Never more than this in the background, pins included. */
export const MAX_BACKGROUND_BRANCHES = 10;
/** Below this many requests left in the hour, only the current branch is synced; below the critical floor, nothing until the reset. */
export const LOW_RATE_LIMIT = 500;
export const CRITICAL_RATE_LIMIT = 50;

/** What started a cycle: opening the book, switching branch, creating one, the window coming back, the network coming back, the timer, or the person. */
export type SyncTrigger = "open" | "switch" | "created" | "focus" | "online" | "periodic" | "manual";

export function triggerRuns(mode: AutoSyncMode, trigger: SyncTrigger): boolean {
  if (trigger === "manual") return true;
  if (mode === "off") return false;
  return trigger !== "periodic" || mode === "periodic";
}

export interface CycleTiming {
  now: number;
  lastCycleAt?: number;
  /** A failure or a rate limit put the automatic cycles off until then. */
  pausedUntil?: number;
}

/** Whether a cycle may start now. The person (`manual`) is never made to wait; opening, switching and creating are not throttled, the rest is. */
export function cycleMayStart(trigger: SyncTrigger, timing: CycleTiming): boolean {
  if (trigger === "manual") return true;
  if (timing.pausedUntil !== undefined && timing.pausedUntil > timing.now) return false;
  const automatic = trigger === "focus" || trigger === "online" || trigger === "periodic";
  return !(automatic && timing.lastCycleAt !== undefined && timing.now - timing.lastCycleAt < AUTOMATIC_THROTTLE_MS);
}

/** When the next periodic cycle is due after `failures` failures in a row. */
export function periodicDelay(failures: number): number {
  return Math.min(MAX_BACKOFF_MS, PERIODIC_INTERVAL_MS * 2 ** Math.max(0, Math.min(failures, 10)));
}

/** How long automatic cycles wait after a failure of this kind (the person can always sync at once). `null`: nothing to wait for. */
export function pauseAfterFailure(kind: string, failures: number, now: number, hints: { rateLimitReset?: number; retryAfterSeconds?: number } = {}): number | null {
  if (kind === "abort" || kind === "credential-invalid" || kind === "no-credential") return null;
  if (kind === "rate-limit") return hints.rateLimitReset && hints.rateLimitReset > now ? hints.rateLimitReset : now + 15 * 60_000;
  if (kind === "abuse-limit") return now + (hints.retryAfterSeconds ? hints.retryAfterSeconds * 1000 : 10 * 60_000);
  const base = kind === "network" || kind === "service-unavailable" ? 60_000 : 5 * 60_000;
  return now + Math.min(MAX_BACKOFF_MS, base * 2 ** Math.max(0, Math.min(failures, 10)));
}

export interface RateLimitState {
  remaining: number;
  /** When the hour starts again (ms since the epoch). */
  resetAt: number;
}

/** What is left of the hour allows: everything, the current branch only, or nothing until the reset. */
export function rateLimitAllows(rate: RateLimitState | null | undefined, now: number): "all" | "current" | "none" {
  if (!rate || rate.resetAt <= now) return "all";
  if (rate.remaining < CRITICAL_RATE_LIMIT) return "none";
  return rate.remaining < LOW_RATE_LIMIT ? "current" : "all";
}

export interface BranchCandidate {
  name: string;
  role: "current" | "background";
}

export interface CandidateInput {
  current: string;
  memory?: BookBranchMemory;
  /** The branches with a complete working copy on this device. */
  localCopies: ReadonlySet<string>;
  /** The heads GitHub lists, by branch. */
  listed: ReadonlyMap<string, string>;
  allows: "all" | "current" | "none";
}

/**
 * The branches a cycle looks at, in order: the current one first; then the known branches the person pinned, then the most recently used ones, up to
 * `DEFAULT_BACKGROUND_BRANCHES` (never more than `MAX_BACKGROUND_BRANCHES` with the pins), without the ones the person excluded. A background branch is
 * looked at only if it has a copy here or GitHub has it (a branch made on another device and not published yet cannot be brought here).
 */
export function selectBranchesToSync(input: CandidateInput): BranchCandidate[] {
  if (input.allows === "none") return [];
  const current: BranchCandidate = { name: input.current, role: "current" };
  if (input.allows === "current") return [current];
  const known = [...(input.memory?.knownBranches ?? [])]
    .filter((entry) => entry.name !== input.current && entry.sync !== false && (input.localCopies.has(entry.name) || input.listed.has(entry.name)))
    .sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt) || left.name.localeCompare(right.name));
  const pinned = known.filter((entry) => entry.sync === true).slice(0, MAX_BACKGROUND_BRANCHES);
  const recent = known.filter((entry) => entry.sync === undefined).slice(0, Math.max(0, Math.min(DEFAULT_BACKGROUND_BRANCHES, MAX_BACKGROUND_BRANCHES - pinned.length)));
  return [current, ...[...pinned, ...recent].map((entry) => ({ name: entry.name, role: "background" as const }))];
}

/** What one branch needs. `hold`: it would be a pull or a push that has to wait (the person is editing, the server's autopilot is running). */
export type BranchSyncAction = "none" | "pull" | "push" | "publish" | "download" | "diverged" | "gone" | "name-taken" | "hold";

export interface BranchFacts {
  hasCopy: boolean;
  /** Created on this device and not on GitHub yet: publishing makes it at this commit. */
  pendingHeadSha?: string;
  /** The commit of GitHub the copy is based on. */
  localHeadSha?: string;
  dirty: number;
  ahead: number;
  /** The head GitHub lists; `null` when GitHub does not have the branch; `undefined` when that is not known (a list GitHub cut short). */
  listedHeadSha: string | null | undefined;
}

export interface BranchDecisionContext {
  role: "current" | "background";
  /** Pushing is allowed now (not while the server's autopilot runs on the book). */
  mayPush: boolean;
  /** Pulling is allowed now (not into the branch on the screen while a page has unsaved edits). */
  mayPull: boolean;
}

/**
 * The single rule of the automatic sync: a pull only into a clean copy, a push only when GitHub did not move; GitHub moved while the copy has work →
 * `diverged`, for the person and the conflict dialog; a branch GitHub does not have is published only if it was created here, else it is `gone`, and a
 * branch created here whose name GitHub already uses for another history is `name-taken`. Nothing is ever forced or merged here.
 */
export function decideBranchAction(facts: BranchFacts, context: BranchDecisionContext): BranchSyncAction {
  if (facts.listedHeadSha === undefined) return "none";
  if (!facts.hasCopy) return context.role === "background" && facts.listedHeadSha ? "download" : "none";
  if (facts.pendingHeadSha) {
    if (facts.listedHeadSha !== null && facts.listedHeadSha !== facts.pendingHeadSha) return "name-taken";
    return context.mayPush ? "publish" : "hold";
  }
  if (facts.listedHeadSha === null) return "gone";
  const work = facts.dirty > 0 || facts.ahead > 0;
  if (facts.listedHeadSha === facts.localHeadSha) return !work ? "none" : context.mayPush ? "push" : "hold";
  if (work) return "diverged";
  return context.mayPull ? "pull" : "hold";
}

/** The outcomes the person is told of; the others (a clean pull, a clean push, publishing, a download) stay silent. */
export type BranchOutcomeKind = "synced" | "pulled" | "pushed" | "published" | "downloaded" | "held" | "busy" | "diverged" | "gone" | "name-taken" | "failed";

export function outcomeIsVisible(kind: BranchOutcomeKind): boolean {
  return kind === "diverged" || kind === "gone" || kind === "name-taken" || kind === "failed";
}
