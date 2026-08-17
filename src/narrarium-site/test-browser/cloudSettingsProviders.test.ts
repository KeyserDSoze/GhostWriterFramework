import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProvider } from "@/store/authStore";
import { registerCloudAccount } from "@/drive/cloudWriteBarrier";

vi.mock("@/drive/googleAppFolder", () => ({ ensureGoogleAppFolder: vi.fn(async () => "folder-id") }));

import { loadCloudSettings, loadCloudSettingsForMigration, saveCloudSettings } from "@/drive/cloudSettingsClient";
import { DEFAULT_SETTINGS } from "@/types/settings";
import "fake-indexeddb/auto";

const historicalV1 = {
  version: 1,
  defaultGitHubToken: "",
  books: [],
  ui: { language: "en" },
  copilotTools: null,
  customActions: [{ id: "legacy", name: "Legacy", prompt: "Run" }],
};

const malformedNested = {
  version: 2,
  defaultGitHubToken: "",
  books: [],
  ui: { language: "it" },
  copilotTools: { toolOverrides: { good: { enabled: false }, bad: { enabled: "no" } } },
  customActions: [{ id: "good", name: "Good", prompt: "Run" }, { id: "bad", name: 1, prompt: "Run" }],
};

function providerFetch(provider: AuthProvider, payload: unknown) {
  return vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (provider === "google") {
      if (url.includes("/files?") && url.includes("createdTime")) return Response.json({ files: [{ id: "settings-id", createdTime: "2026-01-01T00:00:00Z" }] });
      if (url.includes("/files/settings-id?alt=media")) return Response.json(payload);
      if (url.endsWith("/files/settings-id?fields=id,version,modifiedTime,md5Checksum")) return Response.json({ id: "settings-id", version: "123", modifiedTime: "2026-01-01T00:00:00Z", md5Checksum: "abc" });
    } else {
      if (url.includes("graph.microsoft.com/v1.0/me?$select=id")) return Response.json({ id: "graph-user-test" });
      if (url.endsWith("/root:/Apps")) return Response.json({ id: "apps", folder: {} });
      if (url.endsWith("/root:/Apps/Narrarium")) return Response.json({ id: "folder", folder: {} });
      if (url.includes("/root:/Apps/Narrarium") && url.includes("$select=id,folder,createdBy")) return Response.json({ id: "folder", folder: {}, createdBy: { user: { id: "graph-user-test" } } });
      if (url.includes("/items/folder/children")) return Response.json({ value: [{ id: "marker", name: ".narrarium-app-folder-v1.json", eTag: "m1", file: {} }, { id: "settings-id", name: "settings.json", eTag: "etag-1", file: {} }] });
      if (url.endsWith("/.narrarium-app-folder-v1.json:/content")) return Response.json({ application: "Narrarium", version: 3, provider: "microsoft", providerAccountId: "home-test", graphUserId: "graph-user-test" });
      if (url.endsWith("/root:/Apps/Narrarium/settings.json")) return Response.json({ id: "settings-id", eTag: "etag-1" });
      if (url.endsWith("/items/settings-id/content")) return Response.json(payload);
    }
    throw new Error(`Unexpected ${provider} request: ${url}`);
  });
}

describe.each<AuthProvider>(["google", "microsoft"])("%s cloud settings historical fixtures", (provider) => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    registerCloudAccount("microsoft", "token", "home-test");
  });

  it.each([
    ["v1", historicalV1, 0, 1],
    ["malformed nested records", malformedNested, 2, 1],
  ])("normalizes the %s fixture identically during ordinary and migration loads", async (_name, payload, diagnosticCount, actionCount) => {
    vi.stubGlobal("fetch", providerFetch(provider, payload));
    const ordinary = await loadCloudSettings(provider, "token");
    vi.stubGlobal("fetch", providerFetch(provider, payload));
    const migration = await loadCloudSettingsForMigration(provider, "token");

    for (const result of [ordinary, migration]) {
      expect(result.settings.version).toBe(2);
      expect(result.settings.copilotTools).toEqual({ schemaVersion: 1, toolOverrides: payload === malformedNested ? { good: { enabled: false } } : {} });
      expect(result.settings.customActions).toHaveLength(actionCount);
      expect(result.diagnostics).toHaveLength(diagnosticCount);
    }
  });

  it("rejects an update without the revision retained by load", async () => {
    vi.stubGlobal("fetch", providerFetch(provider, historicalV1));
    await expect(saveCloudSettings(provider, "token", DEFAULT_SETTINGS)).rejects.toThrow(/not loaded|changed/i);
  });

  if (provider === "google") it("rejects content when the metadata revision changes during download", async () => {
    let revisionRead = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/files?") && url.includes("createdTime")) return Response.json({ files: [{ id: "settings-id", createdTime: "2026-01-01T00:00:00Z" }] });
      if (url.endsWith("/files/settings-id?fields=id,version,modifiedTime,md5Checksum")) return Response.json({ id: "settings-id", version: String(++revisionRead) });
      if (url.includes("/files/settings-id?alt=media")) return Response.json(historicalV1);
      throw new Error(`Unexpected request ${url}`);
    }));
    await expect(loadCloudSettings("google", "token")).rejects.toThrow(/changed while/);
  });

  it.each([
    ["null", null],
    ["array", []],
  ])("repairs the %s root on ordinary load but rejects it as a migration source", async (_name, payload) => {
    vi.stubGlobal("fetch", providerFetch(provider, payload));
    const ordinary = await loadCloudSettings(provider, "token");
    expect(ordinary.settings.copilotTools).toEqual({ schemaVersion: 1, toolOverrides: {} });
    expect(ordinary.diagnostics).toHaveLength(1);

    vi.stubGlobal("fetch", providerFetch(provider, payload));
    await expect(loadCloudSettingsForMigration(provider, "token")).rejects.toThrow("Source settings are malformed");
  });
});

describe("cloud settings provider revisions", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    registerCloudAccount("microsoft", "token", "home-test");
  });

  it("loads Google settings from JSON version metadata when browser responses have no ETag", async () => {
    vi.stubGlobal("fetch", providerFetch("google", historicalV1));
    const loaded = await loadCloudSettings("google", "token");
    expect(loaded.fileId).toBe("settings-id");
    expect(loaded.revision).toMatch(/^gdrive:/);
  });

  it("rejects a stale Google save before PATCH", async () => {
    let patched = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/files?") && url.includes("createdTime")) return Response.json({ files: [{ id: "settings-id" }] });
      if (url.endsWith("/files/settings-id?fields=id,version,modifiedTime,md5Checksum")) return Response.json({ id: "settings-id", version: "new-version" });
      if (init?.method === "PATCH") patched = true;
      throw new Error(`Unexpected request ${url}`);
    }));
    const oldRevision = `gdrive:${btoa(JSON.stringify(["settings-id", "old-version"])).replace(/=+$/, "")}`;
    await expect(saveCloudSettings("google", "token", DEFAULT_SETTINGS, { fileId: "settings-id", revision: oldRevision })).rejects.toThrow(/changed since/);
    expect(patched).toBe(false);
  });

  it("saves Google settings without If-Match and returns the advanced JSON version", async () => {
    let metadataRead = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/files?") && url.includes("createdTime")) return Response.json({ files: [{ id: "settings-id" }] });
      if (url.endsWith("/files/settings-id?fields=id,version,modifiedTime,md5Checksum")) return Response.json({ id: "settings-id", version: String(++metadataRead) });
      if (init?.method === "PATCH") {
        expect(new Headers(init.headers).has("If-Match")).toBe(false);
        return Response.json({ id: "settings-id" });
      }
      throw new Error(`Unexpected request ${url}`);
    }));
    const revision = `gdrive:${btoa(JSON.stringify(["settings-id", "1"])).replace(/=+$/, "")}`;
    const saved = await saveCloudSettings("google", "token", DEFAULT_SETTINGS, { fileId: "settings-id", revision });
    expect(saved.revision).toBe(`gdrive:${btoa(JSON.stringify(["settings-id", "2"])).replace(/=+$/, "")}`);
  });

  it("reconciles a Google PATCH that committed before a network error", async () => {
    let metadataRead = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/files?") && url.includes("createdTime")) return Response.json({ files: [{ id: "settings-id" }] });
      if (url.endsWith("/files/settings-id?fields=id,version,modifiedTime,md5Checksum")) return Response.json({ id: "settings-id", version: metadataRead++ === 0 ? "1" : "2" });
      if (init?.method === "PATCH") throw new TypeError("network disconnected after commit");
      if (url.endsWith("/files/settings-id?alt=media")) return Response.json(DEFAULT_SETTINGS);
      throw new Error(`Unexpected request ${url}`);
    }));
    const revision = `gdrive:${btoa(JSON.stringify(["settings-id", "1"])).replace(/=+$/, "")}`;
    const saved = await saveCloudSettings("google", "token", DEFAULT_SETTINGS, { fileId: "settings-id", revision });
    expect(saved.revision).toBe(`gdrive:${btoa(JSON.stringify(["settings-id", "2"])).replace(/=+$/, "")}`);
  });

  it.each([
    ["eTag", { id: "settings-id", eTag: "body-etag" }, "body-etag"],
    ["@odata.etag", { id: "settings-id", "@odata.etag": "odata-etag" }, "odata-etag"],
  ])("loads a OneDrive revision from JSON %s without a response ETag", async (_field, metadata, revision) => {
    const base = providerFetch("microsoft", historicalV1);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/root:/Apps/Narrarium/settings.json")) return Response.json(metadata);
      return base(input);
    }));
    const loaded = await loadCloudSettings("microsoft", "token");
    expect(loaded.revision).toBe(revision);
  });

  it("looks up OneDrive metadata when the save response contains no revision", async () => {
    const base = providerFetch("microsoft", historicalV1);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/root:/Apps/Narrarium/settings.json:/content") && init?.method === "PUT") return Response.json({ id: "settings-id" });
      if (url.endsWith("/items/settings-id")) return Response.json({ id: "settings-id", "@odata.etag": "etag-2" });
      return base(input);
    }));
    const saved = await saveCloudSettings("microsoft", "token", DEFAULT_SETTINGS, { fileId: "settings-id", revision: "etag-1" });
    expect(saved).toEqual({ fileId: "settings-id", revision: "etag-2" });
  });
});
