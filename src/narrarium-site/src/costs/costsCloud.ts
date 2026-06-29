import type { AuthProvider } from "@/store/authStore";
import type { CostsFile } from "@/costs/model";
import { emptyCostsFile } from "@/costs/model";

const GOOGLE_DRIVE_API = "https://www.googleapis.com/drive/v3";
const GOOGLE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const GRAPH_DRIVE_API = "https://graph.microsoft.com/v1.0/me/drive";
const APP_FOLDER = "Narrarium";
const ONE_DRIVE_APP_FOLDER = "Apps/Narrarium";
const COSTS_FILE = "costs.json";
const MIME_JSON = "application/json";

function authHeaders(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` };
}

export interface CostsHandle {
  file: CostsFile;
  driveFileId?: string;
}

export async function loadCosts(provider: AuthProvider, accessToken: string): Promise<CostsHandle> {
  try {
    return provider === "microsoft" ? await loadMicrosoftCosts(accessToken) : await loadGoogleCosts(accessToken);
  } catch {
    return { file: emptyCostsFile() };
  }
}

export async function saveCosts(provider: AuthProvider, accessToken: string, handle: CostsHandle): Promise<CostsHandle> {
  const file: CostsFile = { ...handle.file, updatedAt: new Date().toISOString() };
  if (provider === "microsoft") {
    await saveMicrosoftCosts(accessToken, file);
    return { file };
  }
  const driveFileId = await saveGoogleCosts(accessToken, file, handle.driveFileId);
  return { file, driveFileId };
}

// ─── Google Drive ─────────────────────────────────────────────────────────────

async function ensureGoogleFolder(accessToken: string, name: string): Promise<string> {
  const params = new URLSearchParams({
    q: `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    spaces: "drive",
    fields: "files(id)",
  });
  const found = await fetch(`${GOOGLE_DRIVE_API}/files?${params}`, { headers: authHeaders(accessToken) });
  if (found.ok) {
    const data = (await found.json()) as { files?: Array<{ id: string }> };
    if (data.files?.[0]?.id) return data.files[0].id;
  }
  const created = await fetch(`${GOOGLE_DRIVE_API}/files?fields=id`, {
    method: "POST",
    headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder" }),
  });
  return ((await created.json()) as { id: string }).id;
}

async function loadGoogleCosts(accessToken: string): Promise<CostsHandle> {
  const root = await ensureGoogleFolder(accessToken, APP_FOLDER);
  const params = new URLSearchParams({ q: `name='${COSTS_FILE}' and '${root}' in parents and trashed=false`, spaces: "drive", fields: "files(id)" });
  const found = await fetch(`${GOOGLE_DRIVE_API}/files?${params}`, { headers: authHeaders(accessToken) });
  const data = (await found.json()) as { files?: Array<{ id: string }> };
  const fileId = data.files?.[0]?.id;
  if (!fileId) return { file: emptyCostsFile() };
  const content = await fetch(`${GOOGLE_DRIVE_API}/files/${fileId}?alt=media`, { headers: authHeaders(accessToken) });
  const file = (await content.json()) as CostsFile;
  return { file: { ...emptyCostsFile(), ...file }, driveFileId: fileId };
}

async function saveGoogleCosts(accessToken: string, file: CostsFile, fileId?: string): Promise<string> {
  const body = JSON.stringify(file, null, 2);
  if (fileId) {
    await fetch(`${GOOGLE_UPLOAD_API}/files/${fileId}?uploadType=media`, {
      method: "PATCH",
      headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON },
      body,
    });
    return fileId;
  }
  const root = await ensureGoogleFolder(accessToken, APP_FOLDER);
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({ name: COSTS_FILE, parents: [root] })], { type: MIME_JSON }));
  form.append("file", new Blob([body], { type: MIME_JSON }));
  const create = await fetch(`${GOOGLE_UPLOAD_API}/files?uploadType=multipart&fields=id`, {
    method: "POST",
    headers: authHeaders(accessToken),
    body: form,
  });
  return ((await create.json()) as { id: string }).id;
}

// ─── OneDrive ─────────────────────────────────────────────────────────────────

async function ensureMicrosoftFolderPath(accessToken: string, folderPath: string): Promise<void> {
  const parts = folderPath.split("/").filter(Boolean);
  let currentPath = "";
  for (const part of parts) {
    const nextPath = currentPath ? `${currentPath}/${part}` : part;
    const exists = await fetch(`${GRAPH_DRIVE_API}/root:/${nextPath}`, { headers: authHeaders(accessToken) });
    if (exists.ok) { currentPath = nextPath; continue; }
    const createUrl = currentPath ? `${GRAPH_DRIVE_API}/root:/${currentPath}:/children` : `${GRAPH_DRIVE_API}/root/children`;
    await fetch(createUrl, {
      method: "POST",
      headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON },
      body: JSON.stringify({ name: part, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
    });
    currentPath = nextPath;
  }
}

async function loadMicrosoftCosts(accessToken: string): Promise<CostsHandle> {
  await ensureMicrosoftFolderPath(accessToken, ONE_DRIVE_APP_FOLDER);
  const response = await fetch(`${GRAPH_DRIVE_API}/root:/${ONE_DRIVE_APP_FOLDER}/${COSTS_FILE}:/content`, { headers: authHeaders(accessToken) });
  if (!response.ok) return { file: emptyCostsFile() };
  const file = (await response.json()) as CostsFile;
  return { file: { ...emptyCostsFile(), ...file } };
}

async function saveMicrosoftCosts(accessToken: string, file: CostsFile): Promise<void> {
  await ensureMicrosoftFolderPath(accessToken, ONE_DRIVE_APP_FOLDER);
  await fetch(`${GRAPH_DRIVE_API}/root:/${ONE_DRIVE_APP_FOLDER}/${COSTS_FILE}:/content`, {
    method: "PUT",
    headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON },
    body: JSON.stringify(file, null, 2),
  });
}
