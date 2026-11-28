import type { AutopilotMessageCode, AutopilotStatus } from "narrarium-engine";
import i18n from "@/i18n";
import type { PauseCommand } from "@/autopilot/quickControls";

/** The two places the autopilot of a book can run. */
export type HandoverSide = "browser" | "server";

/** When the book changes hands: after the step that is running (the default), or now (the step in flight is abandoned and done again on the other side). */
export type HandoverWhen = "after-step" | "now";

/**
 * Where a handover is. `armed`: it waits for the step that is running to end (the pause is asked for, and it can still be taken back).
 * `pausing`: the run is being stopped. `moving`: the files of the book travel to the other side. `starting`: the autopilot starts there.
 * `running-there`: it goes on there for the steps it was asked, and will come back. `returning`: the book comes back. `done` and `failed` are the end.
 */
export type HandoverPhase = "armed" | "pausing" | "moving" | "starting" | "running-there" | "returning" | "done" | "failed";

/** A plan to move the autopilot of one book to the other side: an intention that lives in this tab, one for each book. */
export interface HandoverPlan {
  to: HandoverSide;
  when: HandoverWhen;
  /** Run this many steps on the other side, and then bring the book back and go on here. */
  returnAfterSteps?: number;
  phase: HandoverPhase;
  /** Why it failed, in the language of the app. */
  error?: string;
}

/**
 * What the author agrees to send to the server when the book moves there. It is given by the author in the flow of "Where it runs", on the button that makes the plan:
 * the quick commands never give it, and it is sent when the book moves (after the step), never before, so that a plan that is taken back has sent nothing.
 */
export interface HandoverConsent {
  sendAiConfiguration: boolean;
  sendGitHubToken: boolean;
}

/** What the author asks for. */
export interface HandoverRequest {
  to: HandoverSide;
  /** `after-step` when it is not said. */
  when?: HandoverWhen;
  returnAfterSteps?: number;
  /** For a move to the server: what the author consents to send. Without it the server must already have what a run needs, and the plan is refused when it does not. */
  consent?: HandoverConsent;
}

/** The phases in which nothing more happens to the plan: it is over, or it has failed. */
export function isHandoverOver(plan: Pick<HandoverPlan, "phase"> | null | undefined): boolean {
  return plan?.phase === "done" || plan?.phase === "failed";
}

/** The plan can still be taken back: nothing has been moved, and the pause it asked for can be cancelled. */
export function isHandoverCancellable(plan: Pick<HandoverPlan, "phase"> | null | undefined): boolean {
  return plan?.phase === "armed";
}

export type HandoverRefusal = "already-there" | "in-progress" | "not-controllable";

/** The plan is not made: the book is not where the author thinks, or something else holds it. Says why, in the language of the app. */
export class HandoverRefusedError extends Error {
  constructor(readonly reason: HandoverRefusal) {
    super(i18n.t(`autopilot.quick.handover.refused.${reason}`));
    this.name = "HandoverRefusedError";
  }
}

/**
 * The move to the server needs what only the author can give: the AI configuration or the GitHub token of the book are not on the
 * server, and a handover never sends a secret by itself. The existing flow of "Where it runs" asks for the consent.
 */
export class HandoverConsentError extends Error {
  readonly code = "consent-missing";
  constructor(readonly missing: "ai" | "github") {
    super(i18n.t(`autopilot.quick.handover.consent.${missing}`));
    this.name = "HandoverConsentError";
  }
}

export function isHandoverConsentError(error: unknown): error is HandoverConsentError {
  return error instanceof Error && (error as { code?: unknown }).code === "consent-missing";
}

/** What a fresh look at the run of the book says: whether it runs, whether this client can command it, and the pause that waits. */
export interface RunInspection {
  running: boolean;
  controllable: boolean;
  pausePending: "after-step" | "after-chapter" | null;
}

/** How the run ended: the status the book was left in, the message it ended with (none when it paused because the author asked), and the reason the engine gave when it gave one. */
export interface RunOutcome {
  status: AutopilotStatus | null;
  message: string | null;
  code?: AutopilotMessageCode;
}

/** What a plan needs from its surroundings: the browser's runtime in the app, fakes in the tests. */
export interface HandoverPorts {
  /** Where the autopilot of the book is hosted now. */
  hostOf(bookId: string): HandoverSide;
  /** Throws, with a message that says what, when another operation of the author's holds the book (a move, a sync, a start…). */
  assertFree(bookId: string): void;
  /** A fresh look at the run. It throws when the run cannot be seen (a server that cannot be reached): it is never taken for stopped. */
  inspect(bookId: string): Promise<RunInspection>;
  /**
   * Check, before anything is paused, that the book can go to `to`: the server is reachable and verified, it has the AI configuration and
   * the GitHub token a run needs (a handover never sends a secret by itself), and, when the run there is limited, it keeps the limit.
   */
  prepareMove(bookId: string, to: HandoverSide, options: { limits: boolean; consent?: HandoverConsent }): Promise<void>;
  pause(bookId: string, mode: PauseCommand): Promise<void>;
  /** Resolves when the run of the book has ended, however it ended; `since` is when the plan began asking for it. Rejects when `signal` aborts, or when the run cannot be watched. */
  waitUntilStopped(bookId: string, signal: AbortSignal, since: number): Promise<RunOutcome>;
  /** Move the files of the book and make `to` its host, sending what the author consented to. It throws, and the book stays where it was, when it cannot. */
  move(bookId: string, to: HandoverSide, consent?: HandoverConsent): Promise<void>;
  start(bookId: string, options?: { limits?: { steps: number } }): Promise<void>;
  /** What the screen shows of the plan of the book; `null` when there is none. */
  publish(bookId: string, plan: HandoverPlan | null): void;
  describeError(error: unknown): string;
}

export interface HandoverOptions {
  /** How long a plan that is done stays on show (milliseconds). */
  doneVisibleMs?: number;
  now?: () => number;
}

const DEFAULT_DONE_VISIBLE_MS = 6000;

interface HandoverEntry {
  plan: HandoverPlan;
  controller: AbortController;
  /** The plan asked for the pause that waits: it is the plan that takes it back when it is cancelled. */
  askedPause: boolean;
  /** The pause the author had asked for before the plan (`after-chapter` is less strict than the plan's own, and has to be asked again). */
  pausedBefore: "after-step" | "after-chapter" | null;
  /** What the author consented to send when the book moves to the server. */
  consent?: HandoverConsent;
  finished: Promise<HandoverPlan>;
  timer?: ReturnType<typeof setTimeout>;
}

/** The pause that ended the run was the one the author asked for: it left no message and no reason. Anything else is a stop that only the author settles. */
function endedByRequestedPause(outcome: RunOutcome): boolean {
  return outcome.status === "paused" && !outcome.message && !outcome.code;
}

/** A wait that was abandoned: the plan was taken back. (A `DOMException` is not always an `Error` here, so the name is what counts.) */
const isAbort = (error: unknown): boolean => typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";

/**
 * The plans to move the autopilot of a book to the other side (browser ↔ personal server), one for each book. A plan is an intention, not
 * a lock: it holds nothing of the book while it waits for the step to end, and the operations that touch the files (moving, starting)
 * take their own turn. It never leaves two runs at once (the book moves only after the run here has ended), and whatever goes wrong leaves
 * the book stopped, where it is, with the reason on the plan. It starts the autopilot on the other side only when it ran before, or
 * when the author asked for the step there.
 */
export class HandoverCoordinator {
  private readonly entries = new Map<string, HandoverEntry>();
  private readonly arming = new Set<string>();

  constructor(private readonly ports: HandoverPorts, private readonly options: HandoverOptions = {}) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** The plan of the book, or `null`. */
  plan(bookId: string): HandoverPlan | null {
    const entry = this.entries.get(bookId);
    return entry ? { ...entry.plan } : null;
  }

  /** Resolves, with the plan as it ended, when the plan of the book is over (done or failed); `null` when there is none, or it was taken back. */
  finished(bookId: string): Promise<HandoverPlan> | null {
    return this.entries.get(bookId)?.finished ?? null;
  }

  /**
   * Make the plan, ask the run to pause, and let the plan go on by itself. It resolves once the plan is armed; a request that cannot be
   * made (the book is already there, another operation holds it, the server cannot take it) is refused before anything is paused.
   */
  async arm(bookId: string, request: HandoverRequest): Promise<void> {
    const existing = this.entries.get(bookId);
    if ((existing && !isHandoverOver(existing.plan)) || this.arming.has(bookId)) throw new HandoverRefusedError("in-progress");
    const from = this.ports.hostOf(bookId);
    if (from === request.to) throw new HandoverRefusedError("already-there");
    this.ports.assertFree(bookId);
    this.arming.add(bookId);
    try {
      const when: HandoverWhen = request.when === "now" ? "now" : "after-step";
      const returnAfterSteps = Number.isSafeInteger(request.returnAfterSteps) && (request.returnAfterSteps ?? 0) > 0 ? request.returnAfterSteps : undefined;
      const inspection = await this.ports.inspect(bookId);
      if (inspection.running && !inspection.controllable) throw new HandoverRefusedError("not-controllable");
      const consent = request.to === "server" ? request.consent : undefined;
      await this.ports.prepareMove(bookId, request.to, { limits: returnAfterSteps !== undefined, ...(consent ? { consent } : {}) });
      if (returnAfterSteps !== undefined) await this.ports.prepareMove(bookId, from, { limits: false });

      const since = this.now();
      let askedPause = false;
      if (inspection.running) {
        if (when === "now") {
          await this.ports.pause(bookId, "now");
        } else if (inspection.pausePending !== "after-step") {
          await this.ports.pause(bookId, "after-step");
          askedPause = true;
        }
      }
      if (existing) this.forget(bookId, existing);
      const plan: HandoverPlan = {
        to: request.to,
        when,
        ...(returnAfterSteps !== undefined ? { returnAfterSteps } : {}),
        phase: inspection.running ? (when === "now" ? "pausing" : "armed") : "moving",
      };
      const entry: HandoverEntry = { plan, controller: new AbortController(), askedPause, pausedBefore: inspection.pausePending, ...(consent ? { consent } : {}), finished: Promise.resolve(plan) };
      this.entries.set(bookId, entry);
      this.ports.publish(bookId, { ...plan });
      entry.finished = this.drive(bookId, entry, { from, wasRunning: inspection.running, since });
    } finally {
      this.arming.delete(bookId);
    }
  }

  /** Take the plan back, while it only waits for the step to end: the pause it asked for is taken back too. `false` when it cannot be (the book is already on its way). */
  async cancel(bookId: string): Promise<boolean> {
    const entry = this.entries.get(bookId);
    if (!entry || !isHandoverCancellable(entry.plan)) return false;
    entry.controller.abort();
    this.forget(bookId, entry);
    this.ports.publish(bookId, null);
    if (entry.askedPause) {
      await this.ports.pause(bookId, "cancel").catch(() => undefined);
      if (entry.pausedBefore === "after-chapter") await this.ports.pause(bookId, "after-chapter").catch(() => undefined);
    }
    return true;
  }

  /** Close a plan that is over (the author read how it ended). A plan that goes on is not closed. */
  dismiss(bookId: string): void {
    const entry = this.entries.get(bookId);
    if (!entry || !isHandoverOver(entry.plan)) return;
    this.forget(bookId, entry);
    this.ports.publish(bookId, null);
  }

  private forget(bookId: string, entry: HandoverEntry): void {
    if (entry.timer) clearTimeout(entry.timer);
    if (this.entries.get(bookId) === entry) this.entries.delete(bookId);
  }

  /** Change what the plan says and show it. A plan that was taken back, or replaced, says nothing more. */
  private set(bookId: string, entry: HandoverEntry, patch: Partial<HandoverPlan>): void {
    if (this.entries.get(bookId) !== entry) return;
    const next = { ...entry.plan, ...patch };
    if (next.phase === entry.plan.phase && next.error === entry.plan.error) return;
    entry.plan = next;
    this.ports.publish(bookId, { ...entry.plan });
  }

  private async drive(bookId: string, entry: HandoverEntry, context: { from: HandoverSide; wasRunning: boolean; since: number }): Promise<HandoverPlan> {
    const { signal } = entry.controller;
    const { to, returnAfterSteps } = entry.plan;
    try {
      // Whether the autopilot goes on on the other side: it does only if the author's pause is what stopped it here.
      let resume = false;
      if (context.wasRunning) {
        const outcome = await this.ports.waitUntilStopped(bookId, signal, context.since);
        if (signal.aborted) return entry.plan;
        resume = endedByRequestedPause(outcome);
      }
      this.set(bookId, entry, { phase: "moving" });
      await this.ports.move(bookId, to, entry.consent);
      if (resume || returnAfterSteps !== undefined) {
        this.set(bookId, entry, { phase: "starting" });
        const since = this.now();
        await this.ports.start(bookId, returnAfterSteps !== undefined ? { limits: { steps: returnAfterSteps } } : undefined);
        // The pause at the end of the chapter that the author asked for belongs to the run, which is another one now.
        if (entry.pausedBefore === "after-chapter") await this.ports.pause(bookId, "after-chapter").catch(() => undefined);
        if (returnAfterSteps !== undefined) {
          this.set(bookId, entry, { phase: "running-there" });
          const there = await this.ports.waitUntilStopped(bookId, new AbortController().signal, since);
          this.set(bookId, entry, { phase: "returning" });
          await this.ports.move(bookId, context.from);
          // It goes on here only if it stopped at the limit, and only if it was running before: a question, an error or a complete book wait for the author.
          if (resume && there.code === "stepLimit") await this.ports.start(bookId);
        }
      }
      this.set(bookId, entry, { phase: "done" });
      entry.timer = setTimeout(() => this.dismiss(bookId), this.options.doneVisibleMs ?? DEFAULT_DONE_VISIBLE_MS);
    } catch (error) {
      if (!(signal.aborted && isAbort(error))) this.set(bookId, entry, { phase: "failed", error: this.ports.describeError(error) });
    }
    return entry.plan;
  }
}
