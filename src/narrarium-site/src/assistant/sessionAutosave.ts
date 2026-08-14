import type { AssistantSession, AssistantSessionMeta } from "./store.ts";

export function assistantSessionSaveFingerprint(session: AssistantSession): string {
  const { fileId: _fileId, ...persisted } = session;
  void _fileId;
  return JSON.stringify(persisted);
}

export function upsertAssistantSessionMeta(
  sessions: AssistantSessionMeta[],
  session: AssistantSession,
  fileId: string,
): AssistantSessionMeta[] {
  const next: AssistantSessionMeta = {
    id: session.id,
    fileId,
    title: session.title,
    contextTitle: session.contextTitle,
    updatedAt: session.updatedAt,
  };
  return [next, ...sessions.filter((entry) => entry.id !== session.id && entry.fileId !== fileId)];
}

export function attachAssistantSessionFileId(
  currentSession: AssistantSession | null,
  sessionId: string,
  fileId: string,
): AssistantSession | null {
  if (!currentSession || currentSession.id !== sessionId || currentSession.fileId === fileId) return currentSession;
  return { ...currentSession, fileId };
}

type SaveSession = (session: AssistantSession) => Promise<string>;
type SavedSession = (session: AssistantSession, fileId: string) => void;
type SaveFailed = (error: unknown) => void;

/** Serializes cloud writes per chat and carries the first created file ID into queued saves. */
export class AssistantSessionSaveQueue {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly fileIds = new Map<string, string>();

  enqueue(session: AssistantSession, save: SaveSession, onSaved: SavedSession, onError: SaveFailed): Promise<void> {
    const sessionId = session.id;
    if (session.fileId) this.fileIds.set(sessionId, session.fileId);
    const previous = this.chains.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const knownFileId = this.fileIds.get(sessionId);
        const snapshot = knownFileId && session.fileId !== knownFileId ? { ...session, fileId: knownFileId } : session;
        const fileId = await save(snapshot);
        this.fileIds.set(sessionId, fileId);
        onSaved(snapshot, fileId);
      })
      .catch(onError)
      .finally(() => {
        if (this.chains.get(sessionId) === next) this.chains.delete(sessionId);
      });
    this.chains.set(sessionId, next);
    return next;
  }
}
