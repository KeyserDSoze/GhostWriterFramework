import type { AppUser } from "../store/authStore.ts";

export function requireGoogleProviderAccountId(profile: { sub?: unknown }): string {
  if (typeof profile.sub !== "string" || !profile.sub.trim()) throw new Error("Google profile did not provide an immutable account subject.");
  return profile.sub.trim();
}

export function accountIdentity(user: AppUser | null | undefined): string | null {
  if (!user) return null;
  const providerAccountId = user.providerAccountId?.trim();
  if (!providerAccountId) return null;
  if (user.provider === "microsoft" && (!user.homeAccountId?.trim() || !user.localAccountId?.trim() || user.homeAccountId.trim() !== providerAccountId)) return null;
  return `${user.provider}:${providerAccountId}`;
}

export function isAccountIdentityCurrent(expected: string | null, user: AppUser | null | undefined): boolean {
  return accountIdentity(user) === expected;
}

export function shouldResetAccountScope(storedIdentity: string | null, currentIdentity: string | null): boolean {
  return !storedIdentity || storedIdentity !== currentIdentity;
}

export function isMicrosoftIdentityUpgrade(previous: AppUser | null | undefined, next: AppUser | null | undefined): boolean {
  return previous?.provider === "microsoft"
    && next?.provider === "microsoft"
    && !previous.homeAccountId
    && Boolean(next.homeAccountId)
    && previous.email.trim().toLocaleLowerCase() === next.email.trim().toLocaleLowerCase();
}

export function isGoogleIdentityUpgrade(previous: AppUser | null | undefined, next: AppUser | null | undefined): boolean {
  return previous?.provider === "google" && next?.provider === "google" && !previous.providerAccountId && Boolean(next.providerAccountId)
    && previous.email.trim().toLocaleLowerCase() === next.email.trim().toLocaleLowerCase();
}
