import type { AccountSyncBackendKind, LocalReplicaState, LocalSyncConfiguration } from "@/account/types";

export type SyncIndicatorState = "synced" | "syncing" | "pending" | "needs-login" | "failed" | "remote-offline" | "device-offline";

export interface SyncBackendStatus {
  backend: AccountSyncBackendKind;
  name: string;
  replica: LocalReplicaState;
}

export interface SyncIndicatorSummary {
  state: SyncIndicatorState;
  /** Nothing to show when no service syncs this device and the device is online. */
  visible: boolean;
  /** The enabled services, in a fixed order. */
  backends: SyncBackendStatus[];
  /** The service that explains an attention state. */
  focus?: SyncBackendStatus;
  /** The newest successful sync of any enabled service. */
  lastSyncAtUtc?: string;
}

const ATTENTION_STATES: readonly SyncIndicatorState[] = ["needs-login", "failed", "remote-offline", "device-offline"];
/** The statuses a service can report that need the owner's attention, most urgent first. */
const SERVICE_ATTENTION: ReadonlyArray<[LocalReplicaState["status"], SyncIndicatorState]> = [["needs-auth", "needs-login"], ["error", "failed"], ["offline", "remote-offline"]];
const PENDING_STATUSES: ReadonlyArray<LocalReplicaState["status"]> = ["dirty", "ahead", "behind", "diverged"];

export function needsAttention(state: SyncIndicatorState): boolean {
  return ATTENTION_STATES.includes(state);
}

/** The statuses in which a replica's error kind and message explain what is wrong. */
export function isFailureStatus(status: string | undefined): boolean {
  return status === "error" || status === "needs-auth" || status === "offline";
}

export function summarizeSyncStatus(input: { configuration: LocalSyncConfiguration; syncing: boolean; deviceOffline: boolean }): SyncIndicatorSummary {
  const { configuration } = input;
  const backends: SyncBackendStatus[] = [
    { backend: "google-drive" as const, name: "Google Drive", replica: configuration.google?.replica },
    { backend: "onedrive" as const, name: "OneDrive", replica: configuration.microsoft?.replica },
    { backend: "github" as const, name: "GitHub", replica: configuration.github?.replica },
  ].filter((entry): entry is SyncBackendStatus => Boolean(entry.replica?.enabled));
  const withStatus = (status: LocalReplicaState["status"]) => backends.find((entry) => entry.replica.status === status);

  const lastSyncAtUtc = backends
    .map((entry) => entry.replica.lastSuccessfulSyncAtUtc)
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];

  let state: SyncIndicatorState = "synced";
  let focus: SyncBackendStatus | undefined;
  if (input.deviceOffline) state = "device-offline";
  else if (input.syncing || withStatus("syncing")) state = "syncing";
  else {
    for (const [status, attention] of SERVICE_ATTENTION) {
      focus = withStatus(status);
      if (focus) { state = attention; break; }
    }
    if (!focus && backends.some((entry) => PENDING_STATUSES.includes(entry.replica.status))) state = "pending";
  }

  return { state, visible: backends.length > 0 || input.deviceOffline, backends, ...(focus ? { focus } : {}), ...(lastSyncAtUtc ? { lastSyncAtUtc } : {}) };
}
