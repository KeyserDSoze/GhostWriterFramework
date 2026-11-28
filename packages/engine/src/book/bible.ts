import { parseMarkdown, renderMarkdown } from "../markdown/frontmatter.js";
import { clipText, isItalian, truncate } from "../util/text.js";
import { designFingerprint, ledgerChapter } from "./design.js";
import { chapterNumberFromSlug } from "./paths.js";

/**
 * The decisions of a book, its open questions and its setup/payoff threads: the files of `bible/` that hold the story's agreements (`bible/decisions.md`, `bible/threads.md`).
 * Like `bible/themes.md` and `bible/world.md` (see `./design.ts`) they are the author's files: structured frontmatter, free notes in the body, read softly (what cannot be read is
 * said and left out, a key the engine does not know is kept), written by the engine and by the author in the Bible, and read by every agent that works on the book.
 *
 * A decision is LOCKED when the author says so, and from then on it binds every agent: the design run, the writing autopilot, Brainstorming and the Copilot are told it in their
 * instructions, and a change that contradicts it (`decisionConflicts`, which needs no model) is held and put to the author instead of being applied. Only the author locks:
 * a decision that another agent captures is OPEN, however it is asked (`captureDecision`).
 */

export const BIBLE_DECISIONS_FILE = "bible/decisions.md";
export const BIBLE_THREADS_FILE = "bible/threads.md";

/** Decisions, questions and threads a file may hold, and the characters of a line of them: what is beyond is cut (and said), so that a file stays one an author can read. */
export const BIBLE_ITEMS_MAX = 500;
export const BIBLE_TEXT_MAX_CHARS = 1200;
const LIST_MAX = 40;

// ─── Decisions and open questions ───────────────────────────────────────────

export type DecisionStatus = "locked" | "open";
/** Who made the decision: the author, or the agent that captured it for the author to confirm. */
export type DecisionBy = "author" | "brainstorming" | "copilot" | "director" | "autopilot";

export const DECISION_AUTHORS: readonly DecisionBy[] = Object.freeze(["author", "brainstorming", "copilot", "director", "autopilot"]);

export interface BibleDecision {
  /** `d-001`, `d-002`…: never reused, so that a decision can be pointed to. */
  id: string;
  /** The day it was made (`YYYY-MM-DD`). */
  date: string;
  /** What was decided, in a sentence. */
  decision: string;
  /** Why. */
  reason: string;
  by: DecisionBy;
  status: DecisionStatus;
  /** The chapters it is about: a change to the entry of one of them (in the Synopsis) is held. */
  chapters: number[];
  /** The files it is about (`secrets/the-wreck.md`, `characters/elio.md`): a change to one of them is held. */
  files: string[];
  /** The secrets it is about, by slug: a change to the file of one of them is held. */
  secrets: string[];
  /** Phrases it forbids (`Elio dies`): a change whose new text has one is held. Case, accents and spacing do not matter. */
  avoid: string[];
}

export type QuestionStatus = "open" | "answered";

export interface BibleQuestion {
  /** `q-001`, `q-002`… */
  id: string;
  date: string;
  question: string;
  by: DecisionBy;
  status: QuestionStatus;
  /** What the author answered. */
  answer: string;
  chapters: number[];
  /** The question of the autopilot this one mirrors (`DirectorQuestion.id`): the autopilot closes it when the author answers there. */
  ref?: string;
}

export interface BibleDecisions {
  decisions: BibleDecision[];
  questions: BibleQuestion[];
  /** The free notes of the file. */
  notes: string;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function lineOf(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).replace(/\r\n?/g, "\n").trim() : "";
}

function clipLine(value: string): string {
  return clipText(value.trim(), BIBLE_TEXT_MAX_CHARS).trim();
}

function listOf(value: unknown): string[] {
  const items = typeof value === "string" ? value.split("\n") : Array.isArray(value) ? value : [];
  const lines: string[] = [];
  for (const item of items) {
    const text = lineOf(item).replace(/^[-*•]\s+/, "");
    if (text) lines.push(clipLine(text));
  }
  return [...new Set(lines)].slice(0, LIST_MAX);
}

function chaptersOf(value: unknown): number[] {
  const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const numbers = items.map((item) => ledgerChapter(item)).filter((chapter): chapter is number => chapter !== undefined && chapter > 0);
  return [...new Set(numbers)].sort((left, right) => left - right).slice(0, LIST_MAX);
}

/** A day as the files say it: `YYYY-MM-DD` from a text or from a date the YAML parser made of one. */
function dayOf(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const text = lineOf(value);
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  return match ? match[1] : "";
}

/** The day of an instant, as the files keep it. */
export function bibleDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function authorOf(value: unknown): DecisionBy {
  const text = lineOf(value).toLowerCase();
  return (DECISION_AUTHORS as readonly string[]).includes(text) ? (text as DecisionBy) : "author";
}

function readDecision(raw: unknown, problems: string[]): BibleDecision | null {
  if (!isMapping(raw)) {
    problems.push("a decision is not a mapping of fields: it is not read");
    return null;
  }
  const id = lineOf(raw.id);
  const decision = lineOf(raw.decision);
  if (!id || !decision) {
    problems.push(`a decision has no ${id ? "decision" : "id"}: it is not read`);
    return null;
  }
  return {
    id,
    date: dayOf(raw.date),
    decision: clipLine(decision),
    reason: clipLine(lineOf(raw.reason)),
    by: authorOf(raw.by),
    status: lineOf(raw.status).toLowerCase() === "locked" ? "locked" : "open",
    chapters: chaptersOf(raw.chapters),
    files: listOf(raw.files),
    secrets: listOf(raw.secrets),
    avoid: listOf(raw.avoid),
  };
}

function readQuestion(raw: unknown, problems: string[]): BibleQuestion | null {
  if (!isMapping(raw)) {
    problems.push("a question is not a mapping of fields: it is not read");
    return null;
  }
  const id = lineOf(raw.id);
  const question = lineOf(raw.question);
  if (!id || !question) {
    problems.push(`a question has no ${id ? "question" : "id"}: it is not read`);
    return null;
  }
  const answer = lineOf(raw.answer);
  return {
    id,
    date: dayOf(raw.date),
    question: clipLine(question),
    by: authorOf(raw.by),
    status: lineOf(raw.status).toLowerCase() === "answered" || answer ? "answered" : "open",
    answer: clipLine(answer),
    chapters: chaptersOf(raw.chapters),
    ...(lineOf(raw.ref) ? { ref: lineOf(raw.ref) } : {}),
  };
}

export function emptyBibleDecisions(): BibleDecisions {
  return { decisions: [], questions: [], notes: "" };
}

/** The decisions and the questions of `bible/decisions.md` (empty when the file has none), and what could not be read of it (in English). */
export function readBibleDecisions(content: string | null | undefined): { value: BibleDecisions; problems: string[] } {
  const problems: string[] = [];
  const document = parseMarkdown(content ?? "");
  if (document.error) problems.push(`the frontmatter cannot be read: ${document.error}`);
  const rawDecisions = document.frontmatter.decisions;
  const rawQuestions = document.frontmatter.questions;
  if (rawDecisions !== undefined && rawDecisions !== null && !Array.isArray(rawDecisions)) problems.push("decisions must be a list: it is not read");
  if (rawQuestions !== undefined && rawQuestions !== null && !Array.isArray(rawQuestions)) problems.push("questions must be a list: it is not read");
  const seen = new Set<string>();
  const decisions: BibleDecision[] = [];
  for (const item of Array.isArray(rawDecisions) ? rawDecisions.slice(0, BIBLE_ITEMS_MAX) : []) {
    const decision = readDecision(item, problems);
    if (!decision) continue;
    if (seen.has(decision.id)) {
      problems.push(`the decision ${decision.id} appears twice: the second is not read`);
      continue;
    }
    seen.add(decision.id);
    decisions.push(decision);
  }
  const questions: BibleQuestion[] = [];
  const seenQuestions = new Set<string>();
  for (const item of Array.isArray(rawQuestions) ? rawQuestions.slice(0, BIBLE_ITEMS_MAX) : []) {
    const question = readQuestion(item, problems);
    if (!question) continue;
    if (seenQuestions.has(question.id)) {
      problems.push(`the question ${question.id} appears twice: the second is not read`);
      continue;
    }
    seenQuestions.add(question.id);
    questions.push(question);
  }
  return { value: { decisions, questions, notes: document.body }, problems };
}

function decisionMapping(decision: BibleDecision): Record<string, unknown> {
  return {
    id: decision.id,
    date: decision.date || undefined,
    decision: decision.decision,
    reason: decision.reason || undefined,
    by: decision.by,
    status: decision.status,
    chapters: decision.chapters.length ? decision.chapters : undefined,
    files: decision.files.length ? decision.files : undefined,
    secrets: decision.secrets.length ? decision.secrets : undefined,
    avoid: decision.avoid.length ? decision.avoid : undefined,
  };
}

function questionMapping(question: BibleQuestion): Record<string, unknown> {
  return {
    id: question.id,
    date: question.date || undefined,
    question: question.question,
    by: question.by,
    status: question.status,
    answer: question.answer || undefined,
    chapters: question.chapters.length ? question.chapters : undefined,
    ref: question.ref || undefined,
  };
}

/** `bible/decisions.md` with these decisions and questions, in the order they have (the log: the oldest first); the keys of `existing` the format does not manage are kept. */
export function serializeBibleDecisions(value: Partial<BibleDecisions>, existing?: string | null): string {
  const document = parseMarkdown(existing ?? "");
  const decisions = (value.decisions ?? []).slice(0, BIBLE_ITEMS_MAX);
  const questions = (value.questions ?? []).slice(0, BIBLE_ITEMS_MAX);
  return renderMarkdown({
    ...document.frontmatter,
    type: "bible",
    id: "bible:decisions",
    title: typeof document.frontmatter.title === "string" && document.frontmatter.title.trim() ? document.frontmatter.title : "Decisions",
    decisions: decisions.length ? decisions.map(decisionMapping) : undefined,
    questions: questions.length ? questions.map(questionMapping) : undefined,
  }, (value.notes ?? document.body ?? "").trim());
}

/** The decisions that bind: the locked ones. */
export function lockedDecisions(value: Pick<BibleDecisions, "decisions"> | readonly BibleDecision[]): BibleDecision[] {
  const decisions = Array.isArray(value) ? value : (value as Pick<BibleDecisions, "decisions">).decisions;
  return (decisions as readonly BibleDecision[]).filter((decision) => decision.status === "locked");
}

/** The questions that wait for an answer. */
export function openQuestions(value: Pick<BibleDecisions, "questions">): BibleQuestion[] {
  return value.questions.filter((question) => question.status === "open");
}

function nextId(prefix: string, ids: readonly string[]): string {
  const highest = ids.reduce((most, id) => {
    const match = new RegExp(`^${prefix}-(\\d+)$`).exec(id);
    return match ? Math.max(most, Number(match[1])) : most;
  }, 0);
  return `${prefix}-${String(highest + 1).padStart(3, "0")}`;
}

export interface DecisionInput {
  decision: string;
  reason?: string;
  by?: DecisionBy;
  /** Only the author's decision can be locked: any other `by` makes an open one, whatever is asked. */
  status?: DecisionStatus;
  chapters?: readonly number[];
  files?: readonly string[];
  secrets?: readonly string[];
  avoid?: readonly string[];
}

/** A decision as `captureDecision` would write it (without writing it), or why it cannot be: no text. */
export function buildDecision(value: BibleDecisions, input: DecisionInput, now: Date): { decision?: BibleDecision; problem?: string } {
  const text = clipLine(lineOf(input.decision));
  if (!text) return { problem: "the decision has no text" };
  const by = input.by ?? "author";
  return {
    decision: {
      id: nextId("d", value.decisions.map((decision) => decision.id)),
      date: bibleDay(now),
      decision: text,
      reason: clipLine(lineOf(input.reason)),
      by,
      status: by === "author" && input.status === "locked" ? "locked" : "open",
      chapters: chaptersOf(input.chapters ?? []),
      files: listOf(input.files ?? []),
      secrets: listOf(input.secrets ?? []),
      avoid: listOf(input.avoid ?? []),
    },
  };
}

/**
 * Captures a decision in the log: the file with the decision added at the end (never anything rewritten). The hook of the agents: Brainstorming, the Copilot and the
 * autopilot call it to put what was agreed in the book; the author's confirmation is what applies the file it returns, and only the author's decision can come out locked.
 */
export function captureDecision(existing: string | null | undefined, input: DecisionInput, now: Date): { content: string; decision: BibleDecision } | { problem: string } {
  const { value } = readBibleDecisions(existing);
  const built = buildDecision(value, input, now);
  if (!built.decision) return { problem: built.problem ?? "the decision cannot be captured" };
  return { content: serializeBibleDecisions({ ...value, decisions: [...value.decisions, built.decision] }, existing), decision: built.decision };
}

/** The file with a decision locked, or opened again: `null` when there is no such decision. The lock is the author's act. */
export function setDecisionStatus(existing: string | null | undefined, id: string, status: DecisionStatus): string | null {
  const { value } = readBibleDecisions(existing);
  if (!value.decisions.some((decision) => decision.id === id)) return null;
  return serializeBibleDecisions({ ...value, decisions: value.decisions.map((decision) => (decision.id === id ? { ...decision, status } : decision)) }, existing);
}

export interface QuestionInput {
  question: string;
  by?: DecisionBy;
  chapters?: readonly number[];
  /** The question of the autopilot this one mirrors. */
  ref?: string;
}

/** The file with an open question added at the end. */
export function askQuestion(existing: string | null | undefined, input: QuestionInput, now: Date): { content: string; question: BibleQuestion } | { problem: string } {
  const { value } = readBibleDecisions(existing);
  const text = clipLine(lineOf(input.question));
  if (!text) return { problem: "the question has no text" };
  const question: BibleQuestion = { id: nextId("q", value.questions.map((entry) => entry.id)), date: bibleDay(now), question: text, by: input.by ?? "author", status: "open", answer: "", chapters: chaptersOf(input.chapters ?? []), ...(input.ref ? { ref: input.ref } : {}) };
  return { content: serializeBibleDecisions({ ...value, questions: [...value.questions, question] }, existing), question };
}

/**
 * The file with a question answered: the answer is kept with the question. With `asDecision` the answer is also captured as a decision (the author's, locked or open as
 * asked), so that what the author settled binds the agents.
 */
export function answerQuestion(existing: string | null | undefined, id: string, answer: string, now: Date, asDecision?: { status?: DecisionStatus; reason?: string }): { content: string; decision?: BibleDecision } | { problem: string } {
  const { value } = readBibleDecisions(existing);
  const question = value.questions.find((entry) => entry.id === id);
  if (!question) return { problem: `there is no question ${id}` };
  const text = clipLine(lineOf(answer));
  if (!text) return { problem: "the answer has no text" };
  let next: BibleDecisions = { ...value, questions: value.questions.map((entry) => (entry.id === id ? { ...entry, status: "answered", answer: text } : entry)) };
  let decision: BibleDecision | undefined;
  if (asDecision) {
    const built = buildDecision(next, { decision: text, reason: asDecision.reason ?? question.question, by: "author", status: asDecision.status ?? "locked", chapters: question.chapters }, now);
    if (built.decision) {
      decision = built.decision;
      next = { ...next, decisions: [...next.decisions, decision] };
    }
  }
  return { content: serializeBibleDecisions(next, existing), ...(decision ? { decision } : {}) };
}

// ─── What the agents are told ───────────────────────────────────────────────

/** Characters a block of decisions may take in a prompt. */
export const DECISIONS_BLOCK_MAX_CHARS = 5000;

function decisionLine(decision: BibleDecision): string {
  const scope = [
    decision.chapters.length ? `chapters ${decision.chapters.join(", ")}` : "",
    decision.secrets.length ? `secrets ${decision.secrets.join(", ")}` : "",
    decision.files.length ? `files ${decision.files.join(", ")}` : "",
  ].filter(Boolean).join("; ");
  const avoid = decision.avoid.length ? ` Never write: ${decision.avoid.map((phrase) => `«${phrase}»`).join(", ")}.` : "";
  return `- ${decision.id}: ${decision.decision}${decision.reason ? ` (why: ${decision.reason})` : ""}${scope ? ` [${scope}]` : ""}.${avoid}`.replace(/\.\.$/, ".");
}

/**
 * What every agent that works on the book is told of its decisions, as instructions (they are the author's): the locked decisions, which it never contradicts, and the open
 * questions, which it never settles on its own (`skipMirrored`: not those that mirror a question of the autopilot). `""` when there is nothing to say. Kept within `maxChars`: the
 * most recent decisions go first.
 */
export function decisionsBlock(value: BibleDecisions, maxChars = DECISIONS_BLOCK_MAX_CHARS, options: { skipMirrored?: boolean } = {}): string {
  const locked = lockedDecisions(value);
  // The autopilot's own questions (`ref`) are in its state and its notes already: its prompts do not say them twice.
  const open = openQuestions(value).filter((question) => !(options.skipMirrored && question.ref));
  if (!locked.length && !open.length) return "";
  const blocks: string[] = [];
  if (locked.length) {
    blocks.push(`LOCKED DECISIONS (the author's: never contradict, change or work around them; when the task would, leave that part as it is and say so):\n${locked.slice().reverse().map(decisionLine).join("\n")}`);
  }
  if (open.length) {
    blocks.push(`OPEN QUESTIONS (the author has not answered: do not settle them yourself, work with what is decided and raise them when they matter):\n${open.slice().reverse().map((question) => `- ${question.id}: ${question.question}${question.chapters.length ? ` [chapters ${question.chapters.join(", ")}]` : ""}`).join("\n")}`);
  }
  return truncate(blocks.join("\n\n"), maxChars);
}

// ─── The check against the decisions ────────────────────────────────────────

/** A change of a file, as an edit would make it: the text before (`null`: the file is new) and after (`null`: it is deleted). */
export interface ChangedFile {
  path: string;
  before: string | null;
  after: string | null;
}

/**
 * - `scope`: the change is to something a locked decision is about (the entry of its chapter, a file it names, one of its secrets).
 * - `avoid`: the new text has a phrase the decision forbids.
 * - `unlock`: the change alters or removes a locked decision in `bible/decisions.md`: only the author does that, in the Bible.
 */
export type DecisionConflictKind = "scope" | "avoid" | "unlock";

export interface DecisionConflict {
  kind: DecisionConflictKind;
  decision: { id: string; decision: string; reason: string };
  path: string;
  chapter?: number;
  secret?: string;
  phrase?: string;
}

function normalizeText(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[«»"'“”‘’]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

/** The chapter whose entry in the Synopsis a path is (`outline/chapters/007.md`). */
function outlineChapterOf(path: string): number | undefined {
  const match = /^outline\/chapters\/(\d+)\.md$/.exec(path);
  return match ? Number(match[1]) : undefined;
}

/** What an entry of the Synopsis says: its title, its ghostwriter, its text and its design. A change that leaves these as they were (the autopilot's bookkeeping: a digest, an origin) is no change. */
function outlineEntrySignature(content: string | null): string {
  if (content === null) return "";
  const document = parseMarkdown(content);
  return JSON.stringify([lineOf(document.frontmatter.title), lineOf(document.frontmatter.ghostwriter), document.body.trim(), designFingerprint(document.frontmatter.design)]);
}

/** The chapter whose text a path is (`chapters/007-the-wreck/…`): its prose, which a decision never keeps from being written, only from saying what it forbids. */
export function chapterOfProse(path: string): number | undefined {
  const match = /^chapters\/([^/]+)\//.exec(path);
  return match ? chapterNumberFromSlug(match[1]) ?? undefined : undefined;
}

const secretOf = (path: string): string | undefined => /^secrets\/([^/]+)\.md$/.exec(path)?.[1];

/**
 * The changes that contradict a locked decision, from the decisions and the files an edit would change; deterministic, so that no model decides whether a lock holds. A
 * change is held when it touches what a locked decision is about (`scope`: the Synopsis entry of its chapters, the files and the secrets it names), when its new text has a
 * phrase the decision forbids (`avoid`, in any file), or when it alters a locked decision (`unlock`). A change that leaves a file as it was is no change. The prose of a chapter
 * is never held for being written: only a forbidden phrase in it is.
 */
export function decisionConflicts(changes: readonly ChangedFile[], decisions: Pick<BibleDecisions, "decisions"> | readonly BibleDecision[]): DecisionConflict[] {
  const locked = lockedDecisions(decisions);
  if (!locked.length) return [];
  const conflicts: DecisionConflict[] = [];
  const subject = (decision: BibleDecision) => ({ id: decision.id, decision: decision.decision, reason: decision.reason });
  for (const change of changes) {
    if (change.before === change.after) continue;
    const before = change.before === null ? null : change.before.replace(/\r\n?/g, "\n").trim();
    const after = change.after === null ? null : change.after.replace(/\r\n?/g, "\n").trim();
    if (before === after) continue;
    if (change.path === BIBLE_DECISIONS_FILE) {
      const next = readBibleDecisions(change.after).value.decisions;
      for (const decision of locked) {
        const kept = next.find((entry) => entry.id === decision.id);
        if (!kept || kept.status !== "locked" || kept.decision !== decision.decision || kept.avoid.join("\n") !== decision.avoid.join("\n")) conflicts.push({ kind: "unlock", decision: subject(decision), path: change.path });
      }
      continue;
    }
    const chapter = outlineChapterOf(change.path);
    if (chapter !== undefined && change.before !== null && change.after !== null && outlineEntrySignature(change.before) === outlineEntrySignature(change.after)) continue;
    const secret = secretOf(change.path);
    const haystack = after === null ? "" : normalizeText(after);
    const earlier = before === null ? "" : normalizeText(before);
    for (const decision of locked) {
      if (chapter !== undefined && decision.chapters.includes(chapter)) conflicts.push({ kind: "scope", decision: subject(decision), path: change.path, chapter });
      else if (secret !== undefined && decision.secrets.includes(secret)) conflicts.push({ kind: "scope", decision: subject(decision), path: change.path, secret });
      else if (decision.files.includes(change.path)) conflicts.push({ kind: "scope", decision: subject(decision), path: change.path });
      for (const phrase of decision.avoid) {
        const wanted = normalizeText(phrase);
        if (wanted.length >= 3 && haystack.includes(wanted) && !earlier.includes(wanted)) conflicts.push({ kind: "avoid", decision: subject(decision), path: change.path, phrase });
      }
    }
  }
  return conflicts;
}

/** A conflict in words, in English or in Italian (the language of the interface): what is held, which decision, and what to do. */
export function decisionConflictText(conflict: DecisionConflict, language: string): string {
  const it = isItalian(language);
  const what = conflict.decision.decision;
  const id = conflict.decision.id;
  switch (conflict.kind) {
    case "scope": {
      const where = conflict.chapter ? (it ? `la voce del capitolo ${conflict.chapter}` : `the entry of chapter ${conflict.chapter}`) : conflict.secret ? (it ? `il segreto «${conflict.secret}»` : `the secret «${conflict.secret}»`) : `${conflict.path}`;
      return it ? `Questa modifica tocca ${where}, coperto dalla decisione bloccata ${id}: «${what}».` : `This change touches ${where}, which the locked decision ${id} covers: «${what}».`;
    }
    case "avoid":
      return it ? `Il nuovo testo di ${conflict.path} contiene «${conflict.phrase}», che la decisione bloccata ${id} vieta: «${what}».` : `The new text of ${conflict.path} has «${conflict.phrase}», which the locked decision ${id} forbids: «${what}».`;
    case "unlock":
      return it ? `Questa modifica cambia o toglie la decisione bloccata ${id} («${what}»): solo l'autore la sblocca, dalla Bibbia.` : `This change alters or removes the locked decision ${id} («${what}»): only the author unlocks it, in the Bible.`;
  }
}

// ─── Setup and payoff threads ───────────────────────────────────────────────

export type ThreadStatus = "open" | "paid" | "dropped";

export interface ThreadPoint {
  chapter: number;
  note: string;
}

/**
 * A thread of setup and payoff: something the story plants (an object, a promise, a question, a danger) and what pays it off later. It is the story's own bookkeeping
 * beside the ledger of the secrets (a secret has its clues and its reveal in its own file; a thread is anything else the reader is promised). A thread that is open
 * and never paid, or paid before it was planted, is a finding (`design-checks`); `dropped` says the author gave it up on purpose.
 */
export interface BibleThread {
  /** `t-001`, `t-002`… */
  id: string;
  title: string;
  setup?: ThreadPoint;
  payoff?: ThreadPoint;
  status: ThreadStatus;
}

export interface BibleThreads {
  threads: BibleThread[];
  notes: string;
}

function readPoint(value: unknown): ThreadPoint | undefined {
  if (!isMapping(value)) return undefined;
  const chapter = ledgerChapter(value.chapter);
  if (chapter === undefined) return undefined;
  return { chapter, note: clipLine(lineOf(value.note)) };
}

/** The threads of `bible/threads.md` (empty when the file has none), and what could not be read of it (in English). */
export function readBibleThreads(content: string | null | undefined): { value: BibleThreads; problems: string[] } {
  const problems: string[] = [];
  const document = parseMarkdown(content ?? "");
  if (document.error) problems.push(`the frontmatter cannot be read: ${document.error}`);
  const raw = document.frontmatter.threads;
  if (raw !== undefined && raw !== null && !Array.isArray(raw)) problems.push("threads must be a list: it is not read");
  const threads: BibleThread[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw) ? raw.slice(0, BIBLE_ITEMS_MAX) : []) {
    if (!isMapping(item)) {
      problems.push("a thread is not a mapping of fields: it is not read");
      continue;
    }
    const id = lineOf(item.id);
    const title = lineOf(item.title);
    if (!id || !title) {
      problems.push(`a thread has no ${id ? "title" : "id"}: it is not read`);
      continue;
    }
    if (seen.has(id)) {
      problems.push(`the thread ${id} appears twice: the second is not read`);
      continue;
    }
    seen.add(id);
    const status = lineOf(item.status).toLowerCase();
    const setup = readPoint(item.setup);
    const payoff = readPoint(item.payoff);
    threads.push({ id, title: clipLine(title), ...(setup ? { setup } : {}), ...(payoff ? { payoff } : {}), status: status === "paid" || status === "dropped" ? status : "open" });
  }
  return { value: { threads, notes: document.body }, problems };
}

/** `bible/threads.md` with these threads; the keys of `existing` the format does not manage are kept. */
export function serializeBibleThreads(value: Partial<BibleThreads>, existing?: string | null): string {
  const document = parseMarkdown(existing ?? "");
  const threads = (value.threads ?? []).slice(0, BIBLE_ITEMS_MAX);
  const point = (value: ThreadPoint | undefined) => (value ? { chapter: value.chapter, note: value.note || undefined } : undefined);
  return renderMarkdown({
    ...document.frontmatter,
    type: "bible",
    id: "bible:threads",
    title: typeof document.frontmatter.title === "string" && document.frontmatter.title.trim() ? document.frontmatter.title : "Setups and payoffs",
    threads: threads.length ? threads.map((thread) => ({ id: thread.id, title: thread.title, setup: point(thread.setup), payoff: point(thread.payoff), status: thread.status })) : undefined,
  }, (value.notes ?? document.body ?? "").trim());
}

export function nextThreadId(threads: readonly BibleThread[]): string {
  return nextId("t", threads.map((thread) => thread.id));
}
