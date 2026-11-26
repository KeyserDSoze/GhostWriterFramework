import { frozenChanges, FrozenChapterError, type ChapterFreeze, type FrozenChapterChange } from "../book/freeze.js";
import type { BookSnapshot, ChapterInfo } from "../book/snapshot.js";
import { formatBookDate, isItalian, truncate } from "../util/text.js";
import { inHands, startedReview } from "./chapter-state.js";
import type { OutlineWrittenChange } from "./outline-check.js";
import type { PlanNote } from "./planner.js";
import { MAX_DEFERRED_CHANGES, MAX_FROZEN_SEEN, MAX_PENDING_REVIEWS, capConstraints, normalizeRuleText } from "./state.js";
import {
  FROZEN_ACTIONS,
  FROZEN_CHANGE_ACTIONS,
  type AutopilotState,
  type DeferredChange,
  type DirectorQuestion,
  type FrozenAction,
  type FrozenChangeKind,
  type FrozenChapterView,
  type FrozenEditsMode,
  type PendingFrozenReview,
  type PlannedChapter,
  type QuestionAnswer,
  type QuestionChoice,
  type RevisionRequest,
} from "./types.js";

// ─── What changed, and what the autopilot has in its hands ──────────────────────────────────────────────────────────────

/**
 * One change the author decides about: the text of a frozen chapter (`frozen`), or the outline entry of a chapter already closed
 * (`outline`). `inPlan` says whether the chapter is one of the plan's, closed: only then can it be reviewed (else it can only be marked
 * as reviewed). `pending` is the decision already recorded for it, when there is one.
 */
export interface FrozenWorkItem {
  kind: FrozenChangeKind;
  number: number;
  slug: string;
  title: string;
  fingerprint: string;
  /** The chapter was written by the author before the autopilot took over: never rewritten for a decision the autopilot took. */
  imported: boolean;
  inPlan: boolean;
  change?: FrozenChapterChange;
  outline?: OutlineWrittenChange;
  pending?: PendingFrozenReview;
  /** The author chose to decide about this change later (`DeferredChange`): it is not asked, decided by the autopilot or said again. */
  deferred?: { at: string };
}

/** Whether a question is about a change of a frozen chapter or of the outline of a written one. */
export function isFrozenQuestion(question: DirectorQuestion | null | undefined): question is DirectorQuestion & { frozen: NonNullable<DirectorQuestion["frozen"]> } {
  return Boolean(question && (question.kind === "frozen-change" || question.kind === "outline-change") && question.frozen);
}

/**
 * The autopilot is finishing work the author asked for: a revision, the chapters it rewrote being reviewed again, the review of a change, or a
 * campaign whose chapters wait or are being worked.
 */
function finishingWork(state: AutopilotState): boolean {
  return Boolean(state.revision) || Boolean(startedReview(state)) || campaignGoesOn(state) || (state.plan?.chapters ?? []).some((chapter) => chapter.skipReaders && chapter.status !== "done");
}

/** A campaign has chapters that wait for their turn, or one being worked (`state.campaign`). */
export function campaignGoesOn(state: Pick<AutopilotState, "campaign">): boolean {
  // A review of the book goes on between its rounds too (the book is judged, or the author is waited for), until it is taken away.
  return Boolean(state.campaign?.review) || Boolean(state.campaign?.chapters.some((chapter) => chapter.status === "waiting" || chapter.status === "working"));
}

/**
 * The decision a campaign holds for the change of a chapter, as a decision that waits: the chapter is the campaign's until it is done (no question is
 * asked about it, and the autopilot decides nothing for it). Only a campaign about the Synopsis holds changes of the outline.
 */
function campaignDecision(state: AutopilotState | null, kind: FrozenChangeKind, number: number): PendingFrozenReview | undefined {
  const campaign = state?.campaign;
  if (!campaign || campaign.reason !== "outline-change" || kind !== "outline") return undefined;
  const item = campaign.chapters.find((entry) => entry.number === number && (entry.status === "waiting" || entry.status === "working") && entry.mode !== "later");
  if (!item) return undefined;
  return {
    id: `${campaign.id}-${number}`,
    kind,
    number,
    action: item.mode === "keep" ? "keep-text" : "rewrite-to-outline",
    fingerprint: item.fingerprint ?? "",
    at: campaign.createdAt,
    ...(campaign.note ? { note: campaign.note } : {}),
  };
}

/** The decision to decide later about this change, when the author made it and the change is still the one it was about. */
function deferralOf(state: AutopilotState | null, kind: FrozenChangeKind, number: number, fingerprint: string): DeferredChange | undefined {
  return state?.deferredChanges?.find((entry) => entry.kind === kind && entry.number === number && entry.fingerprint === fingerprint);
}

/** The state without the decisions to decide later about this chapter (of one kind, or all). */
export function withoutDeferrals(state: AutopilotState, number: number, kind?: FrozenChangeKind): AutopilotState {
  if (!state.deferredChanges?.some((entry) => entry.number === number && (kind === undefined || entry.kind === kind))) return state;
  const deferredChanges = state.deferredChanges.filter((entry) => entry.number !== number || (kind !== undefined && entry.kind !== kind));
  const { deferredChanges: _before, ...rest } = state;
  return deferredChanges.length ? { ...rest, deferredChanges } : rest;
}

/** The state with the change of a chapter decided later (replacing an earlier decision to do so for the same chapter and kind). */
export function withDeferral(state: AutopilotState, change: Omit<DeferredChange, "at">, at: string): AutopilotState {
  const others = (state.deferredChanges ?? []).filter((entry) => entry.number !== change.number || entry.kind !== change.kind);
  return { ...state, deferredChanges: [...others, { ...change, at }].slice(-MAX_DEFERRED_CHANGES) };
}

// What the state says of one chapter (`inRevision`, `startedReview`, and `inHands` here) is in `chapter-state.ts`, which has no import but types: the rule that tells the author what
// happens when an entry of the outline changes (`outline-change.ts`) needs it too, and must not carry this whole module with it. The two exports stay where they were.
export { inRevision, startedReview } from "./chapter-state.js";

/** The changes of a book and what is decided about them, in the order of the book (a frozen chapter's text before its outline). */
export function frozenWork(state: AutopilotState | null, snapshot: BookSnapshot, outlineWritten: ReadonlyMap<number, OutlineWrittenChange> = new Map()): FrozenWorkItem[] {
  const plan = state?.plan ?? null;
  const bySlug = new Map((plan?.chapters ?? []).map((chapter) => [chapter.slug, chapter]));
  const byNumber = new Map((plan?.chapters ?? []).map((chapter) => [chapter.number, chapter]));
  const queued = (kind: FrozenChangeKind, number: number) => state?.pendingReviews?.find((entry) => !entry.started && entry.kind === kind && entry.number === number) ?? campaignDecision(state, kind, number);
  const later = (kind: FrozenChangeKind, number: number, fingerprint: string) => {
    const deferral = deferralOf(state, kind, number, fingerprint);
    return deferral ? { deferred: { at: deferral.at } } : {};
  };
  const items: FrozenWorkItem[] = [];
  for (const change of frozenChanges(snapshot)) {
    const planned = bySlug.get(change.slug);
    if (planned && state && inHands(state, planned)) continue;
    // A folder the plan does not use (a second folder with the number of a chapter) is not the chapter the autopilot knows.
    if (!planned && byNumber.get(change.number)) continue;
    const pending = queued("frozen", change.number);
    items.push({ kind: "frozen", number: change.number, slug: change.slug, title: change.title, fingerprint: change.fingerprint, imported: planned?.imported === true || !planned, inPlan: Boolean(planned), change, ...(pending ? { pending } : later("frozen", change.number, change.fingerprint)) });
  }
  for (const change of outlineWritten.values()) {
    const planned = byNumber.get(change.number);
    if (!planned || !state || inHands(state, planned)) continue;
    const pending = queued("outline", change.number);
    items.push({ kind: "outline", number: change.number, slug: planned.slug, title: planned.title, fingerprint: change.digest, imported: planned.imported === true, inPlan: true, outline: change, ...(pending ? { pending } : later("outline", change.number, change.digest)) });
  }
  return items.sort((left, right) => left.number - right.number || (left.kind === right.kind ? 0 : left.kind === "frozen" ? -1 : 1));
}

/** What can be done with a change now: reviewing needs the chapter in the plan, closed; marking reviewed can always be done. */
export function frozenActions(item: Pick<FrozenWorkItem, "kind" | "inPlan">): FrozenAction[] {
  return item.inPlan ? [...FROZEN_CHANGE_ACTIONS[item.kind]] : ["mark-reviewed"];
}

/** The chapters the autopilot approved before it froze what it approves (a state saved by an older engine): frozen once, by its first run. Never the author's. */
export function legacyChapters(state: AutopilotState, snapshot: BookSnapshot): ChapterInfo[] {
  if (state.frozenSince || !state.plan) return [];
  const folders = new Map(snapshot.chapters.map((chapter) => [chapter.slug, chapter]));
  return state.plan.chapters
    .filter((chapter) => chapter.status === "done" && !chapter.imported)
    .map((chapter) => folders.get(chapter.slug))
    .filter((folder): folder is ChapterInfo => Boolean(folder && folder.paragraphs.length && !folder.frozen && !folder.frozenProblem && !folder.document?.error));
}

/** Decisions to mark a frozen chapter reviewed that wait for a run (a host that applied an answer by itself): the `freeze` step carries them out. */
export function queuedMarkReviewed(state: Pick<AutopilotState, "pendingReviews">): PendingFrozenReview[] {
  return (state.pendingReviews ?? []).filter((entry) => !entry.started && entry.kind === "frozen" && entry.action === "mark-reviewed");
}

/** Whether the next step is the `freeze` step, which needs no model: the chapters an older engine approved, or changes marked as reviewed. */
export function needsFreezeStep(state: AutopilotState, snapshot: BookSnapshot): boolean {
  return queuedMarkReviewed(state).length > 0 || legacyChapters(state, snapshot).length > 0;
}

// ─── The question ───────────────────────────────────────────────────────────

function text(language: string, en: string, it: string): string {
  return isItalian(language) ? it : en;
}

function quoted(title: string | undefined): string {
  return title ? ` «${title}»` : "";
}

const CHOICE_LABELS: Record<FrozenAction, { en: string; it: string }> = {
  "review-and-update": { en: "Review and update the book from this change", it: "Rivedi e aggiorna il libro da questa modifica" },
  "review-only": { en: "Only review the chapter", it: "Solo una review del capitolo" },
  "mark-reviewed": { en: "Mark as reviewed", it: "Segna come rivisto" },
  "rewrite-to-outline": { en: "Rewrite the chapter to follow the synopsis", it: "Riscrivi il capitolo secondo la Sinossi" },
  "keep-text": { en: "Keep the text, update only the synopsis", it: "Tieni il testo, aggiorna solo la Sinossi" },
};

/** The labels these actions had while the Synopsis was called the outline (the Scaletta): an answer that still says them chooses the same action. */
const FORMER_CHOICE_LABELS: Partial<Record<FrozenAction, readonly string[]>> = {
  "rewrite-to-outline": ["Rewrite the chapter to follow the outline", "Riscrivi il capitolo secondo la Scaletta"],
  "keep-text": ["Keep the text, update only the outline", "Tieni il testo, aggiorna solo la Scaletta"],
};

/** The label of an action in the language of the book. */
export function frozenActionLabel(action: FrozenAction, language: string): string {
  return text(language, CHOICE_LABELS[action].en, CHOICE_LABELS[action].it);
}

function frozenChoices(kind: FrozenChangeKind, language: string): QuestionChoice[] {
  return FROZEN_CHANGE_ACTIONS[kind].map((action) => ({ id: action, label: frozenActionLabel(action, language) }));
}

function list(names: string[]): string {
  return names.length > 6 ? `${names.slice(0, 6).join(", ")} (+${names.length - 6})` : names.join(", ");
}

/** What changed in a frozen chapter, in words. */
function changedLines(item: FrozenWorkItem, language: string): string[] {
  const changed = item.change?.changed;
  if (!changed) return [];
  return [
    changed.body ? text(language, "The text of chapter.md changed.", "È cambiato il testo di chapter.md.") : "",
    changed.modified.length ? text(language, `Scenes changed: ${list(changed.modified)}.`, `Scene modificate: ${list(changed.modified)}.`) : "",
    changed.added.length ? text(language, `Scenes added: ${list(changed.added)}.`, `Scene aggiunte: ${list(changed.added)}.`) : "",
    changed.removed.length ? text(language, `Scenes removed: ${list(changed.removed)}.`, `Scene rimosse: ${list(changed.removed)}.`) : "",
  ].filter(Boolean);
}

/** ", frozen on 1 January 2026": the day a chapter was frozen, as the author reads a date in the language of the book (only ", frozen" when the record says no day that can be read). */
function frozenOn(moment: string | undefined, language: string): string {
  const day = formatBookDate(moment, language);
  return day ? text(language, `, frozen on ${day}`, `, congelato il ${day}`) : text(language, ", frozen", ", congelato");
}

/** The question the run stops with for a change (one at a time, in the order of the book): it says the others that wait after it. */
export function frozenQuestion(item: FrozenWorkItem, others: FrozenWorkItem[], language: string, now: string): DirectorQuestion {
  const choices = frozenChoices(item.kind, language);
  const n = item.number;
  const question = item.kind === "frozen"
    ? text(language, `You changed chapter ${n}${quoted(item.title)}${frozenOn(item.change?.frozenAt, language)}. What should I do?`, `Hai modificato il capitolo ${n}${quoted(item.title)}${frozenOn(item.change?.frozenAt, language)}. Cosa faccio?`)
    : text(language, `The synopsis of chapter ${n}${quoted(item.title)} changed, but the chapter is already written. What should I do?`, `La Sinossi del capitolo ${n}${quoted(item.title)} è cambiata, ma il capitolo è già scritto. Cosa faccio?`);
  const otherNumbers = [...new Set(others.map((other) => other.number).filter((number) => number !== n))];
  const context = [
    ...changedLines(item, language),
    item.kind === "outline" && item.outline ? text(language, `The new entry: ${truncate(item.outline.body, 600) || "(no text)"}`, `La nuova voce: ${truncate(item.outline.body, 600) || "(nessun testo)"}`) : "",
    otherNumbers.length
      ? text(language, `${otherNumbers.length === 1 ? `Chapter ${otherNumbers[0]} changed too` : `Chapters ${otherNumbers.join(", ")} changed too`}: you will be asked about ${otherNumbers.length === 1 ? "it" : "them"} next, one at a time.`, `${otherNumbers.length === 1 ? `Anche il capitolo ${otherNumbers[0]} è cambiato` : `Anche i capitoli ${otherNumbers.join(", ")} sono cambiati`}: ti chiederò dopo, uno alla volta.`)
      : "",
  ].filter(Boolean).join("\n");
  return {
    id: `${item.kind}-${n}-${item.fingerprint}`,
    kind: item.kind === "frozen" ? "frozen-change" : "outline-change",
    question,
    context,
    options: choices.map((choice) => choice.label),
    choices,
    frozen: {
      kind: item.kind,
      number: n,
      slug: item.slug,
      fingerprint: item.fingerprint,
      ...(item.title ? { title: item.title } : {}),
      ...(item.change ? { by: item.change.by, frozenAt: item.change.frozenAt, changed: item.change.changed } : {}),
      ...(otherNumbers.length ? { others: otherNumbers } : {}),
    },
    chapterNumber: n,
    askedAt: now,
  };
}

/** Why the run stopped, for a question about a change. */
export function frozenQuestionMessage(question: DirectorQuestion, language: string): string {
  const frozen = question.frozen;
  if (!frozen) return question.question;
  return frozen.kind === "frozen"
    ? text(language, `You changed chapter ${frozen.number}${frozenOn(frozen.frozenAt, language)}: choose what to do with it.`, `Hai modificato il capitolo ${frozen.number}${frozenOn(frozen.frozenAt, language)}: scegli cosa farne.`)
    : text(language, `The synopsis of chapter ${frozen.number} changed after it was written: choose what to do with it.`, `La Sinossi del capitolo ${frozen.number} è cambiata dopo che era scritto: scegli cosa farne.`);
}

const comparable = (value: string) => value.normalize("NFC").replace(/[«»"“”'’]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The action an answer to a question about a change chooses. The `choice` (or the `answer`) names one by its id or its label, in either
 * language, as an interface that only shows `options` sends it; `accept` without a choice keeps what the author did (`mark-reviewed`, or
 * `keep-text` for the outline); any other text reviews and updates the book (rewrites to the outline), with the text as the author's
 * note for the director. An empty answer chooses nothing.
 */
export function frozenAnswerAction(question: DirectorQuestion, answer: Pick<QuestionAnswer, "answer" | "choice" | "accept">): { action: FrozenAction; note?: string } {
  const kind: FrozenChangeKind = question.frozen?.kind ?? (question.kind === "outline-change" ? "outline" : "frozen");
  const allowed = FROZEN_CHANGE_ACTIONS[kind];
  const raw = (typeof answer.choice === "string" && answer.choice.trim() ? answer.choice : answer.answer ?? "").trim();
  if (raw) {
    const wanted = comparable(raw);
    for (const action of allowed) {
      const labels = [action, CHOICE_LABELS[action].en, CHOICE_LABELS[action].it, ...(FORMER_CHOICE_LABELS[action] ?? []), ...(question.choices ?? []).filter((choice) => choice.id === action).map((choice) => choice.label)];
      if (labels.some((label) => comparable(label) === wanted)) return { action };
    }
  }
  if (answer.accept) return { action: kind === "frozen" ? "mark-reviewed" : "keep-text" };
  if (raw) return { action: kind === "frozen" ? "review-and-update" : "rewrite-to-outline", note: raw };
  throw new FrozenChapterError("invalid_action", `Choose what to do with the change: ${allowed.join(", ")}.`);
}

// ─── Decisions ──────────────────────────────────────────────────────────────

export interface FrozenDecision {
  kind: FrozenChangeKind;
  number: number;
  action: FrozenAction;
  /** The change decided about (`FrozenWorkItem.fingerprint`). */
  fingerprint: string;
  note?: string;
  /** Taken by the autopilot (`frozenEdits: "auto"`). */
  auto?: boolean;
  /** The author's note becomes a permanent rule too (`QuestionAnswer.asRule`). */
  asRule?: boolean;
}

/**
 * The state with a decision recorded: in `pendingReviews` (replacing one that waited for the same change of the same chapter), and the
 * question about it closed. Pure. What needs no model is carried out at once by the session; the rest by the next run, before the plan.
 */
export function applyFrozenDecision(state: AutopilotState, decision: FrozenDecision, at: string, id: string): AutopilotState {
  if (!FROZEN_ACTIONS.includes(decision.action) || !FROZEN_CHANGE_ACTIONS[decision.kind].includes(decision.action)) {
    throw new FrozenChapterError("invalid_action", `${decision.action} is not something that can be done with a change of ${decision.kind === "frozen" ? "a frozen chapter" : "the outline of a written chapter"}.`);
  }
  const rule = decision.asRule && decision.note ? normalizeRuleText(decision.note) : null;
  // The author's decision replaces the one to decide later, and the campaign's for the same chapter when it has not begun.
  const next = structuredClone(withoutDeferrals(state, decision.number, decision.kind));
  if (decision.kind === "outline" && next.campaign?.reason === "outline-change") {
    for (const item of next.campaign.chapters) if (item.number === decision.number && item.status === "waiting") Object.assign(item, { status: "cancelled", endedAt: at });
  }
  const others = (next.pendingReviews ?? []).filter((entry) => entry.started || entry.kind !== decision.kind || entry.number !== decision.number);
  const entry: PendingFrozenReview = {
    id,
    kind: decision.kind,
    number: decision.number,
    action: decision.action,
    fingerprint: decision.fingerprint,
    at,
    ...(decision.note ? { note: decision.note } : {}),
    ...(decision.auto ? { auto: true } : {}),
  };
  next.pendingReviews = [...others, entry].slice(-MAX_PENDING_REVIEWS);
  if (rule && !next.constraints.includes(rule)) next.constraints = capConstraints([...next.constraints, rule]);
  const question = next.question;
  if (isFrozenQuestion(question) && question.frozen.kind === decision.kind && question.frozen.number === decision.number) {
    next.question = null;
    if (next.status === "waiting-author") next.status = "paused";
    next.message = null;
  }
  return next;
}

/** The state without a decision (carried out, or no longer about anything). */
export function withoutPendingReview(state: AutopilotState, id: string): AutopilotState {
  const pendingReviews = (state.pendingReviews ?? []).filter((entry) => entry.id !== id);
  const { pendingReviews: _before, ...rest } = state;
  return pendingReviews.length ? { ...rest, pendingReviews } : rest;
}

/** Remove the decisions that wait for this chapter (all, or of one kind) and close the question about it: the author decided otherwise. */
export function forgetFrozenChapter(input: AutopilotState, number: number, kind?: FrozenChangeKind): AutopilotState {
  const state = withoutDeferrals(input, number, kind);
  const keep = (entry: PendingFrozenReview) => entry.started || entry.number !== number || (kind !== undefined && entry.kind !== kind);
  const pendingReviews = (state.pendingReviews ?? []).filter(keep);
  const { pendingReviews: _before, ...rest } = state;
  const next: AutopilotState = pendingReviews.length ? { ...rest, pendingReviews } : rest;
  if (isFrozenQuestion(next.question) && next.question.frozen.number === number && (kind === undefined || next.question.frozen.kind === kind)) {
    return { ...next, question: null, status: next.status === "waiting-author" ? "paused" : next.status, message: null };
  }
  return next;
}

// ─── Before every step ──────────────────────────────────────────────────────

export interface FrozenSettleInput {
  snapshot: BookSnapshot;
  /** The chapters already closed whose outline entry the author changed (`outlinePlanStatus(...).written`). */
  outlineWritten: ReadonlyMap<number, OutlineWrittenChange>;
  language: string;
  now: string;
}

export interface FrozenSettleResult {
  state: AutopilotState;
  /** What the author should know (said once a run, by key). */
  notes: PlanNote[];
  /** How many chapters have a change that waits for the author's decision. */
  waiting: number;
}

/**
 * What the run does with the changes before a step, as `options.frozenEdits` says: `ask` stops with a question (one change at a time,
 * in the order of the book; a question whose change is gone is withdrawn, one whose change changed again is asked again); `auto`
 * decides to review and update (to rewrite to the outline), with an insight, except for the chapters the author wrote, which are only
 * said; `notify` says every change once (its fingerprint is remembered in `frozenSeen`). Records that cannot be read are said, and the
 * state learns since when it knows frozen chapters once there is nothing an older engine approved left to freeze. Pure.
 */
export function settleFrozenChanges(input: AutopilotState, settle: FrozenSettleInput): FrozenSettleResult {
  const { snapshot, language, now } = settle;
  let state = input;
  const notes: PlanNote[] = [];
  const mode: FrozenEditsMode = state.options.frozenEdits ?? "ask";

  for (const folder of snapshot.chapters) {
    if (!folder.frozenProblem) continue;
    notes.push({
      key: `frozen-invalid:${folder.slug}:${folder.hash ?? ""}`,
      tone: "warning",
      code: "frozenInvalid",
      chapterNumber: folder.number,
      title: text(language, `The freeze record of chapter ${folder.number} cannot be read: the chapter counts as not frozen`, `Il congelamento del capitolo ${folder.number} non si legge: il capitolo conta come non congelato`),
      detail: `${folder.path}: ${folder.frozenProblem}`,
    });
  }

  if (!state.frozenSince && !legacyChapters(state, snapshot).length) state = { ...state, frozenSince: now };

  const items = frozenWork(state, snapshot, settle.outlineWritten).filter((item) => item.inPlan);
  // What the author chose to decide later waits for the author, and only for the author: no question, no decision of the autopilot, nothing said again.
  const deferred = items.filter((item) => !item.pending && item.deferred);
  let waiting = items.filter((item) => !item.pending && !item.deferred);

  const asked = state.question;
  if (isFrozenQuestion(asked)) {
    const current = waiting.find((item) => item.kind === asked.frozen.kind && item.number === asked.frozen.number);
    if (mode !== "ask" || !current) {
      state = { ...state, question: null, message: null };
      if (!current) {
        notes.push({
          key: `frozen-cleared:${asked.id}`,
          tone: "info",
          code: "frozenCleared",
          chapterNumber: asked.frozen.number,
          title: text(language, `Chapter ${asked.frozen.number}: the change is no longer there, nothing to decide`, `Capitolo ${asked.frozen.number}: la modifica non c'è più, non c'è nulla da decidere`),
        });
      }
    } else if (current.fingerprint !== asked.frozen.fingerprint) {
      state = { ...state, question: frozenQuestion(current, waiting.filter((item) => item !== current), language, now) };
    }
  }

  if (mode === "ask") {
    // While the autopilot finishes work the author asked for (a revision, the chapters it rewrote reviewed again, the review of a change), no
    // new question: what it rewrites is reviewed and frozen again at its end, and a change it does not reach is asked about once it is over.
    if (!state.question && !finishingWork(state) && waiting.length) state = { ...state, question: frozenQuestion(waiting[0], waiting.slice(1), language, now) };
  } else if (mode === "auto") {
    for (const item of waiting) {
      if (item.kind === "outline" && item.imported) continue;
      const action: FrozenAction = item.kind === "frozen" ? "review-and-update" : "rewrite-to-outline";
      state = applyFrozenDecision(state, { kind: item.kind, number: item.number, action, fingerprint: item.fingerprint, auto: true }, now, `auto-${item.kind}-${item.number}-${item.fingerprint}`);
      notes.push({
        key: `frozen-auto:${item.kind}:${item.number}:${item.fingerprint}`,
        tone: "info",
        code: item.kind === "frozen" ? "frozenAuto" : "outlineWrittenAuto",
        chapterNumber: item.number,
        title: item.kind === "frozen"
          ? text(language, `You changed chapter ${item.number}, which was frozen: I review it and update the book from your change`, `Hai modificato il capitolo ${item.number}, che era congelato: lo rivedo e aggiorno il libro dalla tua modifica`)
          : text(language, `The synopsis of chapter ${item.number} changed: I rewrite the chapter to follow it`, `La Sinossi del capitolo ${item.number} è cambiata: riscrivo il capitolo per seguirla`),
      });
    }
    waiting = waiting.filter((item) => item.kind === "outline" && item.imported);
  }

  if (mode !== "ask") {
    const seen = new Set(state.frozenSeen ?? []);
    const fresh: string[] = [];
    for (const item of waiting) {
      const key = `${item.kind}:${item.number}:${item.fingerprint}`;
      if (seen.has(key)) continue;
      fresh.push(key);
      notes.push({
        key: `frozen-notify:${key}`,
        tone: "info",
        code: item.kind === "frozen" ? "frozenChanged" : "outlineWrittenChanged",
        chapterNumber: item.number,
        title: item.kind === "frozen"
          ? text(language, `You changed chapter ${item.number}${frozenOn(item.change?.frozenAt, language)}: it is not reviewed (frozen chapters are only noticed)`, `Hai modificato il capitolo ${item.number}${frozenOn(item.change?.frozenAt, language)}: non viene rivisto (i capitoli congelati sono solo segnalati)`)
          : text(language, `The synopsis of chapter ${item.number} changed, but the chapter is already written: it is not rewritten`, `La Sinossi del capitolo ${item.number} è cambiata, ma il capitolo è già scritto: non viene riscritto`),
        ...(item.change ? { detail: changedLines(item, language).join(" ") } : {}),
      });
    }
    if (fresh.length) state = { ...state, frozenSeen: [...(state.frozenSeen ?? []), ...fresh].slice(-MAX_FROZEN_SEEN) };
  }

  return { state, notes, waiting: new Set([...waiting, ...deferred].map((item) => item.number)).size };
}

// ─── Carrying out a decision: what advancing the state does ─────────────────

/** What the planner knows of the changes when it may start one (the runner, after it settled the changes of the step). */
export interface PlannerFrozen {
  /** The chapters already closed whose outline entry changed: the new entry of a chapter about to be rewritten to follow it. */
  outlineWritten: ReadonlyMap<number, OutlineWrittenChange>;
  /** The moment the step begins. */
  now: string;
  /**
   * While a review of the book goes on: the chapters (their slugs) the author froze, and the frozen ones changed since they were frozen (a change of the author's,
   * which its own rules decide about first). The review leaves them to the author.
   */
  authorFrozen?: ReadonlySet<string>;
  changedFrozen?: ReadonlySet<string>;
}

/** What a review of the book needs to know of the frozen chapters (`PlannerFrozen.authorFrozen`, `changedFrozen`): the ones the author froze, and the ones changed since. */
export function authorHeldChapters(snapshot: BookSnapshot): Required<Pick<PlannerFrozen, "authorFrozen" | "changedFrozen">> {
  return {
    authorFrozen: new Set(snapshot.chapters.filter((chapter) => chapter.frozen?.by === "author").map((chapter) => chapter.slug)),
    changedFrozen: new Set(frozenChanges(snapshot).map((change) => change.slug)),
  };
}

const PLAN_GOAL_CHARACTERS = 1200;

function viewOf(chapter: PlannedChapter): FrozenChapterView {
  return { title: chapter.title, summary: chapter.summary, keyEvents: [...chapter.keyEvents], ...(chapter.storySoFarAtClose ? { storySoFar: chapter.storySoFarAtClose } : {}) };
}

function laterWritten(state: AutopilotState, number: number, auto: boolean): boolean {
  return (state.plan?.chapters ?? []).some((chapter) => chapter.number > number && !(auto && chapter.imported) && chapter.scenes.some((scene) => scene.status !== "planned" && scene.path));
}

/** The revision that checks the chapters after a changed one: BEFORE is what the autopilot knew of it when it was frozen, AFTER its new closing. */
function impactRevision(state: AutopilotState, entry: PendingFrozenReview, chapter: PlannedChapter): RevisionRequest | null {
  if (!entry.started || !laterWritten(state, chapter.number, entry.auto === true)) return null;
  const instruction = entry.kind === "frozen"
    ? `The author changed chapter ${chapter.number} after it was approved: keep the later chapters consistent with it.`
    : `Chapter ${chapter.number} was rewritten to follow the author's new outline entry: keep the later chapters consistent with it.`;
  return {
    id: `${entry.id}-impact`,
    instruction,
    createdAt: entry.at,
    targets: null,
    cursor: 0,
    afterChapter: chapter.number,
    source: { kind: entry.kind, chapterNumber: chapter.number, ...(entry.note ? { note: entry.note } : {}), ...(entry.auto ? { auto: true } : {}), before: entry.started.before, after: viewOf(chapter) },
  };
}

/**
 * What advancing the state does with the decisions (`advanceState` calls it, before it opens the review of the current chapter):
 *
 * - a change of the outline the author kept (`keep-text`, `mark-reviewed`): the plan follows the new entry;
 * - the decision being carried out, once its chapter is closed again: a review and update goes on with the impact on the later chapters
 *   (a revision with `afterChapter`), a review only is done, and so is a rewrite to the outline (after its own impact, when it rewrote);
 * - when nothing is in progress (no question, revision or review) and the planner may start one (`frozen` is given), the first decision
 *   that waits, in the order of the book: the chapter goes back to `review` for one round of the director that applies nothing, or its
 *   rewrite to follow the new entry begins (a revision with `onlyChapter`). A decision whose change is gone is dropped and said.
 *
 * Deterministic: every id and moment comes from the decision or from `frozen.now`.
 */
export function advancePendingReviews(state: AutopilotState, snapshot: BookSnapshot, report: (note: PlanNote) => void, language: string, frozen?: PlannerFrozen): void {
  const plan = state.plan;
  if (!plan || !state.pendingReviews?.length) return;
  const chapterOf = (number: number) => plan.chapters.find((chapter) => chapter.number === number);
  const drop = (entry: PendingFrozenReview) => {
    state.pendingReviews = (state.pendingReviews ?? []).filter((other) => other.id !== entry.id);
  };

  for (const entry of [...state.pendingReviews]) {
    if (entry.started || entry.kind !== "outline" || (entry.action !== "keep-text" && entry.action !== "mark-reviewed")) continue;
    const chapter = chapterOf(entry.number);
    if (chapter) chapter.outlineDigest = entry.fingerprint;
    drop(entry);
  }

  const started = startedReview(state);
  if (started) {
    const chapter = chapterOf(started.number);
    if (!chapter) drop(started);
    else if (chapter.status === "done" && !state.revision && state.review?.chapterNumber !== chapter.number) {
      const rewritten = started.kind === "frozen" ? started.action === "review-and-update" : started.started?.rewritten === true;
      const revision = rewritten ? impactRevision(state, started, chapter) : null;
      if (revision) state.revision = revision;
      drop(started);
      report({
        key: `frozen-reviewed:${started.id}`,
        tone: "ok",
        code: "frozenReviewed",
        chapterNumber: chapter.number,
        title: started.kind === "outline"
          ? revision
            ? text(language, `Chapter ${chapter.number} rewritten to follow the new synopsis entry: now the later chapters are checked`, `Capitolo ${chapter.number} riscritto secondo la nuova voce della Sinossi: ora si controllano i capitoli successivi`)
            : text(language, `Chapter ${chapter.number} follows the new synopsis entry`, `Il capitolo ${chapter.number} segue la nuova voce della Sinossi`)
          : revision
            ? text(language, `Chapter ${chapter.number} reviewed after your change: now the later chapters are checked`, `Capitolo ${chapter.number} rivisto dopo la tua modifica: ora si controllano i capitoli successivi`)
            : text(language, `Chapter ${chapter.number} reviewed after your change, and frozen again`, `Capitolo ${chapter.number} rivisto dopo la tua modifica, e congelato di nuovo`),
      });
    }
  }

  if (!frozen || startedReview(state) || state.question || state.revision || state.review) return;
  const changes = new Map(frozenChanges(snapshot).map((change) => [change.slug, change]));
  const queued = (state.pendingReviews ?? [])
    .filter((entry) => !entry.started && entry.action !== "mark-reviewed" && entry.action !== "keep-text")
    .sort((left, right) => left.number - right.number || (left.kind === right.kind ? 0 : left.kind === "frozen" ? -1 : 1));
  for (const entry of queued) {
    const chapter = chapterOf(entry.number);
    if (!chapter) {
      drop(entry);
      continue;
    }
    // Still in the autopilot's hands (being written, reviewed, revised): the decision waits. So does one about the outline while the plan
    // is made again (the outline is compared with an approved plan only).
    if (chapter.status !== "done" || (entry.kind === "outline" && !plan.approved)) continue;
    const gone = entry.kind === "frozen" ? !changes.has(chapter.slug) : !frozen.outlineWritten.has(entry.number);
    if (gone) {
      drop(entry);
      report({
        key: `frozen-cleared:${entry.id}`,
        tone: "info",
        code: "frozenCleared",
        chapterNumber: entry.number,
        title: text(language, `Chapter ${entry.number}: the change is no longer there, nothing to review`, `Capitolo ${entry.number}: la modifica non c'è più, non c'è nulla da rivedere`),
      });
      continue;
    }
    const before = viewOf(chapter);
    const folder = snapshot.chapters.find((info) => info.slug === chapter.slug);
    if (entry.kind === "frozen") {
      if (!folder?.paragraphs.length) {
        // Nothing left to review: the chapter is written again (a review and update), or frozen as it is (only a review).
        if (entry.action === "review-only") {
          state.pendingReviews = (state.pendingReviews ?? []).map((other) => (other.id === entry.id ? { ...other, action: "mark-reviewed" as const } : other));
          report({ key: `frozen-empty:${entry.id}`, tone: "warning", code: "frozenReviewed", chapterNumber: entry.number, title: text(language, `Chapter ${entry.number} has no scene left: there is nothing to review, it is frozen as it is`, `Il capitolo ${entry.number} non ha più scene: non c'è nulla da rivedere, viene congelato così com'è`) });
          return;
        }
        chapter.status = "planned";
        chapter.scenes = [];
        Object.assign(entry, { started: { at: frozen.now, phase: "rewrite" as const, before, rewritten: true } });
      } else {
        chapter.status = "review";
        chapter.skipReaders = true;
        Object.assign(entry, { started: { at: frozen.now, phase: "review" as const, before } });
      }
    } else {
      beginOutlineRewrite(state, chapter, frozen.outlineWritten.get(entry.number)!, { id: entry.id, createdAt: entry.at, ...(entry.note ? { note: entry.note } : {}), ...(entry.auto ? { auto: true } : {}) });
      Object.assign(entry, { started: { at: frozen.now, phase: "rewrite" as const, before } });
    }
    state.pendingReviews = (state.pendingReviews ?? []).map((other) => (other.id === entry.id ? entry : other));
    if (entry.action !== "review-only") {
      state.finalDone = false;
      delete state.finalReview;
    }
    return;
  }
}

/**
 * Begin rewriting a written chapter to follow its new outline entry: the plan of the chapter follows the entry (its digest, and its text as the goal), and a
 * revision of that chapter alone starts (`onlyChapter`), with the author's note for the director. What the decision about one change and a campaign about the
 * Synopsis both do; the decision checks the later chapters after it, a campaign does not (the author chose each chapter that changes). Mutates `state`.
 */
export function beginOutlineRewrite(state: AutopilotState, chapter: PlannedChapter, outline: OutlineWrittenChange, input: { id: string; createdAt: string; note?: string; auto?: boolean }): void {
  const before = viewOf(chapter);
  chapter.outlineDigest = outline.digest;
  if (outline.body.trim()) {
    chapter.goal = truncate(outline.body.trim(), PLAN_GOAL_CHARACTERS);
    chapter.keyEvents = [];
  }
  state.revision = {
    id: input.id,
    instruction: `Rewrite chapter ${chapter.number} to follow the new entry of the author's outline.`,
    createdAt: input.createdAt,
    targets: null,
    cursor: 0,
    onlyChapter: chapter.number,
    source: { kind: "outline", chapterNumber: chapter.number, ...(input.note ? { note: input.note } : {}), ...(input.auto ? { auto: true } : {}), before },
  };
}

/** When the revision that rewrites a chapter to follow its outline is over: whether it rewrote anything (else there is nothing to check after it). */
export function noteOutlineRewrite(state: AutopilotState, revision: RevisionRequest): void {
  const started = startedReview(state);
  if (!started || started.kind !== "outline" || started.id !== revision.id || !started.started) return;
  started.started = { ...started.started, rewritten: (revision.targets?.length ?? 0) > 0 };
}

// ─── For the hosts: the status of a book ────────────────────────────────────

export interface FrozenStatusEntry {
  kind: FrozenChangeKind;
  number: number;
  slug: string;
  title: string;
  /** The change: what a decision is about. */
  fingerprint: string;
  /** What can be done with it now (`frozenActions`). */
  actions: FrozenAction[];
  /** For a frozen chapter: who froze it, when, and what changed since. */
  by?: FrozenChapterChange["by"];
  frozenAt?: string;
  changed?: FrozenChapterChange["changed"];
  /** For the outline of a written chapter: the new entry. */
  outline?: { title: string; digest: string };
  /** The decision recorded for it, which the next run carries out (a run in progress, at its next step). */
  pending?: { action: FrozenAction; at: string };
  /** The author chose to decide about it later: the autopilot leaves it alone until the author does, or it changes again. */
  deferred?: { at: string };
}

export interface FrozenStatus {
  /** `options.frozenEdits` (`ask` when there is no state yet). */
  mode: FrozenEditsMode;
  /** The changes, in the order of the book, with what can be done with each. */
  changes: FrozenStatusEntry[];
  /** The decisions recorded, also the one being carried out. */
  pending: PendingFrozenReview[];
  /** The chapters whose freeze record cannot be read (they count as not frozen). */
  warnings: Array<{ slug: string; path: string; problem: string }>;
}

/** A chapter frozen or unfrozen by the author (`AutopilotSession.freezeChapter`, `unfreezeChapter`): its record now, `null` when it is not frozen. */
export interface FrozenChapterResult {
  slug: string;
  number: number;
  frozen: ChapterFreeze | null;
}

/** How many chapters of a status have a change that waits for the author (the summary's `frozenChanges`). */
export function frozenWaitingCount(status: Pick<FrozenStatus, "changes">): number {
  return new Set(status.changes.filter((entry) => !entry.pending).map((entry) => entry.number)).size;
}
