import type { AuthProvider } from "@/store/authStore";
import type { AssistantSession, AssistantSessionMeta } from "@/assistant/store";

const GOOGLE_DRIVE_API = "https://www.googleapis.com/drive/v3";
const GOOGLE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const GRAPH_DRIVE_API = "https://graph.microsoft.com/v1.0/me/drive";
const APP_FOLDER = "Narrarium";
const ONE_DRIVE_APP_FOLDER = "Apps/Narrarium";
const CHATS_FOLDER = "chats";
const MIME_JSON = "application/json";

export async function listAssistantSessions(provider: AuthProvider, accessToken: string): Promise<AssistantSessionMeta[]> {
  return provider === "microsoft"
    ? listMicrosoftSessions(accessToken)
    : listGoogleSessions(accessToken);
}

export async function loadAssistantSession(provider: AuthProvider, accessToken: string, fileId: string): Promise<AssistantSession> {
  return provider === "microsoft"
    ? loadMicrosoftSession(accessToken, fileId)
    : loadGoogleSession(accessToken, fileId);
}

export async function saveAssistantSession(provider: AuthProvider, accessToken: string, session: AssistantSession): Promise<string> {
  return provider === "microsoft"
    ? saveMicrosoftSession(accessToken, session)
    : saveGoogleSession(accessToken, session);
}

export async function deleteAssistantSession(provider: AuthProvider, accessToken: string, fileId: string): Promise<void> {
  return provider === "microsoft"
    ? deleteMicrosoftSession(accessToken, fileId)
    : deleteGoogleSession(accessToken, fileId);
}

function authHeaders(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` };
}

function assertOk(response: Response, context: string): void {
  if (!response.ok) throw new Error(`${context}: ${response.status}`);
}

function chatFileName(session: AssistantSession): string {
  return `${session.id}.json`;
}

function normalizeSessionMeta(fileId: string, raw: Partial<AssistantSession>): AssistantSessionMeta {
  return {
    id: raw.id ?? fileId,
    fileId,
    title: raw.title ?? raw.contextTitle ?? "Untitled chat",
    contextTitle: raw.contextTitle ?? "Narrarium",
    updatedAt: raw.updatedAt ?? new Date().toISOString(),
  };
}

async function ensureGoogleFolder(accessToken: string, name: string, parentId?: string): Promise<string> {
  const query = parentId
    ? `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
    : `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const params = new URLSearchParams({ q: query, spaces: "drive", fields: "files(id,name)" });
  const found = await fetch(`${GOOGLE_DRIVE_API}/files?${params}`, { headers: authHeaders(accessToken) });
  assertOk(found, "Google folder lookup");
  const foundData = (await found.json()) as { files?: Array<{ id: string }> };
  if (foundData.files?.[0]?.id) return foundData.files[0].id;

  const created = await fetch(`${GOOGLE_DRIVE_API}/files?fields=id`, {
    method: "POST",
    headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
      ...(parentId ? { parents: [parentId] } : {}),
    }),
  });
  assertOk(created, "Google folder create");
  return ((await created.json()) as { id: string }).id;
}

async function listGoogleSessions(accessToken: string): Promise<AssistantSessionMeta[]> {
  const root = await ensureGoogleFolder(accessToken, APP_FOLDER);
  const chats = await ensureGoogleFolder(accessToken, CHATS_FOLDER, root);
  const params = new URLSearchParams({
    q: `'${chats}' in parents and trashed=false`,
    spaces: "drive",
    fields: "files(id,modifiedTime)",
  });
  const response = await fetch(`${GOOGLE_DRIVE_API}/files?${params}`, { headers: authHeaders(accessToken) });
  assertOk(response, "Google chats list");
  const data = (await response.json()) as { files?: Array<{ id: string; modifiedTime?: string }> };
  const metas = await Promise.all((data.files ?? []).map(async (file) => {
    try {
      const session = await loadGoogleSession(accessToken, file.id);
      return normalizeSessionMeta(file.id, { ...session, updatedAt: session.updatedAt ?? file.modifiedTime });
    } catch {
      return normalizeSessionMeta(file.id, { updatedAt: file.modifiedTime, title: file.id });
    }
  }));
  return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function loadGoogleSession(accessToken: string, fileId: string): Promise<AssistantSession> {
  const response = await fetch(`${GOOGLE_DRIVE_API}/files/${fileId}?alt=media`, { headers: authHeaders(accessToken) });
  assertOk(response, "Google chat download");
  const session = (await response.json()) as AssistantSession;
  return { ...session, fileId };
}

async function saveGoogleSession(accessToken: string, session: AssistantSession): Promise<string> {
  const root = await ensureGoogleFolder(accessToken, APP_FOLDER);
  const chats = await ensureGoogleFolder(accessToken, CHATS_FOLDER, root);
  const body = JSON.stringify(session, null, 2);

  if (session.fileId) {
    const update = await fetch(`${GOOGLE_UPLOAD_API}/files/${session.fileId}?uploadType=media`, {
      method: "PATCH",
      headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON },
      body,
    });
    assertOk(update, "Google chat update");
    return session.fileId;
  }

  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({ name: chatFileName(session), parents: [chats] })], { type: MIME_JSON }));
  form.append("file", new Blob([body], { type: MIME_JSON }));
  const create = await fetch(`${GOOGLE_UPLOAD_API}/files?uploadType=multipart&fields=id`, {
    method: "POST",
    headers: authHeaders(accessToken),
    body: form,
  });
  assertOk(create, "Google chat create");
  return ((await create.json()) as { id: string }).id;
}

async function deleteGoogleSession(accessToken: string, fileId: string): Promise<void> {
  const response = await fetch(`${GOOGLE_DRIVE_API}/files/${fileId}`, { method: "DELETE", headers: authHeaders(accessToken) });
  if (!(response.ok || response.status === 404)) throw new Error(`Google chat delete: ${response.status}`);
}

async function ensureMicrosoftFolderPath(accessToken: string, folderPath: string): Promise<void> {
  const parts = folderPath.split("/").filter(Boolean);
  let currentPath = "";
  for (const part of parts) {
    const nextPath = currentPath ? `${currentPath}/${part}` : part;
    const exists = await fetch(`${GRAPH_DRIVE_API}/root:/${nextPath}`, { headers: authHeaders(accessToken) });
    if (exists.ok) {
      currentPath = nextPath;
      continue;
    }
    if (exists.status !== 404) throw new Error(`OneDrive folder lookup: ${exists.status}`);
    const createUrl = currentPath ? `${GRAPH_DRIVE_API}/root:/${currentPath}:/children` : `${GRAPH_DRIVE_API}/root/children`;
    const created = await fetch(createUrl, {
      method: "POST",
      headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON },
      body: JSON.stringify({ name: part, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
    });
    if (!(created.ok || created.status === 409)) throw new Error(`OneDrive folder create: ${created.status}`);
    currentPath = nextPath;
  }
}

async function listMicrosoftSessions(accessToken: string): Promise<AssistantSessionMeta[]> {
  const folderPath = `${ONE_DRIVE_APP_FOLDER}/${CHATS_FOLDER}`;
  await ensureMicrosoftFolderPath(accessToken, folderPath);
  const response = await fetch(`${GRAPH_DRIVE_API}/root:/${folderPath}:/children`, { headers: authHeaders(accessToken) });
  assertOk(response, "OneDrive chats list");
  const data = (await response.json()) as { value?: Array<{ id: string; lastModifiedDateTime?: string }> };
  const metas = await Promise.all((data.value ?? []).map(async (entry) => {
    try {
      const session = await loadMicrosoftSession(accessToken, entry.id);
      return normalizeSessionMeta(entry.id, { ...session, updatedAt: session.updatedAt ?? entry.lastModifiedDateTime });
    } catch {
      return normalizeSessionMeta(entry.id, { updatedAt: entry.lastModifiedDateTime, title: entry.id });
    }
  }));
  return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function loadMicrosoftSession(accessToken: string, fileId: string): Promise<AssistantSession> {
  const response = await fetch(`${GRAPH_DRIVE_API}/items/${fileId}/content`, { headers: authHeaders(accessToken) });
  assertOk(response, "OneDrive chat download");
  const session = (await response.json()) as AssistantSession;
  return { ...session, fileId };
}

async function saveMicrosoftSession(accessToken: string, session: AssistantSession): Promise<string> {
  const folderPath = `${ONE_DRIVE_APP_FOLDER}/${CHATS_FOLDER}`;
  await ensureMicrosoftFolderPath(accessToken, folderPath);
  const response = await fetch(`${GRAPH_DRIVE_API}/root:/${folderPath}/${chatFileName(session)}:/content`, {
    method: "PUT",
    headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON },
    body: JSON.stringify(session, null, 2),
  });
  assertOk(response, "OneDrive chat save");
  return ((await response.json()) as { id: string }).id;
}

async function deleteMicrosoftSession(accessToken: string, fileId: string): Promise<void> {
  const response = await fetch(`${GRAPH_DRIVE_API}/items/${fileId}`, { method: "DELETE", headers: authHeaders(accessToken) });
  if (!(response.ok || response.status === 404)) throw new Error(`OneDrive chat delete: ${response.status}`);
}
