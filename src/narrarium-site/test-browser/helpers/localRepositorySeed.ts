import {
  deleteLocalFile as deleteScoped,
  putCleanLocalFile as putCleanScoped,
  writeLocalText as writeScoped,
  type LocalRepositoryMeta,
} from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";

const DB_NAME = "narrarium-local-repositories";

export function putCleanLocalFile(input: Parameters<typeof putCleanScoped>[0]) {
  return putCleanScoped(input, captureRepositoryOperationScope());
}

export function writeLocalText(repoId: string, path: string, text: string) {
  return writeScoped(repoId, path, text, captureRepositoryOperationScope());
}

export function deleteLocalFile(repoId: string, path: string) {
  return deleteScoped(repoId, path, captureRepositoryOperationScope());
}

export async function putQuarantinedLocalRepository(meta: Omit<LocalRepositoryMeta, "id" | "updatedAt" | "localInstanceId"> & { localInstanceId?: string }): Promise<LocalRepositoryMeta> {
  const id = `${meta.accountScope ? `${meta.accountScope}::` : ""}${meta.owner}/${meta.repo}#${meta.branch}`.toLowerCase();
  const full: LocalRepositoryMeta = { ...meta, id, localInstanceId: meta.localInstanceId ?? crypto.randomUUID(), updatedAt: new Date().toISOString() };
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(DB_NAME); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  await new Promise<void>((resolve, reject) => { const tx = db.transaction("repositories", "readwrite"); tx.objectStore("repositories").put(full); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  db.close();
  return full;
}
