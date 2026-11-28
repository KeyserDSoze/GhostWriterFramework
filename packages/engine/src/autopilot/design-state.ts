import { asRecord } from "../util/json.js";
import { normalizeRubrics } from "./design-rubric.js";
import type { AutopilotDesign, DesignWorkflow } from "./types.js";

/**
 * What the state of a design keeps of its reviews (`AutopilotDesign.workflow`, `rubric`…), read back from a file. A file that says something that is not what it should
 * is read as the design it can be: a part that is not understood is left out, never guessed. Pure.
 */

/** The parts of the workflow that are a switch. */
const SWITCHES = ["rubric"] as const;

/** The workflow as a file says it: a part that is on is kept, the rest is dropped; `undefined` when nothing is on. */
export function normalizeWorkflow(value: unknown): DesignWorkflow | undefined {
  const source = asRecord(value);
  const workflow: DesignWorkflow = {};
  if (source.rubric === true) workflow.rubric = true;
  return Object.keys(workflow).length ? workflow : undefined;
}

/** What a start says of the workflow, checked: the parts it knows, each a switch. An error message (not thrown here) for anything else. */
export function readWorkflowInput(value: unknown): { workflow: DesignWorkflow } | { error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { error: "design.workflow must be { rubric? } or null." };
  const source = value as Record<string, unknown>;
  const unknown = Object.keys(source).filter((key) => !SWITCHES.includes(key as (typeof SWITCHES)[number]));
  if (unknown.length) return { error: `design.workflow does not take ${unknown.map((key) => `«${key}»`).join(", ")}: it takes ${SWITCHES.join(", ")}.` };
  const workflow: DesignWorkflow = {};
  for (const key of SWITCHES) {
    if (source[key] === undefined) continue;
    if (typeof source[key] !== "boolean") return { error: `design.workflow.${key} must be true or false.` };
    if (source[key]) workflow[key] = true;
  }
  return { workflow };
}

/** The parts of a design that its reviews wrote, from a file: what `normalizeDesign` adds to the design of every engine before. */
export function normalizeDesignReviews(source: Record<string, unknown>): Partial<AutopilotDesign> {
  const workflow = normalizeWorkflow(source.workflow);
  const rubric = normalizeRubrics(source.rubric);
  return { ...(workflow ? { workflow } : {}), ...(rubric ? { rubric } : {}) };
}

/** What a design does besides the plain design, every part resolved: off while the design says nothing of it. */
export interface DesignFlow {
  rubric: boolean;
}

export function designFlow(design: Pick<AutopilotDesign, "workflow"> | null | undefined): DesignFlow {
  const on = (key: (typeof SWITCHES)[number]) => design?.workflow?.[key] === true;
  return { rubric: on("rubric") };
}
