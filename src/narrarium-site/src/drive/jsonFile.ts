import type { AuthProvider } from "@/store/authStore";

const GOOGLE_DRIVE_API = "https://www.googleapis.com/drive/v3";
const GOOGLE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const GRAPH_DRIVE_API = "https://graph.microsoft.com/v1.0/me/drive";
const APP_FOLDER = "Narrarium";
const ONE_DRIVE_APP_FOLDER = "Apps/Narrarium";
const MIME_JSON = "application/json";

function headers(token: string) {
  return { Authorization: `Bearer ${token}` };
}

export interface JsonHandle<T> {
  data: T | null;
  driveFileId?: string;
}

export async function loadAppJson<T>(provider: AuthProvider, token: string, fileName: string): Promise<JsonHandle<T>> {
  try {
    return provider === "microsoft" ? await loadMs<T>(token, fileName) : await loadGoogle<T>(token, fileName);
  } catch {
    return { data: null };
  }
}

export async function saveAppJson<T>(provider: AuthProvider, token: string, fileName: string, data: T, driveFileId?: string): Promise<JsonHandle<T>> {
  if (provider === "microsoft") {
    await saveMs(token, fileName, data);
    return { data };
  }
  const id = await saveGoogle(token, fileName, data, driveFileId);
  return { data, driveFileId: id };
}

async function ensureGoogleFolder(token: string): Promise<string> {
  const params = new URLSearchParams({ q: `name='${APP_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`, spaces: "drive", fields: "files(id)" });
  const found = await fetch(`${GOOGLE_DRIVE_API}/files?${params}`, { headers: headers(token) });
  if (found.ok) {
    const data = (await found.json()) as { files?: Array<{ id: string }> };
    if (data.files?.[0]?.id) return data.files[0].id;
  }
  const created = await fetch(`${GOOGLE_DRIVE_API}/files?fields=id`, {
    method: "POST",
    headers: { ...headers(token), "Content-Type": MIME_JSON },
    body: JSON.stringify({ name: APP_FOLDER, mimeType: "application/vnd.google-apps.folder" }),
  });
  return ((await created.json()) as { id: string }).id;
}

async function loadGoogle<T>(token: string, fileName: string): Promise<JsonHandle<T>> {
  const root = await ensureGoogleFolder(token);
  const params = new URLSearchParams({ q: `name='${fileName}' and '${root}' in parents and trashed=false`, spaces: "drive", fields: "files(id)" });
  const found = await fetch(`${GOOGLE_DRIVE_API}/files?${params}`, { headers: headers(token) });
  const data = (await found.json()) as { files?: Array<{ id: string }> };
  const id = data.files?.[0]?.id;
  if (!id) return { data: null };
  const content = await fetch(`${GOOGLE_DRIVE_API}/files/${id}?alt=media`, { headers: headers(token) });
  return { data: (await content.json()) as T, driveFileId: id };
}

async function saveGoogle<T>(token: string, fileName: string, data: T, id?: string): Promise<string> {
  const body = JSON.stringify(data, null, 2);
  if (id) {
    await fetch(`${GOOGLE_UPLOAD_API}/files/${id}?uploadType=media`, { method: "PATCH", headers: { ...headers(token), "Content-Type": MIME_JSON }, body });
    return id;
  }
  const root = await ensureGoogleFolder(token);
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({ name: fileName, parents: [root] })], { type: MIME_JSON }));
  form.append("file", new Blob([body], { type: MIME_JSON }));
  const create = await fetch(`${GOOGLE_UPLOAD_API}/files?uploadType=multipart&fields=id`, { method: "POST", headers: headers(token), body: form });
  return ((await create.json()) as { id: string }).id;
}

async function ensureMsFolder(token: string): Promise<void> {
  const parts = ONE_DRIVE_APP_FOLDER.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    const next = current ? `${current}/${part}` : part;
    const exists = await fetch(`${GRAPH_DRIVE_API}/root:/${next}`, { headers: headers(token) });
    if (exists.ok) { current = next; continue; }
    const url = current ? `${GRAPH_DRIVE_API}/root:/${current}:/children` : `${GRAPH_DRIVE_API}/root/children`;
    await fetch(url, { method: "POST", headers: { ...headers(token), "Content-Type": MIME_JSON }, body: JSON.stringify({ name: part, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }) });
    current = next;
  }
}

async function loadMs<T>(token: string, fileName: string): Promise<JsonHandle<T>> {
  await ensureMsFolder(token);
  const response = await fetch(`${GRAPH_DRIVE_API}/root:/${ONE_DRIVE_APP_FOLDER}/${fileName}:/content`, { headers: headers(token) });
  if (!response.ok) return { data: null };
  return { data: (await response.json()) as T };
}

async function saveMs<T>(token: string, fileName: string, data: T): Promise<void> {
  await ensureMsFolder(token);
  await fetch(`${GRAPH_DRIVE_API}/root:/${ONE_DRIVE_APP_FOLDER}/${fileName}:/content`, {
    method: "PUT",
    headers: { ...headers(token), "Content-Type": MIME_JSON },
    body: JSON.stringify(data, null, 2),
  });
}
