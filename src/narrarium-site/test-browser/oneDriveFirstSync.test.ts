import { afterEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { registerCloudAccount } from "@/drive/cloudWriteBarrier";
import { loadAppJson } from "@/drive/jsonFile";

describe("OneDrive first synchronization", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates a missing app folder and ownership marker before reporting an absent replica file", async () => {
    const token = `first-sync-${crypto.randomUUID()}`;
    const providerAccountId = `home-${crypto.randomUUID()}`;
    let folderCreated = false;
    let markerCreated = false;
    registerCloudAccount("microsoft", token, providerAccountId);

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? "GET") === "GET") expect(init?.cache).toBe("no-store");
      if (url.includes("/v1.0/me?$select=id")) return Response.json({ id: "graph-first-sync" });
      if (url.endsWith("/root:/Apps")) return Response.json({ id: "apps", folder: {} });
      if (url.endsWith("/root:/Apps/Narrarium")) return folderCreated ? Response.json({ id: "folder", folder: {} }) : new Response(null, { status: 404 });
      if (url.endsWith("/root:/Apps:/children") && init?.method === "POST") {
        folderCreated = true;
        return Response.json({ id: "folder", folder: {} }, { status: 201 });
      }
      if (url.includes("/root:/Apps/Narrarium?") && url.includes("createdBy")) return Response.json({ id: "folder", folder: {}, createdBy: { user: { id: "opaque-drive-creator" } } });
      if (url.includes("/items/folder/children")) return Response.json({ value: markerCreated ? [{ id: "marker", name: ".narrarium-app-folder-v1.json", eTag: "m1", file: {} }] : [] });
      if (url.endsWith("/.narrarium-app-folder-v1.json:/content") && init?.method === "PUT") {
        markerCreated = true;
        return Response.json({ id: "marker", eTag: "m1" }, { status: 201 });
      }
      if (url.endsWith("/.narrarium-app-folder-v1.json:/content")) return markerCreated
        ? Response.json({ application: "Narrarium", version: 3, provider: "microsoft", providerAccountId, graphUserId: "graph-first-sync" })
        : new Response(null, { status: 404 });
      if (url.endsWith("/root:/Apps/Narrarium/manifest.json")) return new Response(null, { status: 404 });
      throw new Error(`Unexpected OneDrive first-sync request: ${url}`);
    }));

    await expect(loadAppJson("microsoft", token, "manifest.json")).resolves.toEqual({ data: null });
    expect(folderCreated).toBe(true);
    expect(markerCreated).toBe(true);
  });
});
