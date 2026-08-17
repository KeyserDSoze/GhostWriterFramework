import type { AppUser } from "../store/authStore.ts";

const LEGACY_UPGRADE_PENDING_KEY = "narrarium-legacy-account-upgrade-pending-v2";
const LEGACY_UPGRADE_EVIDENCE_KEY = "narrarium-legacy-account-upgrade-evidence-v2";
const LEGACY_UPGRADE_MAX_AGE_MS = 5 * 60_000;

export interface LegacyAccountUpgradeEvidence {
  provider: AppUser["provider"];
  normalizedEmail: string;
  legacyIdentity: string;
  immutableIdentity: string;
  nonce: string;
  createdAt: number;
}

interface PendingLegacyAccountUpgrade extends Omit<LegacyAccountUpgradeEvidence, "immutableIdentity"> {}
interface PendingLegacyRecovery extends PendingLegacyAccountUpgrade { expectedImmutableIdentity?: string }

export function normalizedAccountEmail(user: Pick<AppUser, "email">): string {
  return user.email.trim().toLocaleLowerCase();
}

export function legacyEmailAccountIdentity(user: AppUser): string {
  return `${user.provider}:${normalizedAccountEmail(user)}`;
}

export function beginLegacyAccountUpgrade(user: AppUser): void {
  const pending: PendingLegacyAccountUpgrade = {
    provider: user.provider,
    normalizedEmail: normalizedAccountEmail(user),
    legacyIdentity: legacyEmailAccountIdentity(user),
    nonce: crypto.randomUUID(),
    createdAt: Date.now(),
  };
  try { sessionStorage.setItem(LEGACY_UPGRADE_PENDING_KEY, JSON.stringify(pending)); } catch { /* Migration remains explicit when session storage is unavailable. */ }
}

export function beginStrandedLegacyRecovery(user: AppUser, legacyIdentity: string): void {
  const immutableIdentity = accountIdentity(user);
  if (!immutableIdentity || legacyIdentity !== legacyEmailAccountIdentity(user)) return;
  try {
    const current = JSON.parse(sessionStorage.getItem(LEGACY_UPGRADE_PENDING_KEY) ?? "null") as PendingLegacyRecovery | null;
    if (current?.expectedImmutableIdentity === immutableIdentity && current.legacyIdentity === legacyIdentity && Date.now() - current.createdAt <= LEGACY_UPGRADE_MAX_AGE_MS) return;
    const pending: PendingLegacyRecovery = { provider: user.provider, normalizedEmail: normalizedAccountEmail(user), legacyIdentity, expectedImmutableIdentity: immutableIdentity, nonce: crypto.randomUUID(), createdAt: Date.now() };
    sessionStorage.setItem(LEGACY_UPGRADE_PENDING_KEY, JSON.stringify(pending));
  } catch { /* Recovery remains blocked until browser session storage is available. */ }
}

export function finalizeInteractiveLegacyAccountUpgrade(user: AppUser): LegacyAccountUpgradeEvidence | null {
  const immutableIdentity = accountIdentity(user);
  let pending: PendingLegacyRecovery | null = null;
  try {
    pending = JSON.parse(sessionStorage.getItem(LEGACY_UPGRADE_PENDING_KEY) ?? "null") as PendingLegacyAccountUpgrade | null;
    sessionStorage.removeItem(LEGACY_UPGRADE_PENDING_KEY);
  } catch { return null; }
  if (!pending) return null;
  if (!immutableIdentity || Date.now() - pending.createdAt > LEGACY_UPGRADE_MAX_AGE_MS || pending.createdAt > Date.now()
    || pending.provider !== user.provider || pending.normalizedEmail !== normalizedAccountEmail(user)
    || pending.legacyIdentity !== legacyEmailAccountIdentity(user)
    || (pending.expectedImmutableIdentity !== undefined && pending.expectedImmutableIdentity !== immutableIdentity)) {
    clearLegacyAccountUpgrade();
    throw new Error("Interactive recovery must use the same provider account and email as the currently authenticated account. Start recovery again to retry.");
  }
  const evidence: LegacyAccountUpgradeEvidence = { ...pending, immutableIdentity };
  try { sessionStorage.setItem(LEGACY_UPGRADE_EVIDENCE_KEY, JSON.stringify(evidence)); } catch { return null; }
  return evidence;
}

export function getLegacyAccountUpgradeEvidence(user: AppUser, immutableIdentity: string): LegacyAccountUpgradeEvidence | null {
  try {
    const evidence = JSON.parse(sessionStorage.getItem(LEGACY_UPGRADE_EVIDENCE_KEY) ?? "null") as LegacyAccountUpgradeEvidence | null;
    if (!evidence || Date.now() - evidence.createdAt > LEGACY_UPGRADE_MAX_AGE_MS || evidence.createdAt > Date.now()
      || evidence.provider !== user.provider || evidence.normalizedEmail !== normalizedAccountEmail(user)
      || evidence.legacyIdentity !== legacyEmailAccountIdentity(user) || evidence.immutableIdentity !== immutableIdentity) return null;
    return evidence;
  } catch { clearLegacyAccountUpgrade(); return null; }
}

export function consumeLegacyAccountUpgradeEvidence(user: AppUser, immutableIdentity: string, nonce?: string): LegacyAccountUpgradeEvidence | null {
  const evidence = getLegacyAccountUpgradeEvidence(user, immutableIdentity);
  if (!evidence || (nonce !== undefined && evidence.nonce !== nonce)) return null;
  try { sessionStorage.removeItem(LEGACY_UPGRADE_EVIDENCE_KEY); } catch { return null; }
  return evidence;
}

export function clearLegacyAccountUpgrade(): void {
  try {
    sessionStorage.removeItem(LEGACY_UPGRADE_PENDING_KEY);
    sessionStorage.removeItem(LEGACY_UPGRADE_EVIDENCE_KEY);
  } catch { /* Nothing else can retain browser-session proof. */ }
}

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
