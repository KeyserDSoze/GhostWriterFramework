import type { BookEntry } from "@/types/settings";
import type { AssistantFileUpdate } from "@/assistant/store";
import { getLocalFile, getLocalRepository } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { isRepositoryError, repositoryErrorDescription } from "@/repository/repositoryError";
import { RepositoryConflictError, type MutationDelivery } from "@/repository/safeRepositoryMutation";

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** What the author is told once a change of the Copilot was applied (or undone): the sentence of the toast, or `null` when the usual one says it all. */
export interface DeliveryNotice {
  title?: string;
  description?: string;
  /** The sync stopped on a real conflict: the resolver is open, and this is how to open it again. */
  conflict?: { files: string[] };
}

/**
 * What became of the change at GitHub, in words the author can act on. A change that reached GitHub alone, or one that lives on this device by the book's own
 * nature (a book kept here), says nothing more than the usual toast.
 */
export function deliveryNotice(delivery: MutationDelivery | undefined, kind: "apply" | "undo", baseTitle: string, t: Translate): DeliveryNotice | null {
  if (!delivery) return null;
  if (delivery.kind === "published") {
    if (delivery.earlier === 0) return null;
    return {
      title: t(kind === "apply" ? "copilotApply.appliedSynced" : "copilotApply.undoneSynced", { count: delivery.earlier }),
      ...(delivery.pulled > 0 ? { description: t("copilotApply.pulledToo", { count: delivery.pulled }) } : {}),
    };
  }
  if (delivery.kind === "conflict") {
    return { title: t(kind === "apply" ? "copilotApply.conflictApplied" : "copilotApply.conflictUndone"), description: t("copilotApply.conflict", { files: delivery.files.join(", "), count: delivery.files.length }), conflict: { files: delivery.files } };
  }
  if (delivery.reason === "local-book") return null;
  return { title: baseTitle, description: t(`copilotApply.saved.${delivery.reason}`, { reason: delivery.reason === "failed" ? repositoryErrorDescription(delivery.error, t) : undefined }) };
}

/** Why a change could not be applied, in the author's language, with what to do. Never the raw text of an error. */
export function applyFailureText(error: unknown, t: Translate): string {
  if (error instanceof RepositoryConflictError) return t("copilotApply.failed.changed", { file: error.path ?? "" });
  if ((error instanceof DOMException && error.name === "AbortError") || isRepositoryError(error, "abort")) return t("copilotApply.failed.cancelled");
  if (isRepositoryError(error)) return repositoryErrorDescription(error, t);
  return t("copilotApply.failed.generic");
}

/**
 * How a file changed since the proposal was made, when the apply stopped on it: edits of the author's that are not saved as a change yet (the working copy
 * holds them as they are), or a change that is saved (a commit here, or what GitHub sent). Either way the author chooses; nothing is overwritten unasked.
 */
export async function conflictKindOf(book: BookEntry, branch: string, path: string): Promise<NonNullable<AssistantFileUpdate["conflict"]>> {
  try {
    const scope = captureRepositoryOperationScope();
    const local = await getLocalRepository(book.owner, book.repo, branch, scope);
    const file = local ? await getLocalFile(local.id, path, scope) : null;
    return file && file.status !== "clean" && !file.committed ? "local-edits" : "changed";
  } catch {
    return "changed";
  }
}

/** The proposal after the author kept their own version of a file: that file leaves it. */
export function withoutUpdate(updates: AssistantFileUpdate[], path: string): AssistantFileUpdate[] {
  return updates.filter((update) => update.path !== path);
}
