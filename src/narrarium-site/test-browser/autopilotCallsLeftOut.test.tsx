import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AiCallAttempt } from "narrarium-engine";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import TaskCalls from "@/components/autopilot/calls/TaskCalls";
import { provideCallsSources } from "@/autopilot/calls/sourceHook";
import { useCallsView } from "@/components/autopilot/calls/callsView";
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { polyfillRadix } from "./helpers/radix";
import { BOOK, STEP, attemptOf, recordCall, storeAsSource } from "./helpers/aiCalls";

// The record of a call keeps the candidates of the route that it left out beside the attempts that it made: the page says who was asked, in order, and who was not and why. The integration is named by what the
// settings call it, by its provider when this device does not know it, and the primary that was left out is never taken for the model that answered.

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const announce = vi.fn();

beforeAll(async () => {
  polyfillRadix();
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as typeof window.matchMedia;
});

afterEach(async () => {
  cleanup();
  provideCallsSources(null);
  useCallsView.setState({ raw: false, open: {}, live: {}, epoch: 0 });
  useAutopilotStore.setState({ live: {} });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

function View() {
  return (
    <MemoryRouter initialEntries={[`/app/books/${BOOK}/autopilot`]}>
      <TaskCalls bookId={BOOK} activityIds={[STEP]} running={false} announce={announce} />
    </MemoryRouter>
  );
}

const callOf = (seq: number) => document.querySelector<HTMLElement>(`[data-call$="-${String(seq).padStart(4, "0")}"]`) as HTMLElement;
const skipped = (index: number, patch: Record<string, unknown> = {}) => attemptOf(index, { textAttempt: null, outcome: "skipped", durationMs: null, firstByteMs: null, usage: null, usageKnown: null, cost: null, costKnown: null, currency: null, finishReason: null, integrationId: "alpha", model: "alpha-model", skip: { reason: "context-window", promptTokens: 150_000, windowTokens: 128_000 }, ...patch } as never);

describe("a call that left a candidate out", () => {
  it("says who was left out and why, apart from the attempts, and counts only the attempts that were asked", async () => {
    const { store } = storeAsSource();
    await recordCall(store, STEP, {
      texts: ["Whole."],
      attempts: [
        skipped(1),
        attemptOf(2, { integrationId: "beta", model: "beta-model", outcome: "failed", durationMs: 200, textAttempt: null, error: { name: "AiProviderError", message: "HTTP 503 — overloaded", status: 503, transient: true, timedOut: false } }),
        attemptOf(3, { integrationId: "gamma", model: "gamma-model", textAttempt: 1 }),
      ],
    });
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, aiIntegrations: [{ id: "alpha", name: "Alpha" }, { id: "beta", name: "Beta" }, { id: "gamma", name: "Gamma" }] as never } });
    render(<View />);
    await screen.findByText("Whole.");

    const left = callOf(1).querySelectorAll("[data-left-out] li");
    expect(left).toHaveLength(1);
    expect(left[0]).toHaveTextContent("Alpha · alpha-model");
    expect(left[0]).toHaveTextContent(t("autopilot.route.leftOut", { reason: t("autopilot.route.reason.context-window", { prompt: "150K", window: "128K" }) }));

    const failed = callOf(1).querySelectorAll("[data-failed-attempts] li");
    expect(failed, "the candidate that was left out is not an attempt that failed").toHaveLength(1);
    expect(failed[0]).toHaveTextContent("Attempt 2 · Beta · beta-model · failed");
    expect(failed[0]).toHaveTextContent("Error AiProviderError (503): HTTP 503 — overloaded");

    const header = within(callOf(1)).getAllByRole("button")[0];
    expect(header).toHaveTextContent("gamma-model");
    expect(header).toHaveTextContent("2 attempts");
    expect(header).toHaveTextContent("1 candidate left out");
    const facts = Object.fromEntries([...callOf(1).querySelectorAll("dt")].map((term) => [term.textContent, term.nextElementSibling?.textContent]));
    expect(facts.Model, "the model that answered, in the integration that answered").toBe("gamma-model (Gamma)");
  });

  it("names an integration this device does not know by its provider, and a record of an older engine, which says nothing of what it left out, shows no list", async () => {
    const { store } = storeAsSource();
    await recordCall(store, STEP, { texts: ["Whole."], attempts: [attemptOf(1)] });
    render(<View />);
    await screen.findByText("Whole.");
    expect(callOf(1).querySelector("[data-left-out]")).toBeNull();
    const facts = Object.fromEntries([...callOf(1).querySelectorAll("dt")].map((term) => [term.textContent, term.nextElementSibling?.textContent]));
    expect(facts.Model).toBe("gpt-5 (openai)");
  });

  it("says that the window a candidate was left out for is the default one, when the model's own is not set", async () => {
    const { store } = storeAsSource();
    await recordCall(store, STEP, { texts: ["Whole."], attempts: [skipped(1, { skip: { reason: "context-window", promptTokens: 150_000, windowTokens: 118_000, windowDefault: true } }), attemptOf(2, { textAttempt: 1 })] });
    render(<View />);
    await screen.findByText("Whole.");
    expect(callOf(1).querySelector("[data-left-out] li")).toHaveTextContent(t("autopilot.route.leftOut", { reason: t("autopilot.route.reason.context-window-default", { prompt: "150K", window: "118K", assumed: "128K" }) }));
  });

  it("says in the details of a call the window its model was judged by, and whether it is the model's own or the default", async () => {
    const cases: Array<[AiCallAttempt["window"], string | null, string | null]> = [
      [{ tokens: 128_000, source: "default" }, "default", "128K tokens, the default: this model's window is not set in AI Integrations"],
      [{ tokens: 32_000, source: "configured" }, "configured", "32,000 tokens, set in AI Integrations"],
      [undefined, null, null],
    ];
    for (const [window, source, words] of cases) {
      const { store } = storeAsSource();
      await recordCall(store, STEP, { texts: ["Whole."], attempts: [attemptOf(1, window ? { window } : {})] });
      const { unmount } = render(<View />);
      await screen.findByText("Whole.");
      const shown = callOf(1).querySelector<HTMLElement>("[data-call-window]");
      if (source === null) expect(shown, "a record of an older engine says nothing of it").toBeNull();
      else {
        expect(shown).toHaveAttribute("data-call-window", source);
        expect(shown?.textContent).toBe(words);
        expect(shown?.parentElement?.previousElementSibling).toHaveTextContent("Context window");
      }
      unmount();
      provideCallsSources(null);
    }
  });

  it("says why in Italian too", async () => {
    await i18n.changeLanguage("it");
    const { store } = storeAsSource();
    await recordCall(store, STEP, { texts: ["Whole."], attempts: [skipped(1, { skip: { reason: "unusable", why: "integration-missing" } }), attemptOf(2, { textAttempt: 1 })] });
    render(<View />);
    await screen.findByText("Whole.");
    expect(callOf(1).querySelector("[data-left-out] li")).toHaveTextContent("escluso: la sua integrazione non c'è più in Integrazioni AI");
  });
});
