import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sync = vi.hoisted(() => ({ syncOne: vi.fn(async (_kind: string) => undefined) }));
vi.mock("@/account/accountSync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/account/accountSync")>()),
  syncOneAccountReplica: sync.syncOne,
}));

import i18n from "@/i18n";
import { SyncStatusIndicator } from "@/components/layout/SyncStatusIndicator";
import { useAccountSyncStore } from "@/account/accountSync";
import { useConnectionStore } from "@/account/connectionStore";
import { useUiStore } from "@/store/uiStore";
import type { LocalReplicaState, LocalSyncConfiguration } from "@/account/types";

const NOW = new Date("2026-11-21T22:30:00.000Z");
const TODAY_SYNC = "2026-11-21T21:28:18.893Z";
const OLDER_SYNC = "2026-11-20T21:28:18.893Z";
const RAW_MESSAGE = "google-drive did not provide a revision for a conditional account update.";

const replica = (status: LocalReplicaState["status"], patch: Partial<LocalReplicaState> = {}): LocalReplicaState => ({ enabled: true, status, lastSuccessfulSyncAtUtc: TODAY_SYNC, ...patch });

function configuration(replicas: { google?: LocalReplicaState; microsoft?: LocalReplicaState; github?: LocalReplicaState }): LocalSyncConfiguration {
  return {
    ...(replicas.google ? { google: { backend: "google-drive", method: "google", identity: { provider: "google", providerAccountId: "g", displayName: "G" }, rememberMe: true, replica: replicas.google } } : {}),
    ...(replicas.microsoft ? { microsoft: { backend: "onedrive", method: "microsoft", identity: { provider: "microsoft", providerAccountId: "m", displayName: "M" }, homeAccountId: "m", localAccountId: "m", rememberMe: true, replica: replicas.microsoft } } : {}),
    ...(replicas.github ? { github: { backend: "github", method: "github-pat", credentialKind: "pat", rememberMe: true, accountSyncEnabled: true, repositoryName: "narrarium.settings", replica: replicas.github } } : {}),
  } as LocalSyncConfiguration;
}

type Replicas = Parameters<typeof configuration>[0];
const setReplicas = (replicas: Replicas) => act(() => { useConnectionStore.setState({ hydrated: true, configuration: configuration(replicas) }); });
const setSyncing = (syncing: boolean) => act(() => { useAccountSyncStore.setState({ syncing }); });
const setDeviceOffline = (offline: boolean) => act(() => {
  vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(!offline);
  window.dispatchEvent(new Event(offline ? "offline" : "online"));
});

async function show(language: "en" | "it", replicas: Replicas = { google: replica("idle") }) {
  await i18n.changeLanguage(language);
  setReplicas(replicas);
  return render(<MemoryRouter><SyncStatusIndicator /></MemoryRouter>);
}

// An open menu hides the rest of the page from assistive technology, the trigger included.
const trigger = () => screen.getByRole("button", { name: /^(Sync status|Stato della sincronizzazione):/, hidden: true });
const openByPointer = () => fireEvent.pointerDown(trigger(), { button: 0, ctrlKey: false });
const message = () => screen.getByRole("status").textContent;

interface Case { state: string; replicas: Replicas; syncing?: boolean; offline?: boolean; attention: boolean; en: { name: string; label: string; tooltip: string | RegExp }; it: { name: string; label: string; tooltip: string | RegExp } }

const CASES: Case[] = [
  { state: "synced", replicas: { google: replica("idle"), github: replica("idle") }, attention: false,
    en: { name: "Sync status: Synced", label: "Synced", tooltip: /^Saved · synced at 10:28\sPM$/ }, it: { name: "Stato della sincronizzazione: Sincronizzato", label: "Sincronizzato", tooltip: "Salvato · sincronizzato alle 22:28" } },
  { state: "syncing", replicas: { google: replica("syncing") }, syncing: true, attention: false,
    en: { name: "Sync status: Syncing…", label: "Syncing…", tooltip: "Saved locally · syncing…" }, it: { name: "Stato della sincronizzazione: Sincronizzazione…", label: "Sincronizzazione…", tooltip: "Salvato localmente · sincronizzazione in corso…" } },
  { state: "pending", replicas: { google: replica("idle"), microsoft: replica("dirty") }, attention: false,
    en: { name: "Sync status: Pending", label: "Pending", tooltip: "Saved locally · changes waiting to sync" }, it: { name: "Stato della sincronizzazione: In attesa", label: "In attesa", tooltip: "Salvato localmente · modifiche in attesa di sincronizzazione" } },
  { state: "needs-login", replicas: { google: replica("idle"), microsoft: replica("needs-auth", { errorKind: "credential-expired" }) }, attention: true,
    en: { name: "Sync status: Login needed", label: "Login needed", tooltip: "Saved locally · reconnect OneDrive" }, it: { name: "Stato della sincronizzazione: Accesso necessario", label: "Accesso necessario", tooltip: "Salvato localmente · riconnetti OneDrive" } },
  { state: "failed", replicas: { google: replica("error", { errorKind: "unknown", lastErrorMessage: RAW_MESSAGE }) }, attention: true,
    en: { name: "Sync status: Sync failed", label: "Sync failed", tooltip: "Saved locally · Google Drive sync failed" }, it: { name: "Stato della sincronizzazione: Sync non riuscita", label: "Sync non riuscita", tooltip: "Salvato localmente · sincronizzazione con Google Drive non riuscita" } },
  { state: "remote-offline", replicas: { github: replica("offline", { errorKind: "offline" }) }, attention: true,
    en: { name: "Sync status: Service offline", label: "Service offline", tooltip: "Saved locally · GitHub is offline" }, it: { name: "Stato della sincronizzazione: Servizio offline", label: "Servizio offline", tooltip: "Salvato localmente · GitHub non è raggiungibile" } },
  { state: "device-offline", replicas: { google: replica("idle") }, offline: true, attention: true,
    en: { name: "Sync status: Offline", label: "Offline", tooltip: "Offline · saved locally" }, it: { name: "Stato della sincronizzazione: Offline", label: "Offline", tooltip: "Offline · salvato localmente" } },
];

const zone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Europe/Rome";
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterAll(() => {
  vi.unstubAllGlobals();
  if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  sync.syncOne.mockReset();
  sync.syncOne.mockResolvedValue(undefined);
  useUiStore.setState({ authActivity: "idle" });
  useAccountSyncStore.setState({ syncing: false, reconciliation: null });
  useConnectionStore.setState({ hydrated: true, configuration: {} });
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  await i18n.changeLanguage("en");
});

describe.each(["en", "it"] as const)("sync status indicator in the header (%s)", (language) => {
  it.each(CASES)("shows the $state state as a button whose name carries the state", async (testCase) => {
    const text = testCase[language];
    if (testCase.syncing) useAccountSyncStore.setState({ syncing: true });
    if (testCase.offline) vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    await show(language, testCase.replicas);

    const button = trigger();
    expect(button.tagName).toBe("BUTTON");
    expect(button).toHaveAccessibleName(text.name);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveAttribute("data-sync-state", testCase.state);
    expect(button.getAttribute("title")).toMatch(text.tooltip instanceof RegExp ? text.tooltip : new RegExp(`^${text.tooltip.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    expect(button.className.includes("amber")).toBe(testCase.attention);
    expect(button.innerHTML.includes("animate-spin")).toBe(testCase.state === "syncing");

    // A word next to the icon, from md up, only when something needs attention: a label that comes and goes with
    // every save would make the other buttons of the header jump.
    const label = within(button).queryByText(text.label);
    if (!testCase.attention) expect(label).toBeNull();
    else {
      expect(label).not.toBeNull();
      expect(label!.className).toContain("hidden");
      expect(label!.className).toContain("md:inline");
    }
    for (const icon of button.querySelectorAll("svg")) expect(icon).toHaveAttribute("aria-hidden", "true");
  });

  it("says when the last sync was on another day", async () => {
    await show(language, { google: replica("idle", { lastSuccessfulSyncAtUtc: OLDER_SYNC }) });
    expect(trigger().getAttribute("title")).toMatch(language === "it" ? /^Salvato · sincronizzato il 20 nov 2026, 22:28$/ : /^Saved · synced on Nov 20, 2026, 10:28\sPM$/);
  });

  it("does not claim a sync time it does not have", async () => {
    await show(language, { google: replica("idle", { lastSuccessfulSyncAtUtc: undefined }) });
    expect(trigger().getAttribute("title")).toBe(language === "it" ? "Salvato localmente" : "Saved locally");
  });

  it("is not shown when no service syncs this device and the device is online", async () => {
    await show(language, {});
    expect(screen.queryByRole("button")).toBeNull();
    await setReplicas({ google: replica("idle", { enabled: false, status: "disabled" }) });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is shown for a device that is offline even when no service is configured", async () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    await show(language, {});
    expect(trigger()).toHaveAttribute("data-sync-state", "device-offline");
  });

  it("opens a popover with a line for each enabled service, its state in words, its last sync in local time and its last error", async () => {
    await show(language, {
      google: replica("error", { errorKind: "unknown", lastErrorMessage: RAW_MESSAGE }),
      microsoft: replica("needs-auth", { errorKind: "credential-expired", lastSuccessfulSyncAtUtc: OLDER_SYNC }),
      github: replica("idle", { enabled: false, status: "disabled" }),
    });
    openByPointer();
    const menu = await screen.findByRole("menu");
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(within(menu).getAllByRole("group").map((group) => group.getAttribute("aria-label"))).toEqual(["Google Drive", "OneDrive"]);

    const drive = within(screen.getByRole("group", { name: "Google Drive" }));
    expect(drive.getByText(language === "it" ? "Sincronizzazione non riuscita" : "Sync failed")).toBeInTheDocument();
    expect(drive.getByText(language === "it" ? "Qualcosa è andato storto durante la sincronizzazione." : "Something unexpected went wrong while syncing.")).toBeInTheDocument();
    expect(drive.getByText(RAW_MESSAGE)).toBeInTheDocument();
    expect(drive.getByText(language === "it" ? "Ultimo errore:" : "Last error:")).toBeInTheDocument();
    const syncTime = screen.getByRole("group", { name: "Google Drive" }).querySelector("time")!;
    expect(syncTime).toHaveAttribute("datetime", TODAY_SYNC);
    expect(syncTime.textContent).toMatch(language === "it" ? "21 nov 2026, 22:28" : /^Nov 21, 2026, 10:28\sPM$/);

    const onedrive = within(screen.getByRole("group", { name: "OneDrive" }));
    // The state in words, and the link that acts on it.
    expect(onedrive.getAllByText(language === "it" ? "Riconnetti OneDrive" : "Reconnect OneDrive")).toHaveLength(2);
    expect(onedrive.getByText(language === "it" ? "L'accesso a OneDrive va rinnovato. Riconnetti OneDrive per continuare a sincronizzare; non si perde nulla, i dati restano su questo dispositivo." : "The OneDrive sign-in needs to be renewed. Reconnect OneDrive to keep syncing; nothing is lost, your data stays on this device.")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "OneDrive" }).querySelector("time")).toHaveAttribute("datetime", OLDER_SYNC);
    expect(menu.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it("says that a service has never synced instead of showing an empty date", async () => {
    await show(language, { google: replica("dirty", { lastSuccessfulSyncAtUtc: undefined }) });
    openByPointer();
    const group = within(await screen.findByRole("group", { name: "Google Drive" }));
    expect(group.getByText(language === "it" ? "Non ancora sincronizzato" : "Not synced yet")).toBeInTheDocument();
  });

  it("offers Sync now for every service, Reconnect only where a login is needed, and a link to Account & Sync", async () => {
    await show(language, { google: replica("idle"), microsoft: replica("needs-auth", { errorKind: "credential-expired" }) });
    openByPointer();
    await screen.findByRole("menu");
    const syncNow = language === "it" ? "Sincronizza ora" : "Sync now";
    const reconnect = language === "it" ? "Riconnetti" : "Reconnect";

    expect(screen.getByRole("menuitem", { name: `${syncNow}: Google Drive` })).toHaveTextContent(syncNow);
    expect(screen.getByRole("menuitem", { name: `${syncNow}: OneDrive` })).toHaveTextContent(syncNow);
    const link = screen.getByRole("menuitem", { name: `${reconnect} OneDrive` });
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "/app/account-sync");
    expect(screen.queryByRole("menuitem", { name: `${reconnect} Google Drive` })).toBeNull();

    const page = screen.getByRole("menuitem", { name: language === "it" ? "Account e sincronizzazione" : "Account & Sync" });
    expect(page.tagName).toBe("A");
    expect(page).toHaveAttribute("href", "/app/account-sync");
  });

  it("runs the sync of that service only, and keeps the popover open to show the result", async () => {
    await show(language, { google: replica("idle"), microsoft: replica("idle"), github: replica("idle") });
    openByPointer();
    await screen.findByRole("menu");
    fireEvent.click(screen.getByRole("menuitem", { name: `${language === "it" ? "Sincronizza ora" : "Sync now"}: OneDrive` }));

    await waitFor(() => expect(sync.syncOne).toHaveBeenCalledTimes(1));
    expect(sync.syncOne).toHaveBeenCalledWith("onedrive");
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("survives a sync that fails, because the failure is recorded on the service and shown by the indicator", async () => {
    sync.syncOne.mockRejectedValueOnce(new Error("Google Drive sync failed (unknown)"));
    await show(language);
    openByPointer();
    await screen.findByRole("menu");
    fireEvent.click(screen.getByRole("menuitem", { name: /: Google Drive$/ }));
    await waitFor(() => expect(sync.syncOne).toHaveBeenCalledWith("google-drive"));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: /: Google Drive$/ })).not.toHaveAttribute("aria-disabled", "true"));
  });

  it("does not offer to sync while a sync runs or while the device is offline", async () => {
    await show(language, { google: replica("syncing") });
    await setSyncing(true);
    openByPointer();
    await screen.findByRole("menu");
    const item = screen.getByRole("menuitem", { name: /: Google Drive$/ });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveTextContent(language === "it" ? "Sincronizzazione in corso…" : "Syncing…");
    fireEvent.click(item);
    expect(sync.syncOne).not.toHaveBeenCalled();

    await setSyncing(false);
    await setDeviceOffline(true);
    expect(screen.getByRole("menuitem", { name: /: Google Drive$/ })).toHaveAttribute("aria-disabled", "true");
  });

  it("opens with Enter, Space and the arrow key, and closes with Escape handing the focus back", async () => {
    await show(language);
    for (const key of ["Enter", " ", "ArrowDown"]) {
      trigger().focus();
      fireEvent.keyDown(trigger(), { key });
      const menu = await screen.findByRole("menu");
      expect(trigger()).toHaveAttribute("aria-expanded", "true");
      fireEvent.keyDown(menu, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      expect(trigger()).toHaveFocus();
      expect(trigger()).toHaveAttribute("aria-expanded", "false");
    }
  });

  it("lists no service, and explains why, when only the device is offline", async () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    await show(language, {});
    openByPointer();
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryAllByRole("group")).toHaveLength(0);
    expect(within(menu).getByText(language === "it" ? "Nessun servizio sta sincronizzando questo dispositivo." : "No service is syncing this device.")).toBeInTheDocument();
  });
});

describe("sync status indicator announcements", () => {
  it("announces the transitions into an attention state and back to synced, not every sync", async () => {
    await show("en", { google: replica("idle") });
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(message()).toBe("");

    await setSyncing(true);
    await setReplicas({ google: replica("syncing") });
    expect(message()).toBe("");
    await setSyncing(false);
    await setReplicas({ google: replica("idle") });
    expect(message()).toBe("");

    await setReplicas({ google: replica("dirty") });
    expect(message()).toBe("");

    await setReplicas({ google: replica("error", { errorKind: "unknown" }) });
    expect(message()).toBe("Google Drive sync failed.");

    await setReplicas({ google: replica("needs-auth", { errorKind: "credential-expired" }) });
    expect(message()).toBe("The Google Drive sign-in needs to be renewed. Reconnect Google Drive.");

    await setSyncing(true);
    await setReplicas({ google: replica("syncing") });
    expect(message()).toBe("");
    await setSyncing(false);
    await setReplicas({ google: replica("error", { errorKind: "network" }) });
    expect(message()).toBe("Google Drive sync failed.");

    await setReplicas({ google: replica("offline", { errorKind: "offline" }) });
    expect(message()).toBe("Google Drive is offline.");

    await setSyncing(true);
    await setReplicas({ google: replica("syncing") });
    await setSyncing(false);
    await setReplicas({ google: replica("idle") });
    expect(message()).toBe("Everything is synced again.");

    await setReplicas({ google: replica("dirty") });
    expect(message()).toBe("");
  });

  it("announces that the device is offline and when it is back", async () => {
    await show("it", { google: replica("idle") });
    await setDeviceOffline(true);
    expect(message()).toBe("Sei offline. Le modifiche sono salvate su questo dispositivo.");
    await setDeviceOffline(false);
    expect(message()).toBe("Tutto è di nuovo sincronizzato.");
  });

  it("does not announce a login that was already needed when it appeared, nor the removal of the last service", async () => {
    await show("en", { google: replica("needs-auth", { errorKind: "credential-expired" }) });
    expect(message()).toBe("");
    await setReplicas({});
    expect(message()).toBe("");
  });

  it("does not repeat an announcement when only the language changes", async () => {
    await show("en", { google: replica("idle") });
    await setReplicas({ google: replica("error", { errorKind: "unknown" }) });
    expect(message()).toBe("Google Drive sync failed.");
    await act(async () => { await i18n.changeLanguage("it"); });
    expect(message()).toBe("Google Drive sync failed.");
  });
});

describe("where the sync status lives", () => {
  const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

  it("is in the header, and no longer floats over the content", () => {
    expect(source("src/components/layout/Topbar.tsx")).toContain("<SyncStatusIndicator />");
    expect(source("src/components/layout/Shell.tsx")).not.toContain("SessionStatusPill");
    expect(existsSync(resolve(process.cwd(), "src/components/layout/SessionStatusPill.tsx"))).toBe(false);
  });

  it.each(CASES)("renders nothing with fixed positioning in the $state state", async (testCase) => {
    if (testCase.syncing) useAccountSyncStore.setState({ syncing: true });
    if (testCase.offline) vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    const { container } = await show("en", testCase.replicas);
    const everything = [...container.querySelectorAll<HTMLElement>("*")];
    expect(everything.length).toBeGreaterThan(0);
    for (const element of everything) {
      expect(element.classList.contains("fixed")).toBe(false);
      expect(element.style.position).not.toBe("fixed");
      expect(element.getAttribute("class") ?? "").not.toMatch(/(^|\s)(fixed|sticky)(\s|$)|top-16|left-1\/2/);
    }
  });
});
