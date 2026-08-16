import type { AuthProvider } from "../store/authStore.ts";
import { normalizeAssistantSession, type AssistantSession, type AssistantSessionMeta } from "./store.ts";
import type { AssistantSessionCloudHandle } from "./sessionAutosave.ts";
import { ensureGoogleAppFolder } from "../drive/googleAppFolder.ts";
import { beginCloudWrite } from "../drive/cloudWriteBarrier.ts";
import { MAX_ASSISTANT_SESSION_BYTES, parseAssistantSessionJson, serializeAssistantSession } from "./sessionSchema.ts";

const GOOGLE_DRIVE_API = "https://www.googleapis.com/drive/v3";
const GOOGLE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const GRAPH_DRIVE_API = "https://graph.microsoft.com/v1.0/me/drive";
const ONE_DRIVE_APP_FOLDER = "Apps/Narrarium";
const CHATS_FOLDER = "chats";
const MIME_JSON = "application/json";
const CHAT_MARKER = "v1";
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

export async function saveAssistantSession(provider: AuthProvider, accessToken: string, session: AssistantSession): Promise<AssistantSessionCloudHandle> {
  if (!CHAT_NAME.test(chatFileName(session))) throw new AssistantSessionPermanentSaveError(`Invalid chat session identity: ${session.id}`);
  const normalized = normalizeAssistantSession(session);
  const payloadBytes = new TextEncoder().encode(serializeAssistantSession(normalized)).length;
  if (payloadBytes > MAX_PERSISTED_CHAT_BYTES) throw new AssistantSessionPayloadTooLargeError(payloadBytes);
  const endWrite = beginCloudWrite(provider, accessToken);
  try {
    return await (provider === "microsoft" ? saveMicrosoftSession(accessToken, normalized) : saveGoogleSession(accessToken, normalized));
  } finally {
    endWrite();
  }
}

export async function deleteAssistantSession(provider: AuthProvider, accessToken: string, fileId: string, signal?: AbortSignal): Promise<void> {
  return provider === "microsoft" ? deleteMicrosoftSession(accessToken, fileId, signal) : deleteGoogleSession(accessToken, fileId, signal);
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
  return parseAssistantSessionJson(await response.text());
}

function chatFileName(session: Pick<AssistantSession, "id">): string {
  return `${session.id}.json`;
}

function sessionIdFromName(name: string): string | undefined {
  return CHAT_NAME.test(name) ? name.slice(0, -5) : undefined;
}

function normalizeSessionMeta(raw: NativeChatMeta): AssistantSessionMeta {
  const sessionId = raw.sessionId ?? sessionIdFromName(raw.name) ?? raw.id;
  return {
    id: sessionId,
    fileId: raw.id,
    revision: raw.revision,
    title: raw.title || sessionId,
    contextTitle: raw.contextTitle || "Narrarium",
    updatedAt: raw.modifiedTime ?? new Date(0).toISOString(),
  };
}

function sameSession(left: AssistantSession, right: AssistantSession): boolean {
  return serializeAssistantSession(left) === serializeAssistantSession(right);
}

function responseRevision(response: Response, body?: { eTag?: string; etag?: string }): string | undefined {
  return response.headers.get("ETag") ?? body?.eTag ?? body?.etag;
}

function googleProperties(session: AssistantSession): Record<string, string> {
  return { narrariumChat: CHAT_MARKER, sessionId: session.id, title: truncateUtf8(session.title, 100), contextTitle: truncateUtf8(session.contextTitle, 100) };
}

function microsoftDescription(session: AssistantSession): string {
  return JSON.stringify({ narrariumChat: CHAT_MARKER, sessionId: session.id, title: session.title.slice(0, 500), contextTitle: session.contextTitle.slice(0, 500) });
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
    };
  } catch {
    return null;
  }
}

function microsoftMetadataMatches(description: string | undefined, session: AssistantSession): boolean {
  const metadata = parseMicrosoftDescription(description);
  const expected = JSON.parse(microsoftDescription(session)) as { sessionId: string; title: string; contextTitle: string };
  return Boolean(
    metadata
    && metadata.sessionId === expected.sessionId
    && metadata.title === expected.title
    && metadata.contextTitle === expected.contextTitle
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
  const created = await fetch(`${GOOGLE_DRIVE_API}/files?fields=id`, {
    method: "POST",
    headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", ...(parentId ? { parents: [parentId] } : {}) }),
  });
  assertOk(created, "Google folder create");
  return (await created.json() as { id: string }).id;
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
      files.push({ id: file.id, name: file.name, modifiedTime: file.modifiedTime, sessionId: properties.sessionId, title: properties.title, contextTitle: properties.contextTitle });
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

async function loadGoogleSession(accessToken: string, fileId: string, signal?: AbortSignal): Promise<AssistantSession> {
  const response = await fetch(`${GOOGLE_DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`, { headers: authHeaders(accessToken), signal });
  assertOk(response, "Google chat download");
  const session = await parseSessionResponse(response);
  return { ...session, fileId, revision: responseRevision(response) };
}

async function resolveGoogleIdentity(accessToken: string, chats: string, session: AssistantSession): Promise<NativeChatMeta | undefined> {
  const matches = await findGoogleSessions(accessToken, chats, session.id);
  if (matches.length > 1) throw new AssistantSessionConflictError(session.id, matches[0].id);
  return matches[0];
}

async function reconcileGoogleCreate(accessToken: string, chats: string, session: AssistantSession, createdFileId: string): Promise<AssistantSessionCloudHandle | undefined> {
  const observed = new Map<string, NativeChatMeta>();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, attempt * 50));
    const matches = await findGoogleSessions(accessToken, chats, session.id);
    for (const match of matches) observed.set(match.id, match);
  }
  if (!observed.size) throw new AssistantSessionConflictError(session.id, createdFileId);
  const matches = [...observed.values()].sort((left, right) => left.id.localeCompare(right.id));
  const loaded = await Promise.all(matches.map((match) => loadGoogleSession(accessToken, match.id)));
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

async function saveGoogleSession(accessToken: string, session: AssistantSession): Promise<AssistantSessionCloudHandle> {
  const root = await ensureGoogleAppFolder(accessToken);
  const chats = await ensureGoogleFolder(accessToken, CHATS_FOLDER, root);
  const body = serializeAssistantSession(session);
  let fileId = session.fileId;
  if (!fileId) {
    const existing = await resolveGoogleIdentity(accessToken, chats, session);
    if (existing) return idempotentOrConflict("google", accessToken, session, existing.id);
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify({ name: chatFileName(session), parents: [chats], mimeType: MIME_JSON, appProperties: googleProperties(session) })], { type: MIME_JSON }));
    form.append("file", new Blob([body], { type: MIME_JSON }));
    const create = await fetch(`${GOOGLE_UPLOAD_API}/files?uploadType=multipart&fields=id`, { method: "POST", headers: authHeaders(accessToken), body: form });
    assertOk(create, "Google chat create");
    const created = await create.json() as { id: string };
    fileId = created.id;
    const raced = await reconcileGoogleCreate(accessToken, chats, session, fileId);
    if (raced) return raced;
    const revision = responseRevision(create) ?? (await loadGoogleRevision(accessToken, fileId));
    return { fileId, revision };
  }
  const revision = session.revision ?? await loadGoogleRevision(accessToken, fileId);
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({ name: chatFileName(session), mimeType: MIME_JSON, appProperties: googleProperties(session) })], { type: MIME_JSON }));
  form.append("file", new Blob([body], { type: MIME_JSON }));
  const update = await fetch(`${GOOGLE_UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=multipart`, {
    method: "PATCH",
    headers: { ...authHeaders(accessToken), "If-Match": revision },
    body: form,
  });
  if (update.status === 409 || update.status === 412) return idempotentOrConflict("google", accessToken, session, fileId);
  assertOk(update, "Google chat update");
  return { fileId, revision: responseRevision(update) ?? await loadGoogleRevision(accessToken, fileId) };
}

async function loadGoogleRevision(accessToken: string, fileId: string): Promise<string> {
  const response = await fetch(`${GOOGLE_DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id`, { headers: authHeaders(accessToken) });
  assertOk(response, "Google chat revision");
  const revision = responseRevision(response);
  if (!revision) throw new Error(`Google chat ${fileId} did not provide a revision.`);
  return revision;
}

async function deleteGoogleSession(accessToken: string, fileId: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${GOOGLE_DRIVE_API}/files/${encodeURIComponent(fileId)}`, { method: "DELETE", headers: authHeaders(accessToken), signal });
  if (!(response.ok || response.status === 404)) throw new Error(`Google chat delete: ${response.status}`);
}

async function ensureMicrosoftFolderPath(accessToken: string, folderPath: string): Promise<void> {
  const parts = folderPath.split("/").filter(Boolean);
  let currentPath = "";
  for (const part of parts) {
    const nextPath = currentPath ? `${currentPath}/${part}` : part;
    const exists = await fetch(`${GRAPH_DRIVE_API}/root:/${nextPath}`, { headers: authHeaders(accessToken) });
    if (exists.ok) { currentPath = nextPath; continue; }
    if (exists.status !== 404) throw new AssistantCloudRequestError("OneDrive folder lookup", exists.status);
    const createUrl = currentPath ? `${GRAPH_DRIVE_API}/root:/${currentPath}:/children` : `${GRAPH_DRIVE_API}/root/children`;
    const created = await fetch(createUrl, {
      method: "POST", headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON },
      body: JSON.stringify({ name: part, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
    });
    if (!(created.ok || created.status === 409)) throw new AssistantCloudRequestError("OneDrive folder create", created.status);
    currentPath = nextPath;
  }
}

async function findMicrosoftSessions(accessToken: string, options: ListOptions = {}): Promise<NativeChatMeta[]> {
  const folderPath = `${ONE_DRIVE_APP_FOLDER}/${CHATS_FOLDER}`;
  await ensureMicrosoftFolderPath(accessToken, folderPath);
  let next: string | undefined = `${GRAPH_DRIVE_API}/root:/${folderPath}:/children?$select=id,name,lastModifiedDateTime,eTag,description,file,folder&$top=200`;
  const entries: NativeChatMeta[] = [];
  while (next) {
    assertCurrent(options);
    const response = await fetch(next, { headers: authHeaders(accessToken), signal: options.signal });
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

async function loadMicrosoftSession(accessToken: string, fileId: string, signal?: AbortSignal): Promise<AssistantSession> {
  return (await loadMicrosoftSessionState(accessToken, fileId, signal)).session;
}

async function loadMicrosoftSessionState(accessToken: string, fileId: string, signal?: AbortSignal): Promise<{ session: AssistantSession; description?: string }> {
  const metadataResponse = await fetch(`${GRAPH_DRIVE_API}/items/${encodeURIComponent(fileId)}?$select=id,eTag,description`, { headers: authHeaders(accessToken), signal });
  assertOk(metadataResponse, "OneDrive chat metadata");
  const metadata = await metadataResponse.json() as { eTag?: string; description?: string };
  const response = await fetch(`${GRAPH_DRIVE_API}/items/${encodeURIComponent(fileId)}/content`, { headers: authHeaders(accessToken), signal });
  assertOk(response, "OneDrive chat download");
  const session = await parseSessionResponse(response);
  return { session: { ...session, fileId, revision: responseRevision(metadataResponse, metadata) }, description: metadata.description };
}

async function patchMicrosoftMetadata(accessToken: string, handle: AssistantSessionCloudHandle, session: AssistantSession): Promise<AssistantSessionCloudHandle> {
  const response = await fetch(`${GRAPH_DRIVE_API}/items/${encodeURIComponent(handle.fileId)}`, {
    method: "PATCH",
    headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON, ...(handle.revision ? { "If-Match": handle.revision } : {}) },
    body: JSON.stringify({ description: microsoftDescription(session) }),
  });
  assertOk(response, "OneDrive chat metadata update");
  const body = await response.json() as { eTag?: string };
  return { fileId: handle.fileId, revision: responseRevision(response, body) ?? handle.revision };
}

async function findMicrosoftSessionByIdentity(accessToken: string, folderPath: string, session: AssistantSession): Promise<(AssistantSessionCloudHandle & { metadataMatches: boolean }) | undefined> {
  const response = await fetch(`${GRAPH_DRIVE_API}/root:/${folderPath}/${chatFileName(session)}?$select=id,name,eTag,description,file,folder`, { headers: authHeaders(accessToken) });
  if (response.status === 404) return undefined;
  assertOk(response, "OneDrive chat identity lookup");
  const item = await response.json() as { id?: string; name?: string; eTag?: string; description?: string; file?: unknown; folder?: unknown };
  if (!item.id || item.name !== chatFileName(session) || !item.file || item.folder) {
    throw new Error(`OneDrive chat ${session.id} has an invalid file identity.`);
  }
  return { fileId: item.id, revision: responseRevision(response, item), metadataMatches: microsoftMetadataMatches(item.description, session) };
}

async function repairMicrosoftSession(accessToken: string, session: AssistantSession, handle: AssistantSessionCloudHandle): Promise<AssistantSessionCloudHandle> {
  const state = await loadMicrosoftSessionState(accessToken, handle.fileId);
  const remote = state.session;
  if (!sameSession(remote, session)) throw new AssistantSessionConflictError(session.id, handle.fileId);
  if (microsoftMetadataMatches(state.description, session)) return { fileId: handle.fileId, revision: remote.revision };
  return patchMicrosoftMetadata(accessToken, { fileId: handle.fileId, revision: remote.revision }, session);
}

async function saveMicrosoftSession(accessToken: string, session: AssistantSession): Promise<AssistantSessionCloudHandle> {
  const folderPath = `${ONE_DRIVE_APP_FOLDER}/${CHATS_FOLDER}`;
  await ensureMicrosoftFolderPath(accessToken, folderPath);
  const body = serializeAssistantSession(session);
  let fileId = session.fileId;
  if (!fileId) {
    const existing = await findMicrosoftSessionByIdentity(accessToken, folderPath, session);
    if (existing) return existing.metadataMatches
      ? idempotentOrConflict("microsoft", accessToken, session, existing.fileId)
      : repairMicrosoftSession(accessToken, session, existing);
    const create = await fetch(`${GRAPH_DRIVE_API}/root:/${folderPath}/${chatFileName(session)}:/content`, {
      method: "PUT", headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON, "If-None-Match": "*" }, body,
    });
    if (create.status === 409 || create.status === 412) {
      const raced = await findMicrosoftSessionByIdentity(accessToken, folderPath, session);
      if (!raced) throw new AssistantCloudRequestError("OneDrive chat create conflict", create.status);
      return raced.metadataMatches
        ? idempotentOrConflict("microsoft", accessToken, session, raced.fileId)
        : repairMicrosoftSession(accessToken, session, raced);
    }
    assertOk(create, "OneDrive chat create");
    const created = await create.json() as { id: string; eTag?: string };
    return patchMicrosoftMetadata(accessToken, { fileId: created.id, revision: responseRevision(create, created) }, session);
  }
  if (!session.revision) return repairMicrosoftSession(accessToken, session, { fileId });
  const response = await fetch(`${GRAPH_DRIVE_API}/items/${encodeURIComponent(fileId)}/content`, {
    method: "PUT", headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON, "If-Match": session.revision }, body,
  });
  if (response.status === 409 || response.status === 412) return repairMicrosoftSession(accessToken, session, { fileId });
  assertOk(response, "OneDrive chat update");
  const updated = await response.json() as { id: string; eTag?: string };
  return patchMicrosoftMetadata(accessToken, { fileId: updated.id, revision: responseRevision(response, updated) }, session);
}

async function deleteMicrosoftSession(accessToken: string, fileId: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${GRAPH_DRIVE_API}/items/${encodeURIComponent(fileId)}`, { method: "DELETE", headers: authHeaders(accessToken), signal });
  if (!(response.ok || response.status === 404)) throw new Error(`OneDrive chat delete: ${response.status}`);
}
