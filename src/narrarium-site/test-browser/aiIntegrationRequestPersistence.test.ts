import { beforeEach, describe, expect, it } from "vitest";
import { mergeLocalDeviceSettings, projectSyncableSettings, sensitiveAccountData } from "@/account/dataProjection";
import { parseAccountRepositoryFiles, serializeAccountRepository } from "@/account/serialization";
import { ACCOUNT_SYNC_SCHEMA_VERSION, type LocalAccountSnapshot } from "@/account/types";
import { initialAccountManifest } from "@/account/vectorClock";
import { emptyCostsFile } from "@/costs/model";
import { migrateSettings, migrateSettingsWithDiagnostics } from "@/drive/cloudSettingsClient";
import { cacheOfflineSettings, cacheSettings, changedSafeSettingsKeys, loadCachedSettings, projectSafeSettings, reconcileCachedSettings } from "@/drive/settingsCache";
import { DEFAULT_SETTINGS, type AIIntegration, type AppSettings } from "@/types/settings";

const account = "google:sub-request-settings";

const integration = (extra: Partial<AIIntegration> = {}): AIIntegration => ({
  id: "lab",
  name: "Slow lab",
  provider: "openai",
  endpoint: "https://lab.example.test/v1",
  apiKey: "KEY_CANARY",
  requestTimeoutMs: 6000,
  idleTimeoutMs: 45_000,
  streamMode: "off",
  chatModels: [{ id: "m", name: "muse-glimmer-30b", capabilities: ["default"] }],
  ...extra,
});

const settingsWith = (...integrations: AIIntegration[]): AppSettings => ({ ...DEFAULT_SETTINGS, aiIntegrations: integrations, defaultWritingIntegrationId: integrations[0]?.id, defaultReviewIntegrationId: integrations[0]?.id });

const REQUEST_SETTINGS = { requestTimeoutMs: 6000, idleTimeoutMs: 45_000, streamMode: "off" } as const;

describe("the request settings of an integration survive wherever integrations are saved, loaded and synced", () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });

  describe("the cloud settings file", () => {
    it("is read back with them: the Drive file is JSON, and what is loaded is migrated", () => {
      const saved = JSON.parse(JSON.stringify(settingsWith(integration())));
      const { settings, diagnostics } = migrateSettingsWithDiagnostics(saved);
      expect(diagnostics).toEqual([]);
      expect(settings.aiIntegrations[0]).toMatchObject(REQUEST_SETTINGS);
      expect(settings.aiIntegrations[0].chatModels?.[0].name).toBe("muse-glimmer-30b");
    });

    it("keeps them on an integration that still has the older single-model fields, which migration turns into chat models", () => {
      const legacy = { id: "old", name: "Old", provider: "azure_openai", apiKey: "k", endpoint: "https://x.openai.azure.com", modelWriting: "gpt-4o", modelReview: "gpt-4o", ...REQUEST_SETTINGS };
      const migrated = migrateSettings({ ...DEFAULT_SETTINGS, aiIntegrations: [legacy] });
      expect(migrated.aiIntegrations[0]).toMatchObject(REQUEST_SETTINGS);
      expect(migrated.aiIntegrations[0].chatModels?.length).toBeGreaterThan(0);
    });

    it("writes nothing for an integration that says nothing: Automatic is the absence of a value, so a file of an older app is unchanged", () => {
      const plain = integration({ requestTimeoutMs: undefined, idleTimeoutMs: undefined, streamMode: undefined });
      const json = JSON.stringify(settingsWith(plain));
      expect(json).not.toContain("streamMode");
      expect(json).not.toContain("idleTimeoutMs");
      expect(json).not.toContain("requestTimeoutMs");
      const back = migrateSettings(JSON.parse(json));
      expect(back.aiIntegrations[0]).not.toHaveProperty("streamMode");
      expect(back.aiIntegrations[0]).not.toHaveProperty("idleTimeoutMs");
    });

    it("keeps an integration's values apart from the next one's", () => {
      const other = integration({ id: "plain", name: "Plain", requestTimeoutMs: undefined, idleTimeoutMs: undefined, streamMode: undefined });
      const back = migrateSettings(JSON.parse(JSON.stringify(settingsWith(integration(), other))));
      expect(back.aiIntegrations.map((entry) => [entry.id, entry.streamMode, entry.idleTimeoutMs])).toEqual([["lab", "off", 45_000], ["plain", undefined, undefined]]);
    });
  });

  describe("the offline cache", () => {
    it("projects them, without the key or the address that stay out of the cache", () => {
      const projected = projectSafeSettings(settingsWith(integration()));
      expect(projected.aiIntegrations[0]).toMatchObject({ ...REQUEST_SETTINGS, apiKey: "", endpoint: "" });
    });

    it("loads them back, and keeps no secret beside them in the durable cache", () => {
      cacheSettings(account, settingsWith(integration()), "revision-1");
      const durable = JSON.stringify(localStorage);
      expect(durable).toContain("streamMode");
      expect(durable).toContain("idleTimeoutMs");
      expect(durable).not.toContain("KEY_CANARY");
      const loaded = loadCachedSettings(account)!;
      expect(loaded.aiIntegrations[0]).toMatchObject({ ...REQUEST_SETTINGS, apiKey: "KEY_CANARY" });
    });

    it.each([
      ["Streaming", { streamMode: undefined }],
      ["the idle timeout", { idleTimeoutMs: 90_000 }],
      ["the provider timeout", { requestTimeoutMs: 120_000 }],
    ] as const)("sees a change of only %s as a change of the integrations, so it is synced", (_name, change) => {
      const base = settingsWith(integration());
      const next = settingsWith(integration(change));
      expect(changedSafeSettingsKeys(base, next)).toEqual(["aiIntegrations"]);
      expect(changedSafeSettingsKeys(base, base)).toEqual([]);
    });

    it("merges a change kept in the cache into the settings of the cloud, with the cloud's key and address", () => {
      const cloud = settingsWith(integration({ streamMode: undefined, idleTimeoutMs: undefined }));
      cacheSettings(account, cloud, "revision-1");
      cacheOfflineSettings(account, settingsWith(integration()));

      const reconciled = reconcileCachedSettings(account, cloud, "revision-1");
      expect(reconciled.kind).toBe("merged");
      expect(reconciled.changedKeys).toEqual(["aiIntegrations"]);
      expect(reconciled.settings.aiIntegrations[0]).toMatchObject({ ...REQUEST_SETTINGS, apiKey: "KEY_CANARY", endpoint: "https://lab.example.test/v1" });
      expect(loadCachedSettings(account)!.aiIntegrations[0]).toMatchObject(REQUEST_SETTINGS);
    });
  });

  describe("the account replicas", () => {
    it("carry them in the portable settings, and not among the secrets", () => {
      const settings = settingsWith(integration());
      expect(projectSyncableSettings(settings).aiIntegrations[0]).toMatchObject(REQUEST_SETTINGS);
      const secrets = JSON.stringify(sensitiveAccountData(settings));
      expect(secrets).toContain("KEY_CANARY");
      for (const name of ["streamMode", "idleTimeoutMs", "requestTimeoutMs"]) expect(secrets).not.toContain(name);
    });

    it("keep the remote values when a remote dataset is adopted on this device", () => {
      const local = settingsWith(integration({ streamMode: undefined, idleTimeoutMs: undefined }));
      const remote = settingsWith(integration({ idleTimeoutMs: 120_000 }));
      expect(mergeLocalDeviceSettings(local, remote).aiIntegrations[0]).toMatchObject({ streamMode: "off", idleTimeoutMs: 120_000 });
    });

    it("write them in settings.json of the account repository and read them back", async () => {
      const snapshot: LocalAccountSnapshot = {
        manifest: { ...initialAccountManifest("device-a"), vectorClock: { "device-a": 1 } },
        dirty: true,
        data: { schemaVersion: ACCOUNT_SYNC_SCHEMA_VERSION, settings: settingsWith(integration()), costs: emptyCostsFile(), clipboard: [], chats: [] },
      };
      const serialized = await serializeAccountRepository(snapshot);
      expect(serialized.files.get("settings.json")).toContain('"idleTimeoutMs": 45000');
      expect(serialized.files.get("settings.json")).toContain('"streamMode": "off"');
      const restored = parseAccountRepositoryFiles(serialized.files);
      expect(restored.data.settings.aiIntegrations[0]).toMatchObject(REQUEST_SETTINGS);
    });
  });
});
