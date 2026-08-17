export interface AssistantRequestOwner {
  requestId: string;
  sessionId: string;
  contextGeneration: number;
  pathname: string;
  bookId: string | null;
  branch: string;
  secretPath: string | null;
}

export function isAssistantRequestOwned(
  active: AssistantRequestOwner | null,
  expected: AssistantRequestOwner,
  currentSessionId: string | undefined,
  currentContext: Omit<AssistantRequestOwner, "requestId" | "sessionId">,
  aborted: boolean,
): boolean {
  return !aborted
    && active?.requestId === expected.requestId
    && active.sessionId === expected.sessionId
    && active.contextGeneration === expected.contextGeneration
    && active.pathname === expected.pathname
    && active.bookId === expected.bookId
    && active.branch === expected.branch
    && active.secretPath === expected.secretPath
    && currentSessionId === expected.sessionId
    && currentContext.contextGeneration === expected.contextGeneration
    && currentContext.pathname === expected.pathname
    && currentContext.bookId === expected.bookId
    && currentContext.branch === expected.branch
    && currentContext.secretPath === expected.secretPath;
}

export interface ConfirmedMutationOwner {
  account: string | null;
  sessionId: string;
  bookId: string;
  branch: string;
  pathname: string;
}

export function isConfirmedMutationOwned(expected: ConfirmedMutationOwner, current: ConfirmedMutationOwner, aborted: boolean): boolean {
  return !aborted
    && expected.account === current.account
    && expected.sessionId === current.sessionId
    && expected.bookId === current.bookId
    && expected.branch === current.branch
    && expected.pathname === current.pathname;
}
