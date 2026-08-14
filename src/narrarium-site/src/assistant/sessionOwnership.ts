export interface AssistantRequestOwner {
  requestId: string;
  sessionId: string;
}

export function isAssistantRequestOwned(
  active: AssistantRequestOwner | null,
  requestId: string,
  sessionId: string,
  currentSessionId: string | undefined,
  aborted: boolean,
): boolean {
  return !aborted
    && active?.requestId === requestId
    && active.sessionId === sessionId
    && currentSessionId === sessionId;
}
