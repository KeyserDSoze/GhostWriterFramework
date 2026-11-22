import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AI_REASONING_PARAMETERS, pickAiRuntimeConfig, redactAiRuntimeConfig } from "narrarium-engine";
import { closeAccountLocalStoreForTests, initializeAccountLocalStore, loadLocalAccountSnapshot, saveLocalAccountSettings } from "@/account/accountLocalStore";
import { resetLocalWorkspaceIdentityForTests } from "@/account/deviceIdentity";
import { mergeLocalDeviceSettings, projectSyncableSettings } from "@/account/dataProjection";
import { migrateSettings } from "@/drive/cloudSettingsClient";
import { cacheSettings, loadCachedSettings, projectSafeSettings, reconcileCachedSettings } from "@/drive/settingsCache";
import { emptyCostsFile } from "@/costs/model";
import { DEFAULT_SETTINGS, REASONING_PARAMETERS, type AIIntegration, type AppSettings, type ReasoningParameter } from "@/types/settings";

const account = "google:sub-owner";
const TEMPLATE = "chat_template_kwargs.reasoning_strength";

/** An integration with two models: the first says how its level of thinking is sent (or says nothing), the second never does. */
const integration = (parameter?: unknown): AIIntegration => ({
  id: "llm", name: "LlmProxy", provider: "openai", endpoint: "http://llm.test/v1", apiKey: "sk-llm-0123456789abcdef",
  chatModels: [
    { id: "m1", name: "muse-glimmer-30b", capabilities: ["default"], ...(parameter !== undefined ? { reasoningParameter: parameter as ReasoningParameter } : {}) },
    { id: "m2", name: "legacy", capabilities: ["default"] },
  ],
});
const withParameter = (parameter?: unknown): AppSettings => ({ ...DEFAULT_SETTINGS, aiIntegrations: [integration(parameter)], defaultWritingIntegrationId: "llm" });
const model = (settings: AppSettings, index: number) => settings.aiIntegrations[0].chatModels![index];

describe("the thinking parameter of a model, in the settings", () => {
  it("has the three values of the engine, in its order: the site does not invent one", () => {
    expect([...REASONING_PARAMETERS]).toEqual([...AI_REASONING_PARAMETERS]);
    expect([...REASONING_PARAMETERS]).toEqual(["reasoning_effort", TEMPLATE, "none"]);
  });

  it.each([...REASONING_PARAMETERS])("keeps %s through the migration that every copy of the settings goes through, on its model only", (value) => {
    const migrated = migrateSettings(withParameter(value));
    expect(model(migrated, 0).reasoningParameter).toBe(value);
    expect("reasoningParameter" in model(migrated, 1)).toBe(false);
  });

  it("leaves a model that never said as it was: no key, so a settings file stays as an older app wrote it", () => {
    expect("reasoningParameter" in model(migrateSettings(withParameter()), 0)).toBe(false);
  });

  it("does not rewrite what it does not know: a value that a newer app writes goes through as it was, and the engine uses none of it", () => {
    const migrated = migrateSettings(withParameter("chat_template_kwargs.enable_thinking"));
    expect(model(migrated, 0).reasoningParameter).toBe("chat_template_kwargs.enable_thinking");
    expect(pickAiRuntimeConfig(migrated).aiIntegrations[0].chatModels?.[0]).not.toHaveProperty("reasoningParameter");
  });
});

describe("the thinking parameter in the offline cache", () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });

  it.each([...REASONING_PARAMETERS])("is part of what the cache keeps of an integration: %s (only the key and the address are taken out)", (value) => {
    const projected = projectSafeSettings(withParameter(value));
    expect(model(projected as unknown as AppSettings, 0).reasoningParameter).toBe(value);
    expect(projected.aiIntegrations[0].apiKey).toBe("");
  });

  it("is still there after the settings are cached and read back, for an author who is offline", () => {
    cacheSettings(account, withParameter(TEMPLATE), "revision-1");
    expect(model(loadCachedSettings(account)!, 0).reasoningParameter).toBe(TEMPLATE);
  });

  it("is kept when the cloud's copy is reconciled with the cache", () => {
    cacheSettings(account, withParameter("none"), "revision-1");
    const reconciled = reconcileCachedSettings(account, withParameter("none"), "revision-1");
    expect(model(reconciled.settings, 0).reasoningParameter).toBe("none");
  });
});

describe("the thinking parameter in the account's own data", () => {
  beforeEach(async () => {
    closeAccountLocalStoreForTests();
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase("narrarium-local-account");
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
    });
    localStorage.clear();
    resetLocalWorkspaceIdentityForTests();
  });
  afterEach(() => closeAccountLocalStoreForTests());

  it("goes into the data that every device of the account shares, and into what is read back from it", () => {
    const wire = JSON.parse(JSON.stringify(projectSyncableSettings(withParameter(TEMPLATE))));
    expect(model(migrateSettings(wire), 0).reasoningParameter).toBe(TEMPLATE);
  });

  it("is the remote device's choice when a device adopts the account's data", () => {
    const merged = mergeLocalDeviceSettings(withParameter("none"), withParameter(TEMPLATE));
    expect(model(merged, 0).reasoningParameter).toBe(TEMPLATE);
  });

  it("is kept in the local account store, and is a change to sync", async () => {
    const first = await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
    expect(first.dirty).toBe(false);
    const manifest = await saveLocalAccountSettings(withParameter(TEMPLATE));
    const restored = await loadLocalAccountSnapshot();
    expect(model(restored!.data.settings, 0).reasoningParameter).toBe(TEMPLATE);
    expect(restored?.dirty).toBe(true);
    expect(manifest.snapshotId).not.toBe(first.manifest.snapshotId);
  });
});

describe("the thinking parameter in the configuration the personal server gets", () => {
  it.each([...REASONING_PARAMETERS])("carries %s for the model that says it, and for no other", (value) => {
    const picked = pickAiRuntimeConfig(withParameter(value));
    expect(picked.aiIntegrations[0].chatModels?.[0].reasoningParameter).toBe(value);
    expect(picked.aiIntegrations[0].chatModels?.[1]).not.toHaveProperty("reasoningParameter");
  });

  it.each([["a model that says nothing", undefined], ["a word that is not one of the three", "reasoning-effort"], ["a number", 3], ["nothing at all", null]])("carries nothing for %s: the model is called as it always was", (_name, value) => {
    const settings = withParameter(value === undefined ? undefined : value);
    expect(pickAiRuntimeConfig(settings).aiIntegrations[0].chatModels?.[0]).not.toHaveProperty("reasoningParameter");
  });

  it("is the same after the server has stored the configuration and picks it again, and the safe view shows it, with no secret", () => {
    const stored = JSON.parse(JSON.stringify(pickAiRuntimeConfig(withParameter(TEMPLATE))));
    const again = pickAiRuntimeConfig(stored);
    expect(again.aiIntegrations[0].chatModels?.[0].reasoningParameter).toBe(TEMPLATE);
    const shown = redactAiRuntimeConfig(again).integrations[0].models;
    expect(shown.find((entry) => entry.name === "muse-glimmer-30b")?.reasoningParameter).toBe(TEMPLATE);
    expect(shown.find((entry) => entry.name === "legacy")).not.toHaveProperty("reasoningParameter");
    expect(JSON.stringify(shown)).not.toContain("sk-llm");
  });
});
