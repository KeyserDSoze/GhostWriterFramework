import { beginCloudWrite, fencedCloudMutation, registerCloudAccount } from "@/drive/cloudWriteBarrier";
import { CopyHttpError, retryAfterOf } from "../classify";
import type { DriveCopyApi } from "./drive";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER = "application/vnd.google-apps.folder";
const MIME = "application/gzip";
/** Above this a file goes up in one resumable request; under it, as one multipart request. */
const MULTIPART_LIMIT = 4 * 1024 * 1024;

function quote(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function check(response: Response, context: string): Promise<Response> {
  if (!response.ok) throw new CopyHttpError(response.status, `${context}: ${response.status}`, retryAfterOf(response.headers));
  return response;
}

/**
 * `DriveCopyApi` over the Drive REST API, in the hidden app-data folder (`spaces=appDataFolder`, the `drive.appdata` scope the connection already has),
 * with the connection's token. Writes go through the site's cloud write fence, so an account change or a deletion of the account's data stops them.
 */
export class GoogleDriveFetchApi implements DriveCopyApi {
  private readonly folders = new Map<string, string>();
  constructor(private readonly token: string, accountId: string) {
    registerCloudAccount("google", token, accountId);
  }
  private get headers(): Record<string, string> { return { Authorization: `Bearer ${this.token}` }; }

  async session<T>(run: () => Promise<T>): Promise<T> {
    const end = await beginCloudWrite("google", this.token);
    try { return await run(); } finally { await end(); }
  }

  private async child(parent: string, name: string, folder: boolean): Promise<string | null> {
    const params = new URLSearchParams({
      spaces: "appDataFolder",
      q: `name='${quote(name)}' and '${quote(parent)}' in parents and trashed=false${folder ? ` and mimeType='${FOLDER}'` : ""}`,
      fields: "files(id,name)",
      orderBy: "createdTime",
      pageSize: "5",
    });
    const response = await check(await fetch(`${API}/files?${params}`, { headers: this.headers }), "Google Drive lookup");
    return ((await response.json()) as { files?: Array<{ id: string }> }).files?.[0]?.id ?? null;
  }

  async findFolder(segments: string[]): Promise<string | null> {
    let parent = "appDataFolder";
    for (let index = 0; index < segments.length; index += 1) {
      const key = segments.slice(0, index + 1).join("/");
      let id: string | null | undefined = this.folders.get(key);
      if (!id) id = await this.child(parent, segments[index], true);
      if (!id) return null;
      this.folders.set(key, id);
      parent = id;
    }
    return parent;
  }

  async ensureFolder(segments: string[]): Promise<string> {
    let parent = "appDataFolder";
    for (let index = 0; index < segments.length; index += 1) {
      const key = segments.slice(0, index + 1).join("/");
      let id: string | null | undefined = this.folders.get(key);
      if (!id) id = await this.child(parent, segments[index], true);
      if (!id) {
        const created = await check(await fencedCloudMutation("google", this.token, `${API}/files?fields=id`, {
          method: "POST",
          headers: { ...this.headers, "Content-Type": "application/json" },
          body: JSON.stringify({ name: segments[index], mimeType: FOLDER, parents: [parent] }),
        }), "Google Drive folder create");
        id = ((await created.json()) as { id: string }).id;
      }
      this.folders.set(key, id);
      parent = id;
    }
    return parent;
  }

  async fileExists(folderId: string, name: string): Promise<boolean> {
    return (await this.child(folderId, name, false)) !== null;
  }

  async upload(folderId: string, name: string, bytes: Uint8Array): Promise<void> {
    const metadata = JSON.stringify({ name, parents: [folderId] });
    if (bytes.length <= MULTIPART_LIMIT) {
      const form = new FormData();
      form.append("metadata", new Blob([metadata], { type: "application/json" }));
      form.append("file", new Blob([bytes as BlobPart], { type: MIME }));
      await check(await fencedCloudMutation("google", this.token, `${UPLOAD}/files?uploadType=multipart&fields=id`, { method: "POST", headers: this.headers, body: form }), "Google Drive upload");
      return;
    }
    const start = await check(await fencedCloudMutation("google", this.token, `${UPLOAD}/files?uploadType=resumable&fields=id`, {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": MIME },
      body: metadata,
    }), "Google Drive upload start");
    const location = start.headers.get("location");
    if (!location) throw new CopyHttpError(502, "Google Drive did not answer with an upload address.");
    await check(await fencedCloudMutation("google", this.token, location, { method: "PUT", headers: { "Content-Type": MIME }, body: bytes as BodyInit }), "Google Drive upload");
  }

  async deleteItem(id: string): Promise<void> {
    const response = await fencedCloudMutation("google", this.token, `${API}/files/${encodeURIComponent(id)}`, { method: "DELETE", headers: this.headers });
    if (response.status !== 404) await check(response, "Google Drive delete");
    for (const [key, value] of this.folders) if (value === id) this.folders.delete(key);
  }
}
