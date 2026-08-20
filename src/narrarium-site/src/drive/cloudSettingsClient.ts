import { CHAT_CAPABILITIES, DEFAULT_SETTINGS, type AIIntegration, type AppSettings, type ChatCapability, type ChatModel, type CustomAction, type RoutingTarget } from "@/types/settings";
import type { AuthProvider } from "@/store/authStore";
import { BROWSER_ROUTING_ID, sanitizeTaskRouting } from "@/assistant/router";
import { ensureGoogleAppFolder } from "@/drive/googleAppFolder";
import { beginCloudWrite, fencedCloudMutation } from "@/drive/cloudWriteBarrier";
import { ensureMicrosoftAppMarker, graphPath, ONE_DRIVE_APP_FOLDER } from "@/drive/microsoftAppFolder";

export class TokenExpiredError extends Error {
  constructor() {
    super("Cloud access token expired");
    this.name = "TokenExpiredError";
  }
}

const GOOGLE_DRIVE_API = "https://www.googleapis.com/drive/v3";
const GOOGLE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const GRAPH_DRIVE_API = "https://graph.microsoft.com/v1.0/me/drive";
const SETTINGS_FILE_NAME = "settings.json";
const MIME_JSON = "application/json";
export interface CloudSettingsHandle { settings: AppSettings; fileId: string; revision: string; diagnostics: string[] }

export async function loadCloudSettings(
  provider: AuthProvider,
  accessToken: string,
): Promise<CloudSettingsHandle> {
  const release = await beginCloudWrite(provider, accessToken);
  try {
    return await (provider === "microsoft" ? loadMicrosoftSettings(accessToken) : loadGoogleSettings(accessToken));
  } finally { release(); }
}

export async function loadCloudSettingsForMigration(provider: AuthProvider, accessToken: string): Promise<CloudSettingsHandle> {
  const release = await beginCloudWrite(provider, accessToken);
  try {
    return await (provider === "microsoft" ? loadMicrosoftSettings(accessToken, true) : loadGoogleSettings(accessToken, true));
  } finally { release(); }
}

export async function saveCloudSettings(
  provider: AuthProvider,
  accessToken: string,
  settings: AppSettings,
  expected?: { fileId: string | null; revision: string | null },
): Promise<{ fileId: string; revision: string }> {
  const endWrite = await beginCloudWrite(provider, accessToken);
  try {
    return await (provider === "microsoft"
      ? saveMicrosoftSettings(accessToken, settings, expected)
      : saveGoogleSettings(accessToken, settings, expected));
  } finally {
    endWrite();
  }
}

function assertOk(response: Response, context: string): void {
  if (response.status === 401) throw new TokenExpiredError();
  if (!response.ok) throw new Error(`${context}: ${response.status}`);
}

function authHeaders(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` };
}

async function googleFindSettingsFile(accessToken: string, folderId: string): Promise<{ id: string } | null> {
  const query = new URLSearchParams({
    q: `name='${SETTINGS_FILE_NAME}' and '${folderId}' in parents and trashed=false`,
    spaces: "drive",
    fields: "files(id,createdTime)",
  });
  const response = await fetch(`${GOOGLE_DRIVE_API}/files?${query}`, {
    headers: authHeaders(accessToken),
  });
  assertOk(response, "Google Drive settings lookup");
  const data = (await response.json()) as { files?: Array<{ id: string; createdTime?: string }> };
  const file = [...(data.files ?? [])].sort((a, b) => (a.createdTime ?? "").localeCompare(b.createdTime ?? "") || a.id.localeCompare(b.id))[0];
  return file ? { id: file.id } : null;
}

interface GoogleFileMetadata { id: string; version: string; modifiedTime?: string; md5Checksum?: string }

function googleRevisionToken(metadata: GoogleFileMetadata): string {
  if (typeof metadata.id !== "string" || !metadata.id || typeof metadata.version !== "string" || !metadata.version.trim()) {
    throw new Error("Google Drive did not provide a valid settings version.");
  }
  return `gdrive:${btoa(JSON.stringify([metadata.id, metadata.version])).replace(/=+$/, "")}`;
}

async function googleFileRevision(accessToken: string, fileId: string): Promise<{ metadata: GoogleFileMetadata; revision: string }> {
  const fields = "id,version,modifiedTime,md5Checksum";
  const response = await fetch(`${GOOGLE_DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=${fields}`, { headers: authHeaders(accessToken) });
  assertOk(response, "Google Drive settings revision");
  const metadata = await response.json() as GoogleFileMetadata;
  if (metadata.id !== fileId) throw new Error("Google Drive returned metadata for a different settings file.");
  return { metadata, revision: googleRevisionToken(metadata) };
}

async function loadGoogleSettings(accessToken: string, strict = false): Promise<CloudSettingsHandle> {
  const folderId = await ensureGoogleAppFolder(accessToken);
  const file = await googleFindSettingsFile(accessToken, folderId);
  if (!file) {
    if (strict) throw new Error("Source settings file is missing.");
    const created = await saveGoogleSettings(accessToken, DEFAULT_SETTINGS, { fileId: null, revision: null });
    return { settings: DEFAULT_SETTINGS, ...created, diagnostics: [] };
  }

  const before = await googleFileRevision(accessToken, file.id);
  const response = await fetch(`${GOOGLE_DRIVE_API}/files/${file.id}?alt=media`, {
    headers: authHeaders(accessToken),
  });
  assertOk(response, "Google Drive settings download");
  const raw = await response.json();
  const after = await googleFileRevision(accessToken, file.id);
  if (after.revision !== before.revision) throw new Error("Google Drive settings changed while they were downloading. Reload and retry.");
  if (strict && !isValidSettingsSource(raw)) throw new Error("Source settings are malformed.");
  const migrated = migrateSettingsWithDiagnostics(raw);
  return { ...migrated, fileId: file.id, revision: after.revision };
}

async function saveGoogleSettings(accessToken: string, settings: AppSettings, expected?: { fileId: string | null; revision: string | null }): Promise<{ fileId: string; revision: string }> {
  const folderId = await ensureGoogleAppFolder(accessToken);
  const file = await googleFindSettingsFile(accessToken, folderId);
  const json = JSON.stringify(settings, null, 2);

  if (file) {
    if (!expected?.fileId || expected.fileId !== file.id || !expected.revision) throw new Error("Cloud settings changed or were not loaded. Reload before saving.");
    const before = await googleFileRevision(accessToken, file.id);
    if (before.revision !== expected.revision) throw new Error("Cloud settings changed since they were loaded. Reload before saving.");
    let response: Response;
    try {
      response = await fencedCloudMutation("google", accessToken, `${GOOGLE_UPLOAD_API}/files/${file.id}?uploadType=media&fields=id`, {
        method: "PATCH",
        headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON },
        body: json,
      });
    } catch (error) {
      const reconciled = await reconcileAmbiguousGoogleUpdate(accessToken, file.id, before.revision, settings);
      if (reconciled) return { fileId: file.id, revision: reconciled };
      throw error;
    }
    if (!response.ok && response.status !== 401) {
      const reconciled = await reconcileAmbiguousGoogleUpdate(accessToken, file.id, before.revision, settings);
      if (reconciled) return { fileId: file.id, revision: reconciled };
    }
    assertOk(response, "Google Drive settings update");
    const after = await googleFileRevision(accessToken, file.id);
    if (after.revision === before.revision) throw new Error("Google Drive settings update did not advance the file version.");
    return { fileId: file.id, revision: after.revision };
  }
  if (expected?.fileId) throw new Error("Cloud settings were deleted. Reload before saving.");

  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({ name: SETTINGS_FILE_NAME, parents: [folderId] })], { type: MIME_JSON }));
  form.append("file", new Blob([json], { type: MIME_JSON }));
  const response = await fencedCloudMutation("google", accessToken, `${GOOGLE_UPLOAD_API}/files?uploadType=multipart&fields=id`, {
    method: "POST",
    headers: authHeaders(accessToken),
    body: form,
  });
  assertOk(response, "Google Drive settings create");
  const data = (await response.json()) as { id: string };
  const canonical = await googleFindSettingsFile(accessToken, folderId);
  if (!canonical) throw new Error("Google Drive settings create could not be reconciled.");
  if (canonical.id !== data.id) {
    const canonicalContent = await fetch(`${GOOGLE_DRIVE_API}/files/${canonical.id}?alt=media`, { headers: authHeaders(accessToken) });
    assertOk(canonicalContent, "Google Drive canonical settings download");
    const same = JSON.stringify(await canonicalContent.json()) === JSON.stringify(settings);
    await fencedCloudMutation("google", accessToken, `${GOOGLE_DRIVE_API}/files/${data.id}`, { method: "DELETE", headers: authHeaders(accessToken) });
    if (!same) throw new Error("A concurrent Google settings creation contains different data. Reload before saving.");
  }
  const { revision } = await googleFileRevision(accessToken, canonical.id);
  return { fileId: canonical.id, revision };
}

async function reconcileAmbiguousGoogleUpdate(accessToken: string, fileId: string, previousRevision: string, settings: AppSettings): Promise<string | null> {
  const beforeDownload = await googleFileRevision(accessToken, fileId);
  if (beforeDownload.revision === previousRevision) return null;
  const content = await fetch(`${GOOGLE_DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`, { headers: authHeaders(accessToken) });
  assertOk(content, "Google Drive ambiguous settings update reconciliation");
  const matches = JSON.stringify(await content.json()) === JSON.stringify(settings);
  const afterDownload = await googleFileRevision(accessToken, fileId);
  return matches && afterDownload.revision === beforeDownload.revision ? afterDownload.revision : null;
}

async function ensureMicrosoftFolderPath(accessToken: string, folderPath: string): Promise<void> {
  const parts = folderPath.split("/").filter(Boolean);
  let currentPath = "";
  for (const part of parts) {
    const nextPath = currentPath ? `${currentPath}/${part}` : part;
    const exists = await fetch(`${GRAPH_DRIVE_API}/root:/${graphPath(nextPath)}`, {
      headers: authHeaders(accessToken),
    });
    if (exists.status === 401) throw new TokenExpiredError();
    if (exists.ok) {
      currentPath = nextPath;
      continue;
    }
    if (exists.status !== 404) throw new Error(`OneDrive folder lookup: ${exists.status}`);

    const createUrl = currentPath
      ? `${GRAPH_DRIVE_API}/root:/${graphPath(currentPath)}:/children`
      : `${GRAPH_DRIVE_API}/root/children`;
    const created = await fencedCloudMutation("microsoft", accessToken, createUrl, {
      method: "POST",
      headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON },
      body: JSON.stringify({ name: part, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
    });
    if (created.status !== 409) assertOk(created, "OneDrive folder create");
    currentPath = nextPath;
  }
  if (folderPath === ONE_DRIVE_APP_FOLDER) await ensureMicrosoftAppMarker(accessToken);
}

async function loadMicrosoftSettings(accessToken: string, strict = false): Promise<CloudSettingsHandle> {
  await ensureMicrosoftFolderPath(accessToken, ONE_DRIVE_APP_FOLDER);
  const meta = await fetch(`${GRAPH_DRIVE_API}/root:/${graphPath(ONE_DRIVE_APP_FOLDER)}/${encodeURIComponent(SETTINGS_FILE_NAME)}`, {
    headers: authHeaders(accessToken),
  });

  if (meta.status === 404) {
    if (strict) throw new Error("Source settings file is missing.");
    const created = await saveMicrosoftSettings(accessToken, DEFAULT_SETTINGS, { fileId: null, revision: null });
    return { settings: DEFAULT_SETTINGS, ...created, diagnostics: [] };
  }
  assertOk(meta, "OneDrive settings lookup");
  const metaData = (await meta.json()) as MicrosoftDriveItem;
  const revision = microsoftRevision(metaData, meta);
  if (!metaData.id || !revision) throw new Error("OneDrive did not provide a settings revision.");
  const file = await fetch(`${GRAPH_DRIVE_API}/items/${metaData.id}/content`, {
    headers: authHeaders(accessToken),
  });
  assertOk(file, "OneDrive settings download");
  const raw = await file.json();
  if (strict && !isValidSettingsSource(raw)) throw new Error("Source settings are malformed.");
  const migrated = migrateSettingsWithDiagnostics(raw);
  return { ...migrated, fileId: metaData.id, revision };
}

interface MicrosoftDriveItem { id?: string; eTag?: string; "@odata.etag"?: string }

function microsoftRevision(item: MicrosoftDriveItem, response?: Response): string | null {
  for (const value of [item.eTag, item["@odata.etag"], response?.headers.get("etag")]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

async function microsoftMetadataRevision(accessToken: string, itemId: string | undefined, itemUrl: string): Promise<{ fileId: string; revision: string }> {
  const url = itemId ? `${GRAPH_DRIVE_API}/items/${encodeURIComponent(itemId)}` : itemUrl;
  const response = await fetch(url, { headers: authHeaders(accessToken) });
  assertOk(response, "OneDrive settings metadata");
  const item = await response.json() as MicrosoftDriveItem;
  const revision = microsoftRevision(item, response);
  if (!item.id || !revision) throw new Error("OneDrive did not provide a settings revision.");
  return { fileId: item.id, revision };
}

async function saveMicrosoftSettings(accessToken: string, settings: AppSettings, expected?: { fileId: string | null; revision: string | null }): Promise<{ fileId: string; revision: string }> {
  await ensureMicrosoftFolderPath(accessToken, ONE_DRIVE_APP_FOLDER);
  const itemUrl = `${GRAPH_DRIVE_API}/root:/${graphPath(ONE_DRIVE_APP_FOLDER)}/${encodeURIComponent(SETTINGS_FILE_NAME)}`;
  const current = await fetch(itemUrl, { headers: authHeaders(accessToken) });
  if (!(current.ok || current.status === 404)) assertOk(current, "OneDrive settings revision");
  const item = current.ok ? await current.json() as MicrosoftDriveItem : null;
  if (item) {
    if (!expected?.fileId || expected.fileId !== item.id || !expected.revision) throw new Error("Cloud settings changed or were not loaded. Reload before saving.");
    const currentRevision = microsoftRevision(item, current);
    if (!currentRevision) throw new Error("OneDrive did not provide a settings revision.");
    if (currentRevision !== expected.revision) throw new Error("Cloud settings changed since they were loaded. Reload before saving.");
  } else if (expected?.fileId) throw new Error("Cloud settings were deleted. Reload before saving.");
  const response = await fencedCloudMutation("microsoft", accessToken, `${itemUrl}:/content`, {
    method: "PUT",
    headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON, ...(item ? { "If-Match": expected!.revision! } : { "If-None-Match": "*" }) },
    body: JSON.stringify(settings, null, 2),
  });
  assertOk(response, "OneDrive settings save");
  let data: MicrosoftDriveItem = {};
  try { data = await response.json() as MicrosoftDriveItem; } catch { /* Metadata lookup below handles an empty provider response. */ }
  const revision = microsoftRevision(data, response);
  if (data.id && revision) return { fileId: data.id, revision };
  return microsoftMetadataRevision(accessToken, data.id ?? item?.id, itemUrl);
}

export function migrateSettings(raw: unknown): AppSettings {
  return migrateSettingsWithDiagnostics(raw).settings;
}

export function migrateSettingsWithDiagnostics(raw: unknown): { settings: AppSettings; diagnostics: string[] } {
  const diagnostics: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    diagnostics.push("Cloud settings were malformed and reset to defaults.");
    return { settings: DEFAULT_SETTINGS, diagnostics };
  }
  const source = raw as Partial<AppSettings> & { version?: number };
  const azureOpenAI = {
    ...DEFAULT_SETTINGS.azureOpenAI,
    ...(typeof source.azureOpenAI === "object" && source.azureOpenAI ? source.azureOpenAI : {}),
  };

  const migratedAzureIntegration: AIIntegration | null =
    source.aiIntegrations?.length || (!azureOpenAI.endpoint && !azureOpenAI.apiKey)
      ? null
      : {
          id: "default-azure-openai",
          name: "Azure OpenAI",
          provider: "azure_openai",
          endpoint: azureOpenAI.endpoint,
          apiKey: azureOpenAI.apiKey,
          modelWriting: azureOpenAI.model,
          modelReview: azureOpenAI.model,
          apiVersion: azureOpenAI.apiVersion,
        };

  const aiIntegrations = [
    ...(Array.isArray(source.aiIntegrations) ? source.aiIntegrations : []),
    ...(migratedAzureIntegration ? [migratedAzureIntegration] : []),
  ].map(ensureChatModels);
  const sourceReader = typeof source.reader === "object" && source.reader ? source.reader : {};

  const customActions = source.customActionsSchemaVersion !== undefined && source.customActionsSchemaVersion !== 1
    ? (diagnostics.push("Custom actions use an unsupported schema version and were quarantined."), [])
    : normalizeCustomActions(source.customActions, diagnostics);
  const settings: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...source,
    version: 2,
    defaultGitHubToken: typeof source.defaultGitHubToken === "string" ? source.defaultGitHubToken : "",
    extraGitHubTokens: Array.isArray(source.extraGitHubTokens) ? source.extraGitHubTokens : [],
    azureOpenAI,
    aiIntegrations,
    defaultWritingIntegrationId: aiIntegrations.some((entry) => entry.id === source.defaultWritingIntegrationId) ? source.defaultWritingIntegrationId : aiIntegrations[0]?.id,
    defaultReviewIntegrationId: aiIntegrations.some((entry) => entry.id === source.defaultReviewIntegrationId) ? source.defaultReviewIntegrationId : aiIntegrations[0]?.id,
    ui: {
      ...DEFAULT_SETTINGS.ui,
      ...(typeof source.ui === "object" && source.ui ? source.ui : {}),
    },
    speech: {
      ...DEFAULT_SETTINGS.speech,
      ...(typeof source.speech === "object" && source.speech ? source.speech : {}),
    },
    repository: {
      ...DEFAULT_SETTINGS.repository,
      ...(typeof source.repository === "object" && source.repository ? source.repository : {}),
    },
    reader: {
      ...DEFAULT_SETTINGS.reader,
      ...sourceReader,
      bookmarks: Array.isArray((sourceReader as Partial<AppSettings["reader"]>).bookmarks) ? (sourceReader as Partial<AppSettings["reader"]>).bookmarks! : [],
    },
    copilotTools: normalizeCopilotTools(source.copilotTools, diagnostics),
    customActionsSchemaVersion: 1,
    customActions,
    books: Array.isArray(source.books) ? source.books : [],
    taskRouting: normalizeTaskRouting(source.taskRouting, aiIntegrations),
    fallbackDisclosure: {
      ...DEFAULT_SETTINGS.fallbackDisclosure,
      ...(typeof source.fallbackDisclosure === "object" && source.fallbackDisclosure ? source.fallbackDisclosure : {}),
    },
    routingExecution: normalizeRoutingExecution(source.routingExecution),
  };
  return { settings, diagnostics };
}

function normalizeRoutingExecution(raw: unknown): AppSettings["routingExecution"] {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const bounded = (key: keyof AppSettings["routingExecution"], min: number, max: number) => {
    const value = source[key];
    return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : DEFAULT_SETTINGS.routingExecution[key];
  };
  return {
    maxCandidates: Math.floor(bounded("maxCandidates", 1, 8)),
    maxTotalDurationMs: Math.floor(bounded("maxTotalDurationMs", 1_000, 600_000)),
    maxTokenAttempts: Math.floor(bounded("maxTokenAttempts", 1_000, 2_000_000)),
    maxEstimatedCost: bounded("maxEstimatedCost", 0.01, 1_000),
  };
}

function normalizeCopilotTools(raw: unknown, diagnostics: string[]): AppSettings["copilotTools"] {
  if (raw == null) return { ...DEFAULT_SETTINGS.copilotTools, toolOverrides: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    diagnostics.push("Copilot tool settings were malformed and reset to defaults.");
    return { ...DEFAULT_SETTINGS.copilotTools, toolOverrides: {} };
  }
  if ("schemaVersion" in raw && (raw as { schemaVersion?: unknown }).schemaVersion !== 1) {
    diagnostics.push("Copilot tool settings use an unsupported schema version and were reset to defaults.");
    return { ...DEFAULT_SETTINGS.copilotTools, toolOverrides: {} };
  }
  const overrides = (raw as Record<string, unknown>).toolOverrides;
  if (overrides == null) return { ...DEFAULT_SETTINGS.copilotTools, toolOverrides: {} };
  if (typeof overrides !== "object" || Array.isArray(overrides)) {
    diagnostics.push("Copilot tool overrides were malformed and reset to defaults.");
    return { ...DEFAULT_SETTINGS.copilotTools, toolOverrides: {} };
  }
  const toolOverrides: AppSettings["copilotTools"]["toolOverrides"] = {};
  for (const [id, value] of Object.entries(overrides)) {
    if (!id.trim() || !value || typeof value !== "object" || Array.isArray(value) || ("enabled" in value && typeof (value as { enabled?: unknown }).enabled !== "boolean")) {
      diagnostics.push(`Copilot tool override "${id || "(empty)"}" was ignored because it is malformed.`);
      continue;
    }
    toolOverrides[id] = "enabled" in value ? { enabled: (value as { enabled: boolean }).enabled } : {};
  }
  return { schemaVersion: 1, toolOverrides };
}

function normalizeCustomActions(raw: unknown, diagnostics: string[]): CustomAction[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    diagnostics.push("Custom actions were malformed and quarantined.");
    return [];
  }
  const actions: CustomAction[] = [];
  const ids = new Set<string>();
  raw.forEach((value, index) => {
    const action = normalizeCustomAction(value);
    if (!action || ids.has(action.id)) {
      diagnostics.push(`Custom action ${index + 1} was quarantined because it is malformed or has a duplicate ID.`);
      return;
    }
    ids.add(action.id);
    actions.push(action);
  });
  return actions;
}

function normalizeCustomAction(value: unknown): CustomAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id.trim() || typeof raw.name !== "string" || typeof raw.prompt !== "string") return null;
  if (raw.capability !== undefined && !CHAT_CAPABILITIES.includes(raw.capability as ChatCapability)) return null;
  if (raw.activation !== undefined && raw.activation !== "selection" && raw.activation !== "element") return null;
  if (raw.outputMode !== undefined && raw.outputMode !== "show" && raw.outputMode !== "replace") return null;
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") return null;
  if (raw.targetTypes !== undefined && (!Array.isArray(raw.targetTypes) || raw.targetTypes.some((target) => typeof target !== "string" || !target.trim()))) return null;
  if (raw.injections !== undefined && (!raw.injections || typeof raw.injections !== "object" || Array.isArray(raw.injections))) return null;
  const injections = (raw.injections ?? {}) as Record<string, unknown>;
  const injectionKeys = ["includeBody", "includeFrontmatter", "includeContext", "includeGhostwriter"] as const;
  if (injectionKeys.some((key) => injections[key] !== undefined && typeof injections[key] !== "boolean")) return null;
  return {
    id: raw.id,
    name: raw.name,
    prompt: raw.prompt,
    capability: (raw.capability as ChatCapability | undefined) ?? "default",
    targetTypes: (raw.targetTypes as string[] | undefined) ?? ["*"],
    activation: (raw.activation as CustomAction["activation"] | undefined) ?? "selection",
    injections: {
      includeBody: (injections.includeBody as boolean | undefined) ?? true,
      includeFrontmatter: (injections.includeFrontmatter as boolean | undefined) ?? false,
      includeContext: (injections.includeContext as boolean | undefined) ?? true,
      includeGhostwriter: (injections.includeGhostwriter as boolean | undefined) ?? true,
    },
    outputMode: (raw.outputMode as CustomAction["outputMode"] | undefined) ?? "show",
    enabled: (raw.enabled as boolean | undefined) ?? true,
  };
}

export function isValidSettingsSource(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const source = raw as Record<string, unknown>;
  const ui = source.ui as Record<string, unknown> | undefined;
  return (source.version === 1 || source.version === 2)
    && Array.isArray(source.books)
    && typeof source.defaultGitHubToken === "string"
    && Boolean(ui && (ui.language === "en" || ui.language === "it"));
}

/** Drop router targets pointing at integrations/models that no longer exist. */
function normalizeTaskRouting(
  raw: unknown,
  integrations: AIIntegration[],
): AppSettings["taskRouting"] {
  if (!raw || typeof raw !== "object") return undefined;
  const byId = new Map(integrations.map((i) => [i.id, i]));
  const validTarget = (t: unknown, task: string): t is RoutingTarget => {
    if (!t || typeof t !== "object") return false;
    const target = t as RoutingTarget;
    if (target.integrationId === BROWSER_ROUTING_ID) {
      return task === "stt" || task === "tts";
    }
    const integration = byId.get(target.integrationId);
    if (!integration || !target.model) return false;
    return true;
  };
  const normalizeTarget = (target: RoutingTarget): RoutingTarget => {
    if (target.integrationId === BROWSER_ROUTING_ID) {
      return { integrationId: BROWSER_ROUTING_ID, model: "browser" };
    }
    return { integrationId: target.integrationId, model: target.model.trim() };
  };
  const out: NonNullable<AppSettings["taskRouting"]> = {};
  for (const [task, route] of Object.entries(raw as Record<string, unknown>)) {
    if (!route || typeof route !== "object") continue;
    const r = route as { primary?: unknown; fallbacks?: unknown };
    const primary = validTarget(r.primary, task) ? normalizeTarget(r.primary as RoutingTarget) : undefined;
    const fallbacks = Array.isArray(r.fallbacks)
      ? r.fallbacks.filter((target) => validTarget(target, task)).map((target) => normalizeTarget(target as RoutingTarget))
      : [];
    if (primary || fallbacks.length) out[task as keyof typeof out] = { primary, fallbacks };
  }
  return sanitizeTaskRouting(Object.keys(out).length ? out : undefined, integrations);
}

/**
 * Backward-compatible upgrade: give every integration a chatModels[] list.
 * If it already has one, keep it. Otherwise synthesise entries from the legacy
 * modelWriting/modelReview fields, tagging capabilities so routing keeps working.
 */
function ensureChatModels(integration: AIIntegration): AIIntegration {
  if (Array.isArray(integration.chatModels) && integration.chatModels.length) return integration;
  const chatModels: ChatModel[] = [];
  const writing = integration.modelWriting?.trim();
  const review = integration.modelReview?.trim();
  if (writing) {
    const caps: ChatCapability[] = ["default", "copilot", "simple-tasks"];
    if (!review || review === writing) caps.push("review");
    chatModels.push({ id: "legacy-writing", name: writing, capabilities: caps, pricing: integration.pricing });
  }
  if (review && review !== writing) {
    chatModels.push({ id: "legacy-review", name: review, capabilities: ["review"], pricing: integration.pricing });
  }
  if (!chatModels.length) return integration;
  return { ...integration, chatModels };
}
