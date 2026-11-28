import { requireStructuredFields } from "../ai/structured.js";
import { AI_CAPABILITIES, AiReplyRejectedError } from "../ai/types.js";
import { activeReaders, canonManifest } from "../book/context.js";
import { directorSystemPrompt } from "../director/opinion.js";
import { brainstormerPrompt } from "../profiles/brainstormer.js";
import { readerPersonaSystemPrompt } from "../profiles/readers.js";
import { asArray, asRecord } from "../util/json.js";
import { isItalian, languageName, truncate } from "../util/text.js";
import { AutopilotDesignError } from "./design.js";
import {
  DESIGN_PITCH_FIELD_CHARACTERS,
  DESIGN_PITCH_LOGLINE_CHARACTERS,
  DESIGN_PITCH_PREMISE_CHARACTERS,
  DESIGN_SUMMARY_CHARACTERS,
  type DesignAlternatives,
  type DesignCriterionScore,
  type DesignPitch,
  type DesignPitchEvaluation,
} from "./design-review-types.js";
import { DESIGN_RUBRIC_TOKENS, designRubricRule, readDesignRubric, recordRubric, rubricLine, rubricOverall, rubricRow } from "./design-rubric.js";
import { designFlow } from "./design-state.js";
import { DESIGN_PITCHES_ROLE, DESIGN_PITCHES_TOOL, PITCH_DIRECTOR_RULES, PITCH_READER_ROLE, designArchitectSystem, designPitchEvaluationTool } from "./prompts.js";

export { DESIGN_PITCHES_ROLE };
import { authorRules, bookHeader, briefBlock, data, outputLimit, readerReply, request, type TaskContext, type TaskResult } from "./tasks.js";
import type { AutopilotState } from "./types.js";

/**
 * The alternatives of a design run: before the book is designed, the Brainstormer proposes several pitches from the idea of the author (`design-pitches`), the simulated readers
 * and the director judge each on the rubric, and one is chosen, with its reason, by the director or by the author when the design asks for the author's choice
 * (`design-pitch-review`). The concept is made of the pitch that was chosen. Pitches are proposals: the author's idea is the one thing none of them may contradict.
 */

export { DESIGN_PITCHES_TOOL, designPitchEvaluationTool } from "./prompts.js";

type PitchField = "title" | "logline" | "premise" | "protagonist" | "stakes" | "twist" | "tone" | "difference";

function pitchText(pitch: DesignPitch): string {
  return [
    `Pitch ${pitch.id}: «${pitch.title}»`,
    `Logline: ${pitch.logline}`,
    `Premise: ${pitch.premise}`,
    `Protagonist: ${pitch.protagonist}`,
    `Stakes: ${pitch.stakes}`,
    `Twist: ${pitch.twist}`,
    `Tone: ${pitch.tone}`,
    `What makes it different: ${pitch.difference}`,
  ].join("\n");
}

/** The pitches told for a prompt. */
function pitchesSection(label: string, pitches: readonly DesignPitch[]): string {
  return `${label}:\n${pitches.map(pitchText).join("\n\n")}`;
}

/** What a concept is told of the pitch that was chosen: the whole pitch, and the titles of the others for contrast. Empty when the design chose none. */
export function chosenPitchBlock(design: { alternatives?: DesignAlternatives } | undefined): string {
  const alternatives = design?.alternatives;
  const chosen = alternatives?.pitches.find((pitch) => pitch.id === alternatives.selected?.id);
  if (!alternatives || !chosen) return "";
  const others = alternatives.pitches.filter((pitch) => pitch !== chosen);
  return [
    `THE CHOSEN PITCH (${alternatives.selected?.by === "author" ? "the author chose it" : "the director chose it"}${alternatives.selected?.reason ? `: ${alternatives.selected.reason}` : ""}). Develop the book from this pitch, in its own direction:`,
    pitchText(chosen),
    others.length ? `PITCHES NOT CHOSEN (for contrast: take from them only what the chosen pitch can use): ${others.map((pitch) => `«${pitch.title}»`).join(", ")}.` : "",
  ].filter(Boolean).join("\n");
}

const WORD = /[\p{L}\p{N}]+/gu;

/** How much two texts share, from 0 to 1: the words of the smaller that are in the other. */
function overlap(left: string, right: string): number {
  const a = new Set(left.toLowerCase().match(WORD) ?? []);
  const b = new Set(right.toLowerCase().match(WORD) ?? []);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

/** The pitches of a reply, checked and read: exactly `count`, each whole and within its limits, no two the same book. Throws a retryable `AiReplyRejectedError`. */
export function readDesignPitches(value: unknown, count: number): DesignPitch[] {
  const subject = "The pitches";
  const items = asArray(value).map(asRecord);
  if (items.length !== count) throw new AiReplyRejectedError(`${subject} were rejected: ${items.length} pitches were returned, but exactly ${count} were asked.`);
  const limits: Record<PitchField, number> = { title: 120, logline: DESIGN_PITCH_LOGLINE_CHARACTERS, premise: DESIGN_PITCH_PREMISE_CHARACTERS, protagonist: DESIGN_PITCH_FIELD_CHARACTERS, stakes: DESIGN_PITCH_FIELD_CHARACTERS, twist: DESIGN_PITCH_FIELD_CHARACTERS, tone: DESIGN_PITCH_FIELD_CHARACTERS, difference: DESIGN_PITCH_FIELD_CHARACTERS };
  const problems: string[] = [];
  const pitches = items.map((item, index): DesignPitch => {
    const id = `p${index + 1}`;
    const fields = {} as Record<PitchField, string>;
    for (const key of Object.keys(limits) as PitchField[]) {
      const text = typeof item[key] === "string" ? (item[key] as string).trim() : "";
      if (!text) problems.push(`pitch ${index + 1} has no ${key}`);
      else if (text.length > limits[key]) problems.push(`the ${key} of pitch ${index + 1} is ${text.length} characters long, over the ${limits[key]} allowed: return it shorter, whole`);
      fields[key] = text;
    }
    return { id, ...fields };
  });
  for (let left = 0; left < pitches.length; left += 1) {
    for (let right = left + 1; right < pitches.length; right += 1) {
      if (pitches[left].title.toLowerCase() === pitches[right].title.toLowerCase() || overlap(pitches[left].logline, pitches[right].logline) >= 0.8) problems.push(`pitches ${left + 1} and ${right + 1} are the same book: propose different ones`);
    }
  }
  if (problems.length) throw new AiReplyRejectedError(`${subject} were rejected: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? `; and ${problems.length - 5} more` : ""}.`);
  return pitches;
}

/** The judgements of a reply that judges the pitches: one for each pitch, each with a note and a rubric read strictly. Throws a retryable `AiReplyRejectedError`. */
export function readPitchEvaluations(value: unknown, ids: readonly string[], subject: string): Map<string, { note: string; scores: DesignCriterionScore[] }> {
  const items = asArray(value).map(asRecord);
  const found = new Map<string, { note: string; scores: DesignCriterionScore[] }>();
  for (const id of ids) {
    const matching = items.filter((item) => typeof item.id === "string" && item.id.trim().toLowerCase() === id);
    if (matching.length !== 1) throw new AiReplyRejectedError(`${subject} was rejected: ${matching.length ? `pitch ${id} is judged ${matching.length} times` : `pitch ${id} is not judged`}. Return one judgement for each of the pitches ${ids.join(", ")}.`);
    const note = typeof matching[0].note === "string" ? matching[0].note.trim() : "";
    if (!note) throw new AiReplyRejectedError(`${subject} was rejected: the note of pitch ${id} is missing.`);
    if (note.length > DESIGN_SUMMARY_CHARACTERS) throw new AiReplyRejectedError(`${subject} was rejected: the note of pitch ${id} is ${note.length} characters long, over the ${DESIGN_SUMMARY_CHARACTERS} allowed: return it shorter, whole.`);
    found.set(id, { note, scores: readDesignRubric(matching[0].rubric, { subject: `${subject} (pitch ${id})`, mode: "applicable" }) });
  }
  return found;
}

function evaluationOf(by: string, name: string, judged: { note: string; scores: DesignCriterionScore[] }): DesignPitchEvaluation {
  return { by, name, overall: rubricOverall(judged.scores), scores: rubricRow(judged.scores), note: judged.note };
}

/** The pitches of the Brainstormer (`design-pitches`): one call, as many as the workflow asks, each a different book. */
export async function runDesignPitches(ctx: TaskContext): Promise<TaskResult> {
  const design = ctx.state.design!;
  const italian = isItalian(ctx.language);
  const count = designFlow(design).alternatives;
  const response = await ctx.ai({
    capability: AI_CAPABILITIES.writer,
    label: "autopilot:design-pitches",
    system: designArchitectSystem(ctx.language, ctx.brainstormer ? brainstormerPrompt(ctx.brainstormer) : null) + `\n\n${DESIGN_PITCHES_ROLE}`,
    user: `${request([
      `Propose exactly ${count} alternative pitches for this novel, from the author's description.`,
      `Write every text in ${languageName(ctx.language)}. Keep every text whole and short: a text over its limit is rejected.`,
      authorRules(ctx, false),
    ])}\n\n${data([
      bookHeader(ctx),
      briefBlock(ctx),
      ctx.snapshot.canon.length ? `EXISTING CANON (the pitches respect it):\n${canonManifest(ctx.snapshot, { includeSecrets: true })}` : "",
    ])}`,
    json: DESIGN_PITCHES_TOOL,
    maxOutputTokens: outputLimit(ctx, 700 * count + 500),
  });
  const output = requireStructuredFields(response.json, { pitches: "present" }, "The pitches");
  const pitches = readDesignPitches(output.pitches, count);
  design.alternatives = { pitches, evaluations: {} };
  ctx.insight(
    "info",
    italian ? `${count} pitch alternativi proposti dal Brainstormer` : `${count} alternative pitches proposed by the Brainstormer`,
    pitches.map((pitch) => `${pitch.id}: «${pitch.title}» — ${pitch.logline}`).join("\n"),
    { code: "designPitches", figures: { chapters: count } },
  );
  return { changes: [], summary: pitches.map((pitch) => `${pitch.id} ${pitch.title}`).join("; ") };
}

/**
 * The judgement of the pitches (`design-pitch-review`): each simulated reader of the panel (when the design uses readers) and then the director judge every pitch on the rubric,
 * and the director recommends one with its reason. The director chooses it, unless the design asks for the author's choice: then the run waits for the author.
 */
export async function runDesignPitchReview(ctx: TaskContext): Promise<TaskResult> {
  const design = ctx.state.design!;
  const alternatives = design.alternatives;
  if (!alternatives?.pitches.length) return { changes: [], summary: "No pitches to judge." };
  const italian = isItalian(ctx.language);
  const flow = designFlow(design);
  const ids = alternatives.pitches.map((pitch) => pitch.id);
  const names = new Map(alternatives.pitches.map((pitch) => [pitch.id, pitch.title]));
  const material = [bookHeader(ctx), briefBlock(ctx), pitchesSection("THE PITCHES", alternatives.pitches)];
  const rubric = designRubricRule("applicable");
  const evaluations: Record<string, DesignPitchEvaluation[]> = {};
  const note = (id: string, evaluation: DesignPitchEvaluation) => {
    (evaluations[id] ??= []).push(evaluation);
  };
  const readers = ctx.state.options.readersOnPlan ? activeReaders(ctx.readerPanel, ctx.director, ctx.state.options.maxReaders) : [];
  for (const reader of readers) {
    const asked = await readerReply(ctx, ctx.ai({
      capability: AI_CAPABILITIES.reader,
      label: `autopilot:design-pitch-reader:${reader.slug}`,
      system: `${readerPersonaSystemPrompt(reader, languageName(ctx.language), "brief")}\n\n${PITCH_READER_ROLE}`,
      user: `${request(["React as this reader to every pitch: would you read that book? What excites you, what is predictable, what would you do instead?", ...rubric])}\n\n${data(material)}`,
      json: designPitchEvaluationTool("reader"),
      maxOutputTokens: outputLimit(ctx, Math.round(DESIGN_RUBRIC_TOKENS * 0.5) * ids.length + 400),
    }), (response) => readPitchEvaluations(requireStructuredFields(response.json, { pitches: "present" }, "The reader's reaction").pitches, ids, "The reader's reaction"));
    if ("skipped" in asked) {
      ctx.insight("warning", italian ? `${reader.name} saltato: la risposta è rimasta incompleta anche dopo un nuovo tentativo.` : `${reader.name} skipped: the reply stayed incomplete after a retry.`, asked.skipped.message);
      continue;
    }
    for (const id of ids) note(id, evaluationOf(reader.slug, reader.name, asked.value.get(id)!));
  }
  const readersSection = Object.keys(evaluations).length
    ? `WHAT THE SIMULATED READERS THOUGHT (weight each by the reader's weight; they are opinions, not orders):\n${ids.map((id) => `Pitch ${id}: ${(evaluations[id] ?? []).map((evaluation) => `${evaluation.name} ${evaluation.overall ?? "-"}/10 — ${evaluation.note}`).join(" | ")}`).join("\n")}`
    : "";
  const choice = flow.pitchChoice === "author"
    ? "The author will choose among the pitches: recommend the one you would choose and say why, and the author will decide."
    : "You choose the pitch the book is designed from: say why, and what the others have that is worth keeping.";
  const response = await ctx.ai({
    capability: AI_CAPABILITIES.director,
    label: "autopilot:design-pitch-review",
    system: directorSystemPrompt(ctx.director, ctx.language),
    user: `${request(["Judge the alternative pitches before the book is designed.", ...PITCH_DIRECTOR_RULES, choice, ...rubric, authorRules(ctx, false)])}\n\n${data([...material, readersSection])}`,
    json: designPitchEvaluationTool("director"),
    maxOutputTokens: outputLimit(ctx, Math.round(DESIGN_RUBRIC_TOKENS * 0.5) * ids.length + 900),
  });
  const output = requireStructuredFields(response.json, { pitches: "present", recommended: "text", reason: "text" }, "The director's judgement of the pitches");
  const judged = readPitchEvaluations(output.pitches, ids, "The director's judgement of the pitches");
  const recommended = String(output.recommended).trim().toLowerCase();
  if (!ids.includes(recommended)) throw new AiReplyRejectedError(`The director's judgement of the pitches was rejected: «${recommended.slice(0, 20)}» is not a pitch. Recommend one of ${ids.join(", ")}.`);
  const reason = String(output.reason).trim();
  if (reason.length > DESIGN_SUMMARY_CHARACTERS * 1.5) throw new AiReplyRejectedError(`The director's judgement of the pitches was rejected: the reason is ${reason.length} characters long, over the ${DESIGN_SUMMARY_CHARACTERS * 1.5} allowed: return it shorter, whole.`);
  const at = ctx.now().toISOString();
  let rubrics = design.rubric;
  for (const id of ids) {
    note(id, evaluationOf("director", ctx.director.name, judged.get(id)!));
    rubrics = recordRubric(rubrics, `pitch:${id}`, judged.get(id)!.scores, { round: 1, at }, { whole: true });
  }
  design.rubric = rubrics;
  design.alternatives = { ...alternatives, evaluations, recommended: { id: recommended, reason } };
  const title = names.get(recommended)!;
  if (flow.pitchChoice === "director") {
    design.alternatives.selected = { id: recommended, by: "director", reason, at };
    ctx.insight("ok", italian ? `Pitch scelto dal direttore: «${title}»` : `Pitch chosen by the director: «${title}»`, reason, { code: "designPitchChosen" });
  } else {
    ctx.insight("info", italian ? `Il direttore consiglia il pitch «${title}»: scegli tu` : `The director recommends the pitch «${title}»: the choice is yours`, reason, { code: "designPitchChoice" });
  }
  const best = judged.get(recommended)!.scores;
  return { changes: [], summary: `${recommended}: ${truncate(reason, 200)} (${rubricLine(best.filter((entry) => entry.score !== null && entry.score < 7)) || "no weak criterion"})` };
}

export interface DesignPitchChoice {
  id: string;
  /** Why, in the author's words (optional). */
  reason?: string;
}

/**
 * The state after the author chose a pitch (`AutopilotSession.chooseDesignPitch`). Throws an `AutopilotDesignError`: `no_pitches` (the design has proposed none),
 * `unknown_pitch` (the id names none), `pitch_locked` (the concept is made of a pitch already: the book was designed from it).
 */
export function chooseDesignPitch(state: AutopilotState, input: DesignPitchChoice, at: string): AutopilotState {
  const alternatives = state.design?.alternatives;
  if (!alternatives?.pitches.length) throw new AutopilotDesignError("no_pitches", "The design has proposed no pitches to choose from.");
  const id = typeof input.id === "string" ? input.id.trim().toLowerCase() : "";
  if (!alternatives.pitches.some((pitch) => pitch.id === id)) throw new AutopilotDesignError("unknown_pitch", `There is no pitch ${typeof input.id === "string" ? `«${input.id.slice(0, 20)}»` : "with that id"}: choose one of ${alternatives.pitches.map((pitch) => pitch.id).join(", ")}.`);
  if (state.concept.done) throw new AutopilotDesignError("pitch_locked", "The book was designed from the pitch already chosen: a design from another pitch begins from a new design.");
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 600) : "";
  const next = structuredClone(state);
  next.design!.alternatives = { ...alternatives, selected: { id, by: "author", reason, at } };
  return next;
}
