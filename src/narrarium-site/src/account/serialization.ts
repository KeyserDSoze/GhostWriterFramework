import { migrateSettings } from "@/drive/cloudSettingsClient";
import { emptyCostsFile, type CostsFile } from "@/costs/model";
import { normalizeAssistantSession, type AssistantLosslessSegment, type AssistantSession } from "@/assistant/store";
import { ACCOUNT_SYNC_SCHEMA_VERSION, type AccountSyncManifest, type LocalAccountSnapshot, type SyncableAccountData } from "@/account/types";
import { accountContentHash, validateAccountManifest } from "@/account/vectorClock";
import { projectSyncableSettings } from "@/account/dataProjection";

export interface AccountSyncEnvelope {
  manifest: AccountSyncManifest;
  data: SyncableAccountData;
}

export interface AccountRepositoryFiles {
  files: Map<string, string>;
  manifest: AccountSyncManifest;
  data: SyncableAccountData;
}

function portableChat(session: AssistantSession): AssistantSession {
  const { fileId: _fileId, revision: _revision, ...portable } = normalizeAssistantSession(session);
  const losslessArchive = portable.losslessArchive ? { ...portable.losslessArchive, origin: undefined } : portable.losslessArchive;
  return { ...portable, losslessArchive };
}

export function normalizeSyncableAccountData(data: SyncableAccountData): SyncableAccountData {
  return {
    schemaVersion: ACCOUNT_SYNC_SCHEMA_VERSION,
    settings: projectSyncableSettings(data.settings),
    costs: data.costs,
    clipboard: data.clipboard,
    chats: data.chats.map(portableChat).sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export async function accountSyncEnvelope(snapshot: LocalAccountSnapshot): Promise<AccountSyncEnvelope> {
  const data = normalizeSyncableAccountData(snapshot.data);
  const manifest = { ...snapshot.manifest, contentHash: await accountContentHash(data) };
  return { manifest, data };
}

export function parseAccountSyncEnvelope(value: unknown): AccountSyncEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Account sync envelope is malformed.");
  const raw = value as { manifest?: unknown; data?: unknown };
  const manifest = validateAccountManifest(raw.manifest);
  if (!raw.data || typeof raw.data !== "object" || Array.isArray(raw.data)) throw new Error("Account sync data is malformed.");
  const source = raw.data as Partial<SyncableAccountData>;
  if (source.schemaVersion !== ACCOUNT_SYNC_SCHEMA_VERSION || !Array.isArray(source.clipboard) || !Array.isArray(source.chats)) throw new Error("Account sync data schema is incompatible.");
  const costs = parseCosts(source.costs);
  const data: SyncableAccountData = {
    schemaVersion: ACCOUNT_SYNC_SCHEMA_VERSION,
    settings: migrateSettings(source.settings),
    costs,
    clipboard: source.clipboard,
    chats: source.chats.map((session) => normalizeAssistantSession(session)),
  };
  return { manifest, data };
}

function parseCosts(value: unknown): CostsFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyCostsFile();
  const costs = value as Partial<CostsFile>;
  if (costs.version !== 1 || costs.currency !== "EUR" || typeof costs.updatedAt !== "string" || !costs.books || typeof costs.books !== "object" || Array.isArray(costs.books)) throw new Error("Account costs data is malformed.");
  return costs as CostsFile;
}

function safeId(id: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) throw new Error(`Unsafe account file identity: ${id}`);
  return id;
}

export async function serializeAccountRepository(snapshot: LocalAccountSnapshot): Promise<AccountRepositoryFiles> {
  const envelope = await accountSyncEnvelope(snapshot);
  const { books, ...settings } = envelope.data.settings;
  const files = new Map<string, string>();
  files.set("manifest.json", `${JSON.stringify(envelope.manifest, null, 2)}\n`);
  files.set("settings.json", `${JSON.stringify(settings, null, 2)}\n`);
  files.set("books.json", `${JSON.stringify(books, null, 2)}\n`);
  files.set("costs.json", `${JSON.stringify(envelope.data.costs, null, 2)}\n`);
  files.set("clipboard.json", `${JSON.stringify(envelope.data.clipboard, null, 2)}\n`);
  for (const session of envelope.data.chats) {
    const { losslessSegments = [], ...chat } = session;
    files.set(`chats/${safeId(session.id)}.json`, `${JSON.stringify(chat, null, 2)}\n`);
    for (const segment of losslessSegments) files.set(`chat-segments/${safeId(session.id)}/${safeId(segment.id)}.json`, `${JSON.stringify(segment, null, 2)}\n`);
  }
  return { files, ...envelope };
}

export function parseAccountRepositoryFiles(files: ReadonlyMap<string, string>): AccountSyncEnvelope {
  const manifest = validateAccountManifest(parseJson(files, "manifest.json"));
  const settings = parseJson(files, "settings.json") as Record<string, unknown>;
  const books = parseJson(files, "books.json");
  const costs = parseJson(files, "costs.json");
  const clipboard = parseJson(files, "clipboard.json");
  const segmentEntries = new Map<string, AssistantLosslessSegment[]>();
  for (const [path, content] of files) {
    const match = /^chat-segments\/([^/]+)\/([^/]+)\.json$/.exec(path);
    if (!match) continue;
    const segment = JSON.parse(content) as AssistantLosslessSegment;
    segmentEntries.set(match[1], [...(segmentEntries.get(match[1]) ?? []), segment]);
  }
  const chats: AssistantSession[] = [];
  for (const [path, content] of files) {
    const match = /^chats\/([^/]+)\.json$/.exec(path);
    if (!match) continue;
    chats.push(normalizeAssistantSession({ ...JSON.parse(content), losslessSegments: segmentEntries.get(match[1]) ?? [] }));
  }
  return parseAccountSyncEnvelope({
    manifest,
    data: { schemaVersion: ACCOUNT_SYNC_SCHEMA_VERSION, settings: { ...settings, books }, costs, clipboard, chats },
  });
}

function parseJson(files: ReadonlyMap<string, string>, path: string): unknown {
  const content = files.get(path);
  if (content === undefined) throw new Error(`Account repository is missing ${path}.`);
  try { return JSON.parse(content); }
  catch { throw new Error(`Account repository file ${path} is malformed.`); }
}
