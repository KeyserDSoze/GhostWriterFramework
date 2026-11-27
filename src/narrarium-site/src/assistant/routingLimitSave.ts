import { raisedLimits, restoredLimits, type RoutingLimitKey, type RoutingLimitRaise } from "@/assistant/routingLimitRaise";
import { saveSettingsNow } from "@/drive/useSettings";
import { useSettingsStore } from "@/store/settingsStore";

/**
 * A raise of a routing limit from a refusal (or the value it replaced, put back), written where every setting is: the store of the settings at once, so that the request sent again
 * and the run that resumes read it, then the account's store and the cloud when it can (`saveSettingsNow`), so that it is still there after a reload. The promise says whether the
 * saving went well; the change holds in this tab either way.
 */
export function saveRoutingLimitRaise(raise: Pick<RoutingLimitRaise, "key" | "to">): Promise<boolean> {
  const { settings, patchSettings } = useSettingsStore.getState();
  patchSettings({ routingExecution: raisedLimits(settings.routingExecution, raise) });
  return saveSettingsNow().then(() => true, () => false);
}

/** The limit a refusal raised, back to the value the author had (`from` when the settings no longer remember it), and forgotten as raised. */
export function saveRoutingLimitRestore(key: RoutingLimitKey, from: number): Promise<boolean> {
  const { settings, patchSettings } = useSettingsStore.getState();
  patchSettings({ routingExecution: { ...restoredLimits(settings.routingExecution, key), [key]: settings.routingExecution.raisedFrom?.[key] ?? from } });
  return saveSettingsNow().then(() => true, () => false);
}
