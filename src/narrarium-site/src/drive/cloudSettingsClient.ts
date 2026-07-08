import { DEFAULT_SETTINGS, type AIIntegration, type AppSettings, type ChatCapability, type ChatModel, type RoutingTarget } from "@/types/settings";
import type { AuthProvider } from "@/store/authStore";

export class TokenExpiredError extends Error {
  constructor() {
    super("Cloud access token expired");
    this.name = "TokenExpiredError";
  }
}

const GOOGLE_DRIVE_API = "https://www.googleapis.com/drive/v3";
const GOOGLE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const GRAPH_DRIVE_API = "https://graph.microsoft.com/v1.0/me/drive";
const APP_FOLDER = "Narrarium";
const ONE_DRIVE_APP_FOLDER = "Apps/Narrarium";
const SETTINGS_FILE_NAME = "settings.json";
const MIME_JSON = "application/json";

export async function loadCloudSettings(
  provider: AuthProvider,
  accessToken: string,
): Promise<{ settings: AppSettings; fileId: string }> {
  return provider === "microsoft"
    ? loadMicrosoftSettings(accessToken)
    : loadGoogleSettings(accessToken);
}

export async function saveCloudSettings(
  provider: AuthProvider,
  accessToken: string,
  settings: AppSettings,
): Promise<string> {
  return provider === "microsoft"
    ? saveMicrosoftSettings(accessToken, settings)
    : saveGoogleSettings(accessToken, settings);
}

function assertOk(response: Response, context: string): void {
  if (response.status === 401) throw new TokenExpiredError();
  if (!response.ok) throw new Error(`${context}: ${response.status}`);
}

function authHeaders(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` };
}

async function googleFindOrCreateFolder(accessToken: string): Promise<string> {
  const query = new URLSearchParams({
    q: `name='${APP_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    spaces: "drive",
    fields: "files(id,name)",
  });
  const found = await fetch(`${GOOGLE_DRIVE_API}/files?${query}`, {
    headers: authHeaders(accessToken),
  });
  assertOk(found, "Google Drive folder lookup");
  const foundData = (await found.json()) as { files?: Array<{ id: string }> };
  if (foundData.files?.[0]?.id) return foundData.files[0].id;

  const created = await fetch(`${GOOGLE_DRIVE_API}/files?fields=id`, {
    method: "POST",
    headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON },
    body: JSON.stringify({ name: APP_FOLDER, mimeType: "application/vnd.google-apps.folder" }),
  });
  assertOk(created, "Google Drive folder create");
  const createdData = (await created.json()) as { id: string };
  return createdData.id;
}

async function googleFindSettingsFile(accessToken: string, folderId: string): Promise<string | null> {
  const query = new URLSearchParams({
    q: `name='${SETTINGS_FILE_NAME}' and '${folderId}' in parents and trashed=false`,
    spaces: "drive",
    fields: "files(id)",
  });
  const response = await fetch(`${GOOGLE_DRIVE_API}/files?${query}`, {
    headers: authHeaders(accessToken),
  });
  assertOk(response, "Google Drive settings lookup");
  const data = (await response.json()) as { files?: Array<{ id: string }> };
  return data.files?.[0]?.id ?? null;
}

async function loadGoogleSettings(accessToken: string): Promise<{ settings: AppSettings; fileId: string }> {
  const folderId = await googleFindOrCreateFolder(accessToken);
  const fileId = await googleFindSettingsFile(accessToken, folderId);
  if (!fileId) {
    const createdId = await saveGoogleSettings(accessToken, DEFAULT_SETTINGS);
    return { settings: DEFAULT_SETTINGS, fileId: createdId };
  }

  const response = await fetch(`${GOOGLE_DRIVE_API}/files/${fileId}?alt=media`, {
    headers: authHeaders(accessToken),
  });
  assertOk(response, "Google Drive settings download");
  return { settings: migrateSettings(await response.json()), fileId };
}

async function saveGoogleSettings(accessToken: string, settings: AppSettings): Promise<string> {
  const folderId = await googleFindOrCreateFolder(accessToken);
  const fileId = await googleFindSettingsFile(accessToken, folderId);
  const json = JSON.stringify(settings, null, 2);

  if (fileId) {
    const response = await fetch(`${GOOGLE_UPLOAD_API}/files/${fileId}?uploadType=media`, {
      method: "PATCH",
      headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON },
      body: json,
    });
    assertOk(response, "Google Drive settings update");
    return fileId;
  }

  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({ name: SETTINGS_FILE_NAME, parents: [folderId] })], { type: MIME_JSON }));
  form.append("file", new Blob([json], { type: MIME_JSON }));
  const response = await fetch(`${GOOGLE_UPLOAD_API}/files?uploadType=multipart&fields=id`, {
    method: "POST",
    headers: authHeaders(accessToken),
    body: form,
  });
  assertOk(response, "Google Drive settings create");
  const data = (await response.json()) as { id: string };
  return data.id;
}

async function ensureMicrosoftFolderPath(accessToken: string, folderPath: string): Promise<void> {
  const parts = folderPath.split("/").filter(Boolean);
  let currentPath = "";
  for (const part of parts) {
    const nextPath = currentPath ? `${currentPath}/${part}` : part;
    const exists = await fetch(`${GRAPH_DRIVE_API}/root:/${nextPath}`, {
      headers: authHeaders(accessToken),
    });
    if (exists.status === 401) throw new TokenExpiredError();
    if (exists.ok) {
      currentPath = nextPath;
      continue;
    }
    if (exists.status !== 404) throw new Error(`OneDrive folder lookup: ${exists.status}`);

    const createUrl = currentPath
      ? `${GRAPH_DRIVE_API}/root:/${currentPath}:/children`
      : `${GRAPH_DRIVE_API}/root/children`;
    const created = await fetch(createUrl, {
      method: "POST",
      headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON },
      body: JSON.stringify({ name: part, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
    });
    if (created.status !== 409) assertOk(created, "OneDrive folder create");
    currentPath = nextPath;
  }
}

async function loadMicrosoftSettings(accessToken: string): Promise<{ settings: AppSettings; fileId: string }> {
  await ensureMicrosoftFolderPath(accessToken, ONE_DRIVE_APP_FOLDER);
  const meta = await fetch(`${GRAPH_DRIVE_API}/root:/${ONE_DRIVE_APP_FOLDER}/${SETTINGS_FILE_NAME}`, {
    headers: authHeaders(accessToken),
  });

  if (meta.status === 404) {
    const fileId = await saveMicrosoftSettings(accessToken, DEFAULT_SETTINGS);
    return { settings: DEFAULT_SETTINGS, fileId };
  }
  assertOk(meta, "OneDrive settings lookup");
  const metaData = (await meta.json()) as { id: string };
  const file = await fetch(`${GRAPH_DRIVE_API}/items/${metaData.id}/content`, {
    headers: authHeaders(accessToken),
  });
  assertOk(file, "OneDrive settings download");
  return { settings: migrateSettings(await file.json()), fileId: metaData.id };
}

async function saveMicrosoftSettings(accessToken: string, settings: AppSettings): Promise<string> {
  await ensureMicrosoftFolderPath(accessToken, ONE_DRIVE_APP_FOLDER);
  const response = await fetch(`${GRAPH_DRIVE_API}/root:/${ONE_DRIVE_APP_FOLDER}/${SETTINGS_FILE_NAME}:/content`, {
    method: "PUT",
    headers: { ...authHeaders(accessToken), "Content-Type": MIME_JSON },
    body: JSON.stringify(settings, null, 2),
  });
  assertOk(response, "OneDrive settings save");
  const data = (await response.json()) as { id: string };
  return data.id;
}

function migrateSettings(raw: unknown): AppSettings {
  if (!raw || typeof raw !== "object") return DEFAULT_SETTINGS;
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

  return {
    ...DEFAULT_SETTINGS,
    ...source,
    version: 2,
    defaultGitHubToken: typeof source.defaultGitHubToken === "string" ? source.defaultGitHubToken : "",
    extraGitHubTokens: Array.isArray(source.extraGitHubTokens) ? source.extraGitHubTokens : [],
    azureOpenAI,
    aiIntegrations,
    defaultWritingIntegrationId: source.defaultWritingIntegrationId ?? aiIntegrations[0]?.id,
    defaultReviewIntegrationId: source.defaultReviewIntegrationId ?? aiIntegrations[0]?.id,
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
    customActions: Array.isArray(source.customActions) ? source.customActions : [],
    books: Array.isArray(source.books) ? source.books : [],
    taskRouting: normalizeTaskRouting(source.taskRouting, aiIntegrations),
  };
}

/** Drop router targets pointing at integrations/models that no longer exist. */
function normalizeTaskRouting(
  raw: unknown,
  integrations: AIIntegration[],
): AppSettings["taskRouting"] {
  if (!raw || typeof raw !== "object") return undefined;
  const byId = new Map(integrations.map((i) => [i.id, i]));
  const validTarget = (t: unknown): t is RoutingTarget => {
    if (!t || typeof t !== "object") return false;
    const target = t as RoutingTarget;
    const integration = byId.get(target.integrationId);
    if (!integration || !target.model) return false;
    return true;
  };
  const out: NonNullable<AppSettings["taskRouting"]> = {};
  for (const [task, route] of Object.entries(raw as Record<string, unknown>)) {
    if (!route || typeof route !== "object") continue;
    const r = route as { primary?: unknown; fallbacks?: unknown };
    const primary = validTarget(r.primary) ? (r.primary as RoutingTarget) : undefined;
    const fallbacks = Array.isArray(r.fallbacks) ? r.fallbacks.filter(validTarget) as RoutingTarget[] : [];
    if (primary || fallbacks.length) out[task as keyof typeof out] = { primary, fallbacks };
  }
  return Object.keys(out).length ? out : undefined;
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
