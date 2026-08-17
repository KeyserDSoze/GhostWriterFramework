import type { AuthProvider } from "@/store/authStore";
import type { CostsFile } from "@/costs/model";
import { emptyCostsFile } from "@/costs/model";
import { ensureGoogleAppFolder } from "@/drive/googleAppFolder";
import { beginCloudWrite, fencedCloudMutation } from "@/drive/cloudWriteBarrier";
import { assertCloudStatus } from "@/drive/migrationSafety";
import { ensureMicrosoftAppMarker, graphPath, ONE_DRIVE_APP_FOLDER } from "@/drive/microsoftAppFolder";

const GOOGLE_DRIVE_API = "https://www.googleapis.com/drive/v3";
const GOOGLE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const GRAPH_DRIVE_API = "https://graph.microsoft.com/v1.0/me/drive";
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
  const release = await beginCloudWrite(provider, accessToken);
  try { return await (provider === "microsoft" ? loadMicrosoftCosts(accessToken) : loadGoogleCosts(accessToken)); }
  finally { release(); }
}

function assertOk(response: Response, context: string, allow404 = false): void {
  if (allow404 && response.status === 404) return;
  assertCloudStatus(response.ok, response.status, context);
}

function parseCostsFile(value: unknown): CostsFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Costs source is malformed.");
  const file = value as Partial<CostsFile>;
  if (file.version !== 1 || file.currency !== "EUR" || typeof file.updatedAt !== "string" || !file.books || typeof file.books !== "object" || Array.isArray(file.books)) {
    throw new Error("Costs source is malformed.");
  }
  return file as CostsFile;
}

export async function saveCosts(provider: AuthProvider, accessToken: string, handle: CostsHandle): Promise<CostsHandle> {
  const endWrite = await beginCloudWrite(provider, accessToken);
  const file: CostsFile = { ...handle.file, updatedAt: new Date().toISOString() };
  try {
    if (provider === "microsoft") {
      await saveMicrosoftCosts(accessToken, file);
      return { file };
    }
    const driveFileId = await saveGoogleCosts(accessToken, file, handle.driveFileId);
    return { file, driveFileId };
  } finally {
    endWrite();
  }
}

// ─── Google Drive ─────────────────────────────────────────────────────────────

async function loadGoogleCosts(accessToken: string): Promise<CostsHandle> {
  const root = await ensureGoogleAppFolder(accessToken);
  const params = new URLSearchParams({ q: `name='${COSTS_FILE}' and '${root}' in parents and trashed=false`, spaces: "drive", fields: "files(id)" });
  const found = await fetch(`${GOOGLE_DRIVE_API}/files?${params}`, { headers: authHeaders(accessToken) });
  assertOk(found, "Google costs lookup");
  const data = (await found.json()) as { files?: Array<{ id: string }> };
  const fileId = data.files?.[0]?.id;
  if (!fileId) return { file: emptyCostsFile() };
  const content = await fetch(`${GOOGLE_DRIVE_API}/files/${fileId}?alt=media`, { headers: authHeaders(accessToken) });
  assertOk(content, "Google costs download");
  const file = parseCostsFile(await content.json());
  return { file: { ...emptyCostsFile(), ...file }, driveFileId: fileId };
}

async function saveGoogleCosts(accessToken: string, file: CostsFile, fileId?: string): Promise<string> {
  const body = JSON.stringify(file, null, 2);
  if (fileId) {
    const response = await fencedCloudMutation("google", accessToken, `${GOOGLE_UPLOAD_API}/files/${fileId}?uploadType=media`, {
      method: "PATCH",
      headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON },
      body,
    });
    assertOk(response, "Google costs update");
    return fileId;
  }
  const root = await ensureGoogleAppFolder(accessToken);
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({ name: COSTS_FILE, parents: [root] })], { type: MIME_JSON }));
  form.append("file", new Blob([body], { type: MIME_JSON }));
  const create = await fencedCloudMutation("google", accessToken, `${GOOGLE_UPLOAD_API}/files?uploadType=multipart&fields=id`, {
    method: "POST",
    headers: authHeaders(accessToken),
    body: form,
  });
  assertOk(create, "Google costs create");
  return ((await create.json()) as { id: string }).id;
}

// ─── OneDrive ─────────────────────────────────────────────────────────────────

async function ensureMicrosoftFolderPath(accessToken: string, folderPath: string): Promise<void> {
  const parts = folderPath.split("/").filter(Boolean);
  let currentPath = "";
  for (const part of parts) {
    const nextPath = currentPath ? `${currentPath}/${part}` : part;
    const exists = await fetch(`${GRAPH_DRIVE_API}/root:/${graphPath(nextPath)}`, { headers: authHeaders(accessToken) });
    if (exists.ok) { currentPath = nextPath; continue; }
    if (exists.status !== 404) throw new Error(`OneDrive costs folder lookup: ${exists.status}`);
    const createUrl = currentPath ? `${GRAPH_DRIVE_API}/root:/${graphPath(currentPath)}:/children` : `${GRAPH_DRIVE_API}/root/children`;
    const created = await fencedCloudMutation("microsoft", accessToken, createUrl, {
      method: "POST",
      headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON },
      body: JSON.stringify({ name: part, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
    });
    if (!(created.ok || created.status === 409)) throw new Error(`OneDrive costs folder create: ${created.status}`);
    currentPath = nextPath;
  }
  await ensureMicrosoftAppMarker(accessToken);
}

async function loadMicrosoftCosts(accessToken: string): Promise<CostsHandle> {
  await ensureMicrosoftFolderPath(accessToken, ONE_DRIVE_APP_FOLDER);
  const response = await fetch(`${GRAPH_DRIVE_API}/root:/${graphPath(ONE_DRIVE_APP_FOLDER)}/${encodeURIComponent(COSTS_FILE)}:/content`, { headers: authHeaders(accessToken) });
  if (response.status === 404) return { file: emptyCostsFile() };
  assertOk(response, "OneDrive costs download");
  const file = parseCostsFile(await response.json());
  return { file: { ...emptyCostsFile(), ...file } };
}

async function saveMicrosoftCosts(accessToken: string, file: CostsFile): Promise<void> {
  await ensureMicrosoftFolderPath(accessToken, ONE_DRIVE_APP_FOLDER);
  const response = await fencedCloudMutation("microsoft", accessToken, `${GRAPH_DRIVE_API}/root:/${graphPath(ONE_DRIVE_APP_FOLDER)}/${encodeURIComponent(COSTS_FILE)}:/content`, {
    method: "PUT",
    headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON },
    body: JSON.stringify(file, null, 2),
  });
  assertOk(response, "OneDrive costs save");
}
