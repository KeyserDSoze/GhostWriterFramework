import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ load: vi.fn(async () => undefined), save: vi.fn(async () => undefined), toast: vi.fn() }));

vi.mock("@/drive/useSettings", () => ({
  useSettings: () => ({ load: mocks.load, save: mocks.save, resolveOfflineConflict: vi.fn(async () => undefined), syncStatus: "idle", lastSynced: null }),
}));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { SettingsPage } from "@/pages/SettingsPage";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, ROUTING_TASKS, type AIIntegration, type AppSettings } from "@/types/settings";

type Language = "en" | "it";
const LANGUAGES: Language[] = ["en", "it"];
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

const AZURE = {
  id: "azure-1",
  name: "Studio Azure",
  provider: "azure_openai",
  endpoint: "https://studio.openai.azure.com",
  apiKey: "azure-key",
  apiVersion: "2024-10-21",
  chatModels: [{ id: "model-1", name: "gpt-4o", capabilities: ["default", "review"] }],
} as AIIntegration;

async function show(path: string, patch: Partial<AppSettings> = {}, language: Language = "en") {
  await i18n.changeLanguage(language);
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, language }, ...patch } });
  return render(<MemoryRouter initialEntries={[path]}><SettingsPage /></MemoryRouter>);
}

const settingsHrefs = () => screen.getAllByRole("link").map((link) => link.getAttribute("href") ?? "").filter((href) => href.startsWith("/app/settings/"));
const link = (name: string) => screen.getByRole("link", { name }) as HTMLAnchorElement;
const heading = (level: number, name: string) => screen.getByRole("heading", { level, name });
const iconOf = (card: Element) => Array.from(card.querySelector("svg")?.classList ?? []).filter((name) => name.startsWith("lucide-")).join(" ");

vi.setConfig({ testTimeout: 30_000 });
beforeAll(() => i18n.changeLanguage("en"));

afterEach(async () => {
  cleanup();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("Settings home", () => {
  it("lists AI Integrations first and AI Router right after it, then the other sections as before, Costs last", async () => {
    await show("/app/settings");
    expect(settingsHrefs()).toEqual([
      "/app/settings/ai-integrations",
      "/app/settings/ai-router",
      "/app/settings/deep-search",
      "/app/settings/tools",
      "/app/settings/github",
      "/app/settings/speech",
      "/app/settings/repository",
      "/app/settings/server",
      "/app/settings/costs",
      "/app/settings/annotations",
    ]);
  });

  it.each(LANGUAGES)("gives the two AI cards their own title and description, and every card its own icon (%s)", async (language) => {
    await show("/app/settings", {}, language);
    const integrations = document.querySelector('a[href="/app/settings/ai-integrations"]') as HTMLElement;
    const router = document.querySelector('a[href="/app/settings/ai-router"]') as HTMLElement;
    expect(within(integrations).getByText(t("settingsSection.aiIntegrationsTitle"))).toBeInTheDocument();
    expect(within(integrations).getByText(t("settingsSection.aiIntegrationsDescription"))).toBeInTheDocument();
    expect(within(router).getByText(t("settingsSection.aiRouterTitle"))).toBeInTheDocument();
    expect(within(router).getByText(t("settingsSection.aiRouterDescription"))).toBeInTheDocument();
    expect(t("settingsSection.aiIntegrationsDescription")).not.toBe(t("settingsSection.aiRouterDescription"));

    const icons = settingsHrefs().map((href) => iconOf(document.querySelector(`a[href="${href}"]`)!));
    expect(icons.every(Boolean)).toBe(true);
    expect(new Set(icons).size).toBe(icons.length);
  });
});

describe("AI Integrations page", () => {
  it.each(LANGUAGES)("holds the providers, default models, currency and add form, and none of the routing (%s)", async (language) => {
    await show("/app/settings/ai-integrations", { aiIntegrations: [AZURE], defaultWritingIntegrationId: AZURE.id, defaultReviewIntegrationId: AZURE.id }, language);

    expect(heading(1, t("settingsSection.aiIntegrationsTitle"))).toBeInTheDocument();
    expect(screen.getByText(t("settingsSection.aiIntegrationsDescription"))).toBeInTheDocument();
    expect(screen.getByText(t("settings.defaultWriting"))).toBeInTheDocument();
    expect(screen.getByText(t("settings.defaultReview"))).toBeInTheDocument();
    expect(screen.getByText(t("settings.costCurrency"))).toBeInTheDocument();
    expect(screen.getByText(t("settings.modelCount", { count: 1 }), { exact: false })).toBeInTheDocument();
    expect(screen.getByDisplayValue("Studio Azure")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("settings.addIntegration") })).toBeInTheDocument();
    expect(link(t("common.back")).getAttribute("href")).toBe("/app/settings");

    expect(screen.queryByText(t("routing.title"))).not.toBeInTheDocument();
    expect(screen.queryByText(t("routing.primary"))).not.toBeInTheDocument();
    expect(screen.queryByText(t("routing.sameBoundaryOnly"))).not.toBeInTheDocument();
  });

  it.each(LANGUAGES)("ends with the next step into AI Router once an integration exists (%s)", async (language) => {
    await show("/app/settings/ai-integrations", { aiIntegrations: [AZURE] }, language);
    const next = link(t("settings.nextRouteTasks"));
    expect(next.getAttribute("href")).toBe("/app/settings/ai-router");
    expect(t("settings.nextRouteTasks")).toContain(t("settingsSection.aiRouterTitle"));
    const add = screen.getByRole("button", { name: t("settings.addIntegration") });
    expect(add.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("offers no next step before the first integration, and still lets the author add one", async () => {
    await show("/app/settings/ai-integrations");
    expect(screen.getByText(t("settings.noIntegrations"))).toBeInTheDocument();
    expect(screen.queryByText(t("settings.defaultWriting"))).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: t("settings.nextRouteTasks") })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("settings.addIntegration") })).toBeDisabled();
  });

  it("keeps adding, editing and removing integrations working", async () => {
    await show("/app/settings/ai-integrations");
    fireEvent.change(screen.getByPlaceholderText("Azure OpenAI"), { target: { value: "Local lab" } });
    fireEvent.click(screen.getByRole("button", { name: t("settings.addIntegration") }));

    const added = useSettingsStore.getState().settings;
    expect(added.aiIntegrations).toHaveLength(1);
    expect(added.aiIntegrations[0]).toMatchObject({ name: "Local lab", provider: "azure_openai" });
    expect(added.defaultWritingIntegrationId).toBe(added.aiIntegrations[0].id);
    expect(added.defaultReviewIntegrationId).toBe(added.aiIntegrations[0].id);
    expect(screen.getByRole("link", { name: t("settings.nextRouteTasks") })).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue("Local lab"), { target: { value: "Renamed lab" } });
    expect(useSettingsStore.getState().settings.aiIntegrations[0].name).toBe("Renamed lab");

    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: t("settings.removeIntegration", { name: "Renamed lab" }) }));
    expect(useSettingsStore.getState().settings.aiIntegrations).toEqual([]);
    expect(screen.queryByRole("link", { name: t("settings.nextRouteTasks") })).not.toBeInTheDocument();
  });

  it("keeps the offline explanation attached to the form", async () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    await show("/app/settings/ai-integrations", { aiIntegrations: [AZURE] });
    expect(document.getElementById("offline-settings-explanation")).not.toBeNull();
    expect(document.querySelector("fieldset")).toHaveAttribute("aria-describedby", "offline-settings-explanation");
  });
});

describe("AI Router page", () => {
  it.each(LANGUAGES)("holds only the routing, with a line and a link to AI Integrations (%s)", async (language) => {
    await show("/app/settings/ai-router", { aiIntegrations: [AZURE] }, language);

    expect(heading(1, t("settingsSection.aiRouterTitle"))).toBeInTheDocument();
    expect(screen.getByText(t("settingsSection.aiRouterDescription"))).toBeInTheDocument();
    expect(screen.getByText(t("routing.title"))).toBeInTheDocument();
    // One table per kind of task (text, speech out, speech in, images), each with its own tabs: the Primary tab is no longer repeated for every task.
    expect(screen.getAllByRole("tab", { name: t("routing.primary") })).toHaveLength(4);
    // The default route is the first row of the text table, named "Default" there.
    for (const task of ROUTING_TASKS) expect(screen.getAllByText(task === "default" ? t("routing.table.defaultRow") : t(`routing.task.${task}`)).length, task).toBeGreaterThan(0);
    expect(screen.getByText(t("routing.sameBoundaryOnly"))).toBeInTheDocument();
    expect(screen.getByText(t("routing.requireAcknowledgement"))).toBeInTheDocument();
    expect(screen.getAllByRole("spinbutton")).toHaveLength(4);

    const source = screen.getByText(t("routing.modelsFromIntegrations"), { exact: false });
    const toIntegrations = within(source).getByRole("link", { name: t("settingsSection.aiIntegrationsTitle") });
    expect(toIntegrations.getAttribute("href")).toBe("/app/settings/ai-integrations");
    expect(screen.queryByText(t("routing.noIntegrationsTitle"))).not.toBeInTheDocument();

    expect(screen.queryByText(t("settings.defaultWriting"))).not.toBeInTheDocument();
    expect(screen.queryByText(t("settings.costCurrency"))).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("settings.addIntegration") })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: t("settings.nextRouteTasks") })).not.toBeInTheDocument();
  });

  it.each(LANGUAGES)("explains that there is nothing to route yet and sends the author to AI Integrations (%s)", async (language) => {
    await show("/app/settings/ai-router", {}, language);

    expect(heading(1, t("settingsSection.aiRouterTitle"))).toBeInTheDocument();
    expect(heading(2, t("routing.noIntegrationsTitle"))).toBeInTheDocument();
    expect(screen.getByText(t("routing.noIntegrationsBody"))).toBeInTheDocument();
    expect(link(t("routing.noIntegrationsAction")).getAttribute("href")).toBe("/app/settings/ai-integrations");
    expect(screen.queryByText(t("routing.title"))).not.toBeInTheDocument();
    expect(screen.queryByText(t("routing.primary"))).not.toBeInTheDocument();
    expect(screen.queryByText(t("routing.modelsFromIntegrations"), { exact: false })).not.toBeInTheDocument();
  });

  it("keeps the fallback disclosure and the execution limits editable", async () => {
    await show("/app/settings/ai-router", { aiIntegrations: [AZURE] });
    // By name: the «Tools only» switch is the first one on the page now, and the two of the privacy of fallbacks follow it in the box of the options.
    const sameBoundary = screen.getByRole("switch", { name: t("routing.sameBoundaryOnly") });
    const acknowledgement = screen.getByRole("switch", { name: t("routing.requireAcknowledgement") });
    fireEvent.click(sameBoundary);
    expect(useSettingsStore.getState().settings.fallbackDisclosure?.sameBoundaryOnly).toBe(true);
    fireEvent.click(acknowledgement);
    expect(useSettingsStore.getState().settings.fallbackDisclosure?.requireAcknowledgement).toBe(true);

    const maxCandidates = screen.getAllByRole("spinbutton")[0];
    fireEvent.change(maxCandidates, { target: { value: "3" } });
    expect(useSettingsStore.getState().settings.routingExecution?.maxCandidates).toBe(3);
  });

  it("keeps the offline explanation attached to the routing", async () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    await show("/app/settings/ai-router", { aiIntegrations: [AZURE] });
    expect(document.getElementById("offline-settings-explanation")).not.toBeNull();
    expect(document.querySelector("fieldset")).toHaveAttribute("aria-describedby", "offline-settings-explanation");
  });
});
