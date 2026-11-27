import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const local = vi.hoisted(() => ({
  snapshot: { dirty: false, manifest: { modifiedAtUtc: "2026-11-21T21:15:39.398Z" }, data: { settings: { books: [{}] }, chats: [{}, {}] } },
}));

vi.mock("@react-oauth/google", () => ({ useGoogleLogin: () => vi.fn() }));
vi.mock("@/config/msal", () => ({ ensureMsalInitialized: vi.fn(), MICROSOFT_SCOPES: [], microsoftMsalInstance: vi.fn(), microsoftSilentRequest: vi.fn(), setMicrosoftRememberMe: vi.fn() }));
vi.mock("@/account/accountLocalStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/account/accountLocalStore")>()),
  loadLocalAccountSnapshot: vi.fn(async () => local.snapshot),
}));

import i18n from "@/i18n";
import { AccountSyncPage } from "@/pages/AccountSyncPage";
import { useConnectionStore } from "@/account/connectionStore";
import { useAccountSyncStore } from "@/account/accountSync";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import type { LocalReplicaState, LocalSyncConfiguration } from "@/account/types";

const RAW_MESSAGE = "google-drive did not provide a revision for a conditional account update.";
const LAST_SYNC = "2026-11-21T21:28:18.893Z";

const TEXTS = {
  it: {
    notConnected: "Non connesso", dataSync: "Sincronizzazione dei dati dell'account", sync: "Sincronizza", disconnect: "Disconnetti", deleteRemote: "Elimina dati remoti",
    lastSync: "Ultima sincronizzazione", reconnect: "Riconnetti", signInAgain: (service: string) => `Accedi di nuovo a ${service} su questo dispositivo`, githubNotEnabled: "L'accesso con GitHub non è ancora attivo su questo sito.", githubPat: "Usa un token di accesso personale (avanzato)", lastError: "Ultimo errore",
    failed: "Sincronizzazione non riuscita", unknownKind: "Qualcosa è andato storto durante la sincronizzazione.", needsLogin: "Riconnetti OneDrive", expiredKind: "L'accesso a OneDrive va rinnovato. Riconnetti OneDrive per continuare a sincronizzare; non si perde nulla, i dati restano su questo dispositivo.",
    status: (state: string) => `Stato: ${state}`, upToDate: "Aggiornato",
    sync1: "21 nov 2026, 22:28", workspaceDate: "21 nov 2026, 22:15", counts: "1 libro · 2 chat",
  },
  en: {
    notConnected: "Not connected", dataSync: "Account data sync", sync: "Sync", disconnect: "Disconnect", deleteRemote: "Delete remote",
    lastSync: "Last sync", reconnect: "Reconnect", signInAgain: (service: string) => `Sign in to ${service} again on this device`, githubNotEnabled: "Sign-in with GitHub is not enabled on this site yet.", githubPat: "Use a personal access token (advanced)", lastError: "Last error",
    failed: "Sync failed", unknownKind: "Something unexpected went wrong while syncing.", needsLogin: "Reconnect OneDrive", expiredKind: "The OneDrive sign-in needs to be renewed. Reconnect OneDrive to keep syncing; nothing is lost, your data stays on this device.",
    status: (state: string) => `Status: ${state}`, upToDate: "Up to date",
    sync1: /^Nov 21, 2026, 10:28\sPM$/, workspaceDate: /^Nov 21, 2026, 10:15\sPM$/, counts: "1 book · 2 chats",
  },
} as const;

function replica(patch: Partial<LocalReplicaState> = {}): LocalReplicaState {
  return { enabled: true, status: "idle", lastSuccessfulSyncAtUtc: LAST_SYNC, ...patch };
}

function connect(configuration: LocalSyncConfiguration) {
  useConnectionStore.setState({ hydrated: true, configuration });
}

const google = (patch: Partial<LocalReplicaState> = {}): NonNullable<LocalSyncConfiguration["google"]> => ({
  backend: "google-drive", method: "google", identity: { provider: "google", providerAccountId: "g-1", displayName: "Writer" }, accessToken: "token", rememberMe: true, replica: replica(patch),
});
const microsoft = (patch: Partial<LocalReplicaState> = {}): NonNullable<LocalSyncConfiguration["microsoft"]> => ({
  backend: "onedrive", method: "microsoft", identity: { provider: "microsoft", providerAccountId: "m-1", displayName: "Writer" }, accessToken: "token", homeAccountId: "m-1", localAccountId: "l-1", rememberMe: true, replica: replica(patch),
});

async function open(language: "it" | "en") {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, language } } });
  await i18n.changeLanguage(language);
  render(<MemoryRouter><AccountSyncPage /></MemoryRouter>);
  await screen.findByText(language === "it" ? /Disponibile senza login/ : /Available without login/);
}

const card = (name: string) => screen.getByRole("heading", { name }).parentElement!.parentElement!;
const timeIn = (element: HTMLElement) => element.querySelector("time");

const zone = process.env.TZ;
beforeAll(() => { process.env.TZ = "Europe/Rome"; });
afterAll(() => { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; });

beforeEach(() => {
  useAccountSyncStore.setState({ syncing: false, reconciliation: null });
});

afterEach(async () => {
  cleanup();
  useConnectionStore.setState({ hydrated: true, configuration: {} });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe.each(["it", "en"] as const)("Account & Sync page in %s", (language) => {
  const text = TEXTS[language];

  it("shows every date in the viewer's time zone, never as a raw ISO string", async () => {
    connect({ google: google(), microsoft: microsoft({ lastSuccessfulSyncAtUtc: "2026-11-21T21:29:00.000Z" }) });
    await open(language);

    const googleTime = timeIn(card("Google Drive"));
    expect(googleTime).toHaveAttribute("datetime", LAST_SYNC);
    expect(googleTime).toHaveAttribute("title", LAST_SYNC);
    expect(googleTime?.textContent).toMatch(text.sync1);
    expect(timeIn(card("OneDrive"))?.textContent).toMatch(language === "it" ? "22:29" : /10:29\sPM/);

    const workspace = screen.getByText(text.counts).parentElement!;
    expect(timeIn(workspace)).toHaveAttribute("datetime", local.snapshot.manifest.modifiedAtUtc);
    expect(timeIn(workspace)?.textContent).toMatch(text.workspaceDate);

    expect(document.body.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(document.body.textContent).not.toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });

  it("writes the whole connection cards in the app language", async () => {
    connect({ google: google(), microsoft: microsoft({ status: "needs-auth", errorKind: "credential-expired" }) });
    await open(language);

    const driveCard = within(card("Google Drive"));
    expect(driveCard.getByText(text.status(text.upToDate))).toBeInTheDocument();
    expect(driveCard.getByText(text.dataSync)).toBeInTheDocument();
    expect(driveCard.getByRole("button", { name: text.sync })).toBeInTheDocument();
    expect(driveCard.getByRole("button", { name: text.disconnect })).toBeInTheDocument();
    expect(driveCard.getByRole("button", { name: text.deleteRemote })).toBeInTheDocument();
    expect(driveCard.getByText(`${text.lastSync}:`, { exact: false })).toBeInTheDocument();
    expect(driveCard.queryByRole("button", { name: `${text.reconnect} Google Drive` })).not.toBeInTheDocument();

    const driveNeedingLogin = within(card("OneDrive"));
    expect(driveNeedingLogin.getByRole("button", { name: text.signInAgain("OneDrive") })).toBeInTheDocument();
    expect(driveNeedingLogin.getByText(text.status(text.needsLogin))).toBeInTheDocument();

    const github = within(card("GitHub"));
    expect(github.getByText(text.notConnected)).toBeInTheDocument();
    // The GitHub app sign-in is offered only where the broker says so and the build has the app's client id: here it has neither, so the card says so
    // in one honest line and offers the personal access token (this replaces the «Connect OAuth» button of the disabled browser-only flow).
    expect(await github.findByText(text.githubNotEnabled, { exact: false })).toBeInTheDocument();
    expect(github.getByText(text.githubPat)).toBeInTheDocument();
    expect(github.queryByRole("button", { name: /OAuth/ })).not.toBeInTheDocument();

    if (language === "it") {
      for (const english of ["Account data sync", "Sync", "Disconnect", "Delete remote", "Not connected", "Reconnect", "Connect"]) {
        expect(screen.queryByText(english)).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: english })).not.toBeInTheDocument();
      }
    }
  });

  it("explains the last error of a failed replica in plain words and keeps the raw message as detail", async () => {
    connect({ google: google({ status: "error", errorKind: "unknown", lastErrorMessage: RAW_MESSAGE }), microsoft: microsoft({ status: "needs-auth", errorKind: "credential-expired" }) });
    await open(language);

    const failed = within(card("Google Drive"));
    expect(failed.getByText(text.status(text.failed))).toBeInTheDocument();
    expect(failed.getByText(text.lastError, { exact: false })).toBeInTheDocument();
    expect(failed.getByText(text.unknownKind)).toBeInTheDocument();
    expect(failed.getByText(RAW_MESSAGE)).toBeInTheDocument();
    expect(card("Google Drive")).not.toHaveTextContent(/error · unknown/);

    expect(within(card("OneDrive")).getByRole("heading", { name: text.signInAgain("OneDrive") })).toBeInTheDocument();
  });

  it("shows the copies to choose from with local dates and counts in the app language", async () => {
    connect({ google: google() });
    const snapshot = { dirty: false, manifest: { modifiedAtUtc: "2026-11-21T21:15:39.398Z", modifiedByDeviceId: "device-a" }, data: { settings: { books: [{}] }, chats: [{}, {}] } };
    useAccountSyncStore.setState({ reconciliation: { local: snapshot, remotes: [], candidates: [{ id: "local", label: "Local device", comparison: "same", snapshot }] } as never });
    await open(language);

    const dialog = await screen.findByRole("dialog");
    expect(timeIn(dialog)).toHaveAttribute("datetime", "2026-11-21T21:15:39.398Z");
    expect(timeIn(dialog)?.textContent).toMatch(text.workspaceDate);
    expect(within(dialog).getByText(text.counts, { exact: false })).toBeInTheDocument();
    expect(dialog.textContent).not.toContain(" UTC");
    expect(within(dialog).getByRole("button", { name: language === "it" ? "Annulla" : "Cancel" })).toBeInTheDocument();
  });

  it("opens the check of the Google configuration from the Google card, only when asked", async () => {
    connect({ google: google() });
    await open(language);
    const label = language === "it" ? "Controlla la configurazione di Google" : "Check Google configuration";
    expect(screen.queryByTestId("google-config-check")).toBeNull();
    const button = within(card("Google Drive")).getByRole("button", { name: label });
    expect(button).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(button);
    expect(await screen.findByTestId("google-config-check")).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-expanded", "true");
  });

  it("shows no error block for a replica that is in sync", async () => {
    connect({ google: google() });
    await open(language);
    expect(within(card("Google Drive")).queryByText(text.lastError, { exact: false })).not.toBeInTheDocument();
  });
});

describe("Account & Sync page dates that cannot be read", () => {
  it("keeps a value it cannot parse as it is", async () => {
    connect({ google: google({ lastSuccessfulSyncAtUtc: "yesterday evening" }) });
    await open("en");
    await waitFor(() => expect(within(card("Google Drive")).getByText("yesterday evening")).toBeInTheDocument());
    expect(timeIn(card("Google Drive"))).toBeNull();
  });
});
