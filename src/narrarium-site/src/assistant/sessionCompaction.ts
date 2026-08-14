import type { AssistantSession } from "./store.ts";

export function assistantSessionCompactionTarget(session: AssistantSession): number | null {
  if (session.messages.length <= 12) return null;
  const targetCount = session.messages.length - 6;
  return targetCount > session.compactedMessageCount ? targetCount : null;
}

export function mergeAssistantSessionCompaction(
  currentSession: AssistantSession | null,
  expectedSessionId: string,
  compactedSession: AssistantSession,
): AssistantSession | null {
  if (!currentSession || currentSession.id !== expectedSessionId) return currentSession;
  if (compactedSession.compactedMessageCount <= currentSession.compactedMessageCount) return currentSession;
  return {
    ...currentSession,
    compactSummary: compactedSession.compactSummary,
    compactedMessageCount: compactedSession.compactedMessageCount,
  };
}
