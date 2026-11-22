import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/drive/useSettings", () => ({
  useSettings: () => ({ load: async () => undefined, save: async () => undefined, resolveOfflineConflict: async () => undefined, syncStatus: "idle", lastSynced: null }),
}));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: () => undefined }), toast: () => undefined }));

import i18n from "@/i18n";
import { SettingsPage } from "@/pages/SettingsPage";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type AIIntegration, type AppSettings, type RoutingTarget, type TaskRoute } from "@/types/settings";
import { polyfillRadix } from "./helpers/radix";

type Language = "en" | "it";
const LANGUAGES: Language[] = ["en", "it"];
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

const LLM: AIIntegration = {
  id: "llm", name: "LlmProxy", provider: "openai", endpoint: "http://llm.test/v1", apiKey: "k",
  chatModels: [
    { id: "m1", name: "muse-big", capabilities: ["default", "autopilot", "director", "copilot", "review", "reader-evaluation"] },
    { id: "m3", name: "legacy", capabilities: ["default", "reader-evaluation", "copilot"], supportsToolCalls: false },
  ],
};
const to = (model: string): RoutingTarget => ({ integrationId: "llm", model });
const route = (primary: RoutingTarget, ...fallbacks: RoutingTarget[]): TaskRoute => ({ primary, fallbacks });

const OK: NonNullable<AppSettings["taskRouting"]> = {
  default: route(to("muse-big")),
  autopilot: route(to("muse-big")),
  director: route(to("muse-big")),
  "reader-evaluation": route(to("muse-big")),
  "reader-evaluation-summary": route(to("muse-big")),
  review: route(to("muse-big")),
  "simple-tasks": route(to("muse-big")),
};

async function show(language: Language = "en", patch: Partial<AppSettings> = {}, path = "/app/settings/ai-router") {
  await i18n.changeLanguage(language);
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, language }, aiIntegrations: [LLM], defaultWritingIntegrationId: "llm", defaultReviewIntegrationId: "llm", taskRouting: OK, ...patch },
  });
  return render(<MemoryRouter initialEntries={[path]}><SettingsPage /></MemoryRouter>);
}

const toolsOnly = () => screen.getByRole("switch", { name: t("routing.toolsOnly.label") });
const stored = () => useSettingsStore.getState().settings.aiToolsOnly;
const optionsBox = () => screen.getByText(t("routing.options.title")).closest("details") as HTMLDetailsElement;
const taskName = (task: string) => t(`routing.task.${task}`);

vi.setConfig({ testTimeout: 60_000 });
beforeAll(async () => {
  polyfillRadix();
  await i18n.changeLanguage("en");
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("the «Tools only» switch of the AI Router", () => {
  it.each(LANGUAGES)("is at the top of the page, before the options and the tables, and not inside the options: it is the choice that matters most (%s)", async (language) => {
    await show(language);
    const control = toolsOnly();
    expect(optionsBox()).not.toContainElement(control);
    expect(control.compareDocumentPosition(optionsBox()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(control.compareDocumentPosition(screen.getAllByRole("table")[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(control.compareDocumentPosition(screen.getAllByRole("tablist")[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("says in the words of the design what it does, in both languages", async () => {
    await show("it");
    expect(t("routing.toolsOnly.label")).toBe("Solo tool per l'autopilot");
    expect(t("routing.toolsOnly.hint")).toBe("Ogni agente (scrittore, direttore, lettori, specialisti, riassunti) risponde chiamando la propria funzione; i modelli senza tool call vengono saltati e una risposta in testo al posto della chiamata viene rifiutata.");
    cleanup();
    await show("en");
    expect(t("routing.toolsOnly.label")).toBe("Tools only for the autopilot");
    expect(t("routing.toolsOnly.hint")).toMatch(/^Every agent \(writer, director, readers, specialists, summaries\) answers by calling its own function; models without tool calls are skipped, and a reply in text instead of the call is refused\.$/);
  });

  it.each(LANGUAGES)("is described by that hint, so that a screen reader says it with the switch (%s)", async (language) => {
    await show(language);
    const control = toolsOnly();
    const hintId = control.getAttribute("aria-describedby") ?? "";
    expect(hintId).not.toBe("");
    expect(document.getElementById(hintId)).toHaveTextContent(t("routing.toolsOnly.hint"));
    expect(control).toHaveAttribute("id", "tools-only");
  });

  it("is on when the settings say nothing, which is what the engine does", async () => {
    await show("en");
    expect(stored()).toBeUndefined();
    expect(toolsOnly()).toBeChecked();
  });

  it("is off when the settings say so", async () => {
    await show("en", { aiToolsOnly: false });
    expect(toolsOnly()).not.toBeChecked();
  });

  it("stores a boolean each time it is switched, never a missing value: a missing value is lost when two devices merge their settings", async () => {
    await show("en");
    fireEvent.click(toolsOnly());
    expect(stored()).toBe(false);
    expect(toolsOnly()).not.toBeChecked();
    fireEvent.click(toolsOnly());
    expect(stored()).toBe(true);
    expect(toolsOnly()).toBeChecked();
  });

  it("is where the keyboard goes first when a link names it: the deep link «#tools-only» scrolls to it and focuses it", async () => {
    await show("en", {}, "/app/settings/ai-router#tools-only");
    await waitFor(() => expect(toolsOnly()).toHaveFocus());
  });

  it("does not take the focus when no link names it", async () => {
    await show("en");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(toolsOnly()).not.toHaveFocus();
  });
});

describe("what it says about the models without tool calls", () => {
  const WARNING = () => document.querySelector<HTMLElement>("[data-tools-only-notes]");

  it.each(LANGUAGES)("says nothing when every task has a model that can call functions (%s)", async (language) => {
    await show(language);
    expect(WARNING()).not.toBeNull();
    expect(WARNING()).toBeEmptyDOMElement();
  });

  it.each(LANGUAGES)("names the task that has no model that can: the autopilot would stop on it, and here is what to do (%s)", async (language) => {
    await show(language, { taskRouting: { ...OK, "reader-evaluation": route(to("legacy")) } });
    const notes = WARNING() as HTMLElement;
    expect(notes).toHaveTextContent(t("routing.toolsOnly.blocked", { count: 1, tasks: taskName("reader-evaluation") }));
    expect(notes).toHaveTextContent(taskName("reader-evaluation"));
    expect(notes).toHaveTextContent(t("routing.toolsOnly.remedy"));
    expect(t("routing.toolsOnly.remedy")).toContain(language === "en" ? "Forced tool calls" : "Tool call forzati");
  });

  it("says which models are skipped when the task has another that can call functions: nothing stops", async () => {
    await show("en", { taskRouting: { ...OK, "reader-evaluation": route(to("legacy"), to("muse-big")) } });
    const notes = WARNING() as HTMLElement;
    expect(notes).toHaveTextContent("legacy");
    expect(notes).toHaveTextContent(taskName("reader-evaluation"));
    expect(notes).not.toHaveTextContent(t("routing.toolsOnly.blocked", { count: 1, tasks: taskName("reader-evaluation") }));
  });

  it("is quiet while «Tools only» is off, whatever the models are: they are asked as they always were", async () => {
    await show("en", { aiToolsOnly: false, taskRouting: { ...OK, "reader-evaluation": route(to("legacy")) } });
    expect(WARNING()).toBeEmptyDOMElement();
  });

  it("follows the switch: turning it off clears the warning, turning it on brings it back", async () => {
    await show("en", { taskRouting: { ...OK, "reader-evaluation": route(to("legacy")) } });
    expect(WARNING()).not.toBeEmptyDOMElement();
    fireEvent.click(toolsOnly());
    expect(WARNING()).toBeEmptyDOMElement();
    fireEvent.click(toolsOnly());
    expect(WARNING()).not.toBeEmptyDOMElement();
  });

  it("is one status, so that a change is told once and no timer talks: the warnings are not a live region of their own that repeats", async () => {
    await show("en", { taskRouting: { ...OK, "reader-evaluation": route(to("legacy")) } });
    const notes = WARNING() as HTMLElement;
    expect(notes.getAttribute("role")).toBe("status");
    expect(notes.querySelectorAll("[aria-live], [role=alert], [role=status]")).toHaveLength(0);
  });

  it("does not warn about the tasks of the Copilot: the switch is the autopilot's, and the Copilot has its own way of asking", async () => {
    await show("en", { taskRouting: { ...OK, copilot: route(to("legacy")) } });
    expect(WARNING()).toBeEmptyDOMElement();
    const copilotRow = screen.getByRole("combobox", { name: t("routing.cell.model", { task: taskName("copilot"), tab: t("routing.primary") }) }).closest("tr") as HTMLElement;
    expect(within(copilotRow).queryByText(t("routing.warn.structuredSteps"))).not.toBeInTheDocument();
  });
});
