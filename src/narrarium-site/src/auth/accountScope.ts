import { emptyCostsFile } from "@/costs/model";
import { useAssistantStore } from "@/assistant/store";
import { useClipboardStore } from "@/clipboard/clipboardStore";
import { useCostsStore } from "@/costs/costsStore";
import { useLlmDebugStore } from "@/debug/llmDebugStore";
import { useProseEditorStore } from "@/components/editor/proseEditorStore";
import { useAuthStore } from "@/store/authStore";
import { useBooksStore } from "@/store/booksStore";
import { useDossierStore } from "@/store/dossierStore";
import { useFeedbackRewriteWorkflowStore } from "@/store/feedbackRewriteWorkflowStore";
import { useGenerateDiffStore } from "@/store/generateDiffStore";
import { useNavigationHistoryStore } from "@/store/navigationHistoryStore";
import { usePageActionsStore } from "@/store/pageActionsStore";
import { useRepositorySyncStore } from "@/store/repositorySyncStore";
import { useSaveStore } from "@/store/saveStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { accountIdentity } from "@/auth/accountIdentity";
import { setFallbackAcknowledgementAccountScope } from "@/assistant/fallbackDisclosure";
import { resetAssistantSessionIndex } from "@/assistant/sessionIndex";
import { migrateCurrentProviderRepositoriesToWorkspace, resumeCurrentAccountRepositoryMigrations } from "@/repository/localRepository";
import { resetBookStructureLoadCoordinator } from "@/hooks/useBookStructure";
import { clearTokenHealth } from "@/repository/tokenHealth";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { localWorkspaceScope } from "@/account/deviceIdentity";

const ACCOUNT_SCOPE_KEY = "narrarium-account-scope-v1";
let installed = false;
export interface AccountScopeInstallationResult { error?: Error }
let installation: Promise<AccountScopeInstallationResult> | null = null;

function storeAccountScope(identity: string | null): void {
  try {
    if (identity) localStorage.setItem(ACCOUNT_SCOPE_KEY, identity);
    else localStorage.removeItem(ACCOUNT_SCOPE_KEY);
  } catch {
    // Account isolation still applies in memory when storage is unavailable.
  }
}

function loadAccountScope(): string | null {
  try {
    return localStorage.getItem(ACCOUNT_SCOPE_KEY);
  } catch {
    return null;
  }
}

export function resetAccountScopedState(): void {
  clearTokenHealth();
  const structureLoadEpoch = resetBookStructureLoadCoordinator();
  useFeedbackRewriteWorkflowStore.getState().abortController?.abort();
  resetAssistantSessionIndex(null);
  useAssistantStore.setState({ open: false, launchMode: null, busy: false, sessions: [], currentSession: null });
  useSettingsStore.setState((state) => ({ settings: DEFAULT_SETTINGS, syncStatus: "idle", driveFileId: null, cloudRevision: null, lastSynced: null, cloudLoaded: false, cloudReconciled: false, offlineConflict: null, accountGeneration: state.accountGeneration + 1, accountIdentity: accountIdentity(useAuthStore.getState().user) }));
  useBooksStore.setState({ structures: {}, loadingIds: new Set(), activeStructureOperations: {}, errors: {}, workingBranches: {}, cloneProgress: {}, structureGenerations: {}, structureLoadEpoch });
  useCostsStore.getState().setFile(emptyCostsFile(), undefined);
  useClipboardStore.getState().setItems([]);
  useLlmDebugStore.getState().clear();
  useDossierStore.getState().clearDossiers();
  useFeedbackRewriteWorkflowStore.setState((state) => ({
    open: false,
    requestId: state.requestId + 1,
    intent: null,
    phase: "loading",
    staleFeedback: false,
    missingSummary: false,
    proposal: null,
    manifest: null,
    operationId: null,
    progress: null,
    error: null,
    conflicts: [],
    rollbackPolicies: {},
    abortController: null,
    abortable: false,
    operationIdentity: null,
  }));
  useGenerateDiffStore.setState({ open: false, loading: false, title: "", oldText: "", newText: "", error: null, make: null, proposal: null, onApplied: null });
  useNavigationHistoryStore.setState({ current: null, previous: null });
  usePageActionsStore.setState({ actions: [] });
  useRepositorySyncStore.setState({ current: null });
  useSaveStore.setState({ current: null });
  useProseEditorStore.setState({ editors: [] });
  useUiStore.setState({ debugOpen: false, actionsOpen: false, dossierSearchOpen: false, notesOpen: false, authActivity: "idle" });
}

export function installAccountScopeIsolation(): Promise<AccountScopeInstallationResult> {
  if (installed) return installation ?? Promise.resolve({});
  installed = true;
  const activeIdentity = localWorkspaceScope();
  setFallbackAcknowledgementAccountScope(activeIdentity);
  const storedIdentity = loadAccountScope();
  useSettingsStore.setState({ accountIdentity: activeIdentity });
  useLlmDebugStore.getState().setAccount(activeIdentity, storedIdentity, false);
  storeAccountScope(activeIdentity);
  const scope = captureRepositoryOperationScope();
  installation = migrateCurrentProviderRepositoriesToWorkspace(scope)
    .then(() => resumeCurrentAccountRepositoryMigrations(scope))
    .then(() => ({}))
    .catch((cause) => ({ error: cause instanceof Error ? cause : new Error(String(cause)) }));
  return installation;
}

export async function migrateConnectedProviderRepositories(): Promise<AccountScopeInstallationResult> {
  const scope = captureRepositoryOperationScope();
  try {
    await migrateCurrentProviderRepositoriesToWorkspace(scope);
    await resumeCurrentAccountRepositoryMigrations(scope);
    return {};
  } catch (cause) {
    return { error: cause instanceof Error ? cause : new Error(String(cause)) };
  }
}
