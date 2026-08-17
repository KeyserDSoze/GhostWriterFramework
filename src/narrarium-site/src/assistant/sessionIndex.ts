import type { AuthProvider } from "../store/authStore.ts";
import { listAssistantSessions, maintainAssistantSessionSegments } from "./chatCloud.ts";
import { useAssistantStore } from "./store.ts";

let generation = 0;
let active: { key: string; controller: AbortController; promise: Promise<void>; settled: boolean } | null = null;
const lastMaintenance = new Map<string, number>();
const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Refreshes the single account-scoped chat index and rejects stale/out-of-order results. */
export function refreshAssistantSessionIndex(provider: AuthProvider, accessToken: string, identity: string): Promise<void> {
  const key = `${identity}\0${accessToken}`;
  useAssistantStore.getState().setSessionAccountIdentity(identity);
  if (active?.key === key && !active.settled) return active.promise;
  active?.controller.abort();
  const controller = new AbortController();
  const requestGeneration = ++generation;
  useAssistantStore.getState().setSessionsLoading(true);
  const isCurrent = () => requestGeneration === generation
    && !controller.signal.aborted
    && useAssistantStore.getState().sessionAccountIdentity === identity;
  const promise = listAssistantSessions(provider, accessToken, { signal: controller.signal, isCurrent })
    .then(async (sessions) => {
      if (!isCurrent()) return;
      useAssistantStore.getState().setSessions(sessions);
      const previous = lastMaintenance.get(identity) ?? 0;
      if (Date.now() - previous < MAINTENANCE_INTERVAL_MS) return;
      try {
        await maintainAssistantSessionSegments(provider, accessToken, { signal: controller.signal, isCurrent });
        if (isCurrent()) lastMaintenance.set(identity, Date.now());
      } catch {
        // Session listing remains usable; maintenance retries on the next refresh.
      }
    })
    .finally(() => {
      if (isCurrent()) useAssistantStore.getState().setSessionsLoading(false);
      if (active?.promise === promise) active.settled = true;
    });
  active = { key, controller, promise, settled: false };
  return promise;
}

export function resetAssistantSessionIndex(identity: string | null): void {
  generation += 1;
  active?.controller.abort();
  active = null;
  useAssistantStore.getState().setSessionAccountIdentity(identity);
  if (!identity) useAssistantStore.getState().setSessionsLoading(false);
}

export function resetAssistantSessionMaintenanceForTests(): void {
  lastMaintenance.clear();
}
