import { create } from "zustand";
import { localWorkspaceScope } from "@/account/deviceIdentity";
import { ACCOUNT_LOCAL_CHANGED_EVENT, loadLocalSyncConfiguration, saveLocalSyncConfiguration, withoutRefreshTokens } from "@/account/accountLocalStore";
import { revoke } from "@/account/credentialBroker";
import { deleteRefreshToken, loadRefreshToken, saveRefreshToken, type VaultProvider } from "@/account/credentialVault";
import type {
  AccountSyncBackendKind,
  LocalGitHubConnection,
  LocalGoogleConnection,
  LocalMicrosoftConnection,
  LocalReplicaState,
  LocalSyncConfiguration,
} from "@/account/types";
import { useAuthStore } from "@/store/authStore";
import { setConnectedGitHubToken } from "@/github/githubCredentialRuntime";

const idleReplica = (enabled = false): LocalReplicaState => ({ enabled, status: enabled ? "dirty" : "disabled" });

/**
 * What may be written to the device database. A refresh token is never part of it, not even for a remembered
 * connection: those are sealed in the credential vault instead (see credentialVault.ts).
 */
export function persistedConfiguration(configuration: LocalSyncConfiguration): LocalSyncConfiguration {
  const sanitize = <T extends { rememberMe: boolean; accessToken?: string }>(connection: T | undefined): T | undefined => {
    if (!connection || connection.rememberMe) return connection;
    const { accessToken: _accessToken, ...safe } = connection;
    return safe as T;
  };
  const withoutSecrets = withoutRefreshTokens(configuration);
  const github = withoutSecrets.github && !withoutSecrets.github.rememberMe
    ? { ...withoutSecrets.github, token: undefined }
    : withoutSecrets.github;
  return { google: sanitize(withoutSecrets.google), microsoft: sanitize(withoutSecrets.microsoft), github };
}

type DriveBackend = "google-drive" | "onedrive";
type DriveConnection = LocalGoogleConnection | LocalMicrosoftConnection;

const vaultProvider = (backend: DriveBackend): VaultProvider => (backend === "google-drive" ? "google" : "microsoft");
const driveKey = (backend: DriveBackend): "google" | "microsoft" => (backend === "google-drive" ? "google" : "microsoft");

/** Keeps the connection's refresh token on this device (sealed) when it is remembered, and drops any older one otherwise. */
async function rememberRefreshToken(backend: DriveBackend, connection: DriveConnection): Promise<void> {
  if (connection.refreshToken && connection.rememberMe) await saveRefreshToken(vaultProvider(backend), connection.identity.providerAccountId, connection.refreshToken);
  else await deleteRefreshToken(vaultProvider(backend));
}

/** The GitHub App's refresh token is sealed like the others (never in the device database, never synced); a PAT has none. */
async function rememberGitHubRefreshToken(connection: LocalGitHubConnection): Promise<void> {
  if (connection.credentialKind === "app" && connection.refreshToken && connection.rememberMe && connection.identity) await saveRefreshToken("github", connection.identity.providerAccountId, connection.refreshToken);
  else await deleteRefreshToken("github");
}

/** The refresh tokens of remembered connections, unsealed into memory when the app starts. */
async function withRestoredRefreshTokens(configuration: LocalSyncConfiguration): Promise<LocalSyncConfiguration> {
  const restored = { ...configuration };
  const github = restored.github;
  if (github?.credentialKind === "app" && github.rememberMe && github.identity) {
    const token = await loadRefreshToken("github", github.identity.providerAccountId);
    if (token) restored.github = { ...github, refreshToken: token };
  }
  for (const backend of ["google-drive", "onedrive"] as const) {
    const key = driveKey(backend);
    const connection = restored[key];
    if (!connection || !connection.rememberMe) continue;
    const token = await loadRefreshToken(vaultProvider(backend), connection.identity.providerAccountId);
    if (token) restored[key] = { ...connection, refreshToken: token } as never;
  }
  return restored;
}

const REVOKE_TIMEOUT_MS = 5_000;

/** Revokes a Google refresh token through the broker. A failure never stops the disconnection, so it is not reported. */
export async function revokeGoogleRefreshToken(refreshToken: string | undefined): Promise<void> {
  if (!refreshToken) return;
  try { await revoke("google", refreshToken, { timeoutMs: REVOKE_TIMEOUT_MS }); } catch { /* best effort */ }
}

interface ConnectionState {
  hydrated: boolean;
  configuration: LocalSyncConfiguration;
  hydrate: () => Promise<void>;
  connectGoogle: (connection: Omit<LocalGoogleConnection, "backend" | "method" | "replica"> & { replica?: LocalReplicaState }) => Promise<void>;
  connectMicrosoft: (connection: Omit<LocalMicrosoftConnection, "backend" | "method" | "replica"> & { replica?: LocalReplicaState }) => Promise<void>;
  connectGitHub: (connection: Omit<LocalGitHubConnection, "backend" | "repositoryName" | "replica"> & { replica?: LocalReplicaState }) => Promise<void>;
  setEnabled: (backend: AccountSyncBackendKind, enabled: boolean) => Promise<void>;
  updateAccessToken: (backend: "google-drive" | "onedrive", accessToken: string, accessTokenExpiry: number) => Promise<void>;
  /** Saves what a renewal returned: the new access token, its expiry and, when there is one, the new refresh token. */
  updateCredentials: (backend: DriveBackend, credentials: { accessToken: string; accessTokenExpiry: number; refreshToken?: string }) => Promise<void>;
  /** Forgets a refresh token that no longer works, here and on the device. The connection itself stays. */
  clearRefreshToken: (backend: DriveBackend) => Promise<void>;
  /** Adopts what another tab saved on the device meanwhile (a fresher access token, a rotated refresh token). */
  reloadCredentialsFromDevice: (backend: DriveBackend) => Promise<void>;
  updateReplica: (backend: AccountSyncBackendKind, patch: Partial<LocalReplicaState>) => Promise<void>;
  disconnect: (backend: AccountSyncBackendKind) => Promise<void>;
}

function connectionKey(backend: AccountSyncBackendKind): keyof LocalSyncConfiguration {
  return backend === "google-drive" ? "google" : backend === "onedrive" ? "microsoft" : "github";
}

async function persist(configuration: LocalSyncConfiguration): Promise<void> {
  await saveLocalSyncConfiguration(persistedConfiguration(configuration));
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  hydrated: false,
  configuration: {},
  hydrate: async () => {
    if (get().hydrated) return;
    const configuration = await loadLocalSyncConfiguration();
    const legacy = useAuthStore.getState();
    if (legacy.user && !configuration.google && !configuration.microsoft) {
      if (legacy.user.provider === "google") {
        configuration.google = {
          backend: "google-drive",
          method: "google",
          identity: {
            provider: "google",
            providerAccountId: legacy.user.providerAccountId ?? "",
            displayName: legacy.user.name,
            email: legacy.user.email,
            avatarUrl: legacy.user.picture,
          },
          accessToken: legacy.accessToken ?? undefined,
          accessTokenExpiry: legacy.accessTokenExpiry ?? undefined,
          rememberMe: legacy.rememberMe,
          replica: idleReplica(true),
        };
      } else {
        configuration.microsoft = {
          backend: "onedrive",
          method: "microsoft",
          identity: {
            provider: "microsoft",
            providerAccountId: legacy.user.providerAccountId ?? legacy.user.homeAccountId ?? "",
            displayName: legacy.user.name,
            email: legacy.user.email,
            avatarUrl: legacy.user.picture,
          },
          accessToken: legacy.accessToken ?? undefined,
          accessTokenExpiry: legacy.accessTokenExpiry ?? undefined,
          homeAccountId: legacy.user.homeAccountId ?? legacy.user.providerAccountId ?? "",
          localAccountId: legacy.user.localAccountId ?? "",
          rememberMe: legacy.rememberMe,
          replica: idleReplica(true),
        };
      }
      await persist(configuration);
    }
    const restored = await withRestoredRefreshTokens(configuration);
    setConnectedGitHubToken(restored.github?.token, restored.github?.credentialKind === "app" ? "app" : "connected-pat");
    set({ configuration: restored, hydrated: true });
    if (restored.github?.credentialKind === "app") void import("@/account/githubAppToken").then((module) => module.installGitHubAppTokenRetry());
  },
  connectGoogle: async (connection) => {
    const configuration = { ...get().configuration, google: { ...connection, backend: "google-drive" as const, method: "google" as const, replica: connection.replica ?? idleReplica(true) } };
    set({ configuration });
    await persist(configuration);
    await rememberRefreshToken("google-drive", configuration.google);
  },
  connectMicrosoft: async (connection) => {
    const configuration = { ...get().configuration, microsoft: { ...connection, backend: "onedrive" as const, method: "microsoft" as const, replica: connection.replica ?? idleReplica(true) } };
    set({ configuration });
    await persist(configuration);
    await rememberRefreshToken("onedrive", configuration.microsoft);
  },
  connectGitHub: async (connection) => {
    const configuration = { ...get().configuration, github: { ...connection, backend: "github" as const, repositoryName: "narrarium.settings" as const, replica: connection.replica ?? idleReplica(connection.accountSyncEnabled) } };
    set({ configuration });
    setConnectedGitHubToken(configuration.github.token, configuration.github.credentialKind === "app" ? "app" : "connected-pat");
    await persist(configuration);
    await rememberGitHubRefreshToken(configuration.github);
    // The access token of the app lasts 8 hours: any request that GitHub refuses as expired is renewed once and repeated (see githubAppToken).
    if (configuration.github.credentialKind === "app") void import("@/account/githubAppToken").then((module) => module.installGitHubAppTokenRetry());
  },
  setEnabled: async (backend, enabled) => {
    const key = connectionKey(backend);
    const current = get().configuration[key];
    if (!current) throw new Error(`${backend} is not connected on this device.`);
    const replica = { ...current.replica, enabled, status: enabled ? "dirty" as const : "disabled" as const };
    const next = key === "github" ? { ...current, accountSyncEnabled: enabled, replica } : { ...current, replica };
    const configuration = { ...get().configuration, [key]: next } as LocalSyncConfiguration;
    set({ configuration });
    await persist(configuration);
  },
  updateAccessToken: async (backend, accessToken, accessTokenExpiry) => {
    const key = connectionKey(backend);
    const current = get().configuration[key];
    if (!current || !("accessToken" in current)) throw new AccountCredentialError(backend, "missing");
    const configuration = { ...get().configuration, [key]: { ...current, accessToken, accessTokenExpiry } } as LocalSyncConfiguration;
    set({ configuration });
    await persist(configuration);
  },
  updateCredentials: async (backend, credentials) => {
    const key = driveKey(backend);
    const current = get().configuration[key];
    if (!current) throw new AccountCredentialError(backend, "missing");
    // Google sends no new refresh token: the one in use stays. Microsoft sends a rotated one every time: that one replaces it.
    const refreshToken = credentials.refreshToken ?? current.refreshToken;
    const next = { ...current, accessToken: credentials.accessToken, accessTokenExpiry: credentials.accessTokenExpiry, ...(refreshToken ? { refreshToken } : {}) } as DriveConnection;
    set({ configuration: { ...get().configuration, [key]: next } as LocalSyncConfiguration });
    // The rotated token is the one that must survive a crash, so it is sealed before the rest is written.
    if (credentials.refreshToken && credentials.refreshToken !== current.refreshToken) await rememberRefreshToken(backend, next);
    await persist(get().configuration);
  },
  clearRefreshToken: async (backend) => {
    const key = driveKey(backend);
    const current = get().configuration[key];
    if (!current?.refreshToken) return;
    const { refreshToken: _forgotten, ...rest } = current;
    set({ configuration: { ...get().configuration, [key]: rest } as LocalSyncConfiguration });
    await deleteRefreshToken(vaultProvider(backend));
    await persist(get().configuration);
  },
  reloadCredentialsFromDevice: async (backend) => {
    const key = driveKey(backend);
    const known = get().configuration[key];
    if (!known?.rememberMe) return;
    const accountId = known.identity.providerAccountId;
    let stored: DriveConnection | undefined;
    try { stored = (await loadLocalSyncConfiguration())[key]; } catch { stored = undefined; }
    const sealed = await loadRefreshToken(vaultProvider(backend), accountId);
    const current = get().configuration[key];
    if (!current || current.identity.providerAccountId !== accountId) return;
    const sameAccount = stored?.identity.providerAccountId === accountId && (backend === "google-drive" || (stored as LocalMicrosoftConnection).homeAccountId === (current as LocalMicrosoftConnection).homeAccountId);
    const patch: Partial<DriveConnection> = {};
    if (stored && sameAccount && stored.accessToken && (stored.accessTokenExpiry ?? 0) > (current.accessTokenExpiry ?? 0)) {
      patch.accessToken = stored.accessToken;
      patch.accessTokenExpiry = stored.accessTokenExpiry;
    }
    if (sealed && sealed !== current.refreshToken) patch.refreshToken = sealed;
    if (Object.keys(patch).length) set({ configuration: { ...get().configuration, [key]: { ...current, ...patch } } as LocalSyncConfiguration });
  },
  updateReplica: async (backend, patch) => {
    const key = connectionKey(backend);
    const current = get().configuration[key];
    if (!current) return;
    const configuration = { ...get().configuration, [key]: { ...current, replica: { ...current.replica, ...patch } } } as LocalSyncConfiguration;
    set({ configuration });
    await persist(configuration);
  },
  disconnect: async (backend) => {
    const key = connectionKey(backend);
    const previous = get().configuration[key];
    const configuration = { ...get().configuration };
    delete configuration[key];
    set({ configuration });
    if (backend === "github") setConnectedGitHubToken(undefined);
    await persist(configuration);
    if (backend === "github") {
      // Gone from this device first; then the grant is revoked (best effort: a refusal never keeps the connection) and the sealed token forgotten.
      const github = previous as LocalGitHubConnection | undefined;
      await deleteRefreshToken("github");
      if (github?.credentialKind === "app") await import("@/account/githubAppToken").then((module) => module.revokeGitHubAppGrant(github)).catch(() => undefined);
      return;
    }
    // The connection is gone from this device before anything is asked of Google. Microsoft has nothing to revoke a
    // refresh token with: it is only forgotten here.
    const refreshToken = (previous as DriveConnection | undefined)?.refreshToken;
    await deleteRefreshToken(vaultProvider(backend));
    if (backend === "google-drive") await revokeGoogleRefreshToken(refreshToken);
  },
}));

let installed = false;

/** Marks enabled replicas dirty after logical account mutations, never after connector-only changes. */
export function installAccountDirtyPropagation(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener(ACCOUNT_LOCAL_CHANGED_EVENT, (event) => {
    if (event instanceof CustomEvent && event.detail?.logical === false) return;
    const state = useConnectionStore.getState();
    for (const backend of ["google-drive", "onedrive", "github"] as const) {
      const connection = state.configuration[connectionKey(backend)];
      // A replica that waits for the owner to fix something on GitHub stays in its error: more changes do not make it a new attempt.
      if (connection?.replica.enabled && connection.replica.status !== "syncing" && connection.replica.errorKind !== "repository-unreachable") void state.updateReplica(backend, { status: "dirty" });
    }
  });
}

export class AccountCredentialError extends Error {
  /** `code` is the provider's own code for why the sign-in has to be renewed (such as MSAL's `timed_out`), when there is one. */
  constructor(readonly backend: AccountSyncBackendKind, readonly reason: "missing" | "expired", readonly code?: string) {
    super(`${backend} credential is ${reason}${code ? ` (${code})` : ""}.`);
    this.name = "AccountCredentialError";
  }
}

export function accountBackendToken(backend: AccountSyncBackendKind): string {
  const configuration = useConnectionStore.getState().configuration;
  const connection = configuration[connectionKey(backend)];
  const token = connection && "token" in connection
    ? connection.token
    : connection && "accessToken" in connection ? connection.accessToken : undefined;
  if (!token) throw new AccountCredentialError(backend, "missing");
  // Expiry is checked only when a remote operation explicitly asks for a token.
  if (connection && "accessTokenExpiry" in connection && connection.accessTokenExpiry && connection.accessTokenExpiry <= Date.now()) {
    throw new AccountCredentialError(backend, "expired");
  }
  return token;
}

export function currentLocalWorkspaceLabel(): string {
  return localWorkspaceScope();
}
