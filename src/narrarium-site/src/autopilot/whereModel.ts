import { isHandoverOver, type HandoverPlan, type HandoverRequest, type HandoverSide } from "@/autopilot/handover";

/** What the card of "Where it runs" knows of the places: whether this device has a server that proved who it is. */
export type WhereServer = "ready" | "disabled" | "unverified";

/**
 * Why a way of passing the book to the other side is not open now. Each reason is said in words next to the button it disables, and the one that has an action
 * says which (`github-consent`: tick the consent; the others are cleared by waiting, or by a link to the settings of the server).
 */
export type WhereBlocker = "busy" | "no-server" | "unverified" | "github-consent";

/** What the primary button does: it moves the book at once (nothing runs), or makes the plan that passes it when the step ends, now, or for one step. */
export type WhereMode = "move" | "after-step" | "now" | "step";

export interface WhereMoveInput {
  /** The side chosen with the radios. */
  choice: HandoverSide;
  /** Where the autopilot of the book runs now. */
  host: HandoverSide;
  /** The autopilot of the book is running (here or on the server). */
  running: boolean;
  /** An operation of the book is in progress (a move, a sync, a start…): nothing else is started. */
  busy: boolean;
  /** The plan to pass the book to the other side, when there is one. */
  plan: HandoverPlan | null;
  server: WhereServer;
  /** The book is on GitHub. */
  github: boolean;
  /** The author agrees to send the GitHub token of the book with it. */
  consentGithub: boolean;
  /** The server already holds the GitHub token of the book. */
  serverHasGithubToken: boolean;
  /**
   * The author chose the server's own GitHub connection for the book (and the server says it is connected): no copy of the token is sent, so the book needs no consent for it.
   * Absent: the book signs in with a token that was sent, as it always did.
   */
  githubConnection?: boolean;
  /** What the quick command that opened the card asked for (the side, and when). */
  intent: HandoverRequest | null;
}

export interface WhereMove {
  /** What the primary button does; `null` when the side chosen is where the book already runs (there is nothing to pass). */
  mode: WhereMode | null;
  /** The plan that waits or goes on (never one that is over): the card says where it is, and offers to take it back while it can be. */
  plan: HandoverPlan | null;
  /** Why the primary button is disabled; `null` when it is not. */
  blocker: WhereBlocker | null;
}

/** The plan that still goes on: one that ended (done or failed) is told by the band, and does not hold the card. */
export function activePlan(plan: HandoverPlan | null | undefined): HandoverPlan | null {
  return plan && !isHandoverOver(plan) ? plan : null;
}

/**
 * The state of the way to the other side for the side chosen with the radios. A run that goes on is passed by a plan (after the step by default, now or for one step when
 * the quick command that opened the card asked for it), which is what the card finishes; a book that is stopped is moved at once. Whatever disables the button is a
 * `blocker`, and there is always one when it is disabled. Coming back from a server that cannot be reached is not blocked: the move tells what failed, and the card offers to leave without the server's work.
 */
export function whereMove(input: WhereMoveInput): WhereMove {
  const plan = activePlan(input.plan);
  if (input.choice === input.host) return { mode: null, plan, blocker: null };
  const toServer = input.choice === "server";
  const intent = input.intent?.to === input.choice ? input.intent : null;
  const mode: WhereMode = !input.running ? "move" : intent?.when === "now" ? "now" : toServer && intent?.returnAfterSteps ? "step" : "after-step";
  if (plan) return { mode, plan, blocker: null };
  return { mode, plan: null, blocker: blockerOf(input, toServer, mode) };
}

function blockerOf(input: WhereMoveInput, toServer: boolean, mode: WhereMode): WhereBlocker | null {
  if (input.busy) return "busy";
  // A plan checks the server before it pauses anything, so a run that goes on needs it either way; a book that is stopped and comes back tries, and says what failed.
  if (toServer || mode !== "move") {
    if (input.server === "disabled") return "no-server";
    if (input.server === "unverified") return "unverified";
  }
  if (toServer && input.github && !input.githubConnection && !input.consentGithub && !input.serverHasGithubToken) return "github-consent";
  return null;
}

/** Why the radios are disabled: only while an operation of the book is in progress. A run that goes on does not disable them (the way to pass it is the card's). */
export function radiosBlocker(input: Pick<WhereMoveInput, "busy">): "busy" | null {
  return input.busy ? "busy" : null;
}

/** Why "Sync now" (a book that runs on the server) is disabled, in the same words as the move. */
export function syncBlocker(input: Pick<WhereMoveInput, "busy" | "server">): WhereBlocker | null {
  if (input.busy) return "busy";
  if (input.server === "disabled") return "no-server";
  if (input.server === "unverified") return "unverified";
  return null;
}
