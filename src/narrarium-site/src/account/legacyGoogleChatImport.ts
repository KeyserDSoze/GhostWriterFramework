import { hydrateAssistantSessionArchive, listAssistantSessionsStrict, loadAssistantSession } from "@/assistant/chatCloud";
import { refreshAssistantSessionIndex } from "@/assistant/sessionIndex";
import { normalizeAssistantSession, type AssistantSession } from "@/assistant/store";
import { loadLocalAccountSnapshot, LocalAccountSnapshotChangedError, replaceLocalAccountSnapshot } from "@/account/accountLocalStore";
import { accountBackendToken, useConnectionStore } from "@/account/connectionStore";
import { registerCloudAccount } from "@/drive/cloudWriteBarrier";

export interface LegacyGoogleChatImportPlan {
  localSnapshotId: string;
  total: number;
  unchanged: number;
  conflicts: string[];
  importableSessions: AssistantSession[];
}

function portableSession(session: AssistantSession): AssistantSession {
  const { fileId: _fileId, revision: _revision, ...portable } = normalizeAssistantSession(session);
  const losslessArchive = portable.losslessArchive ? { ...portable.losslessArchive, origin: undefined } : portable.losslessArchive;
  return { ...portable, losslessArchive };
}

function sameSession(left: AssistantSession, right: AssistantSession): boolean {
  return JSON.stringify(portableSession(left)) === JSON.stringify(portableSession(right));
}

export async function prepareLegacyGoogleChatImport(): Promise<LegacyGoogleChatImportPlan> {
  const connection = useConnectionStore.getState().configuration.google;
  if (!connection) throw new Error("Google Drive is not connected on this device.");
  const token = accountBackendToken("google-drive");
  registerCloudAccount("google", token, connection.identity.providerAccountId);

  const metas = await listAssistantSessionsStrict("google", token);
  const sourceIds = new Set<string>();
  const legacySessions: AssistantSession[] = [];
  for (const meta of metas) {
    if (!meta.fileId || sourceIds.has(meta.id)) throw new Error(`Legacy Google chat ${meta.id} has a missing or duplicate identity.`);
    sourceIds.add(meta.id);
    const session = portableSession(await hydrateAssistantSessionArchive("google", token, await loadAssistantSession("google", token, meta.fileId)));
    if (session.id !== meta.id) throw new Error(`Legacy Google chat ${meta.id} has mismatched content identity.`);
    legacySessions.push(session);
  }

  const local = await loadLocalAccountSnapshot();
  if (!local) throw new Error("Local account data has not been initialized.");
  const localById = new Map(local.data.chats.map((session) => [session.id, session]));
  const importableSessions: AssistantSession[] = [];
  const conflicts: string[] = [];
  let unchanged = 0;
  for (const session of legacySessions) {
    const existing = localById.get(session.id);
    if (!existing) importableSessions.push(session);
    else if (sameSession(existing, session)) unchanged += 1;
    else conflicts.push(session.id);
  }
  return { localSnapshotId: local.manifest.snapshotId, total: legacySessions.length, unchanged, conflicts, importableSessions };
}

export async function applyLegacyGoogleChatImport(plan: LegacyGoogleChatImportPlan): Promise<number> {
  if (plan.conflicts.length) throw new Error(`Legacy Google chats conflict with current local chats: ${plan.conflicts.join(", ")}.`);
  if (!plan.importableSessions.length) return 0;
  const local = await loadLocalAccountSnapshot();
  if (!local || local.manifest.snapshotId !== plan.localSnapshotId) throw new LocalAccountSnapshotChangedError();
  const existingIds = new Set(local.data.chats.map((session) => session.id));
  if (plan.importableSessions.some((session) => existingIds.has(session.id))) throw new LocalAccountSnapshotChangedError();
  const chats = [...local.data.chats, ...plan.importableSessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  await replaceLocalAccountSnapshot({ ...local.data, chats }, [local.manifest], `Imported ${plan.importableSessions.length} legacy Google chat${plan.importableSessions.length === 1 ? "" : "s"}`, local.manifest.snapshotId);
  await refreshAssistantSessionIndex().catch(() => undefined);
  return plan.importableSessions.length;
}
