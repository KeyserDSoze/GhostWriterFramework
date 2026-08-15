import { beginCloudWrite } from "./cloudWriteBarrier.ts";

const GOOGLE_DRIVE_API = "https://www.googleapis.com/drive/v3";
const APP_FOLDER_NAME = "Narrarium";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const MARKER_KEY = "narrariumAppFolder";
const MARKER_VALUE = "v1";
const PERSISTED_FOLDER_KEY = "narrarium.googleAppFolderId.v1";

export interface VerifiedGoogleAppFolder {
  id: string;
  name: string;
  createdTime?: string;
  mimeType?: string;
}

let activeEnsure: { token: string; promise: Promise<string> } | null = null;
let activeAccount: { token: string; promise: Promise<string> } | null = null;

function headers(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function assertOk(response: Response, context: string): void {
  if (!response.ok) throw new Error(`${context}: ${response.status}`);
}

function readPersistedFolderId(accountKey: string): string | null {
  try { return window.localStorage.getItem(`${PERSISTED_FOLDER_KEY}.${accountKey}`); } catch { return null; }
}

function persistFolderId(accountKey: string, id: string | null): void {
  try {
    const key = `${PERSISTED_FOLDER_KEY}.${accountKey}`;
    if (id) window.localStorage.setItem(key, id);
    else window.localStorage.removeItem(key);
  } catch {
    // Drive metadata remains authoritative when browser storage is unavailable.
  }
}

function isMarked(properties: unknown): boolean {
  return Boolean(properties && typeof properties === "object" && (properties as Record<string, unknown>)[MARKER_KEY] === MARKER_VALUE);
}

export function selectCanonicalGoogleAppFolder(folders: VerifiedGoogleAppFolder[]): VerifiedGoogleAppFolder | null {
  return [...folders].sort((left, right) => {
    const byTime = (left.createdTime ?? "\uffff").localeCompare(right.createdTime ?? "\uffff");
    return byTime || left.id.localeCompare(right.id);
  })[0] ?? null;
}

export function isLegacyNarrariumSettings(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const settings = value as Record<string, unknown>;
  const ui = settings.ui as Record<string, unknown> | undefined;
  return settings.version === 2
    && Array.isArray(settings.books)
    && typeof settings.defaultGitHubToken === "string"
    && Boolean(ui && (ui.language === "en" || ui.language === "it"));
}

async function googleAccountKey(token: string): Promise<string> {
  if (activeAccount?.token === token) return activeAccount.promise;
  const promise = fetch(`${GOOGLE_DRIVE_API}/about?fields=user(permissionId,emailAddress)`, { headers: headers(token) })
    .then(async (response) => {
      assertOk(response, "Google Drive account identity");
      const user = (await response.json() as { user?: { permissionId?: string; emailAddress?: string } }).user;
      const identity = user?.permissionId ?? user?.emailAddress;
      if (!identity) throw new Error("Google Drive account identity is unavailable.");
      return encodeURIComponent(identity);
    })
    .finally(() => {
      if (activeAccount?.promise === promise) activeAccount = null;
    });
  activeAccount = { token, promise };
  return promise;
}

export async function listVerifiedGoogleAppFolders(token: string): Promise<VerifiedGoogleAppFolder[]> {
  const marker = `appProperties has { key='${MARKER_KEY}' and value='${MARKER_VALUE}' }`;
  const params = new URLSearchParams({
    q: `mimeType='${FOLDER_MIME}' and trashed=false and ${marker}`,
    spaces: "drive",
    fields: "files(id,name,createdTime,appProperties)",
    orderBy: "createdTime,name",
  });
  const response = await fetch(`${GOOGLE_DRIVE_API}/files?${params}`, { headers: headers(token) });
  assertOk(response, "Google verified app folder lookup");
  const data = await response.json() as { files?: Array<VerifiedGoogleAppFolder & { appProperties?: Record<string, string> }> };
  return (data.files ?? []).filter((folder) => isMarked(folder.appProperties));
}

async function findLegacyFolder(token: string): Promise<VerifiedGoogleAppFolder | null> {
  const params = new URLSearchParams({
    q: `name='${APP_FOLDER_NAME}' and mimeType='${FOLDER_MIME}' and 'root' in parents and trashed=false`,
    spaces: "drive",
    fields: "files(id,name,createdTime)",
    orderBy: "createdTime,name",
  });
  const response = await fetch(`${GOOGLE_DRIVE_API}/files?${params}`, { headers: headers(token) });
  assertOk(response, "Google legacy app folder lookup");
  const candidates = (await response.json() as { files?: VerifiedGoogleAppFolder[] }).files ?? [];
  for (const folder of candidates) {
    const childParams = new URLSearchParams({ q: `name='settings.json' and '${folder.id}' in parents and trashed=false`, spaces: "drive", fields: "files(id)" });
    const childResponse = await fetch(`${GOOGLE_DRIVE_API}/files?${childParams}`, { headers: headers(token) });
    assertOk(childResponse, "Google legacy settings lookup");
    const settingsId = (await childResponse.json() as { files?: Array<{ id: string }> }).files?.[0]?.id;
    if (!settingsId) continue;
    const content = await fetch(`${GOOGLE_DRIVE_API}/files/${encodeURIComponent(settingsId)}?alt=media`, { headers: headers(token) });
    if (!content.ok) continue;
    if (!isLegacyNarrariumSettings(await content.json().catch(() => null))) continue;
    const marked = await fetch(`${GOOGLE_DRIVE_API}/files/${encodeURIComponent(folder.id)}?fields=id`, {
      method: "PATCH",
      headers: { ...headers(token), "Content-Type": "application/json" },
      body: JSON.stringify({ appProperties: { [MARKER_KEY]: MARKER_VALUE } }),
    });
    assertOk(marked, "Google legacy app folder marker");
    return folder;
  }
  return null;
}

async function createMarkedFolder(token: string): Promise<VerifiedGoogleAppFolder> {
  const response = await fetch(`${GOOGLE_DRIVE_API}/files?fields=id,name,createdTime,appProperties`, {
    method: "POST",
    headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify({ name: APP_FOLDER_NAME, mimeType: FOLDER_MIME, appProperties: { [MARKER_KEY]: MARKER_VALUE } }),
  });
  assertOk(response, "Google app folder create");
  return response.json() as Promise<VerifiedGoogleAppFolder>;
}

async function ensureGoogleAppFolderInternal(token: string): Promise<string> {
  const accountKey = await googleAccountKey(token);
  const persisted = readPersistedFolderId(accountKey);
  let folders = await listVerifiedGoogleAppFolders(token);
  let selected = selectCanonicalGoogleAppFolder(folders);
  if (selected && persisted !== selected.id) persistFolderId(accountKey, selected.id);
  if (!selected) selected = await findLegacyFolder(token);
  if (!selected) {
    const created = await createMarkedFolder(token);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, attempt * 75));
      folders = await listVerifiedGoogleAppFolders(token);
      if (folders.some((folder) => folder.id === created.id)) break;
    }
    selected = selectCanonicalGoogleAppFolder(folders);
    if (!selected) throw new Error(`Google app folder ${created.id} was created but could not be reconciled safely.`);
  }
  if (!selected) throw new Error("Google app folder creation could not be verified.");
  persistFolderId(accountKey, selected.id);
  return selected.id;
}

export function ensureGoogleAppFolder(token: string): Promise<string> {
  if (activeEnsure?.token === token) return activeEnsure.promise;
  const endWrite = beginCloudWrite("google", token);
  const promise = ensureGoogleAppFolderInternal(token).finally(() => {
    endWrite();
    if (activeEnsure?.promise === promise) activeEnsure = null;
  });
  activeEnsure = { token, promise };
  return promise;
}

export async function deleteVerifiedGoogleAppFolders(token: string): Promise<string[]> {
  const folders = await listVerifiedGoogleAppFolders(token);
  for (const folder of folders) {
    const response = await fetch(`${GOOGLE_DRIVE_API}/files/${encodeURIComponent(folder.id)}`, { method: "DELETE", headers: headers(token) });
    if (!(response.ok || response.status === 404)) throw new Error(`Google verified app folder delete: ${response.status}`);
  }
  const ids = folders.map((folder) => folder.id);
  await clearPersistedGoogleAppFolder(token, ids);
  return ids;
}

export async function clearPersistedGoogleAppFolder(token: string, ids: string[] = []): Promise<void> {
  const accountKey = await googleAccountKey(token);
  const persisted = readPersistedFolderId(accountKey);
  if (!ids.length || (persisted && ids.includes(persisted))) persistFolderId(accountKey, null);
  activeEnsure = null;
}

export function resetGoogleAppFolderCacheForTests(): void {
  activeEnsure = null;
  activeAccount = null;
}
