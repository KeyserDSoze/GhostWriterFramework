import type { CredentialMode } from "@/account/credentialMode";

/**
 * How a failed sync is told on the card of a service: a sign-in that has to be renewed (or is not on this device) is one sentence and one action, with the
 * reason that matches how the connection was made; anything else keeps the sentence of its kind. Pure, so every case is held by a test.
 */
export type SignInEndedWhy =
  /** Session credentials: they last about an hour (Google) or a day (Microsoft) and have ended. */
  | "session"
  /** Long-lived credentials that the service refused, or that this device no longer has: the sign-in has to be made again. */
  | "long-lived"
  /** Nothing is saved on this device for the service. */
  | "missing";

export type SyncErrorView =
  | { kind: "sign-in-again"; why: SignInEndedWhy; /** Session credentials and a proxy that serves the service: the switch to long-lived ones is offered. */ offerLongLived: boolean }
  | { kind: "other" };

const SIGN_IN_KINDS = new Set(["credential-missing", "credential-expired"]);

export function syncErrorView(input: { errorKind?: string; status?: string; mode: CredentialMode | null; brokerAvailable: boolean | null }): SyncErrorView {
  const needsSignIn = input.status === "needs-auth" || (input.errorKind !== undefined && SIGN_IN_KINDS.has(input.errorKind));
  if (!needsSignIn) return { kind: "other" };
  if (input.errorKind === "credential-missing" && input.mode === null) return { kind: "sign-in-again", why: "missing", offerLongLived: false };
  if (input.mode === "session") return { kind: "sign-in-again", why: "session", offerLongLived: input.brokerAvailable === true };
  return { kind: "sign-in-again", why: input.errorKind === "credential-missing" ? "missing" : "long-lived", offerLongLived: false };
}
