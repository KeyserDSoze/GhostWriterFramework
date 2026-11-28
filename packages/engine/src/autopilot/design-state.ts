import { asArray, asInteger, asRecord } from "../util/json.js";
import { DESIGN_SUMMARY_CHARACTERS, type DesignChapterReview } from "./design-review-types.js";
import { normalizeRubrics } from "./design-rubric.js";
import type { AutopilotDesign, DesignWorkflow } from "./types.js";

/**
 * What the state of a design keeps of its reviews (`AutopilotDesign.workflow`, `rubric`…), read back from a file. A file that says something that is not what it should
 * is read as the design it can be: a part that is not understood is left out, never guessed. Pure.
 */

/** The parts of the workflow that are a switch. */
const SWITCHES = ["rubric", "chapterReview"] as const;

/** The workflow as a file says it: a part that is on is kept, the rest is dropped; `undefined` when nothing is on. */
export function normalizeWorkflow(value: unknown): DesignWorkflow | undefined {
  const source = asRecord(value);
  const workflow: DesignWorkflow = {};
  if (source.rubric === true) workflow.rubric = true;
  if (source.chapterReview === true) workflow.chapterReview = true;
  return Object.keys(workflow).length ? workflow : undefined;
}

/** What a start says of the workflow, checked: the parts it knows, each a switch. An error message (not thrown here) for anything else. */
export function readWorkflowInput(value: unknown): { workflow: DesignWorkflow } | { error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { error: "design.workflow must be { rubric?, chapterReview? } or null." };
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

function moment(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}

/** The reviews of the chapters as a file says them: the whole ones, by the number of the chapter. */
export function normalizeReviewed(value: unknown): Record<string, DesignChapterReview> | undefined {
  const reviewed: Record<string, DesignChapterReview> = {};
  for (const [key, raw] of Object.entries(asRecord(value))) {
    const item = asRecord(raw);
    const at = moment(item.at);
    const overall = item.overall === null ? null : typeof item.overall === "number" && item.overall >= 1 && item.overall <= 10 ? Math.round(item.overall * 10) / 10 : undefined;
    if (!/^\d{1,6}$/.test(key) || typeof item.sig !== "string" || !/^[0-9a-f]{8}$/.test(item.sig) || !at || overall === undefined) continue;
    reviewed[key] = {
      sig: item.sig,
      round: asInteger(item.round, 1, 1, 1000),
      at,
      overall,
      verdict: item.verdict === "revise" ? "revise" : "ok",
      summary: typeof item.summary === "string" ? item.summary.trim().slice(0, DESIGN_SUMMARY_CHARACTERS) : "",
    };
  }
  return Object.keys(reviewed).length ? reviewed : undefined;
}

/** A review of the design on request that goes on, as a file says it: the chapters it looks at (none listed: all), and whether it is over. */
export function normalizeReviewing(value: unknown): AutopilotDesign["reviewing"] {
  const source = asRecord(value);
  const startedAt = moment(source.startedAt);
  if (!startedAt) return undefined;
  const chapters = [...new Set(asArray(source.chapters).filter((number): number is number => typeof number === "number" && Number.isInteger(number) && number >= 1 && number <= 1_000_000))].sort((left, right) => left - right);
  return { startedAt, ...(chapters.length ? { chapters } : {}), ...(source.done === true ? { done: true } : {}) };
}

/** The parts of a design that its reviews wrote, from a file: what `normalizeDesign` adds to the design of every engine before. */
export function normalizeDesignReviews(source: Record<string, unknown>): Partial<AutopilotDesign> {
  const workflow = normalizeWorkflow(source.workflow);
  const rubric = normalizeRubrics(source.rubric);
  const reviewed = normalizeReviewed(source.reviewed);
  const reviewing = normalizeReviewing(source.reviewing);
  return { ...(workflow ? { workflow } : {}), ...(rubric ? { rubric } : {}), ...(reviewed ? { reviewed } : {}), ...(reviewing ? { reviewing } : {}) };
}

/** What a design does besides the plain design, every part resolved: off while the design says nothing of it. */
export interface DesignFlow {
  rubric: boolean;
  chapterReview: boolean;
}

export function designFlow(design: Pick<AutopilotDesign, "workflow" | "reviewing"> | null | undefined): DesignFlow {
  // A review on request is a review: every part that judges is on, whatever the workflow of the design says.
  if (design?.reviewing && !design.reviewing.done) return { rubric: true, chapterReview: true };
  const on = (key: (typeof SWITCHES)[number]) => design?.workflow?.[key] === true;
  return { rubric: on("rubric"), chapterReview: on("chapterReview") };
}
