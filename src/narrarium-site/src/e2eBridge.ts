import { abortNextPrimaryFileWriteForTests, adoptLegacyEmailScopedRepository, applyLocalFileChangesAtomically, crashNextRepositoryMigrationForTests, getLocalFile, getLocalRepositoryById, inspectPrimaryRepositoryDatabaseForTests, listAllLocalFiles, listLocalRecoverySnapshots, listUnpushedLocalCommits, resumeCurrentAccountRepositoryMigrations, writeLocalText } from "@/repository/localRepository";
import { closeLocalRewriteOperationStoreForTests, ensureLocalRewriteOperationStoreReady, inspectRewriteOperationDatabaseForTests } from "@/repository/localRewriteOperationStore";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { crashNextMaintenanceRemovalForTests, forceRemoveRepositoryWithoutBackup, type RepositoryMaintenanceTarget } from "@/repository/repositoryMaintenance";
import { beginStrandedLegacyRecovery, getLegacyAccountUpgradeEvidence, legacyEmailAccountIdentity } from "@/auth/accountIdentity";
import { createLegacyAdoptionConsent } from "@/auth/legacyAdoptionConsent";
import { useAuthStore } from "@/store/authStore";
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

export function installE2eBridge(): void {
  if (!__NARRARIUM_E2E_BUILD__ || import.meta.env.VITE_E2E !== "true") return;
  installAccountScopeIsolation();
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
    crashLegacyMigration: async (target, phase) => {
      const user = useAuthStore.getState().user;
      if (!user?.providerAccountId) throw new Error("E2E immutable user is unavailable.");
      const legacyIdentity = legacyEmailAccountIdentity(user);
      beginStrandedLegacyRecovery(user, legacyIdentity);
      useAuthStore.getState().setInteractiveAuth("e2e-google-token", user);
      const scope = captureRepositoryOperationScope();
      const evidence = getLegacyAccountUpgradeEvidence(user, scope.accountIdentity);
      if (!evidence) throw new Error("E2E legacy migration evidence is unavailable.");
      createLegacyAdoptionConsent(user, { ...target, legacyIdentity, evidenceNonce: evidence.nonce, replaceDisposableTarget: false });
      crashNextRepositoryMigrationForTests(phase);
      try { await adoptLegacyEmailScopedRepository({ ...target, scope }); return null; }
      catch (cause) { return cause instanceof Error ? cause.message : String(cause); }
    },
    resumeLegacyMigrations: () => resumeCurrentAccountRepositoryMigrations(captureRepositoryOperationScope()),
  };
}

export type E2eRepositoryMaintenanceTarget = RepositoryMaintenanceTarget;
export type E2eRepositoryMigrationTarget = { bookId: string; owner: string; repo: string; branch: string };
