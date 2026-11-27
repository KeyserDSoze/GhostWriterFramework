import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const msal = vi.hoisted(() => ({ loginPopup: vi.fn(), acquireTokenSilent: vi.fn() }));
vi.mock("@react-oauth/google", () => ({ useGoogleLogin: () => vi.fn() }));
vi.mock("@/config/msal", () => ({
  MICROSOFT_SCOPES: ["User.Read"],
  ensureMsalInitialized: vi.fn(async () => undefined),
  findMicrosoftAccountIn: (_connection: unknown, accounts: unknown[]) => accounts[0] ?? null,
  microsoftSilentRequest: (account: unknown) => ({ account, scopes: [] }),
  setMicrosoftRememberMe: vi.fn(),
  microsoftMsalInstance: () => ({ loginPopup: msal.loginPopup, acquireTokenSilent: msal.acquireTokenSilent, getAllAccounts: () => [], setActiveAccount: vi.fn() }),
}));
vi.mock("@/drive/microsoftGraph", () => ({ fetchMicrosoftGraph: vi.fn(async () => new Response(JSON.stringify({ displayName: "Writer", mail: "writer@outlook.com" }), { status: 200 })) }));
vi.mock("@/auth/accountScope", () => ({ migrateConnectedProviderRepositories: vi.fn(async () => ({})) }));
vi.mock("@/hooks/useBrokerAvailability", () => ({ useBrokerAvailability: () => false }));
const sync = vi.hoisted(() => ({ pull: vi.fn(), push: vi.fn() }));
vi.mock("@/account/sync/driveBackend", () => ({ DriveAccountSyncBackend: class { pull = sync.pull; push = sync.push; } }));
vi.mock("@/account/sync/githubBackend", () => ({ GitHubAccountSyncBackend: class {} }));
vi.mock("@/account/microsoftConnectionToken", () => ({ acquireMicrosoftConnectionToken: vi.fn(async () => "fresh-token") }));
vi.mock("@/account/accountLocalStore", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/account/accountLocalStore")>();
  const snapshot = { dirty: false, manifest: { snapshotId: "s1", modifiedAtUtc: "2026-11-21T21:15:39.398Z", vectorClock: {}, contentHash: "h" }, data: { settings: { books: [] }, chats: [] } };
  return { ...original, loadLocalAccountSnapshot: vi.fn(async () => snapshot), markLocalAccountReplicaConfirmed: vi.fn(async () => undefined) };
});
vi.mock("@/account/serialization", () => ({ accountSyncEnvelope: vi.fn(async () => ({ manifest: { contentHash: "h" } })) }));

import i18n from "@/i18n";
import { AccountSyncPage } from "@/pages/AccountSyncPage";
import { useConnectionStore } from "@/account/connectionStore";
import { useAccountSyncStore } from "@/account/accountSync";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";

const HOME = "home-1";
const TEXTS = {
  en: { reconnect: "Sign in to OneDrive again on this device", status: "Status: Reconnect OneDrive", renew: /signed in to OneDrive with session credentials/, upToDate: "Status: Up to date", signInIncomplete: /OneDrive sign-in was not completed \(popup_window_error\)/ },
  it: { reconnect: "Accedi di nuovo a OneDrive su questo dispositivo", status: "Stato: Riconnetti OneDrive", renew: /ha fatto l'accesso a OneDrive con credenziali di sessione/, upToDate: "Stato: Aggiornato", signInIncomplete: /accesso a OneDrive non è stato completato \(popup_window_error\)/ },
} as const;

async function open(language: "en" | "it") {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, language } } });
  await i18n.changeLanguage(language);
  render(<MemoryRouter><AccountSyncPage /></MemoryRouter>);
  await screen.findByRole("heading", { name: "OneDrive" });
}
const card = () => within(screen.getByRole("heading", { name: "OneDrive" }).parentElement!.parentElement!);
const microsoft = () => useConnectionStore.getState().configuration.microsoft!;

beforeEach(() => {
  localStorage.clear();
  useAccountSyncStore.setState({ syncing: false, reconciliation: null });
  msal.loginPopup.mockReset().mockResolvedValue({ account: { homeAccountId: HOME, localAccountId: "local-1" }, accessToken: "login-token", expiresOn: new Date(Date.now() + 3_600_000) });
  msal.acquireTokenSilent.mockReset().mockResolvedValue({ accessToken: "login-token", expiresOn: new Date(Date.now() + 3_600_000) });
  sync.pull.mockReset().mockResolvedValue(null);
  sync.push.mockReset().mockResolvedValue({ revision: "r1" });
  useConnectionStore.setState({
    hydrated: true,
    configuration: {
      microsoft: {
        backend: "onedrive", method: "microsoft", identity: { provider: "microsoft", providerAccountId: HOME, displayName: "Writer", email: "writer@outlook.com" }, accessToken: "stale", homeAccountId: HOME, localAccountId: "local-1", rememberMe: true,
        replica: { enabled: true, status: "needs-auth", errorKind: "credential-expired", lastErrorMessage: "onedrive credential is expired (timed_out).", lastSuccessfulSyncAtUtc: "2026-11-20T10:00:00.000Z", lastKnownRemoteSnapshotId: "snap-1" },
      },
    },
  });
});

afterEach(async () => {
  cleanup();
  useConnectionStore.setState({ hydrated: true, configuration: {} });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe.each(["en", "it"] as const)("Reconnect OneDrive in %s", (language) => {
  const text = TEXTS[language];

  it("says the sign-in needs to be renewed, with the code as detail and without the help address", async () => {
    await open(language);
    expect(card().getByText(text.status)).toBeInTheDocument();
    expect(card().getByText(text.renew)).toBeInTheDocument();
    expect(card().getByText("onedrive credential is expired (timed_out).")).toBeInTheDocument();
    expect(card().getByRole("button", { name: text.reconnect })).toBeEnabled();
    expect(document.body.textContent).not.toMatch(/aka\.ms|unknown|sconosciut/i);
  });

  it("signs in again as the same account, then resumes the sync that was waiting", async () => {
    await open(language);

    fireEvent.click(card().getByRole("button", { name: text.reconnect }));

    await waitFor(() => expect(card().getByText(text.upToDate)).toBeInTheDocument());
    expect(msal.loginPopup).toHaveBeenCalledTimes(1);
    expect(msal.loginPopup.mock.calls[0][0]).toMatchObject({ loginHint: "writer@outlook.com" });
    expect(sync.push).toHaveBeenCalledTimes(1);
    expect(microsoft().replica).toMatchObject({ enabled: true, status: "idle", lastKnownRemoteSnapshotId: "s1" });
    expect(microsoft().replica.errorKind).toBeUndefined();
    expect(microsoft().replica.lastErrorMessage).toBeUndefined();
    expect(card().queryByRole("button", { name: text.reconnect })).not.toBeInTheDocument();
  });

  it("refuses another account, and the status stays", async () => {
    msal.loginPopup.mockResolvedValue({ account: { homeAccountId: "someone-else", localAccountId: "local-2" }, accessToken: "x" });
    await open(language);

    fireEvent.click(card().getByRole("button", { name: text.reconnect }));

    expect(await screen.findByRole("alert")).toHaveTextContent(language === "it" ? /account diverso/ : /different account/);
    expect(sync.push).not.toHaveBeenCalled();
    expect(microsoft().homeAccountId).toBe(HOME);
    expect(microsoft().replica.status).toBe("needs-auth");
  });

  it("explains a sign-in window that did not finish in words, with the code as detail", async () => {
    msal.loginPopup.mockRejectedValue(Object.assign(new Error("popup_window_error: Error opening popup window. See https://aka.ms/msal.js.errors#popup_window_error for details"), { errorCode: "popup_window_error" }));
    await open(language);

    fireEvent.click(card().getByRole("button", { name: text.reconnect }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(text.signInIncomplete);
    expect(alert.textContent).not.toMatch(/aka\.ms|Error:/);
    expect(microsoft().replica.status).toBe("needs-auth");
  });
});
