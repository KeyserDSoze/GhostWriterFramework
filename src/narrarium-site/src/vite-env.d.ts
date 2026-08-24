/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __NARRARIUM_E2E_BUILD__: boolean;

interface Window {
  __narrariumE2e?: {
    upgradeStorage(repoId: string, accountIdentity: string): Promise<import("./e2eBridge").E2eStorageUpgradeResult>;
    closeRewriteStorage(): Promise<void>;
    writePrimaryFile(repoId: string, path: string, nextText: string, abort?: boolean): Promise<{ before: unknown; after: unknown; error: { name: string; message: string } | null }>;
    writePrimaryFiles(repoId: string, writes: Array<{ path: string; text: string }>): Promise<{ files: unknown[]; error: { name: string; message: string } | null }>;
    crashForceRemoval(target: import("./e2eBridge").E2eRepositoryMaintenanceTarget, phase: Parameters<typeof import("./repository/repositoryMaintenance").crashNextMaintenanceRemovalForTests>[0]): Promise<string | null>;
    resumeForceRemoval(target: import("./e2eBridge").E2eRepositoryMaintenanceTarget): ReturnType<typeof import("./repository/repositoryMaintenance").forceRemoveRepositoryWithoutBackup>;
    inspectRepository(repoId: string, accountIdentity: string): Promise<{ repository: unknown; files: unknown[] }>;
    crashLegacyMigration(target: import("./e2eBridge").E2eRepositoryMigrationTarget, phase: Parameters<typeof import("./repository/localRepository").crashNextRepositoryMigrationForTests>[0]): Promise<string | null>;
    resumeLegacyMigrations(): ReturnType<typeof import("./repository/localRepository").resumeCurrentAccountRepositoryMigrations>;
  };
}
