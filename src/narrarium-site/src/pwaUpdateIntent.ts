import { isNewerAppVersion } from "@/lib/appVersion";
import { accountIdentity } from "@/auth/accountIdentity";
import type { AppUser } from "@/store/authStore";

export const UPDATE_DESTINATION_INTENT_KEY = "narrarium-update-destination-v1";
export const UPDATE_DESTINATION_TAB_STATE_KEY = "narrarium-update-destination-tab-v1";
export const LEGACY_OPEN_PATCH_NOTES_KEY = "narrarium-open-patch-notes-after-update";
export const UPDATE_PATCH_NOTES_ROUTE = "/app/patch-notes";
export const UPDATE_INTENT_MAX_AGE_MS = 30 * 60_000;

export interface UpdateDestinationIntent {
  version: 1;
  route: typeof UPDATE_PATCH_NOTES_ROUTE;
  targetVersion: string;
  createdAt: number;
  expiresAt: number;
  nonce: string;
  status: "pending";
}

export interface UpdateIntentAuthState {
  accessToken: string | null;
  accessTokenExpiry: number | null;
  user: AppUser | null;
}

interface UpdateDestinationTabState {
  version: 1;
  nonce: string;
  targetVersion: string;
  status: "navigating" | "auth-required" | "reloading";
}

const INTENT_KEYS = ["version", "route", "targetVersion", "createdAt", "expiresAt", "nonce", "status"].sort();
const TAB_STATE_KEYS = ["version", "nonce", "targetVersion", "status"].sort();
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const NONCE_PATTERN = /^[0-9A-Za-z-]{8,128}$/;

function hasExactKeys(value: object, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function removeLegacyMarker(tabStorage: Storage): void {
  try {
    tabStorage.removeItem(LEGACY_OPEN_PATCH_NOTES_KEY);
  } catch {
    // Storage may be unavailable in a restricted browser context.
  }
}

export function clearUpdateDestinationIntent(tabStorage: Storage = sessionStorage): void {
  removeLegacyMarker(tabStorage);
  try {
    localStorage.removeItem(UPDATE_DESTINATION_INTENT_KEY);
  } catch {
    // Updating must still work when durable storage is unavailable.
  }
  try { tabStorage.removeItem(UPDATE_DESTINATION_TAB_STATE_KEY); } catch { /* Per-tab handling expires with the tab. */ }
}

export function clearUpdateDestinationIntentThrough(targetVersion: string, tabStorage: Storage = sessionStorage): void {
  const intent = readUpdateDestinationIntent();
  if (!intent || intent.targetVersion === targetVersion || isNewerAppVersion(targetVersion, intent.targetVersion)) {
    clearUpdateDestinationIntent(tabStorage);
  }
}

function validIntent(value: unknown, now: number): value is UpdateDestinationIntent {
  if (!value || typeof value !== "object" || Array.isArray(value) || !hasExactKeys(value, INTENT_KEYS)) return false;
  const candidate = value as Partial<UpdateDestinationIntent>;
  return candidate.version === 1
    && candidate.route === UPDATE_PATCH_NOTES_ROUTE
    && typeof candidate.targetVersion === "string"
    && VERSION_PATTERN.test(candidate.targetVersion)
    && typeof candidate.createdAt === "number"
    && Number.isFinite(candidate.createdAt)
    && candidate.createdAt <= now
    && typeof candidate.expiresAt === "number"
    && Number.isFinite(candidate.expiresAt)
    && candidate.expiresAt === candidate.createdAt + UPDATE_INTENT_MAX_AGE_MS
    && candidate.expiresAt > now
    && typeof candidate.nonce === "string"
    && NONCE_PATTERN.test(candidate.nonce)
    && candidate.status === "pending";
}

function writeIntent(intent: UpdateDestinationIntent): boolean {
  try {
    localStorage.setItem(UPDATE_DESTINATION_INTENT_KEY, JSON.stringify(intent));
    return true;
  } catch {
    return false;
  }
}

export function readUpdateDestinationIntent(now = Date.now()): UpdateDestinationIntent | null {
  try {
    const raw = localStorage.getItem(UPDATE_DESTINATION_INTENT_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (validIntent(value, now)) return value;
    localStorage.removeItem(UPDATE_DESTINATION_INTENT_KEY);
  } catch {
    try { localStorage.removeItem(UPDATE_DESTINATION_INTENT_KEY); } catch { /* Nothing unsafe is retained. */ }
  }
  return null;
}

export function createUpdateDestinationIntent(targetVersion: string, now = Date.now()): UpdateDestinationIntent | null {
  if (!VERSION_PATTERN.test(targetVersion) || !Number.isFinite(now)) return null;
  const existing = readUpdateDestinationIntent(now);
  if (existing && !isNewerAppVersion(targetVersion, existing.targetVersion)) return existing;
  const intent: UpdateDestinationIntent = {
    version: 1,
    route: UPDATE_PATCH_NOTES_ROUTE,
    targetVersion,
    createdAt: now,
    expiresAt: now + UPDATE_INTENT_MAX_AGE_MS,
    nonce: crypto.randomUUID(),
    status: "pending",
  };
  return writeIntent(intent) ? intent : null;
}

export function migrateLegacyUpdateDestinationIntent(
  targetVersion: string,
  now = Date.now(),
  tabStorage: Storage = sessionStorage,
): UpdateDestinationIntent | null {
  const existing = readUpdateDestinationIntent(now);
  let legacyRequested = false;
  try { legacyRequested = tabStorage.getItem(LEGACY_OPEN_PATCH_NOTES_KEY) === "1"; } catch { /* No migration source is available. */ }
  const intent = existing ?? (legacyRequested ? createUpdateDestinationIntent(targetVersion, now) : null);
  removeLegacyMarker(tabStorage);
  return intent;
}

function validTabState(value: unknown): value is UpdateDestinationTabState {
  if (!value || typeof value !== "object" || Array.isArray(value) || !hasExactKeys(value, TAB_STATE_KEYS)) return false;
  const candidate = value as Partial<UpdateDestinationTabState>;
  return candidate.version === 1
    && typeof candidate.nonce === "string"
    && NONCE_PATTERN.test(candidate.nonce)
    && typeof candidate.targetVersion === "string"
    && VERSION_PATTERN.test(candidate.targetVersion)
    && (candidate.status === "navigating" || candidate.status === "auth-required" || candidate.status === "reloading");
}

function readTabState(tabStorage: Storage): UpdateDestinationTabState | null {
  try {
    const raw = tabStorage.getItem(UPDATE_DESTINATION_TAB_STATE_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (validTabState(value)) return value;
    tabStorage.removeItem(UPDATE_DESTINATION_TAB_STATE_KEY);
  } catch {
    try { tabStorage.removeItem(UPDATE_DESTINATION_TAB_STATE_KEY); } catch { /* Invalid state cannot affect navigation. */ }
  }
  return null;
}

function writeTabState(tabStorage: Storage, state: UpdateDestinationTabState): boolean {
  try {
    tabStorage.setItem(UPDATE_DESTINATION_TAB_STATE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function beginUpdateDestinationNavigation(tabStorage: Storage = sessionStorage): UpdateDestinationIntent | null {
  const intent = readUpdateDestinationIntent();
  if (!intent) return null;
  const handled = readTabState(tabStorage);
  if (handled?.nonce === intent.nonce && handled.targetVersion === intent.targetVersion) return null;
  return writeTabState(tabStorage, {
    version: 1,
    nonce: intent.nonce,
    targetVersion: intent.targetVersion,
    status: "navigating",
  }) ? intent : null;
}

export function markControllerReloadHandled(targetVersion: string, tabStorage: Storage = sessionStorage): boolean {
  if (!VERSION_PATTERN.test(targetVersion)) return false;
  const handled = readTabState(tabStorage);
  if (handled?.status === "reloading" && handled.targetVersion === targetVersion) return false;
  return writeTabState(tabStorage, {
    version: 1,
    nonce: "reload-event",
    targetVersion,
    status: "reloading",
  });
}

export function markUpdateDestinationAuthRequired(pathname: string, tabStorage: Storage = sessionStorage): string | null {
  if (pathname !== UPDATE_PATCH_NOTES_ROUTE) return null;
  const intent = readUpdateDestinationIntent();
  const handled = readTabState(tabStorage);
  if (!intent || handled?.nonce !== intent.nonce || handled.targetVersion !== intent.targetVersion
    || (handled.status !== "navigating" && handled.status !== "auth-required")) return null;
  if (handled.status === "navigating" && !writeTabState(tabStorage, { ...handled, status: "auth-required" })) return null;
  return UPDATE_PATCH_NOTES_ROUTE;
}

export function updateDestinationLoginReturnTo(tabStorage: Storage = sessionStorage): string | null {
  const intent = readUpdateDestinationIntent();
  const handled = readTabState(tabStorage);
  return intent && handled?.status === "auth-required" && handled.nonce === intent.nonce
    && handled.targetVersion === intent.targetVersion ? UPDATE_PATCH_NOTES_ROUTE : null;
}

export function resolveUpdateAwareLoginReturnTo(
  explicitReturnTo: string | null,
  tabStorage: Storage = sessionStorage,
): string {
  return explicitReturnTo ?? updateDestinationLoginReturnTo(tabStorage) ?? "/app/books";
}

export function hasValidUpdateIntentAuth(auth: UpdateIntentAuthState, now = Date.now()): boolean {
  return typeof auth.accessToken === "string" && Boolean(auth.accessToken.trim())
    && typeof auth.accessTokenExpiry === "number" && Number.isFinite(auth.accessTokenExpiry)
    && auth.accessTokenExpiry > now
    && accountIdentity(auth.user) !== null;
}

export function consumeUpdateDestinationIntent(
  nonce: string,
  currentVersion: string,
  auth: UpdateIntentAuthState,
  now = Date.now(),
): boolean {
  const intent = readUpdateDestinationIntent();
  if (!intent || intent.nonce !== nonce || intent.route !== UPDATE_PATCH_NOTES_ROUTE) return false;
  if (!hasValidUpdateIntentAuth(auth, now)) return false;
  if (currentVersion !== intent.targetVersion && !isNewerAppVersion(currentVersion, intent.targetVersion)) return false;
  try {
    localStorage.removeItem(UPDATE_DESTINATION_INTENT_KEY);
    return true;
  } catch {
    return false;
  }
}

export function patchNotesPhysicalUrl(baseUrl: string): string {
  const basePath = baseUrl === "/" ? "/" : `/${baseUrl.replace(/^\/+|\/+$/g, "")}/`;
  return `${basePath}app/patch-notes/`;
}
