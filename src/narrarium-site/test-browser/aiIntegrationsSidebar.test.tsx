import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { MobileSidebar, Sidebar } from "@/components/layout/Sidebar";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";
import { DEFAULT_SETTINGS } from "@/types/settings";

type Language = "en" | "it";
const LANGUAGES: Language[] = ["en", "it"];
const t = (key: string) => i18n.t(key) as string;

const SETTINGS_ENTRIES = [
  "/app/settings",
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
];

async function open(menu: "desktop" | "mobile", path: string, language: Language = "en") {
  await i18n.changeLanguage(language);
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, language } } });
  const Menu = menu === "desktop" ? Sidebar : MobileSidebar;
  return render(<MemoryRouter initialEntries={[path]}><Menu /></MemoryRouter>);
}

const settingsLinks = () => screen.getAllByRole("link").filter((link) => (link.getAttribute("href") ?? "").startsWith("/app/settings"));
const linkTo = (href: string) => settingsLinks().find((link) => link.getAttribute("href") === href)!;

vi.setConfig({ testTimeout: 60_000 });
beforeAll(() => i18n.changeLanguage("en"));

afterEach(async () => {
  cleanup();
  useUiStore.setState({ sidebarCollapsed: false });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe.each(["desktop", "mobile"] as const)("the %s settings menu", (menu) => {
  it("lists AI Integrations and, right after it, AI Router, before the other sections", async () => {
    await open(menu, "/app/settings");
    expect(settingsLinks().map((link) => link.getAttribute("href"))).toEqual(SETTINGS_ENTRIES);
  });

  it.each(LANGUAGES)("labels the two entries with their own names and icons (%s)", async (language) => {
    await open(menu, "/app/settings", language);
    const integrations = linkTo("/app/settings/ai-integrations");
    const router = linkTo("/app/settings/ai-router");
    expect(integrations).toHaveTextContent(t("settingsSection.aiIntegrationsTitle"));
    expect(router).toHaveTextContent(t("settingsSection.aiRouterTitle"));
    expect(t("settingsSection.aiIntegrationsTitle")).not.toBe(t("settingsSection.aiRouterTitle"));

    const icons = settingsLinks().map((link) => Array.from(link.querySelector("svg")?.classList ?? []).filter((name) => name.startsWith("lucide-")).join(" "));
    expect(icons.every(Boolean)).toBe(true);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it.each(["/app/settings/ai-integrations", "/app/settings/ai-router"])("highlights only the entry of the page being shown (%s)", async (path) => {
    await open(menu, path);
    for (const href of SETTINGS_ENTRIES) {
      if (href === path) expect(linkTo(href)).toHaveClass("bg-primary");
      else expect(linkTo(href)).not.toHaveClass("bg-primary");
    }
  });
});
