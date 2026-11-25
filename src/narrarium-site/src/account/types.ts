import type { AssistantSession } from "@/assistant/store";
import type { ClipboardEntry } from "@/clipboard/clipboardStore";
import type { CostsFile } from "@/costs/model";
import type { AppSettings } from "@/types/settings";

export const ACCOUNT_SYNC_SCHEMA_VERSION = 1 as const;
export const ACCOUNT_SYNC_APPLICATION = "Narrarium" as const;

export type AccountConnectionMethod = "github-app" | "github-pat" | "google" | "microsoft";
export type AccountSyncBackendKind = "github" | "google-drive" | "onedrive";
/** `app`: the user token of Narrarium's GitHub App (8 hours, renewed with a rotating refresh token); `pat`: a personal access token. */
export type GitHubCredentialKind = "app" | "pat";
export type ReplicaComparison = "same" | "ahead" | "behind" | "diverged";

export interface AccountSyncManifest {
  application: typeof ACCOUNT_SYNC_APPLICATION;
  schemaVersion: typeof ACCOUNT_SYNC_SCHEMA_VERSION;
  snapshotId: string;
  modifiedAtUtc: string;
  modifiedByDeviceId: string;
  vectorClock: Record<string, number>;
  contentHash?: string;
}

export interface SyncableAccountData {
  schemaVersion: typeof ACCOUNT_SYNC_SCHEMA_VERSION;
  settings: AppSettings;
  costs: CostsFile;
  clipboard: ClipboardEntry[];
  chats: AssistantSession[];
}

/** Secret-bearing subset intentionally synchronized for cross-device restore. */
export interface SensitiveAccountData {
  defaultGitHubToken: string;
  extraGitHubTokens: AppSettings["extraGitHubTokens"];
  bookTokens: Record<string, { token: string; label?: string }>;
  aiApiKeys: Record<string, string>;
  searchApiKeys: Pick<AppSettings["deepSearch"], "braveApiKey" | "tavilyApiKey">;
}

/** Device-only state. This type must never be embedded in SyncableAccountData. */
export interface LocalDeviceConfiguration {
  workspace: LocalWorkspaceIdentity;
  sync: LocalSyncConfiguration;
}

export interface LocalReplicaState {
  enabled: boolean;
  lastAttemptAtUtc?: string;
  lastSuccessfulSyncAtUtc?: string;
  lastKnownRemoteSnapshotId?: string;
  status: "disabled" | "idle" | "dirty" | "syncing" | "needs-auth" | "offline" | "behind" | "ahead" | "diverged" | "error";
  errorKind?: AccountSyncErrorKind;
  /** The message of the last failure, as the error reported it (cut to a bounded length). Cleared with the error. */
  lastErrorMessage?: string;
}

export type AccountSyncErrorKind =
  | "offline"
  | "credential-missing"
  | "credential-invalid"
  | "credential-expired"
  | "permission-denied"
  | "remote-not-found"
  | "remote-deleted"
  | "remote-public"
  | "repository-unreachable"
  | "rate-limited"
  | "cache-revalidation"
  | "remote-changed"
  | "network"
  | "schema-incompatible"
  | "remote-corrupt"
  | "hash-mismatch"
  | "unknown";

export interface ProviderIdentity {
  provider: "github" | "google" | "microsoft";
  providerAccountId: string;
  displayName: string;
  username?: string;
  email?: string;
  avatarUrl?: string;
}

export interface LocalGoogleConnection {
  backend: "google-drive";
  method: "google";
  identity: ProviderIdentity;
  accessToken?: string;
  accessTokenExpiry?: number;
  /**
   * The long-lived credential issued through the token broker. It lives in memory and, with `rememberMe`, sealed in the
   * credential vault: it is never part of the persisted configuration, of the synchronized account data or of any export.
   * A connection without one has "session" credentials that stop working after about an hour.
   */
  refreshToken?: string;
  rememberMe: boolean;
  replica: LocalReplicaState;
}

export interface LocalMicrosoftConnection {
  backend: "onedrive";
  method: "microsoft";
  identity: ProviderIdentity;
  accessToken?: string;
  accessTokenExpiry?: number;
  /** As for Google: memory and the credential vault only. Microsoft rotates it on every renewal. A connection made with MSAL has none. */
  refreshToken?: string;
  homeAccountId: string;
  localAccountId: string;
  rememberMe: boolean;
  replica: LocalReplicaState;
}

export interface LocalGitHubConnection {
  backend: "github";
  method: "github-app" | "github-pat";
  credentialKind: GitHubCredentialKind;
  identity?: ProviderIdentity;
  token?: string;
  /** App connections only: when `token` stops working (the same minute-early expiry as the other providers). Device-local, never synced. */
  accessTokenExpiry?: number;
  /** App connections only: the rotating refresh token. Kept in memory and sealed in the credential vault, never in the device database, never synced. */
  refreshToken?: string;
  rememberMe: boolean;
  accountSyncEnabled: boolean;
  repositoryOwner?: string;
  repositoryName: "narrarium.settings";
  defaultBranch?: string;
  replica: LocalReplicaState;
}

export interface LocalSyncConfiguration {
  google?: LocalGoogleConnection;
  microsoft?: LocalMicrosoftConnection;
  github?: LocalGitHubConnection;
}

export interface LocalWorkspaceIdentity {
  workspaceId: string;
  deviceId: string;
  createdAtUtc: string;
}

export interface LocalAccountSnapshot {
  data: SyncableAccountData;
  manifest: AccountSyncManifest;
  dirty: boolean;
}

export interface AccountRemoteSnapshot {
  backend: AccountSyncBackendKind;
  data: SyncableAccountData;
  manifest: AccountSyncManifest;
  format?: "current" | "legacy" | "repair";
  revision?: string;
  sizeBytes?: number;
}

export interface AccountRemoteExpectation {
  snapshotId?: string;
  contentHash?: string;
  revision?: string;
  absent?: boolean;
  format?: "current" | "legacy" | "repair";
}

export interface AccountSyncBackend {
  readonly kind: AccountSyncBackendKind;
  pull(): Promise<AccountRemoteSnapshot | null>;
  push(snapshot: LocalAccountSnapshot, expected: AccountRemoteExpectation): Promise<{ revision?: string }>;
  deleteRemoteData(): Promise<void>;
}
