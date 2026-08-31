import { localWorkspaceScope } from "@/account/deviceIdentity";
import { listLocalChatSessions } from "@/assistant/chatLocal";
import { useAssistantStore } from "@/assistant/store";
import type { AuthProvider } from "@/store/authStore";
import { listAssistantSessions, maintainAssistantSessionSegments } from "@/assistant/chatCloud";

let generation = 0;
let active: { key: string; controller: AbortController; promise: Promise<void>; settled: boolean } | null = null;
const lastMaintenance = new Map<string, number>();
const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Refreshes the durable device-local chat index without contacting a provider. */
export function refreshAssistantSessionIndex(providerOrIdentity: AuthProvider | string = localWorkspaceScope(), legacyAccessToken?: string, legacyIdentity?: string): Promise<void> {
  const identity = legacyIdentity ?? (providerOrIdentity.startsWith("workspace:") ? providerOrIdentity : localWorkspaceScope());
  const key = identity;
  useAssistantStore.getState().setSessionAccountIdentity(identity);
  if (active?.key === key && !active.settled) return active.promise;
  active?.controller.abort();
  const controller = new AbortController();
  const requestGeneration = ++generation;
  useAssistantStore.getState().setSessionsLoading(true);
  const isCurrent = () => requestGeneration === generation
    && !controller.signal.aborted
    && useAssistantStore.getState().sessionAccountIdentity === identity;
  const legacyCloudRequest = Boolean(legacyAccessToken && legacyIdentity && (providerOrIdentity === "google" || providerOrIdentity === "microsoft"));
  const promise = (legacyCloudRequest
    ? listAssistantSessions(providerOrIdentity as AuthProvider, legacyAccessToken!, { signal: controller.signal, isCurrent })
    : listLocalChatSessions())
    .then((sessions) => { if (isCurrent()) useAssistantStore.getState().setSessions(sessions); })
    .then(async () => {
      if (!legacyCloudRequest || Date.now() - (lastMaintenance.get(identity) ?? 0) < MAINTENANCE_INTERVAL_MS) return;
      await maintainAssistantSessionSegments(providerOrIdentity as AuthProvider, legacyAccessToken!, { signal: controller.signal, isCurrent }).catch(() => undefined);
      if (isCurrent()) lastMaintenance.set(identity, Date.now());
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
