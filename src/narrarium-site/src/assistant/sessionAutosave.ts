import type { AssistantSession, AssistantSessionMeta } from "./store.ts";

export const MAX_ASSISTANT_AUTOSAVE_RETRIES = 3;
export const ASSISTANT_AUTOSAVE_RETRY_BASE_MS = 1_000;

export type AssistantSessionSaveRetryPlan =
  | { kind: "retry"; attempt: number; delayMs: number }
  | { kind: "stop"; reason: "permanent" | "exhausted" };

export function assistantSessionSaveRetryPlan(error: unknown, failedAttempts: number): AssistantSessionSaveRetryPlan {
  if (isPermanentAssistantSessionSaveError(error)) return { kind: "stop", reason: "permanent" };
  if (failedAttempts >= MAX_ASSISTANT_AUTOSAVE_RETRIES) return { kind: "stop", reason: "exhausted" };
  return { kind: "retry", attempt: failedAttempts + 1, delayMs: ASSISTANT_AUTOSAVE_RETRY_BASE_MS * 2 ** failedAttempts };
}

export function isPermanentAssistantSessionSaveError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; permanent?: unknown; status?: unknown };
  if (value.permanent === true || value.code === "ASSISTANT_SESSION_TOO_LARGE" || value.code === "INVALID_ASSISTANT_SESSION" || value.code === "ASSISTANT_SESSION_CONFLICT") return true;
  return typeof value.status === "number" && value.status >= 400 && value.status < 500 && value.status !== 408 && value.status !== 429;
}

export function assistantSessionSaveFingerprint(session: AssistantSession): string {
  const { fileId: _fileId, revision: _revision, ...persisted } = session;
  void _fileId;
  void _revision;
  return JSON.stringify(persisted);
}

export function clearFailedAssistantSessionSaveFingerprint(fingerprints: Map<string, string>, sessionId: string, failedFingerprint: string): boolean {
  if (fingerprints.get(sessionId) !== failedFingerprint) return false;
  fingerprints.delete(sessionId);
  return true;
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
    contentRevision: session.contentRevision,
  };
  return [next, ...sessions.filter((entry) => entry.id !== session.id && entry.fileId !== handle.fileId)];
}

export interface AssistantSessionCloudHandle {
  fileId: string;
  revision?: string;
}

export function attachAssistantSessionCloudHandle(
  currentSession: AssistantSession | null,
  savedSnapshot: AssistantSession,
  handle: AssistantSessionCloudHandle,
): AssistantSession | null {
  if (!currentSession || currentSession.id !== savedSnapshot.id) return currentSession;
  const persistedIds = new Set((savedSnapshot.losslessSegments ?? []).map((segment) => segment.id));
  const losslessSegments = (currentSession.losslessSegments ?? []).filter((segment) => !persistedIds.has(segment.id));
  if (currentSession.fileId === handle.fileId && currentSession.revision === handle.revision && losslessSegments.length === (currentSession.losslessSegments ?? []).length) return currentSession;
  return { ...currentSession, ...handle, losslessSegments };
}

type SaveSession = (session: AssistantSession) => Promise<AssistantSessionCloudHandle>;
type SavedSession = (session: AssistantSession, handle: AssistantSessionCloudHandle) => void;
type SaveFailed = (error: unknown) => void;

/** Serializes cloud writes per chat and carries the first created file ID into queued saves. */
export class AssistantSessionSaveQueue {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly handles = new Map<string, AssistantSessionCloudHandle>();
  private readonly retired = new Set<string>();
  private generation = 0;

  reset(): void {
    this.generation += 1;
    this.chains.clear();
    this.handles.clear();
    this.retired.clear();
  }

  /** Block new saves and wait for already queued writes before deleting the cloud file. */
  async retire(sessionId: string): Promise<void> {
    this.retired.add(sessionId);
    await this.chains.get(sessionId);
    this.handles.delete(sessionId);
  }

  resume(sessionId: string): void {
    this.retired.delete(sessionId);
  }

  enqueue(session: AssistantSession, save: SaveSession, onSaved: SavedSession, onError: SaveFailed): Promise<void> {
    const generation = this.generation;
    const sessionId = session.id;
    if (this.retired.has(sessionId)) return Promise.resolve();
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

export function flushAssistantSessionSnapshot(
  queue: AssistantSessionSaveQueue,
  session: AssistantSession,
  save: SaveSession,
): Promise<AssistantSessionCloudHandle> {
  return new Promise((resolve, reject) => {
    void queue.enqueue(session, save, (_snapshot, handle) => resolve(handle), reject);
  });
}

/** Shared by every chat UI so deletion can retire autosave before removing cloud data. */
export const assistantSessionSaveQueue = new AssistantSessionSaveQueue();
