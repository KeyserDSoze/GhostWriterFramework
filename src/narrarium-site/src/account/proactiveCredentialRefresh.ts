/**
 * Renews long-lived credentials ahead of time, so that coming back to the app does not wait for a failed sync first.
 *
 * Right after the app starts (once the connections are loaded) and whenever the tab becomes visible again, a connection
 * that holds a refresh token, whose sync is turned on, and whose access token has expired or is about to, is renewed
 * through the broker, quietly: never a window, never a prompt. If its replica was waiting for the login or had failed,
 * a sync is then retried right away, in this session.
 *
 * The GitHub App's 8-hour token is renewed the same way, whether or not account sync is on (the books use that token), and again shortly before it
 * ends for as long as the tab stays open.
 *
 * It never loops: one renewal at a time per service, and after a failure the next attempt waits twice as long as the
 * last time (30 s, 1 min, 2 min... at most 15 min), or as long as the broker asked.
 */
import { setReplicaFailure, scheduleAccountSync } from "@/account/accountSync";
import { acquireBrokerAccessToken, type DriveBackend } from "@/account/brokerAccessToken";
import { AccountCredentialError, useConnectionStore } from "@/account/connectionStore";
import { BrokerError } from "@/account/credentialBroker";

/** A token with less life left than this is renewed ahead of time. */
const NEAR_EXPIRY_MS = 5 * 60_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;

interface Attempts { running: boolean; failures: number; notBefore: number }

type RenewBackend = DriveBackend | "github";

const attempts: Record<RenewBackend, Attempts> = {
  "google-drive": { running: false, failures: 0, notBefore: 0 },
  onedrive: { running: false, failures: 0, notBefore: 0 },
  github: { running: false, failures: 0, notBefore: 0 },
};

function needsRenewal(connection: { refreshToken?: string; accessToken?: string; token?: string; accessTokenExpiry?: number; replica: { enabled: boolean; errorKind?: string } }, now: number, requireSync = true): boolean {
  if (!connection.refreshToken || (requireSync && !connection.replica.enabled)) return false;
  return !(connection.accessToken ?? connection.token)
    || connection.accessTokenExpiry === undefined
    || connection.accessTokenExpiry - now <= NEAR_EXPIRY_MS
    || connection.replica.errorKind === "credential-expired";
}

function backoffMs(failures: number, askedFor: number | undefined): number {
  return Math.max(Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS), askedFor ?? 0);
}

async function renewOne(backend: RenewBackend): Promise<boolean> {
  const state = attempts[backend];
  const configuration = useConnectionStore.getState().configuration;
  const connection = backend === "google-drive" ? configuration.google : backend === "onedrive" ? configuration.microsoft : configuration.github?.credentialKind === "app" ? configuration.github : undefined;
  if (!connection || state.running || Date.now() < state.notBefore || !needsRenewal(connection, Date.now(), backend !== "github")) return false;

  state.running = true;
  try {
    // Forced: a token that is merely close to its end is still "usable" for a sync, but is what this renews ahead of time.
    if (backend === "github") await import("@/account/githubAppToken").then((module) => module.acquireGitHubAppToken({ force: true }));
    else await acquireBrokerAccessToken(backend, { force: true });
    state.failures = 0;
    state.notBefore = 0;
    return true;
  } catch (error) {
    state.failures += 1;
    state.notBefore = Date.now() + backoffMs(state.failures, error instanceof BrokerError ? error.retryAfterMs : undefined);
    // A login that was refused is the owner's business, and the header indicator should say so; a passing problem is not.
    if (error instanceof AccountCredentialError) await setReplicaFailure(backend, error).catch(() => undefined);
    return false;
  } finally {
    state.running = false;
  }
}

let githubTimer: ReturnType<typeof setTimeout> | undefined;

/** The app's token is renewed again just before it ends, so an open tab never meets an expired one. */
function armGitHubRenewal(): void {
  clearTimeout(githubTimer);
  const github = useConnectionStore.getState().configuration.github;
  if (github?.credentialKind !== "app" || !github.refreshToken || !github.accessTokenExpiry) return;
  const wait = Math.min(Math.max(github.accessTokenExpiry - NEAR_EXPIRY_MS - Date.now(), 30_000), 2 ** 31 - 1);
  githubTimer = setTimeout(() => { void renewLongLivedCredentials("visible"); }, wait);
}

/** Renews what needs it. Never rejects. `trigger` says why it ran: at start, or because the tab became visible. */
export async function renewLongLivedCredentials(_trigger: "start" | "visible"): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  try {
    const renewed = (await Promise.all((["google-drive", "onedrive", "github"] as const).map(async (backend) => (await renewOne(backend)) ? backend : null)))
      .filter((backend): backend is RenewBackend => backend !== null);
    armGitHubRenewal();
    const configuration = useConnectionStore.getState().configuration;
    const waiting = renewed.some((backend) => {
      const status = (backend === "google-drive" ? configuration.google : backend === "onedrive" ? configuration.microsoft : configuration.github)?.replica.status;
      return status === "needs-auth" || status === "error" || status === "offline";
    });
    if (waiting) scheduleAccountSync(250);
  } catch {
    // A background renewal must never surface as an error.
  }
}

let uninstall: (() => void) | null = null;

/** Starts the renewals: once the connections are loaded, and each time the tab becomes visible. Safe to call twice. */
export function installProactiveCredentialRefresh(): void {
  if (uninstall || typeof document === "undefined") return;
  const onVisible = () => { if (document.visibilityState === "visible") void renewLongLivedCredentials("visible"); };
  document.addEventListener("visibilitychange", onVisible);
  let unsubscribe: (() => void) | null = null;
  if (useConnectionStore.getState().hydrated) void renewLongLivedCredentials("start");
  else {
    unsubscribe = useConnectionStore.subscribe((state) => {
      if (!state.hydrated) return;
      unsubscribe?.();
      unsubscribe = null;
      void renewLongLivedCredentials("start");
    });
  }
  uninstall = () => {
    document.removeEventListener("visibilitychange", onVisible);
    unsubscribe?.();
  };
}

export function resetProactiveCredentialRefreshForTests(): void {
  clearTimeout(githubTimer);
  uninstall?.();
  uninstall = null;
  for (const state of Object.values(attempts)) Object.assign(state, { running: false, failures: 0, notBefore: 0 });
}
