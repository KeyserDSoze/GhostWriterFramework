import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertOfflineSettingsPatchAllowed, cacheOfflineSettings, cacheSettings, clearSettingsCache, loadCachedSettings, loadCachedSettingsForHydration, OFFLINE_EDITABLE_SETTINGS_KEYS, projectSafeSettings, purgeLegacyUnsafeCaches, reconcileCachedSettings, SAFE_SETTINGS_KEYS } from "@/drive/settingsCache";
import { DEFAULT_SETTINGS, type AppSettings } from "@/types/settings";
import { useSettingsStore } from "@/store/settingsStore";

const account = "google:sub-owner";

function settings(language: "en" | "it" = "en"): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    defaultGitHubToken: "PAT_DEFAULT_CANARY",
    extraGitHubTokens: [{ label: "private", token: "PAT_EXTRA_CANARY" }],
    azureOpenAI: { ...DEFAULT_SETTINGS.azureOpenAI, apiKey: "AZURE_KEY_CANARY", endpoint: "https://basic-user:BASIC_PASS_CANARY@azure.example.test/models?api_key=AZURE_QUERY_CANARY#AZURE_FRAGMENT_CANARY" },
    aiIntegrations: [{ id: "private-ai", name: "Private", provider: "openai", apiKey: "AI_KEY_CANARY", endpoint: "https://encoded%40user:ENCODED_PASS_CANARY@ai.example.test/TOKEN_PATH_CANARY/v1?token=AI_QUERY_CANARY&sig=AI_SIG_CANARY#AI_FRAGMENT_CANARY", chatModels: [] }],
    deepSearch: { ...DEFAULT_SETTINGS.deepSearch, braveApiKey: "BRAVE_KEY_CANARY", tavilyApiKey: "TAVILY_KEY_CANARY", contentProxyBaseUrl: "data:text/plain,DATA_PROXY_CANARY?api_key=PROXY_QUERY_CANARY" },
    books: [{ id: "book", owner: "owner", repo: "repo", name: "Book", tokenIndex: null, bookToken: "BOOK_PAT_CANARY", addedAt: "now" }],
    ui: { ...DEFAULT_SETTINGS.ui, language },
  };
}

describe("validated account-scoped settings cache", () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });

  it("persists no credentials or secret canaries in localStorage", () => {
    cacheSettings(account, settings(), "revision-1");
    cacheOfflineSettings(account, settings("it"));
    const durable = JSON.stringify(localStorage);
    for (const secret of [
      "PAT_DEFAULT_CANARY", "PAT_EXTRA_CANARY", "AZURE_KEY_CANARY", "AI_KEY_CANARY", "BRAVE_KEY_CANARY", "TAVILY_KEY_CANARY", "BOOK_PAT_CANARY",
      "BASIC_PASS_CANARY", "AZURE_QUERY_CANARY", "AZURE_FRAGMENT_CANARY", "ENCODED_PASS_CANARY", "TOKEN_PATH_CANARY", "AI_QUERY_CANARY",
      "AI_SIG_CANARY", "AI_FRAGMENT_CANARY", "DATA_PROXY_CANARY", "PROXY_QUERY_CANARY", "basic-user", "encoded%40user",
    ]) {
      expect(durable).not.toContain(secret);
    }
    const loaded = loadCachedSettings(account)!;
    expect(loaded.ui.language).toBe("it");
    expect(loaded.defaultGitHubToken).toBe("PAT_DEFAULT_CANARY");
    expect(loaded.aiIntegrations[0].apiKey).toBe("AI_KEY_CANARY");
    expect(loaded.azureOpenAI.endpoint).toBe("");
    expect(loaded.aiIntegrations[0].endpoint).toBe("");
    expect(loaded.deepSearch.contentProxyBaseUrl).toBe("");
  });

  it("enumerates offline-editable fields within the safe projection and scrubs every omitted nested field", () => {
    for (const key of OFFLINE_EDITABLE_SETTINGS_KEYS) expect(SAFE_SETTINGS_KEYS).toContain(key);
    const projected = projectSafeSettings(settings());
    expect(projected.azureOpenAI).toMatchObject({ apiKey: "", endpoint: "" });
    expect(projected.aiIntegrations[0]).toMatchObject({ apiKey: "", endpoint: "" });
    expect(projected.deepSearch).toMatchObject({ braveApiKey: "", tavilyApiKey: "", contentProxyBaseUrl: "" });
    expect(projected.books[0]).not.toHaveProperty("bookToken");
    expect(projected.books[0]).not.toHaveProperty("bookTokenLabel");
  });

  it("rejects programmatic offline changes outside the explicit allowlist", () => {
    const current = settings();
    for (const patch of [
      { azureOpenAI: { ...current.azureOpenAI, endpoint: "https://changed.test" } },
      { aiIntegrations: [{ ...current.aiIntegrations[0], provider: "azure_openai" as const }] },
      { deepSearch: { ...current.deepSearch, contentProxyBaseUrl: "https://changed.test" } },
      { taskRouting: { default: { primary: { integrationId: "private-ai", model: "private-model" }, fallbacks: [] } } },
      { defaultGitHubToken: "changed" },
    ]) expect(() => assertOfflineSettingsPatchAllowed(current, patch)).toThrow(/cannot be changed offline/);
    expect(() => assertOfflineSettingsPatchAllowed(current, { ui: { ...current.ui, language: "it" } })).not.toThrow();
    expect(() => assertOfflineSettingsPatchAllowed(current, { speech: { ...current.speech, sttProvider: "ai" } })).toThrow(/browser voice/);
    expect(() => assertOfflineSettingsPatchAllowed(current, { books: [{ ...current.books[0], bookToken: "changed" }] })).toThrow(/credentials/);

    const online = navigator.onLine;
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    useSettingsStore.setState({ settings: current });
    expect(() => useSettingsStore.getState().patchSettings({ deepSearch: { ...current.deepSearch, contentProxyBaseUrl: "https://changed.test" } })).toThrow(/cannot be changed offline/);
    expect(useSettingsStore.getState().settings.deepSearch.contentProxyBaseUrl).toBe(current.deepSearch.contentProxyBaseUrl);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: online });
  });

  it("guards full offline replacement against credential, endpoint, and routing bypasses", () => {
    const current = settings();
    const online = navigator.onLine;
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    useSettingsStore.setState({ settings: current });

    for (const next of [
      { ...current, defaultGitHubToken: "BYPASS_PAT" },
      { ...current, azureOpenAI: { ...current.azureOpenAI, endpoint: "https://bypass.example.test" } },
      { ...current, aiIntegrations: [{ ...current.aiIntegrations[0], endpoint: "https://bypass.example.test" }] },
      { ...current, taskRouting: { default: { primary: { integrationId: "private-ai", model: "private-model" }, fallbacks: [] } } },
      { ...current, books: [{ ...current.books[0], exportSettings: { googleDriveFolderId: "other-account-folder" } }] },
    ]) expect(() => useSettingsStore.getState().setSettings(next)).toThrow(/cannot be changed offline/);

    expect(useSettingsStore.getState().settings).toEqual(current);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: online });
  });

  it("allows full offline replacement when every changed field is durable and editable", () => {
    const current = settings();
    const next = { ...current, ui: { ...current.ui, language: "it" as const }, repository: { ...current.repository, autoFetchOnOpen: !current.repository.autoFetchOnOpen } };
    const online = navigator.onLine;
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    useSettingsStore.setState({ settings: current });
    expect(() => useSettingsStore.getState().setSettings(next)).not.toThrow();
    expect(useSettingsStore.getState().settings).toEqual(next);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: online });
  });

  it("rejects stale trusted hydration after the account generation changes", () => {
    const replacement = settings("it");
    useSettingsStore.setState({ settings: settings(), accountIdentity: account, accountGeneration: 7 });
    expect(() => useSettingsStore.getState().replaceSettingsFromTrustedLoad(replacement, {
      accountIdentity: account,
      accountGeneration: 6,
      source: { kind: "offline-cache", schemaVersion: 2 },
    })).toThrow(/stale/);
    expect(useSettingsStore.getState().settings.ui.language).toBe("en");
  });

  it("accepts validated same-account cache hydration for the current generation", () => {
    const replacement = settings("it");
    cacheSettings(account, replacement, "revision-1");
    const hydration = loadCachedSettingsForHydration(account)!;
    useSettingsStore.setState({ settings: settings(), accountIdentity: account, accountGeneration: 8 });
    expect(() => useSettingsStore.getState().replaceSettingsFromTrustedLoad(hydration.settings, {
      accountIdentity: hydration.accountIdentity,
      accountGeneration: 8,
      source: hydration.source,
    })).not.toThrow();
    expect(useSettingsStore.getState().settings.ui.language).toBe("it");
  });

  it("loads only the owning account and rejects malformed or legacy envelopes", () => {
    cacheSettings(account, settings(), "revision-1");
    expect(loadCachedSettings("google:sub-other")).toBeNull();
    localStorage.setItem("narrarium-settings-cache-v2:google%3Asub-owner", JSON.stringify({ schemaVersion: 1, accountScope: account, base: {} }));
    expect(loadCachedSettings(account)).toBeNull();
  });

  it("purges the previous unsafe full-settings cache format", () => {
    localStorage.setItem("narrarium-settings-cache-v1:legacy", "PAT_LEGACY_CANARY");
    purgeLegacyUnsafeCaches();
    expect(JSON.stringify(localStorage)).not.toContain("PAT_LEGACY_CANARY");
  });

  it("auto-merges a safe offline patch only when the cloud revision still matches", () => {
    cacheSettings(account, settings("en"), "revision-1");
    cacheOfflineSettings(account, settings("it"));
    const merged = reconcileCachedSettings(account, settings("en"), "revision-1");
    expect(merged.kind).toBe("merged");
    expect(merged.changedKeys).toEqual(["ui"]);
    expect(merged.settings.ui.language).toBe("it");
    expect(merged.settings.defaultGitHubToken).toBe("PAT_DEFAULT_CANARY");
  });

  it("preserves the local safe patch and reports a conflict when cloud revision diverges", () => {
    cacheSettings(account, settings("en"), "revision-1");
    cacheOfflineSettings(account, settings("it"));
    const conflict = reconcileCachedSettings(account, { ...settings("en"), repository: { ...DEFAULT_SETTINGS.repository, autoFetchOnOpen: false } }, "revision-2");
    expect(conflict.kind).toBe("conflict");
    expect(conflict.settings.ui.language).toBe("it");
    expect(conflict.settings.repository.autoFetchOnOpen).toBe(false);
    expect(loadCachedSettings(account)?.ui.language).toBe("it");
  });

  it("retains cloud credentials when safe integration and book fields changed offline", () => {
    const base = settings("en");
    cacheSettings(account, base, "revision-1");
    const offline = settings("en");
    offline.aiIntegrations = [{ ...offline.aiIntegrations[0], name: "Renamed", apiKey: "AI_KEY_CANARY" }];
    offline.books = [{ ...offline.books[0], name: "Renamed book" }];
    cacheOfflineSettings(account, offline);
    const cloud = settings("en");
    cloud.aiIntegrations[0].apiKey = "CLOUD_AI_KEY_CANARY";
    cloud.aiIntegrations[0].endpoint = "https://cloud-ai.example.test/v1?token=CLOUD_QUERY_CANARY";
    cloud.azureOpenAI.endpoint = "https://cloud-azure.example.test/path?sig=CLOUD_SIG_CANARY";
    cloud.deepSearch.contentProxyBaseUrl = "https://cloud-proxy.example.test/fetch?api_key=CLOUD_PROXY_CANARY";
    cloud.books[0].bookToken = "CLOUD_BOOK_PAT_CANARY";
    const merged = reconcileCachedSettings(account, cloud, "revision-1").settings;
    expect(merged.aiIntegrations[0]).toMatchObject({ name: "Renamed", apiKey: "CLOUD_AI_KEY_CANARY", endpoint: cloud.aiIntegrations[0].endpoint });
    expect(merged.azureOpenAI.endpoint).toBe(cloud.azureOpenAI.endpoint);
    expect(merged.deepSearch.contentProxyBaseUrl).toBe(cloud.deepSearch.contentProxyBaseUrl);
    expect(merged.books[0]).toMatchObject({ name: "Renamed book", bookToken: "CLOUD_BOOK_PAT_CANARY" });
  });

  it("clears both durable safe state and session credentials", () => {
    cacheSettings(account, settings(), "revision-1");
    clearSettingsCache(account);
    expect(loadCachedSettings(account)).toBeNull();
    expect(JSON.stringify(localStorage)).not.toContain("narrarium-settings-cache-v2");
    expect(JSON.stringify(sessionStorage)).not.toContain("PAT_DEFAULT_CANARY");
  });

  it("disconnect and logout wiring does not clear authoritative local data", () => {
    const source = readFileSync(resolve(process.cwd(), "src/components/layout/Topbar.tsx"), "utf8");
    expect(source).not.toContain("clearOfflineCache();");
    const connections = readFileSync(resolve(process.cwd(), "src/pages/AccountSyncPage.tsx"), "utf8");
    expect(connections).toContain("disconnectAll");
    expect(connections).toContain("deleteAllNarrariumLocalData");
    expect(connections).toContain('await syncOneAccountReplica("onedrive")');
    const shell = readFileSync(resolve(process.cwd(), "src/components/layout/Shell.tsx"), "utf8");
    expect(shell).toContain("hydrateConnections().then(() => scheduleAccountSync(250))");
  });

  it("keeps important settings locally editable offline with an explanation", () => {
    const page = readFileSync(resolve(process.cwd(), "src/pages/SettingsPage.tsx"), "utf8");
    expect(page).toContain('fieldset className="space-y-3" aria-describedby={offline ? "offline-settings-explanation" : undefined}');
    expect(page).toContain('credentialsDisabled={false}');
    expect(page).toContain('id="offline-settings-explanation"');
  });
});
