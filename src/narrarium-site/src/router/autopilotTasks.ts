import type { RoutingTaskKind } from "@/types/settings";

/**
 * The tasks of the engine's agents (`AI_CAPABILITIES`), in the engine's order: the writer, the director, the readers and their summary, the specialists and the
 * summaries. «Tools only» is theirs: the Copilot and the editor have their own way of asking a model for a structured answer. It is a module of its own, with nothing
 * behind it, so that the autopilot's pages can ask which tasks these are without bringing the tables of the router with them.
 */
export const AUTOPILOT_TASKS = ["autopilot", "director", "reader-evaluation", "reader-evaluation-summary", "review", "simple-tasks"] as const satisfies readonly RoutingTaskKind[];
