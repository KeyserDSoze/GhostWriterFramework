import type { ReactNode } from "react";
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
  /**
   * A text the author pasted and set apart as material («Use this text as material»): the request reads it as data, as a text pasted in the message, not as a file (the limits of the
   * attachments do not cut it, and the import of a synopsis reads it).
   */
  material?: boolean;
}

export interface AssistantFileUpdate {
  path: string;
  /** The new text of the file; `null` deletes it (only an entry of the outline, see `isOutlineProposal`). */
  content: string | null;
  reason?: string;
  previousContent?: string | null;
  status?: "pending" | "applied" | "failed";
  /** Set when applying stopped on this file because it changed after the proposal was made: the author chooses between their version and the proposal's. */
  conflict?: "local-edits" | "changed";
  /** The hash of what was written; `null` when the update deleted the file. */
  appliedHash?: string | null;
  error?: string;
}

/** One line of the review of a proposal for a page: a thing of the page (a reader, a ghostwriter, a field) with its resulting state and what changes. */
export interface PageChangeRow {
  /** What the thing is in the book: a reader's id, a ghostwriter's slug, the key of a field. */
  id: string;
  name: string;
  /** What kind of thing it is, as the table says it (standard, genre, custom…). */
  kind?: string;
  builtin?: boolean;
  /** On or off before and after, for what has a switch: `null` when it does not exist before (created) or after (removed). */
  before?: boolean | null;
  after?: boolean | null;
  /** A value before and after, for a field (short). */
  from?: string;
  to?: string;
  change: "created" | "edited" | "turned-on" | "turned-off" | "removed" | "unchanged";
  /** The fields that change. */
  fields?: string[];
  /** Removing it was asked, and it is built in: it is turned off instead. */
  kept?: boolean;
}

/** The review of a proposal for a page: every thing of the page with its resulting state, shown before it is applied. */
export interface PageChangesReview {
  /** The page (`PageId`), or `outline` for the Synopsis. */
  page: string;
  rows: PageChangeRow[];
  /**
   * What the proposal leaves aside unless the author asks, from the review: the edits of entries the author wrote (`rows`, the ids of their rows), with the files and the versions they
   * were made on. Adding them moves them into the proposal's updates; nothing of them is written before that.
   */
  optional?: { rows: string[]; updates: AssistantFileUpdate[]; sourceRevisions: Record<string, string | null> };
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
      /** A proposal for a page: what the author reviews in place of the files. */
      review?: PageChangesReview;
    }
  | {
      kind: "undo-file-updates";
      bookId: string;
      updates: AssistantFileUpdate[];
      review?: PageChangesReview;
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
      /**
       * A call whose fallbacks the routing limits left out (Settings > AI Router > Routing options): the author can raise `key` from `from` to `to` (what the fallbacks needed,
       * `estimated`, with room) and send the request again, in one click. `raised` once it is: the message then offers to put `from` back.
       */
      kind: "raise-routing-limit";
      key: "maxTokenAttempts" | "maxEstimatedCost";
      from: number;
      to: number;
      estimated: number;
      raised?: boolean;
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
  provider: "local" | "github" | "google" | "microsoft";
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
  /** A chat of Brainstorming, the mode of the Copilot on the Synopsis page: listed apart from the Copilot's, with the other chats of its book (`bookId`). */
  mode?: "brainstorming";
  bookId?: string;
}

/** The book Brainstorming works on, and the title its new chats take. */
export interface BrainstormingTarget {
  bookId: string;
  title: string;
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

/**
 * A compaction of the context of a chat (#122): the older part of the conversation summarised, so that the next requests carry the summary and the messages after it. The
 * messages themselves stay in the chat; the marker of the compaction says what was summarised.
 */
export interface ContextCompaction {
  id: string;
  /** The last message the summary covers: the next requests carry the summary and the messages after it. */
  throughMessageId: string;
  /** How many messages of the chat the summary covers, from its start. */
  messageCount: number;
  /** How many messages this compaction added to the summary: what its marker says. */
  coveredCount: number;
  summary: string;
  /** Written by a model (`chat-resume`), or made from the messages when the model did not answer. */
  source: "model" | "fallback";
  /** At about 90% of the window (`auto`), or asked for (`/compact`, «Compact now»). */
  trigger: "auto" | "manual";
  at: string;
  /** The tokens of the next request before the compaction and after it, as estimated. */
  beforeTokens: number;
  afterTokens: number;
  /** «Undo for the next message»: the next request carries the whole conversation, once. */
  skipNext?: boolean;
}

/** The first request of the last turn of a chat, part by part, and what its provider counted: what the context ring measures the next message against. */
export interface ContextLastRequest {
  integrationId: string;
  model: string;
  /** In likely tokens (see `contextBudget.ts`). */
  shape: { system: number; tools: number; files: number; pageState: number; attachments: number; summary: number; conversation: number; request: number; results: number; other: number };
  /** What the provider reported for it, when it did. */
  usage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
  /** What the provider reported for the whole turn, every round of a tool loop included. */
  turn?: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
  /** The attachments it carried (`attachmentsKey`) and its summary (`summaryKey`): the next request starts the same way while they are the same. */
  attachmentsKey?: string;
  summaryKey?: string;
  /** Its message had text pasted with it (material of that request only). */
  pasted?: boolean;
  at: string;
}

export interface AssistantSession extends AssistantSessionMeta {
  schemaVersion?: 1;
  messages: AssistantMessage[];
  attachments: AssistantAttachment[];
  /** The compactions of the context, in order: the last one is in force (see `contextCompaction.ts`). */
  contextCompactions?: ContextCompaction[];
  contextLast?: ContextLastRequest;
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
  /** Secret bodies were disclosed on these explicit author routes. Leaving them invalidates this context. */
  sensitiveSecretPaths?: string[];
}

interface AssistantState {
  open: boolean;
  launchMode: "chat" | "voice" | null;
  busy: boolean;
  sessions: AssistantSessionMeta[];
  sessionAccountIdentity: string | null;
  sessionsLoading: boolean;
  currentSession: AssistantSession | null;
  /**
   * Brainstorming, the mode of the Copilot that the Synopsis page opens for its book, or `null` for the Copilot. While it lasts the Copilot's chat is
   * kept aside (`copilotSession`) and comes back when the mode ends: «Back to Copilot», the Copilot's own launcher, or leaving the page.
   */
  brainstorming: BrainstormingTarget | null;
  copilotSession: AssistantSession | null;
  /** What a page adds to the launcher of the shell (the Synopsis adds Brainstorming's), drawn by the page's own code. */
  pageLauncher: (() => ReactNode) | null;
  setOpen: (open: boolean) => void;
  launch: (mode: "chat" | "voice") => void;
  startBrainstorming: (target: BrainstormingTarget) => void;
  stopBrainstorming: () => void;
  setPageLauncher: (launcher: (() => ReactNode) | null) => void;
  consumeLaunchMode: () => void;
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
  launchMode: null,
  busy: false,
  sessions: [],
  sessionAccountIdentity: null,
  sessionsLoading: false,
  currentSession: null,
  brainstorming: null,
  copilotSession: null,
  pageLauncher: null,
  setOpen: (open) => set({ open }),
  launch: (launchMode) => set((state) => ({ ...withoutBrainstorming(state), open: true, launchMode })),
  // The chat of the book's Brainstorming is opened by the panel (its latest, or a new one); the Copilot's waits aside.
  startBrainstorming: (target) => set((state) => {
    const current = state.currentSession;
    const brainstorm = current?.mode === "brainstorming";
    return {
      brainstorming: target,
      open: true,
      launchMode: "chat",
      copilotSession: brainstorm ? state.copilotSession : current,
      currentSession: brainstorm && current.bookId === target.bookId ? current : null,
    };
  }),
  stopBrainstorming: () => set(withoutBrainstorming),
  setPageLauncher: (pageLauncher) => set({ pageLauncher }),
  consumeLaunchMode: () => set({ launchMode: null }),
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

export function createEmptyAssistantSession(contextTitle: string, provenance?: AssistantSessionProvenance, brainstorming?: { bookId: string }): AssistantSession {
  const timestamp = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    title: `${contextTitle} ${timestamp.slice(0, 16).replace("T", " ")}`,
    contextTitle,
    updatedAt: timestamp,
    contentRevision: 0,
    ...(brainstorming ? { mode: "brainstorming" as const, bookId: brainstorming.bookId } : {}),
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

/** The end of Brainstorming: the Copilot's chat comes back, and the Brainstorming one stays in the history of its book. */
function withoutBrainstorming(state: AssistantState): Partial<AssistantState> {
  const current = state.currentSession;
  if (!state.brainstorming && current?.mode !== "brainstorming") return {};
  return {
    brainstorming: null,
    copilotSession: null,
    // While Brainstorming lasts the panel holds its chat, or none while it opens it: either way the Copilot's chat is the one that comes back.
    currentSession: !current || current.mode === "brainstorming" ? state.copilotSession : current,
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
    sensitiveSecretPaths: Array.isArray(session.sensitiveSecretPaths) ? [...new Set(session.sensitiveSecretPaths)] : [],
  };
}

export function invalidateAssistantSecretContext(session: AssistantSession, allowedSecretPath: string | null): AssistantSession {
  const sensitive = session.sensitiveSecretPaths ?? [];
  if (!sensitive.length || (allowedSecretPath && sensitive.every((path) => path === allowedSecretPath))) return session;
  return touchAssistantSession(session, {
    ...session,
    messages: [{ id: crypto.randomUUID(), role: "system", text: "Secret-author conversation context was cleared after leaving its explicit secret route." }],
    attachments: [],
    archive: emptyAssistantSessionArchive(),
    losslessSegments: [],
    losslessArchive: { version: 1, segmentCount: 0, messageCount: 0, attachmentCount: 0, actionCount: 0, complete: true, missingRanges: [] },
    compactSummary: "",
    compactedMessageCount: 0,
    quarantinedActions: [],
    sensitiveSecretPaths: [],
  });
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
