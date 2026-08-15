import type { AssistantSession, AssistantSessionMeta } from "./store.ts";

export function assistantSessionSaveFingerprint(session: AssistantSession): string {
  const { fileId: _fileId, revision: _revision, ...persisted } = session;
  void _fileId;
  void _revision;
  return JSON.stringify(persisted);
}

export function upsertAssistantSessionMeta(
  sessions: AssistantSessionMeta[],
  session: AssistantSession,
  handle: AssistantSessionCloudHandle,
): AssistantSessionMeta[] {
  const next: AssistantSessionMeta = {
    id: session.id,
    fileId: handle.fileId,
    revision: handle.revision,
    title: session.title,
    contextTitle: session.contextTitle,
    updatedAt: session.updatedAt,
  };
  return [next, ...sessions.filter((entry) => entry.id !== session.id && entry.fileId !== handle.fileId)];
}

export interface AssistantSessionCloudHandle {
  fileId: string;
  revision?: string;
}

export function attachAssistantSessionCloudHandle(
  currentSession: AssistantSession | null,
  sessionId: string,
  handle: AssistantSessionCloudHandle,
): AssistantSession | null {
  if (!currentSession || currentSession.id !== sessionId) return currentSession;
  if (currentSession.fileId === handle.fileId && currentSession.revision === handle.revision) return currentSession;
  return { ...currentSession, ...handle };
}

type SaveSession = (session: AssistantSession) => Promise<AssistantSessionCloudHandle>;
type SavedSession = (session: AssistantSession, handle: AssistantSessionCloudHandle) => void;
type SaveFailed = (error: unknown) => void;

/** Serializes cloud writes per chat and carries the first created file ID into queued saves. */
export class AssistantSessionSaveQueue {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly handles = new Map<string, AssistantSessionCloudHandle>();
  private generation = 0;

  reset(): void {
    this.generation += 1;
    this.chains.clear();
    this.handles.clear();
  }

  enqueue(session: AssistantSession, save: SaveSession, onSaved: SavedSession, onError: SaveFailed): Promise<void> {
    const generation = this.generation;
    const sessionId = session.id;
    if (session.fileId) this.handles.set(sessionId, { fileId: session.fileId, revision: session.revision });
    const previous = this.chains.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const known = this.handles.get(sessionId);
        const snapshot = known ? { ...session, ...known } : session;
        const handle = await save(snapshot);
        if (generation !== this.generation) return;
        this.handles.set(sessionId, handle);
        onSaved(snapshot, handle);
      })
      .catch((error) => { if (generation === this.generation) onError(error); })
      .finally(() => {
        if (this.chains.get(sessionId) === next) this.chains.delete(sessionId);
      });
    this.chains.set(sessionId, next);
    return next;
  }
}
