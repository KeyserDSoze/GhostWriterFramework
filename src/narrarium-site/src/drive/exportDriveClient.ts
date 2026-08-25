import type { AuthProvider } from "@/store/authStore";
import { useAuthStore } from "@/store/authStore";
import { graphPath } from "@/drive/microsoftAppFolder";
import { acquireCloudWriteLease, fencedCloudMutation } from "@/drive/cloudWriteBarrier";

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

export interface GoogleExportAllocation {
  allocationId: string;
  createdAt: string;
  fileName: string;
}

interface GoogleExportEntry { id: string; name: string; appProperties?: Record<string, string> }

/** Provider-neutral collision policy: keep the extension and append ` (n)` starting at 1. */
export function nextAvailableDriveFileName(fileName: string, existingNames: Iterable<string>): string {
  const existing = new Set([...existingNames].map((name) => name.toLocaleLowerCase()));
  if (!existing.has(fileName.toLocaleLowerCase())) return fileName;
  const dot = fileName.lastIndexOf(".");
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const extension = dot > 0 ? fileName.slice(dot) : "";
  for (let index = 1; ; index += 1) {
    const candidate = `${base} (${index})${extension}`;
    if (!existing.has(candidate.toLocaleLowerCase())) return candidate;
  }
}

export function uniqueGoogleExportName(fileName: string, allocationId: string): string {
  const dot = fileName.lastIndexOf(".");
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const extension = dot > 0 ? fileName.slice(dot) : "";
  return `${base} (narrarium-${allocationId})${extension}`;
}

async function listAllGoogleExportEntries(accessToken: string, folderId: string): Promise<GoogleExportEntry[]> {
  const entries: GoogleExportEntry[] = [];
  let pageToken: string | undefined;
  do {
    const query = new URLSearchParams({ q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed=false`, spaces: "drive", fields: "files(id,name,appProperties),nextPageToken", pageSize: "1000", ...(pageToken ? { pageToken } : {}) });
    const response = await fetch(`${GOOGLE_DRIVE_API}/files?${query}`, { headers: authHeaders(accessToken) });
    assertOk(response, "Google Drive export reconciliation", "google", accessToken);
    const page = await response.json() as { files?: GoogleExportEntry[]; nextPageToken?: string };
    entries.push(...(page.files ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return entries;
}

function authHeaders(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` };
}

function assertOk(response: Response, context: string, provider?: AuthProvider, token?: string): void {
  if (response.status === 401) {
    const current = useAuthStore.getState();
    if (provider && token && current.user?.provider === provider && current.accessToken === token) current.invalidateToken();
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
  assertOk(response, "Google Drive folder list", "google", accessToken);
  const data = (await response.json()) as { files?: Array<{ id: string; name: string }> };
  return (data.files ?? []).map((entry) => ({ id: entry.id, name: entry.name }));
}

export async function listMicrosoftDriveFolders(accessToken: string, folderPath = ""): Promise<DriveFolderEntry[]> {
  const normalized = folderPath.split("/").filter(Boolean).join("/");
  const endpoint = normalized ? `${GRAPH_DRIVE_API}/root:/${graphPath(normalized)}:/children` : `${GRAPH_DRIVE_API}/root/children`;
  const response = await fetch(endpoint, {
    headers: authHeaders(accessToken),
  });
  assertOk(response, "OneDrive folder list", "microsoft", accessToken);
  const data = (await response.json()) as { value?: Array<{ id: string; name: string; folder?: Record<string, unknown> }> };
  return (data.value ?? [])
    .filter((entry) => Boolean(entry.folder))
    .map((entry) => ({ id: entry.id, name: entry.name }));
}

/** Create a new subfolder inside a Google Drive folder. Returns the created folder. */
export async function createGoogleDriveFolder(accessToken: string, parentId: string, name: string): Promise<DriveFolderEntry> {
  const release = await acquireCloudWriteLease("google", accessToken);
  try {
  const response = await fencedCloudMutation("google", accessToken, `${GOOGLE_DRIVE_API}/files?fields=id,name`, {
    method: "POST",
    headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON },
    body: JSON.stringify({
      name: name.trim(),
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId || "root"],
    }),
  });
  assertOk(response, "Google Drive folder create", "google", accessToken);
  const data = (await response.json()) as { id: string; name: string };
  return { id: data.id, name: data.name };
  } finally { await release(); }
}

/** Create a new subfolder inside a OneDrive folder path. Returns the new folder path. */
export async function createMicrosoftDriveFolder(accessToken: string, parentPath: string, name: string): Promise<string> {
  const release = await acquireCloudWriteLease("microsoft", accessToken);
  try {
  const normalized = parentPath.split("/").filter(Boolean).join("/");
  const endpoint = normalized ? `${GRAPH_DRIVE_API}/root:/${graphPath(normalized)}:/children` : `${GRAPH_DRIVE_API}/root/children`;
  const response = await fencedCloudMutation("microsoft", accessToken, endpoint, {
    method: "POST",
    headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON },
    body: JSON.stringify({ name: name.trim(), folder: {}, "@microsoft.graph.conflictBehavior": "rename" }),
  });
  assertOk(response, "OneDrive folder create", "microsoft", accessToken);
  const data = (await response.json()) as { name: string };
  return normalized ? `${normalized}/${data.name}` : data.name;
  } finally { await release(); }
}

export async function uploadGoogleDriveFile(
  accessToken: string,
  folderId: string,
  fileName: string,
  _mimeType: string,
  blob: Blob,
): Promise<UploadedDriveFile> {
  const release = await acquireCloudWriteLease("google", accessToken);
  try {
  // Listing is paginated for diagnostics/logical-name discovery only. Provider filenames remain immutable and unique.
  await listAllGoogleExportEntries(accessToken, folderId);
  const allocationId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const temporaryName = `.narrarium-export-${allocationId}.tmp`;
  const form = new FormData();
  form.append(
    "metadata",
    new Blob([JSON.stringify({ name: temporaryName, parents: [folderId], appProperties: { narrariumExportName: fileName, narrariumExportAllocation: allocationId, narrariumExportCreatedAt: createdAt } })], { type: MIME_JSON }),
  );
  form.append("file", blob, temporaryName);

  const response = await fencedCloudMutation("google", accessToken, `${GOOGLE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,webViewLink`, {
    method: "POST",
    headers: authHeaders(accessToken),
    body: form,
  });
  assertOk(response, "Google Drive export upload", "google", accessToken);
  const created = (await response.json()) as UploadedDriveFile;
  const resolvedName = uniqueGoogleExportName(fileName, created.id);
  const renamed = await fencedCloudMutation("google", accessToken, `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(created.id)}?fields=id,name,webViewLink`, {
    method: "PATCH",
    headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON },
    body: JSON.stringify({ name: resolvedName, appProperties: { narrariumExportName: fileName, narrariumExportAllocation: allocationId, narrariumExportCreatedAt: createdAt, narrariumExportFinal: "v1" } }),
  });
  assertOk(renamed, "Google Drive export allocation rename", "google", accessToken);
  const result = (await renamed.json()) as UploadedDriveFile;
  return result;
  } finally { await release(); }
}

async function ensureMicrosoftFolderPath(accessToken: string, folderPath: string): Promise<void> {
  const parts = folderPath.split("/").filter(Boolean);
  let currentPath = "";
  for (const part of parts) {
    const nextPath = currentPath ? `${currentPath}/${part}` : part;
    const exists = await fetch(`${GRAPH_DRIVE_API}/root:/${graphPath(nextPath)}`, {
      headers: authHeaders(accessToken),
    });
    if (exists.status === 401) {
      const current = useAuthStore.getState();
      if (current.user?.provider === "microsoft" && current.accessToken === accessToken) current.invalidateToken();
      throw new Error("Cloud access token expired");
    }
    if (exists.ok) {
      currentPath = nextPath;
      continue;
    }
    if (exists.status !== 404) throw new Error(`OneDrive folder lookup: ${exists.status}`);
    const createUrl = currentPath ? `${GRAPH_DRIVE_API}/root:/${graphPath(currentPath)}:/children` : `${GRAPH_DRIVE_API}/root/children`;
    const created = await fencedCloudMutation("microsoft", accessToken, createUrl, {
      method: "POST",
      headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON },
      body: JSON.stringify({ name: part, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
    });
    if (created.status !== 409) assertOk(created, "OneDrive folder create", "microsoft", accessToken);
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
  const release = await acquireCloudWriteLease("microsoft", accessToken);
  try {
  await ensureMicrosoftFolderPath(accessToken, folderPath);
  const arrayBuffer = await blob.arrayBuffer();
  const response = await fencedCloudMutation("microsoft", accessToken, `${GRAPH_DRIVE_API}/root:/${graphPath(folderPath)}/${encodeURIComponent(fileName)}:/content?@microsoft.graph.conflictBehavior=rename`, {
    method: "PUT",
    headers: { ...authHeaders(accessToken), "Content-Type": mimeType },
    body: arrayBuffer,
  });
  assertOk(response, "OneDrive export upload", "microsoft", accessToken);
  const data = (await response.json()) as { id: string; name: string; webUrl?: string };
  return { id: data.id, name: data.name, webViewLink: data.webUrl };
  } finally { await release(); }
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
