import { asArray, asInteger, asRecord } from "../util/json.js";
import {
  COHERENCE_FINDINGS_KEPT,
  COHERENCE_KINDS,
  COHERENCE_PROPOSAL_CHARACTERS,
  COHERENCE_SEVERITIES,
  COHERENCE_STATUSES,
  COHERENCE_TEXT_CHARACTERS,
  DESIGN_ALTERNATIVES_MAX,
  DESIGN_ALTERNATIVES_MIN,
  DESIGN_CRITERIA,
  DESIGN_PITCH_FIELD_CHARACTERS,
  DESIGN_PITCH_LOGLINE_CHARACTERS,
  DESIGN_PITCH_PREMISE_CHARACTERS,
  DESIGN_SUMMARY_CHARACTERS,
  type CoherenceFinding,
  type DesignAlternatives,
  type DesignChapterReview,
  type DesignCoherence,
  type DesignPitch,
  type DesignPitchEvaluation,
} from "./design-review-types.js";
import { normalizeRubrics } from "./design-rubric.js";
import type { AutopilotDesign, DesignWorkflow } from "./types.js";

/**
 * What the state of a design keeps of its reviews (`AutopilotDesign.workflow`, `rubric`…), read back from a file. A file that says something that is not what it should
 * is read as the design it can be: a part that is not understood is left out, never guessed. Pure.
 */

/** The parts of the workflow that are a switch. */
const SWITCHES = ["rubric", "chapterReview", "coherence"] as const;
const WORKFLOW_KEYS = [...SWITCHES, "alternatives", "pitchChoice"] as const;

/** The workflow as a file says it: a part that is on is kept, the rest is dropped; `undefined` when nothing is on. */
export function normalizeWorkflow(value: unknown): DesignWorkflow | undefined {
  const source = asRecord(value);
  const workflow: DesignWorkflow = {};
  for (const key of SWITCHES) if (source[key] === true) workflow[key] = true;
  if (typeof source.alternatives === "number" && Number.isInteger(source.alternatives) && source.alternatives >= DESIGN_ALTERNATIVES_MIN && source.alternatives <= DESIGN_ALTERNATIVES_MAX) {
    workflow.alternatives = source.alternatives;
    if (source.pitchChoice === "author") workflow.pitchChoice = "author";
  }
  return Object.keys(workflow).length ? workflow : undefined;
}

/** What a start says of the workflow, checked: the parts it knows. An error message (not thrown here) for anything else. */
export function readWorkflowInput(value: unknown): { workflow: DesignWorkflow } | { error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { error: `design.workflow must be { ${WORKFLOW_KEYS.join("?, ")}? } or null.` };
  const source = value as Record<string, unknown>;
  const unknown = Object.keys(source).filter((key) => !(WORKFLOW_KEYS as readonly string[]).includes(key));
  if (unknown.length) return { error: `design.workflow does not take ${unknown.map((key) => `«${key}»`).join(", ")}: it takes ${WORKFLOW_KEYS.join(", ")}.` };
  const workflow: DesignWorkflow = {};
  for (const key of SWITCHES) {
    if (source[key] === undefined) continue;
    if (typeof source[key] !== "boolean") return { error: `design.workflow.${key} must be true or false.` };
    if (source[key]) workflow[key] = true;
  }
  if (source.alternatives !== undefined) {
    const count = source.alternatives;
    if (typeof count !== "number" || !Number.isInteger(count) || (count !== 0 && (count < DESIGN_ALTERNATIVES_MIN || count > DESIGN_ALTERNATIVES_MAX))) {
      return { error: `design.workflow.alternatives must be 0 (none) or a whole number from ${DESIGN_ALTERNATIVES_MIN} to ${DESIGN_ALTERNATIVES_MAX}.` };
    }
    if (count) workflow.alternatives = count;
  }
  if (source.pitchChoice !== undefined) {
    if (source.pitchChoice !== "author" && source.pitchChoice !== "director") return { error: 'design.workflow.pitchChoice must be "director" or "author".' };
    if (source.pitchChoice === "author") workflow.pitchChoice = "author";
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

function text(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

const PITCH_FIELDS = ["title", "logline", "premise", "protagonist", "stakes", "twist", "tone", "difference"] as const;
const PITCH_LIMITS: Record<(typeof PITCH_FIELDS)[number], number> = {
  title: 120,
  logline: DESIGN_PITCH_LOGLINE_CHARACTERS,
  premise: DESIGN_PITCH_PREMISE_CHARACTERS,
  protagonist: DESIGN_PITCH_FIELD_CHARACTERS,
  stakes: DESIGN_PITCH_FIELD_CHARACTERS,
  twist: DESIGN_PITCH_FIELD_CHARACTERS,
  tone: DESIGN_PITCH_FIELD_CHARACTERS,
  difference: DESIGN_PITCH_FIELD_CHARACTERS,
};

/** The alternatives of a design as a file says them: the pitches that are whole, what was judged of them that is whole, the recommendation and the choice when they name a pitch there is. */
export function normalizeAlternatives(value: unknown): DesignAlternatives | undefined {
  const source = asRecord(value);
  const pitches: DesignPitch[] = [];
  for (const raw of asArray(source.pitches).slice(0, DESIGN_ALTERNATIVES_MAX)) {
    const item = asRecord(raw);
    const fields = Object.fromEntries(PITCH_FIELDS.map((key) => [key, text(item[key], PITCH_LIMITS[key])])) as Record<(typeof PITCH_FIELDS)[number], string>;
    if (typeof item.id !== "string" || !/^p[1-9]\d?$/.test(item.id) || pitches.some((pitch) => pitch.id === item.id) || PITCH_FIELDS.some((key) => !fields[key])) continue;
    pitches.push({ id: item.id, ...fields });
  }
  if (!pitches.length) return undefined;
  const known = new Set(pitches.map((pitch) => pitch.id));
  const evaluations: Record<string, DesignPitchEvaluation[]> = {};
  for (const [id, list] of Object.entries(asRecord(source.evaluations))) {
    if (!known.has(id)) continue;
    const kept: DesignPitchEvaluation[] = [];
    for (const raw of asArray(list).slice(0, 12)) {
      const item = asRecord(raw);
      const scores = asArray(item.scores);
      const vote = (entry: unknown) => (entry === null ? null : typeof entry === "number" && entry >= 1 && entry <= 10 ? Math.round(entry * 10) / 10 : undefined);
      const row = scores.map(vote);
      const overall = vote(item.overall);
      if (typeof item.by !== "string" || !item.by || scores.length !== DESIGN_CRITERIA.length || row.includes(undefined) || overall === undefined) continue;
      kept.push({ by: item.by.slice(0, 80), name: text(item.name, 120), overall, scores: row as Array<number | null>, note: text(item.note, DESIGN_SUMMARY_CHARACTERS) });
    }
    if (kept.length) evaluations[id] = kept;
  }
  const recommended = asRecord(source.recommended);
  const selected = asRecord(source.selected);
  const at = moment(selected.at);
  return {
    pitches,
    evaluations,
    ...(typeof recommended.id === "string" && known.has(recommended.id) ? { recommended: { id: recommended.id, reason: text(recommended.reason, 600) } } : {}),
    ...(typeof selected.id === "string" && known.has(selected.id) && at ? { selected: { id: selected.id, by: selected.by === "author" ? "author" as const : "director" as const, reason: text(selected.reason, 600), at } } : {}),
  };
}

function chapterNumbers(value: unknown): number[] {
  return [...new Set(asArray(value).filter((number): number is number => typeof number === "number" && Number.isInteger(number) && number >= 1 && number <= 1_000_000))].sort((left, right) => left - right).slice(0, 24);
}

function normalizeFinding(raw: unknown): CoherenceFinding | null {
  const item = asRecord(raw);
  const severity = COHERENCE_SEVERITIES.find((entry) => entry === item.severity);
  const body = text(item.text, COHERENCE_TEXT_CHARACTERS);
  if (typeof item.id !== "string" || !/^[ac]-[0-9a-f]{8}$/.test(item.id) || !severity || !body || (item.source !== "check" && item.source !== "ai")) return null;
  const decision = asRecord(item.decision);
  const decidedAt = moment(decision.at);
  const proposal = text(item.proposal, COHERENCE_PROPOSAL_CHARACTERS);
  const reason = text(decision.reason, 600);
  return {
    id: item.id,
    source: item.source,
    kind: COHERENCE_KINDS.find((entry) => entry === item.kind) ?? "other",
    severity,
    chapters: chapterNumbers(item.chapters),
    requires: chapterNumbers(item.requires),
    text: body,
    ...(proposal ? { proposal } : {}),
    owner: item.owner === "author" || item.owner === "both" ? item.owner : "autopilot",
    status: COHERENCE_STATUSES.find((entry) => entry === item.status) ?? "open",
    ...(decidedAt && (decision.by === "author" || decision.by === "director") ? { decision: { by: decision.by, ...(reason ? { reason } : {}), at: decidedAt } } : {}),
    round: asInteger(item.round, 1, 1, 1000),
    seen: asInteger(item.seen, 1, 1, 1000),
  };
}

/** The analysis of the structure as a file says it: the findings that are whole, and what it was made of; nothing when it says no signature or moment. */
export function normalizeCoherence(value: unknown): DesignCoherence | undefined {
  const source = asRecord(value);
  const at = moment(source.at);
  if (typeof source.sig !== "string" || !/^[0-9a-f]{8}$/.test(source.sig) || !at) return undefined;
  const findings = asArray(source.findings).slice(0, COHERENCE_FINDINGS_KEPT).map(normalizeFinding).filter((finding): finding is CoherenceFinding => finding !== null);
  return { sig: source.sig, round: asInteger(source.round, 1, 1, 1000), at, findings, summary: text(source.summary, 800) };
}

/** The parts of a design that its reviews wrote, from a file: what `normalizeDesign` adds to the design of every engine before. */
export function normalizeDesignReviews(source: Record<string, unknown>): Partial<AutopilotDesign> {
  const workflow = normalizeWorkflow(source.workflow);
  const rubric = normalizeRubrics(source.rubric);
  const reviewed = normalizeReviewed(source.reviewed);
  const reviewing = normalizeReviewing(source.reviewing);
  const alternatives = normalizeAlternatives(source.alternatives);
  const coherence = normalizeCoherence(source.coherence);
  return { ...(workflow ? { workflow } : {}), ...(rubric ? { rubric } : {}), ...(reviewed ? { reviewed } : {}), ...(reviewing ? { reviewing } : {}), ...(alternatives ? { alternatives } : {}), ...(coherence ? { coherence } : {}) };
}

/** What a design does besides the plain design, every part resolved: off while the design says nothing of it. */
export interface DesignFlow {
  rubric: boolean;
  chapterReview: boolean;
  /** The whole structure is analysed for what does not hold together. */
  coherence: boolean;
  /** The pitches proposed before the design: how many (0: none), and who chooses. */
  alternatives: number;
  pitchChoice: "director" | "author";
}

export function designFlow(design: Pick<AutopilotDesign, "workflow" | "reviewing"> | null | undefined): DesignFlow {
  // A review on request is a review: every part that judges is on, whatever the workflow of the design says, and nothing is proposed.
  if (design?.reviewing && !design.reviewing.done) return { rubric: true, chapterReview: true, coherence: !design.reviewing.chapters, alternatives: 0, pitchChoice: "director" };
  const on = (key: (typeof SWITCHES)[number]) => design?.workflow?.[key] === true;
  const alternatives = design?.workflow?.alternatives ?? 0;
  return { rubric: on("rubric"), chapterReview: on("chapterReview"), coherence: on("coherence"), alternatives, pitchChoice: alternatives && design?.workflow?.pitchChoice === "author" ? "author" : "director" };
}
