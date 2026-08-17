import type { AssistantAction, AssistantAttachment, AssistantLosslessArchiveManifest, AssistantLosslessSegment, AssistantLosslessSegmentRef, AssistantMessage, AssistantNoteSaveOperation, AssistantQuarantinedAction, AssistantSession, AssistantSessionArchive, AssistantSessionProvenance } from "./store.ts";
import { emptyAssistantArchiveRollup, emptyAssistantSessionArchive, normalizeAssistantSession } from "./store.ts";
import { hasAssistantActionProvenance } from "./actionValidation.ts";

export const ASSISTANT_SESSION_SCHEMA_VERSION = 1 as const;
export const MAX_ASSISTANT_SESSION_BYTES = 8 * 1024 * 1024;
export const MAX_ASSISTANT_LOSSLESS_SEGMENTS = 256;
export const MAX_ASSISTANT_LOSSLESS_SEGMENT_BYTES = 2 * 1024 * 1024;
export const MAX_ASSISTANT_LOSSLESS_ARCHIVE_BYTES = 24 * 1024 * 1024;
export const MAX_ASSISTANT_QUARANTINED_ACTIONS = 256;
export const MAX_ASSISTANT_QUARANTINED_ACTION_BYTES = 4 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BRANCH = /^(?![./])(?!.*(?:\.\.|\/\/|[~^:?*[\\\x00-\x20\x7f]))(?!.*(?:\.|\/|\.lock)$).{1,255}$/;

export class AssistantSessionValidationError extends Error {
  readonly code = "INVALID_ASSISTANT_SESSION";
  constructor(message: string) { super(message); this.name = "AssistantSessionValidationError"; }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AssistantSessionValidationError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max = 1024 * 1024): string {
  if (typeof value !== "string" || new TextEncoder().encode(value).length > max) throw new AssistantSessionValidationError(`${label} is invalid.`);
  return value;
}

function identifier(value: unknown, label: string): string {
  const result = text(value, label, 128);
  if (!ID.test(result)) throw new AssistantSessionValidationError(`${label} is invalid.`);
  return result;
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(result) || !Number.isFinite(Date.parse(result))) throw new AssistantSessionValidationError(`${label} is invalid.`);
  return result;
}

export function isSafeAssistantRepositoryPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 && !value.startsWith("/") && !value.includes("\\")
    && !/[\x00-\x1f\x7f]/.test(value) && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function repositoryPath(value: unknown, label: string): string {
  if (!isSafeAssistantRepositoryPath(value)) throw new AssistantSessionValidationError(`${label} is unsafe.`);
  return value;
}

function branch(value: unknown, label: string): string {
  const result = text(value, label, 255);
  if (!BRANCH.test(result)) throw new AssistantSessionValidationError(`${label} is unsafe.`);
  return result;
}

function provenance(value: unknown, label: string): AssistantSessionProvenance {
  const raw = object(value, label);
  return { bookId: identifier(raw.bookId, `${label}.bookId`), owner: identifier(raw.owner, `${label}.owner`), repo: identifier(raw.repo, `${label}.repo`), branch: branch(raw.branch, `${label}.branch`), ...(raw.noteTargetPath === undefined ? {} : { noteTargetPath: repositoryPath(raw.noteTargetPath, `${label}.noteTargetPath`) }) };
}

function update(value: unknown, label: string) {
  const raw = object(value, label);
  if (raw.status !== undefined && raw.status !== "pending" && raw.status !== "applied" && raw.status !== "failed") throw new AssistantSessionValidationError(`${label}.status is invalid.`);
  return { path: repositoryPath(raw.path, `${label}.path`), content: text(raw.content, `${label}.content`), ...(raw.reason === undefined ? {} : { reason: text(raw.reason, `${label}.reason`, 10_000) }), ...(raw.previousContent === undefined ? {} : { previousContent: raw.previousContent === null ? null : text(raw.previousContent, `${label}.previousContent`) }), ...(raw.status === undefined ? {} : { status: raw.status }), ...(raw.appliedHash === undefined ? {} : { appliedHash: text(raw.appliedHash, `${label}.appliedHash`, 256) }), ...(raw.error === undefined ? {} : { error: text(raw.error, `${label}.error`, 10_000) }) };
}

function action(value: unknown, label: string): AssistantAction {
  const raw = object(value, label);
  const kind = text(raw.kind, `${label}.kind`, 64);
  const common: Record<string, unknown> = {};
  if (raw.toolId !== undefined) common.toolId = identifier(raw.toolId, `${label}.toolId`);
  if (raw.owner !== undefined) common.owner = identifier(raw.owner, `${label}.owner`);
  if (raw.repo !== undefined) common.repo = identifier(raw.repo, `${label}.repo`);
  if (raw.branch !== undefined) common.branch = branch(raw.branch, `${label}.branch`);
  if (raw.sourceRevision !== undefined) common.sourceRevision = text(raw.sourceRevision, `${label}.sourceRevision`, 256);
  if (raw.generatedAt !== undefined) common.generatedAt = timestamp(raw.generatedAt, `${label}.generatedAt`);
  if (raw.sourceRevisions !== undefined) common.sourceRevisions = Object.fromEntries(Object.entries(object(raw.sourceRevisions, `${label}.sourceRevisions`)).map(([path, revision]) => [repositoryPath(path, `${label}.sourceRevisions path`), revision === null ? null : text(revision, `${label}.sourceRevisions revision`, 256)]));
  const bookId = () => identifier(raw.bookId, `${label}.bookId`);
  switch (kind) {
    case "apply-paragraph-rewrite": return { ...common, kind, bookId: bookId(), chapterSlug: identifier(raw.chapterSlug, `${label}.chapterSlug`), paragraphPath: repositoryPath(raw.paragraphPath, `${label}.paragraphPath`), proposedBody: text(raw.proposedBody, `${label}.proposedBody`) } as AssistantAction;
    case "apply-file-updates":
    case "undo-file-updates": {
      if (!Array.isArray(raw.updates) || raw.updates.length > 100) throw new AssistantSessionValidationError(`${label}.updates is invalid.`);
      return { ...common, kind, bookId: bookId(), updates: raw.updates.map((item, index) => update(item, `${label}.updates[${index}]`)) } as AssistantAction;
    }
    case "switch-book-branch": return { ...common, kind, bookId: bookId(), branchName: branch(raw.branchName, `${label}.branchName`), ...(typeof raw.createIfMissing === "boolean" ? { createIfMissing: raw.createIfMissing } : {}), ...(raw.baseBranch === undefined ? {} : { baseBranch: branch(raw.baseBranch, `${label}.baseBranch`) }) } as AssistantAction;
    case "confirm-create-pull-request": {
      if (!Array.isArray(raw.changedFiles) || raw.changedFiles.length > 1000 || !Array.isArray(raw.existingPullRequests) || raw.existingPullRequests.length > 100) throw new AssistantSessionValidationError(`${label} pull request summary is invalid.`);
      const changedFiles = raw.changedFiles.map((item, index) => { const file = object(item, `${label}.changedFiles[${index}]`); if (!Number.isSafeInteger(file.additions) || !Number.isSafeInteger(file.deletions)) throw new AssistantSessionValidationError(`${label}.changedFiles[${index}] is invalid.`); return { filename: repositoryPath(file.filename, `${label}.changedFiles[${index}].filename`), status: text(file.status, `${label}.changedFiles[${index}].status`, 32), additions: file.additions as number, deletions: file.deletions as number }; });
      const existingPullRequests = raw.existingPullRequests.map((item, index) => { const pull = object(item, `${label}.existingPullRequests[${index}]`); if (!Number.isSafeInteger(pull.number) || (pull.number as number) < 1) throw new AssistantSessionValidationError(`${label}.existingPullRequests[${index}] is invalid.`); return { number: pull.number as number, title: text(pull.title, `${label}.existingPullRequests[${index}].title`, 500), htmlUrl: text(pull.htmlUrl, `${label}.existingPullRequests[${index}].htmlUrl`, 2048), state: text(pull.state, `${label}.existingPullRequests[${index}].state`, 32) }; });
      return { ...common, kind, bookId: bookId(), base: branch(raw.base, `${label}.base`), head: branch(raw.head, `${label}.head`), title: text(raw.title, `${label}.title`, 500), body: text(raw.body, `${label}.body`), baseRevision: text(raw.baseRevision, `${label}.baseRevision`, 256), headRevision: text(raw.headRevision, `${label}.headRevision`, 256), changedFiles, existingPullRequests } as AssistantAction;
    }
    case "navigate": {
      const to = text(raw.to, `${label}.to`, 2048);
      if (!to.startsWith("/app/") || to.includes("\\") || /[\x00-\x1f]/.test(to)) throw new AssistantSessionValidationError(`${label}.to is unsafe.`);
      return { ...common, kind, to, ...(raw.label === undefined ? {} : { label: text(raw.label, `${label}.label`, 500) }) } as AssistantAction;
    }
    case "read-aloud": {
      if (!Array.isArray(raw.paths) || raw.paths.length > 100) throw new AssistantSessionValidationError(`${label}.paths is invalid.`);
      return { ...common, kind, bookId: bookId(), title: text(raw.title, `${label}.title`, 500), paths: raw.paths.map((item, index) => repositoryPath(item, `${label}.paths[${index}]`)), ...(typeof raw.includeFrontmatter === "boolean" ? { includeFrontmatter: raw.includeFrontmatter } : {}) } as AssistantAction;
    }
    case "confirm-delete": {
      if (raw.target !== "note" && raw.target !== "paragraph" && raw.target !== "entity" && raw.target !== "reader-evaluation") throw new AssistantSessionValidationError(`${label}.target is invalid.`);
      return { ...common, kind, bookId: bookId(), target: raw.target, path: repositoryPath(raw.path, `${label}.path`), title: text(raw.title, `${label}.title`, 500), ...(raw.chapterSlug === undefined ? {} : { chapterSlug: identifier(raw.chapterSlug, `${label}.chapterSlug`) }) } as AssistantAction;
    }
    case "confirm-create-from-research": {
      const entityKind = text(raw.entityKind, `${label}.entityKind`, 32);
      if (entityKind !== "character" && entityKind !== "item" && entityKind !== "location" && entityKind !== "faction" && entityKind !== "secret" && entityKind !== "timeline-event") throw new AssistantSessionValidationError(`${label}.entityKind is invalid.`);
      return { ...common, kind, bookId: bookId(), researchPath: repositoryPath(raw.researchPath, `${label}.researchPath`), entityKind, label: text(raw.label, `${label}.label`, 500), body: text(raw.body, `${label}.body`), extraFrontmatter: object(raw.extraFrontmatter, `${label}.extraFrontmatter`), destinationPath: repositoryPath(raw.destinationPath, `${label}.destinationPath`) } as AssistantAction;
    }
    case "confirm-cancel-feedback-rewrite": {
      if (raw.scope !== "chapter" && raw.scope !== "paragraph") throw new AssistantSessionValidationError(`${label}.scope is invalid.`);
      if (!Number.isSafeInteger(raw.workflowRequestId) || (raw.workflowRequestId as number) < 0) throw new AssistantSessionValidationError(`${label}.workflowRequestId is invalid.`);
      return { ...common, kind, bookId: bookId(), operationId: identifier(raw.operationId, `${label}.operationId`), scope: raw.scope, chapterSlug: identifier(raw.chapterSlug, `${label}.chapterSlug`), ...(raw.paragraphSlug === undefined ? {} : { paragraphSlug: identifier(raw.paragraphSlug, `${label}.paragraphSlug`) }), workflowRequestId: raw.workflowRequestId as number, ownerSessionId: identifier(raw.ownerSessionId, `${label}.ownerSessionId`), ownerRequestId: identifier(raw.ownerRequestId, `${label}.ownerRequestId`) } as AssistantAction;
    }
    default: throw new AssistantSessionValidationError(`${label}.kind is unknown.`);
  }
}

function message(value: unknown, index: number, quarantine: AssistantQuarantinedAction[]): AssistantMessage {
  const label = `messages[${index}]`;
  const raw = object(value, label);
  const messageId = identifier(raw.id, `${label}.id`);
  if (raw.role !== "user" && raw.role !== "assistant" && raw.role !== "system") throw new AssistantSessionValidationError(`${label}.role is invalid.`);
  let safeAction: AssistantAction | undefined;
  if (raw.action !== undefined) {
    try {
      safeAction = action(raw.action, `${label}.action`);
      if (!hasAssistantActionProvenance(safeAction)) throw new AssistantSessionValidationError(`${label}.action is missing required provenance.`);
    }
    catch (error) {
      safeAction = undefined;
      appendQuarantinedAction(quarantine, { messageId, reason: error instanceof Error ? error.message : "Invalid action", action: raw.action });
    }
  }
  let mutation: AssistantMessage["mutation"];
  if (raw.mutation !== undefined) {
    const source = object(raw.mutation, `${label}.mutation`);
    if (!Array.isArray(source.changedPaths) || source.changedPaths.length > 100 || source.refresh !== "book-structure-and-context") throw new AssistantSessionValidationError(`${label}.mutation is invalid.`);
    mutation = { changedPaths: source.changedPaths.map((item, pathIndex) => repositoryPath(item, `${label}.mutation.changedPaths[${pathIndex}]`)), refresh: source.refresh };
  }
  return { id: messageId, role: raw.role, text: text(raw.text, `${label}.text`), ...(safeAction ? { action: safeAction } : {}), ...(raw.branch === undefined ? {} : { branch: branch(raw.branch, `${label}.branch`) }), ...(mutation ? { mutation } : {}) };
}

function attachment(value: unknown, label: string): AssistantAttachment {
  const raw = object(value, label);
  if (raw.kind !== "text" && raw.kind !== "image") throw new AssistantSessionValidationError(`${label}.kind is invalid.`);
  if (!Number.isSafeInteger(raw.sizeBytes) || (raw.sizeBytes as number) < 0 || (raw.sizeBytes as number) > MAX_ASSISTANT_SESSION_BYTES) throw new AssistantSessionValidationError(`${label}.sizeBytes is invalid.`);
  for (const key of ["extractedBytes", "extractedPages", "estimatedTokens"] as const) {
    if (raw[key] !== undefined && (!Number.isSafeInteger(raw[key]) || (raw[key] as number) < 0)) throw new AssistantSessionValidationError(`${label}.${key} is invalid.`);
  }
  if (raw.truncated !== undefined && typeof raw.truncated !== "boolean") throw new AssistantSessionValidationError(`${label}.truncated is invalid.`);
  return { id: identifier(raw.id, `${label}.id`), name: text(raw.name, `${label}.name`, 255), mimeType: text(raw.mimeType, `${label}.mimeType`, 255), kind: raw.kind, sizeBytes: raw.sizeBytes as number, ...(raw.textContent === undefined ? {} : { textContent: text(raw.textContent, `${label}.textContent`) }), ...(raw.imageDataUrl === undefined ? {} : { imageDataUrl: text(raw.imageDataUrl, `${label}.imageDataUrl`, MAX_ASSISTANT_SESSION_BYTES) }), ...(raw.extractedBytes === undefined ? {} : { extractedBytes: raw.extractedBytes as number }), ...(raw.extractedPages === undefined ? {} : { extractedPages: raw.extractedPages as number }), ...(raw.estimatedTokens === undefined ? {} : { estimatedTokens: raw.estimatedTokens as number }), ...(raw.truncated === undefined ? {} : { truncated: raw.truncated as boolean }), ...(raw.truncationReason === undefined ? {} : { truncationReason: text(raw.truncationReason, `${label}.truncationReason`, 10_000) }) };
}

function losslessSegment(value: unknown, index: number, quarantine: AssistantQuarantinedAction[]): AssistantLosslessSegment {
  const label = `losslessSegments[${index}]`;
  const raw = object(value, label);
  if (!Array.isArray(raw.messages) || raw.messages.length > 10_000 || !Array.isArray(raw.attachments) || raw.attachments.length > 20) throw new AssistantSessionValidationError(`${label} is invalid.`);
  return {
    format: raw.format === undefined ? "narrarium-assistant-chat-segment" : raw.format === "narrarium-assistant-chat-segment" ? raw.format : (() => { throw new AssistantSessionValidationError(`${label}.format is invalid.`); })(),
    version: raw.version === undefined ? 1 : raw.version === 1 ? raw.version : (() => { throw new AssistantSessionValidationError(`${label}.version is invalid.`); })(),
    id: identifier(raw.id, `${label}.id`),
    createdAt: timestamp(raw.createdAt, `${label}.createdAt`),
    ...(raw.previous === undefined ? {} : { previous: segmentRef(raw.previous, `${label}.previous`) }),
    messages: raw.messages.map((item, messageIndex) => message(item, messageIndex, quarantine)),
    attachments: raw.attachments.map((item, attachmentIndex) => attachment(item, `${label}.attachments[${attachmentIndex}]`)),
  };
}

export function parseAssistantLosslessSegment(value: unknown): AssistantLosslessSegment {
  const quarantine: AssistantQuarantinedAction[] = [];
  const segment = losslessSegment(value, 0, quarantine);
  if (quarantine.length) throw new AssistantSessionValidationError("Lossless segment contains an invalid action.");
  return segment;
}

export function serializeAssistantLosslessSegment(segment: AssistantLosslessSegment): string {
  return JSON.stringify(parseAssistantLosslessSegment(segment));
}

function segmentRef(value: unknown, label: string): AssistantLosslessSegmentRef {
  const raw = object(value, label);
  const sha256 = text(raw.sha256, `${label}.sha256`, 64);
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new AssistantSessionValidationError(`${label}.sha256 is invalid.`);
  return { id: identifier(raw.id, `${label}.id`), sha256 };
}

function losslessManifest(value: unknown, legacyCount: number): AssistantLosslessArchiveManifest {
  if (value === undefined) return { version: 1, segmentCount: 0, messageCount: 0, attachmentCount: 0, actionCount: 0, complete: legacyCount === 0, missingRanges: legacyCount ? [{ from: 0, to: legacyCount - 1, reason: "Legacy compaction did not preserve original records." }] : [] };
  const raw = object(value, "losslessArchive");
  const actionCount = raw.actionCount ?? 0;
  if (raw.version !== 1 || !Number.isSafeInteger(raw.segmentCount) || (raw.segmentCount as number) < 0 || (raw.segmentCount as number) > MAX_ASSISTANT_LOSSLESS_SEGMENTS || !Number.isSafeInteger(raw.messageCount) || (raw.messageCount as number) < 0 || !Number.isSafeInteger(raw.attachmentCount) || (raw.attachmentCount as number) < 0 || !Number.isSafeInteger(actionCount) || (actionCount as number) < 0 || typeof raw.complete !== "boolean" || !Array.isArray(raw.missingRanges) || raw.missingRanges.length > 100) throw new AssistantSessionValidationError("losslessArchive is invalid.");
  const missingRanges = raw.missingRanges.map((item, index) => { const range = object(item, `losslessArchive.missingRanges[${index}]`); if (!Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to) || (range.from as number) < 0 || (range.to as number) < (range.from as number)) throw new AssistantSessionValidationError("losslessArchive missing range is invalid."); return { from: range.from as number, to: range.to as number, reason: text(range.reason, `losslessArchive.missingRanges[${index}].reason`, 1000) }; });
  let origin: AssistantLosslessArchiveManifest["origin"];
  if (raw.origin !== undefined) { const entry = object(raw.origin, "losslessArchive.origin"); if ((entry.provider !== "google" && entry.provider !== "microsoft") || typeof entry.account !== "string" || !entry.account.trim() || (entry.fileId !== undefined && typeof entry.fileId !== "string")) throw new AssistantSessionValidationError("losslessArchive.origin is invalid."); origin = { provider: entry.provider, account: entry.account, ...(typeof entry.fileId === "string" && entry.fileId ? { fileId: entry.fileId } : {}) }; }
  return { version: 1, ...(raw.head === undefined ? {} : { head: segmentRef(raw.head, "losslessArchive.head") }), segmentCount: raw.segmentCount as number, messageCount: raw.messageCount as number, attachmentCount: raw.attachmentCount as number, actionCount: actionCount as number, complete: raw.complete, missingRanges, ...(origin ? { origin } : {}) };
}

function archive(value: unknown): AssistantSessionArchive {
  if (value === undefined) return emptyAssistantSessionArchive();
  const raw = object(value, "archive");
  if (!Number.isSafeInteger(raw.messageCount) || (raw.messageCount as number) < 0 || !Array.isArray(raw.actions) || !Array.isArray(raw.attachments)) throw new AssistantSessionValidationError("archive is invalid.");
  const rollup = raw.rollup === undefined ? emptyAssistantArchiveRollup() : (() => {
    const entry = object(raw.rollup, "archive.rollup");
    if (entry.algorithm !== "SHA-256-chain-v1" || !Number.isSafeInteger(entry.actionCount) || (entry.actionCount as number) < 0 || !Number.isSafeInteger(entry.attachmentCount) || (entry.attachmentCount as number) < 0) throw new AssistantSessionValidationError("archive.rollup is invalid.");
    const actionDigest = text(entry.actionDigest, "archive.rollup.actionDigest", 64);
    const attachmentDigest = text(entry.attachmentDigest, "archive.rollup.attachmentDigest", 64);
    if (((entry.actionCount as number) > 0) !== /^[a-f0-9]{64}$/.test(actionDigest) || ((entry.attachmentCount as number) > 0) !== /^[a-f0-9]{64}$/.test(attachmentDigest)) throw new AssistantSessionValidationError("archive.rollup digest is invalid.");
    return { algorithm: "SHA-256-chain-v1" as const, actionCount: entry.actionCount as number, actionDigest, attachmentCount: entry.attachmentCount as number, attachmentDigest };
  })();
  return { summary: text(raw.summary, "archive.summary"), messageCount: raw.messageCount as number, actions: raw.actions.map((item, index) => {
    const entry = object(item, `archive.actions[${index}]`);
    if (!Array.isArray(entry.paths)) throw new AssistantSessionValidationError(`archive.actions[${index}].paths is invalid.`);
    return { messageId: identifier(entry.messageId, `archive.actions[${index}].messageId`), kind: text(entry.kind, `archive.actions[${index}].kind`, 64) as AssistantAction["kind"], ...(entry.bookId === undefined ? {} : { bookId: identifier(entry.bookId, `archive.actions[${index}].bookId`) }), ...(entry.toolId === undefined ? {} : { toolId: identifier(entry.toolId, `archive.actions[${index}].toolId`) }), ...(entry.owner === undefined ? {} : { owner: identifier(entry.owner, `archive.actions[${index}].owner`) }), ...(entry.repo === undefined ? {} : { repo: identifier(entry.repo, `archive.actions[${index}].repo`) }), ...(entry.branch === undefined ? {} : { branch: branch(entry.branch, `archive.actions[${index}].branch`) }), ...(entry.sourceRevision === undefined ? {} : { sourceRevision: text(entry.sourceRevision, `archive.actions[${index}].sourceRevision`, 256) }), ...(entry.sourceRevisions === undefined ? {} : { sourceRevisions: Object.fromEntries(Object.entries(object(entry.sourceRevisions, `archive.actions[${index}].sourceRevisions`)).map(([path, revision]) => [repositoryPath(path, `archive.actions[${index}].sourceRevisions path`), revision === null ? null : text(revision, `archive.actions[${index}].sourceRevisions revision`, 256)])) }), ...(entry.generatedAt === undefined ? {} : { generatedAt: timestamp(entry.generatedAt, `archive.actions[${index}].generatedAt`) }), paths: entry.paths.map((path, pathIndex) => repositoryPath(path, `archive.actions[${index}].paths[${pathIndex}]`)) };
  }), attachments: raw.attachments.map((item, index) => {
    const entry = object(item, `archive.attachments[${index}]`);
    if (entry.kind !== "text" && entry.kind !== "image" || !Number.isSafeInteger(entry.sizeBytes) || (entry.sizeBytes as number) < 0) throw new AssistantSessionValidationError(`archive.attachments[${index}] is invalid.`);
    return { id: identifier(entry.id, `archive.attachments[${index}].id`), name: text(entry.name, `archive.attachments[${index}].name`, 255), mimeType: text(entry.mimeType, `archive.attachments[${index}].mimeType`, 255), kind: entry.kind, sizeBytes: entry.sizeBytes as number };
  }), rollup };
}

function operation(value: unknown): AssistantNoteSaveOperation {
  const raw = object(value, "noteSaveOperation");
  const destination = provenance(raw.destination, "noteSaveOperation.destination");
  if (!destination.noteTargetPath || (raw.mode !== "full" && raw.mode !== "reply-summary") || (raw.status !== "pending" && raw.status !== "note-saved" && raw.status !== "complete" && raw.status !== "delete-failed") || typeof raw.deleteAfter !== "boolean") throw new AssistantSessionValidationError("noteSaveOperation is invalid.");
  return { id: identifier(raw.id, "noteSaveOperation.id"), mode: raw.mode, destination: destination as AssistantNoteSaveOperation["destination"], status: raw.status, deleteAfter: raw.deleteAfter, updatedAt: timestamp(raw.updatedAt, "noteSaveOperation.updatedAt") };
}

export function parseAssistantSession(value: unknown, byteLength?: number): AssistantSession {
  if (byteLength !== undefined && byteLength > MAX_ASSISTANT_SESSION_BYTES) throw new AssistantSessionValidationError("Chat session exceeds the size limit.");
  const raw = object(value, "session");
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== ASSISTANT_SESSION_SCHEMA_VERSION) throw new AssistantSessionValidationError(`Unsupported chat schema version: ${String(raw.schemaVersion)}.`);
  if (raw.schemaVersion === ASSISTANT_SESSION_SCHEMA_VERSION && (!Array.isArray(raw.messages) || !Array.isArray(raw.attachments) || !Array.isArray(raw.quarantinedActions))) throw new AssistantSessionValidationError("Versioned session arrays are required.");
  const messages = raw.messages ?? [];
  const attachments = raw.attachments ?? [];
  if (!Array.isArray(messages) || messages.length > 10_000 || !Array.isArray(attachments) || attachments.length > 20) throw new AssistantSessionValidationError("Session arrays are invalid or too large.");
  const quarantinedActions: AssistantQuarantinedAction[] = Array.isArray(raw.quarantinedActions) && raw.quarantinedActions.length <= MAX_ASSISTANT_QUARANTINED_ACTIONS ? raw.quarantinedActions.map((item, index) => {
    const entry = object(item, `quarantinedActions[${index}]`);
    return { messageId: identifier(entry.messageId, `quarantinedActions[${index}].messageId`), reason: text(entry.reason, `quarantinedActions[${index}].reason`, 10_000), action: boundedQuarantinedAction(entry.action) };
  }) : raw.quarantinedActions === undefined ? [] : (() => { throw new AssistantSessionValidationError("quarantinedActions is invalid."); })();
  const parsedArchive = archive(raw.archive);
  const legacyCount = raw.compactedMessageCount === undefined ? parsedArchive.messageCount : raw.compactedMessageCount;
  const contentRevision = raw.contentRevision ?? 0;
  if (!Number.isSafeInteger(contentRevision) || (contentRevision as number) < 0) throw new AssistantSessionValidationError("contentRevision is invalid.");
  if (!Number.isSafeInteger(legacyCount) || (legacyCount as number) < 0) throw new AssistantSessionValidationError("compactedMessageCount is invalid.");
  const parsedMessages = messages.map((item, index) => message(item, index, quarantinedActions));
  const parsedAttachments = attachments.map((item, index) => attachment(item, `attachments[${index}]`));
  const segments = raw.losslessSegments === undefined ? [] : Array.isArray(raw.losslessSegments) && raw.losslessSegments.length <= MAX_ASSISTANT_LOSSLESS_SEGMENTS
    ? parseLosslessSegments(raw.losslessSegments, quarantinedActions)
    : (() => { throw new AssistantSessionValidationError("losslessSegments is invalid."); })();
  const allMessageIds = [...segments.flatMap((segment) => segment.messages), ...parsedMessages].map((item) => item.id);
  const allAttachmentIds = [...segments.flatMap((segment) => segment.attachments), ...parsedAttachments].map((item) => item.id);
  if (new Set(allMessageIds).size !== allMessageIds.length || new Set(allAttachmentIds).size !== allAttachmentIds.length || new Set(segments.map((segment) => segment.id)).size !== segments.length) throw new AssistantSessionValidationError("Session IDs must be unique.");
  const manifest = losslessManifest(raw.losslessArchive, legacyCount as number);
  const sensitiveSecretPaths = raw.sensitiveSecretPaths === undefined ? [] : Array.isArray(raw.sensitiveSecretPaths) && raw.sensitiveSecretPaths.length <= 32
    ? raw.sensitiveSecretPaths.map((item, index) => repositoryPath(item, `sensitiveSecretPaths[${index}]`)).filter((path) => path.startsWith("secrets/"))
    : (() => { throw new AssistantSessionValidationError("sensitiveSecretPaths is invalid."); })();
  return normalizeAssistantSession({ schemaVersion: 1, id: identifier(raw.id, "session.id"), title: text(raw.title, "session.title", 500), contextTitle: text(raw.contextTitle, "session.contextTitle", 500), updatedAt: timestamp(raw.updatedAt, "session.updatedAt"), contentRevision: contentRevision as number, messages: parsedMessages, attachments: parsedAttachments, losslessSegments: segments, losslessArchive: manifest, ...(raw.archive === undefined ? {} : { archive: parsedArchive }), compactSummary: raw.compactSummary === undefined ? parsedArchive.summary : text(raw.compactSummary, "session.compactSummary"), compactedMessageCount: legacyCount as number, ...(raw.provenance === undefined ? {} : { provenance: provenance(raw.provenance, "provenance") }), ...(raw.noteSaveOperation === undefined ? {} : { noteSaveOperation: operation(raw.noteSaveOperation) }), quarantinedActions, sensitiveSecretPaths });
}

function parseLosslessSegments(values: unknown[], quarantine: AssistantQuarantinedAction[]): AssistantLosslessSegment[] {
  let aggregateBytes = 0;
  return values.map((item, index) => {
    let serialized: string;
    try { serialized = JSON.stringify(item); } catch { throw new AssistantSessionValidationError("losslessSegments contain unserializable data."); }
    const bytes = new TextEncoder().encode(serialized).length;
    if (bytes > MAX_ASSISTANT_LOSSLESS_SEGMENT_BYTES || aggregateBytes + bytes > MAX_ASSISTANT_LOSSLESS_ARCHIVE_BYTES) throw new AssistantSessionValidationError("losslessSegments exceed the archive size limit.");
    aggregateBytes += bytes;
    return losslessSegment(item, index, quarantine);
  });
}

function appendQuarantinedAction(quarantine: AssistantQuarantinedAction[], entry: AssistantQuarantinedAction): void {
  if (quarantine.length >= MAX_ASSISTANT_QUARANTINED_ACTIONS) return;
  quarantine.push({ ...entry, action: boundedQuarantinedAction(entry.action) });
}

function boundedQuarantinedAction(value: unknown): unknown {
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { return { omitted: true, reason: "unserializable action payload" }; }
  if (new TextEncoder().encode(serialized ?? "").length <= MAX_ASSISTANT_QUARANTINED_ACTION_BYTES) return value;
  const kind = value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>).kind === "string" ? (value as Record<string, unknown>).kind : "unknown";
  return { kind, omitted: true, reason: "action payload exceeded quarantine limit" };
}

export function parseAssistantSessionJson(json: string): AssistantSession {
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > MAX_ASSISTANT_SESSION_BYTES) throw new AssistantSessionValidationError("Chat session exceeds the size limit.");
  try { return parseAssistantSession(JSON.parse(json), bytes); } catch (error) { if (error instanceof AssistantSessionValidationError) throw error; throw new AssistantSessionValidationError("Chat session is not valid JSON."); }
}

export function serializeAssistantSession(session: AssistantSession): string {
  const parsed = parseAssistantSession(session);
  const { fileId: _fileId, revision: _revision, losslessSegments: _hydratedSegments, ...persisted } = parsed;
  const result = JSON.stringify(persisted, null, 2);
  if (new TextEncoder().encode(result).length > MAX_ASSISTANT_SESSION_BYTES) throw new AssistantSessionValidationError("Chat session exceeds the size limit.");
  return result;
}
