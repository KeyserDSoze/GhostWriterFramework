import type { AppSettings } from "@/types/settings";
import type { SensitiveAccountData } from "@/account/types";
import { isDeviceLocalSecret } from "@/account/deviceSecrets";

/** A token field that holds a secret of this device (the GitHub App's access token) is empty in everything that is synced. */
const syncable = (token: string): string => (isDeviceLocalSecret(token) ? "" : token);

/** Removes fields that identify this browser or one of its local connectors. */
export function projectSyncableSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    defaultGitHubToken: syncable(settings.defaultGitHubToken),
    extraGitHubTokens: settings.extraGitHubTokens.map((entry) => ({ ...entry, token: syncable(entry.token) })),
    books: settings.books.map((book) => {
      const { localRepositoryId: _localRepositoryId, activeBranch: _activeBranch, exportSettings: _exportSettings, ...portableBook } = book;
      if (portableBook.bookToken && isDeviceLocalSecret(portableBook.bookToken)) delete portableBook.bookToken;
      const rawExportSettings = book.exportSettings && {
        ...book.exportSettings,
        googleDriveFolderId: undefined,
        googleDriveFolderName: undefined,
        microsoftDriveFolderPath: undefined,
      };
      const exportSettings = nonEmptyObject(rawExportSettings);
      return { ...portableBook, ...(exportSettings ? { exportSettings } : {}) };
    }),
  };
}

/** Reapply fields that belong to this browser after adopting a remote dataset. */
export function mergeLocalDeviceSettings(local: AppSettings, remote: AppSettings): AppSettings {
  const localById = new Map(local.books.map((book) => [book.id, book]));
  const portableRemote = projectSyncableSettings(remote);
  return {
    ...portableRemote,
    books: portableRemote.books.map((book) => {
      const device = localById.get(book.id);
      if (!device) return book;
      const exportSettings = nonEmptyObject({
        ...book.exportSettings,
        googleDriveFolderId: device.exportSettings?.googleDriveFolderId,
        googleDriveFolderName: device.exportSettings?.googleDriveFolderName,
        microsoftDriveFolderPath: device.exportSettings?.microsoftDriveFolderPath,
      });
      return {
        ...book,
        ...(device.localRepositoryId ? { localRepositoryId: device.localRepositoryId } : {}),
        ...(device.activeBranch ? { activeBranch: device.activeBranch } : {}),
        ...(exportSettings ? { exportSettings } : {}),
      };
    }),
  };
}

function nonEmptyObject<T extends object>(value: T | undefined): T | undefined {
  if (!value) return undefined;
  return Object.values(value).some((entry) => entry !== undefined) ? value : undefined;
}

export function sensitiveAccountData(settings: AppSettings): SensitiveAccountData {
  return {
    defaultGitHubToken: syncable(settings.defaultGitHubToken),
    extraGitHubTokens: settings.extraGitHubTokens.map((entry) => ({ ...entry, token: syncable(entry.token) })),
    bookTokens: Object.fromEntries(settings.books.filter((book) => book.bookToken && !isDeviceLocalSecret(book.bookToken)).map((book) => [book.id, { token: book.bookToken!, ...(book.bookTokenLabel ? { label: book.bookTokenLabel } : {}) }])),
    aiApiKeys: Object.fromEntries(settings.aiIntegrations.filter((integration) => integration.apiKey).map((integration) => [integration.id, integration.apiKey])),
    searchApiKeys: { braveApiKey: settings.deepSearch.braveApiKey, tavilyApiKey: settings.deepSearch.tavilyApiKey },
  };
}
