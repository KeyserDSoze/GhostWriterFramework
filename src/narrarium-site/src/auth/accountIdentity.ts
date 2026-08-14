import type { AppUser } from "../store/authStore.ts";

export function accountIdentity(user: AppUser | null | undefined): string | null {
  if (!user) return null;
  return `${user.provider}:${user.email.trim().toLocaleLowerCase()}`;
}

export function isAccountIdentityCurrent(expected: string | null, user: AppUser | null | undefined): boolean {
  return accountIdentity(user) === expected;
}

export function shouldResetAccountScope(storedIdentity: string | null, currentIdentity: string | null): boolean {
  return !storedIdentity || storedIdentity !== currentIdentity;
}
