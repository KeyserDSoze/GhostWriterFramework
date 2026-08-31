import type { AccountRemoteExpectation, AccountRemoteSnapshot, AccountSyncBackend, AccountSyncBackendKind, AccountSyncManifest, LocalAccountSnapshot, SyncableAccountData } from "@/account/types";
import { ACCOUNT_SYNC_APPLICATION, ACCOUNT_SYNC_SCHEMA_VERSION } from "@/account/types";
import { accountContentHash } from "@/account/vectorClock";
import { accountSyncEnvelope, normalizeSyncableAccountData, parseAccountSyncEnvelope } from "@/account/serialization";
import { deleteAppJson, loadAppJson, saveAppJson } from "@/drive/jsonFile";
import { preflightCloudMigration } from "@/drive/migration";
import { registerCloudAccount } from "@/drive/cloudWriteBarrier";
import type { AuthProvider } from "@/store/authStore";

const ACCOUNT_DATA_FILE = "account-data.json";
const MANIFEST_FILE = "manifest.json";

export class DriveAccountSyncBackend implements AccountSyncBackend {
  readonly kind: AccountSyncBackendKind;

  constructor(
    private readonly provider: AuthProvider,
    private readonly accessToken: string,
    private readonly providerAccountId: string,
  ) {
    this.kind = provider === "google" ? "google-drive" : "onedrive";
    registerCloudAccount(provider, accessToken, providerAccountId);
  }

  async pull(): Promise<AccountRemoteSnapshot | null> {
    const publishedManifest = await loadAppJson<AccountSyncManifest>(this.provider, this.accessToken, MANIFEST_FILE);
    const current = await loadAppJson<unknown>(this.provider, this.accessToken, ACCOUNT_DATA_FILE);
    if (current.data) {
      const envelope = parseAccountSyncEnvelope(current.data);
      // The envelope is self-describing and atomic. A stale external manifest is
      // repairable on the next push and must not make a valid snapshot unreadable.
      await assertHash(envelope.data, envelope.manifest);
      const format = publishedManifest.data?.snapshotId === envelope.manifest.snapshotId ? "current" as const : "repair" as const;
      return { backend: this.kind, ...envelope, revision: current.revision, format };
    }

    // Legacy providers did not have a manifest. Import their complete dataset
    // without modifying or deleting the old representation.
    try {
      const legacy = await preflightCloudMigration({ provider: this.provider, accessToken: this.accessToken });
      const data = normalizeSyncableAccountData({
        schemaVersion: ACCOUNT_SYNC_SCHEMA_VERSION,
        settings: legacy.settings,
        costs: legacy.costs,
        clipboard: legacy.clipboard as SyncableAccountData["clipboard"],
        chats: legacy.chats,
      });
      const manifest: AccountSyncManifest = {
        application: ACCOUNT_SYNC_APPLICATION,
        schemaVersion: ACCOUNT_SYNC_SCHEMA_VERSION,
        snapshotId: crypto.randomUUID(),
        modifiedAtUtc: new Date().toISOString(),
        modifiedByDeviceId: `legacy-${this.provider}-${this.providerAccountId}`,
        vectorClock: { [`legacy-${this.provider}-${this.providerAccountId}`]: 1 },
        contentHash: await accountContentHash(data),
      };
      return { backend: this.kind, data, manifest, format: "legacy" };
    } catch (error) {
      if (error instanceof Error && /missing|404/i.test(error.message)) return null;
      throw error;
    }
  }

  async push(snapshot: LocalAccountSnapshot, expected: AccountRemoteExpectation): Promise<{ revision?: string }> {
    const envelope = await accountSyncEnvelope(snapshot);
    const existing = await loadAppJson<unknown>(this.provider, this.accessToken, ACCOUNT_DATA_FILE);
    if (existing.data) {
      const current = parseAccountSyncEnvelope(existing.data);
      if (expected.absent || expected.format === "legacy" || !expected.snapshotId || current.manifest.snapshotId !== expected.snapshotId) throw new Error(`${this.kind} account data changed before it could be updated.`);
      if (!expected.revision) throw new Error(`${this.kind} did not provide a revision for a conditional account update.`);
    } else if (expected.format === "legacy") {
      const legacy = await this.pull();
      if (!legacy || legacy.format !== "legacy" || legacy.manifest.contentHash !== expected.contentHash) throw new Error(`${this.kind} legacy account data changed before first publication.`);
    } else if (!expected.absent) throw new Error(`${this.kind} account data was deleted before it could be updated.`);
    const saved = await saveAppJson(this.provider, this.accessToken, ACCOUNT_DATA_FILE, envelope, existing.driveFileId, existing.data ? expected.revision : undefined);
    const existingManifest = await loadAppJson<AccountSyncManifest>(this.provider, this.accessToken, MANIFEST_FILE);
    await saveAppJson(this.provider, this.accessToken, MANIFEST_FILE, envelope.manifest, existingManifest.driveFileId, existingManifest.revision);
    const verified = await loadAppJson<unknown>(this.provider, this.accessToken, ACCOUNT_DATA_FILE);
    if (!verified.data) throw new Error(`${this.kind} did not retain the account snapshot.`);
    const parsed = parseAccountSyncEnvelope(verified.data);
    await assertHash(parsed.data, parsed.manifest);
    if (parsed.manifest.snapshotId !== envelope.manifest.snapshotId || parsed.manifest.contentHash !== envelope.manifest.contentHash) {
      throw new Error(`${this.kind} account snapshot verification failed.`);
    }
    return { revision: saved.revision };
  }

  async deleteRemoteData(): Promise<void> {
    await deleteAppJson(this.provider, this.accessToken, MANIFEST_FILE);
    await deleteAppJson(this.provider, this.accessToken, ACCOUNT_DATA_FILE);
  }
}

async function assertHash(data: SyncableAccountData, manifest: AccountSyncManifest): Promise<void> {
  if (!manifest.contentHash) return;
  if (await accountContentHash(data) !== manifest.contentHash) throw new Error("Account snapshot content hash does not match its manifest.");
}
