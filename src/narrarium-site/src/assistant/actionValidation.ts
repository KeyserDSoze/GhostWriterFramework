import type { AssistantAction, AssistantActionProvenance } from "@/assistant/store";
import { isValidGitBranchName } from "../github/branchNameParser.ts";

export const ASSISTANT_ACTION_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export type AssistantActionValidationFailure =
  | "invalid-action"
  | "missing-provenance"
  | "repository-mismatch"
  | "branch-mismatch"
  | "tool-mismatch"
  | "tool-disabled"
  | "expired"
  | "source-revision-mismatch";

export function sourceRevisionFromFiles(revisions: Record<string, string | null>): string {
  return JSON.stringify(Object.entries(revisions).sort(([left], [right]) => left.localeCompare(right)));
}

export function hasAssistantActionProvenance(action: AssistantAction): action is AssistantAction & AssistantActionProvenance {
  return Boolean(
    typeof action.toolId === "string"
    && typeof action.owner === "string"
    && typeof action.repo === "string"
    && typeof action.branch === "string"
    && typeof action.sourceRevision === "string"
    && action.sourceRevisions && typeof action.sourceRevisions === "object" && !Array.isArray(action.sourceRevisions)
    && Object.entries(action.sourceRevisions).every(([path, revision]) => safePath(path) && (typeof revision === "string" || revision === null))
    && typeof action.generatedAt === "string",
  );
}

function safePath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.split("/").includes("..") && !path.includes("\\");
}

/** The files of the outline (the Synopsis): its description, its entries and the notes of Brainstorming. */
export const OUTLINE_FILE = /^outline\/(?:book\.md|brainstorm\.md|chapters\/\d+\.md)$/;
/** Files a proposal may change. An edit of the outline moves entries (inserting one shifts the ones after it), so it may touch more of them. */
const MAX_FILE_UPDATES = 8;
const MAX_OUTLINE_UPDATES = 100;

/** The files of the simulated readers: one per reader, `personas/<slug>.md` (a built-in reader has one once it changes). */
export const PERSONA_FILE = /^personas\/[^/]+\.md$/;
/** The files of the ghostwriters: one per ghostwriter, `ghostwriters/<slug>.md`. */
export const GHOSTWRITER_FILE = /^ghostwriters\/[^/]+\.md$/;
/** The files of the wildcards: one per wildcard of the book, `wildcards/<slug>.md` (a built-in one has one once the book changes it). */
export const WILDCARD_FILE = /^wildcards\/[^/]+\.md$/;

/**
 * The files whose proposals are applied whole: the outline (moving an entry rewrites the ones it passes) and the files of a page's batch (readers created,
 * turned off and removed together, as the author reviewed them). Such a proposal may touch up to 100 files, and delete files.
 */
const WHOLE_PROPOSAL_FILES = [OUTLINE_FILE, PERSONA_FILE, GHOSTWRITER_FILE, WILDCARD_FILE];

function updatesOf(updates: unknown[], files: RegExp): boolean {
  return updates.every((update) => Boolean(update) && typeof update === "object" && typeof (update as { path?: unknown }).path === "string" && files.test((update as { path: string }).path));
}

function outlineUpdates(updates: unknown[]): boolean {
  return updatesOf(updates, OUTLINE_FILE);
}

function wholeUpdates(updates: unknown[]): boolean {
  return WHOLE_PROPOSAL_FILES.some((files) => updatesOf(updates, files));
}

/**
 * A proposal made only of files of the outline: it may delete entries (`content: null`) and touch up to 100 of them, and it is applied whole,
 * because moving an entry rewrites the ones it passes (applying one file of it would leave two entries with one text).
 */
export function isOutlineProposal(action: AssistantAction): boolean {
  return (action.kind === "apply-file-updates" || action.kind === "undo-file-updates") && Array.isArray(action.updates) && action.updates.length > 0 && outlineUpdates(action.updates);
}

/** A proposal that is applied whole: the outline's, or a page's batch (see `WHOLE_PROPOSAL_FILES`). */
export function isWholeProposal(action: AssistantAction): boolean {
  return (action.kind === "apply-file-updates" || action.kind === "undo-file-updates") && Array.isArray(action.updates) && action.updates.length > 0 && wholeUpdates(action.updates);
}

function validUpdates(updates: unknown): boolean {
  if (!Array.isArray(updates) || updates.length === 0) return false;
  const whole = wholeUpdates(updates);
  if (updates.length > (whole ? MAX_OUTLINE_UPDATES : MAX_FILE_UPDATES)) return false;
  return updates.every((update) => (
    update && typeof update === "object"
    && safePath((update as { path?: unknown }).path)
    && (typeof (update as { content?: unknown }).content === "string" || (whole && (update as { content?: unknown }).content === null))
  ));
}

function revisionsMatchUpdates(action: Extract<AssistantAction, { kind: "apply-file-updates" | "undo-file-updates" }>): boolean {
  if (!action.sourceRevisions) return false;
  const updatePaths = [...new Set(action.updates.map((update) => update.path))].sort();
  const revisionPaths = Object.keys(action.sourceRevisions).sort();
  return updatePaths.length === action.updates.length && updatePaths.length === revisionPaths.length && updatePaths.every((path, index) => path === revisionPaths[index]);
}

export function isValidAssistantActionShape(action: AssistantAction): boolean {
  if (!action || typeof action !== "object" || typeof action.kind !== "string") return false;
  if (action.kind === "apply-paragraph-rewrite") return safePath(action.paragraphPath) && typeof action.proposedBody === "string";
  if (action.kind === "apply-file-updates" || action.kind === "undo-file-updates") return validUpdates(action.updates) && revisionsMatchUpdates(action);
  if (action.kind === "switch-book-branch") return typeof action.branchName === "string" && isValidGitBranchName(action.branchName);
  if (action.kind === "confirm-create-pull-request") return isValidGitBranchName(action.base) && isValidGitBranchName(action.head) && action.base !== action.head
    && typeof action.title === "string" && action.title.trim().length > 0 && typeof action.body === "string"
    && typeof action.baseRevision === "string" && action.baseRevision.length > 0 && typeof action.headRevision === "string" && action.headRevision.length > 0
    && Array.isArray(action.changedFiles) && action.changedFiles.length <= 1000 && action.changedFiles.every((file) => safePath(file.filename) && typeof file.status === "string" && Number.isSafeInteger(file.additions) && file.additions >= 0 && Number.isSafeInteger(file.deletions) && file.deletions >= 0)
    && Array.isArray(action.existingPullRequests) && action.existingPullRequests.length <= 100 && action.existingPullRequests.every((pull) => Number.isSafeInteger(pull.number) && pull.number > 0 && typeof pull.title === "string" && typeof pull.htmlUrl === "string" && typeof pull.state === "string");
  if (action.kind === "confirm-delete") return safePath(action.path) && ["note", "paragraph", "entity", "reader-evaluation"].includes(action.target);
  if (action.kind === "confirm-create-from-research") {
    const revisions = action.sourceRevisions;
    return safePath(action.researchPath) && safePath(action.destinationPath) && action.researchPath !== action.destinationPath
      && typeof action.label === "string" && action.label.trim().length > 0 && typeof action.body === "string" && action.body.trim().length > 0
      && Boolean(revisions && Object.keys(revisions).length === 2 && typeof revisions[action.researchPath] === "string" && revisions[action.destinationPath] === null);
  }
  if (action.kind === "confirm-cancel-feedback-rewrite") return typeof action.bookId === "string" && typeof action.operationId === "string"
    && (action.scope === "chapter" || action.scope === "paragraph") && typeof action.chapterSlug === "string"
    && (action.scope === "chapter" ? action.paragraphSlug === undefined : typeof action.paragraphSlug === "string")
    && Number.isSafeInteger(action.workflowRequestId) && action.workflowRequestId >= 0
    && typeof action.ownerSessionId === "string" && typeof action.ownerRequestId === "string";
  if (action.kind === "navigate") return typeof action.to === "string" && action.to.startsWith("/app/") && !action.to.includes("\\");
  if (action.kind === "raise-routing-limit") return (action.key === "maxTokenAttempts" || action.key === "maxEstimatedCost") && Number.isFinite(action.from) && Number.isFinite(action.to) && action.to > action.from;
  if (action.kind === "read-aloud") return Array.isArray(action.paths) && action.paths.length > 0 && action.paths.every(safePath);
  return false;
}

export function validateAssistantAction(input: {
  action: AssistantAction;
  owner: string;
  repo: string;
  branch: string;
  expectedToolId: string | null;
  toolEnabled: boolean;
  sourceRevision: string;
  now?: number;
}): AssistantActionValidationFailure | null {
  const { action } = input;
  if (!isValidAssistantActionShape(action)) return "invalid-action";
  if (!hasAssistantActionProvenance(action)) return "missing-provenance";
  if (action.owner.toLowerCase() !== input.owner.toLowerCase() || action.repo.toLowerCase() !== input.repo.toLowerCase()) return "repository-mismatch";
  if (action.branch !== input.branch) return "branch-mismatch";
  if (!input.expectedToolId || action.toolId !== input.expectedToolId) return "tool-mismatch";
  if (!input.toolEnabled) return "tool-disabled";
  const generatedAt = Date.parse(action.generatedAt);
  const now = input.now ?? Date.now();
  if (!Number.isFinite(generatedAt) || generatedAt > now + 5 * 60 * 1_000 || now - generatedAt > ASSISTANT_ACTION_MAX_AGE_MS) return "expired";
  if (action.sourceRevision !== input.sourceRevision) return "source-revision-mismatch";
  return null;
}
