import { emptyAssistantArchiveRollup, type AssistantAction, type AssistantArchivedAction, type AssistantArchivedAttachment, type AssistantAttachment, type AssistantSession, type AssistantSessionArchive } from "./store.ts";

export const ACTIVE_MESSAGE_LIMIT = 6;
export const COMPACTION_MESSAGE_THRESHOLD = 12;
export const COMPACTION_SIZE_THRESHOLD_BYTES = 384 * 1024;
export const MAX_COMPACTION_INPUT_CHARS = 80_000;
export const MAX_ARCHIVE_SUMMARY_CHARS = 20_000;
export const MAX_ARCHIVE_RECORD_BYTES = 512 * 1024;

const encoder = new TextEncoder();

export function assistantSessionCompactionTarget(session: AssistantSession): number | null {
  const oversized = encoder.encode(JSON.stringify({ messages: session.messages, attachments: session.attachments })).length > COMPACTION_SIZE_THRESHOLD_BYTES;
  if (session.messages.length <= COMPACTION_MESSAGE_THRESHOLD && !oversized) return null;
  if (!session.messages.length) return 0;
  return Math.max(oversized ? 1 : 0, session.messages.length - ACTIVE_MESSAGE_LIMIT);
}

export function mergeAssistantSessionCompaction(
  currentSession: AssistantSession | null,
  expectedSessionId: string,
  compactedSession: AssistantSession,
): AssistantSession | null {
  if (!currentSession || currentSession.id !== expectedSessionId) return currentSession;
  if (compactedSession.compactedMessageCount < currentSession.compactedMessageCount) return currentSession;
  const removedCount = compactedSession.compactedMessageCount - currentSession.compactedMessageCount;
  if (removedCount > currentSession.messages.length) return currentSession;
  const expectedRemainingId = compactedSession.messages[0]?.id;
  if (expectedRemainingId && currentSession.messages[removedCount]?.id !== expectedRemainingId) return currentSession;
  const archive = compactedSession.archive ?? {
    summary: compactedSession.compactSummary,
    messageCount: compactedSession.compactedMessageCount,
    actions: [],
    attachments: [],
  };
  const archivedAttachmentIds = new Set(archive.attachments.map((attachment) => attachment.id));
  if (removedCount === 0 && !currentSession.attachments.some((attachment) => archivedAttachmentIds.has(attachment.id))) return currentSession;
  return {
    ...currentSession,
    messages: currentSession.messages.slice(removedCount),
    attachments: currentSession.attachments.filter((attachment) => !archivedAttachmentIds.has(attachment.id)),
    archive,
    compactSummary: compactedSession.compactSummary,
    compactedMessageCount: compactedSession.compactedMessageCount,
  };
}

export function compactionText(session: AssistantSession, removeCount: number): string {
  const previous = session.archive?.summary || session.compactSummary;
  const next = session.messages.slice(0, removeCount).map((message) => `${message.role.toUpperCase()}: ${message.text}`).join("\n\n");
  return truncateText([previous ? `PREVIOUS ARCHIVE SUMMARY:\n${previous}` : "", next ? `NEW MESSAGES TO ARCHIVE:\n${next}` : ""].filter(Boolean).join("\n\n"), MAX_COMPACTION_INPUT_CHARS);
}

export function archiveAction(messageId: string, action: AssistantAction): AssistantArchivedAction {
  const paths = actionPaths(action);
  return {
    messageId,
    kind: action.kind,
    ...("bookId" in action ? { bookId: action.bookId } : {}),
    toolId: action.toolId,
    owner: action.owner,
    repo: action.repo,
    branch: action.branch,
    sourceRevision: action.sourceRevision,
    sourceRevisions: action.sourceRevisions,
    generatedAt: action.generatedAt,
    paths,
  };
}

export async function appendAssistantArchiveRecords(
  archive: AssistantSessionArchive,
  actions: AssistantArchivedAction[],
  attachments: AssistantAttachment[],
): Promise<Pick<AssistantSessionArchive, "actions" | "attachments" | "rollup">> {
  const retainedActions = [...archive.actions, ...actions];
  const retainedAttachments: AssistantArchivedAttachment[] = [...archive.attachments, ...attachments.map(({ id, name, mimeType, kind, sizeBytes }) => ({ id, name, mimeType, kind, sizeBytes }))];
  const rollup = { ...(archive.rollup ?? emptyAssistantArchiveRollup()) };
  let retainedBytes = archiveRecordBytes(retainedActions, retainedAttachments);
  while (retainedBytes > MAX_ARCHIVE_RECORD_BYTES && retainedActions.length) {
    const previousLength = retainedActions.length;
    const record = retainedActions.shift()!;
    retainedBytes -= encoder.encode(JSON.stringify(record)).length + (previousLength > 1 ? 1 : 0);
    rollup.actionDigest = await chainedDigest(rollup.actionDigest, "action", record);
    rollup.actionCount += 1;
  }
  while (retainedBytes > MAX_ARCHIVE_RECORD_BYTES && retainedAttachments.length) {
    const previousLength = retainedAttachments.length;
    const record = retainedAttachments.shift()!;
    retainedBytes -= encoder.encode(JSON.stringify(record)).length + (previousLength > 1 ? 1 : 0);
    rollup.attachmentDigest = await chainedDigest(rollup.attachmentDigest, "attachment", record);
    rollup.attachmentCount += 1;
  }
  return { actions: retainedActions, attachments: retainedAttachments, rollup };
}

function archiveRecordBytes(actions: AssistantArchivedAction[], attachments: AssistantArchivedAttachment[]): number {
  return encoder.encode(JSON.stringify({ actions, attachments })).length;
}

async function chainedDigest(previous: string, type: "action" | "attachment", record: AssistantArchivedAction | AssistantArchivedAttachment): Promise<string> {
  const bytes = encoder.encode(JSON.stringify({ previous, type, record }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = "\n\n[content truncated to fit the context limit]";
  if (maxChars <= marker.length) return marker.slice(0, maxChars);
  const retained = maxChars - marker.length;
  const head = Math.ceil(retained * 0.6);
  return value.slice(0, head) + marker + value.slice(value.length - (retained - head));
}

function actionPaths(action: AssistantAction): string[] {
  if ("updates" in action) return action.updates.map((update) => update.path);
  if ("path" in action) return [action.path];
  if ("paragraphPath" in action) return [action.paragraphPath];
  if ("researchPath" in action) return [action.researchPath, action.destinationPath];
  if ("paths" in action) return action.paths;
  return [];
}
