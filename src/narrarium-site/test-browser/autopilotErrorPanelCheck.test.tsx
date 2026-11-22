import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutopilotActivity, AutopilotErrorDetail, AutopilotErrorKind } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ runtime: null as unknown as Record<string, ReturnType<typeof vi.fn>>, toast: vi.fn(), save: vi.fn(async () => true) }));

vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: mocks.save }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { ErrorPanel } from "@/components/autopilot/ErrorPanel";
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type AIIntegration } from "@/types/settings";
import { activityOf, seedRun } from "./helpers/autopilotBand";
import { chatModel, compatible } from "./helpers/aiFixtures";
import { assertProvidersClean } from "./helpers/fakeProvider";
import { gateway, type GatewayBehavior } from "./helpers/llmProxyFakes";
import { LOCAL_BOOK, T0, makeRuntime, t } from "./helpers/quickCommands";

const MS = Date.parse(T0);
const at = (seconds: number) => new Date(MS + seconds * 1000).toISOString();

const AZURE = { id: "az", name: "Studio Azure", provider: "azure_openai", endpoint: "https://x.openai.azure.com", apiKey: "k", apiVersion: "2024-10-21", chatModels: [] } as unknown as AIIntegration;
const first = compatible("gw", [chatModel("muse")], { name: "LlmProxy" });
const second = compatible("lm", [chatModel("local")], { name: "LM Studio" });
const KEY = first.integration.apiKey;
const KINDS: AutopilotErrorKind[] = ["network", "auth", "rate_limit", "timeout", "truncated", "refused", "conflict", "budget", "limit", "profile", "config", "provider", "unknown"];
const OFFERED: AutopilotErrorKind[] = ["network", "auth", "timeout", "provider"];

const detailOf = (id: string | undefined, patch: Partial<AutopilotErrorDetail> = {}): AutopilotErrorDetail => ({ endpoint: first.endpoint.base, model: "muse", provider: "openai", ...(id ? { integration: id } : {}), status: 401, attempt: 1, retries: 3, ...patch });

function attempts(count: number, patch: Partial<AutopilotActivity> = {}): AutopilotActivity[] {
  return Array.from({ length: count }, (_, index) => activityOf("write", { id: `try-${index}`, title: "Writing scene 2 of chapter 5 «Scene 2»", chapterNumber: 5, sceneNumber: 2, status: "failed", error: "Connection error.", startedAt: at(index * 40), endedAt: at(index * 40 + 30), ...patch }));
}

interface Failure {
  kind: AutopilotErrorKind;
  detail?: AutopilotErrorDetail;
  integrations?: AIIntegration[];
  host?: "browser" | "server";
}

/** A run that stopped on an error of this kind, at the step of the integration the detail names, with these integrations in the settings of the browser. */
function fail({ kind, detail = detailOf("gw"), integrations = [first.integration], host }: Failure) {
  const log = attempts(1, { errorKind: kind, errorDetail: detail });
  const last = log[log.length - 1];
  seedRun({ status: "error", running: false, activities: log, book: host ? { ...LOCAL_BOOK, autopilotHost: host } : undefined, statePatch: { lastError: { message: "Connection error.", at: last.endedAt as string, task: "write", errorKind: kind, errorDetail: detail } } });
  useSettingsStore.setState((state) => ({ settings: { ...state.settings, aiIntegrations: integrations } }));
}

function serve(behavior: GatewayBehavior = {}, which = first) {
  const provider = gateway(which, behavior);
  vi.stubGlobal("fetch", provider.fetch);
  return provider;
}

const show = () => render(<MemoryRouter><ErrorPanel bookId="book-1" /></MemoryRouter>);
const panel = () => document.querySelector<HTMLElement>("[data-autopilot-error]")!;
const checkOf = (name = "LlmProxy") => within(panel()).queryByRole("button", { name: t("endpoint.checkNamed", { name }) });
const resultOf = () => panel().querySelector<HTMLElement>("[data-endpoint-status]")!;
const click = (button: HTMLElement) => { button.focus(); fireEvent.click(button); };

beforeAll(async () => {
  await loadAutopilotTranslations();
});
beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.runtime = makeRuntime();
  mocks.toast.mockReset();
});
afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
  assertProvidersClean();
});

describe("the check of the connection in the panel of an error", () => {
  it.each(OFFERED)("is offered for a failure that an endpoint that does not answer, or answers badly, can cause, on the integration of the step that failed (%s)", (kind) => {
    fail({ kind });
    show();
    const button = checkOf()!;
    expect(button).toBeInTheDocument();
    expect(button.textContent?.trim()).toBe("Check the connection");
    expect(button.getAttribute("aria-label")!.startsWith("Check the connection"), "the name begins with the words on the button").toBe(true);
    expect(resultOf(), "the line of the result is there from the start, and empty").toBeEmptyDOMElement();
  });

  it.each(KINDS.filter((kind) => !OFFERED.includes(kind)))("is not offered for a failure that has nothing to do with the connection (%s)", (kind) => {
    fail({ kind });
    show();
    expect(checkOf()).not.toBeInTheDocument();
    expect(panel().querySelector("[data-endpoint-status]")).toBeNull();
    expect(within(panel()).queryByRole("link", { name: t("endpoint.open") })).not.toBeInTheDocument();
  });

  const NOT_THERE: Array<[string, Partial<Failure>]> = [
    ["an integration that has no list to ask: Azure OpenAI has none", { integrations: [AZURE], detail: detailOf("az", { provider: "azure_openai" }) }],
    ["an integration this browser does not have: a run on the server may use one that it does not", { integrations: [second.integration] }],
    ["a failure that names no integration", { detail: detailOf(undefined) }],
  ];
  it.each(NOT_THERE)("is not offered for %s", (_why, patch) => {
    fail({ kind: "network", ...patch });
    show();
    expect(within(panel()).queryByRole("button", { name: /^Check the connection/ })).not.toBeInTheDocument();
    expect(within(panel()).queryByRole("link", { name: t("endpoint.open") })).not.toBeInTheDocument();
  });

  it("leads to the integration, opened: the link goes to its card by an address that names it", () => {
    fail({ kind: "auth" });
    show();
    expect(within(panel()).getByRole("link", { name: t("endpoint.open") })).toHaveAttribute("href", "/app/settings/ai-integrations#integration-gw");
    expect(within(panel()).getByRole("link", { name: t("autopilot.failure.actions.integrations") }), "and the way to the list of them is still there").toHaveAttribute("href", "/app/settings/ai-integrations");
  });

  it.each([["en", "Responds in 120 ms · 6 models"], ["it", "Risponde in 120 ms · 6 modelli"]] as const)("says how fast the integration answered and how many models it lists, as the card does (%s)", async (language, expected) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await i18n.changeLanguage(language);
    const gw = serve({ elapse: 120 });
    fail({ kind: "network" });
    show();
    click(checkOf()!);
    await waitFor(() => expect(resultOf()).toHaveAttribute("data-state", "ok"));
    expect(resultOf()).toHaveAttribute("role", "status");
    expect(resultOf().textContent?.trim()).toBe(expected);
    expect(gw.calls.map((call) => call.url)).toEqual([`${first.endpoint.base}/models`]);
    expect(gw.calls[0].headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it.each(["en", "it"] as const)("says what the endpoint answered, and that it could not be reached when it did not answer, with the words of the engine in the details (%s)", async (language) => {
    await i18n.changeLanguage(language);
    fail({ kind: "auth" });
    show();
    serve({ status: 401 });
    click(checkOf()!);
    await waitFor(() => expect(resultOf()).toHaveAttribute("data-state", "error"));
    expect(resultOf().textContent?.trim()).toBe(t("endpoint.result.error", { status: 401, remedy: t("endpoint.remedy.key") }));
    expect(resultOf()).toHaveTextContent(language === "en" ? "Responds with error 401: check the key" : "Risponde con errore 401: controlla la chiave");
    const details = panel().querySelector<HTMLElement>("[data-endpoint-details]")!;
    expect(details.querySelector("p")).toHaveAttribute("lang", "en");
    expect(details.textContent).toContain("HTTP 401");
    const names = Array.from(panel().querySelectorAll("summary")).map((summary) => summary.textContent?.trim());
    expect(names, "no two disclosures of the panel have the same name: the panel has its own technical details, and the check has those of the check").toContain(t("endpoint.checkDetails"));
    expect(new Set(names).size).toBe(names.length);

    serve({ unreachable: true });
    click(checkOf()!);
    await waitFor(() => expect(resultOf().textContent?.trim()).toBe(t("endpoint.result.unreachable", { why: t("endpoint.why") })));
    expect(panel().textContent).not.toContain(KEY);
  });

  it("asks the integration of the step that failed, with its own key, and not another one", async () => {
    const lm = serve({}, second);
    fail({ kind: "network", integrations: [first.integration, second.integration], detail: detailOf("lm") });
    show();
    expect(checkOf("LM Studio")).toBeInTheDocument();
    expect(checkOf("LlmProxy")).not.toBeInTheDocument();
    click(checkOf("LM Studio")!);
    await waitFor(() => expect(resultOf()).toHaveAttribute("data-state", "ok"));
    expect(lm.calls).toHaveLength(1);
    expect(lm.calls[0].url).toBe(`${second.endpoint.base}/models`);
    expect(lm.calls[0].headers.authorization).toBe(`Bearer ${second.integration.apiKey}`);
    expect(within(panel()).getByRole("link", { name: t("endpoint.open") })).toHaveAttribute("href", "/app/settings/ai-integrations#integration-lm");
  });

  it("says that it checks from this browser when the run is on the personal server, which may see the endpoint otherwise, and does not say it for a run in the browser", () => {
    fail({ kind: "network", host: "server" });
    const { unmount } = show();
    expect(within(panel()).getByText(t("endpoint.fromBrowser"))).toBeInTheDocument();
    unmount();
    cleanup();
    fail({ kind: "network", host: "browser" });
    show();
    expect(within(panel()).queryByText(t("endpoint.fromBrowser"))).not.toBeInTheDocument();
  });

  it("forgets the result when another failure comes: it was about the other one", async () => {
    serve();
    fail({ kind: "network" });
    show();
    click(checkOf()!);
    await waitFor(() => expect(resultOf()).toHaveAttribute("data-state", "ok"));
    act(() => fail({ kind: "auth", detail: detailOf("gw", { status: 403 }) }));
    await waitFor(() => expect(panel()).toHaveAttribute("data-kind", "auth"));
    expect(resultOf()).toBeEmptyDOMElement();
    expect(resultOf()).toHaveAttribute("data-state", "idle");
  });

  it("stops asking when the panel goes away", async () => {
    const gw = serve({ hang: true });
    fail({ kind: "timeout" });
    const view = show();
    click(checkOf()!);
    await waitFor(() => expect(gw.calls).toHaveLength(1));
    view.unmount();
    expect(gw.calls[0].signal?.aborted).toBe(true);
  });

  it("is one more status line beside the one of the copied diagnostics, which is not touched, and nothing is announced before the author asks", async () => {
    serve();
    fail({ kind: "network" });
    show();
    const lines = within(panel()).getAllByRole("status");
    expect(lines).toHaveLength(2);
    expect(lines.filter((line) => line.hasAttribute("data-error-copy"))).toHaveLength(1);
    for (const line of lines) expect(line).toBeEmptyDOMElement();
    expect(within(panel()).getAllByRole("alert"), "the alert of the panel is the same one").toHaveLength(1);
    expect(within(within(panel()).getByRole("alert")).queryByRole("status")).not.toBeInTheDocument();
  });

  it("is there while the run waits to try again, as well as when it ended", () => {
    const log = attempts(1, { errorKind: "network", errorDetail: detailOf("gw") });
    seedRun({ status: "running", running: true, activities: log, retry: { at: new Date(MS + 60_000).toISOString(), attempt: 2, retries: 3 } });
    useSettingsStore.setState((state) => ({ settings: { ...state.settings, aiIntegrations: [first.integration] } }));
    show();
    expect(checkOf()).toBeInTheDocument();
  });

  it("does not leave the existing actions of the panel out of the page: retry, integrations and copy are where they were", () => {
    fail({ kind: "network" });
    show();
    expect(within(panel()).getByRole("link", { name: t("autopilot.failure.actions.integrations") })).toBeInTheDocument();
    expect(within(panel()).getByRole("button", { name: t("autopilot.failure.actions.copy") })).toBeInTheDocument();
    expect(within(panel()).getByRole("button", { name: new RegExp(t("autopilot.failure.actions.retry")) })).toBeInTheDocument();
  });
});
