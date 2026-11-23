import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { closeAccountLocalStoreForTests, initializeAccountLocalStore } from "@/account/accountLocalStore";
import { useConnectionStore } from "@/account/connectionStore";
import { classifyAccountSyncError, syncOneAccountReplica, useAccountSyncStore } from "@/account/accountSync";
import { upgradedReplica } from "@/account/brokerConnect";
import { describeSignInFailure } from "@/account/connectErrors";
import { AccountSyncFailure, describeSyncFailure } from "@/account/syncFailure";
import { GOOGLE_RENEWAL_CODES, MICROSOFT_RENEWAL_CODES, requiresSignInRenewal, signInRenewalCode, withoutHelpLinks } from "@/account/signInRenewal";
import i18n from "@/i18n";
import { emptyCostsFile } from "@/costs/model";
import { DEFAULT_SETTINGS } from "@/types/settings";

const msal = vi.hoisted(() => ({ acquireTokenSilent: vi.fn() }));
vi.mock("@/config/msal", () => ({
  ensureMsalInitialized: vi.fn(async () => undefined),
  findMicrosoftAccountIn: (_connection: unknown, accounts: unknown[]) => accounts[0] ?? null,
  microsoftSilentRequest: (account: unknown) => ({ account, scopes: [] }),
  microsoftMsalInstance: () => ({ getAllAccounts: () => [{ homeAccountId: "home", localAccountId: "local" }], acquireTokenSilent: msal.acquireTokenSilent, setActiveAccount: vi.fn() }),
}));

const drives = vi.hoisted(() => ({
  google: { pull: vi.fn(), push: vi.fn(), remove: vi.fn() },
  microsoft: { pull: vi.fn(), push: vi.fn(), remove: vi.fn() },
}));
vi.mock("@/account/sync/driveBackend", () => ({
  DriveAccountSyncBackend: class {
    constructor(private readonly provider: "google" | "microsoft") {}
    pull = (...args: unknown[]) => drives[this.provider].pull(...args);
    push = (...args: unknown[]) => drives[this.provider].push(...args);
    deleteRemoteData = (...args: unknown[]) => drives[this.provider].remove(...args);
  },
}));
vi.mock("@/account/sync/githubBackend", () => ({ GitHubAccountSyncBackend: class {} }));

/** What MSAL throws: an error with a code, whose message is "<code>: <description>" and a pointer to its help page. */
const msalError = (code: string) => Object.assign(new Error(`${code}: Token acquisition timed out. See https://aka.ms/msal.js.errors#${code} for details`), { name: "BrowserAuthError", errorCode: code });

const microsoftReplica = () => useConnectionStore.getState().configuration.microsoft!.replica;
const googleReplica = () => useConnectionStore.getState().configuration.google!.replica;

const connectMicrosoft = (patch: Record<string, unknown> = {}) => useConnectionStore.getState().connectMicrosoft({
  identity: { provider: "microsoft", providerAccountId: "home", displayName: "Writer", email: "writer@outlook.com" },
  homeAccountId: "home",
  localAccountId: "local",
  accessToken: "stale",
  accessTokenExpiry: Date.now() - 1_000,
  rememberMe: true,
  ...patch,
});
const connectGoogle = (patch: Record<string, unknown> = {}) => useConnectionStore.getState().connectGoogle({
  identity: { provider: "google", providerAccountId: "g-1", displayName: "Writer" },
  accessToken: "stale",
  accessTokenExpiry: Date.now() - 1_000,
  rememberMe: true,
  ...patch,
});

beforeEach(async () => {
  closeAccountLocalStoreForTests();
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase("narrarium-local-account");
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
  });
  localStorage.clear();
  useAccountSyncStore.setState({ syncing: false, reconciliation: null });
  useConnectionStore.setState({ hydrated: true, configuration: {} });
  msal.acquireTokenSilent.mockReset();
  for (const backend of [drives.google, drives.microsoft]) {
    backend.pull.mockReset().mockResolvedValue(null);
    backend.push.mockReset().mockResolvedValue({ revision: "r1" });
  }
  await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
});

describe("recognising a sign-in that has to be renewed", () => {
  it.each([...MICROSOFT_RENEWAL_CODES])("knows MSAL's %s by its code and by its message", (code) => {
    expect(signInRenewalCode(Object.assign(new Error("x"), { errorCode: code }))).toBe(code);
    expect(signInRenewalCode(msalError(code))).toBe(code);
    expect(signInRenewalCode(new Error(`${code}: See https://aka.ms/msal.js.errors#${code} for details`))).toBe(code);
    expect(classifyAccountSyncError(msalError(code))).toBe("credential-expired");
  });

  it.each([...GOOGLE_RENEWAL_CODES])("knows Google's %s, from the OAuth error and from the window error", (code) => {
    expect(signInRenewalCode({ error: code, error_description: "x" })).toBe(code);
    expect(signInRenewalCode({ type: code })).toBe(code);
    expect(classifyAccountSyncError({ error: code })).toBe("credential-expired");
  });

  it("leaves everything else to the other classes", () => {
    expect(requiresSignInRenewal(new TypeError("Failed to fetch"))).toBe(false);
    expect(requiresSignInRenewal(new Error("OneDrive request failed (500)"))).toBe(false);
    expect(requiresSignInRenewal("timed_out")).toBe(false);
    expect(requiresSignInRenewal(new Error("The sign-in is not timed_out_at_all"))).toBe(false);
    expect(classifyAccountSyncError(new Error("Something odd"))).toBe("unknown");
  });

  it("takes MSAL's help address out of a message and keeps the code", () => {
    expect(withoutHelpLinks("timed_out: See https://aka.ms/msal.js.errors#timed_out for details")).toBe("timed_out");
    expect(withoutHelpLinks("monitor_window_timeout: Token acquisition in popup failed due to timeout. See https://aka.ms/msal.js.errors#monitor_window_timeout for details")).toBe("monitor_window_timeout: Token acquisition in popup failed due to timeout");
  });
});

describe("a OneDrive sync whose silent sign-in cannot be renewed", () => {
  it.each([...MICROSOFT_RENEWAL_CODES])("asks to reconnect OneDrive for %s, keeps the code in the details and never says unknown", async (code) => {
    await connectMicrosoft();
    msal.acquireTokenSilent.mockRejectedValue(msalError(code));

    const failure = await syncOneAccountReplica("onedrive").catch((cause) => cause);

    expect(failure).toBeInstanceOf(AccountSyncFailure);
    expect(failure.kind).toBe("credential-expired");
    expect(failure.message).not.toMatch(/unknown/);
    expect(failure.message).not.toMatch(/aka\.ms/);
    expect(microsoftReplica()).toMatchObject({ status: "needs-auth", errorKind: "credential-expired" });
    expect(microsoftReplica().lastErrorMessage).toContain(code);
    expect(microsoftReplica().lastErrorMessage).not.toMatch(/aka\.ms|https?:/);
  });

  it("does not call the lapse of a login a lost login while the device is offline", async () => {
    await connectMicrosoft();
    msal.acquireTokenSilent.mockRejectedValue(msalError("timed_out"));
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    try {
      await syncOneAccountReplica("onedrive").catch(() => undefined);
      expect(microsoftReplica()).toMatchObject({ status: "offline", errorKind: "offline" });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("says «Reconnect OneDrive» in English and Italian, never the code's address", async () => {
    await connectMicrosoft();
    msal.acquireTokenSilent.mockRejectedValue(msalError("timed_out"));
    const failure = await syncOneAccountReplica("onedrive").catch((cause) => cause);
    for (const [language, reconnect, renew] of [["en", "Reconnect OneDrive", "sign-in needs to be renewed"], ["it", "Riconnetti OneDrive", "va rinnovato"]] as const) {
      const t = i18n.getFixedT(language);
      const text = describeSyncFailure(failure, t);
      expect(text).toContain(reconnect);
      expect(text).toContain(renew);
      expect(text).not.toMatch(/unknown|aka\.ms|sconosciut/i);
      expect(t("accountSync.state.needs-auth", { service: "OneDrive" })).toBe(reconnect);
      expect(t("accountSync.card.reconnectService", { service: "OneDrive" })).toBe(reconnect);
      expect(describeSignInFailure(msalError("popup_window_error"), "onedrive", t)).toContain("popup_window_error");
      expect(describeSignInFailure(msalError("popup_window_error"), "onedrive", t)).toContain(reconnect);
    }
  });

  it("goes on with the sync that was waiting once the sign-in is renewed, and no data is lost", async () => {
    await connectMicrosoft({ replica: { enabled: true, status: "dirty", lastSuccessfulSyncAtUtc: "2026-11-20T10:00:00.000Z", lastKnownRemoteSnapshotId: "snap-1" } });
    msal.acquireTokenSilent.mockRejectedValue(msalError("monitor_window_timeout"));
    await expect(syncOneAccountReplica("onedrive")).rejects.toBeInstanceOf(AccountSyncFailure);
    expect(microsoftReplica().status).toBe("needs-auth");
    expect(drives.microsoft.push).not.toHaveBeenCalled();

    // The Reconnect button: the same account signs in again, the replica is kept and its failure cleared…
    const existing = useConnectionStore.getState().configuration.microsoft!;
    await connectMicrosoft({ accessToken: "fresh", accessTokenExpiry: Date.now() + 3_600_000, replica: upgradedReplica(existing.replica) });
    expect(microsoftReplica()).toMatchObject({ enabled: true, status: "dirty", lastSuccessfulSyncAtUtc: "2026-11-20T10:00:00.000Z", lastKnownRemoteSnapshotId: "snap-1" });
    expect(microsoftReplica().errorKind).toBeUndefined();
    expect(microsoftReplica().lastErrorMessage).toBeUndefined();

    // …and the sync that was waiting runs and clears the status.
    msal.acquireTokenSilent.mockResolvedValue({ accessToken: "fresh", expiresOn: new Date(Date.now() + 3_600_000), account: { homeAccountId: "home", localAccountId: "local" } });
    await syncOneAccountReplica("onedrive");
    expect(drives.microsoft.push).toHaveBeenCalledTimes(1);
    expect(microsoftReplica()).toMatchObject({ status: "idle" });
    expect(microsoftReplica().errorKind).toBeUndefined();
    expect(microsoftReplica().lastErrorMessage).toBeUndefined();
  });
});

describe("a Google Drive sync whose sign-in cannot be renewed", () => {
  it("asks to reconnect Google Drive when the access token expired and there is no refresh token", async () => {
    await connectGoogle();

    const failure = await syncOneAccountReplica("google-drive").catch((cause) => cause);

    expect(failure).toBeInstanceOf(AccountSyncFailure);
    expect(googleReplica()).toMatchObject({ status: "needs-auth", errorKind: "credential-expired" });
    for (const [language, reconnect] of [["en", "Reconnect Google Drive"], ["it", "Riconnetti Google Drive"]] as const) {
      const t = i18n.getFixedT(language);
      expect(describeSyncFailure(failure, t)).toContain(reconnect);
      expect(t("accountSync.state.needs-auth", { service: "Google Drive" })).toBe(reconnect);
    }
  });

  it.each([...GOOGLE_RENEWAL_CODES])("treats Google's %s as a sign-in to renew", async (code) => {
    await connectGoogle({ accessToken: "ok", accessTokenExpiry: Date.now() + 3_600_000 });
    drives.google.pull.mockRejectedValue({ error: code, error_description: "The user did not approve" });

    const failure = await syncOneAccountReplica("google-drive").catch((cause) => cause);

    expect(failure).toBeInstanceOf(AccountSyncFailure);
    expect(failure.kind).toBe("credential-expired");
    expect(googleReplica()).toMatchObject({ status: "needs-auth", errorKind: "credential-expired" });
  });

  it("says why a Google window did not finish, in both languages, with the code as detail", () => {
    for (const [language, reconnect] of [["en", "Reconnect Google Drive"], ["it", "Riconnetti Google Drive"]] as const) {
      const t = i18n.getFixedT(language);
      for (const code of ["popup_closed", "access_denied"]) {
        const text = describeSignInFailure({ type: code }, "google-drive", t);
        expect(text).toContain(code);
        expect(text).toContain(reconnect);
      }
    }
    expect(describeSignInFailure(new Error("x"), "google-drive", i18n.getFixedT("en"))).toBeNull();
  });

  it("goes on with the sync that was waiting once Google is connected again", async () => {
    await connectGoogle({ replica: { enabled: true, status: "dirty", lastKnownRemoteSnapshotId: "snap-2" } });
    await expect(syncOneAccountReplica("google-drive")).rejects.toBeInstanceOf(AccountSyncFailure);
    expect(googleReplica().status).toBe("needs-auth");

    await connectGoogle({ accessToken: "fresh", accessTokenExpiry: Date.now() + 3_600_000, replica: upgradedReplica(googleReplica()) });
    await syncOneAccountReplica("google-drive");

    expect(drives.google.push).toHaveBeenCalledTimes(1);
    expect(googleReplica()).toMatchObject({ status: "idle", lastKnownRemoteSnapshotId: expect.any(String) });
    expect(googleReplica().errorKind).toBeUndefined();
  });
});
