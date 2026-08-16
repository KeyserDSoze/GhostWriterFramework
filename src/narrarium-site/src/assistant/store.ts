import { create } from "zustand";
import type { EntityKind } from "@/narrarium/canon";

export interface AssistantAttachment {
  id: string;
  name: string;
  mimeType: string;
  kind: "text" | "image";
  sizeBytes: number;
  textContent?: string;
  imageDataUrl?: string;
  extractedBytes?: number;
  extractedPages?: number;
  estimatedTokens?: number;
  truncated?: boolean;
  truncationReason?: string;
}

export interface AssistantFileUpdate {
  path: string;
  content: string;
  reason?: string;
  previousContent?: string | null;
  status?: "pending" | "applied" | "failed";
  appliedHash?: string;
  error?: string;
}

export interface AssistantActionProvenance {
  toolId: string;
  owner: string;
  repo: string;
  branch: string;
  sourceRevision: string;
  sourceRevisions: Record<string, string | null>;
  generatedAt: string;
}

export type AssistantAction = (
  | {
      kind: "apply-paragraph-rewrite";
      bookId: string;
      chapterSlug: string;
      paragraphPath: string;
      proposedBody: string;
    }
  | {
      kind: "apply-file-updates";
      bookId: string;
      updates: AssistantFileUpdate[];
    }
  | {
      kind: "undo-file-updates";
      bookId: string;
      updates: AssistantFileUpdate[];
    }
  | {
      kind: "switch-book-branch";
      bookId: string;
      branchName: string;
      createIfMissing?: boolean;
      baseBranch?: string;
    }
  | {
      kind: "confirm-create-pull-request";
      bookId: string;
      base: string;
      head: string;
      title: string;
      body: string;
      baseRevision: string;
      headRevision: string;
      changedFiles: Array<{ filename: string; status: string; additions: number; deletions: number }>;
      existingPullRequests: Array<{ number: number; title: string; htmlUrl: string; state: string }>;
    }
  | {
      kind: "navigate";
      to: string;
      label?: string;
    }
  | {
      kind: "read-aloud";
      bookId: string;
      title: string;
      paths: string[];
      includeFrontmatter?: boolean;
    }
  | {
      kind: "confirm-delete";
      bookId: string;
      target: "note" | "paragraph" | "entity" | "reader-evaluation";
      path: string;
      title: string;
      chapterSlug?: string;
    }
  | {
      kind: "confirm-create-from-research";
      bookId: string;
      researchPath: string;
      entityKind: EntityKind;
      label: string;
      body: string;
      extraFrontmatter: Record<string, unknown>;
      destinationPath: string;
    }
  | {
      kind: "confirm-cancel-feedback-rewrite";
      bookId: string;
      operationId: string;
      scope: "chapter" | "paragraph";
      chapterSlug: string;
      paragraphSlug?: string;
      workflowRequestId: number;
      ownerSessionId: string;
      ownerRequestId: string;
    }
) & Partial<AssistantActionProvenance>;

export interface AssistantMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  action?: AssistantAction;
  branch?: string;
  mutation?: AssistantMutationResult;
}

export interface AssistantMutationResult {
  changedPaths: string[];
  refresh: "book-structure-and-context";
}

export interface AssistantArchivedAction {
  messageId: string;
  kind: AssistantAction["kind"];
  bookId?: string;
  toolId?: string;
  owner?: string;
  repo?: string;
  branch?: string;
  sourceRevision?: string;
  sourceRevisions?: Record<string, string | null>;
  generatedAt?: string;
  paths: string[];
}

export interface AssistantArchivedAttachment {
  id: string;
  name: string;
  mimeType: string;
  kind: AssistantAttachment["kind"];
  sizeBytes: number;
}

export interface AssistantArchiveRollup {
  algorithm: "SHA-256-chain-v1";
  actionCount: number;
  actionDigest: string;
  attachmentCount: number;
  attachmentDigest: string;
}

export interface AssistantSessionArchive {
  summary: string;
  messageCount: number;
  actions: AssistantArchivedAction[];
  attachments: AssistantArchivedAttachment[];
  rollup?: AssistantArchiveRollup;
}

export interface AssistantLosslessSegment {
  format: "narrarium-assistant-chat-segment";
  version: 1;
  id: string;
  createdAt: string;
  previous?: AssistantLosslessSegmentRef;
  messages: AssistantMessage[];
  attachments: AssistantAttachment[];
}

export interface AssistantLosslessSegmentRef {
  id: string;
  sha256: string;
}

export interface AssistantArchiveOrigin {
  provider: "google" | "microsoft";
  account: string;
  fileId?: string;
}

export interface AssistantLosslessArchiveManifest {
  version: 1;
  head?: AssistantLosslessSegmentRef;
  segmentCount: number;
  messageCount: number;
  attachmentCount: number;
  actionCount: number;
  complete: boolean;
  missingRanges: Array<{ from: number; to: number; reason: string }>;
  origin?: AssistantArchiveOrigin;
}

export interface AssistantSessionMeta {
  id: string;
  fileId?: string;
  revision?: string;
  title: string;
  contextTitle: string;
  updatedAt: string;
  /** Monotonic revision of persisted session content. Cloud ETags remain in `revision`. */
  contentRevision?: number;
}

export interface AssistantSessionProvenance {
  bookId: string;
  owner: string;
  repo: string;
  branch: string;
  noteTargetPath?: string;
}

export interface AssistantNoteSaveOperation {
  id: string;
  mode: "full" | "reply-summary";
  destination: AssistantSessionProvenance & { noteTargetPath: string };
  status: "pending" | "note-saved" | "complete" | "delete-failed";
  deleteAfter: boolean;
  updatedAt: string;
}

export interface AssistantQuarantinedAction {
  messageId: string;
  reason: string;
  action: unknown;
}

export interface AssistantSession extends AssistantSessionMeta {
  schemaVersion?: 1;
  messages: AssistantMessage[];
  attachments: AssistantAttachment[];
  archive?: AssistantSessionArchive;
  /** Immutable, lossless source records removed from the active context by compaction. */
  losslessSegments?: AssistantLosslessSegment[];
  losslessArchive?: AssistantLosslessArchiveManifest;
  /** Legacy mirrors retained while existing cloud chats are migrated on save. */
  compactSummary: string;
  compactedMessageCount: number;
  provenance?: AssistantSessionProvenance;
  noteSaveOperation?: AssistantNoteSaveOperation;
  quarantinedActions?: AssistantQuarantinedAction[];
}

interface AssistantState {
  open: boolean;
  busy: boolean;
  sessions: AssistantSessionMeta[];
  sessionAccountIdentity: string | null;
  sessionsLoading: boolean;
  currentSession: AssistantSession | null;
  setOpen: (open: boolean) => void;
  setBusy: (busy: boolean) => void;
  setSessions: (sessions: AssistantSessionMeta[]) => void;
  setSessionAccountIdentity: (identity: string | null) => void;
  setSessionsLoading: (loading: boolean) => void;
  setCurrentSession: (session: AssistantSession | null) => void;
  updateCurrentSession: (updater: (session: AssistantSession) => AssistantSession) => void;
  updateSession: (sessionId: string, updater: (session: AssistantSession) => AssistantSession) => void;
  updateMessage: (messageId: string, patch: Partial<AssistantMessage>) => void;
  updateSessionMessage: (sessionId: string, messageId: string, patch: Partial<AssistantMessage>) => void;
  clearMessages: () => void;
}

export const useAssistantStore = create<AssistantState>((set) => ({
  open: false,
  busy: false,
  sessions: [],
  sessionAccountIdentity: null,
  sessionsLoading: false,
  currentSession: null,
  setOpen: (open) => set({ open }),
  setBusy: (busy) => set({ busy }),
  setSessions: (sessions) => set({ sessions }),
  setSessionAccountIdentity: (identity) => set((state) => state.sessionAccountIdentity === identity
    ? state
    : { sessionAccountIdentity: identity, sessions: [], sessionsLoading: false }),
  setSessionsLoading: (sessionsLoading) => set({ sessionsLoading }),
  setCurrentSession: (currentSession) => set((state) => ({
    currentSession: state.currentSession && currentSession && state.currentSession.id === currentSession.id && assistantSessionContentChanged(state.currentSession, currentSession)
      ? touchAssistantSession(state.currentSession, currentSession)
      : currentSession,
  })),
  updateCurrentSession: (updater) =>
    set((state) => ({
      currentSession: state.currentSession ? mutateAssistantSession(state.currentSession, updater) : state.currentSession,
    })),
  updateSession: (sessionId, updater) =>
    set((state) => ({
      currentSession: state.currentSession?.id === sessionId ? mutateAssistantSession(state.currentSession, updater) : state.currentSession,
    })),
  updateMessage: (messageId, patch) =>
    set((state) => ({
      currentSession: state.currentSession
        ? touchAssistantSession(state.currentSession, {
            ...state.currentSession,
            messages: state.currentSession.messages.map((message) =>
              message.id === messageId ? { ...message, ...patch } : message,
            ),
          })
        : state.currentSession,
    })),
  updateSessionMessage: (sessionId, messageId, patch) =>
    set((state) => ({
      currentSession: state.currentSession?.id === sessionId
        ? touchAssistantSession(state.currentSession, {
            ...state.currentSession,
            messages: state.currentSession.messages.map((message) =>
              message.id === messageId ? { ...message, ...patch } : message,
            ),
          })
        : state.currentSession,
    })),
  clearMessages: () =>
    set((state) => ({
      currentSession: state.currentSession
        ? touchAssistantSession(state.currentSession, { ...state.currentSession, messages: [], attachments: [], archive: emptyAssistantSessionArchive(), compactSummary: "", compactedMessageCount: 0 })
        : state.currentSession,
    })),
}));

export function createEmptyAssistantSession(contextTitle: string, provenance?: AssistantSessionProvenance): AssistantSession {
  const timestamp = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    title: `${contextTitle} ${timestamp.slice(0, 16).replace("T", " ")}`,
    contextTitle,
    updatedAt: timestamp,
    contentRevision: 0,
    messages: [],
    attachments: [],
    archive: emptyAssistantSessionArchive(),
    losslessSegments: [],
    losslessArchive: { version: 1, segmentCount: 0, messageCount: 0, attachmentCount: 0, actionCount: 0, complete: true, missingRanges: [] },
    compactSummary: "",
    compactedMessageCount: 0,
    ...(provenance ? { provenance } : {}),
    quarantinedActions: [],
  };
}

export function emptyAssistantSessionArchive(): AssistantSessionArchive {
  return { summary: "", messageCount: 0, actions: [], attachments: [], rollup: emptyAssistantArchiveRollup() };
}

export function emptyAssistantArchiveRollup(): AssistantArchiveRollup {
  return { algorithm: "SHA-256-chain-v1", actionCount: 0, actionDigest: "", attachmentCount: 0, attachmentDigest: "" };
}

export function normalizeAssistantSession(session: AssistantSession): AssistantSession {
  const legacyCount = Number.isSafeInteger(session.compactedMessageCount) ? Math.max(0, session.compactedMessageCount) : 0;
  const legacyPrefix = session.archive ? [] : (Array.isArray(session.messages) ? session.messages.slice(0, legacyCount) : []);
  const archive = session.archive ?? {
    summary: typeof session.compactSummary === "string" ? session.compactSummary : "",
    messageCount: legacyCount,
    actions: legacyPrefix.flatMap((message) => message.action ? [{
      messageId: message.id,
      kind: message.action.kind,
      ...("bookId" in message.action ? { bookId: message.action.bookId } : {}),
      toolId: message.action.toolId,
      owner: message.action.owner,
      repo: message.action.repo,
      branch: message.action.branch,
      sourceRevision: message.action.sourceRevision,
      sourceRevisions: message.action.sourceRevisions,
      generatedAt: message.action.generatedAt,
      paths: archivedActionPaths(message.action),
    }] : []),
    attachments: legacyCount > 0 ? (Array.isArray(session.attachments) ? session.attachments : []).map(({ id, name, mimeType, kind, sizeBytes }) => ({ id, name, mimeType, kind, sizeBytes })) : [],
    rollup: emptyAssistantArchiveRollup(),
  };
  return {
    ...session,
    schemaVersion: 1,
    contentRevision: typeof session.contentRevision === "number" && Number.isSafeInteger(session.contentRevision) && session.contentRevision >= 0 ? session.contentRevision : 0,
    messages: Array.isArray(session.messages) ? session.messages.slice(legacyPrefix.length) : [],
    attachments: (session.archive || legacyCount === 0) && Array.isArray(session.attachments) ? session.attachments : [],
    archive: {
      summary: typeof archive.summary === "string" ? archive.summary : "",
      messageCount: Number.isSafeInteger(archive.messageCount) ? archive.messageCount : 0,
      actions: Array.isArray(archive.actions) ? archive.actions : [],
      attachments: Array.isArray(archive.attachments) ? archive.attachments : [],
      rollup: archive.rollup ?? emptyAssistantArchiveRollup(),
    },
    losslessSegments: Array.isArray(session.losslessSegments) ? session.losslessSegments : [],
    losslessArchive: session.losslessArchive ?? {
      version: 1,
      segmentCount: 0,
      messageCount: 0,
      attachmentCount: 0,
      actionCount: 0,
      complete: legacyCount === 0,
      missingRanges: legacyCount > 0 ? [{ from: 0, to: legacyCount - 1, reason: "Legacy compaction did not preserve original records." }] : [],
    },
    compactSummary: typeof archive.summary === "string" ? archive.summary : "",
    compactedMessageCount: Number.isSafeInteger(archive.messageCount) ? archive.messageCount : 0,
    quarantinedActions: Array.isArray(session.quarantinedActions) ? session.quarantinedActions : [],
  };
}

export function touchAssistantSession(previous: AssistantSession, next: AssistantSession): AssistantSession {
  if (next === previous) return previous;
  const previousTime = Date.parse(previous.updatedAt);
  const now = Date.now();
  const updatedAt = new Date(Math.max(now, Number.isFinite(previousTime) ? previousTime + 1 : now)).toISOString();
  return { ...next, updatedAt, contentRevision: Math.max(previous.contentRevision ?? 0, next.contentRevision ?? 0) + 1 };
}

function mutateAssistantSession(previous: AssistantSession, updater: (session: AssistantSession) => AssistantSession): AssistantSession {
  return touchAssistantSession(previous, updater(previous));
}

function assistantSessionContentChanged(previous: AssistantSession, next: AssistantSession): boolean {
  const { fileId: _previousFile, revision: _previousCloudRevision, updatedAt: _previousUpdated, contentRevision: _previousContentRevision, ...previousContent } = previous;
  const { fileId: _nextFile, revision: _nextCloudRevision, updatedAt: _nextUpdated, contentRevision: _nextContentRevision, ...nextContent } = next;
  return JSON.stringify(previousContent) !== JSON.stringify(nextContent);
}

function archivedActionPaths(action: AssistantAction): string[] {
  if ("updates" in action) return action.updates.map((update) => update.path);
  if ("path" in action) return [action.path];
  if ("paragraphPath" in action) return [action.paragraphPath];
  if ("researchPath" in action) return [action.researchPath, action.destinationPath];
  if ("paths" in action) return action.paths;
  return [];
}
