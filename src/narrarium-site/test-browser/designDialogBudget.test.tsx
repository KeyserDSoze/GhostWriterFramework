import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runtime: null as unknown as Record<string, ReturnType<typeof vi.fn>> }));

vi.mock("@/autopilot/useBookFiles", () => ({ useBookFiles: () => ({ files: new Map<string, string>(), failed: false }) }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/autopilot/useRunEstimate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/useRunEstimate")>()),
  useRunEstimateSources: () => ({
    sources: {
      book: { read: true, directorFile: true, directorRounds: 2, context: {}, designWritten: false, outline: { entries: 8, lastChapter: 8, words: 800 } },
      ai: { aiIntegrations: [{ id: "cloud", name: "Cloud", provider: "openai", endpoint: "https://api.example.test/v1", apiKey: "sk-secret", chatModels: [{ id: "m1", name: "writer-1", capabilities: ["default"], supportsToolCalls: true, maxInputTokens: 128_000, maxOutputTokens: 16_000, pricing: { inputPerMTok: 2, outputPerMTok: 8 } }] }], defaultWritingIntegrationId: "cloud", costCurrency: "USD" },
      aiFrom: "browser", activities: [], state: null, chapters: null, canonEntries: 0, currency: "USD", language: "en",
    },
    reading: false,
    server: { status: "idle" },
    host: "browser",
  }),
}));

import i18n from "@/i18n";
import "@/i18n/costs";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import DesignDialog from "@/components/outline/studio/DesignDialog";
import { useAutopilotStore } from "@/autopilot/store";
import { useCostsStore } from "@/costs/costsStore";
import { emptyCostsFile } from "@/costs/model";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";

const BOOK = { id: "book-1", name: "The Glass Harbor", owner: "", repo: "", storageMode: "local-only", tokenIndex: null, addedAt: "2026-01-01T00:00:00.000Z" } as BookEntry;

const show = () => render(<MemoryRouter><DesignDialog open onClose={() => undefined} onStarted={() => undefined} book={BOOK} branch="main" structure={undefined} state={null} entries={8} /></MemoryRouter>);

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.runtime = { start: vi.fn(async () => undefined), allowBudgetOverrun: vi.fn(), refresh: vi.fn(async () => null), describeError: vi.fn(String) };
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, costCurrency: "USD", books: [BOOK] } });
  useCostsStore.setState({ file: emptyCostsFile(), persisted: emptyCostsFile() });
});

afterEach(() => {
  cleanup();
  useAutopilotStore.setState({ views: {}, summaries: {} });
});

describe("the design run against the budget", () => {
  it("says nothing without a budget", async () => {
    show();
    await screen.findByRole("dialog");
    await waitFor(() => expect(document.querySelector("[data-review-estimate]")).not.toBeNull());
    expect(document.querySelector("[data-budget-outlook]")).toBeNull();
  });

  it("says at which chapter of the design the money would run out, and starts it past the budgets on the author's word", async () => {
    useSettingsStore.setState((store) => ({ settings: { ...store.settings, costBudgets: { global: { USD: { total: 0.2 } } } } }));
    show();
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.querySelector("[data-budget-outlook]")).not.toBeNull());
    const box = dialog.querySelector<HTMLElement>("[data-budget-outlook]")!;
    expect(box.getAttribute("data-budget-outlook")).toBe("stops");
    expect(box.querySelector("[data-outlook-text]")?.textContent).toMatch(/you have \$0\.20 left in the budget \(All books, in total\): it would stop (at about chapter \d+ of the design|somewhere between chapter \d+ and chapter \d+)\./);
    fireEvent.click(within(box).getByRole("button", { name: "Start anyway" }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledTimes(1));
    expect(mocks.runtime.allowBudgetOverrun).toHaveBeenCalledWith("book-1");
    expect(mocks.runtime.allowBudgetOverrun.mock.invocationCallOrder[0]).toBeLessThan(mocks.runtime.start.mock.invocationCallOrder[0]);
  });

  it("starts as it is, under the cap the budgets give, when the author does not say anyway", async () => {
    useSettingsStore.setState((store) => ({ settings: { ...store.settings, costBudgets: { global: { USD: { total: 0.2 } } } } }));
    show();
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.querySelector("[data-budget-outlook]")).not.toBeNull());
    fireEvent.click(dialog.querySelector("[data-design-start]")!);
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledTimes(1));
    expect(mocks.runtime.allowBudgetOverrun).not.toHaveBeenCalled();
  });
});
