/** The base of a sync as it sits in IndexedDB, read without the code that wrote it. */
export async function readRawSyncBase(serverId: string, bookId: string): Promise<Map<string, string> | null> {
  const db = await new Promise<IDBDatabase | null>((resolve, reject) => {
    const request = indexedDB.open("narrarium-autopilot-sync");
    request.onupgradeneeded = () => {
      request.transaction?.abort();
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => reject(new Error("blocked"));
  });
  if (!db) return null;
  try {
    if (!db.objectStoreNames.contains("bases")) return null;
    const tx = db.transaction("bases", "readonly");
    const record = await new Promise<{ files: Array<[string, string]> } | undefined>((resolve, reject) => {
      const request = tx.objectStore("bases").get(`${serverId}:${bookId}`);
      request.onsuccess = () => resolve(request.result as { files: Array<[string, string]> } | undefined);
      request.onerror = () => reject(request.error);
    });
    return record ? new Map(record.files) : null;
  } finally {
    db.close();
  }
}

/** Remove every database the sync base may have created, between tests. */
export async function dropSyncBaseDatabase(): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase("narrarium-autopilot-sync");
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}
