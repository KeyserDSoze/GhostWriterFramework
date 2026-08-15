import type { AuthProvider } from "@/store/authStore";
import { loadCloudSettingsForMigration, saveCloudSettings } from "@/drive/cloudSettingsClient";
import { loadCosts, saveCosts } from "@/costs/costsCloud";
import { loadAppJson, saveAppJson } from "@/drive/jsonFile";
import {
  listAssistantSessionsStrict,
  loadAssistantSession,
  saveAssistantSession,
} from "@/assistant/chatCloud";
import type { AssistantSession } from "@/assistant/store";
import { assertMigrationChatCompatible, indexUniqueMigrationIdentities, resumableMigrationSteps } from "@/drive/migrationSafety";
import { deleteVerifiedGoogleAppFolders } from "@/drive/googleAppFolder";

const GRAPH_DRIVE_API = "https://graph.microsoft.com/v1.0/me/drive";
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
  verified?: boolean;
  resumable?: boolean;
  sourceFingerprint?: string;
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
  folderIds: string[];
}

export interface MigrationPreflight {
  settings: Awaited<ReturnType<typeof loadCloudSettingsForMigration>>["settings"];
  costs: Awaited<ReturnType<typeof loadCosts>>["file"];
  clipboard: unknown[];
  chats: AssistantSession[];
  counts: Record<MigrationStepKind, number>;
  fingerprint: string;
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
  const folderIds = await deleteVerifiedGoogleAppFolders(accessToken);
  return { deleted: folderIds.length > 0, count: folderIds.length, folderIds };
}

async function deleteMicrosoftData(accessToken: string): Promise<CloudDeleteResult> {
  const meta = await fetch(`${GRAPH_DRIVE_API}/root:/${ONE_DRIVE_APP_FOLDER}`, { headers: authHeaders(accessToken) });
  if (meta.status === 404) return { deleted: false, count: 0, folderIds: [] };
  assertOk(meta, "OneDrive folder lookup");
  const data = (await meta.json()) as { id: string };
  const response = await fetch(`${GRAPH_DRIVE_API}/items/${data.id}`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  assertOk(response, "OneDrive folder delete");
  return { deleted: true, count: 1, folderIds: [data.id] };
}

/**
 * Copy everything Narrarium stores in the user's cloud (app settings incl. per-book
 * settings, costs ledger, clipboard, and all chat sessions) from a source account's
 * cloud storage to a target account's cloud storage. Existing target files are
 * preserved when they differ. The user's active session (authStore) is never touched.
 */
export async function migrateCloudData(
  source: MigrationEndpoint,
  target: MigrationEndpoint,
  onProgress?: (progress: MigrationProgress) => void,
  previousResults: MigrationStepResult[] = [],
  confirmedPreflight?: MigrationPreflight,
): Promise<MigrationStepResult[]> {
  const preflight = confirmedPreflight ?? await preflightCloudMigration(source);
  const results: MigrationStepResult[] = [];
  const pendingSteps = new Set(resumableMigrationSteps(["settings", "costs", "clipboard", "chats"], previousResults));
  const completed = new Set<MigrationStepKind>(["settings", "costs", "clipboard", "chats"].filter((step) => !pendingSteps.has(step) && previousResults.some((result) => result.step === step && result.sourceFingerprint === preflight.fingerprint)) as MigrationStepKind[]);

  const shouldSkip = (step: MigrationStepKind) => {
    if (!completed.has(step)) return false;
    const previous = previousResults.find((result) => result.step === step)!;
    results.push(previous);
    onProgress?.({ step, status: "done", count: previous.count });
    return true;
  };

  // ── Settings (includes per-book settings, tokens, AI integrations, routing) ──
  if (!shouldSkip("settings")) onProgress?.({ step: "settings", status: "start" });
  try {
    if (!completed.has("settings")) {
      await saveCloudSettings(target.provider, target.accessToken, preflight.settings);
      const verified = await loadCloudSettingsForMigration(target.provider, target.accessToken);
      if (!sameJson(verified.settings, preflight.settings)) throw new Error("Target settings verification failed.");
      const bookCount = preflight.counts.settings;
      results.push({ step: "settings", ok: true, verified: true, resumable: true, sourceFingerprint: preflight.fingerprint, detail: `${bookCount}`, count: bookCount });
      onProgress?.({ step: "settings", status: "done", count: bookCount });
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ step: "settings", ok: false, verified: false, resumable: true, detail });
    onProgress?.({ step: "settings", status: "error", detail });
  }

  // ── Costs ledger ────────────────────────────────────────────────────────────
  if (!shouldSkip("costs")) onProgress?.({ step: "costs", status: "start" });
  try {
    if (!completed.has("costs")) {
      const targetHandle = await loadCosts(target.provider, target.accessToken);
      await saveCosts(target.provider, target.accessToken, { file: preflight.costs, driveFileId: targetHandle.driveFileId });
      const verified = await loadCosts(target.provider, target.accessToken);
      if (!sameJson(verified.file.books, preflight.costs.books)) throw new Error("Target costs verification failed.");
      results.push({ step: "costs", ok: true, verified: true, resumable: true, sourceFingerprint: preflight.fingerprint, detail: "ok", count: preflight.counts.costs });
      onProgress?.({ step: "costs", status: "done", count: preflight.counts.costs });
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ step: "costs", ok: false, verified: false, resumable: true, detail });
    onProgress?.({ step: "costs", status: "error", detail });
  }

  // ── Clipboard ────────────────────────────────────────────────────────────────
  if (!shouldSkip("clipboard")) onProgress?.({ step: "clipboard", status: "start" });
  try {
    if (!completed.has("clipboard")) {
      const targetHandle = await loadAppJson<unknown[]>(target.provider, target.accessToken, CLIPBOARD_FILE);
      await saveAppJson(target.provider, target.accessToken, CLIPBOARD_FILE, preflight.clipboard, targetHandle.driveFileId);
      const verified = await loadAppJson<unknown[]>(target.provider, target.accessToken, CLIPBOARD_FILE);
      if (!Array.isArray(verified.data) || !sameJson(verified.data, preflight.clipboard)) throw new Error("Target clipboard verification failed.");
      results.push({ step: "clipboard", ok: true, verified: true, resumable: true, sourceFingerprint: preflight.fingerprint, detail: `${preflight.clipboard.length}`, count: preflight.clipboard.length });
      onProgress?.({ step: "clipboard", status: "done", count: preflight.clipboard.length });
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ step: "clipboard", ok: false, verified: false, resumable: true, detail });
    onProgress?.({ step: "clipboard", status: "error", detail });
  }

  // ── Chat sessions (one file per session) ─────────────────────────────────────
  if (!shouldSkip("chats")) onProgress?.({ step: "chats", status: "start" });
  try {
    if (!completed.has("chats")) {
      let copied = 0;
      const targetMetas = await listAssistantSessionsStrict(target.provider, target.accessToken);
      const targetsByIdentity = indexUniqueMigrationIdentities(targetMetas, "Migration target");
      const compatibleTargets = new Map<string, AssistantSession>();
      for (const session of preflight.chats) {
        const targetMeta = targetsByIdentity.get(session.id);
        if (!targetMeta?.fileId) continue;
        const existing = await loadAssistantSession(target.provider, target.accessToken, targetMeta.fileId);
        assertMigrationChatCompatible(session.id, session, existing, canonicalSession);
        compatibleTargets.set(session.id, existing);
      }
      for (const session of preflight.chats) {
        const existing = compatibleTargets.get(session.id);
        if (existing) {
          copied += 1;
          onProgress?.({ step: "chats", status: "start", count: copied });
          continue;
        }
        const targetMeta = targetsByIdentity.get(session.id);
        const clean: AssistantSession = { ...session, fileId: targetMeta?.fileId, revision: targetMeta?.revision };
        const handle = await saveAssistantSession(target.provider, target.accessToken, clean);
        const verified = await loadAssistantSession(target.provider, target.accessToken, handle.fileId);
        if (!sameJson(canonicalSession(verified), canonicalSession(clean))) throw new Error(`Target chat verification failed for ${clean.id}.`);
        copied += 1;
        onProgress?.({ step: "chats", status: "start", count: copied });
      }
      results.push({ step: "chats", ok: true, verified: true, resumable: true, sourceFingerprint: preflight.fingerprint, detail: `${copied}`, count: copied });
      onProgress?.({ step: "chats", status: "done", count: copied });
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ step: "chats", ok: false, verified: false, resumable: true, detail });
    onProgress?.({ step: "chats", status: "error", detail });
  }

  return results;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validSession(value: AssistantSession): boolean {
  return Boolean(value && typeof value.id === "string" && Array.isArray(value.messages) && Array.isArray(value.attachments));
}

function canonicalSession(session: AssistantSession): Omit<AssistantSession, "fileId" | "revision"> {
  const { fileId: _fileId, revision: _revision, ...canonical } = session;
  return canonical;
}

export async function preflightCloudMigration(source: MigrationEndpoint): Promise<MigrationPreflight> {
  const settingsResult = await loadCloudSettingsForMigration(source.provider, source.accessToken);
  if (!settingsResult.settings || !Array.isArray(settingsResult.settings.books)) throw new Error("Source settings are malformed.");
  const costsResult = await loadCosts(source.provider, source.accessToken);
  const clipboardResult = await loadAppJson<unknown[]>(source.provider, source.accessToken, CLIPBOARD_FILE);
  if (clipboardResult.data !== null && !Array.isArray(clipboardResult.data)) throw new Error("Source clipboard is malformed.");
  const metas = await listAssistantSessionsStrict(source.provider, source.accessToken);
  const chats: AssistantSession[] = [];
  for (const meta of metas) {
    if (!meta.fileId) throw new Error(`Source chat ${meta.id} has no file identity.`);
    const session = await loadAssistantSession(source.provider, source.accessToken, meta.fileId);
    if (!validSession(session)) throw new Error(`Source chat ${meta.id} is malformed.`);
    if (session.id !== meta.id) throw new Error(`Source chat ${meta.id} has mismatched session identity.`);
    chats.push(session);
  }
  const clipboard = clipboardResult.data ?? [];
  const fingerprint = JSON.stringify({ settings: settingsResult.settings, costs: costsResult.file, clipboard, chats: chats.map(canonicalSession) });
  return {
    settings: settingsResult.settings,
    costs: costsResult.file,
    clipboard,
    chats,
    counts: { settings: settingsResult.settings.books.length, costs: Object.keys(costsResult.file.books).length, clipboard: clipboard.length, chats: chats.length },
    fingerprint,
  };
}
