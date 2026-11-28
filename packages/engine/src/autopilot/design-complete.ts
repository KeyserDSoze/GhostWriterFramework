import { OUTLINE_DESIGN_FIELDS, OUTLINE_DESIGN_KEYS, normalizeDesignPatch, type OutlineChapterDesign, type OutlineDesignKey } from "../book/design.js";
import type { OutlineChapterEntry } from "../book/outline.js";
import { asArray, asInteger, asOneOf, asRecord, asString } from "../util/json.js";
import { clipText, isItalian } from "../util/text.js";
import {
  DESIGN_BATCH_CHAPTERS,
  type AutopilotDesign,
  type AutopilotState,
  type DesignCanonProposal,
  type DesignCompletion,
  type DesignCompletionChapter,
  type DesignCompletionFinding,
  type DesignCompletionReading,
  type DesignFieldProposal,
  type DesignFindingSeverity,
  type DesignFindingSource,
  type DesignMode,
  type DesignProposalStatus,
} from "./types.js";

/**
 * «Review and complete» (#125): the design run of a book whose chapters the author has already written in the Synopsis. It does not plan the book again: it reads every
 * chapter of the author's and proposes, for the author to apply, the design fields the entry lacks, the inconsistencies and the weak points that the architect, the
 * simulated readers and the director find, and the canon entries the chapters need and the book lacks (`DesignCompletion`). Nothing of it is written before the author
 * applies it (`design-complete-apply.ts`). This module is what decides, and is pure; the steps are in `design-complete-run.ts`.
 */

/** The twelve criteria of a design, as a finding names the one it is about (the rubric's ids). */
export const DESIGN_FINDING_CRITERIA = ["originality", "engagement", "coherence", "pace", "tension", "characters", "emotion", "dialogue", "twists", "credibility", "subplots", "ending"] as const;
export type DesignFindingCriterion = (typeof DESIGN_FINDING_CRITERIA)[number];

export const DESIGN_FINDING_SEVERITIES: readonly DesignFindingSeverity[] = ["critical", "major", "minor"];
export const DESIGN_CANON_PROPOSAL_KINDS: ReadonlyArray<DesignCanonProposal["kind"]> = ["character", "location", "faction", "item", "secret"];

/** The findings a chapter keeps from one source in one reading, the canon entries proposed in all, and the length of their texts. */
export const COMPLETION_FINDINGS_PER_SOURCE = 8;
export const COMPLETION_CANON_MAX = 24;
export const COMPLETION_FINDING_CHARS = 600;
export const COMPLETION_SUGGESTION_CHARS = 400;
export const COMPLETION_CANON_DESCRIPTION_CHARS = 1200;
export const COMPLETION_READING_CHARS = 1200;
const NAME_CHARS = 160;
const DIGEST_SHAPE = /^[a-f0-9]{8,64}$/;
const MAX_CHAPTER = 100_000;

// ─── Which chapters, and which mode ─────────────────────────────────────────

/** Whether an entry is a chapter the author wrote in the Synopsis, with what happens in it: what «Review and complete» reviews. */
export function isAuthorChapter(entry: Pick<OutlineChapterEntry, "intact" | "unreadable" | "body">): boolean {
  return !entry.intact && !entry.unreadable && entry.body.trim().length > 0;
}

/** The chapters «Review and complete» reviews: the author's entries with their text, in order. */
export function completionChapters(entries: ReadonlyArray<Pick<OutlineChapterEntry, "number" | "intact" | "unreadable" | "body">>): number[] {
  return entries.filter(isAuthorChapter).map((entry) => entry.number).sort((left, right) => left - right);
}

/**
 * Which design run fits the book, and why (#125): «Review and complete» when every chapter of the book (1 to the last entry of the Synopsis) is an entry of the author's
 * that says what happens (`written`); the design that plans the book when some are not (`missing`: they are planned, around the author's), or when there is none
 * (`none`). What the Studio offers first, and says; the author may choose the other.
 */
export interface DesignModeChoice {
  mode: DesignMode;
  reason: "written" | "missing" | "none";
  /** The chapters of the book: the number of the last entry of the Synopsis (0 without entries). */
  chapters: number;
  /** The author's chapters with their text. */
  written: number[];
  /** The chapters of the book without an entry of the author's that says what happens. */
  missing: number[];
}

export function designModeChoice(entries: ReadonlyArray<Pick<OutlineChapterEntry, "number" | "intact" | "unreadable" | "body">>): DesignModeChoice {
  const chapters = entries.reduce((highest, entry) => Math.max(highest, entry.number), 0);
  const written = completionChapters(entries);
  const have = new Set(written);
  const missing: number[] = [];
  for (let number = 1; number <= chapters; number += 1) if (!have.has(number)) missing.push(number);
  if (!written.length) return { mode: "plan", reason: "none", chapters, written, missing };
  return { mode: missing.length ? "plan" : "complete", reason: missing.length ? "missing" : "written", chapters, written, missing };
}

/** The design fields an entry lacks: what «Review and complete» may propose for it. */
export function missingDesignKeys(design: OutlineChapterDesign | undefined): OutlineDesignKey[] {
  return OUTLINE_DESIGN_KEYS.filter((key) => {
    const value = design?.[key];
    return value === undefined || value === null || (Array.isArray(value) && !value.length) || (typeof value === "string" && !value.trim());
  });
}

/** The completion a «Review and complete» begins with: the chapters it reviews, nothing proposed yet. */
export function newCompletion(chapters: readonly number[]): DesignCompletion {
  return { chapters: [...chapters], entries: {}, canon: [], readings: [] };
}

// ─── Where the run stands ────────────────────────────────────────────────────

/** The next step of a «Review and complete» that goes on: the proposals of a batch of chapters, the reading of a reader, the director's review. */
export type CompletionStep =
  | { kind: "design-complete"; chapters: number[] }
  | { kind: "design-complete-reader"; reader: string; readerName: string }
  | { kind: "design-complete-review" };

/** The chapters whose proposals are to be made (never made, or sent back by the director), in order. */
export function pendingCompletionChapters(completion: DesignCompletion): number[] {
  const redo = new Set((completion.redo ?? []).map((entry) => entry.chapter));
  return completion.chapters.filter((number) => !completion.entries[String(number)] || redo.has(number));
}

/** The chapters the next `design-complete` proposes for: up to `DESIGN_BATCH_CHAPTERS` of the pending ones, in order. */
export function completionBatch(completion: DesignCompletion): number[] {
  return pendingCompletionChapters(completion).slice(0, DESIGN_BATCH_CHAPTERS);
}

/** The review (the director's, from 1) that comes next. */
export function completionRound(design: Pick<AutopilotDesign, "rounds">): number {
  return design.rounds.length + 1;
}

/**
 * What a «Review and complete» does next (`null`: it is over, or the state is not one). The proposals of every chapter first, a batch at a time; then, when the policy
 * has the readers read before this review (`readersOnPlan`, and within `readerRounds`), each reader; then the director's review.
 */
export function nextCompletionStep(state: Pick<AutopilotState, "design" | "options">, readers: ReadonlyArray<{ slug: string; name: string }>): CompletionStep | null {
  const design = state.design;
  if (!design || design.mode !== "complete" || design.endedAt || !design.completion) return null;
  const completion = design.completion;
  const batch = completionBatch(completion);
  if (batch.length) return { kind: "design-complete", chapters: batch };
  const round = completionRound(design);
  if (state.options.readersOnPlan && round <= (design.review?.readerRounds ?? 1)) {
    const reader = readers.find((entry) => !completion.readings.some((reading) => reading.slug === entry.slug && reading.round === round) && !completion.skippedReaders?.includes(entry.slug));
    if (reader) return { kind: "design-complete-reader", reader: reader.slug, readerName: reader.name };
  }
  return { kind: "design-complete-review" };
}

/** How many proposals wait for the author, and in how many chapters (the canon proposals count with the chapters that need them). */
export function completionWaiting(completion: DesignCompletion | undefined): { waiting: number; chapters: number } {
  if (!completion || completion.decided) return { waiting: 0, chapters: 0 };
  let waiting = 0;
  const chapters = new Set<number>();
  for (const entry of Object.values(completion.entries)) {
    const count = entry.fields.filter((field) => field.status === "waiting").length + entry.findings.filter((finding) => finding.status === "waiting").length;
    if (count) chapters.add(entry.number);
    waiting += count;
  }
  for (const proposal of completion.canon) {
    if (proposal.status !== "waiting") continue;
    waiting += 1;
    for (const number of proposal.chapters) chapters.add(number);
  }
  return { waiting, chapters: chapters.size };
}

/** What the run says when «Review and complete» is over and its proposals wait for the author. */
export function completionReadyMessage(completion: DesignCompletion | undefined, language: string): string {
  const { waiting, chapters } = completionWaiting(completion);
  const italian = isItalian(language);
  if (!waiting) {
    return italian
      ? "Revisione e completamento finiti: non c'è nulla da proporre, i tuoi capitoli hanno già quello che serve."
      : "Review and complete is done: there is nothing to propose, your chapters already have what they need.";
  }
  return italian
    ? `Revisione e completamento finiti: ${waiting === 1 ? "una proposta ti aspetta" : `${waiting} proposte ti aspettano`} nello Studio, per ${chapters === 1 ? "un capitolo" : `${chapters} capitoli`}. Scegli cosa applicare.`
    : `Review and complete is done: ${waiting === 1 ? "one proposal waits" : `${waiting} proposals wait`} for you in the Studio, for ${chapters === 1 ? "one chapter" : `${chapters} chapters`}. Choose what to apply.`;
}

/** What the steps of «Review and complete» say, in the language of the book. */
export function describeCompletionTask(kind: string, language: string, params: { readerName?: string; from?: number; to?: number }): { title: string; reason: string; next: string } | null {
  const italian = isItalian(language);
  const say = (en: string, it: string) => (italian ? it : en);
  if (kind === "design-complete") {
    const one = params.from === params.to;
    const which = params.from === undefined ? "" : one ? say(` of chapter ${params.from}`, ` del capitolo ${params.from}`) : say(` of chapters ${params.from}-${params.to}`, ` dei capitoli ${params.from}-${params.to}`);
    return {
      title: say(`Reviewing and completing the design${which}`, `Revisione e completamento del progetto${which}`),
      reason: say(
        "Your chapters are read as you wrote them: what their design lacks is proposed, with what does not hold together, and nothing is written until you apply it.",
        "I tuoi capitoli sono letti come li hai scritti: si propone quello che manca al loro progetto, con ciò che non torna, e nulla si scrive finché non lo applichi.",
      ),
      next: say("The simulated readers and the director review the chapters with the proposals.", "I lettori simulati e il direttore valutano i capitoli con le proposte."),
    };
  }
  if (kind === "design-complete-reader") {
    return {
      title: say(`${params.readerName ?? "A reader"} reads your chapters and the proposals`, `${params.readerName ?? "Un lettore"} legge i tuoi capitoli e le proposte`),
      reason: say("The director weighs how the intended audience reacts to the chapters as they are designed.", "Il direttore considera come reagisce il pubblico ai capitoli così come sono progettati."),
      next: say("The director reviews the chapters and the proposals.", "Il direttore valuta i capitoli e le proposte."),
    };
  }
  if (kind === "design-complete-review") {
    return {
      title: say("The director reviews your chapters and the proposals", "Il direttore valuta i tuoi capitoli e le proposte"),
      reason: say(
        "The director finds what is inconsistent or weak in your chapters, and sends back the proposals that do not fit them; your text is never changed.",
        "Il direttore trova ciò che è incoerente o debole nei tuoi capitoli, e rimanda le proposte che non ci stanno; il tuo testo non cambia mai.",
      ),
      next: say("The proposals wait for you in the Studio: apply the ones you choose.", "Le proposte ti aspettano nello Studio: applica quelle che scegli."),
    };
  }
  return null;
}

// ─── What the model gives, as proposals ──────────────────────────────────────

/** A criterion as a model names it, among the twelve; `undefined` for one it does not name (or one that is not among them). */
export function readFindingCriterion(value: unknown): DesignFindingCriterion | undefined {
  const text = asString(value).toLowerCase().replace(/[^a-z]+/g, " ").trim();
  if (!text) return undefined;
  const direct = DESIGN_FINDING_CRITERIA.find((criterion) => text === criterion || text.split(" ").includes(criterion));
  if (direct) return direct;
  const aliases: Array<[string, DesignFindingCriterion]> = [
    ["narrative coherence", "coherence"], ["consisten", "coherence"], ["pacing", "pace"], ["rhythm", "pace"], ["suspense", "tension"], ["character", "characters"],
    ["emotional", "emotion"], ["interaction", "dialogue"], ["twist", "twists"], ["plausib", "credibility"], ["subplot", "subplots"], ["engag", "engagement"], ["original", "originality"],
    ["satisf", "ending"],
  ];
  return aliases.find(([alias]) => text.includes(alias))?.[1];
}

/** The findings a model lists for one chapter, as proposals that wait (`id` from `idOf`); empty texts are left out, and so is anything past the limit. */
export function readCompletionFindings(value: unknown, source: DesignFindingSource, idOf: (index: number) => string, reader?: { slug: string; name: string }): DesignCompletionFinding[] {
  const findings: DesignCompletionFinding[] = [];
  for (const item of asArray(value).map(asRecord)) {
    const text = clipText(asString(item.issue) || asString(item.text), COMPLETION_FINDING_CHARS).trim();
    if (!text) continue;
    const suggestion = clipText(asString(item.suggestion), COMPLETION_SUGGESTION_CHARS).trim();
    const criterion = readFindingCriterion(item.criterion);
    findings.push({
      id: idOf(findings.length),
      source,
      ...(reader ? { reader: reader.slug, by: reader.name } : {}),
      severity: asOneOf(item.severity, DESIGN_FINDING_SEVERITIES, "major"),
      ...(criterion ? { criterion } : {}),
      text,
      ...(suggestion ? { suggestion } : {}),
      status: "waiting",
    });
    if (findings.length >= COMPLETION_FINDINGS_PER_SOURCE) break;
  }
  return findings;
}

/**
 * The fields a model proposes for an entry, as proposals that wait: only the fields the entry lacks (`missing`), made what the files keep (`normalizeDesignPatch`), in
 * the order of a design. A field the entry has is never proposed, whatever the model said.
 */
export function readFieldProposals(value: unknown, missing: readonly OutlineDesignKey[], chapter: number): DesignFieldProposal[] {
  const wanted = new Set(missing);
  const { patch } = normalizeDesignPatch(asRecord(value));
  const fields: DesignFieldProposal[] = [];
  for (const { key } of OUTLINE_DESIGN_FIELDS) {
    if (!wanted.has(key)) continue;
    const proposed = patch[key];
    if (proposed === undefined || proposed === null) continue;
    fields.push({ id: fieldProposalId(chapter, key), key, value: proposed as DesignFieldProposal["value"], status: "waiting" });
  }
  return fields;
}

export function fieldProposalId(chapter: number, key: OutlineDesignKey): string {
  return `f${chapter}-${key}`;
}

/** The id of a canon proposal: its kind and its name, squashed (one proposal for one entity). */
export function canonProposalId(kind: DesignCanonProposal["kind"], name: string): string {
  const squashed = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `c-${kind}-${squashed || "entry"}`;
}

/** The findings of `entry` with the ones of `source` (and of that reader) replaced by `findings`: a new reading says again what it finds. */
export function replaceFindings(entry: DesignCompletionChapter, source: DesignFindingSource, findings: DesignCompletionFinding[], reader?: string): DesignCompletionChapter {
  const kept = entry.findings.filter((finding) => finding.source !== source || (source === "reader" && finding.reader !== reader));
  return { ...entry, findings: [...kept, ...findings] };
}

// ─── The state, read back ────────────────────────────────────────────────────

const STATUSES: readonly DesignProposalStatus[] = ["waiting", "applied", "skipped"];
const SOURCES: readonly DesignFindingSource[] = ["architect", "reader", "director"];
const FIELD_KINDS = new Map(OUTLINE_DESIGN_FIELDS.map((field) => [field.key, field.kind]));

function readChapterNumbers(value: unknown): number[] {
  const numbers = asArray(value).map((item) => asInteger(item, 0, 0, MAX_CHAPTER)).filter((number) => number > 0);
  return [...new Set(numbers)].sort((left, right) => left - right);
}

function readFieldProposal(value: unknown, chapter: number): DesignFieldProposal | null {
  const record = asRecord(value);
  const key = asString(record.key) as OutlineDesignKey;
  const kind = FIELD_KINDS.get(key);
  if (!kind) return null;
  const { patch } = normalizeDesignPatch({ [key]: record.value });
  const proposed = patch[key];
  if (proposed === undefined || proposed === null) return null;
  if (kind === "flag" && typeof proposed !== "boolean") return null;
  return { id: asString(record.id) || fieldProposalId(chapter, key), key, value: proposed as DesignFieldProposal["value"], status: asOneOf(record.status, STATUSES, "waiting") };
}

function readFinding(value: unknown): DesignCompletionFinding | null {
  const record = asRecord(value);
  const text = clipText(asString(record.text), COMPLETION_FINDING_CHARS).trim();
  const id = asString(record.id);
  if (!text || !id) return null;
  const suggestion = clipText(asString(record.suggestion), COMPLETION_SUGGESTION_CHARS).trim();
  const criterion = readFindingCriterion(record.criterion);
  const reader = asString(record.reader);
  const by = clipText(asString(record.by), NAME_CHARS).trim();
  return {
    id,
    source: asOneOf(record.source, SOURCES, "director"),
    ...(reader ? { reader } : {}),
    ...(by ? { by } : {}),
    severity: asOneOf(record.severity, DESIGN_FINDING_SEVERITIES, "major"),
    ...(criterion ? { criterion } : {}),
    text,
    ...(suggestion ? { suggestion } : {}),
    status: asOneOf(record.status, STATUSES, "waiting"),
  };
}

/** The proposals of a «Review and complete» as a file says them (`DesignCompletion`), read softly: what cannot be read is left out. */
export function normalizeCompletion(value: unknown): DesignCompletion | undefined {
  const source = asRecord(value);
  if (!Object.keys(source).length) return undefined;
  const chapters = readChapterNumbers(source.chapters);
  const entries: Record<string, DesignCompletionChapter> = {};
  for (const [key, item] of Object.entries(asRecord(source.entries))) {
    const record = asRecord(item);
    const number = asInteger(record.number, 0, 0, MAX_CHAPTER);
    if (!number || String(number) !== key) continue;
    const digest = asString(record.digest);
    entries[key] = {
      number,
      title: clipText(asString(record.title), NAME_CHARS).trim(),
      digest: DIGEST_SHAPE.test(digest) ? digest : "",
      fields: asArray(record.fields).map((field) => readFieldProposal(field, number)).filter((field): field is DesignFieldProposal => field !== null),
      findings: asArray(record.findings).map(readFinding).filter((finding): finding is DesignCompletionFinding => finding !== null),
    };
  }
  const canon: DesignCanonProposal[] = [];
  for (const item of asArray(source.canon).map(asRecord)) {
    const kind = asOneOf(item.kind, DESIGN_CANON_PROPOSAL_KINDS, "character");
    const name = clipText(asString(item.name), NAME_CHARS).trim();
    if (!name || !DESIGN_CANON_PROPOSAL_KINDS.includes(item.kind as DesignCanonProposal["kind"])) continue;
    canon.push({
      id: asString(item.id) || canonProposalId(kind, name),
      kind,
      name,
      description: clipText(asString(item.description), COMPLETION_CANON_DESCRIPTION_CHARS).trim(),
      chapters: readChapterNumbers(item.chapters),
      status: asOneOf(item.status, STATUSES, "waiting"),
    });
    if (canon.length >= COMPLETION_CANON_MAX) break;
  }
  const readings: DesignCompletionReading[] = [];
  for (const item of asArray(source.readings).map(asRecord)) {
    const slug = asString(item.slug);
    if (!slug) continue;
    readings.push({
      slug,
      name: clipText(asString(item.name), NAME_CHARS).trim() || slug,
      round: asInteger(item.round, 1, 1, 1000),
      score: Math.min(10, Math.max(0, Number(item.score) || 0)),
      summary: clipText(asString(item.summary), COMPLETION_READING_CHARS).trim(),
    });
  }
  const redo = asArray(source.redo).map(asRecord)
    .map((item) => ({ chapter: asInteger(item.chapter, 0, 0, MAX_CHAPTER), notes: asArray(item.notes).map((note) => clipText(asString(note), COMPLETION_FINDING_CHARS).trim()).filter(Boolean).slice(0, 8) }))
    .filter((item) => item.chapter > 0);
  const skipped = asArray(source.skippedReaders).map((item) => asString(item)).filter(Boolean);
  const decided = asRecord(source.decided);
  const decidedAt = asString(decided.at);
  return {
    chapters,
    entries,
    canon,
    ...(redo.length ? { redo } : {}),
    readings,
    ...(skipped.length ? { skippedReaders: [...new Set(skipped)] } : {}),
    ...(source.awaitingAuthor === true ? { awaitingAuthor: true } : {}),
    ...(decidedAt && !Number.isNaN(Date.parse(decidedAt)) ? { decided: { at: decidedAt, applied: asInteger(decided.applied, 0, 0, 1_000_000), skipped: asInteger(decided.skipped, 0, 0, 1_000_000) } } : {}),
  };
}

/** A run starts: what a «Review and complete» left for the author is theirs, and the run goes on past it (pure). */
export function resumeCompletion(state: AutopilotState): AutopilotState {
  const completion = state.design?.completion;
  if (!completion?.awaitingAuthor) return state;
  const { awaitingAuthor: _waiting, ...rest } = completion;
  return { ...state, design: { ...state.design!, completion: rest } };
}
