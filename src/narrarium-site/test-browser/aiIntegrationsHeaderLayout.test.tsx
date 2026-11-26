import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/drive/useSettings", () => ({
  useSettings: () => ({ load: async () => undefined, save: async () => undefined, resolveOfflineConflict: async () => undefined, syncStatus: "idle", lastSynced: null }),
}));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: () => undefined }), toast: () => undefined }));

import i18n from "@/i18n";
import { SettingsPage } from "@/pages/SettingsPage";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";

const t = (key: string) => i18n.t(key) as string;

/*
 * jsdom has no layout, so what is checked here is the class that lets the header buttons wrap. The real effect (no horizontal
 * scroll of the app's <main> at 390 px on these three pages) is measured in a headless Chromium run, reported with the change.
 */
describe("the header of the Settings pages at narrow widths", () => {
  vi.setConfig({ testTimeout: 60_000 });
  beforeAll(() => i18n.changeLanguage("en"));
  afterEach(() => {
    cleanup();
    useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  });

  it.each([
    ["/app/settings", false],
    ["/app/settings/ai-integrations", true],
    ["/app/settings/ai-router", true],
  ])("lets the header buttons of %s wrap onto more lines", (path, hasSave) => {
    render(<MemoryRouter initialEntries={[path]}><SettingsPage /></MemoryRouter>);
    const actions = screen.getByRole("button", { name: t("settings.syncFromDrive") }).parentElement as HTMLElement;
    expect(actions).toHaveClass("flex-wrap");
    expect(actions).toContainElement(screen.getByRole("link", { name: t("nav.accountSync") }));
    if (hasSave) expect(actions).toContainElement(screen.getByRole("button", { name: t("settings.save") }));
    else expect(screen.queryByRole("button", { name: t("settings.save") })).not.toBeInTheDocument();
  });
});
