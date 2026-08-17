import { accountIdentity, legacyEmailAccountIdentity, normalizedAccountEmail, type LegacyAccountUpgradeEvidence } from "@/auth/accountIdentity";
import type { AppUser } from "@/store/authStore";

export const LEGACY_ADOPTION_CONSENT_KEY = "narrarium-legacy-adoption-consent-v1";
const MAX_AGE_MS = 5 * 60_000;

export interface LegacyAdoptionTarget {
  bookId: string;
  owner: string;
  repo: string;
  branch: string;
  legacyIdentity: string;
  evidenceNonce: string;
  replaceDisposableTarget: boolean;
}

interface LegacyAdoptionConsent extends LegacyAdoptionTarget {
  version: 1;
  provider: AppUser["provider"];
  immutableIdentity: string;
  normalizedEmail: string;
  createdAt: number;
  nonce: string;
}

function matchesTarget(consent: LegacyAdoptionConsent, user: AppUser, target: LegacyAdoptionTarget): boolean {
  return consent.provider === user.provider
    && consent.immutableIdentity === accountIdentity(user)
    && consent.normalizedEmail === normalizedAccountEmail(user)
    && consent.legacyIdentity === legacyEmailAccountIdentity(user)
    && consent.bookId === target.bookId
    && consent.owner === target.owner
    && consent.repo === target.repo
    && consent.branch === target.branch
    && consent.evidenceNonce === target.evidenceNonce
    && consent.replaceDisposableTarget === target.replaceDisposableTarget;
}

export function createLegacyAdoptionConsent(user: AppUser, target: LegacyAdoptionTarget): void {
  const immutableIdentity = accountIdentity(user);
  if (!immutableIdentity || target.legacyIdentity !== legacyEmailAccountIdentity(user) || !target.evidenceNonce) throw new Error("Invalid legacy adoption consent target.");
  const consent: LegacyAdoptionConsent = {
    version: 1,
    provider: user.provider,
    immutableIdentity,
    normalizedEmail: normalizedAccountEmail(user),
    ...target,
    createdAt: Date.now(),
    nonce: crypto.randomUUID(),
  };
  sessionStorage.setItem(LEGACY_ADOPTION_CONSENT_KEY, JSON.stringify(consent));
}

export function consumeLegacyAdoptionConsent(user: AppUser, target: LegacyAdoptionTarget, evidence: LegacyAccountUpgradeEvidence): boolean {
  let consent: LegacyAdoptionConsent | null = null;
  try {
    consent = JSON.parse(sessionStorage.getItem(LEGACY_ADOPTION_CONSENT_KEY) ?? "null") as LegacyAdoptionConsent | null;
    sessionStorage.removeItem(LEGACY_ADOPTION_CONSENT_KEY);
  } catch {
    return false;
  }
  const now = Date.now();
  return Boolean(consent?.version === 1 && typeof consent.nonce === "string" && consent.nonce
    && typeof consent.createdAt === "number" && consent.createdAt <= now && now - consent.createdAt <= MAX_AGE_MS
    && evidence.nonce === target.evidenceNonce && matchesTarget(consent, user, target));
}
