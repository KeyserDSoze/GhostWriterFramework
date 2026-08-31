import type { AssistantAction, AssistantArchivedAction, AssistantSession } from "./store.ts";
import { parseAssistantSession } from "./sessionSchema.ts";
import { assistantSegmentSha256 } from "./chatSegments.ts";
import { MAX_ASSISTANT_LOSSLESS_ARCHIVE_BYTES, MAX_ASSISTANT_SESSION_BYTES } from "./sessionSchema.ts";

export const ASSISTANT_CHAT_ARCHIVE_VERSION = 1 as const;
export type AssistantArchiveProvider = "local" | "github" | "google" | "microsoft";

export interface AssistantChatArchive {
  format: "narrarium-assistant-chat";
  version: 1;
  exportedAt: string;
  provider: { type: AssistantArchiveProvider; account: string };
  cloud: { fileId?: string; revision?: string };
  origin: { provider: AssistantArchiveProvider; account: string; fileId?: string };
  completeness: { complete: boolean; missingRanges: Array<{ from: number; to: number; reason: string }> };
  session: AssistantSession;
}

export function assistantArchiveMessages(archive: AssistantChatArchive): AssistantSession["messages"] {
  return [...(archive.session.losslessSegments ?? []).flatMap((segment) => segment.messages), ...archive.session.messages];
}

export function assistantArchiveAttachments(archive: AssistantChatArchive): AssistantSession["attachments"] {
  return [...(archive.session.losslessSegments ?? []).flatMap((segment) => segment.attachments), ...archive.session.attachments];
}

/** Produces a new cloud identity while preserving every archived record for account migration. */
export async function migrateAssistantChatArchive(archive: AssistantChatArchive, existingIds: Iterable<string>): Promise<AssistantSession> {
  const ids = new Set(existingIds);
  const source = archive.session;
  const id = ids.has(source.id) ? crypto.randomUUID() : source.id;
  const { fileId: _fileId, revision: _revision, ...session } = source;
  const imported = parseAssistantSession({ ...session, id, losslessArchive: { ...source.losslessArchive, origin: archive.origin }, updatedAt: new Date().toISOString(), contentRevision: (source.contentRevision ?? 0) + 1 });
  return quarantineImportedActions(imported);
}

async function quarantineImportedActions(session: AssistantSession): Promise<AssistantSession> {
  const archived = [...(session.archive?.actions ?? [])];
  const quarantined = [...(session.quarantinedActions ?? [])];
  const strip = (messages: AssistantSession["messages"]): AssistantSession["messages"] => messages.map((message) => {
    if (!message.action) return message;
    archived.push(importedActionRecord(message.id, message.action));
    quarantined.push({ messageId: message.id, reason: "External archive actions are inert because the archive is not cryptographically authenticated.", action: { kind: message.action.kind, omitted: true } });
    const detail = `\n\n> Imported inert action: ${message.action.kind}. It was preserved in audit history but cannot be executed.`;
    return { ...message, text: `${message.text}${detail}`, action: undefined };
  });
  const losslessSegments = [];
  let previous: { id: string; sha256: string } | undefined;
  for (const source of session.losslessSegments ?? []) {
    const segment = { ...source, ...(previous ? { previous } : { previous: undefined }), messages: strip(source.messages) };
    losslessSegments.push(segment);
    previous = { id: segment.id, sha256: await assistantSegmentSha256(segment) };
  }
  return {
    ...session,
    messages: strip(session.messages),
    losslessSegments,
    losslessArchive: { ...session.losslessArchive!, ...(previous ? { head: previous } : { head: undefined }), actionCount: 0 },
    archive: { ...(session.archive ?? { summary: "", messageCount: 0, attachments: [] }), actions: archived },
    quarantinedActions: quarantined,
  };
}

export async function readAssistantChatArchiveFile(file: Pick<File, "size" | "text">): Promise<AssistantChatArchive> {
  if (file.size > MAX_ASSISTANT_SESSION_BYTES + MAX_ASSISTANT_LOSSLESS_ARCHIVE_BYTES) throw new Error("Chat archive exceeds the import size limit.");
  return parseAssistantChatArchive(JSON.parse(await file.text()));
}

function importedActionRecord(messageId: string, action: AssistantAction): AssistantArchivedAction {
  const paths = "updates" in action ? action.updates.map((update) => update.path)
    : "path" in action ? [action.path]
    : "paragraphPath" in action ? [action.paragraphPath]
    : "researchPath" in action ? [action.researchPath, action.destinationPath]
    : "paths" in action ? action.paths : [];
  return { messageId, kind: action.kind, ...(action.toolId ? { toolId: action.toolId } : {}), ...(action.owner ? { owner: action.owner } : {}), ...(action.repo ? { repo: action.repo } : {}), ...(action.branch ? { branch: action.branch } : {}), ...(action.sourceRevision ? { sourceRevision: action.sourceRevision } : {}), ...(action.sourceRevisions ? { sourceRevisions: action.sourceRevisions } : {}), ...(action.generatedAt ? { generatedAt: action.generatedAt } : {}), ...("bookId" in action ? { bookId: action.bookId } : {}), paths };
}

export function createAssistantChatArchive(session: AssistantSession, provider: AssistantArchiveProvider, account: string): AssistantChatArchive {
  const persisted = parseAssistantSession(session);
  const { fileId, revision } = session;
  const manifest = persisted.losslessArchive!;
  const origin = manifest.origin ?? { provider, account, ...(fileId ? { fileId } : {}) };
  persisted.losslessArchive = { ...manifest, origin };
  return {
    format: "narrarium-assistant-chat",
    version: ASSISTANT_CHAT_ARCHIVE_VERSION,
    exportedAt: new Date().toISOString(),
    provider: { type: provider, account },
    cloud: { ...(fileId ? { fileId } : {}), ...(revision ? { revision } : {}) },
    origin,
    completeness: { complete: manifest.complete, missingRanges: manifest.missingRanges },
    session: persisted,
  };
}

export async function parseAssistantChatArchive(value: unknown): Promise<AssistantChatArchive> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Chat archive must be an object.");
  const raw = value as Record<string, unknown>;
  if (raw.format !== "narrarium-assistant-chat" || raw.version !== ASSISTANT_CHAT_ARCHIVE_VERSION) throw new Error(`Unsupported chat archive version: ${String(raw.version)}.`);
  if (typeof raw.exportedAt !== "string" || !Number.isFinite(Date.parse(raw.exportedAt))) throw new Error("Chat archive export time is invalid.");
  if (!raw.provider || typeof raw.provider !== "object" || Array.isArray(raw.provider)) throw new Error("Chat archive provider is invalid.");
  const provider = raw.provider as Record<string, unknown>;
  if (!(["local", "github", "google", "microsoft"] as unknown[]).includes(provider.type) || typeof provider.account !== "string" || !provider.account.trim()) throw new Error("Chat archive provider is invalid.");
  if (!raw.cloud || typeof raw.cloud !== "object" || Array.isArray(raw.cloud)) throw new Error("Chat archive cloud identity is invalid.");
  const cloud = raw.cloud as Record<string, unknown>;
  if (cloud.fileId !== undefined && typeof cloud.fileId !== "string" || cloud.revision !== undefined && typeof cloud.revision !== "string") throw new Error("Chat archive cloud identity is invalid.");
  const session = parseAssistantSession(raw.session);
  const rawOrigin = raw.origin === undefined ? { provider: provider.type, account: provider.account, ...(cloud.fileId ? { fileId: cloud.fileId } : {}) } : raw.origin;
  if (!rawOrigin || typeof rawOrigin !== "object" || Array.isArray(rawOrigin)) throw new Error("Chat archive origin is invalid.");
  const originValue = rawOrigin as Record<string, unknown>;
  if (!(["local", "github", "google", "microsoft"] as unknown[]).includes(originValue.provider) || typeof originValue.account !== "string" || !originValue.account.trim() || (originValue.fileId !== undefined && typeof originValue.fileId !== "string")) throw new Error("Chat archive origin is invalid.");
  const origin: AssistantChatArchive["origin"] = { provider: originValue.provider as AssistantArchiveProvider, account: originValue.account, ...(originValue.fileId ? { fileId: originValue.fileId as string } : {}) };
  const manifest = session.losslessArchive!;
  const manifestCompleteness = validateCompleteness({ complete: manifest.complete, missingRanges: manifest.missingRanges }, "Chat archive manifest completeness");
  const segments = session.losslessSegments ?? [];
  let previous: { id: string; sha256: string } | undefined;
  let messageCount = 0;
  let attachmentCount = 0;
  let actionCount = 0;
  for (const segment of segments) {
    if (JSON.stringify(segment.previous) !== JSON.stringify(previous)) throw new Error("Chat archive segment sequence is invalid.");
    previous = { id: segment.id, sha256: await assistantSegmentSha256(segment) };
    messageCount += segment.messages.length;
    attachmentCount += segment.attachments.length;
    actionCount += segment.messages.filter((message) => Boolean(message.action)).length;
  }
  if (segments.length !== manifest.segmentCount || JSON.stringify(previous) !== JSON.stringify(manifest.head)) throw new Error("Chat archive segment chain is incomplete or invalid.");
  if (messageCount !== manifest.messageCount || attachmentCount !== manifest.attachmentCount || actionCount !== manifest.actionCount) throw new Error("Chat archive segment totals do not match the manifest.");
  const completeness = manifestCompleteness;
  if (raw.completeness !== undefined) {
    const declared = validateCompleteness(raw.completeness, "Chat archive completeness");
    if (declared.complete !== completeness.complete || JSON.stringify(declared.missingRanges) !== JSON.stringify(completeness.missingRanges)) throw new Error("Chat archive completeness does not match its manifest.");
  }
  return {
    format: raw.format,
    version: raw.version,
    exportedAt: raw.exportedAt,
    provider: { type: provider.type as AssistantArchiveProvider, account: provider.account },
    cloud: { ...(cloud.fileId ? { fileId: cloud.fileId as string } : {}), ...(cloud.revision ? { revision: cloud.revision as string } : {}) },
    origin,
    completeness,
    session: { ...session, losslessArchive: { ...session.losslessArchive!, origin } },
  };
}

function validateCompleteness(value: unknown, label: string): AssistantChatArchive["completeness"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  const raw = value as Record<string, unknown>;
  if (typeof raw.complete !== "boolean" || !Array.isArray(raw.missingRanges)) throw new Error(`${label} is invalid.`);
  const rawMissingRanges = raw.missingRanges as unknown[];
  const missingRanges = rawMissingRanges.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${label} is invalid.`);
    const range = item as Record<string, unknown>;
    if (!Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to) || (range.from as number) < 0 || (range.to as number) < (range.from as number) || typeof range.reason !== "string" || !range.reason.trim()) throw new Error(`${label} is invalid.`);
    const previous = rawMissingRanges[index - 1] as Record<string, unknown> | undefined;
    if (previous && Number.isSafeInteger(previous.to) && (range.from as number) <= (previous.to as number)) throw new Error(`${label} ranges must be ordered and non-overlapping.`);
    return { from: range.from as number, to: range.to as number, reason: range.reason };
  });
  if (raw.complete !== (missingRanges.length === 0)) throw new Error(`${label} is contradictory.`);
  return { complete: raw.complete, missingRanges };
}

export async function serializeAssistantChatArchive(archive: AssistantChatArchive): Promise<string> {
  return JSON.stringify(await parseAssistantChatArchive(archive), null, 2);
}
