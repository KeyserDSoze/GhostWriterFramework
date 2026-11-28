import { BIBLE_DECISIONS_FILE, askQuestion, decisionConflictText, decisionConflicts, lockedDecisions, readBibleDecisions, serializeBibleDecisions, type BibleDecisions, type ChangedFile, type DecisionConflict } from "../book/bible.js";
import type { AutopilotState } from "./types.js";
import type { BookFileChange, BookStore } from "../book/store.js";
import { StructuredReplyError } from "../util/json.js";

/**
 * A locked decision binds every step of the autopilot: its instructions say so (`authorRules`), and this is what keeps it so when a model does not listen. The changes a step
 * is about to commit are compared, without a model, with what the locked decisions cover (`decisionConflicts`): a change that touches one is not committed. The step is
 * repeated once with the reason (a rejected reply: the model is told which decision and what it must leave as it is), and when it comes back with the same, the run stops and
 * says so to the author, who unlocks the decision or changes the request. Nothing is applied, nothing is lost.
 */
export class LockedDecisionError extends StructuredReplyError {
  readonly conflicts: readonly DecisionConflict[];

  constructor(message: string, conflicts: readonly DecisionConflict[]) {
    super(message);
    this.name = "LockedDecisionError";
    this.conflicts = conflicts;
  }
}

/** The conflicts of the changes of a step with the locked decisions, reading from the store what each file holds now. Nothing is read when no decision is locked. */
export async function lockedDecisionConflicts(store: BookStore, decisions: BibleDecisions | undefined, changes: readonly BookFileChange[]): Promise<DecisionConflict[]> {
  if (!decisions || !lockedDecisions(decisions).length || !changes.length) return [];
  const changed: ChangedFile[] = [];
  for (const change of changes) {
    const before = (await store.read(change.path))?.content ?? null;
    changed.push({ path: change.path, before, after: change.content });
  }
  return decisionConflicts(changed, decisions);
}

/** Throws a `LockedDecisionError` when a change of the step contradicts a locked decision (in English: the text goes to the model and to the log). */
export async function guardLockedDecisions(store: BookStore, decisions: BibleDecisions | undefined, changes: readonly BookFileChange[]): Promise<void> {
  const conflicts = await lockedDecisionConflicts(store, decisions, changes);
  if (!conflicts.length) return;
  const text = conflicts.slice(0, 6).map((conflict) => decisionConflictText(conflict, "en")).join(" ");
  throw new LockedDecisionError(`The result goes against a locked decision of the author and was not applied. ${text} Leave what a locked decision covers as it is.`, conflicts);
}

/**
 * The questions the director asks the author about the story (`DirectorQuestion` of kind `director`) are also open questions of the book (`bible/decisions.md`): the Bible
 * lists them with the others, and Brainstorming reads them. A question that is open in the autopilot and not in the file is added; one the file keeps open that the autopilot
 * no longer asks is closed with the answer the author gave there (or a line saying it was answered in the autopilot). The change of the file to commit with the step, or `null` when
 * there is nothing to say.
 */
export async function syncDirectorQuestions(store: BookStore, state: Pick<AutopilotState, "question" | "interventions">, now: Date): Promise<BookFileChange | null> {
  const asked = state.question && state.question.kind === "director" ? state.question : null;
  const file = await store.read(BIBLE_DECISIONS_FILE);
  const { value } = readBibleDecisions(file?.content);
  let questions = value.questions;
  let changed = false;
  for (const question of questions) {
    if (question.status !== "open" || !question.ref || question.ref === asked?.id) continue;
    const answer = state.interventions.find((entry) => entry.during === question.question && entry.text.includes("»: "));
    const text = answer ? answer.text.slice(answer.text.indexOf("»: ") + 3).trim() : "";
    questions = questions.map((entry) => (entry === question ? { ...entry, status: "answered" as const, answer: text || "Answered in the autopilot." } : entry));
    changed = true;
  }
  let content = changed ? serializeBibleDecisions({ ...value, questions }, file?.content) : file?.content ?? null;
  if (asked && !questions.some((entry) => entry.ref === asked.id)) {
    const next = askQuestion(content, { question: asked.question, by: "director", ref: asked.id, ...(asked.chapterNumber ? { chapters: [asked.chapterNumber] } : {}) }, now);
    if ("content" in next) {
      content = next.content;
      changed = true;
    }
  }
  return changed && content !== null ? { path: BIBLE_DECISIONS_FILE, content, expectedHash: file?.hash ?? null } : null;
}
