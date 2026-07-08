import type { AuthProvider } from "@/store/authStore";
import { useAuthStore } from "@/store/authStore";

const GOOGLE_DRIVE_API = "https://www.googleapis.com/drive/v3";
const GOOGLE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const GRAPH_DRIVE_API = "https://graph.microsoft.com/v1.0/me/drive";
const MIME_JSON = "application/json";

export interface DriveFolderEntry {
  id: string;
  name: string;
}

export interface UploadedDriveFile {
  id: string;
  name: string;
  webViewLink?: string;
}

function authHeaders(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` };
}

function assertOk(response: Response, context: string): void {
  if (response.status === 401) {
    useAuthStore.getState().invalidateToken();
    throw new Error("Cloud access token expired");
  }
  if (!response.ok) throw new Error(`${context}: ${response.status}`);
}

export async function listGoogleDriveFolders(accessToken: string, parentId = "root"): Promise<DriveFolderEntry[]> {
  const query = new URLSearchParams({
    q: `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    spaces: "drive",
    fields: "files(id,name)",
    orderBy: "name_natural",
    pageSize: "200",
  });
  const response = await fetch(`${GOOGLE_DRIVE_API}/files?${query}`, {
    headers: authHeaders(accessToken),
  });
  assertOk(response, "Google Drive folder list");
  const data = (await response.json()) as { files?: Array<{ id: string; name: string }> };
  return (data.files ?? []).map((entry) => ({ id: entry.id, name: entry.name }));
}

export async function listMicrosoftDriveFolders(accessToken: string, folderPath = ""): Promise<DriveFolderEntry[]> {
  const normalized = folderPath.split("/").filter(Boolean).join("/");
  const endpoint = normalized ? `${GRAPH_DRIVE_API}/root:/${normalized}:/children` : `${GRAPH_DRIVE_API}/root/children`;
  const response = await fetch(endpoint, {
    headers: authHeaders(accessToken),
  });
  assertOk(response, "OneDrive folder list");
  const data = (await response.json()) as { value?: Array<{ id: string; name: string; folder?: Record<string, unknown> }> };
  return (data.value ?? [])
    .filter((entry) => Boolean(entry.folder))
    .map((entry) => ({ id: entry.id, name: entry.name }));
}

/** Create a new subfolder inside a Google Drive folder. Returns the created folder. */
export async function createGoogleDriveFolder(accessToken: string, parentId: string, name: string): Promise<DriveFolderEntry> {
  const response = await fetch(`${GOOGLE_DRIVE_API}/files?fields=id,name`, {
    method: "POST",
    headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON },
    body: JSON.stringify({
      name: name.trim(),
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId || "root"],
    }),
  });
  assertOk(response, "Google Drive folder create");
  const data = (await response.json()) as { id: string; name: string };
  return { id: data.id, name: data.name };
}

/** Create a new subfolder inside a OneDrive folder path. Returns the new folder path. */
export async function createMicrosoftDriveFolder(accessToken: string, parentPath: string, name: string): Promise<string> {
  const normalized = parentPath.split("/").filter(Boolean).join("/");
  const endpoint = normalized ? `${GRAPH_DRIVE_API}/root:/${normalized}:/children` : `${GRAPH_DRIVE_API}/root/children`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON },
    body: JSON.stringify({ name: name.trim(), folder: {}, "@microsoft.graph.conflictBehavior": "rename" }),
  });
  assertOk(response, "OneDrive folder create");
  const data = (await response.json()) as { name: string };
  return normalized ? `${normalized}/${data.name}` : data.name;
}

export async function uploadGoogleDriveFile(
  accessToken: string,
  folderId: string,
  fileName: string,
  _mimeType: string,
  blob: Blob,
): Promise<UploadedDriveFile> {
  const form = new FormData();
  form.append(
    "metadata",
    new Blob([JSON.stringify({ name: fileName, parents: [folderId] })], { type: MIME_JSON }),
  );
  form.append("file", blob, fileName);

  const response = await fetch(`${GOOGLE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,webViewLink`, {
    method: "POST",
    headers: authHeaders(accessToken),
    body: form,
  });
  assertOk(response, "Google Drive export upload");
  return (await response.json()) as UploadedDriveFile;
}

async function ensureMicrosoftFolderPath(accessToken: string, folderPath: string): Promise<void> {
  const parts = folderPath.split("/").filter(Boolean);
  let currentPath = "";
  for (const part of parts) {
    const nextPath = currentPath ? `${currentPath}/${part}` : part;
    const exists = await fetch(`${GRAPH_DRIVE_API}/root:/${nextPath}`, {
      headers: authHeaders(accessToken),
    });
    if (exists.status === 401) {
      useAuthStore.getState().invalidateToken();
      throw new Error("Cloud access token expired");
    }
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
    if (created.status !== 409) assertOk(created, "OneDrive folder create");
    currentPath = nextPath;
  }
}

export async function uploadMicrosoftDriveFile(
  accessToken: string,
  folderPath: string,
  fileName: string,
  mimeType: string,
  blob: Blob,
): Promise<UploadedDriveFile> {
  await ensureMicrosoftFolderPath(accessToken, folderPath);
  const arrayBuffer = await blob.arrayBuffer();
  const response = await fetch(`${GRAPH_DRIVE_API}/root:/${folderPath}/${fileName}:/content`, {
    method: "PUT",
    headers: { ...authHeaders(accessToken), "Content-Type": mimeType },
    body: arrayBuffer,
  });
  assertOk(response, "OneDrive export upload");
  const data = (await response.json()) as { id: string; name: string; webUrl?: string };
  return { id: data.id, name: data.name, webViewLink: data.webUrl };
}

export async function uploadDriveFile(
  provider: AuthProvider,
  accessToken: string,
  options: {
    googleFolderId?: string;
    microsoftFolderPath?: string;
    fileName: string;
    mimeType: string;
    blob: Blob;
  },
): Promise<UploadedDriveFile> {
  if (provider === "microsoft") {
    if (!options.microsoftFolderPath?.trim()) throw new Error("Choose a OneDrive folder path first.");
    return uploadMicrosoftDriveFile(accessToken, options.microsoftFolderPath.trim(), options.fileName, options.mimeType, options.blob);
  }
  if (!options.googleFolderId?.trim()) throw new Error("Choose a Google Drive folder first.");
  return uploadGoogleDriveFile(accessToken, options.googleFolderId.trim(), options.fileName, options.mimeType, options.blob);
}
