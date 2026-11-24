import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ connect: vi.fn(), sync: vi.fn() }));
vi.mock("@react-oauth/google", () => ({ useGoogleLogin: () => vi.fn() }));
vi.mock("@/config/msal", () => ({ ensureMsalInitialized: vi.fn(), MICROSOFT_SCOPES: [], microsoftMsalInstance: vi.fn(), microsoftSilentRequest: vi.fn(), setMicrosoftRememberMe: vi.fn() }));
vi.mock("@/hooks/useBrokerAvailability", () => ({ useBrokerAvailability: () => false }));
vi.mock("@/account/accountLocalStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/account/accountLocalStore")>()),
  loadLocalAccountSnapshot: vi.fn(async () => ({ dirty: false, manifest: { modifiedAtUtc: "2026-11-21T21:15:39.398Z" }, data: { settings: { books: [] }, chats: [] } })),
}));
vi.mock("@/github/githubConnection", () => ({ connectGitHubCredential: mocks.connect }));
vi.mock("@/account/accountSync", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/account/accountSync")>()), syncOneAccountReplica: mocks.sync }));

import i18n from "@/i18n";
import { AccountSyncPage } from "@/pages/AccountSyncPage";
import { useConnectionStore } from "@/account/connectionStore";
import { AccountSyncFailure } from "@/account/syncFailure";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import type { LocalGitHubConnection } from "@/account/types";

const connected = (patch: Partial<LocalGitHubConnection> = {}): LocalGitHubConnection => ({ backend: "github", method: "github-pat", credentialKind: "pat", identity: { provider: "github", providerAccountId: "1", displayName: "W", username: "writer" }, token: "ghp", rememberMe: true, accountSyncEnabled: true, repositoryName: "narrarium.settings", replica: { enabled: true, status: "dirty" }, ...patch });

beforeEach(() => {
  useConnectionStore.setState({ hydrated: true, configuration: {} });
  mocks.connect.mockReset().mockImplementation(async () => { useConnectionStore.setState({ configuration: { github: connected() } }); });
  mocks.sync.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  cleanup();
  useConnectionStore.setState({ hydrated: true, configuration: {} });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

async function openAndConnect(language: "en" | "it") {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, language } } });
  await i18n.changeLanguage(language);
  render(<MemoryRouter><AccountSyncPage /></MemoryRouter>);
  fireEvent.change(await screen.findByLabelText(language === "it" ? "Token di accesso personale" : "Personal access token"), { target: { value: "ghp_secret" } });
  fireEvent.click(screen.getByRole("button", { name: language === "it" ? "Usa questo token" : "Use this token" }));
}

describe.each(["en", "it"] as const)("connecting GitHub with a personal access token in %s", (language) => {
  it("leaves the sync choice to the connection (no forced «on») and runs the first sync right away", async () => {
    await openAndConnect(language);
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledWith("github"));
    expect(mocks.connect).toHaveBeenCalledWith({ token: "ghp_secret", kind: "pat", rememberMe: true });
  });

  it("does not sync when the owner's earlier choice for this account is off", async () => {
    mocks.connect.mockImplementation(async () => { useConnectionStore.setState({ configuration: { github: connected({ accountSyncEnabled: false, replica: { enabled: false, status: "disabled" } }) } }); });
    await openAndConnect(language);
    await waitFor(() => expect(mocks.connect).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("says in the app language that the app cannot reach narrarium.settings when the first sync is refused", async () => {
    mocks.sync.mockRejectedValue(new AccountSyncFailure("github", "repository-unreachable", "GitHub sync failed (repository-unreachable): x"));
    await openAndConnect(language);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(language === "it" ? /L'app GitHub di Narrarium non riesce a creare o raggiungere il repository narrarium\.settings/ : /The Narrarium GitHub app cannot create or reach the narrarium\.settings repository/);
    expect(alert.textContent).not.toContain("GitHub sync failed (");
  });
});
