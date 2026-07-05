import type { AuthProvider } from "@/store/authStore";
import { loadCloudSettings, saveCloudSettings } from "@/drive/cloudSettingsClient";
import { loadCosts, saveCosts } from "@/costs/costsCloud";
import { loadAppJson, saveAppJson } from "@/drive/jsonFile";
import {
  listAssistantSessions,
  loadAssistantSession,
  saveAssistantSession,
} from "@/assistant/chatCloud";
import type { AssistantSession } from "@/assistant/store";

const GOOGLE_DRIVE_API = "https://www.googleapis.com/drive/v3";
const GRAPH_DRIVE_API = "https://graph.microsoft.com/v1.0/me/drive";
const APP_FOLDER = "Narrarium";
const ONE_DRIVE_APP_FOLDER = "Apps/Narrarium";
const CLIPBOARD_FILE = "clipboard.json";

export interface MigrationEndpoint {
  provider: AuthProvider;
  accessToken: string;
}

export type MigrationStepKind = "settings" | "costs" | "clipboard" | "chats";

export interface MigrationStepResult {
  step: MigrationStepKind;
  ok: boolean;
  detail: string;
  count?: number;
}

export interface MigrationProgress {
  step: MigrationStepKind;
  status: "start" | "done" | "error";
  detail?: string;
  count?: number;
}

export interface CloudDeleteResult {
  deleted: boolean;
  count: number;
}

function authHeaders(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` };
}

function assertOk(response: Response, context: string): void {
  if (!(response.ok || response.status === 404)) throw new Error(`${context}: ${response.status}`);
}

/** Delete the app-owned Narrarium cloud folder for the chosen provider. */
export async function deleteNarrariumCloudData(provider: AuthProvider, accessToken: string): Promise<CloudDeleteResult> {
  if (provider === "microsoft") return deleteMicrosoftData(accessToken);
  return deleteGoogleData(accessToken);
}

async function deleteGoogleData(accessToken: string): Promise<CloudDeleteResult> {
  const params = new URLSearchParams({
    q: `name='${APP_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    spaces: "drive",
    fields: "files(id,name)",
  });
  const found = await fetch(`${GOOGLE_DRIVE_API}/files?${params}`, { headers: authHeaders(accessToken) });
  assertOk(found, "Google Drive folder lookup");
  const data = (await found.json()) as { files?: Array<{ id: string }> };
  const folders = data.files ?? [];
  for (const folder of folders) {
    const response = await fetch(`${GOOGLE_DRIVE_API}/files/${folder.id}`, {
      method: "DELETE",
      headers: authHeaders(accessToken),
    });
    assertOk(response, "Google Drive folder delete");
  }
  return { deleted: folders.length > 0, count: folders.length };
}

async function deleteMicrosoftData(accessToken: string): Promise<CloudDeleteResult> {
  const meta = await fetch(`${GRAPH_DRIVE_API}/root:/${ONE_DRIVE_APP_FOLDER}`, { headers: authHeaders(accessToken) });
  if (meta.status === 404) return { deleted: false, count: 0 };
  assertOk(meta, "OneDrive folder lookup");
  const data = (await meta.json()) as { id: string };
  const response = await fetch(`${GRAPH_DRIVE_API}/items/${data.id}`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  assertOk(response, "OneDrive folder delete");
  return { deleted: true, count: 1 };
}

/**
 * Copy everything Narrarium stores in the user's cloud (app settings incl. per-book
 * settings, costs ledger, clipboard, and all chat sessions) from a source account's
 * cloud storage to a target account's cloud storage. Existing target files are
 * overwritten. The user's active session (authStore) is never touched.
 */
export async function migrateCloudData(
  source: MigrationEndpoint,
  target: MigrationEndpoint,
  onProgress?: (progress: MigrationProgress) => void,
): Promise<MigrationStepResult[]> {
  const results: MigrationStepResult[] = [];

  // ── Settings (includes per-book settings, tokens, AI integrations, routing) ──
  onProgress?.({ step: "settings", status: "start" });
  try {
    const { settings } = await loadCloudSettings(source.provider, source.accessToken);
    await saveCloudSettings(target.provider, target.accessToken, settings);
    const bookCount = Array.isArray(settings.books) ? settings.books.length : 0;
    const result: MigrationStepResult = { step: "settings", ok: true, detail: `${bookCount}`, count: bookCount };
    results.push(result);
    onProgress?.({ step: "settings", status: "done", count: bookCount });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ step: "settings", ok: false, detail });
    onProgress?.({ step: "settings", status: "error", detail });
  }

  // ── Costs ledger ────────────────────────────────────────────────────────────
  onProgress?.({ step: "costs", status: "start" });
  try {
    const handle = await loadCosts(source.provider, source.accessToken);
    // Drop the source driveFileId so the target creates/updates its own file.
    await saveCosts(target.provider, target.accessToken, { file: handle.file });
    results.push({ step: "costs", ok: true, detail: "ok" });
    onProgress?.({ step: "costs", status: "done" });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ step: "costs", ok: false, detail });
    onProgress?.({ step: "costs", status: "error", detail });
  }

  // ── Clipboard ────────────────────────────────────────────────────────────────
  onProgress?.({ step: "clipboard", status: "start" });
  try {
    const handle = await loadAppJson<unknown[]>(source.provider, source.accessToken, CLIPBOARD_FILE);
    const items = Array.isArray(handle.data) ? handle.data : [];
    await saveAppJson(target.provider, target.accessToken, CLIPBOARD_FILE, items);
    results.push({ step: "clipboard", ok: true, detail: `${items.length}`, count: items.length });
    onProgress?.({ step: "clipboard", status: "done", count: items.length });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ step: "clipboard", ok: false, detail });
    onProgress?.({ step: "clipboard", status: "error", detail });
  }

  // ── Chat sessions (one file per session) ─────────────────────────────────────
  onProgress?.({ step: "chats", status: "start" });
  try {
    const metas = await listAssistantSessions(source.provider, source.accessToken);
    let copied = 0;
    for (const meta of metas) {
      if (!meta.fileId) continue;
      const session = await loadAssistantSession(source.provider, source.accessToken, meta.fileId);
      // Cross-provider save must NOT reuse the source file id (id namespaces differ).
      const clean: AssistantSession = { ...session, fileId: undefined };
      await saveAssistantSession(target.provider, target.accessToken, clean);
      copied += 1;
      onProgress?.({ step: "chats", status: "start", count: copied });
    }
    results.push({ step: "chats", ok: true, detail: `${copied}`, count: copied });
    onProgress?.({ step: "chats", status: "done", count: copied });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ step: "chats", ok: false, detail });
    onProgress?.({ step: "chats", status: "error", detail });
  }

  return results;
}
