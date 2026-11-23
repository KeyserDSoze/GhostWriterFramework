import { fireEvent, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { DEFAULT_BRIEF, DEFAULT_OPTIONS, type AiIntegrationConfig, type AutopilotActivity } from "narrarium-engine";
import { AutopilotSettingsPage } from "@/pages/AutopilotSettingsPage";
import { useSettingsStore } from "@/store/settingsStore";
import type { AIIntegration, AppSettings } from "@/types/settings";
import { activityOf } from "./autopilotBand";
import { t } from "./quickCommands";

export const ROOT = "/app/books/book-1";
export const SETTINGS = `${ROOT}/autopilot/settings`;

/** The structure of the book the page reads: its chapters, its profiles and its canon. */
export function structureOf(patch: Record<string, unknown> = {}) {
  return {
    title: "The Glass Harbor", language: "en", owner: "local", repo: "book-1", defaultBranch: "main", loadedBranch: "main",
    rootFiles: [{ path: "book.md" }],
    firstClassFiles: [],
    chapters: [],
    ghostwriters: [], readerPersonas: [],
    characters: [], locations: [], factions: [], items: [], timelines: [], secrets: [],
    ...patch,
  };
}

export function Page({ path = SETTINGS }: { path?: string }) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app/books/:bookId/autopilot/settings" element={<AutopilotSettingsPage />} />
        <Route path="/app/books/:bookId/autopilot" element={<p>The live page</p>} />
        <Route path="/app/books/:bookId/director" element={<p>The director page</p>} />
        <Route path="/app/settings/ai-router" element={<p>The AI router</p>} />
        <Route path="/app/settings/ai-integrations" element={<p>The AI integrations</p>} />
        <Route path="/app/settings/server" element={<p>The personal server</p>} />
      </Routes>
    </MemoryRouter>
  );
}

export const region = (key: string) => screen.getByRole("region", { name: t(key) });
export const field = (key: string) => screen.getByLabelText(t(key)) as HTMLInputElement;
/** What a person does: the field gets every keystroke, then loses the focus. */
export function type(input: HTMLInputElement | HTMLTextAreaElement, text: string, blur = true) {
  fireEvent.change(input, { target: { value: text } });
  if (blur) fireEvent.blur(input);
}

/** A cloud model with a window, a limit, a price and tools: the one most tests ask. */
export const CLOUD: AIIntegration = {
  id: "cloud", name: "Cloud", provider: "openai", endpoint: "https://api.example.test/v1", apiKey: "sk-test",
  chatModels: [{ id: "m1", name: "writer-1", capabilities: ["default"], supportsToolCalls: true, maxInputTokens: 128_000, maxOutputTokens: 16_000, pricing: { inputPerMTok: 2, outputPerMTok: 8 } }],
};
/** A model of the owner's own computer: no price, no window declared, no speed until a run measured it. */
export const HOME: AIIntegration = {
  id: "home", name: "Home", provider: "openai", endpoint: "http://127.0.0.1:8080/v1", apiKey: "",
  chatModels: [{ id: "l1", name: "llama-local", capabilities: ["default"], supportsToolCalls: true }],
};

/** An integration with other models: `capabilities` are written as plain strings in the tests. */
export function withModels(base: AIIntegration, chatModels: ReadonlyArray<Record<string, unknown>>): AIIntegration {
  return { ...base, chatModels: chatModels as unknown as AIIntegration["chatModels"] };
}

export function withAi(integrations: AIIntegration[], patch: Partial<AppSettings> = {}): void {
  const settings = useSettingsStore.getState().settings;
  useSettingsStore.setState({
    settings: { ...settings, aiIntegrations: integrations, defaultWritingIntegrationId: integrations[0]?.id ?? "", defaultReviewIntegrationId: integrations[0]?.id ?? "", costCurrency: "EUR", ...patch },
  });
}

/** A step of ten seconds that wrote a thousand tokens: a hundred a second. */
export function measuredStep(task: AutopilotActivity["task"], index: number, patch: Partial<AutopilotActivity> = {}): AutopilotActivity {
  const start = Date.parse("2026-11-20T10:00:00.000Z") + index * 60_000;
  return activityOf(task, { model: "writer-1", usage: { inputTokens: 3000, outputTokens: 1000, cachedInputTokens: 0 }, startedAt: new Date(start).toISOString(), endedAt: new Date(start + 10_000).toISOString(), ...patch });
}

export const stat = (name: string) => document.querySelector(`[data-stat="${name}"]`) as HTMLElement;
export const statValue = (name: string) => stat(name).querySelector("dd") as HTMLElement;
export const FRESH = { brief: DEFAULT_BRIEF, options: DEFAULT_OPTIONS };
export type { AiIntegrationConfig };
