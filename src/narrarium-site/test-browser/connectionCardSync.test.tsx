import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";

vi.mock("@react-oauth/google", () => ({ useGoogleLogin: () => vi.fn() }));
vi.mock("@/config/msal", () => ({ ensureMsalInitialized: vi.fn(), MICROSOFT_SCOPES: [], microsoftMsalInstance: vi.fn(), microsoftSilentRequest: vi.fn(), setMicrosoftRememberMe: vi.fn() }));
vi.mock("@/account/accountLocalStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/account/accountLocalStore")>()),
  loadLocalAccountSnapshot: vi.fn(async () => ({ dirty: false, manifest: { modifiedAtUtc: "2026-11-21T21:15:39.398Z" }, data: { settings: { books: [{}] }, chats: [] } })),
}));

import i18n from "@/i18n";
import { ConnectionCard, type ConnectionCardProps } from "@/components/account/ConnectionCard";
import { AccountSyncPage } from "@/pages/AccountSyncPage";
import { closeAccountLocalStoreForTests, initializeAccountLocalStore, loadLocalSyncConfiguration } from "@/account/accountLocalStore";
import { useConnectionStore } from "@/account/connectionStore";
import { useAccountSyncStore } from "@/account/accountSync";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { emptyCostsFile } from "@/costs/model";

const CHECK = "2026-11-27T09:30:00.000Z";
const TEXTS = {
  en: { synced: /All synced · last check/, sync: "Sync", checkNow: "Check now", hint: "Looks for changes made on another device.", pending: "Changes on this device are waiting to be sent.", tryAgain: "Try again", inherit: "Follows the general setting, which is on.", own: "Set for this service only: off. It overrides the general setting.", follow: "Follow the general setting", all: "Automatic sync for all services", allHelp: /every connected service sends and receives your changes by itself/ },
  it: { synced: /Tutto sincronizzato · ultimo controllo/, sync: "Sincronizza", checkNow: "Controlla ora", hint: "Cerca le modifiche fatte su un altro dispositivo.", pending: "Le modifiche su questo dispositivo aspettano di essere inviate.", tryAgain: "Riprova", inherit: "Segue l'impostazione generale, che è attiva.", own: "Impostata solo per questo servizio: spenta. Prevale sull'impostazione generale.", follow: "Segui l'impostazione generale", all: "Sincronizzazione automatica per tutti i servizi", allHelp: /ogni servizio collegato invia e riceve le tue modifiche da solo/ },
} as const;

const base = (overrides: Partial<ConnectionCardProps> = {}): ConnectionCardProps => ({
  title: "Google Drive", icon: null, connected: true, enabled: true, status: "idle", lastSync: CHECK, busy: false, autoMode: "inherit", autoSyncAll: true,
  onConnect: vi.fn(), onSync: vi.fn(), onDisconnect: vi.fn(), onDelete: vi.fn(), onToggle: vi.fn(), onFollowGeneral: vi.fn(), ...overrides,
});
afterEach(async () => { cleanup(); await i18n.changeLanguage("en"); });

describe.each(["en", "it"] as const)("the sync state of a card, in %s", (language) => {
  const text = TEXTS[language];
  beforeEach(async () => { await i18n.changeLanguage(language); });

  it("says «All synced · last check», has no primary Sync and keeps a quiet Check now with its one line", () => {
    render(<ConnectionCard {...base()} />);
    expect(screen.getByTestId("sync-state")).toHaveTextContent(text.synced);
    expect(screen.getByTestId("sync-state").querySelector("time")).toHaveAttribute("datetime", CHECK);
    expect(screen.queryByRole("button", { name: text.sync })).toBeNull();
    const check = screen.getByRole("button", { name: text.checkNow });
    expect(check).toHaveAccessibleDescription(text.hint);
  });

  it("runs the sync when Check now is pressed", () => {
    const props = base();
    render(<ConnectionCard {...props} />);
    fireEvent.click(screen.getByRole("button", { name: text.checkNow }));
    expect(props.onSync).toHaveBeenCalledTimes(1);
  });

  it("makes Sync the primary action when changes are not sent, and Try again after an error", () => {
    const { rerender } = render(<ConnectionCard {...base({ localDirty: true })} />);
    expect(screen.getByTestId("sync-state")).toHaveTextContent(text.pending);
    expect(screen.getByRole("button", { name: text.sync })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: text.checkNow })).toBeNull();
    rerender(<ConnectionCard {...base({ status: "error", errorKind: "network", errorMessage: "Failed to fetch" })} />);
    expect(screen.getByRole("button", { name: text.tryAgain })).toBeInTheDocument();
  });

  it("explains whether the service follows the general setting or has its own, and gives the general one back", () => {
    const props = base({ autoMode: "off", enabled: false, status: "disabled" });
    const { rerender } = render(<ConnectionCard {...props} />);
    expect(screen.getByText(text.own)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: text.follow }));
    expect(props.onFollowGeneral).toHaveBeenCalledTimes(1);
    rerender(<ConnectionCard {...base()} />);
    expect(screen.getByText(text.inherit)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: text.follow })).toBeNull();
  });
});

describe.each(["en", "it"] as const)("the automatic sync of all the services on the page, in %s", (language) => {
  const text = TEXTS[language];

  beforeEach(async () => {
    closeAccountLocalStoreForTests();
    await new Promise<void>((resolve) => { const request = indexedDB.deleteDatabase("narrarium-local-account"); request.onsuccess = () => resolve(); request.onerror = () => resolve(); });
    await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
    useAccountSyncStore.setState({ syncing: false, reconciliation: null });
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, language } } });
    await i18n.changeLanguage(language);
    useConnectionStore.setState({
      hydrated: true,
      configuration: {
        google: { backend: "google-drive", method: "google", identity: { provider: "google", providerAccountId: "g-1", displayName: "Writer" }, accessToken: "t", rememberMe: true, replica: { enabled: true, autoMode: "inherit", status: "idle", lastSuccessfulSyncAtUtc: CHECK } },
        microsoft: { backend: "onedrive", method: "microsoft", identity: { provider: "microsoft", providerAccountId: "m-1", displayName: "Writer" }, accessToken: "t", homeAccountId: "m-1", localAccountId: "l-1", rememberMe: true, replica: { enabled: true, autoMode: "on", status: "idle", lastSuccessfulSyncAtUtc: CHECK } },
      },
    });
  });
  afterEach(() => useConnectionStore.setState({ hydrated: true, configuration: {} }));

  it("has the general switch at the top, explained, that moves the services that follow it and not the ones set by themselves, and is stored", async () => {
    render(<MemoryRouter><AccountSyncPage /></MemoryRouter>);
    const general = within(await screen.findByTestId("auto-sync-all"));
    const toggle = general.getByRole("switch", { name: text.all });
    expect(toggle).toBeChecked();
    expect(toggle).toHaveAccessibleDescription(text.allHelp);
    expect(screen.getByTestId("auto-sync-all").compareDocumentPosition(screen.getByRole("heading", { name: "Google Drive" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(toggle);
    await waitFor(() => expect(useConnectionStore.getState().configuration.autoSyncAll).toBe(false));
    expect(useConnectionStore.getState().configuration.google?.replica.enabled).toBe(false);
    expect(useConnectionStore.getState().configuration.microsoft?.replica.enabled).toBe(true);
    await waitFor(async () => expect((await loadLocalSyncConfiguration()).autoSyncAll).toBe(false));
    expect(screen.getByTestId("auto-sync-all").querySelector("[role=switch]")).not.toBeChecked();
  });

  it("sets one service by itself with its own switch, and gives it back to the general setting", async () => {
    render(<MemoryRouter><AccountSyncPage /></MemoryRouter>);
    const driveCard = () => within(screen.getByRole("heading", { name: "Google Drive" }).parentElement!.parentElement!);
    await screen.findByTestId("auto-sync-all");
    expect(driveCard().getByText(text.inherit)).toBeInTheDocument();
    fireEvent.click(driveCard().getAllByRole("switch")[0]);
    await waitFor(() => expect(useConnectionStore.getState().configuration.google?.replica).toMatchObject({ enabled: false, autoMode: "off" }));
    expect(await driveCard().findByText(text.own)).toBeInTheDocument();
    fireEvent.click(driveCard().getByRole("button", { name: text.follow }));
    await waitFor(() => expect(useConnectionStore.getState().configuration.google?.replica).toMatchObject({ enabled: true, autoMode: "inherit" }));
  });
});
