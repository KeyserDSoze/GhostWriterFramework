import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { useAuthStore } from "@/store/authStore";
import { getLocalRepository, getLocalRepositoryById, makeRepoId, putLocalRepository, putQuarantinedLocalRepository, removeLocalRepository, writeLocalText } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { commitLocalChanges } from "@/repository/repositoryService";

describe("account-scoped local repositories", () => {
  beforeEach(() => {
    useAuthStore.getState().clearAuth();
    vi.restoreAllMocks();
  });

  it("uses immutable account scope in repository IDs", () => {
    useAuthStore.setState({ user: { provider: "microsoft", providerAccountId: "home-a", name: "A", email: "same@example.com", picture: "", homeAccountId: "home-a", localAccountId: "local-a" } });
    const first = makeRepoId("Owner", "Repo", "Main");
    useAuthStore.setState({ user: { provider: "microsoft", providerAccountId: "home-b", name: "B", email: "same@example.com", picture: "", homeAccountId: "home-b", localAccountId: "local-b" } });
    expect(makeRepoId("Owner", "Repo", "Main")).not.toBe(first);
  });

  it("does not expose another account's working copy", async () => {
    const repoName = crypto.randomUUID();
    useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-a", name: "A", email: "a@example.com", picture: "" } });
    await putLocalRepository({ bookId: crypto.randomUUID(), owner: "scope-owner", repo: repoName, branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: new Date().toISOString() }, captureRepositoryOperationScope());
    useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-b", name: "B", email: "b@example.com", picture: "" } });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    expect(await getLocalRepository("scope-owner", repoName, "main", "google:sub-b")).toBeNull();
  });

  it("keeps legacy Microsoft email scope quarantined after immutable login", async () => {
    const repoName = crypto.randomUUID();
    const user = { provider: "microsoft" as const, name: "A", email: "same@example.com", picture: "" };
    useAuthStore.setState({ user });
    const legacy = await putQuarantinedLocalRepository({ bookId: crypto.randomUUID(), owner: "scope-owner", repo: repoName, branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: new Date().toISOString(), accountScope: "microsoft:same@example.com" });
    useAuthStore.setState({ user: { ...user, providerAccountId: "home-a", homeAccountId: "home-a", localAccountId: "local-a" } });
    const promoted = await getLocalRepository("scope-owner", repoName, "main", "microsoft:home-a");
    expect(promoted).toBeNull();
    expect(legacy.accountScope).toBe("microsoft:same@example.com");
  });

  it("never promotes an unscoped dirty legacy working copy", async () => {
    const repoName = crypto.randomUUID();
    useAuthStore.setState({ user: null });
    const legacy = await putQuarantinedLocalRepository({ bookId: crypto.randomUUID(), owner: "scope-owner", repo: repoName, branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: new Date().toISOString() });
    useAuthStore.setState({ user: { provider: "microsoft", providerAccountId: "home-a", name: "A", email: "a@example.com", picture: "", homeAccountId: "home-a", localAccountId: "local-a" } });
    vi.spyOn(window, "confirm");
    expect(await getLocalRepository("scope-owner", repoName, "main", "microsoft:home-a")).toBeNull();
    expect(window.confirm).not.toHaveBeenCalled();
    expect(legacy.accountScope).toBeUndefined();
  });

  it("requires the current exact account for direct-ID access", async () => {
    const repoName = crypto.randomUUID();
    useAuthStore.setState({ user: null });
    const unscoped = await putQuarantinedLocalRepository({ bookId: "book", owner: "scope-owner", repo: repoName, branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: new Date().toISOString() });
    useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-a", name: "A", email: "a@example.com", picture: "" } });
    const scoped = await putLocalRepository({ bookId: "book", owner: "scope-owner", repo: repoName, branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: new Date().toISOString() }, captureRepositoryOperationScope());

    expect(await getLocalRepositoryById(unscoped.id, "google:sub-a")).toBeNull();
    expect(await getLocalRepositoryById(scoped.id, "google:sub-b")).toBeNull();
    expect(await getLocalRepositoryById(scoped.id, "google:sub-a")).toMatchObject({ id: scoped.id, accountScope: "google:sub-a" });
  });

  it("rejects unscoped and foreign repo IDs from service mutations", async () => {
    const repoName = crypto.randomUUID();
    const base = { bookId: "book", owner: "scope-owner", repo: repoName, branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: new Date().toISOString() };
    useAuthStore.setState({ user: null });
    const unscoped = await putQuarantinedLocalRepository(base);
    useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-a", name: "A", email: "a@example.com", picture: "" } });
    const foreign = await putQuarantinedLocalRepository({ ...base, accountScope: "google:b@example.com" });
    const exact = await putLocalRepository(base, captureRepositoryOperationScope());
    const target = { bookId: "book", owner: "scope-owner", repo: repoName, branch: "main", accountIdentity: "google:sub-a" };

    await expect(commitLocalChanges({ ...target, repoId: unscoped.id }, "blocked")).rejects.toThrow("not ready");
    await expect(commitLocalChanges({ ...target, repoId: foreign.id }, "blocked")).rejects.toThrow("not ready");
    await writeLocalText(exact.id, "plot.md", "change");
    await expect(commitLocalChanges({ ...target, repoId: exact.id }, "accepted")).resolves.toMatchObject({ message: "accepted" });
  });

  it("rejects repository create and remove after an account switch", async () => {
    useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-a", name: "A", email: "a@example.com", picture: "" } });
    const stale = captureRepositoryOperationScope();
    const repository = await putLocalRepository({ bookId: "book", owner: "owner", repo: crypto.randomUUID(), branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: new Date().toISOString() }, stale);
    useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-b", name: "B", email: "b@example.com", picture: "" } });

    await expect(putLocalRepository({ bookId: "other", owner: "owner", repo: crypto.randomUUID(), branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: new Date().toISOString() }, stale)).rejects.toMatchObject({ code: "REPOSITORY_OWNERSHIP_CHANGED" });
    await expect(removeLocalRepository(repository.id, stale)).rejects.toMatchObject({ code: "REPOSITORY_OWNERSHIP_CHANGED" });
  });

  it("isolates recreated Google accounts and preserves same-sub email changes", async () => {
    const repoName = crypto.randomUUID();
    useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-a", name: "A", email: "same@example.com", picture: "" } });
    const repository = await putLocalRepository({ bookId: "book", owner: "owner", repo: repoName, branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: new Date().toISOString() }, captureRepositoryOperationScope());
    useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-a", name: "A", email: "renamed@example.com", picture: "" } });
    expect(await getLocalRepositoryById(repository.id, "google:sub-a")).not.toBeNull();
    useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-b", name: "B", email: "same@example.com", picture: "" } });
    expect(await getLocalRepositoryById(repository.id, "google:sub-b")).toBeNull();
  });

  it("keeps legacy Google email-scoped repositories quarantined", async () => {
    const legacy = await putQuarantinedLocalRepository({ bookId: "book", owner: "owner", repo: crypto.randomUUID(), branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: new Date().toISOString(), accountScope: "google:same@example.com" });
    useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-a", name: "A", email: "same@example.com", picture: "" } });
    expect(await getLocalRepositoryById(legacy.id, "google:sub-a")).toBeNull();
  });
});
