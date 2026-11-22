import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { closeCredentialVaultForTests, credentialVaultAvailable, deleteCredentialVault, deleteRefreshToken, loadRefreshToken, saveRefreshToken } from "@/account/credentialVault";
import { SECRETS, deleteDatabases, dumpIndexedDb, spyOnConsole } from "./oauthTestKit";

const DB = "narrarium-credential-vault";

async function openRaw(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function rawRecords(): Promise<Array<Record<string, unknown> & { id: string }>> {
  const db = await openRaw();
  try {
    const tx = db.transaction("records", "readonly");
    return await new Promise((resolve, reject) => {
      const request = tx.objectStore("records").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

async function putRaw(record: Record<string, unknown>): Promise<void> {
  const db = await openRaw();
  try {
    const tx = db.transaction("records", "readwrite");
    tx.objectStore("records").put(record);
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  } finally { db.close(); }
}

beforeEach(async () => {
  closeCredentialVaultForTests();
  await deleteDatabases(DB);
});

afterEach(() => {
  vi.unstubAllGlobals();
  closeCredentialVaultForTests();
});

describe("the device vault for refresh tokens", () => {
  it("keeps a refresh token only as ciphertext and gives it back unchanged", async () => {
    await expect(saveRefreshToken("google", "g-1", SECRETS.refresh)).resolves.toBe(true);

    const dump = await dumpIndexedDb(DB);
    expect(dump).not.toBe("");
    expect(dump).not.toContain(SECRETS.refresh);
    expect(dump).not.toContain(Buffer.from(SECRETS.refresh).toString("base64"));
    expect(dump).not.toContain(Buffer.from(SECRETS.refresh).toString("hex"));
    await expect(loadRefreshToken("google", "g-1")).resolves.toBe(SECRETS.refresh);
  });

  it("encrypts with one AES-GCM key per device that cannot be exported", async () => {
    await saveRefreshToken("google", "g-1", SECRETS.refresh);
    await saveRefreshToken("microsoft", "m-1", SECRETS.refreshRotated);

    const records = await rawRecords();
    const keys = records.filter((record) => record.id === "device-key");
    expect(keys).toHaveLength(1);
    const key = keys[0].key as CryptoKey;
    expect(key.extractable).toBe(false);
    expect(key.type).toBe("secret");
    expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    expect([...key.usages].sort()).toEqual(["decrypt", "encrypt"]);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toBeTruthy();

    expect(records.map((record) => record.id).sort()).toEqual(["device-key", "refresh:google", "refresh:microsoft"]);
    await expect(loadRefreshToken("google", "g-1")).resolves.toBe(SECRETS.refresh);
    await expect(loadRefreshToken("microsoft", "m-1")).resolves.toBe(SECRETS.refreshRotated);
  });

  it("creates the key only once even when two tabs save for the first time together", async () => {
    const results = await Promise.all([saveRefreshToken("google", "g-1", SECRETS.refresh), saveRefreshToken("microsoft", "m-1", SECRETS.refreshRotated)]);
    expect(results).toEqual([true, true]);
    expect((await rawRecords()).filter((record) => record.id === "device-key")).toHaveLength(1);
    await expect(loadRefreshToken("google", "g-1")).resolves.toBe(SECRETS.refresh);
    await expect(loadRefreshToken("microsoft", "m-1")).resolves.toBe(SECRETS.refreshRotated);
  });

  it("uses a fresh IV every time, so the same token never looks the same twice", async () => {
    await saveRefreshToken("google", "g-1", SECRETS.refresh);
    const first = (await rawRecords()).find((record) => record.id === "refresh:google")!;
    await saveRefreshToken("google", "g-1", SECRETS.refresh);
    const second = (await rawRecords()).find((record) => record.id === "refresh:google")!;
    expect(Buffer.from(first.iv as Uint8Array).equals(Buffer.from(second.iv as Uint8Array))).toBe(false);
    expect(Buffer.from(first.data as Uint8Array).equals(Buffer.from(second.data as Uint8Array))).toBe(false);
  });

  it("gives a token back only to the account and provider it was saved for", async () => {
    await saveRefreshToken("google", "g-1", SECRETS.refresh);
    await expect(loadRefreshToken("google", "someone-else")).resolves.toBeNull();
    await expect(loadRefreshToken("microsoft", "g-1")).resolves.toBeNull();

    const stored = (await rawRecords()).find((record) => record.id === "refresh:google")!;
    await putRaw({ ...stored, id: "refresh:microsoft" });
    await expect(loadRefreshToken("microsoft", "g-1")).resolves.toBeNull();
  });

  it("refuses a record that was altered", async () => {
    await saveRefreshToken("google", "g-1", SECRETS.refresh);
    const stored = (await rawRecords()).find((record) => record.id === "refresh:google")!;
    const data = new Uint8Array(stored.data as Uint8Array);
    data[0] ^= 0xff;
    await putRaw({ ...stored, data });
    await expect(loadRefreshToken("google", "g-1")).resolves.toBeNull();
  });

  it("forgets a token on request, and drops the key once no token needs it", async () => {
    await saveRefreshToken("google", "g-1", SECRETS.refresh);
    await saveRefreshToken("microsoft", "m-1", SECRETS.refreshRotated);

    await deleteRefreshToken("google");
    await expect(loadRefreshToken("google", "g-1")).resolves.toBeNull();
    await expect(loadRefreshToken("microsoft", "m-1")).resolves.toBe(SECRETS.refreshRotated);
    expect((await rawRecords()).map((record) => record.id).sort()).toEqual(["device-key", "refresh:microsoft"]);

    await deleteRefreshToken("microsoft");
    expect((await rawRecords()).map((record) => record.id)).toEqual([]);

    await expect(saveRefreshToken("google", "g-1", SECRETS.refresh)).resolves.toBe(true);
    await expect(loadRefreshToken("google", "g-1")).resolves.toBe(SECRETS.refresh);
  });

  it("can be wiped completely with the rest of the local data", async () => {
    await saveRefreshToken("google", "g-1", SECRETS.refresh);
    await deleteCredentialVault();
    expect((await indexedDB.databases()).map((entry) => entry.name)).not.toContain(DB);
    await expect(loadRefreshToken("google", "g-1")).resolves.toBeNull();
    await expect(deleteCredentialVault()).resolves.toBeUndefined();
  });

  it("refuses to store anything it cannot bind to an account, or nothing at all", async () => {
    await expect(saveRefreshToken("google", "", SECRETS.refresh)).resolves.toBe(false);
    await expect(saveRefreshToken("google", "  ", SECRETS.refresh)).resolves.toBe(false);
    await expect(saveRefreshToken("google", "g-1", "")).resolves.toBe(false);
    expect(await dumpIndexedDb(DB)).toBe("");
  });
});

describe("when the browser cannot keep a secret safely", () => {
  it("stores nothing without WebCrypto and says so, so the token stays in memory only", async () => {
    vi.stubGlobal("crypto", { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto), randomUUID: globalThis.crypto.randomUUID.bind(globalThis.crypto) });
    expect(credentialVaultAvailable()).toBe(false);
    await expect(saveRefreshToken("google", "g-1", SECRETS.refresh)).resolves.toBe(false);
    await expect(loadRefreshToken("google", "g-1")).resolves.toBeNull();
    expect(await dumpIndexedDb(DB)).toBe("");
  });

  it("reports itself available when both IndexedDB and WebCrypto exist", () => {
    expect(credentialVaultAvailable()).toBe(true);
  });

  it("never throws when IndexedDB itself fails, and never prints the secret", async () => {
    const spy = spyOnConsole();
    vi.spyOn(indexedDB, "open").mockImplementation(() => { throw new Error(`blocked while holding ${SECRETS.refresh}`); });
    await expect(saveRefreshToken("google", "g-1", SECRETS.refresh)).resolves.toBe(false);
    await expect(loadRefreshToken("google", "g-1")).resolves.toBeNull();
    await expect(deleteRefreshToken("google")).resolves.toBeUndefined();
    expect(spy.output()).not.toContain(SECRETS.refresh);
    expect(spy.count()).toBe(0);
  });

  it("has no console call anywhere in the vault", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(process.cwd(), "src/account/credentialVault.ts"), "utf8");
    expect(source).not.toMatch(/\bconsole\s*\./);
  });
});
