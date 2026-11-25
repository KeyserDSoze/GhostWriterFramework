/**
 * Errors of the connect flows (Google authorization code, Microsoft sign-in window), with fixed texts: they never
 * carry a code, a state, a verifier or a token. `describeConnectError` turns them, and the broker's errors, into
 * the sentences the page shows.
 */
import type { TFunction } from "i18next";
import { BrokerError } from "@/account/credentialBroker";
import { signInRenewalCode } from "@/account/signInRenewal";

export type ConnectFlowErrorCode =
  | "unsupported"
  | "popup_blocked"
  /** The app itself stopped waiting (the user pressed Cancel, or started another sign-in). */
  | "cancelled"
  /** Microsoft reported that the user declined or closed the sign-in. */
  | "access_denied"
  | "timed_out"
  | "state_mismatch"
  | "provider_error"
  | "invalid_response"
  | "wrong_account";

const MESSAGES: Record<ConnectFlowErrorCode, string> = {
  unsupported: "This browser cannot run the secure sign-in.",
  popup_blocked: "The browser blocked the sign-in window.",
  cancelled: "The sign-in was cancelled.",
  access_denied: "The sign-in was cancelled or declined.",
  timed_out: "The sign-in took too long.",
  state_mismatch: "The sign-in answer did not match the request.",
  provider_error: "The provider refused the sign-in.",
  invalid_response: "The provider's answer was not usable.",
  wrong_account: "A different account was chosen than the one connected.",
};

export class ConnectFlowError extends Error {
  readonly code: ConnectFlowErrorCode;
  /** A plain provider error code such as "invalid_scope", when there was one. */
  readonly providerError?: string;

  constructor(code: ConnectFlowErrorCode, message?: string, details: { providerError?: string } = {}) {
    super(message ?? MESSAGES[code]);
    this.name = "ConnectFlowError";
    this.code = code;
    if (details.providerError) this.providerError = details.providerError;
  }
}

/** The text for the page, or null for what needs no message (the user cancelled) or is already readable as it is. */
export function describeConnectError(error: unknown, t: TFunction): string | null {
  if (error instanceof ConnectFlowError) {
    switch (error.code) {
      case "cancelled": return null;
      case "unsupported": return t("accountSync.connectError.unsupported");
      case "popup_blocked": return t("accountSync.connectError.popupBlocked");
      case "access_denied": return t("accountSync.connectError.denied");
      case "timed_out": return t("accountSync.connectError.timedOut");
      case "state_mismatch": return t("accountSync.connectError.stateMismatch");
      case "provider_error": return t("accountSync.connectError.providerError", { code: error.providerError ?? "unknown" });
      case "invalid_response": return t("accountSync.connectError.invalidResponse");
      case "wrong_account": return t("accountSync.connectError.wrongAccount");
    }
  }
  if (error instanceof BrokerError) {
    if (error.code === "invalid_grant") return t("accountSync.connectError.codeRejected");
    if (error.code === "rate_limited") return t("accountSync.connectError.rateLimited");
    if (error.code === "upstream" && error.providerDetail) return t("accountSync.connectError.providerRefused", { detail: error.providerDetail });
    return t("accountSync.connectError.brokerUnavailable");
  }
  return null;
}

/**
 * The text for an interactive sign-in of Microsoft (MSAL) or Google (the sign-in window) that did not end: the window was
 * closed, blocked or timed out, or the access was refused. The code stays in the sentence as its detail; nothing else of the
 * library's message (its help address, its stack) reaches the page. Null when the error is not one of these.
 */
export function describeSignInFailure(error: unknown, backend: "google-drive" | "onedrive", t: TFunction): string | null {
  const code = signInRenewalCode(error);
  if (!code) return null;
  return t(backend === "onedrive" ? "accountSync.connectError.renewMicrosoft" : "accountSync.connectError.renewGoogle", { code });
}
