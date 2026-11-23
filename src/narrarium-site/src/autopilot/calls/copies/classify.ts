import { AccountCredentialError } from "@/account/connectionStore";
import { BrokerError } from "@/account/credentialBroker";
import { requiresSignInRenewal } from "@/account/signInRenewal";
import { CopyError } from "./types";

/** An HTTP answer that was not a success: the status, and how long the service asked to wait (`Retry-After`), when it did. */
export class CopyHttpError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = "CopyHttpError";
  }
}

/** The seconds of a `Retry-After` header, or of GitHub's `x-ratelimit-reset` (an epoch time), in milliseconds. */
export function retryAfterOf(headers: { get?(name: string): string | null } | Record<string, unknown> | undefined, now = Date.now()): number | undefined {
  if (!headers) return undefined;
  const read = (name: string): string | undefined => {
    if (typeof (headers as { get?: unknown }).get === "function") return (headers as { get(name: string): string | null }).get(name) ?? undefined;
    const value = (headers as Record<string, unknown>)[name];
    return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  };
  const after = Number(read("retry-after"));
  if (Number.isFinite(after) && after > 0) return Math.min(after, 3600) * 1000;
  const reset = Number(read("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) return Math.min(Math.max(reset * 1000 - now, 1000), 3_600_000);
  return undefined;
}

/**
 * Turns whatever a provider, a token or the network threw into the code the page words. A sign-in that has to be renewed (the earlier work of the account
 * sync: `AccountCredentialError`, MSAL's and Google's codes, the broker's refusal) and a 401 are `reconnect`; a network failure is `offline`; the rest is
 * told apart by the HTTP status.
 */
export function classifyCopyFailure(error: unknown, online: boolean = typeof navigator === "undefined" || navigator.onLine !== false): CopyError {
  if (error instanceof CopyError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof AccountCredentialError || requiresSignInRenewal(error)) return new CopyError("reconnect", message, { cause: error });
  if (error instanceof BrokerError) return new CopyError(error.code === "invalid_grant" || error.code === "not_configured" ? "reconnect" : "offline", message, { cause: error });
  const value = error && typeof error === "object" ? error as { status?: unknown; retryAfterMs?: unknown; response?: { headers?: Record<string, unknown> } } : {};
  const status = typeof value.status === "number" ? value.status : undefined;
  if (status === 401) return new CopyError("reconnect", message, { cause: error });
  if (status === 429 || (status === 403 && /rate.?limit|abuse|secondary/i.test(message))) {
    const retryAfterMs = typeof value.retryAfterMs === "number" ? value.retryAfterMs : retryAfterOf(value.response?.headers);
    return new CopyError("rate-limited", message, { ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), cause: error });
  }
  if (status === 403 || status === 404) return new CopyError("unavailable", message, { cause: error });
  if (status !== undefined) return new CopyError("failed", message, { cause: error });
  if (!online || error instanceof TypeError || /network|fetch|failed to fetch|load failed/i.test(message)) return new CopyError("offline", message, { cause: error });
  return new CopyError("failed", message, { cause: error });
}
