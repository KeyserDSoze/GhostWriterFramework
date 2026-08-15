import type { AssistantAction, AssistantActionProvenance } from "@/assistant/store";

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

function validUpdates(updates: unknown): boolean {
  return Array.isArray(updates) && updates.length > 0 && updates.length <= 8 && updates.every((update) => (
    update && typeof update === "object"
    && safePath((update as { path?: unknown }).path)
    && typeof (update as { content?: unknown }).content === "string"
  ));
}

export function isValidAssistantActionShape(action: AssistantAction): boolean {
  if (!action || typeof action !== "object" || typeof action.kind !== "string") return false;
  if (action.kind === "apply-paragraph-rewrite") return safePath(action.paragraphPath) && typeof action.proposedBody === "string";
  if (action.kind === "apply-file-updates" || action.kind === "undo-file-updates") return validUpdates(action.updates);
  if (action.kind === "switch-book-branch") return typeof action.branchName === "string" && /^[A-Za-z0-9._/-]+$/.test(action.branchName) && !action.branchName.includes("..");
  if (action.kind === "confirm-delete") return safePath(action.path) && ["note", "paragraph", "entity", "reader-evaluation"].includes(action.target);
  if (action.kind === "confirm-create-from-research") {
    const revisions = action.sourceRevisions;
    return safePath(action.researchPath) && safePath(action.destinationPath) && action.researchPath !== action.destinationPath
      && typeof action.label === "string" && action.label.trim().length > 0 && typeof action.body === "string" && action.body.trim().length > 0
      && Boolean(revisions && Object.keys(revisions).length === 2 && typeof revisions[action.researchPath] === "string" && revisions[action.destinationPath] === null);
  }
  if (action.kind === "navigate") return typeof action.to === "string" && action.to.startsWith("/app/") && !action.to.includes("\\");
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
