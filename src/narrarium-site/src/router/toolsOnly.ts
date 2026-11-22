import { applySameBoundaryPolicy, pickAiRuntimeConfig, resolveAiCandidates } from "narrarium-engine";
import { AUTOPILOT_TASKS } from "@/router/autopilotTasks";
import type { AppSettings, RoutingTaskKind } from "@/types/settings";

export { AUTOPILOT_TASKS };

export interface ToolsOnlyReport {
  /** Tasks whose every model is marked as without tool calls: with «Tools only» on, the autopilot stops on them with a configuration error. */
  blocked: RoutingTaskKind[];
  /** Tasks that have a model without tool calls beside one that can: the first is skipped, nothing stops. */
  skipped: Array<{ task: RoutingTaskKind; models: string[] }>;
}

/**
 * What «Tools only» would do to the models of each task of the autopilot, as the engine will do it: the route of the task as the engine resolves it (cut at the
 * limit of candidates), minus the fallbacks the privacy setting keeps out, and then the models marked as without tool calls (only an explicit `false` counts).
 * Nothing is reported while «Tools only» is off, and a task with no model at all has nothing to say: that is another error.
 */
export function toolsOnlyReport(settings: AppSettings): ToolsOnlyReport {
  const report: ToolsOnlyReport = { blocked: [], skipped: [] };
  let config;
  try {
    config = pickAiRuntimeConfig(settings);
  } catch {
    return report;
  }
  if (config.toolsOnly === false) return report;
  for (const task of AUTOPILOT_TASKS) {
    const route = applySameBoundaryPolicy(config, resolveAiCandidates(config, task));
    const lacking = route.filter((candidate) => candidate.supportsToolCalls === false);
    if (lacking.length === 0) continue;
    if (lacking.length === route.length) report.blocked.push(task);
    else report.skipped.push({ task, models: lacking.map((candidate) => candidate.model) });
  }
  return report;
}
