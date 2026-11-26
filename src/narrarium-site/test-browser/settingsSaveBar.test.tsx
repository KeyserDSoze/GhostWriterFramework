import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  load: vi.fn(async () => undefined),
  save: vi.fn(async () => true),
}));

vi.mock("@/drive/useSettings", () => ({
  useSettings: () => ({ load: mocks.load, save: mocks.save, resolveOfflineConflict: async () => undefined, syncStatus: "idle", lastSynced: null }),
}));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: () => undefined }), toast: () => undefined }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => ({ reconnectServer: () => undefined }) }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { SettingsPage } from "@/pages/SettingsPage";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";

// G13 of the review: on a phone the Save of Settings → Personal server (and of the other pages of the settings) was at the top of the page, off
// the screen once the author had scrolled to the field they changed. A bar at the bottom of the window brings it back, only while there is
// something to save, saying in words whether the changes are saved; it keeps its room at the bottom, so that it never covers a field.

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

function page(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <main><SettingsPage /></main>
    </MemoryRouter>,
  );
}
const bar = () => screen.queryByRole("group", { name: t("settingsBar.label") });
const reserve = () => document.documentElement.style.getPropertyValue("--bottom-reserve");
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const urlField = () => screen.getByLabelText(t("personalServer.url")) as HTMLInputElement;

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  vi.setConfig({ testTimeout: 60_000 });
  mocks.load.mockReset().mockImplementation(async () => undefined);
  mocks.save.mockReset().mockImplementation(async () => true);
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, syncStatus: "idle", offlineConflict: null });
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  document.documentElement.style.removeProperty("--bottom-reserve");
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("the save bar of the settings", () => {
  it("is not there while nothing has changed", async () => {
    page("/app/settings/server");
    await settle();
    expect(urlField()).toBeInTheDocument();
    expect(bar()).toBeNull();
    expect(reserve()).toBe("");
  });

  it("comes up at the bottom as soon as a field changes, says that the changes are not saved, and keeps its room at the bottom", async () => {
    page("/app/settings/server");
    await settle();
    fireEvent.change(urlField(), { target: { value: "http://127.0.0.1:24242" } });
    expect(bar()).not.toBeNull();
    expect(within(bar() as HTMLElement).getByRole("status")).toHaveTextContent(t("settingsBar.unsaved"));
    expect(within(bar() as HTMLElement).getByRole("button", { name: t("common.save") })).toBeEnabled();
    expect(bar()).toHaveClass("fixed", "bottom-0");
    expect(reserve()).not.toBe("");
  });

  it("saves with its button, says so, and then goes away and gives the room back", async () => {
    page("/app/settings/server");
    await settle();
    fireEvent.change(urlField(), { target: { value: "http://127.0.0.1:24242" } });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await act(async () => { fireEvent.click(within(bar() as HTMLElement).getByRole("button", { name: t("common.save") })); });
    await act(async () => { await Promise.resolve(); });
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(within(bar() as HTMLElement).getByRole("status")).toHaveTextContent(t("settingsBar.saved"));
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(bar()).toBeNull();
    expect(reserve()).toBe("");
  });

  it("says when the save failed, and stays", async () => {
    mocks.save.mockImplementation(async () => { throw new Error("disk full"); });
    page("/app/settings/server");
    await settle();
    fireEvent.change(urlField(), { target: { value: "http://127.0.0.1:24242" } });
    await act(async () => { fireEvent.click(within(bar() as HTMLElement).getByRole("button", { name: t("common.save") })); });
    await settle();
    expect(within(bar() as HTMLElement).getByRole("status")).toHaveTextContent(t("settingsBar.failed", { reason: "disk full" }));
  });

  it("goes away when the changes are undone by hand", async () => {
    page("/app/settings/github");
    await settle();
    const token = screen.getByLabelText(t("settings.defaultGithubToken"));
    fireEvent.change(token, { target: { value: "github_pat_1" } });
    expect(bar()).not.toBeNull();
    fireEvent.change(token, { target: { value: "" } });
    expect(bar()).toBeNull();
  });

  it("counts what was loaded from the disk as saved", async () => {
    mocks.load.mockImplementation(async () => {
      useSettingsStore.getState().patchSettings({ defaultGitHubToken: "github_pat_from_disk" });
    });
    page("/app/settings/github");
    await settle();
    expect(bar()).toBeNull();
  });

  it("is not on the first page of the settings, which has nothing to save", async () => {
    useSettingsStore.getState().patchSettings({ defaultGitHubToken: "github_pat_changed" });
    page("/app/settings");
    await settle();
    useSettingsStore.getState().patchSettings({ defaultGitHubToken: "github_pat_changed_again" });
    await settle();
    expect(bar()).toBeNull();
  });

  it("speaks Italian", async () => {
    await i18n.changeLanguage("it");
    page("/app/settings/server");
    await settle();
    fireEvent.change(urlField(), { target: { value: "http://127.0.0.1:24242" } });
    const group = screen.getByRole("group", { name: "Salvataggio delle impostazioni" });
    expect(within(group).getByRole("status")).toHaveTextContent("Modifiche non salvate");
    expect(within(group).getByRole("button", { name: "Salva" })).toBeInTheDocument();
  });
});
