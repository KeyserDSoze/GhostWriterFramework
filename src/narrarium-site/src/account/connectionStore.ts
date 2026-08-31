import { create } from "zustand";
import { localWorkspaceScope } from "@/account/deviceIdentity";
import { ACCOUNT_LOCAL_CHANGED_EVENT, loadLocalSyncConfiguration, saveLocalSyncConfiguration } from "@/account/accountLocalStore";
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

function persistedConfiguration(configuration: LocalSyncConfiguration): LocalSyncConfiguration {
  const sanitize = <T extends { rememberMe: boolean; accessToken?: string }>(connection: T | undefined): T | undefined => {
    if (!connection || connection.rememberMe) return connection;
    const { accessToken: _accessToken, ...safe } = connection;
    return safe as T;
  };
  const github = configuration.github && !configuration.github.rememberMe
    ? { ...configuration.github, token: undefined }
    : configuration.github;
  return { google: sanitize(configuration.google), microsoft: sanitize(configuration.microsoft), github };
}

interface ConnectionState {
  hydrated: boolean;
  configuration: LocalSyncConfiguration;
  hydrate: () => Promise<void>;
  connectGoogle: (connection: Omit<LocalGoogleConnection, "backend" | "method" | "replica"> & { replica?: LocalReplicaState }) => Promise<void>;
  connectMicrosoft: (connection: Omit<LocalMicrosoftConnection, "backend" | "method" | "replica"> & { replica?: LocalReplicaState }) => Promise<void>;
  connectGitHub: (connection: Omit<LocalGitHubConnection, "backend" | "repositoryName" | "replica"> & { replica?: LocalReplicaState }) => Promise<void>;
  setEnabled: (backend: AccountSyncBackendKind, enabled: boolean) => Promise<void>;
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
    setConnectedGitHubToken(configuration.github?.token, configuration.github?.credentialKind === "oauth" ? "oauth" : "connected-pat");
    set({ configuration, hydrated: true });
  },
  connectGoogle: async (connection) => {
    const configuration = { ...get().configuration, google: { ...connection, backend: "google-drive" as const, method: "google" as const, replica: connection.replica ?? idleReplica(true) } };
    set({ configuration });
    await persist(configuration);
  },
  connectMicrosoft: async (connection) => {
    const configuration = { ...get().configuration, microsoft: { ...connection, backend: "onedrive" as const, method: "microsoft" as const, replica: connection.replica ?? idleReplica(true) } };
    set({ configuration });
    await persist(configuration);
  },
  connectGitHub: async (connection) => {
    const configuration = { ...get().configuration, github: { ...connection, backend: "github" as const, repositoryName: "narrarium.settings" as const, replica: connection.replica ?? idleReplica(connection.accountSyncEnabled) } };
    set({ configuration });
    setConnectedGitHubToken(configuration.github.token, configuration.github.credentialKind === "oauth" ? "oauth" : "connected-pat");
    await persist(configuration);
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
    const configuration = { ...get().configuration };
    delete configuration[key];
    set({ configuration });
    if (backend === "github") setConnectedGitHubToken(undefined);
    await persist(configuration);
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
      if (connection?.replica.enabled && connection.replica.status !== "syncing") void state.updateReplica(backend, { status: "dirty" });
    }
  });
}

export class AccountCredentialError extends Error {
  constructor(readonly backend: AccountSyncBackendKind, readonly reason: "missing" | "expired") {
    super(`${backend} credential is ${reason}.`);
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
