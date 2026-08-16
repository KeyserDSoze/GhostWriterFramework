import type { AssistantNoteSaveOperation, AssistantSession, AssistantSessionProvenance } from "./store.ts";

export type ChatNoteDestination = AssistantSessionProvenance & { noteTargetPath: string };

export function sameChatNoteDestination(left: ChatNoteDestination, right: ChatNoteDestination): boolean {
  return left.bookId === right.bookId && left.owner === right.owner && left.repo === right.repo && left.branch === right.branch && left.noteTargetPath === right.noteTargetPath;
}

export function resolveChatNoteDestination(session: AssistantSession, current?: ChatNoteDestination): { destination: ChatNoteDestination; legacyOrCrossBook: boolean } | null {
  const source = session.provenance;
  if (source?.noteTargetPath) return {
    destination: source as ChatNoteDestination,
    legacyOrCrossBook: Boolean(current && current.bookId !== source.bookId),
  };
  return current ? { destination: current, legacyOrCrossBook: true } : null;
}

export function reusableChatNoteOperation(session: AssistantSession, mode: AssistantNoteSaveOperation["mode"], destination: ChatNoteDestination, deleteAfter: boolean): AssistantNoteSaveOperation | undefined {
  const operation = session.noteSaveOperation;
  return operation && operation.mode === mode && operation.deleteAfter === deleteAfter && sameChatNoteDestination(operation.destination, destination) && operation.status !== "complete" ? operation : undefined;
}

export function chatNoteIdempotencyMarker(operationId: string): string {
  return `<!-- narrarium-chat-note:${operationId} -->`;
}

export async function retryChatNoteConflict<T>(attempt: () => Promise<T>, maxAttempts = 3): Promise<T> {
  for (let index = 0; index < maxAttempts; index += 1) {
    try { return await attempt(); }
    catch (error) {
      if (!(error && typeof error === "object" && "kind" in error && error.kind === "conflict") || index === maxAttempts - 1) throw error;
    }
  }
  throw new Error("Chat note conflict retry exhausted.");
}
