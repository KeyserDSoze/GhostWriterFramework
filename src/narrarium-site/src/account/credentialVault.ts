/**
 * Device vault for refresh tokens.
 *
 * A refresh token is the long-lived secret. When the user chose "remember this connection", it is kept in IndexedDB,
 * but never as plain text: it is sealed with AES-GCM under a key that WebCrypto created for this device and cannot
 * export (the CryptoKey itself is what is stored). The key lives in a database of its own, apart from the account data.
 *
 * What this protects against: someone reading the stored records (a copy of the database, a backup, a casual look in
 * the developer tools) finds ciphertext, not a token. What it does NOT protect against: code that runs in the page.
 * That code can ask WebCrypto to decrypt exactly as this module does, so a script injected into the page can still use
 * the token. The vault is defence in depth, not a safe. Without WebCrypto nothing is stored at all: the token then
 * lives in memory only, for the life of the tab.
 *
 * Each record is bound to its provider and account (as GCM additional data) and uses a fresh IV every time.
 * Nothing here logs, and failures never carry the value: every function reports failure as "false" or "null".
 */
export type VaultProvider = "google" | "microsoft" | "github";

const DB_NAME = "narrarium-credential-vault";
const DB_VERSION = 1;
const STORE = "records";
const KEY_ID = "device-key";
const FORMAT_VERSION = 1;

interface KeyRecord { id: typeof KEY_ID; key: CryptoKey; createdAt: number }
interface TokenRecord { id: string; v: typeof FORMAT_VERSION; accountId: string; iv: Uint8Array<ArrayBuffer>; data: Uint8Array<ArrayBuffer>; savedAt: number }

let dbPromise: Promise<IDBDatabase> | null = null;

/** Both IndexedDB and WebCrypto are needed to keep a token on this device. */
export function credentialVaultAvailable(): boolean {
  try {
    return typeof indexedDB !== "undefined" && typeof crypto !== "undefined" && typeof crypto.subtle?.generateKey === "function" && typeof crypto.getRandomValues === "function";
  } catch {
    return false;
  }
}

function openVault(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("blocked"));
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
  }).catch((error: unknown) => { dbPromise = null; throw error; });
  return dbPromise;
}

/** Does the vault database exist yet? Asking must not create it. When the browser cannot say, assume it does. */
async function vaultExists(): Promise<boolean> {
  if (dbPromise) return true;
  try {
    const databases = await indexedDB.databases?.();
    return databases ? databases.some((entry) => entry.name === DB_NAME) : true;
  } catch {
    return true;
  }
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("aborted"));
  });
}

async function readKey(db: IDBDatabase): Promise<CryptoKey | null> {
  const tx = db.transaction(STORE, "readonly");
  const record = await requestValue(tx.objectStore(STORE).get(KEY_ID)) as KeyRecord | undefined;
  await transactionDone(tx);
  return record?.key ?? null;
}

/** The device key, created on first use. If two tabs create one at the same moment, the first one stored wins. */
async function deviceKey(db: IDBDatabase): Promise<CryptoKey> {
  const existing = await readKey(db);
  if (existing) return existing;
  const fresh = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  const winner = await requestValue(store.get(KEY_ID)) as KeyRecord | undefined;
  if (!winner) store.put({ id: KEY_ID, key: fresh, createdAt: Date.now() } satisfies KeyRecord);
  await transactionDone(tx);
  return winner?.key ?? fresh;
}

const recordId = (provider: VaultProvider) => `refresh:${provider}`;

function boundTo(provider: VaultProvider, accountId: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`narrarium-refresh-token\u0000v${FORMAT_VERSION}\u0000${provider}\u0000${accountId}`);
}

/** Seals a refresh token for this device. False when it could not be stored: the caller then keeps it in memory only. */
export async function saveRefreshToken(provider: VaultProvider, accountId: string, refreshToken: string): Promise<boolean> {
  const account = accountId.trim();
  if (!credentialVaultAvailable() || !account || !refreshToken) return false;
  try {
    const db = await openVault();
    const key = await deviceKey(db);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: boundTo(provider, account) }, key, new TextEncoder().encode(refreshToken));
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ id: recordId(provider), v: FORMAT_VERSION, accountId: account, iv, data: new Uint8Array(sealed), savedAt: Date.now() } satisfies TokenRecord);
    await transactionDone(tx);
    return true;
  } catch {
    return false;
  }
}

/** The refresh token saved for exactly this provider and account, or null (nothing saved, altered, or another account's). */
export async function loadRefreshToken(provider: VaultProvider, accountId: string): Promise<string | null> {
  const account = accountId.trim();
  if (!credentialVaultAvailable() || !account) return null;
  try {
    if (!await vaultExists()) return null;
    const db = await openVault();
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const [record, keyRecord] = await Promise.all([
      requestValue(store.get(recordId(provider))) as Promise<TokenRecord | undefined>,
      requestValue(store.get(KEY_ID)) as Promise<KeyRecord | undefined>,
    ]);
    await transactionDone(tx);
    if (!record || !keyRecord?.key || record.v !== FORMAT_VERSION || record.accountId !== account) return null;
    const opened = await crypto.subtle.decrypt({ name: "AES-GCM", iv: record.iv, additionalData: boundTo(provider, account) }, keyRecord.key, record.data);
    return new TextDecoder().decode(opened);
  } catch {
    return null;
  }
}

/** Forgets a provider's token, and the device key too once no token needs it. Never throws. */
export async function deleteRefreshToken(provider: VaultProvider): Promise<void> {
  try {
    if (!await vaultExists()) return;
    const db = await openVault();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    store.delete(recordId(provider));
    const remaining = await requestValue(store.getAllKeys());
    if (!remaining.some((id) => String(id).startsWith("refresh:"))) store.delete(KEY_ID);
    await transactionDone(tx);
  } catch {
    // Nothing useful can be said, and nothing may be printed.
  }
}

/** Wipes the whole vault, key included. */
export async function deleteCredentialVault(): Promise<void> {
  const open = dbPromise;
  dbPromise = null;
  try { (await open)?.close(); } catch { /* it was not open */ }
  await new Promise<void>((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      // Another tab still holds it open: it closes when it sees the version change, and the deletion then completes.
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

export function closeCredentialVaultForTests(): void {
  const open = dbPromise;
  dbPromise = null;
  void open?.then((db) => db.close(), () => undefined);
}
