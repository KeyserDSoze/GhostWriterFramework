import type { AutopilotRuntime } from "@/autopilot/runtime";
import { loadAutopilotTranslations } from "@/i18n/autopilot";

let pending: Promise<AutopilotRuntime> | null = null;

/**
 * The autopilot runtime (shared engine, browser AI adapter and repository adapters) is loaded on
 * first use, so the app shell does not pay for it until the author opens or runs the autopilot.
 */
export function loadAutopilotRuntime(): Promise<AutopilotRuntime> {
  pending ??= Promise.all([import("@/autopilot/runtime"), loadAutopilotTranslations()])
    .then(([module]) => module.autopilotRuntime)
    .catch((error: unknown) => {
      pending = null;
      throw error;
    });
  return pending;
}
