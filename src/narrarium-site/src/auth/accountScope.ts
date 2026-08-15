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
import { accountIdentity, shouldResetAccountScope } from "@/auth/accountIdentity";

const ACCOUNT_SCOPE_KEY = "narrarium-account-scope-v1";
let installed = false;

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
  useFeedbackRewriteWorkflowStore.getState().abortController?.abort();
  useAssistantStore.setState({ open: false, busy: false, sessions: [], currentSession: null });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, syncStatus: "idle", driveFileId: null, lastSynced: null, cloudLoaded: false });
  useBooksStore.setState({ structures: {}, loadingIds: new Set(), errors: {}, workingBranches: {}, cloneProgress: {} });
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
  }));
  useGenerateDiffStore.setState({ open: false, loading: false, title: "", oldText: "", newText: "", error: null, make: null, proposal: null, onApplied: null });
  useNavigationHistoryStore.setState({ current: null, previous: null });
  usePageActionsStore.setState({ actions: [] });
  useRepositorySyncStore.setState({ current: null });
  useSaveStore.setState({ current: null });
  useProseEditorStore.setState({ editors: [] });
  useUiStore.setState({ debugOpen: false, actionsOpen: false, dossierSearchOpen: false, notesOpen: false, authActivity: "idle" });
}

export function installAccountScopeIsolation(): void {
  if (installed) return;
  installed = true;
  let activeIdentity = accountIdentity(useAuthStore.getState().user);
  const storedIdentity = loadAccountScope();
  const accountChanged = shouldResetAccountScope(storedIdentity, activeIdentity);
  if (accountChanged) resetAccountScopedState();
  useLlmDebugStore.getState().setAccount(activeIdentity, storedIdentity, accountChanged);
  storeAccountScope(activeIdentity);

  useAuthStore.subscribe((state) => {
    const nextIdentity = accountIdentity(state.user);
    if (nextIdentity === activeIdentity) return;
    const previousIdentity = activeIdentity;
    activeIdentity = nextIdentity;
    resetAccountScopedState();
    useLlmDebugStore.getState().setAccount(nextIdentity, previousIdentity, true);
    storeAccountScope(nextIdentity);
  });
}
