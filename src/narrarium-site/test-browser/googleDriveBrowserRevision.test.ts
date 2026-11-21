import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { DriveAccountSyncBackend } from "@/account/sync/driveBackend";
import { accountSyncEnvelope } from "@/account/serialization";
import { ACCOUNT_SYNC_SCHEMA_VERSION, type AccountRemoteExpectation, type AccountRemoteSnapshot, type LocalAccountSnapshot } from "@/account/types";
import { initialAccountManifest, nextAccountManifest } from "@/account/vectorClock";
import { resetGoogleAppFolderCacheForTests } from "@/drive/googleAppFolder";
import { loadAppJson, saveAppJson } from "@/drive/jsonFile";
import { emptyCostsFile } from "@/costs/model";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { createFakeGoogleDrive, type FakeGoogleDriveOptions } from "./helpers/fakeGoogleDrive";

const ACCOUNT_DATA = "account-data.json";
const CHANGED = /changed before it could be updated/;

function snapshotOf(previous?: LocalAccountSnapshot, text = "first"): LocalAccountSnapshot {
  return {
    dirty: true,
    manifest: previous ? nextAccountManifest(previous.manifest, "device-a") : { ...initialAccountManifest("device-a"), vectorClock: { "device-a": 1 } },
    data: { schemaVersion: ACCOUNT_SYNC_SCHEMA_VERSION, settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [{ id: "entry", text, at: "2026-11-21T10:00:00.000Z" }], chats: [] },
  };
}

/** What the sync engine remembers about the remote copy after a pull. */
function expectationOf(remote: AccountRemoteSnapshot): AccountRemoteExpectation {
  return { snapshotId: remote.manifest.snapshotId, contentHash: remote.manifest.contentHash, revision: remote.revision, format: remote.format ?? "current" };
}

function connect(options?: FakeGoogleDriveOptions) {
  const drive = createFakeGoogleDrive(options);
  vi.stubGlobal("fetch", drive.fetch);
  const token = `google-${crypto.randomUUID()}`;
  return { drive, token, backend: new DriveAccountSyncBackend("google", token, `account-${token}`) };
}

async function published(options?: FakeGoogleDriveOptions) {
  const connection = connect(options);
  const first = snapshotOf();
  await connection.backend.push(first, { absent: true });
  const remote = (await connection.backend.pull())!;
  return { ...connection, first, remote };
}

describe("Google Drive account sync in a browser, where the ETag header cannot be read", () => {
  beforeEach(() => {
    localStorage.clear();
    resetGoogleAppFolderCacheForTests();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reads the revision of a file from the version in the JSON metadata", async () => {
    const { drive, token } = await published();
    const loaded = await loadAppJson("google", token, ACCOUNT_DATA);
    expect(loaded.revision).toBe(String(drive.find(ACCOUNT_DATA).version));
    expect(drive.requests.some((request) => request.url.searchParams.get("fields") === "id,version")).toBe(true);
  });

  it("returns a revision for the file it creates and for the one it updates", async () => {
    const { drive, token } = connect();
    const created = await saveAppJson("google", token, "notes.json", { value: 1 });
    expect(created.revision).toBe(String(drive.find("notes.json").version));
    const updated = await saveAppJson("google", token, "notes.json", { value: 2 }, created.driveFileId, created.revision);
    expect(updated.revision).toBe(String(drive.find("notes.json").version));
    expect(Number(updated.revision)).toBeGreaterThan(Number(created.revision));
  });

  it("publishes the first snapshot and pulls it back with a revision", async () => {
    const { backend } = connect();
    const first = snapshotOf();
    await expect(backend.pull()).resolves.toBeNull();
    const result = await backend.push(first, { absent: true });
    expect(result.revision).toEqual(expect.any(String));
    const remote = await backend.pull();
    expect(remote).toMatchObject({ backend: "google-drive", format: "current", revision: result.revision });
    expect(remote?.manifest.snapshotId).toBe(first.manifest.snapshotId);
  });

  it("publishes a second snapshot using the revision of the pull (the failure reported from production)", async () => {
    const { backend, first, remote, drive } = await published();
    expect(remote.revision).toEqual(expect.any(String));
    const second = snapshotOf(first, "second");
    await expect(backend.push(second, expectationOf(remote))).resolves.toMatchObject({ revision: expect.any(String) });
    expect((await backend.pull())?.manifest.snapshotId).toBe(second.manifest.snapshotId);
    expect(drive.writes(ACCOUNT_DATA)).toHaveLength(1);
  });

  it("does not send a bare version number as If-Match", async () => {
    const { backend, first, remote, drive } = await published();
    await backend.push(snapshotOf(first, "second"), expectationOf(remote));
    for (const write of drive.writes(ACCOUNT_DATA)) expect(write.headers.has("If-Match")).toBe(false);
  });

  it("still reports that another device published a different snapshot after the pull", async () => {
    const { backend, first, remote, drive } = await published();
    const other = snapshotOf(first, "another device");
    drive.externalWrite(ACCOUNT_DATA, JSON.stringify(await accountSyncEnvelope(other)));
    await expect(backend.push(snapshotOf(first, "second"), expectationOf(remote))).rejects.toThrow(CHANGED);
    expect(drive.writes(ACCOUNT_DATA)).toHaveLength(0);
  });

  it("still reports that the file changed when only its version moved between the pull and the push", async () => {
    const { backend, first, remote, drive } = await published();
    drive.touch(ACCOUNT_DATA);
    await expect(backend.push(snapshotOf(first, "second"), expectationOf(remote))).rejects.toThrow(CHANGED);
    expect(drive.writes(ACCOUNT_DATA)).toHaveLength(0);
  });

  it("adopts the revision it has just read for a store written by the version that recorded none", async () => {
    const { backend, first, remote, drive } = await published();
    const recordedByTheOldVersion: AccountRemoteExpectation = { ...expectationOf(remote), revision: undefined };
    const second = snapshotOf(first, "second");
    await expect(backend.push(second, recordedByTheOldVersion)).resolves.toMatchObject({ revision: expect.any(String) });
    expect((await backend.pull())?.manifest.snapshotId).toBe(second.manifest.snapshotId);
    expect(drive.writes(ACCOUNT_DATA)).toHaveLength(1);
  });

  it("still checks the snapshot identity when the expectation has no revision", async () => {
    const { backend, first, remote, drive } = await published();
    const stale: AccountRemoteExpectation = { ...expectationOf(remote), revision: undefined, snapshotId: "not-the-snapshot-on-drive" };
    await expect(backend.push(snapshotOf(first, "second"), stale)).rejects.toThrow(CHANGED);
    expect(drive.writes(ACCOUNT_DATA)).toHaveLength(0);
  });

  it("fails only when Drive gives no revision at all", async () => {
    const { backend, first, remote, drive } = await published({ omitVersion: true });
    expect(remote.revision).toBeUndefined();
    await expect(backend.push(snapshotOf(first, "second"), expectationOf(remote))).rejects.toThrow(/did not provide a revision/);
    expect(drive.writes(ACCOUNT_DATA)).toHaveLength(0);
  });
});

describe("Google Drive account sync when the ETag header can be read", () => {
  beforeEach(() => {
    localStorage.clear();
    resetGoogleAppFolderCacheForTests();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps using the ETag header, as If-Match, when the file metadata has no version", async () => {
    const { backend, first, remote, drive } = await published({ exposeEtag: true, omitVersion: true });
    const etag = drive.etagOf(ACCOUNT_DATA);
    expect(remote.revision).toBe(etag);
    await backend.push(snapshotOf(first, "second"), expectationOf(remote));
    expect(drive.writes(ACCOUNT_DATA).map((write) => write.headers.get("If-Match"))).toEqual([etag]);
  });

  it("detects a change of the ETag after the pull before it writes", async () => {
    const { backend, first, remote, drive } = await published({ exposeEtag: true, omitVersion: true });
    drive.touch(ACCOUNT_DATA);
    await expect(backend.push(snapshotOf(first, "second"), expectationOf(remote))).rejects.toThrow(CHANGED);
    expect(drive.writes(ACCOUNT_DATA)).toHaveLength(0);
  });

  it("prefers the version, so the revision does not depend on whether the header is exposed", async () => {
    const { remote, drive } = await published({ exposeEtag: true });
    expect(remote.revision).toBe(String(drive.find(ACCOUNT_DATA).version));
  });
});
