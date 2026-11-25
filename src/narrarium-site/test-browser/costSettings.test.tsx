import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ load: vi.fn(async () => undefined), save: vi.fn(async () => undefined), toast: vi.fn(), verified: vi.fn() }));

vi.mock("@/drive/useSettings", () => ({
  useSettings: () => ({ load: mocks.load, save: mocks.save, resolveOfflineConflict: vi.fn(async () => undefined), syncStatus: "idle", lastSynced: null }),
  saveSettingsNow: vi.fn(async () => true),
}));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));
vi.mock("@/autopilot/serverIdentity", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/autopilot/serverIdentity")>()), verifiedServer: (options: unknown) => mocks.verified(options) }));

import i18n from "@/i18n";
import "@/i18n/costs";
import { formatDate } from "@/autopilot/format";
import { useAutopilotStore } from "@/autopilot/store";
import { SettingsPage } from "@/pages/SettingsPage";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type AppSettings, type BookEntry } from "@/types/settings";
import { chooseOption, polyfillRadix } from "./helpers/radix";
import { CONNECTION } from "./helpers/quickCommands";

type Language = "en" | "it";
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const NOW = "2026-11-21T10:01:26.000Z";
const SERVER_BOOK = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", addedAt: "2026-11-21T00:00:00.000Z", autopilotHost: "server" } as BookEntry;

async function show(patch: Partial<AppSettings> = {}, language: Language = "en") {
  await i18n.changeLanguage(language);
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, language }, ...patch } });
  return render(<MemoryRouter initialEntries={["/app/settings/costs"]}><SettingsPage /></MemoryRouter>);
}

const relabels = () => useSettingsStore.getState().settings.costRelabels;
const recordedAs = () => screen.getByLabelText(t("settings.costRelabels.from"));

beforeAll(() => {
  polyfillRadix();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  mocks.verified.mockReset();
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useAutopilotStore.setState({ server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  await i18n.changeLanguage("en");
});

describe("Settings › Costs", () => {
  it.each(["en", "it"] as const)("is a page of its own with the currency, the exchange rates and the relabelled amounts, and the ways to the prices and the costs (%s)", async (language) => {
    await show({}, language);
    expect(screen.getByRole("heading", { level: 1, name: t("settings.costSettings.title") })).toBeInTheDocument();
    expect(screen.getAllByText(t("settings.costSettings.description")).length).toBeGreaterThan(0);
    expect(screen.getByRole("combobox", { name: t("settings.costCurrency") })).toHaveAccessibleDescription(t("settings.costCurrencyHint"));
    expect(screen.getByRole("group", { name: t("settings.costRelabels.title") })).toHaveAccessibleDescription(t("settings.costRelabels.hint"));
    expect(screen.getByText(t("settings.costRelabels.empty"))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("settingsSection.aiIntegrationsTitle") })).toHaveAttribute("href", "/app/settings/ai-integrations");
    expect(screen.getByRole("link", { name: t("costs.title") })).toHaveAttribute("href", "/app/costs");
  });

  it("relabels the amounts recorded in a currency up to now, lists the relabel, and undoes it: only how they are shown changes", async () => {
    await show({ costCurrency: "EUR" });
    const add = screen.getByRole("button", { name: t("settings.costRelabels.add", { currency: "EUR" }) });
    expect(add, "nothing to relabel yet").toBeDisabled();
    fireEvent.change(recordedAs(), { target: { value: "EUR" } });
    expect(add, "the currency of the settings is not relabelled to itself").toBeDisabled();
    fireEvent.change(recordedAs(), { target: { value: "US" } });
    expect(add, "a code is three letters").toBeDisabled();
    fireEvent.change(recordedAs(), { target: { value: "usd" } });
    expect(add).toBeEnabled();
    fireEvent.click(add);
    expect(relabels()).toEqual([{ from: "USD", to: "EUR", until: NOW }]);
    const row = document.querySelector<HTMLElement>('[data-cost-relabel="USD"]')!;
    expect(row).toHaveTextContent(t("settings.costRelabels.row", { from: "USD", to: "EUR", date: formatDate(NOW) }));
    expect(recordedAs(), "the field is ready for the next one").toHaveValue("");

    fireEvent.click(within(row).getByRole("button", { name: `${t("settings.costRelabels.remove")} — ${t("settings.costRelabels.removeWhich", { from: "USD" })}` }));
    expect(relabels(), "removed, the amounts are shown as recorded").toBeUndefined();
    expect(screen.getByText(t("settings.costRelabels.empty"))).toBeInTheDocument();
  });

  it("adds a relabel with Enter, and keeps one for each recorded currency", async () => {
    await show({ costCurrency: "EUR", costRelabels: [{ from: "USD", to: "EUR", until: "2026-10-01T12:00:00.000Z" }] });
    fireEvent.change(recordedAs(), { target: { value: "GBP" } });
    fireEvent.keyDown(recordedAs(), { key: "Enter" });
    fireEvent.change(recordedAs(), { target: { value: "USD" } });
    fireEvent.keyDown(recordedAs(), { key: "Enter" });
    expect(relabels()).toEqual([{ from: "GBP", to: "EUR", until: NOW }, { from: "USD", to: "EUR", until: NOW }]);
  });

  it("says what a change of the currency changes, and nothing of a server when no book runs on one", async () => {
    await show({ costCurrency: "USD" });
    chooseOption(screen.getByRole("combobox", { name: t("settings.costCurrency") }), /^EUR/);
    expect(useSettingsStore.getState().settings.costCurrency).toBe("EUR");
    expect(screen.getByText(t("settings.costCurrencyChanged", { currency: "EUR" }))).toBeInTheDocument();
    expect(document.querySelector("[data-server-currency-note]")).toBeNull();
  });

  it("offers, when a book runs on the personal server, to send the server the configuration with the new currency: the server prices with the one it was last sent", async () => {
    const putAiConfig = vi.fn(async () => ({ configured: true, updatedAt: NOW }));
    mocks.verified.mockResolvedValue({ client: { putAiConfig }, info: {}, fingerprint: "f" });
    useAutopilotStore.setState({ server: { status: "online", info: null, message: null, books: [], updates: null, connection: CONNECTION } });
    await show({ costCurrency: "USD", books: [SERVER_BOOK], personalServer: CONNECTION });
    chooseOption(screen.getByRole("combobox", { name: t("settings.costCurrency") }), /^EUR/);
    const note = document.querySelector<HTMLElement>("[data-server-currency-note]")!;
    expect(note).toHaveTextContent(t("costs.server.changed", { currency: "EUR" }));
    fireEvent.click(within(note).getByRole("button", { name: t("costs.server.send") }));
    await waitFor(() => expect(putAiConfig).toHaveBeenCalledTimes(1));
    expect((putAiConfig.mock.calls[0] as unknown as [{ costCurrency?: string }])[0].costCurrency).toBe("EUR");
    expect(await within(note).findByText(t("costs.server.sent", { currency: "EUR" }))).toBeInTheDocument();
  });

  it("says why it could not send", async () => {
    mocks.verified.mockRejectedValue(new Error("The server did not prove its identity."));
    useAutopilotStore.setState({ server: { status: "online", info: null, message: null, books: [], updates: null, connection: CONNECTION } });
    await show({ costCurrency: "USD", books: [SERVER_BOOK], personalServer: CONNECTION });
    chooseOption(screen.getByRole("combobox", { name: t("settings.costCurrency") }), /^GBP/);
    const note = document.querySelector<HTMLElement>("[data-server-currency-note]")!;
    fireEvent.click(within(note).getByRole("button", { name: t("costs.server.send") }));
    expect(await within(note).findByText(t("costs.server.failed", { reason: "The server did not prove its identity." }))).toBeInTheDocument();
  });

  it("follows the settings that arrive later without saying anything: only the person's choice does", async () => {
    await show({ costCurrency: "USD" });
    act(() => useSettingsStore.getState().patchSettings({ costCurrency: "GBP" }));
    expect(screen.getByRole("combobox", { name: t("settings.costCurrency") })).toHaveTextContent(/^GBP/);
    expect(screen.queryByText(t("settings.costCurrencyChanged", { currency: "GBP" }))).toBeNull();
  });
});
