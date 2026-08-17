import { accountIdentity, normalizedAccountEmail } from "@/auth/accountIdentity";
import type { AppUser, AuthProvider } from "@/store/authStore";

export const LEGACY_RECOVERY_LOGIN_REQUEST_KEY = "narrarium-legacy-recovery-login-request-v1";
const MAX_AGE_MS = 5 * 60_000;

export interface LegacyRecoveryLoginRequest {
  version: 1;
  provider: AuthProvider;
  immutableIdentity: string;
  normalizedEmail: string;
  returnTo: string;
  createdAt: number;
  nonce: string;
}

export function normalizeAppReturnTo(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/app") || (value.length > 4 && !"/?#".includes(value[4]))
    || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(value)) return null;
  try {
    const parsed = new URL(value, window.location.origin);
    const normalized = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return parsed.origin === window.location.origin && normalized === value && parsed.pathname.startsWith("/app")
      && (parsed.pathname.length === 4 || parsed.pathname[4] === "/") ? normalized : null;
  } catch {
    return null;
  }
}

export function createLegacyRecoveryLoginRequest(user: AppUser, returnTo: string): LegacyRecoveryLoginRequest {
  const immutableIdentity = accountIdentity(user);
  const safeReturnTo = normalizeAppReturnTo(returnTo);
  if (!immutableIdentity || !safeReturnTo) throw new Error("Invalid legacy recovery login request.");
  const request: LegacyRecoveryLoginRequest = {
    version: 1,
    provider: user.provider,
    immutableIdentity,
    normalizedEmail: normalizedAccountEmail(user),
    returnTo: safeReturnTo,
    createdAt: Date.now(),
    nonce: crypto.randomUUID(),
  };
  sessionStorage.setItem(LEGACY_RECOVERY_LOGIN_REQUEST_KEY, JSON.stringify(request));
  sessionStorage.setItem("narrarium-return-to", returnTo);
  return request;
}

export type LegacyRecoveryLoginRequestState = { status: "missing" | "invalid" } | { status: "expired" | "valid"; request: LegacyRecoveryLoginRequest };

export function readLegacyRecoveryLoginRequest(): LegacyRecoveryLoginRequestState {
  try {
    const raw = sessionStorage.getItem(LEGACY_RECOVERY_LOGIN_REQUEST_KEY);
    if (!raw) return { status: "missing" };
    const value = JSON.parse(raw) as Partial<LegacyRecoveryLoginRequest> | null;
    const now = Date.now();
    if (!value || value.version !== 1 || (value.provider !== "google" && value.provider !== "microsoft")
      || typeof value.immutableIdentity !== "string" || value.immutableIdentity !== `${value.provider}:${value.immutableIdentity.slice(value.provider.length + 1)}`
      || !value.immutableIdentity.slice(value.provider.length + 1).trim()
      || typeof value.normalizedEmail !== "string" || value.normalizedEmail !== value.normalizedEmail.trim().toLocaleLowerCase()
      || !value.normalizedEmail || !normalizeAppReturnTo(value.returnTo)
      || typeof value.createdAt !== "number" || value.createdAt > now
      || typeof value.nonce !== "string" || !value.nonce.trim()) return { status: "invalid" };
    const request = value as LegacyRecoveryLoginRequest;
    return now - request.createdAt > MAX_AGE_MS ? { status: "expired", request } : { status: "valid", request };
  } catch {
    return { status: "invalid" };
  }
}

export function getLegacyRecoveryLoginRequest(): LegacyRecoveryLoginRequest | null {
  const state = readLegacyRecoveryLoginRequest();
  return state.status === "valid" ? state.request : null;
}

export function clearLegacyRecoveryLoginRequest(): void {
  sessionStorage.removeItem(LEGACY_RECOVERY_LOGIN_REQUEST_KEY);
}

export function matchesLegacyRecoveryLoginRequest(request: LegacyRecoveryLoginRequest, user: AppUser): boolean {
  return request.provider === user.provider
    && request.immutableIdentity === accountIdentity(user)
    && request.normalizedEmail === normalizedAccountEmail(user);
}

export function consumeLegacyRecoveryLoginRequest(request: LegacyRecoveryLoginRequest): void {
  const current = getLegacyRecoveryLoginRequest();
  if (current?.nonce === request.nonce) sessionStorage.removeItem(LEGACY_RECOVERY_LOGIN_REQUEST_KEY);
}
