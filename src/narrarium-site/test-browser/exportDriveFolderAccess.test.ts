import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleFolderAccessError, uploadDriveFile } from "@/drive/exportDriveClient";

// With drive.file, Google answers «not found» for a folder Narrarium did not create: the export says so (the person may allow full access) instead of a bare 404.
describe("an export into a Google Drive folder Narrarium cannot see", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: 404, message: "File not found: f1." } }), { status: 404, headers: { "Content-Type": "application/json" } })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is told as such, not as a failed request", async () => {
    await expect(uploadDriveFile("google", "token", { googleFolderId: "f1", fileName: "book.epub", mimeType: "application/epub+zip", blob: new Blob(["x"]) })).rejects.toBeInstanceOf(GoogleFolderAccessError);
  });
});
