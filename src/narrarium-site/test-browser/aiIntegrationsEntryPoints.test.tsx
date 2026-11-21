import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: vi.fn(async () => undefined) }) }));

import i18n from "@/i18n";
import { BooksPage } from "@/pages/BooksPage";
import { OnboardingDialog } from "@/components/layout/OnboardingDialog";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";

type Language = "en" | "it";
const LANGUAGES: Language[] = ["en", "it"];
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

vi.setConfig({ testTimeout: 30_000 });
beforeAll(() => i18n.changeLanguage("en"));

afterEach(async () => {
  cleanup();
  localStorage.clear();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("the quick start of an empty library", () => {
  it.each(LANGUAGES)("sends step 3 to AI Integrations, where the provider is configured (%s)", async (language) => {
    await i18n.changeLanguage(language);
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [] } });
    render(<MemoryRouter><BooksPage /></MemoryRouter>);

    const action = screen.getByRole("link", { name: t("books.quickStart.aiAction") });
    expect(action.getAttribute("href")).toBe("/app/settings/ai-integrations");
    expect(action).toHaveTextContent(t("settingsSection.aiIntegrationsTitle"));
    expect(screen.getByText(t("books.quickStart.aiBody"))).toHaveTextContent(t("settingsSection.aiIntegrationsTitle"));
    expect(document.querySelector('a[href="/app/settings/ai-router"]')).toBeNull();
  });

  it("keeps the other quick-start steps where they were", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [] } });
    render(<MemoryRouter><BooksPage /></MemoryRouter>);
    expect(screen.getByRole("link", { name: t("books.quickStart.patAction") }).getAttribute("href")).toBe("/app/account-sync");
    expect(screen.getByRole("link", { name: t("books.quickStart.githubAction") }).getAttribute("href")).toBe("/app/books/add");
  });
});

describe("the first-run guide", () => {
  async function openAtAiStep(language: Language) {
    await i18n.changeLanguage(language);
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [] } });
    render(<MemoryRouter initialEntries={["/app/books"]}><OnboardingDialog /><Where /></MemoryRouter>);
    act(() => { window.dispatchEvent(new Event("narrarium:open-onboarding")); });
    for (let step = 0; step < 3; step += 1) fireEvent.click(await screen.findByRole("button", { name: t("onboarding.next") }, { timeout: 10_000 }));
    expect(await screen.findByRole("heading", { name: t("onboarding.steps.3.title") }, { timeout: 10_000 })).toBeInTheDocument();
  }

  it.each(LANGUAGES)("opens AI Integrations from the AI step, and names it on the button (%s)", async (language) => {
    await openAtAiStep(language);
    const action = screen.getByRole("button", { name: t("onboarding.steps.3.action") });
    expect(action).toHaveTextContent(t("settingsSection.aiIntegrationsTitle"));
    expect(screen.getByText(t("onboarding.steps.3.body"))).toHaveTextContent(t("settingsSection.aiRouterTitle"));
    fireEvent.click(action);
    expect(screen.getByTestId("where")).toHaveTextContent("/app/settings/ai-integrations");
  });
});
