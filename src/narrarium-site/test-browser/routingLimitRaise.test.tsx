import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AiProviderError, AiRoutingBudgetError, type AutopilotErrorDetail } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ runtime: null as unknown as Record<string, ReturnType<typeof vi.fn>>, saveSettingsNow: vi.fn(async () => true) }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/drive/useSettings", async (original) => ({ ...await original<typeof import("@/drive/useSettings")>(), saveSettingsNow: mocks.saveSettingsNow }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { describeAiFailure, routingLimitFailure } from "@/assistant/aiFailure";
import { RoutingExecutionBudgetError } from "@/assistant/routingExecutionBudget";
import { forgetRaise, raiseFor, raiseLimitPatch, raisedLimits, restoredLimits, roundUp, routingBudgetOfError } from "@/assistant/routingLimitRaise";
import { ErrorPanel } from "@/components/autopilot/ErrorPanel";
import { migrateSettingsWithDiagnostics } from "@/drive/cloudSettingsClient";
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { activityOf, seedRun } from "./helpers/autopilotBand";
import { makeRuntime } from "./helpers/quickCommands";

const LIMITS = DEFAULT_SETTINGS.routingExecution;
const t = i18n.t.bind(i18n);

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.runtime = makeRuntime();
  mocks.saveSettingsNow.mockClear();
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, costCurrency: "USD" } });
});

afterEach(async () => {
  cleanup();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("the raise of a routing limit", () => {
  it("rounds up to a number a person would write: 1, 1.5, 2, 2.5, 3, 4, 5, 6 or 8 times a power of ten", () => {
    expect([0.0123, 1, 1.01, 6.1, 7.7, 9.2, 230_000, 287_500, 1_000_001].map(roundUp)).toEqual([0.015, 1, 1.5, 8, 8, 10, 250_000, 300_000, 1_500_000]);
  });

  it("raises the limit that refused to what the call needed with a quarter more room, within the bounds of the settings", () => {
    expect(raiseFor({ limit: "cost", estimated: 6.1, allowed: 5 }, LIMITS)).toEqual({ key: "maxEstimatedCost", from: 5, to: 8, estimated: 6.1 });
    expect(raiseFor({ limit: "tokens", estimated: 230_000, allowed: 200_000 }, LIMITS)).toEqual({ key: "maxTokenAttempts", from: 200_000, to: 300_000, estimated: 230_000 });
    // Up to the most the settings accept, and nothing when even that cannot hold it, or when the limit already holds it.
    expect(raiseFor({ limit: "cost", estimated: 900, allowed: 5 }, LIMITS)).toMatchObject({ to: 1_000 });
    expect(raiseFor({ limit: "cost", estimated: 1_200, allowed: 5 }, LIMITS)).toBeNull();
    expect(raiseFor({ limit: "cost", estimated: 4, allowed: 3 }, LIMITS)).toBeNull();
  });

  it("remembers the value the author had, also across two raises, puts it back, and forgets it when the limit is set by hand", () => {
    const at = new Date("2026-11-27T10:00:00.000Z");
    const once = raisedLimits(LIMITS, { key: "maxEstimatedCost", to: 8 }, at);
    expect(once).toEqual({ ...LIMITS, maxEstimatedCost: 8, raisedFrom: { maxEstimatedCost: 5, at: at.toISOString() } });
    const twice = raisedLimits(once, { key: "maxEstimatedCost", to: 15 }, at);
    expect(twice.raisedFrom).toEqual({ maxEstimatedCost: 5, at: at.toISOString() });
    expect(restoredLimits(twice, "maxEstimatedCost")).toEqual({ ...LIMITS, raisedFrom: undefined });
    expect(forgetRaise(twice, "maxEstimatedCost")).toEqual({ ...twice, raisedFrom: undefined });
    expect(raiseLimitPatch({ routingExecution: LIMITS }, { key: "maxTokenAttempts", to: 300_000 }).routingExecution).toMatchObject({ maxTokenAttempts: 300_000, raisedFrom: { maxTokenAttempts: 200_000 } });
  });

  it("is kept by the settings of the account, and an invalid memory of it is dropped", () => {
    const raisedFrom = { maxEstimatedCost: 5, at: "2026-11-27T10:00:00.000Z" };
    const kept = migrateSettingsWithDiagnostics({ version: 2, books: [], ui: { language: "en" }, routingExecution: { ...LIMITS, maxEstimatedCost: 8, raisedFrom } }).settings;
    expect(kept.routingExecution).toEqual({ ...LIMITS, maxEstimatedCost: 8, raisedFrom });
    const dropped = migrateSettingsWithDiagnostics({ version: 2, books: [], ui: { language: "en" }, routingExecution: { ...LIMITS, raisedFrom: { maxEstimatedCost: "five", at: "never" } } }).settings;
    expect(dropped.routingExecution).toEqual(LIMITS);
  });

  it("reads the numbers of a refusal from either layer, and none from an older one", () => {
    expect(routingBudgetOfError(new RoutingExecutionBudgetError("over", { limit: "cost", estimated: 6.1, allowed: 5 }))).toEqual({ limit: "cost", estimated: 6.1, allowed: 5 });
    expect(routingBudgetOfError(new AiRoutingBudgetError("over", { limit: "tokens", estimated: 230_000, allowed: 200_000 }))).toEqual({ limit: "tokens", estimated: 230_000, allowed: 200_000 });
    expect(routingBudgetOfError(new AiRoutingBudgetError("over"))).toBeNull();
    expect(routingBudgetOfError({ budget: { limit: "cost", estimated: "6" } })).toBeNull();
  });
});

describe("the chat's words for the fallbacks a routing limit left out", () => {
  const settings = { routingExecution: LIMITS, costCurrency: "USD" };
  /** A call whose first model failed, and whose fallbacks the limit kept out: what the router and the engine end with. */
  const failedWith = (budget: { limit: "tokens" | "cost"; estimated: number; allowed: number }) => Object.assign(new AiProviderError("HTTP 503: down. Not tried: …", 503), { budget });

  it("say the failure, which limit kept the fallbacks out, what they needed and the limit, where it is, and offer the raise in one click", () => {
    const reply = describeAiFailure(failedWith({ limit: "cost", estimated: 6.1, allowed: 5 }), t, settings);
    expect(reply?.text).toBe(`HTTP 503: down. Not tried: …\n\n**${t("autopilot.failure.routingLimit.title")}**\n\nThe fallbacks after the first model were not tried: they are estimated at $6.10 together, and the limit of the AI Router is $5.00 (“Maximum estimated route cost”, Settings › AI Router › Routing options).`);
    expect(reply?.action).toEqual({ kind: "raise-routing-limit", key: "maxEstimatedCost", from: 5, to: 8, estimated: 6.1 });
    const tokens = describeAiFailure(failedWith({ limit: "tokens", estimated: 230_000, allowed: 200_000 }), t, settings);
    expect(tokens?.text).toContain("The fallbacks after the first model were not tried: they would use about 230,000 tokens together, and the limit of the AI Router is 200,000 (“Maximum token attempts”");
    expect(tokens?.action).toMatchObject({ key: "maxTokenAttempts", from: 200_000, to: 300_000 });
    // A fallback of speech or images the limits kept out says the same.
    expect(routingLimitFailure(new RoutingExecutionBudgetError("over", { limit: "cost", estimated: 6.1, allowed: 5 }), t, settings)?.action).toMatchObject({ kind: "raise-routing-limit", to: 8 });
  });

  it("say it in Italian", async () => {
    await i18n.changeLanguage("it");
    const reply = describeAiFailure(failedWith({ limit: "cost", estimated: 6.1, allowed: 5 }), t, settings);
    expect(reply?.text).toContain("I fallback dopo il primo modello non sono stati provati: sono stimati a 6,10");
    expect(reply?.text).toContain("Impostazioni › AI Router › Opzioni di instradamento");
  });

  it("link to the limits for the refusal of an older engine or when no value the settings accept would hold them, and are nothing for another failure", () => {
    const older = routingLimitFailure(new AiRoutingBudgetError("No candidate fits the routing limits."), t, settings);
    expect(older?.text).toContain(t("autopilot.failure.routingLimit.refusedTitle"));
    expect(older?.text).toContain(t("autopilot.failure.routingLimit.unknown"));
    expect(older?.text).toContain("> No candidate fits the routing limits.");
    expect(older?.action).toEqual({ kind: "navigate", to: "/app/settings/ai-router#routing-options", label: t("autopilot.failure.routingLimit.open") });
    const huge = describeAiFailure(failedWith({ limit: "cost", estimated: 5_000, allowed: 5 }), t, settings);
    expect(huge?.text).toContain(t("autopilot.failure.routingLimit.tooHigh", { max: "$1,000.00" }));
    expect(huge?.action).toMatchObject({ kind: "navigate" });
    expect(routingLimitFailure(new Error("down"), t, settings)).toBeNull();
    expect(describeAiFailure(new Error("down"), t, settings)).toBeNull();
  });
});

describe("the autopilot's panel for a step whose fallbacks a routing limit left out", () => {
  const BUDGET_DETAIL: AutopilotErrorDetail = { model: "big", provider: "openai", integration: "fake", status: 503, budget: { limit: "cost", estimated: 6.1, allowed: 5 } };

  function failing(kind: "provider" | "budget", detail: AutopilotErrorDetail, message: string) {
    const log = [activityOf("write", { id: "try-0", title: "Writing chapter 2", chapterNumber: 2, status: "failed", error: message, errorKind: kind, errorDetail: detail, startedAt: "2026-11-27T10:00:00.000Z", endedAt: "2026-11-27T10:00:01.000Z" })];
    return seedRun({ status: "error", activities: log, statePatch: { lastError: { message, at: "2026-11-27T10:00:01.000Z", task: "write", errorKind: kind, errorDetail: detail } } });
  }
  const failingOnBudget = (detail: AutopilotErrorDetail = BUDGET_DETAIL) => failing("provider", detail, "HTTP 503: down. Not tried: \"next\" in \"Next\": the fallbacks after the first attempt would be estimated at 6.10 USD together, and the limit is 5.00 USD.");

  const show = () => render(<MemoryRouter><ErrorPanel bookId="book-1" /></MemoryRouter>);
  const notice = () => document.querySelector<HTMLElement>("[data-routing-limit-notice]");

  it("says what the fallbacks needed and the limit, raises the limit in the settings in one click, remembers the old one, and resumes the run", async () => {
    failingOnBudget();
    show();
    expect(within(screen.getByRole("alert")).getByRole("heading", { level: 2 })).toHaveTextContent(t("autopilot.failure.kind.provider.title"));
    expect(notice()).toHaveTextContent("The fallbacks after the first model were not tried: they are estimated at $6.10 together, and the limit of the AI Router is $5.00 (“Maximum estimated route cost”, Settings › AI Router › Routing options).");
    expect(notice()!.querySelector('[data-routing-limit-value="estimated"]')).toHaveTextContent("$6.10");
    expect(notice()!.querySelector('[data-routing-limit-value="allowed"]')).toHaveTextContent("$5.00");
    expect(within(notice()!).getByRole("link", { name: "Open the routing options" })).toHaveAttribute("href", "/app/settings/ai-router#routing-options");
    expect(notice()).toHaveTextContent("The limit is changed in your settings, where you can put it back: it is now $5.00.");
    fireEvent.click(within(notice()!).getByRole("button", { name: "Raise the limit to $8.00 and resume" }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledTimes(1));
    expect(useSettingsStore.getState().settings.routingExecution).toMatchObject({ maxEstimatedCost: 8, raisedFrom: { maxEstimatedCost: 5 } });
    expect(mocks.saveSettingsNow, "saved before the run resumes").toHaveBeenCalledTimes(1);
    expect(notice()!.querySelector("[data-routing-limit-status]")).toHaveTextContent("The limit is now $8.00 (it was $5.00).");
  });

  it("does not offer a raise once the limit holds what the fallbacks needed, says nothing of the limits for a failure that has no budget, and keeps the words of an older engine's refusal", () => {
    failingOnBudget();
    useSettingsStore.setState((state) => ({ settings: { ...state.settings, routingExecution: { ...LIMITS, maxEstimatedCost: 10 } } }));
    const view = show();
    expect(within(notice()!).queryByRole("button", { name: /Raise the limit/ })).toBeNull();
    expect(notice()!.querySelector("[data-routing-limit-holds]")).toHaveTextContent("The limit is now $10.00, which holds it: retry.");
    view.unmount();
    useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [] });
    const { budget: _none, ...plain } = BUDGET_DETAIL;
    failing("provider", plain, "HTTP 503: down.");
    const second = show();
    expect(notice(), "a provider's failure with nothing left out by the limits").toBeNull();
    second.unmount();
    useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [] });
    failing("budget", { model: "big" }, "No candidate fits the routing limits.");
    show();
    expect(within(screen.getByRole("alert")).getByRole("heading", { level: 2 })).toHaveTextContent("Routing limit reached");
    expect(notice()).toHaveTextContent(t("autopilot.failure.routingLimit.unknown"));
    expect(within(notice()!).getByRole("link", { name: "Open the routing options" })).toBeInTheDocument();
  });
});
