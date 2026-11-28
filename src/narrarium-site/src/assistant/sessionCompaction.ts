import { assistantSegmentSha256 } from "./chatSegments.ts";
import { emptyAssistantArchiveRollup, type AssistantAction, type AssistantArchivedAction, type AssistantArchivedAttachment, type AssistantAttachment, type AssistantLosslessSegment, type AssistantMessage, type AssistantSession, type AssistantSessionArchive } from "./store.ts";

export const MAX_ARCHIVE_SUMMARY_CHARS = 20_000;
export const MAX_ARCHIVE_RECORD_BYTES = 512 * 1024;
/**
 * The size past which a chat moves messages to its lossless archive (#122): a chat keeps every message (its context is compacted, not its messages), and is saved as one file of
 * at most 8 MB (`MAX_ASSISTANT_SESSION_BYTES`). Past 4 MB of messages and attachments, the oldest messages that the compaction in force already summarised go to archive segments
 * (kept whole, apart, shown read-only in the chat) until the chat is back under 3 MB.
 */
export const STORAGE_ARCHIVE_BYTES = 4 * 1024 * 1024;
export const STORAGE_TARGET_BYTES = 3 * 1024 * 1024;
/** The same past 2,000 messages, back to 1,500 (a chat file holds at most 10,000). */
export const STORAGE_ARCHIVE_MESSAGES = 2_000;
export const STORAGE_TARGET_MESSAGES = 1_500;
/** A segment of the archive stays under its limit (`MAX_ASSISTANT_LOSSLESS_SEGMENT_BYTES`, 2 MB). */
const STORAGE_SEGMENT_BYTES = 1536 * 1024;

const encoder = new TextEncoder();
const bytesOf = (value: unknown) => encoder.encode(JSON.stringify(value)).length;

/**
 * How many of the first messages a chat too large to keep moves to its archive: only messages that the compaction in force covers (its summary already says them), the fewest
 * that bring the chat back under `STORAGE_TARGET_BYTES` and `STORAGE_TARGET_MESSAGES`. 0 when the chat is within `STORAGE_ARCHIVE_BYTES` and `STORAGE_ARCHIVE_MESSAGES`, or
 * when its compaction covers nothing yet.
 */
export function storageArchiveCount(session: Pick<AssistantSession, "messages" | "attachments" | "contextCompactions">): number {
  const tooMany = session.messages.length > STORAGE_ARCHIVE_MESSAGES;
  const size = bytesOf({ messages: session.messages, attachments: session.attachments });
  if (size <= STORAGE_ARCHIVE_BYTES && !tooMany) return 0;
  const compaction = session.contextCompactions?.[session.contextCompactions.length - 1];
  const point = compaction ? session.messages.findIndex((message) => message.id === compaction.throughMessageId) : -1;
  let remaining = size;
  let count = 0;
  while (count <= point && (remaining > STORAGE_TARGET_BYTES || session.messages.length - count > STORAGE_TARGET_MESSAGES)) {
    remaining -= bytesOf(session.messages[count]) + 1;
    count += 1;
  }
  return count;
}

/** The first `count` messages of a chat moved to new segments of its lossless archive, each within its size; the attachments stay where they are, in the chat. */
export async function archiveForStorage(session: AssistantSession, count: number): Promise<AssistantSession> {
  if (count <= 0) return session;
  const removed = session.messages.slice(0, count);
  const groups: AssistantMessage[][] = [];
  let group: AssistantMessage[] = [];
  let groupBytes = 0;
  for (const message of removed) {
    const size = bytesOf(message) + 1;
    if (group.length && groupBytes + size > STORAGE_SEGMENT_BYTES) {
      groups.push(group);
      group = [];
      groupBytes = 0;
    }
    group.push(message);
    groupBytes += size;
  }
  if (group.length) groups.push(group);
  const priorManifest = session.losslessArchive ?? { version: 1 as const, segmentCount: 0, messageCount: 0, attachmentCount: 0, actionCount: 0, complete: session.compactedMessageCount === 0, missingRanges: session.compactedMessageCount ? [{ from: 0, to: session.compactedMessageCount - 1, reason: "Legacy compaction did not preserve original records." }] : [] };
  let manifest = priorManifest;
  const segments: AssistantLosslessSegment[] = [...(session.losslessSegments ?? [])];
  for (const messages of groups) {
    const segment: AssistantLosslessSegment = { format: "narrarium-assistant-chat-segment", version: 1, id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...(manifest.head ? { previous: manifest.head } : {}), messages, attachments: [] };
    const head = { id: segment.id, sha256: await assistantSegmentSha256(segment) };
    segments.push(segment);
    manifest = { ...manifest, head, segmentCount: manifest.segmentCount + 1, messageCount: manifest.messageCount + messages.length, actionCount: manifest.actionCount + messages.filter((message) => Boolean(message.action)).length };
  }
  const previousArchive = session.archive ?? { summary: session.compactSummary, messageCount: session.compactedMessageCount, actions: [], attachments: [] };
  const records = await appendAssistantArchiveRecords(previousArchive, removed.flatMap((message) => (message.action ? [archiveAction(message.id, message.action)] : [])), []);
  const archive = { summary: previousArchive.summary, messageCount: previousArchive.messageCount + count, ...records };
  return {
    ...session,
    messages: session.messages.slice(count),
    losslessSegments: segments,
    losslessArchive: manifest,
    archive,
    compactSummary: archive.summary,
    compactedMessageCount: archive.messageCount,
  };
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
    losslessSegments: compactedSession.losslessSegments ?? currentSession.losslessSegments ?? [],
    // The manifest says which segments the archive has: it goes with them, or a chat saved to the cloud would not find its newest segment again.
    ...(compactedSession.losslessArchive ? { losslessArchive: compactedSession.losslessArchive } : {}),
    archive,
    compactSummary: compactedSession.compactSummary,
    compactedMessageCount: compactedSession.compactedMessageCount,
  };
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
