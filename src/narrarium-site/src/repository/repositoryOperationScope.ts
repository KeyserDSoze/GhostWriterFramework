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

export function captureRepositoryOperationScope(): RepositoryOperationScope {
  const identity = accountIdentity(useAuthStore.getState().user);
  if (!identity) throw new RepositoryOwnershipChangedError("A current immutable account identity is required.");
  return Object.freeze({ accountIdentity: identity, accountGeneration: useSettingsStore.getState().accountGeneration });
}

export function assertRepositoryOperationScopeCurrent(scope: RepositoryOperationScope): void {
  if (accountIdentity(useAuthStore.getState().user) !== scope.accountIdentity
    || useSettingsStore.getState().accountGeneration !== scope.accountGeneration) {
    throw new RepositoryOwnershipChangedError();
  }
}
