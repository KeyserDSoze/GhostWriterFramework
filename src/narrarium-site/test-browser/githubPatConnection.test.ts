import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";

const github = vi.hoisted(() => ({ user: { id: 42, login: "writer", name: "The Writer", email: null as string | null, avatar_url: "https://avatars.example/w" } }));
vi.mock("@octokit/rest", () => ({ Octokit: class { rest = { users: { getAuthenticated: async () => ({ data: github.user }) } }; } }));

import { closeAccountLocalStoreForTests, initializeAccountLocalStore } from "@/account/accountLocalStore";
import { useConnectionStore } from "@/account/connectionStore";
import { accountSyncForNewGitHubConnection } from "@/account/githubSyncChoice";
import { connectGitHubCredential } from "@/github/githubConnection";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { emptyCostsFile } from "@/costs/model";

const identity = (id: string) => ({ provider: "github" as const, providerAccountId: id, displayName: "W", username: "writer" });
const github_ = () => useConnectionStore.getState().configuration.github;

beforeEach(async () => {
  closeAccountLocalStoreForTests();
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase("narrarium-local-account");
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
  });
  await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
  useConnectionStore.setState({ hydrated: true, configuration: {} });
});

describe("whether a new GitHub connection syncs the account", () => {
  it("is on by itself for a personal access token that was never configured", async () => {
    await connectGitHubCredential({ token: "ghp_new", kind: "pat", rememberMe: true });
    expect(github_()).toMatchObject({ credentialKind: "pat", accountSyncEnabled: true, replica: { enabled: true }, repositoryName: "narrarium.settings" });
  });

  it("keeps the owner's choice for the same account: switched off stays off", async () => {
    await useConnectionStore.getState().connectGitHub({ method: "github-pat", credentialKind: "pat", identity: identity("42"), token: "ghp_old", rememberMe: true, accountSyncEnabled: false, repositoryOwner: "writer", replica: { enabled: false, status: "disabled" } });
    await connectGitHubCredential({ token: "ghp_replaced", kind: "pat", rememberMe: true });
    expect(github_()).toMatchObject({ token: "ghp_replaced", accountSyncEnabled: false, replica: { enabled: false } });
  });

  it("keeps it on for the same account that had it on", async () => {
    await useConnectionStore.getState().connectGitHub({ method: "github-pat", credentialKind: "pat", identity: identity("42"), token: "ghp_old", rememberMe: true, accountSyncEnabled: true, repositoryOwner: "writer" });
    await connectGitHubCredential({ token: "ghp_replaced", kind: "pat", rememberMe: true });
    expect(github_()).toMatchObject({ accountSyncEnabled: true, replica: { enabled: true } });
  });

  it("starts afresh, on, for another GitHub account", async () => {
    await useConnectionStore.getState().connectGitHub({ method: "github-pat", credentialKind: "pat", identity: identity("7"), token: "ghp_old", rememberMe: true, accountSyncEnabled: false, repositoryOwner: "other", replica: { enabled: false, status: "disabled" } });
    await connectGitHubCredential({ token: "ghp_new", kind: "pat", rememberMe: true });
    expect(github_()).toMatchObject({ identity: { providerAccountId: "42" }, accountSyncEnabled: true, replica: { enabled: true } });
  });

  it("an explicit choice of the caller wins", async () => {
    await connectGitHubCredential({ token: "ghp_new", kind: "pat", rememberMe: true, accountSyncEnabled: false });
    expect(github_()).toMatchObject({ accountSyncEnabled: false });
  });

  it("is decided by one rule for the app and the token alike", () => {
    expect(accountSyncForNewGitHubConnection(undefined, "42")).toBe(true);
    expect(accountSyncForNewGitHubConnection({ identity: identity("42"), accountSyncEnabled: false }, "42")).toBe(false);
    expect(accountSyncForNewGitHubConnection({ identity: identity("42"), accountSyncEnabled: true }, "42")).toBe(true);
    expect(accountSyncForNewGitHubConnection({ identity: identity("42"), accountSyncEnabled: false }, "43")).toBe(true);
    expect(accountSyncForNewGitHubConnection({ accountSyncEnabled: false }, "42")).toBe(true);
  });
});
