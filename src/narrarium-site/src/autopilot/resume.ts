/**
 * «Resume by itself after a restart» for the autopilot that runs in this browser. The run lives in the page: a reload, an update of the app, a
 * browser that is closed or crashes ends it without a word (no worker can keep it alive with the page closed). So this device remembers, for each
 * book and account, that it was running the autopilot (the intent), from the moment the author starts it until the run ends by itself, is paused
 * or stopped by the author, or moves to the personal server; when the app starts again with an intent still there, the tab that gets the book's
 * lock resumes the run, which goes on from what the book saved (a step is saved whole or not at all, so nothing is written twice).
 *
 * Pure decisions and the few bytes of this device's storage: the runtime does the rest.
 */

const INTENTS_KEY = "narrarium.autopilot.resume.v1";
const OFF_KEY = "narrarium.autopilot.autoResumeOff.v1";
const LOG_KEY = "narrarium.autopilot.resumeLog.v1";

/** At most this many automatic resumes of a book within the window: a run that keeps dying is left to the author, who is told so. */
export const RESUME_LIMIT = { times: 3, windowMs: 10 * 60 * 1000 } as const;

export interface ResumeIntent {
  bookId: string;
  /** The account (repository scope) the run belongs to: another account in the same browser never resumes it. */
  scope: string;
  /** When the author started the run (or the app resumed it). */
  since: string;
  /** The title of the last step the run began, to say what it was doing. */
  step?: string;
}

type IntentFile = { version: 1; intents: Record<string, ResumeIntent> };

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readJson<T>(store: Storage | null, key: string, fallback: T): T {
  try {
    const raw = store?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(store: Storage | null, key: string, value: unknown): void {
  try {
    store?.setItem(key, JSON.stringify(value));
  } catch {
    // A browser that refuses the storage resumes nothing: the run is the same, the author starts it again.
  }
}

const keyOf = (scope: string, bookId: string) => `${scope}::${bookId}`;

function readIntents(store: Storage | null): IntentFile {
  const file = readJson<Partial<IntentFile>>(store, INTENTS_KEY, {});
  return { version: 1, intents: file && typeof file.intents === "object" && file.intents ? file.intents : {} };
}

/** This browser runs the autopilot of the book now (the author started it, or the app resumed it): remembered until the run ends. */
export function rememberRun(intent: ResumeIntent, store: Storage | null = storage()): void {
  const file = readIntents(store);
  file.intents[keyOf(intent.scope, intent.bookId)] = intent;
  writeJson(store, INTENTS_KEY, file);
}

/** The step the run began, kept with the intent: what the notice says the run was doing when it is resumed. */
export function rememberStep(scope: string, bookId: string, step: string, store: Storage | null = storage()): void {
  const file = readIntents(store);
  const intent = file.intents[keyOf(scope, bookId)];
  if (!intent || intent.step === step) return;
  file.intents[keyOf(scope, bookId)] = { ...intent, step };
  writeJson(store, INTENTS_KEY, file);
}

/** The run ended by itself, was paused or stopped by the author, or moved to the personal server: nothing is left to resume. */
export function forgetRun(scope: string, bookId: string, store: Storage | null = storage()): void {
  const file = readIntents(store);
  if (!file.intents[keyOf(scope, bookId)]) return;
  delete file.intents[keyOf(scope, bookId)];
  writeJson(store, INTENTS_KEY, file);
}

/** The runs of an account that this browser was running when the page ended. */
export function interruptedRuns(scope: string, store: Storage | null = storage()): ResumeIntent[] {
  return Object.values(readIntents(store).intents).filter((intent) => intent && intent.scope === scope && typeof intent.bookId === "string");
}

/** Whether the autopilot of the book resumes by itself in this browser: on unless the author turned it off for this book on this device. */
export function autoResumeOn(bookId: string, store: Storage | null = storage()): boolean {
  const off = readJson<unknown>(store, OFF_KEY, []);
  return !(Array.isArray(off) && off.includes(bookId));
}

export function setAutoResume(bookId: string, on: boolean, store: Storage | null = storage()): void {
  const current = readJson<unknown>(store, OFF_KEY, []);
  const off = new Set(Array.isArray(current) ? current.filter((entry): entry is string => typeof entry === "string") : []);
  if (on) off.delete(bookId);
  else off.add(bookId);
  writeJson(store, OFF_KEY, [...off]);
}

/** The automatic resumes of the book still within the window, and the record with the one made now. */
export function resumesWithin(stamps: readonly number[], now: number): number[] {
  return stamps.filter((stamp) => Number.isFinite(stamp) && stamp <= now && now - stamp < RESUME_LIMIT.windowMs);
}

export function recentResumes(scope: string, bookId: string, now: number, store: Storage | null = storage()): number[] {
  const log = readJson<Record<string, unknown>>(store, LOG_KEY, {});
  const stamps = log[keyOf(scope, bookId)];
  return resumesWithin(Array.isArray(stamps) ? stamps.filter((stamp): stamp is number => typeof stamp === "number") : [], now);
}

export function noteResume(scope: string, bookId: string, now: number, store: Storage | null = storage()): void {
  const log = readJson<Record<string, unknown>>(store, LOG_KEY, {});
  log[keyOf(scope, bookId)] = [...recentResumes(scope, bookId, now, store), now];
  writeJson(store, LOG_KEY, log);
}

/** Why a run that was interrupted is not resumed now (`wait`: it is, later, by itself; `skip`: the author is told, and acts). */
export type ResumeWait = "offline" | "settings";
export type ResumeSkip = "off" | "server" | "missing" | "not-interrupted" | "other-runner" | "other-tab" | "no-working-copy" | "no-ai" | "crash-loop";

export type ResumeDecision =
  | { kind: "resume" }
  | { kind: "wait"; reason: ResumeWait }
  | { kind: "skip"; reason: ResumeSkip; forget: boolean };

export interface ResumeFacts {
  /** The book is in the library of the account, and where its autopilot runs. */
  host: "browser" | "server" | null;
  autoResume: boolean;
  online: boolean;
  /** The settings of the account are loaded (the AI configuration with them). */
  settingsReady: boolean;
  /** What the book's state says now: nothing when it has none (or it cannot be read). */
  state: { status: string; ownRunner: boolean } | null;
  /** Another tab of this browser holds the book (its run goes on there). */
  heldElsewhere: boolean;
  workingCopy: boolean;
  /** The AI the run needs is configured, with its credentials. */
  aiReady: boolean;
  /** Automatic resumes of the book within the window. */
  resumes: number;
}

/**
 * Whether the interrupted run of a book is resumed now. Never a run the author paused or stopped (its intent is gone, and its state is not
 * `running` any more), nor one that ended by itself, nor one another tab or host runs; it waits while the device is offline or the settings are
 * not loaded yet; it is left to the author, with the reason, when its working copy or its AI is missing, or after `RESUME_LIMIT` resumes in the
 * window. `forget`: the intent goes (there is nothing to resume any more); otherwise it stays, and a later start of the app looks again.
 */
export function decideResume(facts: ResumeFacts): ResumeDecision {
  if (facts.host === null) return { kind: "skip", reason: "missing", forget: true };
  if (facts.host === "server") return { kind: "skip", reason: "server", forget: true };
  if (!facts.autoResume) return { kind: "skip", reason: "off", forget: true };
  if (facts.heldElsewhere) return { kind: "skip", reason: "other-tab", forget: false };
  if (!facts.online) return { kind: "wait", reason: "offline" };
  if (!facts.settingsReady) return { kind: "wait", reason: "settings" };
  if (!facts.workingCopy) return { kind: "skip", reason: "no-working-copy", forget: false };
  if (!facts.state || facts.state.status !== "running") return { kind: "skip", reason: "not-interrupted", forget: true };
  if (!facts.state.ownRunner) return { kind: "skip", reason: "other-runner", forget: true };
  if (!facts.aiReady) return { kind: "skip", reason: "no-ai", forget: false };
  if (facts.resumes >= RESUME_LIMIT.times) return { kind: "skip", reason: "crash-loop", forget: true };
  return { kind: "resume" };
}
