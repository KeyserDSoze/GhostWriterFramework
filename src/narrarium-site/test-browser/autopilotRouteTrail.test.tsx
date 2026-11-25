import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutopilotActivity, AutopilotErrorDetail, AutopilotRouteStep } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ runtime: null as unknown as Record<string, ReturnType<typeof vi.fn>>, toast: vi.fn(), save: vi.fn(async () => true), verified: vi.fn() }));

vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: mocks.save }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));
vi.mock("@/autopilot/serverIdentity", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/autopilot/serverIdentity")>()), verifiedServer: (options: unknown) => mocks.verified(options) }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { ErrorPanel } from "@/components/autopilot/ErrorPanel";
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type AppSettings } from "@/types/settings";
import { activityOf, seedRun } from "./helpers/autopilotBand";
import { CONNECTION, LOCAL_BOOK, T0, makeRuntime } from "./helpers/quickCommands";

// The error panel of a step whose primary failed and whose fallback ran out of time says every candidate of the route, in the order the author wrote it, and not the last one alone; a candidate that the
// plan left out says why; a run on the personal server says that the server holds its own AI configuration, what it holds, and sends the current one on request.

const MS = Date.parse(T0);
const at = (seconds: number) => new Date(MS + seconds * 1000).toISOString();
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

const ASKED = (position: number, name: string, model: string, patch: Partial<AutopilotRouteStep> = {}): AutopilotRouteStep => ({ position, integrationId: `ai-${name.toLowerCase()}`, integrationName: name, provider: "openai", model, outcome: "failed", endpoint: `https://${name.toLowerCase()}.example.test`, ...patch });
const FAILED_FAST = ASKED(0, "Alpha", "alpha-model", { status: 404, durationMs: 212, message: "openai alpha-model: HTTP 404 — The model `alpha-model` does not exist." });
const TIMED_OUT = ASKED(1, "Beta", "beta-model", { outcome: "timeout", timeoutPhase: "total", timeoutMs: 179_800, durationMs: 179_800, routing: true, message: "openai beta-model: request timed out" });
const DETAIL: AutopilotErrorDetail = { endpoint: "https://beta.example.test", model: "beta-model", provider: "openai", integration: "ai-beta", timeoutPhase: "total", timeoutMs: 179_800, route: [FAILED_FAST, TIMED_OUT] };

function failing(detail: AutopilotErrorDetail = DETAIL, kind: "timeout" | "refused" | "unknown" = "timeout", book = LOCAL_BOOK) {
  const message = "openai beta-model: request timed out";
  const log: AutopilotActivity[] = [activityOf("write", { id: "try-0", title: "Writing scene 2 of chapter 5 «Scene 2»", chapterNumber: 5, sceneNumber: 2, status: "failed", error: message, errorKind: kind, errorDetail: detail, startedAt: at(0), endedAt: at(180) })];
  return seedRun({ status: "error", running: false, activities: log, book, statePatch: { lastError: { message, at: log[0].endedAt as string, task: "write", errorKind: kind, errorDetail: detail } } });
}

const panel = () => document.querySelector<HTMLElement>("[data-autopilot-error]") as HTMLElement;
const steps = () => [...panel().querySelectorAll<HTMLElement>("[data-error-route] li")];
const show = () => render(<MemoryRouter><ErrorPanel bookId="book-1" /></MemoryRouter>);

function integrations(...names: string[]): AppSettings["aiIntegrations"] {
  return names.map((name) => ({ id: `ai-${name.toLowerCase()}`, name, provider: "openai", apiKey: "k", endpoint: `https://${name.toLowerCase()}.example.test`, chatModels: [] }) as never);
}

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.runtime = makeRuntime();
  mocks.toast.mockReset();
  mocks.verified.mockReset();
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("the route of a step that failed", () => {
  it("lists every candidate in the order of the route, with its integration by name, its model, how it ended and how long it took", () => {
    failing();
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, aiIntegrations: integrations("Alpha", "Beta") } });
    show();
    expect(steps()).toHaveLength(2);
    expect(steps()[0]).toHaveTextContent("Alpha · alpha-model");
    expect(steps()[0]).toHaveTextContent(t("autopilot.route.outcome.failedStatus", { status: 404 }));
    expect(steps()[0]).toHaveTextContent("212 ms");
    expect(steps()[0]).toHaveTextContent("The model `alpha-model` does not exist.");
    expect(steps()[1]).toHaveTextContent("Beta · beta-model");
    expect(steps()[1]).toHaveTextContent(t("autopilot.route.outcome.timeoutRouting", { time: "179.8 s" }));
    expect(steps().map((step) => step.getAttribute("data-route-step"))).toEqual(["failed", "timeout"]);
  });

  it("names an integration this browser does not have by the name the engine kept, and says no model or integration as the one that failed (the list is where they are)", () => {
    failing();
    show();
    expect(steps()[0]).toHaveTextContent("Alpha · alpha-model");
    const labels = [...panel().querySelectorAll("dt")].map((item) => item.textContent);
    for (const gone of ["model", "provider", "integration", "endpoint"]) expect(labels, gone).not.toContain(t(`autopilot.failure.facts.${gone}`));
  });

  it("says the time of the second attempt was the routing time that was left, which can be raised, and not the limit that cannot be changed", () => {
    failing();
    show();
    const notice = panel().querySelector("[data-error-timeout]") as HTMLElement;
    expect(notice).toHaveAttribute("data-error-timeout-routing");
    expect(notice).toHaveTextContent(t("autopilot.failure.timeout.limitRouting", { time: "179.8 s" }));
    expect(notice).toHaveTextContent("Total routing time");
    expect(notice).not.toHaveTextContent(t("autopilot.failure.timeout.fixed"));
    expect(within(notice).getByRole("link", { name: t("autopilot.failure.timeout.openRouter") })).toHaveAttribute("href", "/app/settings/ai-router");
  });

  it("keeps the old words for the longest one request may take, when no route says the time was the routing's", () => {
    failing({ ...DETAIL, route: [ASKED(0, "Beta", "beta-model", { outcome: "timeout", timeoutPhase: "total", timeoutMs: 14_400_000 })] });
    show();
    const notice = panel().querySelector("[data-error-timeout]") as HTMLElement;
    expect(notice).not.toHaveAttribute("data-error-timeout-routing");
    expect(notice).toHaveTextContent(t("autopilot.failure.timeout.fixed"));
    expect(steps(), "one candidate asked and none left out: the facts say all of it").toHaveLength(0);
  });

  it("says why a candidate was left out, with the figures of its window, beside the candidate that was asked", () => {
    const left: AutopilotRouteStep = { position: 0, integrationId: "ai-alpha", integrationName: "Alpha", provider: "openai", model: "alpha-model", outcome: "left-out", leftOut: "context-window", promptTokens: 150_000, windowTokens: 128_000 };
    failing({ status: 401, endpoint: "https://beta.example.test", model: "beta-model", provider: "openai", integration: "ai-beta", route: [left, ASKED(1, "Beta", "beta-model", { status: 401, durationMs: 90, message: "HTTP 401" })] }, "unknown");
    show();
    expect(steps()).toHaveLength(2);
    expect(steps()[0]).toHaveTextContent("Alpha · alpha-model");
    expect(steps()[0]).toHaveTextContent(t("autopilot.route.leftOut", { reason: t("autopilot.route.reason.context-window", { prompt: "150K", window: "128K" }) }));
    expect(steps()[0].getAttribute("data-route-step")).toBe("left-out");
    expect(steps()[1]).toHaveTextContent(t("autopilot.route.outcome.failedStatus", { status: 401 }));
  });

  it.each([
    ["unusable", { why: "integration-missing" as const }, "autopilot.route.reason.integration-missing"],
    ["unusable", { why: "task-not-allowed" as const }, "autopilot.route.reason.task-not-allowed"],
    ["no-tool-calls", {}, "autopilot.route.reason.no-tool-calls"],
    ["boundary", {}, "autopilot.route.reason.boundary"],
    ["budget", {}, "autopilot.route.reason.budget"],
    ["not-acknowledged", {}, "autopilot.route.reason.not-acknowledged"],
    ["out-of-time", {}, "autopilot.route.reason.out-of-time"],
    ["context-window", {}, "autopilot.route.reason.context-window-unknown"],
  ] as const)("says in words why a candidate was left out for %s %j", (reason, extra, key) => {
    const left: AutopilotRouteStep = { position: 1, integrationId: "ai-beta", integrationName: "Beta", provider: "openai", model: "beta-model", outcome: "left-out", leftOut: reason, ...extra };
    failing({ route: [ASKED(0, "Alpha", "alpha-model", { status: 500 }), left] }, "unknown");
    show();
    expect(steps()[1]).toHaveTextContent(t(key));
  });

  it("is told in Italian as well, with the same figures", async () => {
    await i18n.changeLanguage("it");
    failing();
    show();
    expect(steps()[1]).toHaveTextContent("tempo scaduto: il tempo di routing rimasto è finito");
    expect(panel().querySelector("[data-error-timeout]")).toHaveTextContent("Tempo totale di routing");
  });

  it("is in the text that is copied, with no key and in English", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    failing({ ...DETAIL, route: [{ ...FAILED_FAST, message: "HTTP 404 sk-abcdefghijklmnopqrstuvwxyz0123 was refused" }, TIMED_OUT, { position: 2, integrationId: "ai-gamma", integrationName: "Gamma", provider: "openai", model: "gamma-model", outcome: "left-out", leftOut: "context-window", promptTokens: 9000, windowTokens: 4000 }] });
    show();
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.failure.actions.copy") }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const text = (writeText.mock.calls as unknown as string[][])[0][0];
    expect(text).toContain("Route, in the order of the router:");
    expect(text).toContain("1. Alpha (ai-alpha) alpha-model: failed, HTTP 404, 212 ms");
    expect(text).toContain("2. Beta (ai-beta) beta-model: timed out (total, the routing time that was left, 179800 ms)");
    expect(text).toContain("3. Gamma (ai-gamma) gamma-model: left out, context-window (the prompt is about 9000 tokens, the window leaves about 4000)");
    expect(text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123");
    Reflect.deleteProperty(navigator, "clipboard");
  });
});

describe("a run on the personal server", () => {
  const SERVER_BOOK = { ...LOCAL_BOOK, autopilotHost: "server" as const };
  const STATUS = { configured: true, updatedAt: "2026-11-20T09:30:00.000Z", routedTasks: ["autopilot"], integrations: [{ id: "ai-alpha", name: "Alpha", provider: "openai", hasApiKey: true, models: [] }], taskRouting: { autopilot: { primary: { integrationId: "ai-alpha", model: "alpha-model" }, fallbacks: [] } } };

  function onServer(settings: Partial<AppSettings> = {}) {
    failing(DETAIL, "timeout", SERVER_BOOK);
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, personalServer: CONNECTION, aiIntegrations: [{ id: "ai-alpha", name: "Alpha", provider: "openai", apiKey: "sk-secret-0123456789", endpoint: "https://alpha.example.test", chatModels: [{ id: "m", name: "alpha-model", capabilities: ["default", "autopilot"] }] }] as never, ...settings } });
  }

  it("says that the server holds its own AI configuration, what it holds and since when, and that the router here is not what it uses", async () => {
    mocks.verified.mockResolvedValue({ client: { aiStatus: vi.fn(async () => STATUS), putAiConfig: vi.fn() }, info: {}, fingerprint: "f" });
    onServer({ taskRouting: { autopilot: { primary: { integrationId: "ai-alpha", model: "alpha-model", thinking: "high" }, fallbacks: [] } } });
    show();
    const note = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-server-ai-note]");
      expect(found?.querySelector("[data-server-ai-state]")?.textContent).toContain("1");
      return found as HTMLElement;
    });
    expect(note).toHaveTextContent(t("autopilot.serverAi.title"));
    expect(note).toHaveTextContent(t("autopilot.serverAi.note"));
    expect(note).toHaveTextContent(t("autopilot.serverAi.differs"));
    expect(within(note).getByRole("button", { name: t("autopilot.serverAi.send") })).toBeEnabled();
  });

  it("sends the current AI configuration when asked, and says the server holds it then", async () => {
    const putAiConfig = vi.fn(async () => ({ ...STATUS, updatedAt: "2026-11-25T10:00:00.000Z" }));
    mocks.verified.mockResolvedValue({ client: { aiStatus: vi.fn(async () => STATUS), putAiConfig }, info: {}, fingerprint: "f" });
    onServer();
    show();
    const button = await screen.findByRole("button", { name: t("autopilot.serverAi.send") });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(putAiConfig).toHaveBeenCalledTimes(1));
    const sent = (putAiConfig.mock.calls as unknown as Array<[{ aiIntegrations: Array<{ id: string; apiKey: string }> }]>)[0][0];
    expect(sent.aiIntegrations.map((entry) => entry.id)).toEqual(["ai-alpha"]);
    expect(await screen.findByText(t("autopilot.serverAi.sent"))).toBeInTheDocument();
  });

  it("says when the server did not take it, with its words", async () => {
    mocks.verified.mockResolvedValue({ client: { aiStatus: vi.fn(async () => STATUS), putAiConfig: vi.fn(async () => { throw new Error("The server is read only for this token."); }) }, info: {}, fingerprint: "f" });
    onServer();
    show();
    const button = await screen.findByRole("button", { name: t("autopilot.serverAi.send") });
    await waitFor(() => expect(button).toBeEnabled());
    await act(async () => { fireEvent.click(button); });
    expect(await screen.findByText(t("autopilot.serverAi.failed", { reason: "The server is read only for this token." }))).toBeInTheDocument();
  });

  it("is not there for a run of this browser: it asks with the settings of the tab", () => {
    failing();
    show();
    expect(document.querySelector("[data-server-ai-note]")).toBeNull();
  });
});
