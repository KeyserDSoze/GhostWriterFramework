import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/drive/useSettings", () => ({
  useSettings: () => ({ load: async () => undefined, save: async () => undefined, resolveOfflineConflict: async () => undefined, syncStatus: "idle", lastSynced: null }),
}));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: () => undefined }), toast: () => undefined }));

import i18n from "@/i18n";
import { SettingsPage } from "@/pages/SettingsPage";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type AIIntegration, type AppSettings, type RoutingTarget, type TaskRoute } from "@/types/settings";
import { polyfillRadix } from "./helpers/radix";

const LLM: AIIntegration = {
  id: "llm", name: "LlmProxy", provider: "openai", endpoint: "http://llm.test/v1", apiKey: "k",
  chatModels: [{ id: "m1", name: "muse-big", capabilities: ["default", "autopilot", "director", "copilot", "review", "reader-evaluation"] }],
};
const to = (model: string): RoutingTarget => ({ integrationId: "llm", model });
const route = (primary: RoutingTarget, ...fallbacks: RoutingTarget[]): TaskRoute => ({ primary, fallbacks });
const ROUTES: NonNullable<AppSettings["taskRouting"]> = {
  default: route(to("muse-big")), autopilot: route(to("muse-big")), director: route(to("muse-big")), "reader-evaluation": route(to("muse-big")),
  "reader-evaluation-summary": route(to("muse-big")), review: route(to("muse-big")), "simple-tasks": route(to("muse-big")),
};
const TASKS = ["autopilot", "director", "reader-evaluation", "reader-evaluation-summary", "review", "simple-tasks"];
const scrollIntoView = vi.fn();

async function show(path: string, language: "en" | "it" = "en") {
  await i18n.changeLanguage(language);
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, language }, aiIntegrations: [LLM], defaultWritingIntegrationId: "llm", defaultReviewIntegrationId: "llm", taskRouting: ROUTES } });
  return render(<MemoryRouter initialEntries={[path]}><SettingsPage /></MemoryRouter>);
}

const rowOf = (task: string) => document.getElementById(`router-row-${task}`);

vi.setConfig({ testTimeout: 60_000 });
beforeAll(async () => {
  polyfillRadix();
  await i18n.changeLanguage("en");
});
beforeEach(() => {
  Element.prototype.scrollIntoView = scrollIntoView;
});
afterEach(async () => {
  cleanup();
  scrollIntoView.mockReset();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("the link to one row of the AI Router", () => {
  it("gives every task of the autopilot a row with an id made of its name, and no two rows the same one", async () => {
    await show("/app/settings/ai-router");
    for (const task of TASKS) {
      const row = rowOf(task);
      expect(row, task).not.toBeNull();
      expect(row?.tagName).toBe("TR");
    }
    const ids = Array.from(document.querySelectorAll("[id]")).map((element) => element.id);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index), "duplicate ids").toEqual([]);
  });

  it.each(TASKS)("brings the row of «%s» into view and gives the focus to its first control, where a keyboard or a screen reader starts reading", async (task) => {
    await show(`/app/settings/ai-router#router-row-${task}`);
    await waitFor(() => expect(rowOf(task)!.contains(document.activeElement)).toBe(true));
    expect(document.activeElement?.getAttribute("role")).toBe("combobox");
    expect(document.activeElement).toBe(rowOf(task)!.querySelector("button[role='combobox']"));
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("names the row for whoever follows the link: the control that takes the focus says its task and its tab", async () => {
    await show("/app/settings/ai-router#router-row-director");
    await waitFor(() => expect(rowOf("director")!.contains(document.activeElement)).toBe(true));
    expect(document.activeElement).toHaveAccessibleName(i18n.t("routing.cell.endpoint", { task: i18n.t("routing.task.director"), tab: i18n.t("routing.primary") }));
  });

  it("takes no focus when no address names a row, when it names something else, or when it names a row that is not there", async () => {
    for (const path of ["/app/settings/ai-router", "/app/settings/ai-router#tools-only-not", "/app/settings/ai-router#router-row-nothing-here"]) {
      const view = await show(path);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(Array.from(document.querySelectorAll("tr[id^='router-row-']")).some((row) => row.contains(document.activeElement)), path).toBe(false);
      view.unmount();
    }
    expect(screen.queryByText("never")).toBeNull();
  });
});
