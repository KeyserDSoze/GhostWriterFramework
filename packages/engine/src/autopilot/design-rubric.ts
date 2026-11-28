import { AiReplyRejectedError } from "../ai/types.js";
import { isItalian } from "../util/text.js";
import { asArray, asRecord } from "../util/json.js";
import {
  DESIGN_CRITERIA,
  DESIGN_ITEMS_MAX,
  DESIGN_ITEM_CHARACTERS,
  DESIGN_REASON_CHARACTERS,
  DESIGN_RUBRIC_HISTORY_MAX,
  DESIGN_RUBRIC_SUBJECTS_MAX,
  DESIGN_WEAK_SCORE,
  type DesignCriterion,
  type DesignCriterionScore,
  type DesignRubricRound,
  type DesignRubricSubject,
  type DesignRubrics,
} from "./design-review-types.js";

/**
 * The rubric of a design: twelve criteria that the director, the simulated readers and the review of every chapter score the same way, so that what is judged can be
 * compared, round after round and subject after subject. A reply is read strictly (`readDesignRubric`): a criterion that is missing, twice, unknown, without a score or
 * with a text over its limits rejects the reply, which is asked again; nothing is cut or filled in. Pure.
 */

interface CriterionInfo {
  en: string;
  it: string;
  /** What the judge asks of the design for this criterion. */
  ask: string;
  /** What the criterion is called by, squashed (`squash`): the id, the labels, and the other words a model uses. */
  aliases: string[];
}

export const DESIGN_CRITERION_INFO: Readonly<Record<DesignCriterion, CriterionInfo>> = {
  originality: { en: "Originality", it: "Originalità", ask: "does it say something that other books do not, or does it repeat what the genre expects?", aliases: ["originalita", "novelty"] },
  engagement: { en: "Engagement", it: "Coinvolgimento", ask: "would a reader want to turn the page, from the first chapter to the last?", aliases: ["coinvolgimento", "interest"] },
  coherence: { en: "Narrative coherence", it: "Coerenza narrativa", ask: "does every chapter follow from the one before, with no contradiction, plot hole or fact that changes?", aliases: ["narrativecoherence", "coerenza", "coerenzanarrativa", "consistency"] },
  pace: { en: "Pace", it: "Ritmo", ask: "is the book paced well: no stretch that drags, none that rushes, chapters of different shapes?", aliases: ["pacing", "ritmo"] },
  tension: { en: "Tension", it: "Tensione", ask: "do the stakes escalate, and is there a question the reader wants answered in every chapter?", aliases: ["tensione", "suspense"] },
  characters: { en: "Character depth", it: "Profondità dei personaggi", ask: "do the characters want something, fear something and change?", aliases: ["characterdepth", "character", "characterisation", "characterization", "profonditadeipersonaggi", "personaggi"] },
  emotion: { en: "Emotional impact", it: "Impatto emotivo", ask: "will the reader feel something at the turning points?", aliases: ["emotionalimpact", "emotions", "impattoemotivo", "emozione"] },
  dialogue: { en: "Planned dialogue and interactions", it: "Dialoghi e interazioni previsti", ask: "do the planned conversations and encounters carry conflict, subtext and information the reader needs?", aliases: ["dialogues", "interactions", "dialogueandinteractions", "planneddialogueandinteractions", "dialoghi", "dialoghieinterazioniprevisti", "interazioni"] },
  twists: { en: "Effectiveness of the twists", it: "Efficacia dei colpi di scena", ask: "are the twists prepared by clues, surprising and fair, and do they change what came before?", aliases: ["twist", "effectivenessofthetwists", "efficaciadeicolpidiscena", "coloridiscena", "colpidiscena"] },
  credibility: { en: "Credibility", it: "Credibilità", ask: "does everyone act for reasons the reader believes, with what they know at that moment?", aliases: ["plausibility", "credibilita", "believability"] },
  subplots: { en: "Subplot quality", it: "Qualità delle sottotrame", ask: "do the subplots enrich the main story and each get an end, none abandoned?", aliases: ["subplot", "subplotquality", "qualitadellesottotrame", "sottotrame"] },
  ending: { en: "Satisfaction of the ending", it: "Soddisfazione del finale", ask: "does the ending pay what the book promised, and does it feel earned?", aliases: ["endingsatisfaction", "satisfactionoftheending", "finale", "soddisfazionedelfinale"] },
};

export function designCriterionLabel(criterion: DesignCriterion, language?: string): string {
  return isItalian(language) ? DESIGN_CRITERION_INFO[criterion].it : DESIGN_CRITERION_INFO[criterion].en;
}

/** A word reduced to its letters, in lower case and without accents: how criteria are compared. */
function squash(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z]/g, "");
}

const CRITERION_BY_WORD: ReadonlyMap<string, DesignCriterion> = new Map(
  DESIGN_CRITERIA.flatMap((criterion) => [
    [squash(criterion), criterion] as const,
    [squash(DESIGN_CRITERION_INFO[criterion].en), criterion] as const,
    [squash(DESIGN_CRITERION_INFO[criterion].it), criterion] as const,
    ...DESIGN_CRITERION_INFO[criterion].aliases.map((alias) => [alias, criterion] as const),
  ]),
);

/** The criterion a word names (its id, its label in either language, or a usual alias), `null` when it names none. */
export function designCriterionOf(value: unknown): DesignCriterion | null {
  return typeof value === "string" ? CRITERION_BY_WORD.get(squash(value)) ?? null : null;
}

/** What the reply of a judge may leave out: nothing (the design as a whole is judged on all twelve), or the criteria that do not apply (a chapter, a pitch). */
export type DesignRubricMode = "all" | "applicable";

/** The fewest criteria that must apply when a judge may leave some out: a subject judged on less says nothing. */
export const DESIGN_RUBRIC_MIN_APPLICABLE = 4;

/** The `rubric` property of a reply schema: the twelve criteria, each with its score, its reason, its issues and its proposals. */
export function designRubricProperty(mode: DesignRubricMode, description?: string): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    criterion: { type: "string", enum: [...DESIGN_CRITERIA], description: "One of the twelve criteria, by its id." },
    ...(mode === "applicable" ? { applicable: { type: "boolean", description: "False when the criterion does not apply to what is judged: then give score 0 and say why in the reason." } } : {}),
    score: { type: "number", description: "From 1 to 10, one decimal." },
    reason: { type: "string", description: `Why this score, one or two sentences, under ${DESIGN_REASON_CHARACTERS - 100} characters.` },
    issues: { type: "array", items: { type: "string" }, description: `What is wrong, one thing each, at most ${DESIGN_ITEMS_MAX}. Empty when nothing.` },
    proposals: { type: "array", items: { type: "string" }, description: `What you would do instead, one thing each, at most ${DESIGN_ITEMS_MAX}. Never empty for a score under ${DESIGN_WEAK_SCORE}.` },
  };
  return {
    type: "array",
    description: description ?? "The rubric: every one of the twelve criteria exactly once, in this order: " + DESIGN_CRITERIA.join(", ") + ".",
    items: { type: "object", properties, required: ["criterion", ...(mode === "applicable" ? ["applicable"] : []), "score", "reason", "issues", "proposals"] },
  };
}

/** The notes of a revision a rubric adds to what the director asked: the weakest criteria, at most this many. */
export const DESIGN_RUBRIC_NOTES = 4;

/** The scale of a score, one decimal: `null` for anything that is not a number from 1 to 10 (a numeric string with a decimal comma included). */
function scoreOf(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\s*\d+(?:[.,]\d+)?\s*$/.test(value) ? Number(value.replace(",", ".")) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 10) return null;
  return Math.round(parsed * 10) / 10;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The rubric a judge returned, checked and read. Throws a retryable `AiReplyRejectedError` that says what is wrong (and never quotes the reply) when the rubric is not
 * an array, a criterion is unknown, repeated or missing, a score is not a number from 1 to 10, a reason is empty, or a text is over its limit: the reply is asked again,
 * whole, and what was returned is never cut. With `mode: "applicable"` a criterion may be marked `applicable: false` (or scored 0), as long as `DESIGN_RUBRIC_MIN_APPLICABLE` apply.
 */
export function readDesignRubric(value: unknown, input: { subject: string; mode: DesignRubricMode }): DesignCriterionScore[] {
  const problems: string[] = [];
  const found = new Map<DesignCriterion, DesignCriterionScore>();
  if (!Array.isArray(value)) throw new AiReplyRejectedError(`${input.subject} was rejected: the field "rubric" must be a list of the twelve criteria (${DESIGN_CRITERIA.join(", ")}), each with its score, reason, issues and proposals.`);
  value.forEach((item, index) => {
    const record = asRecord(item);
    const criterion = designCriterionOf(record.criterion);
    if (!criterion) {
      problems.push(`rubric item ${index + 1} names no criterion of the twelve`);
      return;
    }
    if (found.has(criterion)) {
      problems.push(`«${criterion}» is scored twice`);
      return;
    }
    const inapplicable = input.mode === "applicable" && (record.applicable === false || record.score === 0 || record.score === "0");
    const reason = textOf(record.reason);
    if (inapplicable) {
      if (reason.length > DESIGN_REASON_CHARACTERS) problems.push(`the reason of «${criterion}» is ${reason.length} characters long, over the ${DESIGN_REASON_CHARACTERS} allowed: return it shorter, whole`);
      found.set(criterion, { criterion, score: null, reason, issues: [], proposals: [] });
      return;
    }
    const score = scoreOf(record.score);
    if (score === null) problems.push(`the score of «${criterion}» is not a number from 1 to 10`);
    if (!reason) problems.push(`«${criterion}» has no reason`);
    else if (reason.length > DESIGN_REASON_CHARACTERS) problems.push(`the reason of «${criterion}» is ${reason.length} characters long, over the ${DESIGN_REASON_CHARACTERS} allowed: return it shorter, whole`);
    const lists = (["issues", "proposals"] as const).map((key) => {
      const raw = record[key];
      if (raw === undefined || raw === null) return [] as string[];
      if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
        problems.push(`the ${key} of «${criterion}» must be a list of texts`);
        return [] as string[];
      }
      const entries = raw.map((entry) => entry.trim()).filter(Boolean);
      if (entries.length > DESIGN_ITEMS_MAX) problems.push(`«${criterion}» has ${entries.length} ${key}, over the ${DESIGN_ITEMS_MAX} allowed: return the most important ones`);
      const tooLong = entries.find((entry) => entry.length > DESIGN_ITEM_CHARACTERS);
      if (tooLong) problems.push(`an entry of the ${key} of «${criterion}» is ${tooLong.length} characters long, over the ${DESIGN_ITEM_CHARACTERS} allowed: return it shorter, whole`);
      return entries;
    });
    found.set(criterion, { criterion, score, reason, issues: lists[0], proposals: lists[1] });
  });
  const missing = DESIGN_CRITERIA.filter((criterion) => !found.has(criterion));
  if (missing.length) problems.push(`the criteria ${missing.map((criterion) => `«${criterion}»`).join(", ")} ${missing.length === 1 ? "is" : "are"} missing`);
  const applicable = [...found.values()].filter((entry) => entry.score !== null).length;
  if (input.mode === "applicable" && !missing.length && applicable < DESIGN_RUBRIC_MIN_APPLICABLE && !problems.length) problems.push(`only ${applicable} ${applicable === 1 ? "criterion is" : "criteria are"} scored: at least ${DESIGN_RUBRIC_MIN_APPLICABLE} must apply`);
  if (problems.length) {
    const listed = problems.slice(0, 6).join("; ");
    throw new AiReplyRejectedError(`${input.subject} was rejected: ${listed}${problems.length > 6 ? `; and ${problems.length - 6} more` : ""}. Return the twelve criteria once each, scored from 1 to 10.`);
  }
  return DESIGN_CRITERIA.map((criterion) => found.get(criterion)!);
}

/** Tokens a reply adds to its output when it carries the rubric of a subject (twelve criteria with their reasons, issues and proposals). */
export const DESIGN_RUBRIC_TOKENS = 2200;

/** The mean of the scores that apply, one decimal; `null` when none does. */
export function rubricOverall(scores: readonly DesignCriterionScore[]): number | null {
  const applicable = scores.filter((entry): entry is DesignCriterionScore & { score: number } => entry.score !== null);
  if (!applicable.length) return null;
  return Math.round((applicable.reduce((sum, entry) => sum + entry.score, 0) / applicable.length) * 10) / 10;
}

/** The criteria that fell short (under `below`), the lowest first. */
export function weakCriteria(scores: readonly DesignCriterionScore[], below = DESIGN_WEAK_SCORE): DesignCriterionScore[] {
  return scores.filter((entry) => entry.score !== null && entry.score < below).sort((left, right) => (left.score ?? 0) - (right.score ?? 0));
}

/** The twelve scores in the order of `DESIGN_CRITERIA`. */
export function rubricRow(scores: readonly DesignCriterionScore[]): Array<number | null> {
  return DESIGN_CRITERIA.map((criterion) => scores.find((entry) => entry.criterion === criterion)?.score ?? null);
}

/**
 * The rubric of a subject written down: its scoring is its `latest` (whole, or for a chapter the weak points only) and its row of scores joins its history, so that the
 * way it went from round to round can be told. The history keeps the last `DESIGN_RUBRIC_HISTORY_MAX` reviews; the subjects, `DESIGN_RUBRIC_SUBJECTS_MAX`.
 */
export function recordRubric(rubrics: DesignRubrics | undefined, key: string, scores: readonly DesignCriterionScore[], at: { round: number; at: string }, options: { whole: boolean }): DesignRubrics {
  const next: DesignRubrics = { ...(rubrics ?? {}) };
  const history: DesignRubricRound[] = [...(next[key]?.history ?? []), { round: at.round, overall: rubricOverall(scores), scores: rubricRow(scores), at: at.at }].slice(-DESIGN_RUBRIC_HISTORY_MAX);
  const latest = options.whole ? scores.map((entry) => ({ ...entry })) : weakCriteria(scores).map((entry) => ({ ...entry }));
  next[key] = { latest, history };
  const keys = Object.keys(next);
  if (keys.length > DESIGN_RUBRIC_SUBJECTS_MAX) {
    const newest = (subject: DesignRubricSubject) => subject.history[subject.history.length - 1]?.at ?? "";
    for (const stale of keys.filter((entry) => entry !== key).sort((left, right) => newest(next[left]).localeCompare(newest(next[right]))).slice(0, keys.length - DESIGN_RUBRIC_SUBJECTS_MAX)) delete next[stale];
  }
  return next;
}

/** How a subject's overall went since its first review: the last minus the first, one decimal; `null` with one review, or when a review had no score. */
export function rubricTrend(subject: DesignRubricSubject | undefined): number | null {
  const history = subject?.history ?? [];
  if (history.length < 2) return null;
  const first = history[0].overall;
  const last = history[history.length - 1].overall;
  return first === null || last === null ? null : Math.round((last - first) * 10) / 10;
}

/** The rule every judge of a design is given for the rubric, in a prompt. */
export function designRubricRule(mode: DesignRubricMode): string[] {
  return [
    mode === "all"
      ? "RUBRIC: score every one of these twelve criteria, each once, from 1 to 10 (one decimal), with a reason of one or two sentences:"
      : `RUBRIC: score these twelve criteria, each once, from 1 to 10 (one decimal), with a reason of one or two sentences. A criterion that does not apply to what you judge is marked applicable: false, with score 0 (at least ${DESIGN_RUBRIC_MIN_APPLICABLE} must apply):`,
    ...DESIGN_CRITERIA.map((criterion) => `- ${criterion}: ${DESIGN_CRITERION_INFO[criterion].ask}`),
    `For every criterion under ${DESIGN_WEAK_SCORE}, give its issues (what is wrong) and its proposals (what you would do instead): concrete, a line each, no more than ${DESIGN_ITEMS_MAX}. Keep every text whole and short: a reply with a text over its limit is rejected.`,
  ];
}

/** A rubric told in a line for a prompt: `originality 7.5, engagement 6 …`, the weak ones marked. */
export function rubricLine(scores: readonly DesignCriterionScore[]): string {
  return scores.filter((entry) => entry.score !== null).map((entry) => `${entry.criterion} ${entry.score}${entry.score! < DESIGN_WEAK_SCORE ? "!" : ""}`).join(", ");
}

/** What a judge proposed for the criteria that fell short, as instructions of a revision: `criterion — proposal` (the reason when it gave no proposal), the lowest first. */
export function rubricProposals(scores: readonly DesignCriterionScore[], limit = 3): string[] {
  const notes: string[] = [];
  for (const entry of weakCriteria(scores)) {
    const text = entry.proposals[0] ?? entry.issues[0] ?? entry.reason;
    if (text) notes.push(`${entry.criterion} (${entry.score}) — ${text}`);
    if (notes.length >= limit) break;
  }
  return notes;
}

/** The reading of a rubric a state file holds: only what is whole is kept (a subject that cannot be read is dropped, never half-read). */
export function normalizeRubrics(value: unknown): DesignRubrics | undefined {
  const source = asRecord(value);
  const rubrics: DesignRubrics = {};
  for (const [key, raw] of Object.entries(source)) {
    if (!/^(design|reader:[A-Za-z0-9][A-Za-z0-9_-]*|chapter:\d{1,6}|pitch:[A-Za-z0-9][A-Za-z0-9_-]*)$/.test(key)) continue;
    const subject = asRecord(raw);
    const history: DesignRubricRound[] = [];
    for (const item of asArray(subject.history).slice(-DESIGN_RUBRIC_HISTORY_MAX)) {
      const round = asRecord(item);
      const scores = asArray(round.scores);
      const at = typeof round.at === "string" ? round.at : "";
      if (scores.length !== DESIGN_CRITERIA.length || !at || !Number.isFinite(Date.parse(at))) continue;
      const row = scores.map((score) => (score === null ? null : scoreOf(score)));
      const overall = round.overall === null ? null : scoreOf(round.overall);
      if (row.some((score, index) => score === null && scores[index] !== null) || (round.overall !== null && overall === null)) continue;
      history.push({ round: Number.isFinite(round.round) ? Math.max(1, Math.round(round.round as number)) : history.length + 1, overall, scores: row, at });
    }
    if (!history.length) continue;
    const latest: DesignCriterionScore[] = [];
    for (const item of asArray(subject.latest)) {
      const entry = asRecord(item);
      const criterion = designCriterionOf(entry.criterion);
      if (!criterion || latest.some((existing) => existing.criterion === criterion)) continue;
      const score = entry.score === null ? null : scoreOf(entry.score);
      if (entry.score !== null && score === null) continue;
      const list = (items: unknown) => asArray(items).filter((text): text is string => typeof text === "string" && text.trim().length > 0).map((text) => text.trim()).slice(0, DESIGN_ITEMS_MAX);
      latest.push({ criterion, score, reason: textOf(entry.reason), issues: list(entry.issues), proposals: list(entry.proposals) });
    }
    rubrics[key] = { latest, history };
  }
  return Object.keys(rubrics).length ? rubrics : undefined;
}
