import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AiProviderError, type AiErrorBody, type AutopilotActivity, type AutopilotErrorDetail, type AutopilotRouteStep } from "narrarium-engine";

vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => ({}) }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import "@/i18n/debugAttempt";
import { ErrorPanel } from "@/components/autopilot/ErrorPanel";
import { RouteTrail } from "@/components/autopilot/RouteTrail";
import TaskCalls from "@/components/autopilot/calls/TaskCalls";
import { describeAiFailure } from "@/assistant/aiFailure";
import { CompletionFallbackError } from "@/assistant/completionFallback";
import { provideCallsSources } from "@/autopilot/calls/sourceHook";
import { useCallsView } from "@/components/autopilot/calls/callsView";
import { diagnosticsText, failureSource } from "@/autopilot/errorModel";
import { providerRows } from "@/autopilot/providerWords";
import { useAutopilotStore } from "@/autopilot/store";
import { attemptBadges } from "@/debug/attemptBadges";
import { redactLlmDebugEntry, type LlmDebugEntry } from "@/debug/llmDebugStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { activityOf, seedRun } from "./helpers/autopilotBand";
import { polyfillRadix } from "./helpers/radix";
import { BOOK, STEP, attemptOf, recordCall, storeAsSource } from "./helpers/aiCalls";

// What a provider answers when it refuses a request is shown in its own words and as labelled fields (Message, Type, Param, Code, HTTP status), wherever a failure is told: the panel of the autopilot, its
// copied diagnostics, the trail of the router, the records of the calls, the debug panel and the Copilot. A body with no structure is shown as it is, one with nothing in it says so, and no key is ever in it.

const MESSAGE = "Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.";
const OWNER: AiErrorBody = { status: 400, shape: "openai", message: MESSAGE, type: "invalid_request_error", param: "reasoning_effort" };
const LINE = `openai gpt-6-luna: HTTP 400 — ${MESSAGE} [type: invalid_request_error, param: reasoning_effort]`;
const DETAIL: AutopilotErrorDetail = { endpoint: "https://gw.example.test", model: "gpt-6-luna", provider: "openai", integration: "gw", status: 400, body: OWNER };

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

/** A run that stopped on an error with this detail, the way the page and the panel read it. */
function failing(detail: AutopilotErrorDetail, message = LINE) {
  const step = activityOf("write", { id: "try-0", title: "Writing scene 2 of chapter 5", chapterNumber: 5, sceneNumber: 2, status: "failed", error: message, errorKind: "provider", errorDetail: detail, startedAt: "2026-11-25T10:00:00.000Z", endedAt: "2026-11-25T10:00:05.000Z" });
  return seedRun({ status: "error", running: false, activities: [step as AutopilotActivity], statePatch: { lastError: { message, at: "2026-11-25T10:00:05.000Z", task: "write", errorKind: "provider", errorDetail: detail } } });
}

const show = () => render(<MemoryRouter><ErrorPanel bookId="book-1" /></MemoryRouter>);
const provider = () => document.querySelector<HTMLElement>("[data-error-provider]");
const field = (name: string) => provider()?.querySelector<HTMLElement>(`[data-provider-field="${name}"]`);
const valueOf = (name: string) => field(name)?.nextElementSibling as HTMLElement | undefined;

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
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  Reflect.deleteProperty(navigator, "clipboard");
  await i18n.changeLanguage("en");
});

describe("the panel of the autopilot", () => {
  it("says what the provider answered as labelled fields in its own words, with the HTTP status among the facts, and no code where the provider had none", () => {
    failing(DETAIL);
    show();
    expect(provider()).not.toBeNull();
    expect(within(provider() as HTMLElement).getByText("What the provider said")).toBeInTheDocument();
    expect(field("message")).toHaveTextContent("Message");
    expect(valueOf("message")).toHaveTextContent(MESSAGE);
    expect(valueOf("message")?.textContent, "the words as the provider wrote them").toBe(MESSAGE);
    expect(valueOf("type")?.textContent).toBe("invalid_request_error");
    expect(valueOf("param")?.textContent).toBe("reasoning_effort");
    expect(field("code")).toBeNull();
    const status = within(document.querySelector("[data-error-facts]") as HTMLElement).getByText("HTTP status", { selector: "dt" }).nextElementSibling;
    expect(status).toHaveTextContent("400");
  });

  it("says it in Italian, with the provider's words as they are", async () => {
    await i18n.changeLanguage("it");
    failing({ ...DETAIL, body: { ...OWNER, code: "unsupported_combination" } });
    show();
    expect(within(provider() as HTMLElement).getByText("Cosa ha detto il provider")).toBeInTheDocument();
    expect(field("message")).toHaveTextContent("Messaggio");
    expect(field("type")).toHaveTextContent("Tipo");
    expect(field("param")).toHaveTextContent("Parametro");
    expect(field("code")).toHaveTextContent("Codice");
    expect(valueOf("code")?.textContent).toBe("unsupported_combination");
    expect(valueOf("message")?.textContent).toBe(MESSAGE);
    const status = within(document.querySelector("[data-error-facts]") as HTMLElement).getByText("Stato HTTP", { selector: "dt" }).nextElementSibling;
    expect(status).toHaveTextContent("400");
  });

  it.each([
    ["a text that is no known shape", { status: 400, shape: "text", raw: "upstream connect error or disconnect/reset before headers" } satisfies AiErrorBody, "Reply", "upstream connect error or disconnect/reset before headers"],
    ["the page of a gateway", { status: 502, shape: "html", message: "an HTML page from a gateway or a proxy (\"502 Bad Gateway\"), not an answer of the provider", raw: "<html><title>502 Bad Gateway</title><body>nginx</body></html>" } satisfies AiErrorBody, "Reply", "A web page from a gateway or a proxy, not an answer of the provider."],
    ["a response with no body", { status: 400, shape: "empty" } satisfies AiErrorBody, "Reply", "No body: the provider sent nothing but the status."],
  ])("shows %s as it is, never as the labelled fields it does not have", (_name, body, label, words) => {
    failing({ ...DETAIL, status: body.status, body });
    show();
    expect(field("reply")).toHaveTextContent(label);
    expect(valueOf("reply")).toHaveTextContent(words);
    expect(field("message")).toBeNull();
    expect(field("type")).toBeNull();
  });

  it("shows the page of a gateway with its content under it, kept as it is", () => {
    failing({ ...DETAIL, status: 502, body: { status: 502, shape: "html", message: "x", raw: "<html><title>502 Bad Gateway</title><body>nginx</body></html>" } });
    show();
    expect(field("raw")).toHaveTextContent("Content");
    expect(valueOf("raw")?.textContent).toBe("<html><title>502 Bad Gateway</title><body>nginx</body></html>");
  });

  it("shows a long message whole, with the ellipsis the engine put where it cut", () => {
    const long = `${"The provider has a lot to say. ".repeat(60)}And then…`;
    failing({ ...DETAIL, body: { ...OWNER, message: long } });
    show();
    expect(valueOf("message")?.textContent).toBe(long);
  });

  it("is not there for a failure the provider did not answer (a connection that broke), and when the route says each candidate's own", () => {
    failing({ endpoint: "https://gw.example.test", model: "gpt-6-luna", provider: "openai", integration: "gw" }, "Connection error.");
    show();
    expect(document.querySelector("[data-autopilot-error]")).not.toBeNull();
    expect(provider()).toBeNull();
    cleanup();
    failing({ ...DETAIL, route: [
      { position: 0, integrationId: "gw", integrationName: "GW", provider: "openai", model: "gpt-6-luna", outcome: "failed", status: 400, body: OWNER },
      { position: 1, integrationId: "gw", integrationName: "GW", provider: "openai", model: "gpt-6.2-sol", outcome: "failed", status: 400, body: { ...OWNER, message: MESSAGE.replace("gpt-6-luna", "gpt-6.2-sol") } },
    ] });
    show();
    expect(provider()).toBeNull();
    expect(document.querySelectorAll("[data-route-step] [data-provider-words]")).toHaveLength(2);
  });
});

describe("the diagnostics that are copied", () => {
  const source = (detail: AutopilotErrorDetail, message = LINE) => failureSource({ status: "error", message, lastError: { message, at: "2026-11-25T10:00:05.000Z", errorKind: "provider", errorDetail: detail } } as never, [])!;
  const text = (detail: AutopilotErrorDetail, message?: string) => diagnosticsText({ source: source(detail, message), appVersion: "0.114.0", engineVersion: "0.1.19", host: "browser", at: new Date("2026-11-25T10:05:00.000Z") });

  it("has the status and the message, the type and the param of the provider, as it wrote them, and its route /v1/chat/completions is not taken for a path of a disk", () => {
    const copied = text(DETAIL);
    expect(copied).toContain("HTTP status: 400");
    expect(copied).toContain(`Provider message: ${MESSAGE}`);
    expect(copied).toContain("Provider type: invalid_request_error");
    expect(copied).toContain("Provider param: reasoning_effort");
    expect(copied).not.toContain("Provider code");
    expect(copied).not.toContain("[path]");
  });

  it("still takes out the path of a disk, and every key, from the words of the provider", () => {
    const copied = text({ ...DETAIL, body: { ...OWNER, message: "Cannot read /var/lib/service/models/config.json with key sk-live-ABCDEFGH12345678 and Bearer abcdefghijklmnop" } });
    expect(copied).toContain("[path]");
    expect(copied).not.toContain("/var/lib/service");
    expect(copied).not.toContain("sk-live-ABCDEFGH12345678");
    expect(copied).not.toContain("abcdefghijklmnop");
  });

  it.each([
    ["a text", { status: 400, shape: "text", raw: "upstream connect error" } satisfies AiErrorBody, "Provider reply: upstream connect error"],
    ["a page", { status: 502, shape: "html", message: "page", raw: "<html>502</html>" } satisfies AiErrorBody, "Provider page: <html>502</html>"],
    ["nothing", { status: 400, shape: "empty" } satisfies AiErrorBody, "Provider reply: no body"],
  ])("says %s as it is", (_name, body, line) => {
    expect(text({ ...DETAIL, body })).toContain(line);
  });

  it("has the whole of a long message (up to the two thousand characters the engine keeps), and each candidate of the route with its own words", () => {
    const long = `${"w".repeat(1500)}.`;
    const route: AutopilotRouteStep[] = [
      { position: 0, integrationId: "gw", integrationName: "GW", provider: "openai", model: "gpt-6-luna", outcome: "failed", status: 400, body: { ...OWNER, message: long } },
      { position: 1, integrationId: "gw", integrationName: "GW", provider: "openai", model: "gpt-6.2-sol", outcome: "failed", status: 429, message: "slow down" },
    ];
    const copied = text({ ...DETAIL, route });
    expect(copied).toContain(`HTTP 400 - HTTP 400 — ${long}`.replace("HTTP 400 - ", ""));
    expect(copied).toContain("2. GW (gw) gpt-6.2-sol: failed, HTTP 429 - slow down");
  });
});

describe("the trail of the router", () => {
  const STEPS: AutopilotRouteStep[] = [
    { position: 0, integrationId: "gw", integrationName: "GW", provider: "openai", model: "gpt-6-luna", outcome: "failed", status: 400, durationMs: 120, body: OWNER },
    { position: 0, integrationId: "gw", integrationName: "GW", provider: "openai", model: "gpt-6-luna", outcome: "failed", status: 400, durationMs: 90, body: { ...OWNER, message: "Second words", type: "other_error", code: "c1" } },
    { position: 1, integrationId: "oa", integrationName: "LlmProxy", provider: "openai", model: "muse", outcome: "failed", status: 500, durationMs: 10, message: "overloaded" },
  ];

  it("says each attempt's own words as fields, even when two attempts are the same candidate (the request that was refused, and the one asked again), and keeps the sentence of an attempt that has no body", () => {
    render(<RouteTrail route={STEPS} integrationName={() => undefined} />);
    const steps = document.querySelectorAll("[data-route-step]");
    expect(steps).toHaveLength(3);
    expect(within(steps[0] as HTMLElement).getByText(MESSAGE)).toBeInTheDocument();
    expect(steps[0].querySelector("[data-provider-field=\"param\"]")?.nextElementSibling).toHaveTextContent("reasoning_effort");
    expect(steps[1].querySelector("[data-provider-field=\"code\"]")?.nextElementSibling).toHaveTextContent("c1");
    expect(steps[1]).toHaveTextContent("Second words");
    expect(steps[2].querySelector("[data-provider-words]")).toBeNull();
    expect(steps[2]).toHaveTextContent("overloaded");
  });
});

describe("the records of the calls", () => {
  it("say the provider's fields under the error of a failed attempt, in its words", async () => {
    const { store } = storeAsSource();
    await recordCall(store, STEP, {
      texts: ["Whole."],
      attempts: [
        attemptOf(1, { outcome: "failed", durationMs: 200, textAttempt: null, error: { name: "AiProviderError", message: LINE, status: 400, transient: false, timedOut: false, body: OWNER } }),
        attemptOf(2),
      ],
    });
    render(<MemoryRouter initialEntries={[`/app/books/${BOOK}/autopilot`]}><TaskCalls bookId={BOOK} activityIds={[STEP]} running={false} announce={vi.fn()} /></MemoryRouter>);
    await screen.findByText("Whole.");
    const failed = document.querySelector("[data-failed-attempts] li") as HTMLElement;
    const words = failed.querySelector("[data-provider-words]") as HTMLElement;
    expect(within(words).getByText("Message", { selector: "dt" }).nextElementSibling?.textContent).toBe(MESSAGE);
    expect(within(words).getByText("Type", { selector: "dt" }).nextElementSibling?.textContent).toBe("invalid_request_error");
    expect(within(words).getByText("Param", { selector: "dt" }).nextElementSibling?.textContent).toBe("reasoning_effort");
  });
});

describe("the debug panel", () => {
  const entry = (extra: Partial<LlmDebugEntry>): LlmDebugEntry => ({ id: "e", at: 1, kind: "chat", model: "gpt-6-luna", status: "error", error: LINE, ...extra });

  it("says the status, the type, the param and the code of what the provider answered, as short words, and never its message", () => {
    const stored = redactLlmDebugEntry(entry({ providerError: { status: 400, type: "invalid_request_error", param: "reasoning_effort", code: "x_1" } }));
    expect(stored.error).toBe("[Error details redacted]");
    expect(stored.providerError).toEqual({ status: 400, type: "invalid_request_error", param: "reasoning_effort", code: "x_1" });
    expect(attemptBadges(stored, "en").filter((badge) => badge.id.startsWith("provider")).map((badge) => [badge.id, badge.params])).toEqual([
      ["providerStatus", { status: "400" }],
      ["providerType", { value: "invalid_request_error" }],
      ["providerParam", { value: "reasoning_effort" }],
      ["providerCode", { value: "x_1" }],
    ]);
  });

  it("keeps a word of an error only when it can be an identifier: a sentence, a path with a space or a key is dropped, whatever it is given", () => {
    const stored = redactLlmDebugEntry(entry({ providerError: { status: 400, type: "Function tools are not supported", param: "messages[0].content", code: "sk-live-ABCDEFGH12345678 with spaces" } }));
    expect(stored.providerError).toEqual({ status: 400, param: "messages[0].content" });
    expect(JSON.stringify(stored)).not.toContain("Function tools");
    expect(redactLlmDebugEntry(entry({ providerError: { status: 99 } as never })).providerError).toBeUndefined();
    expect(redactLlmDebugEntry(entry({ providerError: "x" as never })).providerError).toBeUndefined();
  });

  it("says that the thinking was not sent because of the tools, and says the provider's status only when the transport does not", () => {
    const badges = attemptBadges(entry({ thinkingWhy: "tools", status: "done", error: undefined }), "en");
    expect(badges).toContainEqual({ id: "thinking", key: "debug.attempt.thinkingNotSentTools" });
    // none sent for the tools is told as such, and a level that nothing decided is told as the level.
    expect(attemptBadges(entry({ thinking: "none", thinkingWhy: "tools", status: "done", error: undefined }), "en")).toContainEqual({ id: "thinking", key: "debug.attempt.thinkingNoneTools" });
    expect(attemptBadges(entry({ thinking: "none", status: "done", error: undefined }), "en")).toContainEqual({ id: "thinking", key: "debug.attempt.thinking", params: { level: "none" } });
    expect(redactLlmDebugEntry(entry({ thinking: "none", thinkingWhy: "tools" })).thinking).toBe("none");
    expect(t("debug.attempt.thinkingNoneTools")).toBe("Thinking: none (tools)");
    expect(attemptBadges(entry({ providerError: { status: 400 }, transport: { status: 400 } }), "en").some((badge) => badge.id === "providerStatus")).toBe(false);
    expect(t("debug.attempt.thinkingNotSentTools")).not.toBe("debug.attempt.thinkingNotSentTools");
  });
});

describe("the Copilot", () => {
  it("tells a provider that refused in its own words as labelled fields above the sentence of the client", () => {
    const error = new AiProviderError(LINE, 400, false, { body: OWNER });
    const reply = describeAiFailure(error, i18n.t.bind(i18n) as never);
    expect(reply?.text).toContain("**What the provider said**");
    expect(reply?.text).toContain("- **HTTP status:** 400");
    expect(reply?.text).toContain(`- **Message:** ${MESSAGE}`);
    expect(reply?.text).toContain("- **Type:** invalid_request_error");
    expect(reply?.text).toContain("- **Param:** reasoning_effort");
    expect(reply?.text).not.toContain("**Code:**");
    expect(reply?.text).toContain(`> ${LINE}`);
  });

  it("tells each candidate's answer under its name when several failed, and in Italian when the app is", async () => {
    await i18n.changeLanguage("it");
    const error = new CompletionFallbackError(["one: x", "two: y"], [{ name: "AiProviderError", status: 400 }, { name: "AiProviderError", status: 500 }], [], [{ label: "one", body: OWNER }, { label: "two", body: { status: 500, shape: "empty" } }]);
    const reply = describeAiFailure(error, i18n.t.bind(i18n) as never);
    expect(reply?.text).toContain("**Cosa ha detto il provider**");
    expect(reply?.text).toContain("**one**\n- **Stato HTTP:** 400");
    expect(reply?.text).toContain("- **Messaggio:**");
    expect(reply?.text).toContain("**two**\n- **Stato HTTP:** 500\n- **Risposta:** Nessun corpo");
  });

  it("leaves every other failure as it was: its sentence is shown as it is", () => {
    expect(describeAiFailure(new AiProviderError("openai m: HTTP 503", 503, true), i18n.t.bind(i18n) as never)).toBeNull();
    expect(describeAiFailure(new CompletionFallbackError(["one: x"], [{ name: "Error" }]), i18n.t.bind(i18n) as never)).toBeNull();
    expect(describeAiFailure(new Error("boom"), i18n.t.bind(i18n) as never)).toBeNull();
  });
});

describe("the rows of a body", () => {
  it("are the fields that it has, in the order a person looks for them, and none that it has not", () => {
    const say = (key: string) => key.split(".").pop() as string;
    expect(providerRows(say, OWNER, "autopilot.failure.provider", { status: true }).map((row) => [row.id, row.value])).toEqual([["status", "400"], ["message", MESSAGE], ["type", "invalid_request_error"], ["param", "reasoning_effort"]]);
    expect(providerRows(say, { status: 401, shape: "azure", message: "Denied", code: "401" }, "autopilot.failure.provider").map((row) => row.id)).toEqual(["message", "code"]);
    expect(providerRows(say, { status: 400, shape: "empty" }, "autopilot.failure.provider").map((row) => row.id)).toEqual(["reply"]);
  });
});
