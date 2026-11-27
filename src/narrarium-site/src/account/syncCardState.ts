/**
 * What the card of a service says about its sync, and whether «Sync» is the thing to do. When everything is synced the card says so, with the time of the last
 * check, and offers no primary button: «Sync» is the main action only when there is something to do (changes not sent, newer data on the service, an error).
 * A quiet «Check now» stays for the changes made on another device. Pure, so every state is held by a test.
 */
export interface SyncCardInput {
  connected: boolean;
  /** The automatic sync of this service is on. */
  enabled: boolean;
  status?: string;
  errorKind?: string;
  /** This device has changes that have not reached every service. */
  localDirty: boolean;
  /** When the service was last asked and answered (ISO). */
  lastCheck?: string;
}

export type SyncCardState =
  | { kind: "not-connected" }
  /** The sync of this service is off: nothing runs by itself. */
  | { kind: "off" }
  | { kind: "syncing" }
  /** The sign-in ended: the sign-in panel has the one action. */
  | { kind: "sign-in" }
  | { kind: "offline" }
  | { kind: "error" }
  | { kind: "pending"; reason: "local-changes" | "remote-newer" | "different-copies" | "never-synced" }
  | { kind: "all-synced"; lastCheck: string };

export function syncCardState(input: SyncCardInput): SyncCardState {
  if (!input.connected) return { kind: "not-connected" };
  if (!input.enabled) return { kind: "off" };
  if (input.status === "syncing") return { kind: "syncing" };
  if (input.status === "needs-auth" || input.errorKind === "credential-expired" || input.errorKind === "credential-missing") return { kind: "sign-in" };
  if (input.status === "offline") return { kind: "offline" };
  if (input.status === "error") return { kind: "error" };
  if (input.status === "behind") return { kind: "pending", reason: "remote-newer" };
  if (input.status === "diverged") return { kind: "pending", reason: "different-copies" };
  if (input.status === "dirty" || input.status === "ahead" || input.localDirty) return { kind: "pending", reason: "local-changes" };
  if (!input.lastCheck) return { kind: "pending", reason: "never-synced" };
  return { kind: "all-synced", lastCheck: input.lastCheck };
}

/** The main action of the card: «Sync» when there is something to send or receive, «Try again» after an error, nothing when all is synced or the sign-in comes first. */
export function primarySyncAction(state: SyncCardState): "sync" | "try-again" | null {
  if (state.kind === "pending") return "sync";
  if (state.kind === "error") return "try-again";
  return null;
}

/** Whether the quiet «Check now» is offered: the service is on, signed in and not already syncing. */
export function canCheckNow(state: SyncCardState): boolean {
  return state.kind === "all-synced" || state.kind === "pending" || state.kind === "error" || state.kind === "offline";
}
