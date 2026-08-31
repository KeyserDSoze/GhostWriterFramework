import { abortNextPrimaryFileWriteForTests, applyLocalFileChangesAtomically, getLocalFile, getLocalRepositoryById, inspectPrimaryRepositoryDatabaseForTests, listAllLocalFiles, listLocalRecoverySnapshots, listUnpushedLocalCommits, writeLocalText } from "@/repository/localRepository";
import { closeLocalRewriteOperationStoreForTests, ensureLocalRewriteOperationStoreReady, inspectRewriteOperationDatabaseForTests } from "@/repository/localRewriteOperationStore";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { crashNextMaintenanceRemovalForTests, forceRemoveRepositoryWithoutBackup, type RepositoryMaintenanceTarget } from "@/repository/repositoryMaintenance";
import { installAccountScopeIsolation } from "@/auth/accountScope";

export interface E2eStorageUpgradeResult {
  repository: Awaited<ReturnType<typeof getLocalRepositoryById>>;
  files: Awaited<ReturnType<typeof listAllLocalFiles>>;
  commits: Awaited<ReturnType<typeof listUnpushedLocalCommits>>;
  recoveries: Awaited<ReturnType<typeof listLocalRecoverySnapshots>>;
  primaryVersion: number;
  rewriteVersion: number;
  primaryStores: string[];
  rewriteStores: string[];
  primaryRecords: Record<string, Array<Record<string, unknown>>>;
  rewriteRecords: Record<string, Array<Record<string, unknown>>>;
}

export async function installE2eBridge(): Promise<void> {
  if (!__NARRARIUM_E2E_BUILD__ || import.meta.env.VITE_E2E !== "true") return;
  await installAccountScopeIsolation();
  window.__narrariumE2e = {
    upgradeStorage: async (repoId, accountIdentity) => {
      const repository = await getLocalRepositoryById(repoId, accountIdentity);
      await ensureLocalRewriteOperationStoreReady();
      const [primary, rewrite] = await Promise.all([
        inspectPrimaryRepositoryDatabaseForTests(),
        inspectRewriteOperationDatabaseForTests(),
      ]);
      return {
        repository,
        files: await listAllLocalFiles(repoId),
        commits: await listUnpushedLocalCommits(repoId),
        recoveries: await listLocalRecoverySnapshots(repoId, accountIdentity),
        primaryVersion: primary.version,
        rewriteVersion: rewrite.version,
        primaryStores: primary.stores,
        rewriteStores: rewrite.stores,
        primaryRecords: primary.records,
        rewriteRecords: rewrite.records,
      };
    },
    closeRewriteStorage: closeLocalRewriteOperationStoreForTests,
    writePrimaryFile: async (repoId, path, nextText, abort = false) => {
      const scope = captureRepositoryOperationScope();
      const before = await getLocalFile(repoId, path, scope);
      if (abort) abortNextPrimaryFileWriteForTests();
      let error: { name: string; message: string } | null = null;
      try { await writeLocalText(repoId, path, nextText, scope); }
      catch (cause) { error = { name: cause instanceof Error ? cause.name : "Error", message: String(cause) }; }
      const after = await getLocalFile(repoId, path, scope);
      return { before, after, error };
    },
    writePrimaryFiles: async (repoId, writes) => {
      const scope = captureRepositoryOperationScope();
      let error: { name: string; message: string } | null = null;
      try { await applyLocalFileChangesAtomically(repoId, scope, [], writes.map(({ path, text }) => ({ path, kind: "text" as const, text }))); }
      catch (cause) { error = { name: cause instanceof Error ? cause.name : "Error", message: String(cause) }; }
      return { files: await listAllLocalFiles(repoId), error };
    },
    crashForceRemoval: async (target, phase) => {
      crashNextMaintenanceRemovalForTests(phase);
      try { await forceRemoveRepositoryWithoutBackup(target, `FORCE RECLONE ${target.owner}/${target.repo}#${target.branch}`); return null; }
      catch (cause) { return cause instanceof Error ? cause.message : String(cause); }
    },
    resumeForceRemoval: (target) => forceRemoveRepositoryWithoutBackup(target, `FORCE RECLONE ${target.owner}/${target.repo}#${target.branch}`),
    inspectRepository: async (repoId, accountIdentity) => ({ repository: await getLocalRepositoryById(repoId, accountIdentity), files: await listAllLocalFiles(repoId) }),
  };
}

export type E2eRepositoryMaintenanceTarget = RepositoryMaintenanceTarget;
