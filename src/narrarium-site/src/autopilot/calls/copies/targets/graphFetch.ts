import { beginCloudWrite, fencedCloudMutation, registerCloudAccount } from "@/drive/cloudWriteBarrier";
import { ensureMsFolder } from "@/drive/jsonFile";
import { graphPath } from "@/drive/microsoftAppFolder";
import { fetchMicrosoftGraph } from "@/drive/microsoftGraph";
import { CopyHttpError, retryAfterOf } from "../classify";
import type { GraphCopyApi } from "./onedrive";

const DRIVE = "https://graph.microsoft.com/v1.0/me/drive";

/**
 * `GraphCopyApi` over Microsoft Graph, in the app folder (`Apps/Narrarium`, `Files.ReadWrite`, the scope the connection already has), with the
 * connection's token. The folder and its ownership marker are made as the account sync makes them; writes go through the site's cloud write fence.
 */
export class GraphFetchApi implements GraphCopyApi {
  constructor(private readonly token: string, accountId: string) {
    registerCloudAccount("microsoft", token, accountId);
  }
  private get headers(): Record<string, string> { return { Authorization: `Bearer ${this.token}` }; }

  async session<T>(run: () => Promise<T>): Promise<T> {
    const end = await beginCloudWrite("microsoft", this.token);
    try { return await run(); } finally { await end(); }
  }

  async ensureAppFolder(): Promise<void> {
    await ensureMsFolder(this.token);
  }

  async exists(path: string): Promise<boolean> {
    const response = await fetchMicrosoftGraph(`${DRIVE}/root:/${graphPath(path)}?$select=id`, { headers: this.headers });
    if (response.status === 404) return false;
    if (!response.ok) throw new CopyHttpError(response.status, `OneDrive lookup: ${response.status}`, retryAfterOf(response.headers));
    return true;
  }

  async put(path: string, bytes: Uint8Array): Promise<void> {
    const response = await fencedCloudMutation("microsoft", this.token, `${DRIVE}/root:/${graphPath(path)}:/content?@microsoft.graph.conflictBehavior=replace`, {
      method: "PUT",
      headers: { ...this.headers, "Content-Type": "application/gzip" },
      body: bytes as BodyInit,
    });
    if (!response.ok) throw new CopyHttpError(response.status, `OneDrive upload: ${response.status}`, retryAfterOf(response.headers));
  }

  async remove(path: string): Promise<void> {
    const response = await fencedCloudMutation("microsoft", this.token, `${DRIVE}/root:/${graphPath(path)}`, { method: "DELETE", headers: this.headers });
    if (!response.ok && response.status !== 404) throw new CopyHttpError(response.status, `OneDrive delete: ${response.status}`, retryAfterOf(response.headers));
  }
}
