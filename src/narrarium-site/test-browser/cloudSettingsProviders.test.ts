import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProvider } from "@/store/authStore";

vi.mock("@/drive/googleAppFolder", () => ({ ensureGoogleAppFolder: vi.fn(async () => "folder-id") }));

import { loadCloudSettings, loadCloudSettingsForMigration } from "@/drive/cloudSettingsClient";

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
      if (url.includes("/files?") && url.includes("fields=files%28id%29")) return Response.json({ files: [{ id: "settings-id" }] });
      if (url.includes("/files/settings-id?alt=media")) return Response.json(payload);
    } else {
      if (url.endsWith("/root:/Apps") || url.endsWith("/root:/Apps/Narrarium")) return Response.json({ id: "folder" });
      if (url.endsWith("/root:/Apps/Narrarium/settings.json")) return Response.json({ id: "settings-id" });
      if (url.endsWith("/items/settings-id/content")) return Response.json(payload);
    }
    throw new Error(`Unexpected ${provider} request: ${url}`);
  });
}

describe.each<AuthProvider>(["google", "microsoft"])("%s cloud settings historical fixtures", (provider) => {
  beforeEach(() => vi.unstubAllGlobals());

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
