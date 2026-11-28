import { BIBLE_DECISIONS_FILE, askQuestion, captureDecision, type DecisionBy, type DecisionInput } from "narrarium-engine";
import { sourceRevisionFromFiles } from "@/assistant/actionValidation";
import type { AssistantMessage } from "@/assistant/store";
import type { BookEntry } from "@/types/settings";

/**
 * «Capture this decision»: the hook an agent calls to put what was agreed in the book. Brainstorming calls it when the author settles something in the conversation, the Copilot
 * and the autopilot may too. It makes the proposal of the file `bible/decisions.md` with the decisions and the open questions added at the end of the log (nothing rewritten), as
 * an `apply-file-updates` the author confirms: nothing is written before. A decision an agent captures is always OPEN: only the author locks, in the Bible.
 */

export interface CaptureRequest {
  decisions?: ReadonlyArray<Pick<DecisionInput, "decision" | "reason" | "chapters" | "files" | "secrets" | "avoid">>;
  questions?: ReadonlyArray<{ question: string; chapters?: readonly number[] }>;
}

export interface BibleDecisionsFile {
  content: string;
  hash: string;
}

export type CaptureOutcome = { message: AssistantMessage; decisions: number; questions: number } | { problem: string };

export function decisionCaptureProposal(input: {
  book: BookEntry;
  branch: string;
  /** `bible/decisions.md` as the book has it now (`null`: not there yet). */
  current: BibleDecisionsFile | null;
  by: DecisionBy;
  italian: boolean;
  request: CaptureRequest;
  /** The words of the proposal and of its reason. */
  text: (decisions: number, questions: number) => string;
  reason: string;
  now?: Date;
}): CaptureOutcome {
  const now = input.now ?? new Date();
  let content = input.current?.content ?? null;
  let decisions = 0;
  let questions = 0;
  for (const decision of input.request.decisions ?? []) {
    const captured = captureDecision(content, { ...decision, by: input.by, status: "open" }, now);
    if ("content" in captured) {
      content = captured.content;
      decisions += 1;
    }
  }
  for (const question of input.request.questions ?? []) {
    const asked = askQuestion(content, { question: question.question, by: input.by, ...(question.chapters ? { chapters: question.chapters } : {}) }, now);
    if ("content" in asked) {
      content = asked.content;
      questions += 1;
    }
  }
  if (content === null || (!decisions && !questions)) return { problem: "no decision and no question to capture" };
  const sourceRevisions = { [BIBLE_DECISIONS_FILE]: input.current?.hash ?? null };
  return {
    decisions,
    questions,
    message: {
      id: crypto.randomUUID(),
      role: "assistant",
      text: input.text(decisions, questions),
      action: {
        kind: "apply-file-updates",
        bookId: input.book.id,
        toolId: "edit-outline",
        owner: input.book.owner,
        repo: input.book.repo,
        branch: input.branch,
        sourceRevision: sourceRevisionFromFiles(sourceRevisions),
        sourceRevisions,
        generatedAt: now.toISOString(),
        updates: [{ path: BIBLE_DECISIONS_FILE, content, reason: input.reason }],
      },
    },
  };
}
