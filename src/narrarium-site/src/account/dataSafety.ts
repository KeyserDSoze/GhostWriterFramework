import { deleteAllLocalAccountData, loadLocalAccountSnapshot } from "@/account/accountLocalStore";
import { localWorkspaceScope } from "@/account/deviceIdentity";
import { useConnectionStore } from "@/account/connectionStore";
import { deleteAllLocalRepositoryData, getLocalRepositoryByBook, localStatus } from "@/repository/localRepository";
import { deleteAllLocalRewriteOperationData } from "@/repository/localRewriteOperationStore";
import { useSettingsStore } from "@/store/settingsStore";
import { bookStorageMode } from "@/types/settings";
import { deleteLocalCloudWriteBarrierData } from "@/drive/cloudWriteBarrier";
import { clearMicrosoftAuthCaches } from "@/config/msal";
import { useAuthStore } from "@/store/authStore";

export type BookProtectionState = "local-only" | "remote-up-to-date" | "remote-behind" | "local-unpushed" | "sync-error";

export interface BookSafetyReport {
  bookId: string;
  title: string;
  state: BookProtectionState;
  dirtyFiles: number;
  unpushedCommits: number;
  remotelyProtected: boolean;
}

export interface AccountSafetyReport {
  snapshotId?: string;
  dirty: boolean;
  remotelyProtected: boolean;
  confirmedReplicas: string[];
  behindReplicas: string[];
  chatCount: number;
}

export interface DeviceSafetyReport {
  account: AccountSafetyReport;
  books: BookSafetyReport[];
  destructiveWarnings: string[];
  safeRemoteCopies: number;
}

export async function getAccountSafetyReport(): Promise<AccountSafetyReport> {
  const snapshot = await loadLocalAccountSnapshot();
  const replicas = useConnectionStore.getState().configuration;
  const entries = [replicas.google, replicas.microsoft, replicas.github].filter(Boolean);
  const confirmed = snapshot ? entries.filter((entry) => entry!.replica.lastKnownRemoteSnapshotId === snapshot.manifest.snapshotId && Boolean(entry!.replica.lastSuccessfulSyncAtUtc)) : [];
  const behind = entries.filter((entry) => entry!.replica.enabled && (!snapshot || entry!.replica.lastKnownRemoteSnapshotId !== snapshot.manifest.snapshotId));
  return {
    snapshotId: snapshot?.manifest.snapshotId,
    dirty: snapshot?.dirty ?? false,
    remotelyProtected: confirmed.length > 0,
    confirmedReplicas: confirmed.map((entry) => entry!.backend),
    behindReplicas: behind.map((entry) => entry!.backend),
    chatCount: snapshot?.data.chats.length ?? 0,
  };
}

export async function getBookSafetyReport(bookId: string): Promise<BookSafetyReport> {
  const book = useSettingsStore.getState().settings.books.find((entry) => entry.id === bookId);
  if (!book) throw new Error(`Book ${bookId} is not registered locally.`);
  const repository = await getLocalRepositoryByBook(book.id, localWorkspaceScope());
  if (!repository) return { bookId, title: book.name, state: "sync-error", dirtyFiles: 0, unpushedCommits: 0, remotelyProtected: false };
  const status = await localStatus(repository.id);
  if (bookStorageMode(book) === "local-only" || repository.remoteKind === "none") {
    return { bookId, title: book.name, state: "local-only", dirtyFiles: status.dirty, unpushedCommits: status.ahead, remotelyProtected: false };
  }
  if (status.dirty || status.ahead) return { bookId, title: book.name, state: "local-unpushed", dirtyFiles: status.dirty, unpushedCommits: status.ahead, remotelyProtected: false };
  if (repository.remoteStatus === "changed" || repository.remoteChanged) return { bookId, title: book.name, state: "remote-behind", dirtyFiles: 0, unpushedCommits: 0, remotelyProtected: true };
  const verified = repository.remoteStatus === "clean" && Boolean(repository.remoteCheckedAt);
  return { bookId, title: book.name, state: verified ? "remote-up-to-date" : "sync-error", dirtyFiles: 0, unpushedCommits: 0, remotelyProtected: verified };
}

export async function getFullDeviceSafetyReport(): Promise<DeviceSafetyReport> {
  const account = await getAccountSafetyReport();
  const books = await Promise.all(useSettingsStore.getState().settings.books.map((book) => getBookSafetyReport(book.id)));
  const warnings: string[] = [];
  if (!account.remotelyProtected) warnings.push(account.dirty ? "Account settings and chats have unsynchronized changes." : "Account data has no confirmed remote copy.");
  for (const book of books) {
    if (book.state === "local-only") warnings.push(`Book \"${book.title}\" exists only on this device.`);
    else if (book.state === "local-unpushed") warnings.push(`Book \"${book.title}\" has ${book.dirtyFiles} dirty files and ${book.unpushedCommits} unpushed commits.`);
    else if (!book.remotelyProtected) warnings.push(`Book \"${book.title}\" has no confirmed current remote copy.`);
  }
  return { account, books, destructiveWarnings: warnings, safeRemoteCopies: account.confirmedReplicas.length + books.filter((book) => book.remotelyProtected).length };
}

export async function deleteAllNarrariumLocalData(confirmation: string): Promise<void> {
  if (confirmation !== "DELETE") throw new Error("Type DELETE to remove all local Narrarium data.");
  await Promise.all([
    deleteAllLocalAccountData(),
    deleteAllLocalRepositoryData(),
    deleteAllLocalRewriteOperationData(),
    deleteLocalCloudWriteBarrierData(),
  ]);
  useAuthStore.getState().clearAuth();
  await clearMicrosoftAuthCaches().catch(() => undefined);
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (key?.startsWith("narrarium")) localStorage.removeItem(key);
  }
  for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
    const key = sessionStorage.key(index);
    if (key?.startsWith("narrarium")) sessionStorage.removeItem(key);
  }
}
