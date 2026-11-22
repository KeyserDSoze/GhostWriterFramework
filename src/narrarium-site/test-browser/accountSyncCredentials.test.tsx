import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";

const google = vi.hoisted(() => ({
  triggers: { implicit: vi.fn(), "auth-code": vi.fn() } as Record<string, ReturnType<typeof vi.fn>>,
  options: {} as Record<string, { onSuccess?: (response: unknown) => Promise<void> | void; onError?: (error: unknown) => void; onNonOAuthError?: (error: unknown) => void; [key: string]: unknown }>,
}));
const msal = vi.hoisted(() => ({ client: { loginPopup: vi.fn(), acquireTokenSilent: vi.fn() } }));
const sync = vi.hoisted(() => ({ syncOne: vi.fn(async (_kind: string) => undefined), syncAll: vi.fn(async () => ({ synced: [], reconciliation: false })), migrate: vi.fn(async () => ({ error: undefined })) }));

vi.mock("@react-oauth/google", () => ({
  useGoogleLogin: (options: { flow?: string }) => {
    const flow = options.flow ?? "implicit";
    google.options[flow] = options as never;
    return google.triggers[flow];
  },
}));
vi.mock("@/config/msal", () => ({
  ensureMsalInitialized: vi.fn(async () => undefined),
  MICROSOFT_SCOPES: ["User.Read", "Files.ReadWrite"],
  microsoftMsalInstance: vi.fn(() => msal.client),
  microsoftSilentRequest: vi.fn(),
  setMicrosoftRememberMe: vi.fn(),
}));
vi.mock("@/account/accountLocalStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/account/accountLocalStore")>()),
  loadLocalAccountSnapshot: vi.fn(async () => ({ dirty: false, manifest: { modifiedAtUtc: "2026-11-21T21:15:39.398Z" }, data: { settings: { books: [] }, chats: [] } })),
}));
vi.mock("@/account/accountSync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/account/accountSync")>()),
  syncOneAccountReplica: sync.syncOne,
  syncAllAccountReplicas: sync.syncAll,
}));
vi.mock("@/auth/accountScope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/auth/accountScope")>()),
  migrateConnectedProviderRepositories: sync.migrate,
}));

import i18n from "@/i18n";
import { AccountSyncPage } from "@/pages/AccountSyncPage";
import { useConnectionStore } from "@/account/connectionStore";
import { useAccountSyncStore } from "@/account/accountSync";
import { resetBrokerAvailabilityForTests } from "@/account/credentialBroker";
import { closeCredentialVaultForTests, loadRefreshToken } from "@/account/credentialVault";
import { MICROSOFT_CALLBACK_MESSAGE, resetMicrosoftSignInForTests } from "@/account/microsoftSignIn";
import { GOOGLE_DRIVE_SCOPES } from "@/config/googleAuth";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import type { LocalGoogleConnection, LocalMicrosoftConnection, LocalSyncConfiguration } from "@/account/types";
import { BROKER_BASE, SECRETS, createFakeNetwork, createFakePopup, deleteDatabases, dispatchWindowMessage, jsonResponse, type FakeNetwork, type FakePopup } from "./oauthTestKit";

const TEXTS = {
  it: {
    longLived: "Credenziali durature: attive, si rinnovano da sole.",
    remember: "Ricorda la connessione su questo dispositivo",
    rememberHint: /Le credenziali durature restano su questo dispositivo solo finché questa opzione è attiva/,
    memoryOnly: /Credenziali durature: attive finché questa scheda resta aperta/,
    sessionGoogle: "Credenziali a sessione: dopo circa un'ora devi riconnetterti.",
    sessionMicrosoft: "Credenziali a sessione: dopo circa 24 ore devi riconnetterti.",
    upgrade: "Passa a credenziali durature",
    reconnect: "Riconnetti", connect: "Connetti", disconnect: "Disconnetti", cancel: "Annulla",
    waiting: "In attesa della finestra di accesso Microsoft…",
    noRevoke: /Microsoft non permette di revocare l'accesso da qui/,
    googleRevokes: /anche le credenziali durature vengono revocate presso Google/,
    noRefresh: /Google ha collegato l'account, ma questa volta non ha rilasciato credenziali durature/,
    popupBlocked: "Il browser ha bloccato la finestra di accesso. Consenti i pop-up per questo sito e riprova.",
    wrongAccount: /Hai scelto un account diverso da quello collegato/,
    denied: "L'accesso è stato annullato o rifiutato.",
    confirm: /Scollegare il servizio\?/,
  },
  en: {
    longLived: "Long-lived credentials: active, they renew themselves.",
    remember: "Remember connection on this device",
    rememberHint: /Long-lived credentials are kept on this device only while this is on/,
    memoryOnly: /Long-lived credentials: active while this tab stays open/,
    sessionGoogle: "Session credentials: after about an hour you have to reconnect.",
    sessionMicrosoft: "Session credentials: after about 24 hours you have to reconnect.",
    upgrade: "Switch to long-lived credentials",
    reconnect: "Reconnect", connect: "Connect", disconnect: "Disconnect", cancel: "Cancel",
    waiting: "Waiting for the Microsoft sign-in window…",
    noRevoke: /Microsoft does not allow revoking access from here/,
    googleRevokes: /also revokes the long-lived credentials at Google/,
    noRefresh: /Google connected the account, but did not issue long-lived credentials this time/,
    popupBlocked: "The browser blocked the sign-in window. Allow pop-ups for this site and try again.",
    wrongAccount: /You chose a different account than the one connected here/,
    denied: "The sign-in was cancelled or declined.",
    confirm: /Disconnect this service\?/,
  },
} as const;

const HOME = "f2a1c5e0-3b7d-4a98-8c3e-5d1f0a9b7c42.72f988bf-86f1-41af-91ab-2d7cd011db47";
let net: FakeNetwork;
let popup: FakePopup;

const googleConnection = (patch: Partial<LocalGoogleConnection> = {}): LocalGoogleConnection => ({
  backend: "google-drive", method: "google", identity: { provider: "google", providerAccountId: "g-1", displayName: "Writer", email: "writer@example.com" }, accessToken: SECRETS.access, accessTokenExpiry: Date.now() + 3_000_000, rememberMe: true,
  replica: { enabled: true, status: "idle" }, ...patch,
});
const microsoftConnection = (patch: Partial<LocalMicrosoftConnection> = {}): LocalMicrosoftConnection => ({
  backend: "onedrive", method: "microsoft", identity: { provider: "microsoft", providerAccountId: HOME, displayName: "Writer" }, homeAccountId: HOME, localAccountId: HOME.split(".")[0], accessToken: SECRETS.access, accessTokenExpiry: Date.now() + 3_000_000, rememberMe: true,
  replica: { enabled: true, status: "idle" }, ...patch,
});
const seed = (configuration: LocalSyncConfiguration) => useConnectionStore.setState({ hydrated: true, configuration });
const card = (name: string) => screen.getByRole("heading", { name }).parentElement!.parentElement!;
const stateOf = () => useConnectionStore.getState().configuration;

async function open(language: "it" | "en") {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, language } } });
  await i18n.changeLanguage(language);
  render(<MemoryRouter><AccountSyncPage /></MemoryRouter>);
  await screen.findByText(language === "it" ? /Disponibile senza login/ : /Available without login/);
}

async function brokerReady(google_ = true, microsoft_ = true) {
  net.reply("GET", `${BROKER_BASE}/oauth/status`, { google: google_, microsoft: microsoft_ });
  vi.stubEnv("VITE_AUTH_BROKER_BASE", BROKER_BASE);
}

beforeEach(async () => {
  closeCredentialVaultForTests();
  await deleteDatabases("narrarium-local-account", "narrarium-credential-vault");
  localStorage.clear();
  sessionStorage.clear();
  resetBrokerAvailabilityForTests();
  resetMicrosoftSignInForTests();
  net = createFakeNetwork();
  vi.stubGlobal("fetch", net.fetch);
  popup = createFakePopup();
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  for (const trigger of Object.values(google.triggers)) trigger.mockClear();
  google.options = {};
  msal.client.loginPopup.mockReset().mockRejectedValue(new Error("MSAL popup stopped by the test"));
  msal.client.acquireTokenSilent.mockReset();
  sync.syncOne.mockClear();
  sync.migrate.mockClear();
  useAccountSyncStore.setState({ syncing: false, reconciliation: null });
  useAuthStore.setState({ accessToken: null, accessTokenExpiry: null, provider: null, providerAccountId: null, user: null, rememberMe: false });
  seed({});
});

afterEach(async () => {
  cleanup();
  resetMicrosoftSignInForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  seed({});
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  closeCredentialVaultForTests();
  await i18n.changeLanguage("en");
});

describe.each(["it", "en"] as const)("Account & Sync credentials in %s", (language) => {
  const text = TEXTS[language];

  describe("without the broker, nothing changes and nothing is offered", () => {
    it("shows no credential status and no offer, and never contacts a Worker", async () => {
      seed({ google: googleConnection(), microsoft: microsoftConnection() });
      await open(language);
      for (const name of ["Google Drive", "OneDrive"]) {
        const view = within(card(name));
        expect(view.queryByText(text.upgrade)).not.toBeInTheDocument();
        expect(view.queryByText(/credenziali a sessione|session credentials/i)).not.toBeInTheDocument();
        expect(view.queryByText(/credenziali durature|long-lived credentials/i)).not.toBeInTheDocument();
      }
      expect(net.calls).toHaveLength(0);
    });

    it("still connects Google with the implicit flow and OneDrive with MSAL", async () => {
      await open(language);
      fireEvent.click(within(card("Google Drive")).getByRole("button", { name: text.connect }));
      expect(google.triggers.implicit).toHaveBeenCalledTimes(1);
      expect(google.triggers["auth-code"]).not.toHaveBeenCalled();

      fireEvent.click(within(card("OneDrive")).getByRole("button", { name: text.connect }));
      await waitFor(() => expect(msal.client.loginPopup).toHaveBeenCalledTimes(1));
      expect(window.open).not.toHaveBeenCalled();
    });

    it("adds nothing to the remember switch, which is now properly labelled", async () => {
      await open(language);
      const remember = screen.getByRole("switch", { name: text.remember });
      expect(remember).toBeChecked();
      expect(screen.queryByText(text.rememberHint)).not.toBeInTheDocument();
    });

    it("keeps the long-lived credential of the same account when it signs in again the usual way", async () => {
      seed({ google: googleConnection({ refreshToken: SECRETS.refresh, accessTokenExpiry: Date.now() - 1_000, replica: { enabled: true, status: "needs-auth", errorKind: "credential-expired" } }) });
      net.reply("GET", "https://www.googleapis.com/oauth2/v3/userinfo", { sub: "g-1", name: "Writer", email: "writer@example.com", picture: "" });
      await open(language);

      await act(async () => { await google.options.implicit.onSuccess?.({ access_token: SECRETS.accessFresh, expires_in: 3599, scope: GOOGLE_DRIVE_SCOPES }); });

      await waitFor(() => expect(stateOf().google?.accessToken).toBe(SECRETS.accessFresh));
      expect(stateOf().google?.refreshToken).toBe(SECRETS.refresh);
      await expect(loadRefreshToken("google", "g-1")).resolves.toBe(SECRETS.refresh);
    });

    it("does not lend it to another account", async () => {
      seed({ google: googleConnection({ refreshToken: SECRETS.refresh }) });
      net.reply("GET", "https://www.googleapis.com/oauth2/v3/userinfo", { sub: "g-2", name: "Someone else", email: "else@example.com", picture: "" });
      await open(language);

      await act(async () => { await google.options.implicit.onSuccess?.({ access_token: SECRETS.accessFresh, expires_in: 3599, scope: GOOGLE_DRIVE_SCOPES }); });

      await waitFor(() => expect(stateOf().google?.identity.providerAccountId).toBe("g-2"));
      expect(stateOf().google?.refreshToken).toBeUndefined();
    });

    it("still shows the status of a long-lived connection that was made earlier, but offers nothing", async () => {
      seed({ google: googleConnection({ refreshToken: SECRETS.refresh }) });
      await open(language);
      expect(within(card("Google Drive")).getByText(text.longLived)).toBeInTheDocument();
      expect(within(card("Google Drive")).queryByText(text.upgrade)).not.toBeInTheDocument();
    });
  });

  describe("with the broker", () => {
    it("tells a session connection how long it lasts, explains the difference, and offers the switch", async () => {
      await brokerReady();
      seed({ google: googleConnection(), microsoft: microsoftConnection() });
      await open(language);

      const drive = within(card("Google Drive"));
      expect(await drive.findByText(text.sessionGoogle)).toBeInTheDocument();
      expect(drive.getByRole("button", { name: text.upgrade })).toBeEnabled();
      expect(drive.queryByText(text.longLived)).not.toBeInTheDocument();

      const oneDrive = within(card("OneDrive"));
      expect(await oneDrive.findByText(text.sessionMicrosoft)).toBeInTheDocument();
      expect(oneDrive.getByRole("button", { name: text.upgrade })).toBeEnabled();
      expect(drive.getByText(language === "it" ? /si rinnovano da sole in background/ : /renew themselves quietly in the background/)).toBeInTheDocument();
    });

    it("tells, next to the remember switch, that long-lived credentials are kept on this device only while it is on", async () => {
      await brokerReady();
      await open(language);
      const hint = await screen.findByText(text.rememberHint);
      expect(screen.getByRole("switch", { name: text.remember })).toHaveAccessibleDescription(expect.stringMatching(text.rememberHint));
      expect(hint).toBeInTheDocument();
    });

    it("tells a long-lived connection that it renews itself, with no offer", async () => {
      await brokerReady();
      seed({ google: googleConnection({ refreshToken: SECRETS.refresh }), microsoft: microsoftConnection({ refreshToken: SECRETS.refresh }) });
      await open(language);
      for (const name of ["Google Drive", "OneDrive"]) {
        const view = within(card(name));
        expect(await view.findByText(text.longLived)).toBeInTheDocument();
        expect(view.queryByRole("button", { name: text.upgrade })).not.toBeInTheDocument();
      }
    });

    it("says so when long-lived credentials only last while the tab is open because the connection is not remembered", async () => {
      await brokerReady();
      seed({ google: googleConnection({ refreshToken: SECRETS.refresh, rememberMe: false }) });
      await open(language);
      expect(await within(card("Google Drive")).findByText(text.memoryOnly)).toBeInTheDocument();
      expect(within(card("Google Drive")).queryByText(text.longLived)).not.toBeInTheDocument();
    });

    it("offers nothing for a service that is not connected, and nothing for a provider the broker does not serve", async () => {
      await brokerReady(true, false);
      seed({ microsoft: microsoftConnection() });
      await open(language);
      expect(within(card("Google Drive")).queryByText(text.upgrade)).not.toBeInTheDocument();
      await waitFor(() => expect(net.broker("/oauth/status")).toHaveLength(1));
      expect(within(card("OneDrive")).queryByText(text.upgrade)).not.toBeInTheDocument();
      expect(within(card("OneDrive")).queryByText(/credenziali a sessione|session credentials/i)).not.toBeInTheDocument();
    });

    it("conveys the state with words, not colour alone: the icon is decorative and the text carries the meaning", async () => {
      await brokerReady();
      seed({ google: googleConnection({ refreshToken: SECRETS.refresh }), microsoft: microsoftConnection() });
      await open(language);
      const longLived = await within(card("Google Drive")).findByText(text.longLived);
      expect(longLived.closest("p")!.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
      const session = await within(card("OneDrive")).findByText(text.sessionMicrosoft);
      expect(session.closest("p")!.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    });

    it("connects Google with the authorization code flow in a popup", async () => {
      await brokerReady();
      await open(language);
      await waitFor(() => expect(net.broker("/oauth/status")).toHaveLength(1));
      await act(async () => { await Promise.resolve(); });

      fireEvent.click(within(card("Google Drive")).getByRole("button", { name: text.connect }));

      expect(google.triggers["auth-code"]).toHaveBeenCalledTimes(1);
      expect(google.triggers.implicit).not.toHaveBeenCalled();
      expect(google.options["auth-code"]).toMatchObject({ flow: "auth-code", ux_mode: "popup", scope: GOOGLE_DRIVE_SCOPES });
      expect(google.options.implicit).toMatchObject({ scope: GOOGLE_DRIVE_SCOPES });
      expect(google.options.implicit.flow).toBeUndefined();
    });

    it("finishes a Google connection from the code, keeps the refresh token, and syncs", async () => {
      await brokerReady();
      net.reply("POST", `${BROKER_BASE}/oauth/google/token`, { accessToken: SECRETS.access, expiresIn: 3599, refreshToken: SECRETS.refresh });
      net.reply("GET", "https://www.googleapis.com/oauth2/v3/userinfo", { sub: "g-1", name: "Writer", email: "writer@example.com", picture: "" });
      await open(language);

      await act(async () => { await google.options["auth-code"].onSuccess?.({ code: SECRETS.code, scope: GOOGLE_DRIVE_SCOPES }); });

      await waitFor(() => expect(stateOf().google?.refreshToken).toBe(SECRETS.refresh));
      await waitFor(() => expect(sync.syncOne).toHaveBeenCalledWith("google-drive"));
      await expect(loadRefreshToken("google", "g-1")).resolves.toBe(SECRETS.refresh);
      expect(await within(card("Google Drive")).findByText(text.longLived)).toBeInTheDocument();
      expect(screen.queryByText(text.noRefresh)).not.toBeInTheDocument();
    });

    it("explains it, politely, when Google issued no long-lived credentials this time", async () => {
      await brokerReady();
      net.reply("POST", `${BROKER_BASE}/oauth/google/token`, { accessToken: SECRETS.access, expiresIn: 3599 });
      net.reply("GET", "https://www.googleapis.com/oauth2/v3/userinfo", { sub: "g-1", name: "Writer", email: "writer@example.com", picture: "" });
      await open(language);

      await act(async () => { await google.options["auth-code"].onSuccess?.({ code: SECRETS.code, scope: GOOGLE_DRIVE_SCOPES }); });

      const notice = await screen.findByText(text.noRefresh);
      expect(notice.closest("[role='status']")).not.toBeNull();
      expect(stateOf().google?.refreshToken).toBeUndefined();
      expect(await within(card("Google Drive")).findByText(text.sessionGoogle)).toBeInTheDocument();
    });

    it("switches a session connection to long-lived credentials with the same code flow, and refuses another account", async () => {
      await brokerReady();
      seed({ google: googleConnection() });
      net.reply("POST", `${BROKER_BASE}/oauth/google/token`, { accessToken: "at-other", expiresIn: 3599, refreshToken: "rt-other" });
      net.reply("GET", "https://www.googleapis.com/oauth2/v3/userinfo", { sub: "g-2", name: "Someone else", email: "else@example.com", picture: "" });
      await open(language);
      fireEvent.click(await within(card("Google Drive")).findByRole("button", { name: text.upgrade }));
      expect(google.triggers["auth-code"]).toHaveBeenCalledTimes(1);

      await act(async () => { await google.options["auth-code"].onSuccess?.({ code: SECRETS.code, scope: GOOGLE_DRIVE_SCOPES }); });

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(text.wrongAccount);
      expect(stateOf().google?.identity.providerAccountId).toBe("g-1");
      expect(stateOf().google?.refreshToken).toBeUndefined();
    });

    it("opens the Microsoft sign-in window in the very click, and waits for it with a way to cancel", async () => {
      await brokerReady();
      await open(language);
      await waitFor(() => expect(net.broker("/oauth/status")).toHaveLength(1));
      await act(async () => { await Promise.resolve(); });

      fireEvent.click(within(card("OneDrive")).getByRole("button", { name: text.connect }));

      expect(window.open).toHaveBeenCalledTimes(1);
      expect(msal.client.loginPopup).not.toHaveBeenCalled();
      const waiting = await within(card("OneDrive")).findByText(text.waiting);
      expect(waiting.closest("[role='status']")).not.toBeNull();

      fireEvent.click(within(card("OneDrive")).getByRole("button", { name: text.cancel }));
      await waitFor(() => expect(within(card("OneDrive")).queryByText(text.waiting)).not.toBeInTheDocument());
      expect(popup.close).toHaveBeenCalled();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("completes a OneDrive connection from the callback: broker exchange, Graph profile, long-lived credentials", async () => {
      await brokerReady();
      const info = Buffer.from(JSON.stringify({ uid: HOME.split(".")[0], utid: HOME.split(".")[1] })).toString("base64url");
      net.reply("POST", `${BROKER_BASE}/oauth/microsoft/token`, { accessToken: SECRETS.access, expiresIn: 3599, refreshToken: SECRETS.refresh, clientInfo: info });
      net.reply("GET", "https://graph.microsoft.com/v1.0/me", { displayName: "Writer", mail: "writer@contoso.com" });
      await open(language);
      await waitFor(() => expect(net.broker("/oauth/status")).toHaveLength(1));
      await act(async () => { await Promise.resolve(); });

      fireEvent.click(within(card("OneDrive")).getByRole("button", { name: text.connect }));
      await waitFor(() => expect(popup.location.replace).toHaveBeenCalledTimes(1));
      const state = new URL(popup.location.replace.mock.calls[0][0] as string).searchParams.get("state")!;
      await act(async () => { dispatchWindowMessage({ type: MICROSOFT_CALLBACK_MESSAGE, code: SECRETS.code, state }, { source: popup }); });

      await waitFor(() => expect(stateOf().microsoft?.refreshToken).toBe(SECRETS.refresh));
      expect(stateOf().microsoft).toMatchObject({ homeAccountId: HOME, localAccountId: HOME.split(".")[0], rememberMe: true });
      await waitFor(() => expect(sync.syncOne).toHaveBeenCalledWith("onedrive"));
      expect(await within(card("OneDrive")).findByText(text.longLived)).toBeInTheDocument();
      expect(within(card("OneDrive")).getByText(text.noRevoke)).toBeInTheDocument();
    });

    it("switches a OneDrive connection with the same sign-in window, and refuses another account", async () => {
      await brokerReady();
      seed({ microsoft: microsoftConnection() });
      const info = Buffer.from(JSON.stringify({ uid: "00000000-0000-0000-4d3c-0f1e2a3b4c5d", utid: "9188040d-6c67-4c5b-b112-36a304b66dad" })).toString("base64url");
      net.reply("POST", `${BROKER_BASE}/oauth/microsoft/token`, { accessToken: "at-other", expiresIn: 3599, refreshToken: "rt-other", clientInfo: info });
      await open(language);
      const upgrade = await within(card("OneDrive")).findByRole("button", { name: text.upgrade });

      fireEvent.click(upgrade);
      expect(window.open).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(popup.location.replace).toHaveBeenCalledTimes(1));
      const state = new URL(popup.location.replace.mock.calls[0][0] as string).searchParams.get("state")!;
      await act(async () => { dispatchWindowMessage({ type: MICROSOFT_CALLBACK_MESSAGE, code: SECRETS.code, state }, { source: popup }); });

      expect(await screen.findByRole("alert")).toHaveTextContent(text.wrongAccount);
      expect(stateOf().microsoft?.homeAccountId).toBe(HOME);
      expect(stateOf().microsoft?.refreshToken).toBeUndefined();
    });

    it("tells the user when the browser blocked the sign-in window", async () => {
      await brokerReady();
      vi.mocked(window.open).mockReturnValue(null);
      await open(language);
      await waitFor(() => expect(net.broker("/oauth/status")).toHaveLength(1));
      await act(async () => { await Promise.resolve(); });

      fireEvent.click(within(card("OneDrive")).getByRole("button", { name: text.connect }));

      expect(await screen.findByRole("alert")).toHaveTextContent(text.popupBlocked);
    });

    it("reports a declined sign-in as such, not as a failure", async () => {
      await brokerReady();
      await open(language);
      await waitFor(() => expect(net.broker("/oauth/status")).toHaveLength(1));
      await act(async () => { await Promise.resolve(); });
      fireEvent.click(within(card("OneDrive")).getByRole("button", { name: text.connect }));
      await waitFor(() => expect(popup.location.replace).toHaveBeenCalledTimes(1));
      const state = new URL(popup.location.replace.mock.calls[0][0] as string).searchParams.get("state")!;

      await act(async () => { dispatchWindowMessage({ type: MICROSOFT_CALLBACK_MESSAGE, error: "access_denied", state }, { source: popup }); });

      expect(await screen.findByRole("alert")).toHaveTextContent(text.denied);
      expect(stateOf().microsoft).toBeUndefined();
    });

    it("lets Reconnect use the new flow for a login that was lost", async () => {
      await brokerReady();
      seed({ google: googleConnection({ replica: { enabled: true, status: "needs-auth", errorKind: "credential-expired" } }) });
      await open(language);
      await waitFor(() => expect(net.broker("/oauth/status")).toHaveLength(1));
      await act(async () => { await Promise.resolve(); });

      fireEvent.click(within(card("Google Drive")).getByRole("button", { name: text.reconnect }));

      expect(google.triggers["auth-code"]).toHaveBeenCalledTimes(1);
      expect(google.triggers.implicit).not.toHaveBeenCalled();
    });

    it("shows the failure of a refused code in plain words", async () => {
      await brokerReady();
      net.reply("POST", `${BROKER_BASE}/oauth/google/token`, { error: "invalid_grant", message: "x" }, 400);
      await open(language);
      await act(async () => { await google.options["auth-code"].onSuccess?.({ code: SECRETS.code, scope: GOOGLE_DRIVE_SCOPES }); });
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(language === "it" ? /codice di accesso è stato rifiutato/ : /sign-in code was rejected/);
      expect(alert.textContent).not.toContain(SECRETS.code);
    });
  });

  describe("disconnecting", () => {
    it("says that Google revokes the long-lived credentials, revokes them, and forgets them", async () => {
      seed({ google: googleConnection({ refreshToken: SECRETS.refresh }) });
      vi.stubEnv("VITE_AUTH_BROKER_BASE", BROKER_BASE);
      net.reply("GET", `${BROKER_BASE}/oauth/status`, { google: true, microsoft: true });
      net.on("POST", `${BROKER_BASE}/oauth/google/revoke`, () => jsonResponse(null, 204));
      await open(language);

      fireEvent.click(within(card("Google Drive")).getByRole("button", { name: text.disconnect }));

      expect(window.confirm).toHaveBeenCalledTimes(1);
      expect(vi.mocked(window.confirm).mock.calls[0][0]).toMatch(text.googleRevokes);
      await waitFor(() => expect(stateOf().google).toBeUndefined());
      await waitFor(() => expect(net.broker("/oauth/google/revoke")).toHaveLength(1));
      expect(net.broker("/oauth/google/revoke")[0].body).toEqual({ token: SECRETS.refresh });
    });

    it("says that Microsoft cannot revoke from here, and only forgets the credentials on this device", async () => {
      seed({ microsoft: microsoftConnection({ refreshToken: SECRETS.refresh }) });
      await open(language);

      fireEvent.click(within(card("OneDrive")).getByRole("button", { name: text.disconnect }));

      expect(vi.mocked(window.confirm).mock.calls[0][0]).toMatch(text.noRevoke);
      await waitFor(() => expect(stateOf().microsoft).toBeUndefined());
      expect(net.calls.filter((call) => call.url.includes("/revoke"))).toHaveLength(0);
    });

    it("keeps the usual question for a connection without long-lived credentials", async () => {
      seed({ google: googleConnection() });
      await open(language);
      fireEvent.click(within(card("Google Drive")).getByRole("button", { name: text.disconnect }));
      expect(vi.mocked(window.confirm).mock.calls[0][0]).toMatch(text.confirm);
      expect(vi.mocked(window.confirm).mock.calls[0][0]).not.toMatch(/revoca|revokes|revoke/i);
    });

    it("also revokes and forgets everything when every account is disconnected at once", async () => {
      seed({ google: googleConnection({ refreshToken: SECRETS.refresh }), microsoft: microsoftConnection({ refreshToken: SECRETS.refreshRotated }) });
      vi.stubEnv("VITE_AUTH_BROKER_BASE", BROKER_BASE);
      net.on("POST", `${BROKER_BASE}/oauth/google/revoke`, () => jsonResponse(null, 204));
      await open(language);

      fireEvent.click(screen.getByRole("button", { name: language === "it" ? "Disconnetti tutti gli account e continua in locale" : "Disconnect all accounts and continue locally" }));

      await waitFor(() => expect(stateOf()).toEqual({}));
      await waitFor(() => expect(net.broker("/oauth/google/revoke")).toHaveLength(1));
      await expect(loadRefreshToken("microsoft", HOME)).resolves.toBeNull();
    });
  });
});

describe("the new texts", () => {
  it("exist in both languages, and the Italian ones are real translations", async () => {
    const { default: en } = await import("@/i18n/locales/en");
    const { default: italian } = await import("@/i18n/locales/it");
    for (const section of ["credentials", "connectError", "microsoftSignIn"] as const) {
      const english = (en.accountSync as unknown as Record<string, Record<string, string>>)[section];
      const translated = (italian.accountSync as unknown as Record<string, Record<string, string>>)[section];
      expect(english, section).toBeTruthy();
      expect(Object.keys(translated).sort()).toEqual(Object.keys(english).sort());
      for (const key of Object.keys(english)) expect(translated[key], `${section}.${key}`).not.toBe(english[key]);
    }
  });
});
