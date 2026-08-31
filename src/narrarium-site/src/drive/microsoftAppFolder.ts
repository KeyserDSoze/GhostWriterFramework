import { fencedCloudMutation, registeredCloudAccount } from "@/drive/cloudWriteBarrier";

const GRAPH_DRIVE_API = "https://graph.microsoft.com/v1.0/me/drive";
const GRAPH_ME_API = "https://graph.microsoft.com/v1.0/me?$select=id";
export const ONE_DRIVE_APP_FOLDER = "Apps/Narrarium";
export const MICROSOFT_APP_MARKER = ".narrarium-app-folder-v1.json";
const ALLOWED_CHILDREN = new Set([MICROSOFT_APP_MARKER, "manifest.json", "account-data.json", "settings.json", "costs.json", "clipboard.json", "chats", "chat-segments", "Exports"]);

function headers(token: string) { return { Authorization: `Bearer ${token}` }; }
export function graphPath(path: string): string { return path.split("/").filter(Boolean).map(encodeURIComponent).join("/"); }

function accountId(token: string): string {
  const id = registeredCloudAccount("microsoft", token);
  if (!id) throw new Error("Immutable Microsoft account identity is unavailable.");
  return id;
}

interface MicrosoftAccountProof { providerAccountId: string; graphUserId: string }
function ownedMarker(proof: MicrosoftAccountProof, value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const marker = value as Record<string, unknown>;
  return marker.application === "Narrarium" && marker.version === 3
    && marker.provider === "microsoft"
    && marker.providerAccountId === proof.providerAccountId
    && marker.graphUserId === proof.graphUserId;
}
function legacyMarker(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const marker = value as Record<string, unknown>;
  return marker.application === "Narrarium" && marker.version === 2 && typeof marker.secret === "string" && Boolean(marker.secret);
}
function markerBody(proof: MicrosoftAccountProof): string {
  return JSON.stringify({ application: "Narrarium", version: 3, provider: "microsoft", providerAccountId: proof.providerAccountId, graphUserId: proof.graphUserId });
}
async function microsoftAccountProof(token: string): Promise<MicrosoftAccountProof> {
  const response = await fetch(GRAPH_ME_API, { headers: headers(token) });
  if (!response.ok) throw new Error(`Microsoft account proof: ${response.status}`);
  const profile = await response.json() as { id?: unknown };
  if (typeof profile.id !== "string" || !profile.id.trim()) throw new Error("Microsoft account proof is unavailable.");
  return { providerAccountId: accountId(token), graphUserId: profile.id.trim() };
}
function assertFolderAccountProof(item: { createdBy?: { user?: { id?: string } } }, proof: MicrosoftAccountProof): void {
  if (item.createdBy?.user?.id !== proof.graphUserId) throw new Error("The OneDrive Apps/Narrarium folder was not created by the authenticated Microsoft account.");
}

export interface MicrosoftChild { id: string; name: string; eTag?: string; file?: object; folder?: object }

function validateKnownChildren(children: MicrosoftChild[]): void {
  for (const child of children) {
    if (!ALLOWED_CHILDREN.has(child.name)) throw new Error("The OneDrive Apps/Narrarium folder contains unrelated data and will not be deleted or adopted.");
    const expectedFolder = child.name === "chats" || child.name === "chat-segments" || child.name === "Exports";
    if (expectedFolder ? !child.folder || child.file : !child.file || child.folder) throw new Error(`The OneDrive child ${child.name} has the wrong item type.`);
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

export async function verifyMicrosoftAppFolder(token: string): Promise<{ id: string; eTag?: string; children: MicrosoftChild[] } | null> {
  const encoded = graphPath(ONE_DRIVE_APP_FOLDER);
  const meta = await fetch(`${GRAPH_DRIVE_API}/root:/${encoded}?$select=id,eTag,folder,createdBy`, { headers: headers(token) });
  if (meta.status === 404) return null;
  if (!meta.ok) throw new Error(`OneDrive folder lookup: ${meta.status}`);
  const proof = await microsoftAccountProof(token);
  const item = await meta.json() as { id?: string; eTag?: string; folder?: object; createdBy?: { user?: { id?: string } } };
  if (!item.id || !item.folder) throw new Error("The OneDrive Apps/Narrarium item is not an app-owned folder.");
  assertFolderAccountProof(item, proof);
  const children = await listMicrosoftFolderChildren(token, item.id);
  validateKnownChildren(children);
  const marker = await fetch(`${GRAPH_DRIVE_API}/root:/${encoded}/${encodeURIComponent(MICROSOFT_APP_MARKER)}:/content`, { headers: headers(token) });
  if (marker.status === 404) return null;
  if (!marker.ok) throw new Error(`OneDrive app marker verification: ${marker.status}`);
  const value = await marker.json().catch(() => null);
  if (!ownedMarker(proof, value)) throw new Error("The OneDrive Narrarium folder is not owned by this Microsoft account.");
  return { id: item.id, eTag: item.eTag, children };
}

export async function verifyMicrosoftFolderEmpty(token: string, id: string): Promise<boolean> {
  return (await listMicrosoftFolderChildren(token, id)).length === 0;
}

export async function ensureMicrosoftAppMarker(token: string): Promise<void> {
  const proof = await microsoftAccountProof(token);
  const encoded = graphPath(ONE_DRIVE_APP_FOLDER);
  const meta = await fetch(`${GRAPH_DRIVE_API}/root:/${encoded}?$select=id,folder,createdBy`, { headers: headers(token) });
  if (!meta.ok) throw new Error(`OneDrive folder lookup: ${meta.status}`);
  const item = await meta.json() as { id?: string; folder?: object; createdBy?: { user?: { id?: string } } };
  if (!item.id || !item.folder) throw new Error("The OneDrive Apps/Narrarium item is not a folder.");
  assertFolderAccountProof(item, proof);
  const children = await listMicrosoftFolderChildren(token, item.id);
  validateKnownChildren(children);
  const markerUrl = `${GRAPH_DRIVE_API}/root:/${encoded}/${encodeURIComponent(MICROSOFT_APP_MARKER)}:/content`;
  const existing = await fetch(markerUrl, { headers: headers(token) });
  if (existing.ok) {
    const value = await existing.json().catch(() => null);
    if (!ownedMarker(proof, value)) {
      if (!legacyMarker(value)) throw new Error("The OneDrive Narrarium marker belongs to another account or application.");
      const adopted = await fencedCloudMutation("microsoft", token, markerUrl, { method: "PUT", headers: { ...headers(token), "Content-Type": "application/json", "If-Match": existing.headers.get("etag") ?? "*" }, body: markerBody(proof) });
      if (!adopted.ok) throw new Error(`OneDrive app marker adoption: ${adopted.status}`);
    }
    return;
  }
  if (existing.status !== 404) throw new Error(`OneDrive app marker lookup: ${existing.status}`);
  if (children.length) throw new Error("An unmarked OneDrive Apps/Narrarium folder already exists and will not be adopted.");
  const created = await fencedCloudMutation("microsoft", token, markerUrl, { method: "PUT", headers: { ...headers(token), "Content-Type": "application/json", "If-None-Match": "*" }, body: markerBody(proof) });
  if (!created.ok) throw new Error(`OneDrive app marker create: ${created.status}`);
}
