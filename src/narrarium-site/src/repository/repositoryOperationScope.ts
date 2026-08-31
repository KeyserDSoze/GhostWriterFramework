import { localWorkspaceScope } from "@/account/deviceIdentity";
import { accountIdentity } from "@/auth/accountIdentity";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";

export interface RepositoryOperationScope {
  readonly accountIdentity: string;
  readonly accountGeneration: number;
}

export class RepositoryOwnershipChangedError extends Error {
  readonly code = "REPOSITORY_OWNERSHIP_CHANGED";

  constructor(message = "The repository operation was cancelled because the active account changed.") {
    super(message);
    this.name = "RepositoryOwnershipChangedError";
  }
}

export function currentRepositoryScopeIdentity(): string {
  const configured = useSettingsStore.getState().accountIdentity;
  if (configured?.startsWith("workspace:")) return configured;
  return accountIdentity(useAuthStore.getState().user) ?? localWorkspaceScope();
}

export function captureRepositoryOperationScope(): RepositoryOperationScope {
  return Object.freeze({ accountIdentity: currentRepositoryScopeIdentity(), accountGeneration: useSettingsStore.getState().accountGeneration });
}

export function assertRepositoryOperationScopeCurrent(scope: RepositoryOperationScope): void {
  if (currentRepositoryScopeIdentity() !== scope.accountIdentity
    || useSettingsStore.getState().accountGeneration !== scope.accountGeneration) {
    throw new RepositoryOwnershipChangedError("The repository operation was cancelled because the local workspace changed.");
  }
}
