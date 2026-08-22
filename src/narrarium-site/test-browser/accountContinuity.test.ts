import { beforeEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import {
  ACCOUNT_CONTINUITY_STORAGE_KEY,
  LEGACY_AUTH_STORAGE_KEY,
  clearAccountContinuity,
  createVolatileAuthState,
  continuityToUser,
  migrateLegacyAuthStorage,
  readAccountContinuity,
  sanitizeVolatileAuthStorage,
  saveAccountContinuity,
} from "@/auth/accountContinuity";
import { PERSISTENT_AUTH_STORAGE_KEY, readPersistentAuth, useAuthStore } from "@/store/authStore";

const google = { provider: "google" as const, providerAccountId: "google-sub", name: "Writer", email: "Writer@Example.com", picture: "" };
const microsoft = { provider: "microsoft" as const, providerAccountId: "home-id", homeAccountId: "home-id", localAccountId: "local-id", name: "Writer", email: "writer@example.com", picture: "" };

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  clearAccountContinuity();
  useAuthStore.setState({ user: null, accessToken: null, accessTokenExpiry: null, rememberMe: false, provider: null, providerAccountId: null, interactiveRecoveryIdentity: null });
});

describe("AccountContinuity", () => {
  it("stores the exact bounded identity schema and never a bearer", () => {
    saveAccountContinuity(google, 1000);
    saveAccountContinuity(microsoft, 2000);
    const stored = JSON.parse(localStorage.getItem(ACCOUNT_CONTINUITY_STORAGE_KEY)!);
    expect(Object.keys(stored).sort()).toEqual(["accounts", "version"]);
    expect(Object.keys(stored.accounts).sort()).toEqual(["google", "microsoft"]);
    expect(Object.keys(stored.accounts.google).sort()).toEqual([
      "createdAt", "displayName", "lastSeen", "normalizedEmail", "picture", "provider", "providerAccountId", "version",
    ]);
    expect(Object.keys(stored.accounts.microsoft).sort()).toEqual([
      "createdAt", "displayName", "homeAccountId", "lastSeen", "localAccountId", "normalizedEmail", "picture", "provider", "providerAccountId", "version",
    ]);
    expect(JSON.stringify(localStorage)).not.toMatch(/access|refresh|bearer|token|secret/i);
  });

  it("does not create an authentication database or place credentials in IndexedDB", async () => {
    saveAccountContinuity(google);
    const databases = await indexedDB.databases();
    expect(databases.filter((database) => /auth|token|session/i.test(database.name ?? ""))).toEqual([]);
    expect(JSON.stringify(localStorage)).not.toMatch(/accessToken|refreshToken|access_token|refresh_token/i);
  });

  it("keeps createdAt for the same account but replaces a recreated provider subject", () => {
    saveAccountContinuity(google, 1000);
    saveAccountContinuity({ ...google, name: "Renamed" }, 2000);
    expect(readAccountContinuity("google")).toMatchObject({ providerAccountId: "google-sub", createdAt: 1000, lastSeen: 2000 });
    saveAccountContinuity({ ...google, providerAccountId: "new-sub" }, 3000);
    expect(readAccountContinuity("google")).toMatchObject({ providerAccountId: "new-sub", createdAt: 3000 });
  });

  it("migrates only the old session profile and removes legacy token payloads", () => {
    localStorage.setItem(LEGACY_AUTH_STORAGE_KEY, JSON.stringify({ state: { user: google, accessToken: "local-secret" } }));
    sessionStorage.setItem(LEGACY_AUTH_STORAGE_KEY, JSON.stringify({ state: { user: google, accessToken: "session-token", accessTokenExpiry: 4000 } }));
    migrateLegacyAuthStorage();
    expect(localStorage.getItem(LEGACY_AUTH_STORAGE_KEY)).toBeNull();
    expect(readAccountContinuity("google")).toMatchObject({ providerAccountId: "google-sub" });
    expect(JSON.stringify(localStorage)).not.toContain("local-secret");
    expect(JSON.stringify(localStorage)).not.toContain("session-token");
    expect(sessionStorage.getItem("narrarium-auth-session-v1")).toContain("session-token");
  });

  it("requires the volatile token binding to match the selected provider continuity", () => {
    saveAccountContinuity(google);
    saveAccountContinuity(microsoft);
    const googleEnvelope = JSON.stringify({ version: 1, state: createVolatileAuthState("google-token", 4000, google) });
    const microsoftEnvelope = JSON.stringify({ version: 1, state: createVolatileAuthState("microsoft-token", 4000, microsoft) });
    expect(sanitizeVolatileAuthStorage(googleEnvelope)).toContain("google-token");
    expect(sanitizeVolatileAuthStorage(microsoftEnvelope)).toContain("microsoft-token");
    expect(sanitizeVolatileAuthStorage(JSON.stringify({ version: 1, state: { accessToken: "unbound", accessTokenExpiry: 4000 } }))).toBeNull();
    expect(sanitizeVolatileAuthStorage(JSON.stringify({ version: 1, state: { ...createVolatileAuthState("wrong", 4000, google), provider: "microsoft", providerAccountId: "unknown-home" } }))).toBeNull();
  });

  it("persists provider and immutable account binding with the volatile token envelope", () => {
    saveAccountContinuity(google);
    useAuthStore.getState().setAuth("session-token", google, 3600);
    const envelope = JSON.parse(sessionStorage.getItem("narrarium-auth-session-v1")!);
    expect(envelope.state).toMatchObject({ accessToken: "session-token", provider: "google", providerAccountId: "google-sub" });
    expect(Object.keys(envelope).sort()).toEqual(["state", "version"]);
    expect(Object.keys(envelope.state).sort()).toEqual(["accessToken", "accessTokenExpiry", "provider", "providerAccountId", "rememberMe"]);
    expect(JSON.stringify(envelope)).not.toContain("refreshToken");
  });

  it("clears continuity only on explicit signout, while token invalidation retains it", () => {
    saveAccountContinuity(google);
    useAuthStore.setState({ user: google, accessToken: "session-token", accessTokenExpiry: Date.now() + 1000 });
    useAuthStore.getState().invalidateToken();
    expect(readAccountContinuity("google")).not.toBeNull();
    useAuthStore.getState().clearAuth();
    expect(readAccountContinuity("google")).toBeNull();
  });

  it("reconstructs the known user without a token", () => {
    saveAccountContinuity(microsoft);
    expect(continuityToUser(readAccountContinuity("microsoft")!)).toMatchObject({
      provider: "microsoft", providerAccountId: "home-id", homeAccountId: "home-id", localAccountId: "local-id",
    });
  });

  it("persists a bearer only after explicit remember-me opt-in and binds it to the immutable account", () => {
    useAuthStore.getState().setInteractiveAuth("persistent-token", google, 3600, true);
    expect(readPersistentAuth()).toMatchObject({ accessToken: "persistent-token", provider: "google", providerAccountId: "google-sub" });
    expect(localStorage.getItem(PERSISTENT_AUTH_STORAGE_KEY)).not.toContain("refreshToken");
    useAuthStore.getState().setInteractiveAuth("replacement-token", microsoft, 3600, true);
    expect(readPersistentAuth()).toMatchObject({ accessToken: "replacement-token", provider: "microsoft", providerAccountId: "home-id" });
    expect(localStorage.getItem(PERSISTENT_AUTH_STORAGE_KEY)).not.toContain("persistent-token");
  });

  it("keeps non-remembered auth session-scoped and removes persistent auth on logout", () => {
    useAuthStore.getState().setInteractiveAuth("persistent-token", google, 3600, true);
    useAuthStore.getState().setInteractiveAuth("session-only", google, 3600, false);
    expect(localStorage.getItem(PERSISTENT_AUTH_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem("narrarium-auth-session-v1")).toContain("session-only");
    useAuthStore.getState().setInteractiveAuth("persistent-again", google, 3600, true);
    useAuthStore.getState().clearAuth();
    expect(localStorage.getItem(PERSISTENT_AUTH_STORAGE_KEY)).toBeNull();
  });

  it("rejects and removes expired persistent bearer records", () => {
    localStorage.setItem(PERSISTENT_AUTH_STORAGE_KEY, JSON.stringify({ accessToken: "expired", accessTokenExpiry: Date.now() - 1, provider: "google", providerAccountId: "google-sub" }));
    expect(readPersistentAuth()).toBeNull();
    expect(localStorage.getItem(PERSISTENT_AUTH_STORAGE_KEY)).toBeNull();
  });
});
