import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider, type RouteObject } from "react-router-dom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), toast: vi.fn() }));

vi.mock("@/drive/useSettings", () => ({
  useSettings: () => ({ load: mocks.load, save: mocks.save, resolveOfflineConflict: vi.fn(), syncStatus: "idle", lastSynced: null }),
}));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { router } from "@/router";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

function findRoute(routes: RouteObject[], path: string): RouteObject | undefined {
  for (const route of routes) {
    if (route.path === path) return route;
    const nested = route.children ? findRoute(route.children, path) : undefined;
    if (nested) return nested;
  }
  return undefined;
}

/** The two real AI settings routes, inside a layout with the app's scrolling <main>. */
function mountAiSettings(initial: string) {
  const routes: RouteObject[] = [{
    path: "/app",
    Component: () => <main data-testid="main"><Outlet /></main>,
    children: ["settings/ai-integrations", "settings/ai-router"].map((path) => ({ path, lazy: findRoute(router.routes as RouteObject[], path)!.lazy })),
  }];
  render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: [initial] })} />);
}

const SLOW = 30_000;
const h1 = (name: string) => screen.findByRole("heading", { level: 1, name }, { timeout: SLOW });

beforeAll(async () => {
  await import("@/pages/SettingsPage");
  await i18n.changeLanguage("en");
}, SLOW);

beforeEach(() => {
  // What the local account store holds: nothing configured, as the real load() would restore on a remount.
  mocks.load.mockReset().mockImplementation(async () => { useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } }); });
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } });
});

afterEach(() => {
  cleanup();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
});

afterAll(() => router.dispose());

describe("moving between AI Integrations and AI Router", () => {
  it("keeps an integration that has not been saved yet, and does not reload the settings from disk", async () => {
    mountAiSettings("/app/settings/ai-integrations");
    await h1(t("settingsSection.aiIntegrationsTitle"));
    expect(mocks.load).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByPlaceholderText("Azure OpenAI"), { target: { value: "Studio Azure" } });
    fireEvent.click(screen.getByRole("button", { name: t("settings.addIntegration") }));
    expect(useSettingsStore.getState().settings.aiIntegrations).toHaveLength(1);

    fireEvent.click(screen.getByRole("link", { name: t("settings.nextRouteTasks") }));
    await h1(t("settingsSection.aiRouterTitle"));
    expect(screen.getByText(t("routing.title"))).toBeInTheDocument();
    expect(screen.queryByText(t("routing.noIntegrationsTitle"))).not.toBeInTheDocument();
    expect(useSettingsStore.getState().settings.aiIntegrations).toHaveLength(1);

    fireEvent.click(screen.getByRole("link", { name: t("settingsSection.aiIntegrationsTitle") }));
    await h1(t("settingsSection.aiIntegrationsTitle"));
    expect(screen.getByDisplayValue("Studio Azure")).toBeInTheDocument();
    expect(mocks.load).toHaveBeenCalledTimes(1);
  }, SLOW);

  it("shows each page from its top, because the links sit at the bottom of long pages", async () => {
    mountAiSettings("/app/settings/ai-integrations");
    await h1(t("settingsSection.aiIntegrationsTitle"));
    const main = screen.getByTestId("main");
    const scrollTo = vi.fn();
    main.scrollTo = scrollTo as unknown as typeof main.scrollTo;

    fireEvent.change(screen.getByPlaceholderText("Azure OpenAI"), { target: { value: "Studio Azure" } });
    fireEvent.click(screen.getByRole("button", { name: t("settings.addIntegration") }));
    scrollTo.mockClear();

    fireEvent.click(screen.getByRole("link", { name: t("settings.nextRouteTasks") }));
    await h1(t("settingsSection.aiRouterTitle"));
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });

    scrollTo.mockClear();
    fireEvent.click(screen.getByRole("link", { name: t("settingsSection.aiIntegrationsTitle") }));
    await h1(t("settingsSection.aiIntegrationsTitle"));
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
  }, SLOW);

  it("starts each page with its own sections open, whatever was collapsed on the other one", async () => {
    mountAiSettings("/app/settings/ai-integrations");
    await h1(t("settingsSection.aiIntegrationsTitle"));
    fireEvent.change(screen.getByPlaceholderText("Azure OpenAI"), { target: { value: "Studio Azure" } });
    fireEvent.click(screen.getByRole("button", { name: t("settings.addIntegration") }));
    const own = screen.getByText(t("settings.aiIntegrations")).closest("details") as HTMLDetailsElement;
    own.open = false;

    fireEvent.click(screen.getByRole("link", { name: t("settings.nextRouteTasks") }));
    await h1(t("settingsSection.aiRouterTitle"));
    expect((screen.getByText(t("routing.title")).closest("details") as HTMLDetailsElement).open).toBe(true);
  }, SLOW);
});
