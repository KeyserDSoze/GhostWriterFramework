import { migrateSettings } from "@/drive/cloudSettingsClient";
import { DEFAULT_SETTINGS, type AIIntegration, type AppSettings, type BookEntry } from "@/types/settings";

export const SETTINGS_CACHE_SCHEMA_VERSION = 2;
const SETTINGS_CACHE_PREFIX = "narrarium-settings-cache-v2:";
const SESSION_CREDENTIALS_PREFIX = "narrarium-settings-credentials-v1:";
const LEGACY_UNSAFE_CACHE_PREFIX = "narrarium-settings-cache-v1:";

export const SAFE_SETTINGS_KEYS = [
  "azureOpenAI", "aiIntegrations", "defaultWritingIntegrationId", "defaultReviewIntegrationId", "taskRouting", "fallbackDisclosure",
  "routingExecution", "costCurrency", "ui", "speech", "repository", "deepSearch", "copilotTools", "reader", "customActionsSchemaVersion",
  "customActions", "books",
] as const;

export const OFFLINE_EDITABLE_SETTINGS_KEYS = ["costCurrency", "ui", "repository", "reader", "customActions", "copilotTools", "speech", "books"] as const;
export type OfflineEditableSettingsKey = typeof OFFLINE_EDITABLE_SETTINGS_KEYS[number];

export type SafeSettingsKey = typeof SAFE_SETTINGS_KEYS[number];
export type SafeSettingsProjection = Pick<AppSettings, SafeSettingsKey>;

interface OfflineSettingsEnvelope {
  schemaVersion: typeof SETTINGS_CACHE_SCHEMA_VERSION;
  accountScope: string;
  baseRevision: string | null;
  base: SafeSettingsProjection;
  pending?: {
    revision: number;
    updatedAt: string;
    changedKeys: SafeSettingsKey[];
    values: Partial<SafeSettingsProjection>;
  };
}

interface SessionCredentials {
  defaultGitHubToken: string;
  extraGitHubTokens: AppSettings["extraGitHubTokens"];
  azureOpenAIApiKey: string;
  integrationApiKeys: Record<string, string>;
  deepSearchApiKeys: Pick<AppSettings["deepSearch"], "braveApiKey" | "tavilyApiKey">;
  bookTokens: Record<string, { token: string; label?: string }>;
}

export interface SettingsReconciliation {
  settings: AppSettings;
  kind: "cloud" | "merged" | "conflict";
  changedKeys: SafeSettingsKey[];
}

export interface CachedSettingsHydration {
  settings: AppSettings;
  accountIdentity: string;
  source: { kind: "offline-cache"; schemaVersion: typeof SETTINGS_CACHE_SCHEMA_VERSION };
}

function cacheKey(accountScope: string): string {
  return `${SETTINGS_CACHE_PREFIX}${encodeURIComponent(accountScope)}`;
}

function credentialsKey(accountScope: string): string {
  return `${SESSION_CREDENTIALS_PREFIX}${encodeURIComponent(accountScope)}`;
}

export function purgeLegacyUnsafeCaches(): void {
  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(LEGACY_UNSAFE_CACHE_PREFIX)) localStorage.removeItem(key);
    }
  } catch { /* unavailable storage leaves no usable cache */ }
}

purgeLegacyUnsafeCaches();

function sanitizeIntegration(integration: AIIntegration): AIIntegration {
  return { ...integration, apiKey: "", endpoint: "" };
}

function sanitizeBook(book: BookEntry): BookEntry {
  const { bookToken: _bookToken, bookTokenLabel: _bookTokenLabel, ...safe } = book;
  return safe;
}

function same(value: unknown, other: unknown): boolean {
  return JSON.stringify(value) === JSON.stringify(other);
}

function changedPaths(current: unknown, next: unknown, path: string): string[] {
  if (same(current, next)) return [];
  if (!current || !next || typeof current !== "object" || typeof next !== "object") return [path];
  if (Array.isArray(current) || Array.isArray(next)) {
    if (!Array.isArray(current) || !Array.isArray(next)) return [path];
    return Array.from({ length: Math.max(current.length, next.length) }, (_, index) => index)
      .flatMap((index) => changedPaths(current[index], next[index], `${path}.${index}`));
  }
  const currentRecord = current as Record<string, unknown>;
  const nextRecord = next as Record<string, unknown>;
  return [...new Set([...Object.keys(currentRecord), ...Object.keys(nextRecord)])]
    .flatMap((key) => changedPaths(currentRecord[key], nextRecord[key], path ? `${path}.${key}` : key));
}

function assertOfflineBooksAllowed(current: AppSettings["books"], next: AppSettings["books"]): void {
  const currentById = new Map(current.map((book) => [book.id, book]));
  const protectedFields = ["id", "owner", "repo", "tokenIndex", "bookToken", "bookTokenLabel", "addedAt"] as const;
  const protectedExportFields = ["googleDriveFolderId", "googleDriveFolderName", "microsoftDriveFolderPath"] as const;
  for (const book of next) {
    const existing = currentById.get(book.id);
    if (!existing) throw new Error("Settings path books cannot be changed offline: books cannot be added.");
    for (const field of protectedFields) {
      if (!same(book[field], existing[field])) {
        const credential = field === "tokenIndex" || field === "bookToken" || field === "bookTokenLabel";
        throw new Error(`Settings path books.${book.id}.${field} cannot be changed offline${credential ? "; book credentials are online-only" : ""}.`);
      }
    }
    for (const field of protectedExportFields) {
      if (!same(book.exportSettings?.[field], existing.exportSettings?.[field])) {
        throw new Error(`Settings path books.${book.id}.exportSettings.${field} cannot be changed offline; cloud destinations are account-sensitive.`);
      }
    }
  }
}

export function assertOfflineSettingsReplacementAllowed(current: AppSettings, next: AppSettings): void {
  const fullyEditable = new Set<keyof AppSettings>(["costCurrency", "ui", "repository", "reader", "customActions", "copilotTools"]);
  const keys = [...new Set([...Object.keys(current), ...Object.keys(next)])] as Array<keyof AppSettings>;
  for (const key of keys) {
    if (same(current[key], next[key])) continue;
    if (fullyEditable.has(key)) continue;
    if (key === "books") {
      assertOfflineBooksAllowed(current.books, next.books);
      continue;
    }
    if (key === "speech") {
      const paths = changedPaths(current.speech, next.speech, "speech");
      const rejected = paths.find((path) => path !== "speech.ttsVoice" && path !== "speech.ttsRate");
      if (!rejected) continue;
      throw new Error(`Settings path ${rejected} cannot be changed offline; only browser voice and speed are editable.`);
    }
    const path = changedPaths(current[key], next[key], String(key))[0] ?? String(key);
    throw new Error(`Settings path ${path} cannot be changed offline.`);
  }
}

export function assertOfflineSettingsPatchAllowed(current: AppSettings, patch: Partial<AppSettings>): void {
  assertOfflineSettingsReplacementAllowed(current, { ...current, ...patch });
}

export function projectSafeSettings(settings: AppSettings): SafeSettingsProjection {
  return {
    azureOpenAI: { ...settings.azureOpenAI, apiKey: "", endpoint: "" },
    aiIntegrations: settings.aiIntegrations.map(sanitizeIntegration),
    defaultWritingIntegrationId: settings.defaultWritingIntegrationId,
    defaultReviewIntegrationId: settings.defaultReviewIntegrationId,
    taskRouting: settings.taskRouting,
    fallbackDisclosure: settings.fallbackDisclosure,
    routingExecution: settings.routingExecution,
    costCurrency: settings.costCurrency,
    ui: settings.ui,
    speech: settings.speech,
    repository: settings.repository,
    deepSearch: { ...settings.deepSearch, braveApiKey: "", tavilyApiKey: "", contentProxyBaseUrl: "" },
    copilotTools: settings.copilotTools,
    reader: settings.reader,
    customActionsSchemaVersion: settings.customActionsSchemaVersion,
    customActions: settings.customActions,
    books: settings.books.map(sanitizeBook),
  };
}

function extractCredentials(settings: AppSettings): SessionCredentials {
  return {
    defaultGitHubToken: settings.defaultGitHubToken,
    extraGitHubTokens: settings.extraGitHubTokens,
    azureOpenAIApiKey: settings.azureOpenAI.apiKey,
    integrationApiKeys: Object.fromEntries(settings.aiIntegrations.filter((entry) => entry.apiKey).map((entry) => [entry.id, entry.apiKey])),
    deepSearchApiKeys: { braveApiKey: settings.deepSearch.braveApiKey, tavilyApiKey: settings.deepSearch.tavilyApiKey },
    bookTokens: Object.fromEntries(settings.books.filter((book) => book.bookToken).map((book) => [book.id, { token: book.bookToken!, ...(book.bookTokenLabel ? { label: book.bookTokenLabel } : {}) }])),
  };
}

function applyCredentials(settings: AppSettings, credentials: SessionCredentials | null): AppSettings {
  if (!credentials) return settings;
  return {
    ...settings,
    defaultGitHubToken: credentials.defaultGitHubToken,
    extraGitHubTokens: credentials.extraGitHubTokens,
    azureOpenAI: { ...settings.azureOpenAI, apiKey: credentials.azureOpenAIApiKey },
    aiIntegrations: settings.aiIntegrations.map((entry) => ({ ...entry, apiKey: credentials.integrationApiKeys[entry.id] ?? "" })),
    deepSearch: { ...settings.deepSearch, ...credentials.deepSearchApiKeys },
    books: settings.books.map((book) => {
      const credential = credentials.bookTokens[book.id];
      return credential ? { ...book, bookToken: credential.token, bookTokenLabel: credential.label } : book;
    }),
  };
}

function readEnvelope(accountScope: string): OfflineSettingsEnvelope | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(cacheKey(accountScope)) ?? "null") as Partial<OfflineSettingsEnvelope> | null;
    if (!parsed || parsed.schemaVersion !== SETTINGS_CACHE_SCHEMA_VERSION || parsed.accountScope !== accountScope || !parsed.base || typeof parsed.base !== "object") return null;
    const safeBase = projectSafeSettings(migrateSettings({ ...DEFAULT_SETTINGS, ...parsed.base }));
    const changedKeys = parsed.pending?.changedKeys?.filter((key): key is SafeSettingsKey => SAFE_SETTINGS_KEYS.includes(key as SafeSettingsKey)) ?? [];
    return {
      schemaVersion: SETTINGS_CACHE_SCHEMA_VERSION,
      accountScope,
      baseRevision: typeof parsed.baseRevision === "string" ? parsed.baseRevision : null,
      base: safeBase,
      ...(parsed.pending && changedKeys.length ? { pending: { revision: Number.isFinite(parsed.pending.revision) ? parsed.pending.revision! : 1, updatedAt: typeof parsed.pending.updatedAt === "string" ? parsed.pending.updatedAt : "", changedKeys, values: projectSafePatch(parsed.pending.values, changedKeys) } } : {}),
    };
  } catch {
    return null;
  }
}

function readSessionCredentials(accountScope: string): SessionCredentials | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(credentialsKey(accountScope)) ?? "null") as SessionCredentials | null;
    return value && typeof value === "object" ? value : null;
  } catch { return null; }
}

function projectSafePatch(value: unknown, keys: SafeSettingsKey[]): Partial<SafeSettingsProjection> {
  const source = value && typeof value === "object" ? value as Partial<AppSettings> : {};
  const projected = projectSafeSettings(migrateSettings({ ...DEFAULT_SETTINGS, ...source }));
  return Object.fromEntries(keys.map((key) => [key, projected[key]])) as Partial<SafeSettingsProjection>;
}

function changedSafeKeys(base: SafeSettingsProjection, next: SafeSettingsProjection): SafeSettingsKey[] {
  return SAFE_SETTINGS_KEYS.filter((key) => JSON.stringify(base[key]) !== JSON.stringify(next[key]));
}

function mergeSafe(settings: AppSettings, values: Partial<SafeSettingsProjection>, keys: SafeSettingsKey[]): AppSettings {
  const patch = Object.fromEntries(keys.map((key) => [key, values[key]]));
  return migrateSettings({ ...settings, ...patch });
}

function restoreCloudOnlyUrls(settings: AppSettings, cloudSettings: AppSettings): AppSettings {
  const endpoints = new Map(cloudSettings.aiIntegrations.map((entry) => [entry.id, entry.endpoint]));
  return {
    ...settings,
    azureOpenAI: { ...settings.azureOpenAI, endpoint: cloudSettings.azureOpenAI.endpoint },
    aiIntegrations: settings.aiIntegrations.map((entry) => ({ ...entry, endpoint: endpoints.get(entry.id) ?? "" })),
    deepSearch: { ...settings.deepSearch, contentProxyBaseUrl: cloudSettings.deepSearch.contentProxyBaseUrl },
  };
}

export function cacheSettings(accountScope: string, settings: AppSettings, cloudRevision: string | null): void {
  const envelope: OfflineSettingsEnvelope = { schemaVersion: SETTINGS_CACHE_SCHEMA_VERSION, accountScope, baseRevision: cloudRevision, base: projectSafeSettings(migrateSettings(settings)) };
  localStorage.setItem(cacheKey(accountScope), JSON.stringify(envelope));
  sessionStorage.setItem(credentialsKey(accountScope), JSON.stringify(extractCredentials(settings)));
}

export function cacheOfflineSettings(accountScope: string, settings: AppSettings): void {
  const current = readEnvelope(accountScope);
  const normalized = migrateSettings(settings);
  const base = current?.base ?? projectSafeSettings(normalized);
  const next = projectSafeSettings(normalized);
  const changedKeys = changedSafeKeys(base, next);
  const envelope: OfflineSettingsEnvelope = {
    schemaVersion: SETTINGS_CACHE_SCHEMA_VERSION,
    accountScope,
    baseRevision: current?.baseRevision ?? null,
    base,
    ...(changedKeys.length ? { pending: { revision: (current?.pending?.revision ?? 0) + 1, updatedAt: new Date().toISOString(), changedKeys, values: Object.fromEntries(changedKeys.map((key) => [key, next[key]])) as Partial<SafeSettingsProjection> } } : {}),
  };
  localStorage.setItem(cacheKey(accountScope), JSON.stringify(envelope));
  sessionStorage.setItem(credentialsKey(accountScope), JSON.stringify(extractCredentials(settings)));
}

export function loadCachedSettings(accountScope: string): AppSettings | null {
  const envelope = readEnvelope(accountScope);
  if (!envelope) return null;
  const safe = envelope.pending ? mergeSafe(migrateSettings({ ...DEFAULT_SETTINGS, ...envelope.base }), envelope.pending.values, envelope.pending.changedKeys) : migrateSettings({ ...DEFAULT_SETTINGS, ...envelope.base });
  return applyCredentials(safe, readSessionCredentials(accountScope));
}

export function loadCachedSettingsForHydration(accountScope: string): CachedSettingsHydration | null {
  const settings = loadCachedSettings(accountScope);
  return settings ? { settings, accountIdentity: accountScope, source: { kind: "offline-cache", schemaVersion: SETTINGS_CACHE_SCHEMA_VERSION } } : null;
}

export function reconcileCachedSettings(accountScope: string, cloudSettings: AppSettings, cloudRevision: string): SettingsReconciliation {
  const envelope = readEnvelope(accountScope);
  const cloudWithSessionCredentials = applyCredentials(cloudSettings, extractCredentials(cloudSettings));
  if (!envelope?.pending) return { settings: cloudWithSessionCredentials, kind: "cloud", changedKeys: [] };
  const merged = applyCredentials(restoreCloudOnlyUrls(mergeSafe(cloudSettings, envelope.pending.values, envelope.pending.changedKeys), cloudSettings), extractCredentials(cloudSettings));
  return { settings: merged, kind: envelope.baseRevision === cloudRevision ? "merged" : "conflict", changedKeys: envelope.pending.changedKeys };
}

export function clearSettingsCache(accountScope: string): void {
  localStorage.removeItem(cacheKey(accountScope));
  sessionStorage.removeItem(credentialsKey(accountScope));
}
