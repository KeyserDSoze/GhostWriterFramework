import type { AccountSyncBackendKind, LocalReplicaState, LocalSyncConfiguration } from "@/account/types";

/**
 * The automatic sync of the account data, for all the services and for each one. The sync runs by itself after a change (see `scheduleAccountSync`) for the
 * services that have it on; the setting of a service overrides the general one:
 *
 *  - `inherit`: this service follows the general setting;
 *  - `on` / `off`: this service is set by itself, whatever the general setting says.
 *
 * `replica.enabled` stays what the rest of the app reads: it is always the EFFECTIVE value, so nothing else had to change. A connection made before the general
 * setting existed has no mode: its value of today becomes its own setting (`on` or `off`), so nothing changes for it until the person says so.
 */
export type AutoSyncMode = "inherit" | "on" | "off";

const BACKENDS: AccountSyncBackendKind[] = ["google-drive", "onedrive", "github"];
const KEYS = { "google-drive": "google", onedrive: "microsoft", github: "github" } as const;

/** The general setting: on unless the person turned it off. */
export function autoSyncAll(configuration: Pick<LocalSyncConfiguration, "autoSyncAll">): boolean {
  return configuration.autoSyncAll !== false;
}

/** How a service is set: its own mode, or, for one recorded before the modes, what it was (a value that was kept stays its own setting). */
export function replicaAutoMode(replica: Pick<LocalReplicaState, "enabled" | "autoMode">): AutoSyncMode {
  return replica.autoMode ?? (replica.enabled ? "on" : "off");
}

/** Whether the sync of a service runs by itself, from its mode and the general setting. */
export function effectiveAutoSync(mode: AutoSyncMode, general: boolean): boolean {
  return mode === "inherit" ? general : mode === "on";
}

/** The state of a replica after its mode (or the general setting) changed: `enabled` follows the effective value; a service that is turned on starts as pending. */
export function replicaWithAutoMode(replica: LocalReplicaState, mode: AutoSyncMode, general: boolean): LocalReplicaState {
  const enabled = effectiveAutoSync(mode, general);
  if (enabled === replica.enabled) return { ...replica, autoMode: mode };
  return { ...replica, autoMode: mode, enabled, status: enabled ? "dirty" : "disabled" };
}

/** Gives every connection that has no mode its value of today as its own setting. Returns the same object when there is nothing to migrate. */
export function migrateAutoModes(configuration: LocalSyncConfiguration): LocalSyncConfiguration {
  let changed = false;
  const next: LocalSyncConfiguration = { ...configuration };
  for (const backend of BACKENDS) {
    const key = KEYS[backend];
    const connection = configuration[key];
    if (!connection || connection.replica.autoMode) continue;
    (next as Record<string, unknown>)[key] = { ...connection, replica: { ...connection.replica, autoMode: replicaAutoMode(connection.replica) } };
    changed = true;
  }
  return changed ? next : configuration;
}

/** The configuration with the general setting changed: the services that follow it follow it, the ones set by themselves stay. */
export function withAutoSyncAll(configuration: LocalSyncConfiguration, general: boolean): LocalSyncConfiguration {
  const next: LocalSyncConfiguration = { ...configuration, autoSyncAll: general };
  for (const backend of BACKENDS) {
    const key = KEYS[backend];
    const connection = configuration[key];
    if (!connection) continue;
    const mode = replicaAutoMode(connection.replica);
    if (mode !== "inherit") continue;
    const replica = replicaWithAutoMode(connection.replica, "inherit", general);
    (next as Record<string, unknown>)[key] = key === "github" ? { ...connection, accountSyncEnabled: replica.enabled, replica } : { ...connection, replica };
  }
  return next;
}

/** The configuration with one service set (or set to follow the general setting again). */
export function withAutoMode(configuration: LocalSyncConfiguration, backend: AccountSyncBackendKind, mode: AutoSyncMode): LocalSyncConfiguration {
  const key = KEYS[backend];
  const connection = configuration[key];
  if (!connection) return configuration;
  const replica = replicaWithAutoMode(connection.replica, mode, autoSyncAll(configuration));
  return { ...configuration, [key]: key === "github" ? { ...connection, accountSyncEnabled: replica.enabled, replica } : { ...connection, replica } } as LocalSyncConfiguration;
}

/** The replica of a connection that has just been made: it follows the general setting. */
export function newReplica(configuration: Pick<LocalSyncConfiguration, "autoSyncAll">): LocalReplicaState {
  const enabled = autoSyncAll(configuration);
  return { enabled, autoMode: "inherit", status: enabled ? "dirty" : "disabled" };
}
