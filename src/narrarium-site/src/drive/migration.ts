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
