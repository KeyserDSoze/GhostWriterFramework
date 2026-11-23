/**
 * The failures that mean "the sign-in has to be renewed by the owner", whatever library reported them.
 *
 * MSAL renews a Microsoft token in a hidden iframe and falls back to a window; when the browser blocks the iframe (a
 * third-party cookie, a frame policy) or the account needs the owner, it ends with one of the codes below. Google's
 * sign-in reports the equivalent when its window is closed or the access is refused. None of them is a fault of the
 * data or of the network: the next step is always to sign in again, so they are all treated as one class.
 */

export const MICROSOFT_RENEWAL_CODES = [
  "timed_out",
  "monitor_window_timeout",
  "interaction_required",
  "login_required",
  "consent_required",
  "no_account_error",
  "no_account_in_silent_request",
  "block_iframe_reload",
  "user_cancelled",
  "popup_window_error",
  "empty_window_error",
  "silent_sso_error",
] as const;

export const GOOGLE_RENEWAL_CODES = ["popup_closed", "popup_closed_by_user", "access_denied"] as const;

const RENEWAL_CODES: readonly string[] = [...MICROSOFT_RENEWAL_CODES, ...GOOGLE_RENEWAL_CODES];

/** The code of the first sign-in failure the error carries, or undefined when it is not one. */
export function signInRenewalCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { errorCode?: unknown; subError?: unknown; error?: unknown; type?: unknown; message?: unknown };
  for (const candidate of [value.errorCode, value.subError, value.error, value.type]) {
    if (typeof candidate === "string" && RENEWAL_CODES.includes(candidate.toLowerCase())) return candidate.toLowerCase();
  }
  // MSAL writes its message as "<code>: <description>"; an older error may carry only the text.
  if (typeof value.message === "string") {
    const text = value.message.toLowerCase();
    for (const code of RENEWAL_CODES) {
      if (new RegExp(`(?:^|[\\s:(])${code}(?:[\\s:).,]|$)`).test(text)) return code;
    }
  }
  return undefined;
}

export function requiresSignInRenewal(error: unknown): boolean {
  return signInRenewalCode(error) !== undefined;
}

/** The message with the "See https://aka.ms/… for details" pointer of MSAL taken out: the code stays, the address does not. */
export function withoutHelpLinks(message: string): string {
  return message.replace(/[:.]?\s*See https?:\/\/\S+ for details\.?/gi, "").replace(/\s+/g, " ").trim();
}
