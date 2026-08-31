import type { AuthProvider } from "@/store/authStore";
import { ensureGoogleAppFolder } from "@/drive/googleAppFolder";
import { beginCloudWrite, fencedCloudMutation } from "@/drive/cloudWriteBarrier";
import { assertCloudStatus } from "@/drive/migrationSafety";
import { ensureMicrosoftAppMarker, graphPath, ONE_DRIVE_APP_FOLDER } from "@/drive/microsoftAppFolder";

const GOOGLE_DRIVE_API = "https://www.googleapis.com/drive/v3";
const GOOGLE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const GRAPH_DRIVE_API = "https://graph.microsoft.com/v1.0/me/drive";
const MIME_JSON = "application/json";

function headers(token: string) {
  return { Authorization: `Bearer ${token}` };
}

export interface JsonHandle<T> {
  data: T | null;
  driveFileId?: string;
  revision?: string;
}

export async function loadAppJson<T>(provider: AuthProvider, token: string, fileName: string): Promise<JsonHandle<T>> {
  const release = await beginCloudWrite(provider, token);
  try { return await (provider === "microsoft" ? loadMs<T>(token, fileName) : loadGoogle<T>(token, fileName)); }
  finally { await release(); }
}

function assertOk(response: Response, context: string): void {
  assertCloudStatus(response.ok, response.status, context);
}

export async function saveAppJson<T>(provider: AuthProvider, token: string, fileName: string, data: T, driveFileId?: string, expectedRevision?: string): Promise<JsonHandle<T>> {
  const endWrite = await beginCloudWrite(provider, token);
  try {
    if (provider === "microsoft") {
      const saved = await saveMs(token, fileName, data, expectedRevision);
      return { data, ...saved };
    }
    const saved = await saveGoogle(token, fileName, data, driveFileId, expectedRevision);
    return { data, driveFileId: saved.id, revision: saved.revision };
  } finally {
    await endWrite();
  }
}

export async function deleteAppJson(provider: AuthProvider, token: string, fileName: string): Promise<boolean> {
  if (provider === "microsoft") {
      const current = await loadAppJson<unknown>(provider, token, fileName);
      if (!current.data) return false;
      const endWrite = await beginCloudWrite(provider, token);
      try {
      const response = await fencedCloudMutation("microsoft", token, `${GRAPH_DRIVE_API}/root:/${graphPath(ONE_DRIVE_APP_FOLDER)}/${encodeURIComponent(fileName)}`, { method: "DELETE", headers: headers(token) });
      if (!(response.ok || response.status === 404)) assertOk(response, `OneDrive ${fileName} delete`);
      return response.ok;
      } finally { await endWrite(); }
  }
    const current = await loadAppJson<unknown>(provider, token, fileName);
    if (!current.driveFileId) return false;
    const endWrite = await beginCloudWrite(provider, token);
    try {
    const response = await fencedCloudMutation("google", token, `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(current.driveFileId)}`, { method: "DELETE", headers: headers(token) });
    if (!(response.ok || response.status === 404)) assertOk(response, `Google ${fileName} delete`);
    return response.ok;
    } finally { await endWrite(); }
}

async function loadGoogle<T>(token: string, fileName: string): Promise<JsonHandle<T>> {
  const root = await ensureGoogleAppFolder(token);
  const params = new URLSearchParams({ q: `name='${fileName}' and '${root}' in parents and trashed=false`, spaces: "drive", fields: "files(id,version)" });
  const found = await fetch(`${GOOGLE_DRIVE_API}/files?${params}`, { headers: headers(token) });
  assertOk(found, `Google ${fileName} lookup`);
  const data = (await found.json()) as { files?: Array<{ id: string; version?: string }> };
  if ((data.files?.length ?? 0) > 1) throw new Error(`Google ${fileName} has divergent duplicate files and requires reconciliation.`);
  const selected = data.files?.[0];
  const id = selected?.id;
  if (!id) return { data: null };
  const metadata = await fetch(`${GOOGLE_DRIVE_API}/files/${encodeURIComponent(id)}?fields=id,version`, { headers: headers(token) });
  assertOk(metadata, `Google ${fileName} revision`);
  const revision = metadata.headers.get("etag") ?? undefined;
  const content = await fetch(`${GOOGLE_DRIVE_API}/files/${id}?alt=media`, { headers: headers(token) });
  assertOk(content, `Google ${fileName} download`);
  return { data: (await content.json()) as T, driveFileId: id, revision };
}

async function saveGoogle<T>(token: string, fileName: string, data: T, id?: string, expectedRevision?: string): Promise<{ id: string; revision?: string }> {
  const body = JSON.stringify(data, null, 2);
  if (id) {
    if (expectedRevision) {
      const metadata = await fetch(`${GOOGLE_DRIVE_API}/files/${encodeURIComponent(id)}?fields=id,version`, { headers: headers(token) });
      assertOk(metadata, `Google ${fileName} revision`);
      const value = await metadata.json() as { id?: string };
      if (!value.id || metadata.headers.get("etag") !== expectedRevision) throw new Error(`Google ${fileName} changed before it could be updated.`);
    }
    const response = await fencedCloudMutation("google", token, `${GOOGLE_UPLOAD_API}/files/${id}?uploadType=media`, { method: "PATCH", headers: { ...headers(token), "Content-Type": MIME_JSON, ...(expectedRevision ? { "If-Match": expectedRevision } : {}) }, body });
    if (response.status === 409 || response.status === 412) throw new Error(`Google ${fileName} changed before it could be updated.`);
    assertOk(response, `Google ${fileName} update`);
    const metadata = await fetch(`${GOOGLE_DRIVE_API}/files/${encodeURIComponent(id)}?fields=id,version`, { headers: headers(token) });
    assertOk(metadata, `Google ${fileName} revision`);
    await metadata.json();
    return { id, revision: metadata.headers.get("etag") ?? undefined };
  }
  if (expectedRevision) throw new Error(`Google ${fileName} was deleted before it could be updated.`);
  const root = await ensureGoogleAppFolder(token);
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({ name: fileName, parents: [root] })], { type: MIME_JSON }));
  form.append("file", new Blob([body], { type: MIME_JSON }));
  const create = await fencedCloudMutation("google", token, `${GOOGLE_UPLOAD_API}/files?uploadType=multipart&fields=id`, { method: "POST", headers: headers(token), body: form });
  assertOk(create, `Google ${fileName} create`);
  const createdId = ((await create.json()) as { id: string }).id;
  const metadata = await fetch(`${GOOGLE_DRIVE_API}/files/${encodeURIComponent(createdId)}?fields=id,version`, { headers: headers(token) });
  assertOk(metadata, `Google ${fileName} revision`);
  await metadata.json();
  return { id: createdId, revision: metadata.headers.get("etag") ?? undefined };
}

async function ensureMsFolder(token: string): Promise<void> {
  const parts = ONE_DRIVE_APP_FOLDER.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    const next = current ? `${current}/${part}` : part;
    const exists = await fetch(`${GRAPH_DRIVE_API}/root:/${graphPath(next)}`, { headers: headers(token) });
    if (exists.ok) { current = next; continue; }
    if (exists.status !== 404) throw new Error(`OneDrive folder lookup: ${exists.status}`);
    const url = current ? `${GRAPH_DRIVE_API}/root:/${graphPath(current)}:/children` : `${GRAPH_DRIVE_API}/root/children`;
    const created = await fencedCloudMutation("microsoft", token, url, { method: "POST", headers: { ...headers(token), "Content-Type": MIME_JSON }, body: JSON.stringify({ name: part, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }) });
    if (!(created.ok || created.status === 409)) throw new Error(`OneDrive folder create: ${created.status}`);
    current = next;
  }
  await ensureMicrosoftAppMarker(token);
}

async function loadMs<T>(token: string, fileName: string): Promise<JsonHandle<T>> {
  await ensureMsFolder(token);
  const itemUrl = `${GRAPH_DRIVE_API}/root:/${graphPath(ONE_DRIVE_APP_FOLDER)}/${encodeURIComponent(fileName)}`;
  const metadata = await fetch(itemUrl, { headers: headers(token) });
  if (metadata.status === 404) return { data: null };
  assertOk(metadata, `OneDrive ${fileName} metadata`);
  const item = await metadata.json() as { id?: string; eTag?: string; "@odata.etag"?: string };
  if (!item.id) throw new Error(`OneDrive ${fileName} identity is unavailable.`);
  const response = await fetch(`${GRAPH_DRIVE_API}/items/${encodeURIComponent(item.id)}/content`, { headers: headers(token) });
  assertOk(response, `OneDrive ${fileName} download`);
  return { data: (await response.json()) as T, driveFileId: item.id, revision: item.eTag ?? item["@odata.etag"] ?? metadata.headers.get("etag") ?? undefined };
}

async function saveMs<T>(token: string, fileName: string, data: T, expectedRevision?: string): Promise<{ driveFileId?: string; revision?: string }> {
  await ensureMsFolder(token);
  const response = await fencedCloudMutation("microsoft", token, `${GRAPH_DRIVE_API}/root:/${graphPath(ONE_DRIVE_APP_FOLDER)}/${encodeURIComponent(fileName)}:/content`, {
    method: "PUT",
    headers: { ...headers(token), "Content-Type": MIME_JSON, ...(expectedRevision ? { "If-Match": expectedRevision } : { "If-None-Match": "*" }) },
    body: JSON.stringify(data, null, 2),
  });
  if (response.status === 409 || response.status === 412) throw new Error(`OneDrive ${fileName} changed before it could be updated.`);
  assertOk(response, `OneDrive ${fileName} save`);
  const item = await response.json().catch(() => ({})) as { id?: string; eTag?: string; "@odata.etag"?: string };
  return { driveFileId: item.id, revision: item.eTag ?? item["@odata.etag"] ?? response.headers.get("etag") ?? undefined };
}
