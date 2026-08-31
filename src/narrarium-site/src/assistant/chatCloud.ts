import type { AuthProvider } from "../store/authStore.ts";
import { normalizeAssistantSession, type AssistantSession, type AssistantSessionMeta } from "./store.ts";
import type { AssistantSessionCloudHandle } from "./sessionAutosave.ts";
import { ensureGoogleAppFolder } from "../drive/googleAppFolder.ts";
import { acquireCloudWriteLease, fencedCloudMutation } from "../drive/cloudWriteBarrier.ts";
import { MAX_ASSISTANT_LOSSLESS_ARCHIVE_BYTES, MAX_ASSISTANT_LOSSLESS_SEGMENT_BYTES, MAX_ASSISTANT_SESSION_BYTES, parseAssistantSessionJson, serializeAssistantSession } from "./sessionSchema.ts";
import { serializeAssistantLosslessSegment } from "./sessionSchema.ts";
import { assistantSegmentSha256, verifyAssistantSegment } from "./chatSegments.ts";
import type { AssistantLosslessSegment, AssistantLosslessSegmentRef } from "./store.ts";
import { fetchMicrosoftGraph } from "../drive/microsoftGraph.ts";

const GOOGLE_DRIVE_API = "https://www.googleapis.com/drive/v3";
const GOOGLE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const GRAPH_DRIVE_API = "https://graph.microsoft.com/v1.0/me/drive";
const ONE_DRIVE_APP_FOLDER = "Apps/Narrarium";
const CHATS_FOLDER = "chats";
const SEGMENTS_FOLDER = "chat-segments";
const MIME_JSON = "application/json";
const CHAT_MARKER = "v1";
const SEGMENT_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
const CHAT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/;
export const MAX_PERSISTED_CHAT_BYTES = 7 * 1024 * 1024;

interface ListOptions {
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}

interface NativeChatMeta {
  id: string;
  name: string;
  modifiedTime?: string;
  revision?: string;
  sessionId?: string;
  title?: string;
  contextTitle?: string;
  embeddedUpdatedAt?: string;
  contentRevision?: number;
}

interface GoogleSegmentFile {
  id: string;
  name: string;
  createdTime?: string;
  modifiedTime?: string;
  appProperties?: Record<string, string>;
}

export class AssistantSessionConflictError extends Error {
  readonly code = "ASSISTANT_SESSION_CONFLICT";
  readonly recoverable = true;
  readonly sessionId: string;
  readonly fileId: string;

  constructor(sessionId: string, fileId: string) {
    super(`Chat ${sessionId} changed in another tab or device. Reload it before saving again.`);
    this.name = "AssistantSessionConflictError";
    this.sessionId = sessionId;
    this.fileId = fileId;
  }
}

export class AssistantSessionPayloadTooLargeError extends Error {
  readonly code = "ASSISTANT_SESSION_TOO_LARGE";
  readonly permanent = true;
  readonly payloadBytes: number;
  constructor(payloadBytes: number) {
    super(`Chat payload is ${payloadBytes} bytes; the cloud limit is ${MAX_PERSISTED_CHAT_BYTES}.`);
    this.name = "AssistantSessionPayloadTooLargeError";
    this.payloadBytes = payloadBytes;
  }
}

export class AssistantCloudRequestError extends Error {
  readonly code = "ASSISTANT_CLOUD_REQUEST_FAILED";
  readonly status: number;
  constructor(context: string, status: number) {
    super(`${context}: ${status}`);
    this.name = "AssistantCloudRequestError";
    this.status = status;
  }
}

export class AssistantSessionPermanentSaveError extends Error {
  readonly code = "INVALID_ASSISTANT_SESSION";
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = "AssistantSessionPermanentSaveError";
  }
}

export async function listAssistantSessions(provider: AuthProvider, accessToken: string, options: ListOptions = {}): Promise<AssistantSessionMeta[]> {
  return provider === "microsoft" ? listMicrosoftSessions(accessToken, options) : listGoogleSessions(accessToken, options);
}

export async function listAssistantSessionsStrict(provider: AuthProvider, accessToken: string, options: ListOptions = {}): Promise<AssistantSessionMeta[]> {
  return listAssistantSessions(provider, accessToken, options);
}

export async function loadAssistantSession(provider: AuthProvider, accessToken: string, fileId: string, signal?: AbortSignal): Promise<AssistantSession> {
  return provider === "microsoft" ? loadMicrosoftSession(accessToken, fileId, signal) : loadGoogleSession(accessToken, fileId, signal);
}

export async function hydrateAssistantSessionArchive(provider: AuthProvider, accessToken: string, session: AssistantSession, signal?: AbortSignal): Promise<AssistantSession> {
  return hydrateAssistantSegments(provider, accessToken, session, signal);
}

export async function saveAssistantSession(provider: AuthProvider, accessToken: string, session: AssistantSession, signal?: AbortSignal): Promise<AssistantSessionCloudHandle> {
  if (!CHAT_NAME.test(chatFileName(session))) throw new AssistantSessionPermanentSaveError(`Invalid chat session identity: ${session.id}`);
  const normalized = normalizeAssistantSession(session);
  const payloadBytes = new TextEncoder().encode(serializeAssistantSession(normalized)).length;
  if (payloadBytes > MAX_PERSISTED_CHAT_BYTES) throw new AssistantSessionPayloadTooLargeError(payloadBytes);
  const endWrite = await acquireCloudWriteLease(provider, accessToken, signal);
  const createdSegments: Array<{ ref: AssistantLosslessSegmentRef; providerId?: string }> = [];
  let publicationStarted = false;
  try {
    assertNotAborted(signal);
    createdSegments.push(...await persistAssistantSegments(provider, accessToken, normalized, signal));
    assertNotAborted(signal);
    publicationStarted = true;
    const handle = await (provider === "microsoft" ? saveMicrosoftSession(accessToken, normalized, signal) : saveGoogleSession(accessToken, normalized, signal));
    await reclaimUnreachableSessionSegments(provider, accessToken, normalized, signal).catch(() => undefined);
    return handle;
  } catch (error) {
    if (!publicationStarted || isKnownPrimaryPublicationFailure(error)) await cleanupCreatedSegments(provider, accessToken, normalized.id, createdSegments).catch(() => undefined);
    throw error;
  } finally {
    await endWrite();
  }
}

function isKnownPrimaryPublicationFailure(error: unknown): boolean {
  if (error instanceof AssistantSessionConflictError || error instanceof AssistantSessionPermanentSaveError || error instanceof AssistantSessionPayloadTooLargeError) return true;
  return error instanceof AssistantCloudRequestError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("The chat operation was cancelled.", "AbortError");
}

export async function deleteAssistantSession(provider: AuthProvider, accessToken: string, fileId: string, signal?: AbortSignal, knownSessionId?: string): Promise<void> {
  const release = await acquireCloudWriteLease(provider, accessToken, signal);
  try {
    let session: AssistantSession | undefined;
    try { session = await loadAssistantSession(provider, accessToken, fileId, signal); } catch { /* The primary delete remains idempotent if metadata cannot be loaded. */ }
    await (provider === "microsoft" ? deleteMicrosoftSession(accessToken, fileId, signal) : deleteGoogleSession(accessToken, fileId, signal));
    const sessionId = session?.id ?? knownSessionId;
    if (sessionId) {
      // The primary identity is already gone, so cleanup failure must not resume autosave and recreate it.
      try { await deleteAssistantSegments(provider, accessToken, sessionId, signal); } catch { /* Orphans remain account-scoped and are reclaimed by a later delete/maintenance pass. */ }
    }
  } finally {
    await release();
  }
}

function authHeaders(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` };
}

function assertOk(response: Response, context: string): void {
  if (!response.ok) throw new AssistantCloudRequestError(context, response.status);
}

function assertCurrent(options: ListOptions): void {
  if (options.signal?.aborted || options.isCurrent?.() === false) throw new DOMException("The cloud history request was cancelled.", "AbortError");
}

async function parseSessionResponse(response: Response): Promise<AssistantSession> {
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ASSISTANT_SESSION_BYTES) throw new Error("Chat session exceeds the size limit.");
  return parseAssistantSessionJson(await readResponseTextBounded(response, MAX_ASSISTANT_SESSION_BYTES));
}

export async function readResponseTextBounded(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).length > maxBytes) throw new Error("Chat session exceeds the size limit.");
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error("Chat session exceeds the size limit.");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function chatFileName(session: Pick<AssistantSession, "id">): string {
  return `${session.id}.json`;
}

function segmentFileName(sessionId: string, ref: AssistantLosslessSegmentRef): string {
  return `${sessionId}.${ref.id}.${ref.sha256}.json`;
}

function segmentIdentity(sessionId: string, ref: AssistantLosslessSegmentRef): string {
  return `${sessionId}\0${ref.id}\0${ref.sha256}`;
}

function googleSegmentIdentity(file: GoogleSegmentFile): string | undefined {
  const properties = file.appProperties;
  if (properties?.narrariumChatSegment !== "v1" || !properties.narrariumChatSegmentSession || !properties.narrariumChatSegmentId || !/^[a-f0-9]{64}$/.test(properties.narrariumChatSegmentHash ?? "")) return undefined;
  return segmentIdentity(properties.narrariumChatSegmentSession, { id: properties.narrariumChatSegmentId, sha256: properties.narrariumChatSegmentHash });
}

async function persistAssistantSegments(provider: AuthProvider, accessToken: string, session: AssistantSession, signal?: AbortSignal): Promise<Array<{ ref: AssistantLosslessSegmentRef; providerId?: string }>> {
  if (!session.losslessSegments?.length) return [];
  const created: Array<{ ref: AssistantLosslessSegmentRef; providerId?: string }> = [];
  for (const segment of session.losslessSegments) {
    assertNotAborted(signal);
    const ref = segment.id === session.losslessArchive?.head?.id
      ? session.losslessArchive.head
      : { id: segment.id, sha256: await assistantSegmentSha256(segment) };
    const providerId = provider === "microsoft" ? await persistMicrosoftSegment(accessToken, session.id, ref, segment, signal) : await persistGoogleSegment(accessToken, session.id, ref, segment, signal);
    if (providerId !== undefined) created.push({ ref, providerId });
  }
  return created;
}

async function cleanupCreatedSegments(provider: AuthProvider, accessToken: string, sessionId: string, created: Array<{ ref: AssistantLosslessSegmentRef; providerId?: string }>): Promise<void> {
  for (const item of created) {
    if (provider === "google" && item.providerId) await deleteGoogleSession(accessToken, item.providerId);
    if (provider === "microsoft") {
      const response = await fencedCloudMutation("microsoft", accessToken, `${GRAPH_DRIVE_API}/root:/${microsoftSegmentsPath(sessionId)}/${segmentFileName(sessionId, item.ref)}`, { method: "DELETE", headers: authHeaders(accessToken) });
      if (!(response.ok || response.status === 404)) throw new AssistantCloudRequestError("OneDrive chat segment compensation", response.status);
    }
  }
}

async function hydrateAssistantSegments(provider: AuthProvider, accessToken: string, session: AssistantSession, signal?: AbortSignal): Promise<AssistantSession> {
  const manifest = session.losslessArchive;
  if (!manifest?.head) return session;
  const newest: AssistantLosslessSegment[] = [];
  let ref: AssistantLosslessSegmentRef | undefined = manifest.head;
  const seen = new Set<string>();
  let messageCount = 0;
  let attachmentCount = 0;
  let actionCount = 0;
  let aggregateBytes = 0;
  while (ref) {
    if (seen.has(ref.id) || newest.length >= manifest.segmentCount) throw new Error("Chat archive segment chain is invalid.");
    seen.add(ref.id);
    const raw = provider === "microsoft" ? await loadMicrosoftSegment(accessToken, session.id, ref, signal) : await loadGoogleSegment(accessToken, session.id, ref, signal);
    aggregateBytes += new TextEncoder().encode(JSON.stringify(raw)).length;
    if (aggregateBytes > MAX_ASSISTANT_LOSSLESS_ARCHIVE_BYTES) throw new Error("Chat archive segments exceed the aggregate size limit.");
    const segment = await verifyAssistantSegment(raw, ref);
    newest.push(segment);
    messageCount += segment.messages.length;
    attachmentCount += segment.attachments.length;
    actionCount += segment.messages.filter((message) => Boolean(message.action)).length;
    ref = segment.previous;
  }
  if (newest.length !== manifest.segmentCount) throw new Error("Chat archive segment chain is incomplete.");
  if (messageCount !== manifest.messageCount || attachmentCount !== manifest.attachmentCount || actionCount !== manifest.actionCount) throw new Error("Chat archive segment totals do not match the manifest.");
  return { ...session, losslessSegments: newest.reverse() };
}

function sessionIdFromName(name: string): string | undefined {
  return CHAT_NAME.test(name) ? name.slice(0, -5) : undefined;
}

export function resolveAssistantSessionUpdatedAt(embeddedUpdatedAt?: string, providerModifiedTime?: string): string {
  return embeddedUpdatedAt ?? providerModifiedTime ?? new Date(0).toISOString();
}

function normalizeSessionMeta(raw: NativeChatMeta): AssistantSessionMeta {
  const sessionId = raw.sessionId ?? sessionIdFromName(raw.name) ?? raw.id;
  return {
    id: sessionId,
    fileId: raw.id,
    revision: raw.revision,
    title: raw.title || sessionId,
    contextTitle: raw.contextTitle || "Narrarium",
    // Embedded time tracks meaningful chat mutations; provider time is only a legacy fallback.
    updatedAt: resolveAssistantSessionUpdatedAt(raw.embeddedUpdatedAt, raw.modifiedTime),
    contentRevision: raw.contentRevision ?? 0,
  };
}

function sameSession(left: AssistantSession, right: AssistantSession): boolean {
  return serializeAssistantSession(left) === serializeAssistantSession(right);
}

function responseRevision(response: Response, body?: { eTag?: string; etag?: string }): string | undefined {
  return response.headers.get("ETag") ?? body?.eTag ?? body?.etag;
}

function googleProperties(session: AssistantSession): Record<string, string> {
  return { narrariumChat: CHAT_MARKER, sessionId: session.id, title: truncateUtf8(session.title, 100), contextTitle: truncateUtf8(session.contextTitle, 100), updatedAt: session.updatedAt, contentRevision: String(session.contentRevision ?? 0) };
}

function microsoftDescription(session: AssistantSession): string {
  return JSON.stringify({ narrariumChat: CHAT_MARKER, sessionId: session.id, title: session.title.slice(0, 500), contextTitle: session.contextTitle.slice(0, 500), updatedAt: session.updatedAt, contentRevision: session.contentRevision ?? 0 });
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const size = new TextEncoder().encode(character).length;
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

function parseMicrosoftDescription(description?: string): Omit<NativeChatMeta, "id" | "name"> | null {
  if (!description) return null;
  try {
    const value = JSON.parse(description) as Record<string, unknown>;
    if (
      value.narrariumChat !== CHAT_MARKER
      || typeof value.sessionId !== "string"
      || typeof value.title !== "string"
      || typeof value.contextTitle !== "string"
    ) return null;
    return {
      sessionId: value.sessionId,
      title: value.title,
      contextTitle: value.contextTitle,
      ...(typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt)) ? { embeddedUpdatedAt: value.updatedAt } : {}),
      ...(Number.isSafeInteger(value.contentRevision) && (value.contentRevision as number) >= 0 ? { contentRevision: value.contentRevision as number } : {}),
    };
  } catch {
    return null;
  }
}

function microsoftMetadataMatches(description: string | undefined, session: AssistantSession): boolean {
  const metadata = parseMicrosoftDescription(description);
  const expected = JSON.parse(microsoftDescription(session)) as { sessionId: string; title: string; contextTitle: string; updatedAt: string; contentRevision: number };
  return Boolean(
    metadata
    && metadata.sessionId === expected.sessionId
    && metadata.title === expected.title
    && metadata.contextTitle === expected.contextTitle
    && metadata.embeddedUpdatedAt === expected.updatedAt
    && metadata.contentRevision === expected.contentRevision
  );
}

async function ensureGoogleFolder(accessToken: string, name: string, parentId?: string): Promise<string> {
  const query = parentId
    ? `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
    : `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const params = new URLSearchParams({ q: query, spaces: "drive", fields: "files(id,name)" });
  const found = await fetch(`${GOOGLE_DRIVE_API}/files?${params}`, { headers: authHeaders(accessToken) });
  assertOk(found, "Google folder lookup");
  const foundData = await found.json() as { files?: Array<{ id: string }> };
  if (foundData.files?.[0]?.id) return foundData.files[0].id;
  const created = await fencedCloudMutation("google", accessToken, `${GOOGLE_DRIVE_API}/files?fields=id`, {
    method: "POST",
    headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", ...(parentId ? { parents: [parentId] } : {}) }),
  });
  assertOk(created, "Google folder create");
  return (await created.json() as { id: string }).id;
}

async function googleSegmentsFolder(accessToken: string): Promise<string> {
  return ensureGoogleFolder(accessToken, SEGMENTS_FOLDER, await ensureGoogleAppFolder(accessToken));
}

async function findGoogleSegmentFiles(accessToken: string, sessionId: string, ref?: AssistantLosslessSegmentRef, signal?: AbortSignal): Promise<GoogleSegmentFile[]> {
  const folder = await googleSegmentsFolder(accessToken);
  const files: GoogleSegmentFile[] = [];
  let pageToken: string | undefined;
  do {
    const query = [`'${folder}' in parents`, "trashed=false", `appProperties has { key='narrariumChatSegmentSession' and value='${sessionId}' }`];
    if (ref) query.push(`appProperties has { key='narrariumChatSegmentId' and value='${ref.id}' }`);
    const params = new URLSearchParams({ q: query.join(" and "), spaces: "drive", fields: "nextPageToken,files(id,name,createdTime,modifiedTime,appProperties)", pageSize: "1000", ...(pageToken ? { pageToken } : {}) });
    const response = await fetch(`${GOOGLE_DRIVE_API}/files?${params}`, { headers: authHeaders(accessToken), signal });
    assertOk(response, "Google chat segment lookup");
    const page = await response.json() as { nextPageToken?: string; files?: GoogleSegmentFile[] };
    files.push(...(page.files ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return files;
}

async function persistGoogleSegment(accessToken: string, sessionId: string, ref: AssistantLosslessSegmentRef, segment: AssistantLosslessSegment, signal?: AbortSignal): Promise<string | undefined> {
  const existing = await findGoogleSegmentFiles(accessToken, sessionId, ref, signal);
  if (existing.length) {
    await verifyGoogleSegmentCandidates(accessToken, sessionId, existing, ref, signal);
    await removeGoogleSegmentDuplicates(accessToken, existing, existing.map((file) => file.id).sort()[0], signal);
    return undefined;
  }
  const folder = await googleSegmentsFolder(accessToken);
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({ name: segmentFileName(sessionId, ref), parents: [folder], mimeType: MIME_JSON, appProperties: { narrariumChatSegment: "v1", narrariumChatSegmentSession: sessionId, narrariumChatSegmentId: ref.id, narrariumChatSegmentHash: ref.sha256 } })], { type: MIME_JSON }));
  form.append("file", new Blob([serializeAssistantLosslessSegment(segment)], { type: MIME_JSON }));
  const response = await fencedCloudMutation("google", accessToken, `${GOOGLE_UPLOAD_API}/files?uploadType=multipart&fields=id`, { method: "POST", headers: authHeaders(accessToken), body: form, signal });
  assertOk(response, "Google chat segment create");
  const createdId = (await response.json() as { id: string }).id;
  try {
    const observed = new Map<string, GoogleSegmentFile>();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, attempt * 50));
      for (const file of await findGoogleSegmentFiles(accessToken, sessionId, ref, signal)) observed.set(file.id, file);
    }
    const candidates = [...observed.values()];
    if (!candidates.some((file) => file.id === createdId)) throw new Error(`Google chat segment ${ref.id} could not be reconciled.`);
    await verifyGoogleSegmentCandidates(accessToken, sessionId, candidates, ref, signal);
    const canonicalId = candidates.map((file) => file.id).sort()[0];
    await removeGoogleSegmentDuplicates(accessToken, candidates, canonicalId, signal);
    return canonicalId === createdId ? createdId : undefined;
  } catch (error) {
    await deleteGoogleSession(accessToken, createdId).catch(() => undefined);
    throw error;
  }
}

async function verifyGoogleSegmentCandidates(accessToken: string, sessionId: string, files: GoogleSegmentFile[], ref: AssistantLosslessSegmentRef, signal?: AbortSignal): Promise<AssistantLosslessSegment[]> {
  const values: AssistantLosslessSegment[] = [];
  for (const file of files) {
    if (googleSegmentIdentity(file) !== segmentIdentity(sessionId, ref)) throw new Error(`Chat archive segment ${ref.id} has divergent provider metadata.`);
    const response = await fetch(`${GOOGLE_DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media`, { headers: authHeaders(accessToken), signal });
    assertOk(response, "Google chat segment reconciliation download");
    try { values.push(await verifyAssistantSegment(JSON.parse(await readResponseTextBounded(response, MAX_ASSISTANT_LOSSLESS_SEGMENT_BYTES)), ref)); }
    catch { throw new Error(`Chat archive segment ${ref.id} has divergent duplicate content.`); }
  }
  return values;
}

async function removeGoogleSegmentDuplicates(accessToken: string, files: GoogleSegmentFile[], canonicalId: string, signal?: AbortSignal): Promise<void> {
  for (const duplicate of files) if (duplicate.id !== canonicalId) await deleteGoogleSession(accessToken, duplicate.id, signal);
}

async function loadGoogleSegment(accessToken: string, sessionId: string, ref: AssistantLosslessSegmentRef, signal?: AbortSignal): Promise<unknown> {
  const matches = (await findGoogleSegmentFiles(accessToken, sessionId, ref, signal)).sort((a, b) => a.id.localeCompare(b.id));
  if (!matches.length) throw new Error(`Chat archive segment ${ref.id} is missing.`);
  const values = await verifyGoogleSegmentCandidates(accessToken, sessionId, matches, ref, signal);
  return values[0];
}

async function deleteGoogleSegments(accessToken: string, sessionId: string, signal?: AbortSignal): Promise<void> {
  for (const file of await findGoogleSegmentFiles(accessToken, sessionId, undefined, signal)) await deleteGoogleSession(accessToken, file.id, signal);
}

async function findGoogleSessions(accessToken: string, chats: string, sessionId?: string, options: ListOptions = {}): Promise<NativeChatMeta[]> {
  const files: NativeChatMeta[] = [];
  let pageToken: string | undefined;
  do {
    assertCurrent(options);
    const query = [`'${chats}' in parents`, "trashed=false", `mimeType='${MIME_JSON}'`];
    if (sessionId) query.push(`name='${sessionId}.json'`);
    const params = new URLSearchParams({
      q: query.join(" and "), spaces: "drive",
      fields: "nextPageToken,files(id,name,mimeType,modifiedTime,appProperties,trashed)",
      pageSize: "1000",
      ...(pageToken ? { pageToken } : {}),
    });
    const response = await fetch(`${GOOGLE_DRIVE_API}/files?${params}`, { headers: authHeaders(accessToken), signal: options.signal });
    assertOk(response, "Google chats list");
    const data = await response.json() as { nextPageToken?: string; files?: Array<{ id: string; name: string; modifiedTime?: string; appProperties?: Record<string, string> }> };
    for (const file of data.files ?? []) {
      const idFromName = sessionIdFromName(file.name);
      if (!idFromName) continue;
      const properties = file.appProperties ?? {};
      if (
        properties.narrariumChat !== CHAT_MARKER
        || properties.sessionId !== idFromName
        || typeof properties.title !== "string"
        || typeof properties.contextTitle !== "string"
      ) continue;
       files.push({ id: file.id, name: file.name, modifiedTime: file.modifiedTime, sessionId: properties.sessionId, title: properties.title, contextTitle: properties.contextTitle, ...(Number.isFinite(Date.parse(properties.updatedAt)) ? { embeddedUpdatedAt: properties.updatedAt } : {}), ...(/^\d+$/.test(properties.contentRevision ?? "") ? { contentRevision: Number(properties.contentRevision) } : {}) });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  assertCurrent(options);
  return files;
}

async function listGoogleSessions(accessToken: string, options: ListOptions): Promise<AssistantSessionMeta[]> {
  const root = await ensureGoogleAppFolder(accessToken);
  assertCurrent(options);
  const chats = await ensureGoogleFolder(accessToken, CHATS_FOLDER, root);
  const files = await findGoogleSessions(accessToken, chats, undefined, options);
  return files.map(normalizeSessionMeta).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function reclaimGoogleOrphanSegments(accessToken: string, reachableNames: Set<string>, signal?: AbortSignal): Promise<void> {
  const folder = await googleSegmentsFolder(accessToken);
  const files: GoogleSegmentFile[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ q: `'${folder}' in parents and trashed=false`, spaces: "drive", fields: "nextPageToken,files(id,name,createdTime,modifiedTime,appProperties)", pageSize: "1000", ...(pageToken ? { pageToken } : {}) });
    const response = await fetch(`${GOOGLE_DRIVE_API}/files?${params}`, { headers: authHeaders(accessToken), signal });
    assertOk(response, "Google orphan chat segment list");
    const page = await response.json() as { nextPageToken?: string; files?: GoogleSegmentFile[] };
    files.push(...(page.files ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  const byIdentity = new Map<string, GoogleSegmentFile[]>();
  for (const file of files) {
    const identity = googleSegmentIdentity(file);
    if (identity) byIdentity.set(identity, [...(byIdentity.get(identity) ?? []), file]);
  }
  for (const [identity, matches] of byIdentity) {
    if (reachableNames.has(identity) && matches.length > 1) {
      const properties = matches[0].appProperties!;
      const ref = { id: properties.narrariumChatSegmentId, sha256: properties.narrariumChatSegmentHash };
      await verifyGoogleSegmentCandidates(accessToken, properties.narrariumChatSegmentSession, matches, ref, signal);
      await removeGoogleSegmentDuplicates(accessToken, matches, matches.map((file) => file.id).sort()[0], signal);
      continue;
    }
    for (const file of matches) {
      const providerTime = Date.parse(file.createdTime ?? file.modifiedTime ?? "");
      if (Number.isFinite(providerTime) && Date.now() - providerTime >= SEGMENT_ORPHAN_GRACE_MS && !reachableNames.has(identity)) await deleteGoogleSession(accessToken, file.id, signal);
    }
  }
}

async function loadGoogleSession(accessToken: string, fileId: string, signal?: AbortSignal): Promise<AssistantSession> {
  const response = await fetch(`${GOOGLE_DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`, { headers: authHeaders(accessToken), signal });
  assertOk(response, "Google chat download");
  const session = await parseSessionResponse(response);
  return { ...session, fileId, revision: responseRevision(response) };
}

async function resolveGoogleIdentity(accessToken: string, chats: string, session: AssistantSession, signal?: AbortSignal): Promise<NativeChatMeta | undefined> {
  const matches = await findGoogleSessions(accessToken, chats, session.id, { signal });
  if (matches.length > 1) throw new AssistantSessionConflictError(session.id, matches[0].id);
  return matches[0];
}

async function reconcileGoogleCreate(accessToken: string, chats: string, session: AssistantSession, createdFileId: string, signal?: AbortSignal): Promise<AssistantSessionCloudHandle | undefined> {
  const observed = new Map<string, NativeChatMeta>();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, attempt * 50));
    const matches = await findGoogleSessions(accessToken, chats, session.id, { signal });
    for (const match of matches) observed.set(match.id, match);
  }
  if (!observed.size) throw new AssistantSessionConflictError(session.id, createdFileId);
  const matches = [...observed.values()].sort((left, right) => left.id.localeCompare(right.id));
  const loaded = await Promise.all(matches.map((match) => loadGoogleSession(accessToken, match.id, signal)));
  if (loaded.some((remote) => !sameSession(remote, session))) {
    const canonical = loaded[0];
    if (createdFileId !== canonical.fileId) await deleteGoogleSession(accessToken, createdFileId);
    throw new AssistantSessionConflictError(session.id, canonical.fileId ?? createdFileId);
  }
  const canonical = loaded[0];
  for (const duplicate of loaded.slice(1)) await deleteGoogleSession(accessToken, duplicate.fileId!);
  return canonical.fileId === createdFileId ? undefined : { fileId: canonical.fileId!, revision: canonical.revision };
}

async function idempotentOrConflict(provider: AuthProvider, accessToken: string, session: AssistantSession, fileId: string): Promise<AssistantSessionCloudHandle> {
  const remote = await loadAssistantSession(provider, accessToken, fileId);
  if (sameSession(remote, session)) return { fileId, revision: remote.revision };
  throw new AssistantSessionConflictError(session.id, fileId);
}

async function saveGoogleSession(accessToken: string, session: AssistantSession, signal?: AbortSignal): Promise<AssistantSessionCloudHandle> {
  const root = await ensureGoogleAppFolder(accessToken);
  const chats = await ensureGoogleFolder(accessToken, CHATS_FOLDER, root);
  const body = serializeAssistantSession(session);
  let fileId = session.fileId;
  if (!fileId) {
    const existing = await resolveGoogleIdentity(accessToken, chats, session, signal);
    if (existing) return idempotentOrConflict("google", accessToken, session, existing.id);
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify({ name: chatFileName(session), parents: [chats], mimeType: MIME_JSON, appProperties: googleProperties(session) })], { type: MIME_JSON }));
    form.append("file", new Blob([body], { type: MIME_JSON }));
    const create = await fencedCloudMutation("google", accessToken, `${GOOGLE_UPLOAD_API}/files?uploadType=multipart&fields=id`, { method: "POST", headers: authHeaders(accessToken), body: form, signal });
    assertOk(create, "Google chat create");
    const created = await create.json() as { id: string };
    fileId = created.id;
    const raced = await reconcileGoogleCreate(accessToken, chats, session, fileId, signal);
    if (raced) return raced;
    const revision = responseRevision(create) ?? (await loadGoogleRevision(accessToken, fileId, signal));
    return { fileId, revision };
  }
  const revision = session.revision ?? await loadGoogleRevision(accessToken, fileId, signal);
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({ name: chatFileName(session), mimeType: MIME_JSON, appProperties: googleProperties(session) })], { type: MIME_JSON }));
  form.append("file", new Blob([body], { type: MIME_JSON }));
  const update = await fencedCloudMutation("google", accessToken, `${GOOGLE_UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=multipart`, {
    method: "PATCH",
    headers: { ...authHeaders(accessToken), "If-Match": revision },
    body: form,
    signal,
  });
  if (update.status === 409 || update.status === 412) return idempotentOrConflict("google", accessToken, session, fileId);
  assertOk(update, "Google chat update");
  return { fileId, revision: responseRevision(update) ?? await loadGoogleRevision(accessToken, fileId, signal) };
}

async function loadGoogleRevision(accessToken: string, fileId: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(`${GOOGLE_DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id`, { headers: authHeaders(accessToken), signal });
  assertOk(response, "Google chat revision");
  const revision = responseRevision(response);
  if (!revision) throw new Error(`Google chat ${fileId} did not provide a revision.`);
  return revision;
}

async function deleteGoogleSession(accessToken: string, fileId: string, signal?: AbortSignal): Promise<void> {
  const response = await fencedCloudMutation("google", accessToken, `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(fileId)}`, { method: "DELETE", headers: authHeaders(accessToken), signal });
  if (!(response.ok || response.status === 404)) throw new Error(`Google chat delete: ${response.status}`);
}

async function ensureMicrosoftFolderPath(accessToken: string, folderPath: string): Promise<void> {
  const parts = folderPath.split("/").filter(Boolean);
  let currentPath = "";
  for (const part of parts) {
    const nextPath = currentPath ? `${currentPath}/${part}` : part;
    const exists = await fetchMicrosoftGraph(`${GRAPH_DRIVE_API}/root:/${nextPath}`, { headers: authHeaders(accessToken) });
    if (exists.ok) { currentPath = nextPath; continue; }
    if (exists.status !== 404) throw new AssistantCloudRequestError("OneDrive folder lookup", exists.status);
    const createUrl = currentPath ? `${GRAPH_DRIVE_API}/root:/${currentPath}:/children` : `${GRAPH_DRIVE_API}/root/children`;
    const created = await fencedCloudMutation("microsoft", accessToken, createUrl, {
      method: "POST", headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON },
      body: JSON.stringify({ name: part, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
    });
    if (!(created.ok || created.status === 409)) throw new AssistantCloudRequestError("OneDrive folder create", created.status);
    currentPath = nextPath;
  }
}

function microsoftSegmentsPath(sessionId: string): string { return `${ONE_DRIVE_APP_FOLDER}/${SEGMENTS_FOLDER}/${sessionId}`; }

async function persistMicrosoftSegment(accessToken: string, sessionId: string, ref: AssistantLosslessSegmentRef, segment: AssistantLosslessSegment, signal?: AbortSignal): Promise<string | undefined> {
  const folder = microsoftSegmentsPath(sessionId);
  await ensureMicrosoftFolderPath(accessToken, folder);
  const response = await fencedCloudMutation("microsoft", accessToken, `${GRAPH_DRIVE_API}/root:/${folder}/${segmentFileName(sessionId, ref)}:/content`, { method: "PUT", headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON, "If-None-Match": "*" }, body: serializeAssistantLosslessSegment(segment), signal });
  if (response.status === 409 || response.status === 412) { await verifyAssistantSegment(await loadMicrosoftSegment(accessToken, sessionId, ref, signal), ref); return undefined; }
  else assertOk(response, "OneDrive chat segment create");
  return segmentFileName(sessionId, ref);
}

async function loadMicrosoftSegment(accessToken: string, sessionId: string, ref: AssistantLosslessSegmentRef, signal?: AbortSignal): Promise<unknown> {
  const response = await fetchMicrosoftGraph(`${GRAPH_DRIVE_API}/root:/${microsoftSegmentsPath(sessionId)}/${segmentFileName(sessionId, ref)}:/content`, { headers: authHeaders(accessToken), signal });
  assertOk(response, "OneDrive chat segment download");
  return JSON.parse(await readResponseTextBounded(response, MAX_ASSISTANT_LOSSLESS_SEGMENT_BYTES));
}

async function deleteMicrosoftSegments(accessToken: string, sessionId: string, signal?: AbortSignal): Promise<void> {
  const response = await fencedCloudMutation("microsoft", accessToken, `${GRAPH_DRIVE_API}/root:/${microsoftSegmentsPath(sessionId)}`, { method: "DELETE", headers: authHeaders(accessToken), signal });
  if (!(response.ok || response.status === 404)) throw new AssistantCloudRequestError("OneDrive chat segments delete", response.status);
}

async function deleteAssistantSegments(provider: AuthProvider, accessToken: string, sessionId: string, signal?: AbortSignal): Promise<void> {
  return provider === "microsoft" ? deleteMicrosoftSegments(accessToken, sessionId, signal) : deleteGoogleSegments(accessToken, sessionId, signal);
}

async function findMicrosoftSessions(accessToken: string, options: ListOptions = {}): Promise<NativeChatMeta[]> {
  const folderPath = `${ONE_DRIVE_APP_FOLDER}/${CHATS_FOLDER}`;
  await ensureMicrosoftFolderPath(accessToken, folderPath);
  let next: string | undefined = `${GRAPH_DRIVE_API}/root:/${folderPath}:/children?$select=id,name,lastModifiedDateTime,eTag,description,file,folder&$top=200`;
  const entries: NativeChatMeta[] = [];
  while (next) {
    assertCurrent(options);
    const response = await fetchMicrosoftGraph(next, { headers: authHeaders(accessToken), signal: options.signal });
    assertOk(response, "OneDrive chats list");
    const data = await response.json() as { "@odata.nextLink"?: string; value?: Array<{ id: string; name: string; lastModifiedDateTime?: string; eTag?: string; description?: string; file?: unknown; folder?: unknown }> };
    for (const entry of data.value ?? []) {
      const idFromName = sessionIdFromName(entry.name);
      if (!entry.file || entry.folder || !idFromName) continue;
      const metadata = parseMicrosoftDescription(entry.description);
      if (!metadata || metadata.sessionId !== idFromName) continue;
      entries.push({ id: entry.id, name: entry.name, modifiedTime: entry.lastModifiedDateTime, revision: entry.eTag, ...metadata });
    }
    next = data["@odata.nextLink"];
  }
  assertCurrent(options);
  return entries;
}

async function listMicrosoftSessions(accessToken: string, options: ListOptions): Promise<AssistantSessionMeta[]> {
  const entries = await findMicrosoftSessions(accessToken, options);
  return entries.map(normalizeSessionMeta).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function reclaimMicrosoftOrphanSegments(accessToken: string, reachableNames: Set<string>, signal?: AbortSignal): Promise<void> {
  await ensureMicrosoftFolderPath(accessToken, `${ONE_DRIVE_APP_FOLDER}/${SEGMENTS_FOLDER}`);
  let next: string | undefined = `${GRAPH_DRIVE_API}/root:/${ONE_DRIVE_APP_FOLDER}/${SEGMENTS_FOLDER}:/children?$select=id,name,folder,createdDateTime&$top=200`;
  while (next) {
    const response = await fetchMicrosoftGraph(next, { headers: authHeaders(accessToken), signal });
    assertOk(response, "OneDrive orphan chat segment list");
    const page = await response.json() as { "@odata.nextLink"?: string; value?: Array<{ id: string; name: string; folder?: unknown; createdDateTime?: string }> };
    for (const item of page.value ?? []) {
      const createdAt = Date.parse(item.createdDateTime ?? "");
      if (item.folder && Number.isFinite(createdAt) && Date.now() - createdAt >= SEGMENT_ORPHAN_GRACE_MS) {
        const childrenRemain = await reclaimMicrosoftSegmentFolder(accessToken, item.name, reachableNames, signal);
        if (!childrenRemain) {
          const removed = await fencedCloudMutation("microsoft", accessToken, `${GRAPH_DRIVE_API}/items/${encodeURIComponent(item.id)}`, { method: "DELETE", headers: authHeaders(accessToken), signal });
          if (!(removed.ok || removed.status === 404)) throw new AssistantCloudRequestError("OneDrive orphan chat segments delete", removed.status);
        }
      }
    }
    next = page["@odata.nextLink"];
  }
}

async function reclaimMicrosoftSegmentFolder(accessToken: string, sessionId: string, reachableNames: Set<string>, signal?: AbortSignal): Promise<boolean> {
  let next: string | undefined = `${GRAPH_DRIVE_API}/root:/${microsoftSegmentsPath(sessionId)}:/children?$select=id,name,createdDateTime&$top=200`;
  let childrenRemain = false;
  while (next) {
    const response = await fetchMicrosoftGraph(next, { headers: authHeaders(accessToken), signal });
    if (response.status === 404) return false;
    assertOk(response, "OneDrive chat segment maintenance list");
    const page = await response.json() as { "@odata.nextLink"?: string; value?: Array<{ id: string; name: string; createdDateTime?: string }> };
    for (const item of page.value ?? []) {
      const createdAt = Date.parse(item.createdDateTime ?? "");
      if (Number.isFinite(createdAt) && Date.now() - createdAt >= SEGMENT_ORPHAN_GRACE_MS && !reachableNames.has(item.name)) {
        const removed = await fencedCloudMutation("microsoft", accessToken, `${GRAPH_DRIVE_API}/items/${encodeURIComponent(item.id)}`, { method: "DELETE", headers: authHeaders(accessToken), signal });
        if (!(removed.ok || removed.status === 404)) throw new AssistantCloudRequestError("OneDrive unreachable chat segment delete", removed.status);
      } else childrenRemain = true;
    }
    next = page["@odata.nextLink"];
  }
  return childrenRemain;
}

async function collectReachableSegments(provider: AuthProvider, accessToken: string, entries: NativeChatMeta[], options: ListOptions): Promise<Set<string>> {
  const reachable = new Set<string>();
  for (const entry of entries) {
    assertCurrent(options);
    const session = provider === "microsoft" ? await loadMicrosoftSession(accessToken, entry.id, options.signal) : await loadGoogleSession(accessToken, entry.id, options.signal);
    let ref = session.losslessArchive?.head;
    let count = 0;
    const seen = new Set<string>();
    while (ref) {
      if (seen.has(ref.id) || count >= (session.losslessArchive?.segmentCount ?? 0)) throw new Error(`Chat ${session.id} has an invalid archive chain.`);
      seen.add(ref.id);
      reachable.add(provider === "google" ? segmentIdentity(session.id, ref) : segmentFileName(session.id, ref));
      const raw = provider === "microsoft" ? await loadMicrosoftSegment(accessToken, session.id, ref, options.signal) : await loadGoogleSegment(accessToken, session.id, ref, options.signal);
      ref = (await verifyAssistantSegment(raw, ref)).previous;
      count += 1;
    }
    if (count !== (session.losslessArchive?.segmentCount ?? 0)) throw new Error(`Chat ${session.id} has an incomplete archive chain.`);
  }
  return reachable;
}

export async function maintainAssistantSessionSegments(provider: AuthProvider, accessToken: string, options: ListOptions = {}): Promise<void> {
  const release = await acquireCloudWriteLease(provider, accessToken, options.signal);
  try {
    const entries = provider === "microsoft" ? await findMicrosoftSessions(accessToken, options) : await (async () => {
      const root = await ensureGoogleAppFolder(accessToken);
      const chats = await ensureGoogleFolder(accessToken, CHATS_FOLDER, root);
      return findGoogleSessions(accessToken, chats, undefined, options);
    })();
    const reachable = await collectReachableSegments(provider, accessToken, entries, options);
    if (provider === "microsoft") await reclaimMicrosoftOrphanSegments(accessToken, reachable, options.signal);
    else await reclaimGoogleOrphanSegments(accessToken, reachable, options.signal);
  } finally {
    await release();
  }
}

async function reclaimUnreachableSessionSegments(provider: AuthProvider, accessToken: string, session: AssistantSession, signal?: AbortSignal): Promise<void> {
  if (!session.losslessArchive?.head && (session.losslessArchive?.segmentCount ?? 0) === 0) return;
  const reachable = new Set<string>();
  let ref = session.losslessArchive?.head;
  let count = 0;
  while (ref) {
    reachable.add(provider === "google" ? segmentIdentity(session.id, ref) : segmentFileName(session.id, ref));
    const raw = provider === "microsoft" ? await loadMicrosoftSegment(accessToken, session.id, ref, signal) : await loadGoogleSegment(accessToken, session.id, ref, signal);
    ref = (await verifyAssistantSegment(raw, ref)).previous;
    count += 1;
  }
  if (count !== (session.losslessArchive?.segmentCount ?? 0)) throw new Error(`Chat ${session.id} has an incomplete published archive chain.`);
  if (provider === "microsoft") await reclaimMicrosoftSegmentFolder(accessToken, session.id, reachable, signal);
  else {
    for (const file of await findGoogleSegmentFiles(accessToken, session.id, undefined, signal)) {
      const identity = googleSegmentIdentity(file);
      if (identity && reachable.has(identity)) continue;
      const providerTime = Date.parse(file.createdTime ?? file.modifiedTime ?? "");
      if (identity && Number.isFinite(providerTime) && Date.now() - providerTime >= SEGMENT_ORPHAN_GRACE_MS) await deleteGoogleSession(accessToken, file.id, signal);
    }
  }
}

async function loadMicrosoftSession(accessToken: string, fileId: string, signal?: AbortSignal): Promise<AssistantSession> {
  return (await loadMicrosoftSessionState(accessToken, fileId, signal)).session;
}

async function loadMicrosoftSessionState(accessToken: string, fileId: string, signal?: AbortSignal): Promise<{ session: AssistantSession; description?: string }> {
  const metadataResponse = await fetchMicrosoftGraph(`${GRAPH_DRIVE_API}/items/${encodeURIComponent(fileId)}?$select=id,eTag,description`, { headers: authHeaders(accessToken), signal });
  assertOk(metadataResponse, "OneDrive chat metadata");
  const metadata = await metadataResponse.json() as { eTag?: string; description?: string };
  const response = await fetchMicrosoftGraph(`${GRAPH_DRIVE_API}/items/${encodeURIComponent(fileId)}/content`, { headers: authHeaders(accessToken), signal });
  assertOk(response, "OneDrive chat download");
  const session = await parseSessionResponse(response);
  return { session: { ...session, fileId, revision: responseRevision(metadataResponse, metadata) }, description: metadata.description };
}

async function patchMicrosoftMetadata(accessToken: string, handle: AssistantSessionCloudHandle, session: AssistantSession, signal?: AbortSignal): Promise<AssistantSessionCloudHandle> {
  const response = await fencedCloudMutation("microsoft", accessToken, `${GRAPH_DRIVE_API}/items/${encodeURIComponent(handle.fileId)}`, {
    method: "PATCH",
    headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON, ...(handle.revision ? { "If-Match": handle.revision } : {}) },
    body: JSON.stringify({ description: microsoftDescription(session) }),
    signal,
  });
  assertOk(response, "OneDrive chat metadata update");
  const body = await response.json() as { eTag?: string };
  return { fileId: handle.fileId, revision: responseRevision(response, body) ?? handle.revision };
}

async function findMicrosoftSessionByIdentity(accessToken: string, folderPath: string, session: AssistantSession): Promise<(AssistantSessionCloudHandle & { metadataMatches: boolean }) | undefined> {
  const response = await fetchMicrosoftGraph(`${GRAPH_DRIVE_API}/root:/${folderPath}/${chatFileName(session)}?$select=id,name,eTag,description,file,folder`, { headers: authHeaders(accessToken) });
  if (response.status === 404) return undefined;
  assertOk(response, "OneDrive chat identity lookup");
  const item = await response.json() as { id?: string; name?: string; eTag?: string; description?: string; file?: unknown; folder?: unknown };
  if (!item.id || item.name !== chatFileName(session) || !item.file || item.folder) {
    throw new Error(`OneDrive chat ${session.id} has an invalid file identity.`);
  }
  return { fileId: item.id, revision: responseRevision(response, item), metadataMatches: microsoftMetadataMatches(item.description, session) };
}

async function repairMicrosoftSession(accessToken: string, session: AssistantSession, handle: AssistantSessionCloudHandle, signal?: AbortSignal): Promise<AssistantSessionCloudHandle> {
  const state = await loadMicrosoftSessionState(accessToken, handle.fileId, signal);
  const remote = state.session;
  if (!sameSession(remote, session)) throw new AssistantSessionConflictError(session.id, handle.fileId);
  if (microsoftMetadataMatches(state.description, session)) return { fileId: handle.fileId, revision: remote.revision };
  return patchMicrosoftMetadata(accessToken, { fileId: handle.fileId, revision: remote.revision }, session, signal);
}

async function saveMicrosoftSession(accessToken: string, session: AssistantSession, signal?: AbortSignal): Promise<AssistantSessionCloudHandle> {
  const folderPath = `${ONE_DRIVE_APP_FOLDER}/${CHATS_FOLDER}`;
  await ensureMicrosoftFolderPath(accessToken, folderPath);
  const body = serializeAssistantSession(session);
  let fileId = session.fileId;
  if (!fileId) {
    const existing = await findMicrosoftSessionByIdentity(accessToken, folderPath, session);
    if (existing) return existing.metadataMatches
      ? idempotentOrConflict("microsoft", accessToken, session, existing.fileId)
      : repairMicrosoftSession(accessToken, session, existing, signal);
    const create = await fencedCloudMutation("microsoft", accessToken, `${GRAPH_DRIVE_API}/root:/${folderPath}/${chatFileName(session)}:/content`, {
      method: "PUT", headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON, "If-None-Match": "*" }, body, signal,
    });
    if (create.status === 409 || create.status === 412) {
      const raced = await findMicrosoftSessionByIdentity(accessToken, folderPath, session);
      if (!raced) throw new AssistantCloudRequestError("OneDrive chat create conflict", create.status);
      return raced.metadataMatches
        ? idempotentOrConflict("microsoft", accessToken, session, raced.fileId)
        : repairMicrosoftSession(accessToken, session, raced, signal);
    }
    assertOk(create, "OneDrive chat create");
    const created = await create.json() as { id: string; eTag?: string };
    return patchMicrosoftMetadata(accessToken, { fileId: created.id, revision: responseRevision(create, created) }, session, signal);
  }
  if (!session.revision) return repairMicrosoftSession(accessToken, session, { fileId }, signal);
  const response = await fencedCloudMutation("microsoft", accessToken, `${GRAPH_DRIVE_API}/items/${encodeURIComponent(fileId)}/content`, {
    method: "PUT", headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON, "If-Match": session.revision }, body, signal,
  });
  if (response.status === 409 || response.status === 412) return repairMicrosoftSession(accessToken, session, { fileId }, signal);
  assertOk(response, "OneDrive chat update");
  const updated = await response.json() as { id: string; eTag?: string };
  return patchMicrosoftMetadata(accessToken, { fileId: updated.id, revision: responseRevision(response, updated) }, session, signal);
}

async function deleteMicrosoftSession(accessToken: string, fileId: string, signal?: AbortSignal): Promise<void> {
  const response = await fencedCloudMutation("microsoft", accessToken, `${GRAPH_DRIVE_API}/items/${encodeURIComponent(fileId)}`, { method: "DELETE", headers: authHeaders(accessToken), signal });
  if (!(response.ok || response.status === 404)) throw new Error(`OneDrive chat delete: ${response.status}`);
}
