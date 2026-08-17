import { fencedCloudMutation, registeredCloudAccount } from "@/drive/cloudWriteBarrier";

const GRAPH_DRIVE_API = "https://graph.microsoft.com/v1.0/me/drive";
export const ONE_DRIVE_APP_FOLDER = "Apps/Narrarium";
export const MICROSOFT_APP_MARKER = ".narrarium-app-folder-v1.json";
const ALLOWED_CHILDREN = new Set([MICROSOFT_APP_MARKER, "settings.json", "costs.json", "clipboard.json", "chats", "chat-segments", "Exports"]);
const MARKER_STORAGE_PREFIX = "narrarium.microsoftAppFolderMarker.v2.";

function headers(token: string) { return { Authorization: `Bearer ${token}` }; }
export function graphPath(path: string): string { return path.split("/").filter(Boolean).map(encodeURIComponent).join("/"); }

function accountId(token: string): string {
  const id = registeredCloudAccount("microsoft", token);
  if (!id) throw new Error("Immutable Microsoft account identity is unavailable.");
  return id;
}

function markerStorageKey(token: string): string { return `${MARKER_STORAGE_PREFIX}${encodeURIComponent(accountId(token))}`; }
function ownedMarker(token: string, value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const marker = value as Record<string, unknown>;
  const secret = localStorage.getItem(markerStorageKey(token));
  return marker.application === "Narrarium" && marker.version === 2 && typeof marker.secret === "string" && marker.secret === secret;
}

export interface MicrosoftChild { id: string; name: string; eTag?: string; file?: object; folder?: object }

function validateKnownChildren(children: MicrosoftChild[]): void {
  for (const child of children) {
    if (!ALLOWED_CHILDREN.has(child.name)) throw new Error("The OneDrive Apps/Narrarium folder contains unrelated data and will not be deleted or adopted.");
    const expectedFolder = child.name === "chats" || child.name === "chat-segments" || child.name === "Exports";
    if (expectedFolder ? !child.folder || child.file : !child.file || child.folder) throw new Error(`The OneDrive child ${child.name} has the wrong item type.`);
  }
}

function validateLegacyAdoptionChildren(children: MicrosoftChild[]): void {
  validateKnownChildren(children);
  if (children.some((child) => child.name !== MICROSOFT_APP_MARKER && child.name !== "settings.json")) {
    throw new Error("Legacy OneDrive adoption requires a settings-only folder; existing app data remains untouched.");
  }
}

export async function listMicrosoftFolderChildren(token: string, id: string): Promise<MicrosoftChild[]> {
  const children: MicrosoftChild[] = [];
  let next: string | undefined = `${GRAPH_DRIVE_API}/items/${encodeURIComponent(id)}/children?$select=id,name,eTag,file,folder&$top=200`;
  while (next) {
    const response = await fetch(next, { headers: headers(token) });
    if (!response.ok) throw new Error(`OneDrive folder verification: ${response.status}`);
    const page = await response.json() as { value?: Array<{ id?: unknown; name?: unknown; eTag?: unknown; file?: object; folder?: object }>; "@odata.nextLink"?: string };
    for (const item of page.value ?? []) {
      if (typeof item.id !== "string" || !item.id || typeof item.name !== "string" || !item.name) throw new Error("OneDrive folder contains an unidentified child.");
      children.push({ id: item.id, name: item.name, eTag: typeof item.eTag === "string" ? item.eTag : undefined, file: item.file, folder: item.folder });
    }
    next = page["@odata.nextLink"];
  }
  return children;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function strictlyValidLegacySettings(token: string, encoded: string): Promise<boolean> {
  const response = await fetch(`${GRAPH_DRIVE_API}/root:/${encoded}/${encodeURIComponent("settings.json")}:/content`, { headers: headers(token) });
  if (!response.ok) return false;
  const value = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!value || value.version !== 2) return false;
  const { isValidSettingsSource, migrateSettings } = await import("@/drive/cloudSettingsClient");
  if (!isValidSettingsSource(value) || canonicalJson(migrateSettings(value)) !== canonicalJson(value)) return false;
  const settings = value as Record<string, unknown>;
  const ui = settings.ui as Record<string, unknown>;
  if (!(["en", "it"].includes(String(ui.language))) || !(["light", "dark", "system"].includes(String(ui.theme)))) return false;
  const books = settings.books as unknown[];
  if (!books.every((book) => book && typeof book === "object" && typeof (book as Record<string, unknown>).id === "string" && typeof (book as Record<string, unknown>).owner === "string" && typeof (book as Record<string, unknown>).repo === "string")) return false;
  const tokens = settings.extraGitHubTokens as unknown[];
  if (!tokens.every((entry) => entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).label === "string" && typeof (entry as Record<string, unknown>).token === "string")) return false;
  return true;
}

export async function verifyMicrosoftAppFolder(token: string): Promise<{ id: string; eTag?: string; children: MicrosoftChild[] } | null> {
  const encoded = graphPath(ONE_DRIVE_APP_FOLDER);
  const meta = await fetch(`${GRAPH_DRIVE_API}/root:/${encoded}`, { headers: headers(token) });
  if (meta.status === 404) return null;
  if (!meta.ok) throw new Error(`OneDrive folder lookup: ${meta.status}`);
  const item = await meta.json() as { id?: string; eTag?: string; folder?: object };
  if (!item.id || !item.folder) throw new Error("The OneDrive Apps/Narrarium item is not an app-owned folder.");
  const children = await listMicrosoftFolderChildren(token, item.id);
  validateKnownChildren(children);
  const marker = await fetch(`${GRAPH_DRIVE_API}/root:/${encoded}/${encodeURIComponent(MICROSOFT_APP_MARKER)}:/content`, { headers: headers(token) });
  if (marker.status === 404) return null;
  if (!marker.ok) throw new Error(`OneDrive app marker verification: ${marker.status}`);
  const value = await marker.json().catch(() => null);
  if (!ownedMarker(token, value)) throw new Error("The OneDrive Narrarium folder is not owned by this app installation.");
  return { id: item.id, eTag: item.eTag, children };
}

export async function verifyMicrosoftFolderEmpty(token: string, id: string): Promise<boolean> {
  return (await listMicrosoftFolderChildren(token, id)).length === 0;
}

export async function ensureMicrosoftAppMarker(token: string): Promise<void> {
  const encoded = graphPath(ONE_DRIVE_APP_FOLDER);
  const meta = await fetch(`${GRAPH_DRIVE_API}/root:/${encoded}`, { headers: headers(token) });
  if (!meta.ok) throw new Error(`OneDrive folder lookup: ${meta.status}`);
  const item = await meta.json() as { id?: string; folder?: object };
  if (!item.id || !item.folder) throw new Error("The OneDrive Apps/Narrarium item is not a folder.");
  const children = await listMicrosoftFolderChildren(token, item.id);
  validateKnownChildren(children);
  const markerUrl = `${GRAPH_DRIVE_API}/root:/${encoded}/${encodeURIComponent(MICROSOFT_APP_MARKER)}:/content`;
  const existing = await fetch(markerUrl, { headers: headers(token) });
  if (existing.ok) {
    const value = await existing.json().catch(() => null);
    if (!ownedMarker(token, value)) {
      validateLegacyAdoptionChildren(children);
      if (!await strictlyValidLegacySettings(token, encoded)) throw new Error("The legacy OneDrive folder does not contain valid Narrarium settings and cannot be adopted.");
      if (typeof window === "undefined" || !window.confirm("A legacy Narrarium OneDrive folder was found. Adopt it without deleting or replacing any content?")) throw new Error("Legacy OneDrive folder adoption was declined.");
      const secret = crypto.randomUUID();
      const adopted = await fencedCloudMutation("microsoft", token, markerUrl, { method: "PUT", headers: { ...headers(token), "Content-Type": "application/json", "If-Match": existing.headers.get("etag") ?? "*" }, body: JSON.stringify({ application: "Narrarium", version: 2, secret }) });
      if (!adopted.ok) throw new Error(`OneDrive app marker adoption: ${adopted.status}`);
      localStorage.setItem(markerStorageKey(token), secret);
    }
    return;
  }
  if (existing.status !== 404) throw new Error(`OneDrive app marker lookup: ${existing.status}`);
  const legacy = children.length > 0;
  if (legacy) {
    validateLegacyAdoptionChildren(children);
    if (!await strictlyValidLegacySettings(token, encoded)) throw new Error("The legacy OneDrive folder does not contain valid Narrarium settings and cannot be adopted.");
    if (typeof window === "undefined" || !window.confirm("A legacy Narrarium OneDrive folder was found. Adopt it without deleting or replacing any content?")) throw new Error("Legacy OneDrive folder adoption was declined.");
  }
  const secret = crypto.randomUUID();
  const created = await fencedCloudMutation("microsoft", token, markerUrl, { method: "PUT", headers: { ...headers(token), "Content-Type": "application/json", "If-None-Match": "*" }, body: JSON.stringify({ application: "Narrarium", version: 2, secret }) });
  if (!created.ok) throw new Error(`OneDrive app marker create: ${created.status}`);
  localStorage.setItem(markerStorageKey(token), secret);
}
