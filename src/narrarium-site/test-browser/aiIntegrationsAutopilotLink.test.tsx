import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ book: null as unknown, toast: vi.fn() }));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: { title: "The Glass Harbor", language: "en", chapters: [], readerPersonas: [], loadedBranch: "main" }, loading: false, error: undefined, reload: vi.fn() }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: vi.fn(async () => true) }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));
vi.mock("@/autopilot/loader", () => ({
  loadAutopilotRuntime: async () => ({ refresh: vi.fn(async () => undefined), describeError: (error: unknown) => String(error) }),
}));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AutopilotPage } from "@/pages/AutopilotPage";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type AIIntegration, type BookEntry } from "@/types/settings";

type Language = "en" | "it";
const LANGUAGES: Language[] = ["en", "it"];
const t = (key: string) => i18n.t(key) as string;
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };
const AI = { id: "ai-1", name: "Primary", provider: "openai", endpoint: "https://api.openai.com/v1", apiKey: "sk-test", chatModels: [{ id: "m1", name: "gpt-4o", capabilities: ["default"] }] } as AIIntegration;

async function open(language: Language, aiIntegrations: AIIntegration[]) {
  await i18n.changeLanguage(language);
  mocks.book = { ...BOOK };
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK], aiIntegrations, ui: { ...DEFAULT_SETTINGS.ui, language } } });
  render(
    <MemoryRouter initialEntries={["/app/books/book-1/autopilot"]}>
      <Routes><Route path="/app/books/:bookId/autopilot" element={<AutopilotPage />} /></Routes>
    </MemoryRouter>,
  );
}

vi.setConfig({ testTimeout: 30_000 });

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  cleanup();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("the Autopilot page without an AI model", () => {
  it.each(LANGUAGES)("sends the author to AI Integrations, and says so (%s)", async (language) => {
    await open(language, []);
    const alert = screen.getByText(t("autopilot.errors.aiMissing")).closest('[role="alert"]') as HTMLElement;
    const action = Array.from(alert.querySelectorAll("a")).find((anchor) => anchor.getAttribute("href") === "/app/settings/ai-integrations");
    expect(action).toBeDefined();
    expect(action).toHaveTextContent(t("settingsSection.aiIntegrationsTitle"));
    expect(alert.querySelector('a[href="/app/settings/ai-router"]')).toBeNull();
    expect(t("autopilot.errors.aiMissing")).toContain(t("settingsSection.aiIntegrationsTitle"));
  });

  it("shows no alert once an integration exists", async () => {
    await open("en", [AI]);
    expect(screen.queryByText(t("autopilot.errors.aiMissing"))).not.toBeInTheDocument();
    expect(document.querySelector('a[href="/app/settings/ai-integrations"]')).toBeNull();
  });
});
