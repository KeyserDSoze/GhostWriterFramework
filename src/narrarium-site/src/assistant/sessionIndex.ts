import type { AuthProvider } from "../store/authStore.ts";
import { listAssistantSessions } from "./chatCloud.ts";
import { useAssistantStore } from "./store.ts";

let generation = 0;
let active: { key: string; controller: AbortController; promise: Promise<void>; settled: boolean } | null = null;

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
    .then((sessions) => { if (isCurrent()) useAssistantStore.getState().setSessions(sessions); })
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
