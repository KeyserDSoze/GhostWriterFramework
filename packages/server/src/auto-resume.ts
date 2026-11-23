import type { AutopilotRestartCause } from "narrarium-engine";
import type { BookRegistry } from "./books.js";
import { atomicJson, readJson, renameReplacing } from "./files.js";

/**
 * «Resume after a restart»: when the server starts again, the runs that were going on when it stopped are resumed by themselves, for the books whose author
 * turned the option on (`options.resumeAfterRestart`). What the engine says of each book decides (`AutopilotSession.restartResumeCause`): a run the server
 * paused when it stopped (`stoppedBy: "server-shutdown"`), or one left `running` by a process that ended without pausing it; never one the author paused.
 *
 * One book at a time, `AUTO_RESUME_GAP_MS` apart, and every start goes through what a start of the author goes through (`BookRegistry.startRun`: the AI
 * configuration, the number of runs, the owner's switch and caps). A start that is refused leaves the book as it is, is said in the log and is not tried again.
 * A loop (a run that makes the server stop, again and again) is bounded: a book is resumed by itself at most `AUTO_RESUME_MAX` times in `AUTO_RESUME_WINDOW_HOURS`,
 * counted in a private file of the server that is written before each attempt; after that the run waits for the author, and its message says why.
 */

/** How many times a book is resumed by itself in `AUTO_RESUME_WINDOW_HOURS` at most. */
export const AUTO_RESUME_MAX = 3;
export const AUTO_RESUME_WINDOW_HOURS = 24;
/** The wait between a resume and the next book's: the runs do not all call the AI, and pull from GitHub, at the same moment. */
export const AUTO_RESUME_GAP_MS = 5000;

const WINDOW_MS = AUTO_RESUME_WINDOW_HOURS * 60 * 60_000;
const MAX_FILE_BYTES = 256 * 1024;
/** The resumes kept for one book: the ones of the window are all that count. */
const KEPT_PER_BOOK = AUTO_RESUME_MAX * 2;

interface Resume {
  bookId: string;
  at: string;
}

/**
 * The resumes the server made by itself, in `private/auto-resume.json`: `{ version: 1, resumes: [{ bookId, at }] }`, a list and never an object keyed by
 * book id (`readJson` refuses a file with a key like `constructor`, and an older book may be called so). Only the resumes of the last
 * `AUTO_RESUME_WINDOW_HOURS` are kept.
 */
export class AutoResumeLedger {
  private resumes: Resume[] = [];

  private constructor(private readonly file: string, private readonly now: () => Date) {}

  /**
   * The record as the file has it. A file that cannot be read is set aside (`auto-resume.json.damaged`) and the record starts from zero; `damaged` says why,
   * and the server resumes nothing by itself that time (the count it would have trusted is gone).
   */
  static async open(file: string, now: () => Date = () => new Date()): Promise<{ ledger: AutoResumeLedger; damaged?: string }> {
    const ledger = new AutoResumeLedger(file, now);
    try {
      const stored = await readJson(file, MAX_FILE_BYTES);
      if (stored === undefined) return { ledger };
      if (!stored || typeof stored !== "object" || Array.isArray(stored) || (stored as { version?: unknown }).version !== 1 || !Array.isArray((stored as { resumes?: unknown }).resumes)) {
        throw new Error("it is not a record of automatic resumes of this version");
      }
      for (const entry of (stored as { resumes: unknown[] }).resumes) {
        const { bookId, at } = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
        if (typeof bookId === "string" && bookId && bookId.length <= 120 && typeof at === "string" && at.length <= 40 && Number.isFinite(Date.parse(at))) ledger.resumes.push({ bookId, at });
      }
      return { ledger };
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200);
      const kept = await renameReplacing(file, `${file}.damaged`).then(() => true, () => false);
      return { ledger, damaged: `${reason}${kept ? "; the unreadable file was kept as auto-resume.json.damaged" : ""}` };
    }
  }

  /** The resumes of `bookId` in the window that ends now (one dated after now, by a clock that went back, counts too). */
  recent(bookId: string): number {
    const now = this.now().getTime();
    return this.resumes.filter((entry) => entry.bookId === bookId && now - Date.parse(entry.at) < WINDOW_MS).length;
  }

  /** Count one more resume of `bookId`, now, and write the record before anything else happens. Answers how many there are in the window, this one included. */
  async record(bookId: string): Promise<number> {
    const now = this.now();
    const inWindow = (entry: Resume) => now.getTime() - Date.parse(entry.at) < WINDOW_MS;
    const others = this.resumes.filter((entry) => entry.bookId !== bookId && inWindow(entry));
    const own = [...this.resumes.filter((entry) => entry.bookId === bookId && inWindow(entry)), { bookId, at: now.toISOString() }].slice(-KEPT_PER_BOOK);
    const next = [...others, ...own];
    await atomicJson(this.file, { version: 1, resumes: next });
    this.resumes = next;
    return own.length;
  }
}

/** How one book came out of the server's resume after a restart. */
export interface AutoResumeOutcome {
  bookId: string;
  cause: AutopilotRestartCause;
  /** `resumed`: the run started again; `held`: the book was resumed too often, and its run waits for the author; `refused`: a start was refused, and nothing was written to the book. */
  result: "resumed" | "held" | "refused";
  /** The resumes of the book in the window, this one included (none for a start refused before it was counted). */
  count?: number;
  /** Why it was not resumed: the code a start would have been answered with (`ai_not_configured`, `too_many_runs`, `spend_limit`, `maintenance`…), `auto_resume_limit`, or `record_unwritable`. */
  code?: string;
}

export interface AutoResumeOptions {
  books: BookRegistry;
  /** The private record of the resumes (`private/auto-resume.json`). */
  file: string;
  /** What a refusal is, as the routes answer it: its code, and what the log says of it. */
  describe: (error: unknown) => { code: string; message: string };
  /** One line of the admin log for every book that was, or was not, resumed: written before the pass goes on to the next book. Never rejects. */
  record: (entry: { bookId: string; ok: boolean; code?: string; detail: string }) => Promise<void> | void;
  log: (line: string) => void;
  /** Ends the pass: the server is stopping. A start in flight finishes (it is paused with the others). */
  signal: AbortSignal;
  gapMs?: number;
  now?: () => Date;
}

/** Wait `ms`, or less when `signal` ends it. Never rejects. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener("abort", done, { once: true });
  });
}

const why = (cause: AutopilotRestartCause): string => (cause === "server-shutdown" ? "paused when the server stopped" : "interrupted, with nobody running it");

/**
 * Resume the runs that were going on when the server stopped, one book at a time (see the top of this file). Never rejects: what happened to each book is
 * in its answer, in the log and in the admin log.
 */
export async function resumeAfterRestart(options: AutoResumeOptions): Promise<AutoResumeOutcome[]> {
  const outcomes: AutoResumeOutcome[] = [];
  try {
    await resumeBooks(options, outcomes);
  } catch (error) {
    options.log(`Autopilot: the automatic resumes after the restart stopped early: ${error instanceof Error ? error.message : String(error)}`);
  }
  return outcomes;
}

async function resumeBooks(options: AutoResumeOptions, outcomes: AutoResumeOutcome[]): Promise<void> {
  const { books, signal, log } = options;
  const gapMs = options.gapMs ?? AUTO_RESUME_GAP_MS;
  let opened: Awaited<ReturnType<typeof AutoResumeLedger.open>> | undefined;
  let started = false;
  for (const runtime of books.all()) {
    if (signal.aborted) break;
    const { bookId } = runtime.book;
    let cause: AutopilotRestartCause | null;
    try {
      cause = await runtime.session.restartResumeCause();
    } catch (error) {
      log(`Autopilot of book ${bookId}: what it was doing when the server stopped could not be read (${error instanceof Error ? error.message : String(error)}): it is not resumed by itself.`);
      continue;
    }
    if (!cause) continue;
    opened ??= await AutoResumeLedger.open(options.file, options.now);
    if (opened.damaged) {
      log(`Autopilot: the record of the automatic resumes (private/auto-resume.json) could not be read (${opened.damaged}): no autopilot is resumed by itself this time, and the record starts again from zero.`);
      break;
    }
    const { ledger } = opened;
    // A resume, then the next book: the runs do not all start at the same moment.
    if (started) await pause(gapMs, signal);
    if (signal.aborted) break;
    const recent = ledger.recent(bookId);
    if (recent >= AUTO_RESUME_MAX) {
      const held = await runtime.session.holdAfterRestart({ times: recent, hours: AUTO_RESUME_WINDOW_HOURS }).catch(() => null);
      log(`Autopilot of book ${bookId} (${why(cause)}): not resumed after the restart, it was already resumed by itself ${recent} times in the last ${AUTO_RESUME_WINDOW_HOURS} hours. ${held ? "It waits for the author, and its message says why." : "It is left as it is."}`);
      await options.record({ bookId, ok: false, code: "auto_resume_limit", detail: `${cause} ${recent}/${AUTO_RESUME_MAX}` });
      outcomes.push({ bookId, cause, result: "held", count: recent, code: "auto_resume_limit" });
      continue;
    }
    // What would refuse the start is asked before the resume is counted: a server without its AI configuration does not use up the resumes of a day.
    try {
      await books.assertStartAllowed();
    } catch (error) {
      const refusal = options.describe(error);
      log(`Autopilot of book ${bookId} (${why(cause)}): not resumed after the restart: ${refusal.message} (${refusal.code}). It is left as it is: resume it when the server can run it.`);
      await options.record({ bookId, ok: false, code: refusal.code, detail: cause });
      outcomes.push({ bookId, cause, result: "refused", code: refusal.code });
      continue;
    }
    let count: number;
    try {
      count = await ledger.record(bookId);
    } catch (error) {
      log(`Autopilot of book ${bookId} (${why(cause)}): not resumed after the restart: the record of the automatic resumes could not be written (${error instanceof Error ? error.message : String(error)}).`);
      await options.record({ bookId, ok: false, code: "record_unwritable", detail: cause });
      outcomes.push({ bookId, cause, result: "refused", code: "record_unwritable" });
      continue;
    }
    started = true;
    try {
      await books.startRun(runtime, { afterRestart: true });
    } catch (error) {
      const refusal = options.describe(error);
      log(`Autopilot of book ${bookId} (${why(cause)}): not resumed after the restart: ${refusal.message} (${refusal.code}). It is left as it is.`);
      await options.record({ bookId, ok: false, code: refusal.code, detail: `${cause} ${count}/${AUTO_RESUME_MAX}` });
      outcomes.push({ bookId, cause, result: "refused", count, code: refusal.code });
      continue;
    }
    log(`Autopilot of book ${bookId} (${why(cause)}): resumed after the restart (${count} of ${AUTO_RESUME_MAX} in ${AUTO_RESUME_WINDOW_HOURS} hours).`);
    await options.record({ bookId, ok: true, detail: `${cause} ${count}/${AUTO_RESUME_MAX}` });
    outcomes.push({ bookId, cause, result: "resumed", count });
  }
}
