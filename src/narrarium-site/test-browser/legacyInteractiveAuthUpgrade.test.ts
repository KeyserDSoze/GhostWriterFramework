import { beforeEach, describe, expect, it, vi } from "vitest";
import { beginLegacyAccountUpgrade, consumeLegacyAccountUpgradeEvidence } from "@/auth/accountIdentity";
import { useAuthStore } from "@/store/authStore";

const legacyGoogle = { provider: "google" as const, name: "Writer", email: "Writer@Example.com", picture: "" };

describe("legacy AuthGuard to interactive LoginScreen upgrade", () => {
  beforeEach(() => {
    sessionStorage.clear();
    useAuthStore.setState({ user: null, accessToken: null, accessTokenExpiry: null });
    vi.restoreAllMocks();
  });

  it("survives the AuthGuard legacy clear and finalizes only through interactive auth", () => {
    useAuthStore.setState({ user: legacyGoogle });
    beginLegacyAccountUpgrade(legacyGoogle);
    useAuthStore.getState().clearAuthForLegacyUpgrade();
    const immutable = { ...legacyGoogle, providerAccountId: "sub-a" };
    useAuthStore.getState().setInteractiveAuth("token", immutable);
    expect(consumeLegacyAccountUpgradeEvidence(immutable, "google:sub-a")).toMatchObject({ legacyIdentity: "google:writer@example.com", immutableIdentity: "google:sub-a" });
    expect(consumeLegacyAccountUpgradeEvidence(immutable, "google:sub-a")).toBeNull();
  });

  it("does not finalize through ordinary silent setAuth", () => {
    beginLegacyAccountUpgrade(legacyGoogle);
    const immutable = { ...legacyGoogle, providerAccountId: "sub-a" };
    useAuthStore.getState().setAuth("token", immutable);
    expect(consumeLegacyAccountUpgradeEvidence(immutable, "google:sub-a")).toBeNull();
  });

  it("binds finalized evidence to the exact immutable subject without letting a mismatch consume it", () => {
    beginLegacyAccountUpgrade(legacyGoogle);
    const immutable = { ...legacyGoogle, providerAccountId: "sub-a" };
    useAuthStore.getState().setInteractiveAuth("token", immutable);
    expect(consumeLegacyAccountUpgradeEvidence({ ...legacyGoogle, providerAccountId: "sub-b" }, "google:sub-b")).toBeNull();
    expect(consumeLegacyAccountUpgradeEvidence(immutable, "google:sub-a")).toMatchObject({ immutableIdentity: "google:sub-a" });
  });

  it("rejects different email, provider, and expired pending proof", () => {
    beginLegacyAccountUpgrade(legacyGoogle);
    const differentEmail = { ...legacyGoogle, providerAccountId: "sub-a", email: "other@example.com" };
    expect(() => useAuthStore.getState().setInteractiveAuth("token", differentEmail)).toThrow("same provider account and email");
    expect(consumeLegacyAccountUpgradeEvidence(differentEmail, "google:sub-a")).toBeNull();

    beginLegacyAccountUpgrade(legacyGoogle);
    const microsoft = { provider: "microsoft" as const, providerAccountId: "home", homeAccountId: "home", localAccountId: "local", name: "Writer", email: legacyGoogle.email, picture: "" };
    expect(() => useAuthStore.getState().setInteractiveAuth("token", microsoft)).toThrow("same provider account and email");
    expect(consumeLegacyAccountUpgradeEvidence(microsoft, "microsoft:home")).toBeNull();

    vi.spyOn(Date, "now").mockReturnValueOnce(1_000);
    beginLegacyAccountUpgrade(legacyGoogle);
    vi.spyOn(Date, "now").mockReturnValue(1_000 + 6 * 60_000);
    expect(() => useAuthStore.getState().setInteractiveAuth("token", { ...legacyGoogle, providerAccountId: "sub-a" })).toThrow("same provider account and email");
    expect(consumeLegacyAccountUpgradeEvidence({ ...legacyGoogle, providerAccountId: "sub-a" }, "google:sub-a")).toBeNull();
  });

  it("signout clears pending and finalized proof", () => {
    beginLegacyAccountUpgrade(legacyGoogle);
    useAuthStore.getState().clearAuth();
    const immutable = { ...legacyGoogle, providerAccountId: "sub-a" };
    useAuthStore.getState().setInteractiveAuth("token", immutable);
    expect(consumeLegacyAccountUpgradeEvidence(immutable, "google:sub-a")).toBeNull();
  });
});
