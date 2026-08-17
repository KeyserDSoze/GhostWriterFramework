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
      if (url.includes("/files/settings-id?alt=media")) return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json", etag: "etag-1" } });
      if (url.endsWith("/files/settings-id?fields=id")) return new Response(JSON.stringify({ id: "settings-id" }), { headers: { "Content-Type": "application/json", etag: "etag-1" } });
    } else {
      if (url.endsWith("/root:/Apps")) return Response.json({ id: "apps", folder: {} });
      if (url.endsWith("/root:/Apps/Narrarium")) return Response.json({ id: "folder", folder: {} });
      if (url.includes("/items/folder/children")) return Response.json({ value: [{ id: "marker", name: ".narrarium-app-folder-v1.json", eTag: "m1", file: {} }, { id: "settings-id", name: "settings.json", eTag: "etag-1", file: {} }] });
      if (url.endsWith("/.narrarium-app-folder-v1.json:/content")) return Response.json({ application: "Narrarium", version: 2, secret: "test-secret" });
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
    localStorage.setItem("narrarium.microsoftAppFolderMarker.v2.home-test", "test-secret");
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
      if (url.endsWith("/files/settings-id?fields=id")) return new Response("{}", { headers: { etag: `etag-${++revisionRead}` } });
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
