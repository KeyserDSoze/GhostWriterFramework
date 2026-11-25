import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AutopilotErrorDetail, AutopilotRouteStep } from "narrarium-engine";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import "@/i18n/debugAttempt";
import { RouteTrail } from "@/components/autopilot/RouteTrail";
import { diagnosticsText, errorFacts, failureSource } from "@/autopilot/errorModel";
import { attemptBadges, transportBadges } from "@/debug/attemptBadges";
import { redactLlmDebugEntry, type LlmDebugEntry } from "@/debug/llmDebugStore";

// A request made through the Responses API says so wherever an attempt is told, and a model with an address of its own is told by the host and the path of that address: the facts and the diagnostics of a
// failed step, the trail of the router and the debug panel. The query of the address, which may hold a key, is nowhere, and the debug panel keeps the protocol and no address at all.

const STEPS: AutopilotRouteStep[] = [
  { position: 0, integrationId: "az", integrationName: "oai-gw-002", provider: "azure_openai", model: "gpt-5.2", outcome: "failed", status: 404, durationMs: 210, endpoint: "https://gw.example.com", path: "/proxy/openai/responses", protocol: "responses", message: "not found" },
  { position: 1, integrationId: "az", integrationName: "oai-gw-002", provider: "azure_openai", model: "gpt-4.1", outcome: "failed", status: 500, durationMs: 90, endpoint: "https://oai-gw-002.openai.azure.com", apiVersion: "2024-10-21" },
  { position: 2, integrationId: "az", integrationName: "oai-gw-002", provider: "azure_openai", model: "gpt-5.2-mini", outcome: "left-out", leftOut: "no-tool-calls", endpoint: "https://gw.example.com", path: "/proxy/openai/responses", protocol: "responses" },
];
const DETAIL: AutopilotErrorDetail = { status: 404, endpoint: "https://gw.example.com", path: "/proxy/openai/responses", protocol: "responses", model: "gpt-5.2", provider: "azure_openai", integration: "az", route: STEPS };

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

describe("the protocol and the address in the facts and the diagnostics of a failed step", () => {
  it("are facts of the last attempt: the endpoint with its path, then the protocol, and they are left out when the route lists every attempt", () => {
    expect(errorFacts({ endpoint: "https://gw.example.com", path: "/proxy/openai/responses", protocol: "responses", model: "gpt-5.2" })).toEqual([
      { key: "endpoint", value: "https://gw.example.com/proxy/openai/responses" },
      { key: "protocol", value: "responses" },
      { key: "model", value: "gpt-5.2" },
    ]);
    expect(errorFacts({ endpoint: "https://res.openai.azure.com", apiVersion: "2024-10-21" })).toEqual([{ key: "endpoint", value: "https://res.openai.azure.com" }, { key: "apiVersion", value: "2024-10-21" }]);
    expect(errorFacts({ protocol: "responses" })).toEqual([{ key: "protocol", value: "responses" }]);
    expect(errorFacts(DETAIL, undefined, true).map((fact) => fact.key)).toEqual(["status"]);
  });

  it("are in the text that is copied: the endpoint with its path, a line for the protocol, and the line of every attempt of the route that has one", () => {
    const summary = { status: "error", message: "boom", lastError: { message: "boom", at: "2026-11-25T10:00:00.000Z", errorKind: "provider", errorDetail: DETAIL } } as never;
    const source = failureSource(summary, [])!;
    const text = diagnosticsText({ source, appVersion: "0.115.0", engineVersion: "0.1.20", host: "browser", at: new Date("2026-11-25T10:05:00.000Z") });
    expect(text).toContain("Endpoint: https://gw.example.com/proxy/openai/responses");
    expect(text).toContain("Protocol: Responses API");
    expect(text).toContain("1. oai-gw-002 (az) gpt-5.2 [Responses API] [https://gw.example.com/proxy/openai/responses]: failed, HTTP 404");
    expect(text).toContain("2. oai-gw-002 (az) gpt-4.1 [api-version 2024-10-21]: failed, HTTP 500");
    expect(text).toContain("3. oai-gw-002 (az) gpt-5.2-mini [Responses API] [https://gw.example.com/proxy/openai/responses]: left out");
    expect(text).not.toContain("2. oai-gw-002 (az) gpt-4.1 [Responses API]");
  });
});

describe("the protocol and the address in the trail of the router", () => {
  it.each([["en", "Responses API"], ["it", "API Responses"]])("say them beside the address of each attempt that has them, the host and the path together, with the version after [%s]", async (language, words) => {
    await i18n.changeLanguage(language);
    render(<RouteTrail route={STEPS} integrationName={() => undefined} />);
    const steps = document.querySelectorAll("[data-route-step]");
    expect(steps).toHaveLength(3);
    expect(steps[0].querySelector("[data-route-address]")).toHaveTextContent("https://gw.example.com/proxy/openai/responses");
    expect(steps[0].querySelector("[data-route-protocol]")).toHaveTextContent(words);
    expect(steps[0].querySelector("[data-route-api-version]")).toBeNull();
    expect(steps[1].querySelector("[data-route-address]")).toHaveTextContent("https://oai-gw-002.openai.azure.com");
    expect(steps[1].querySelector("[data-route-address]")?.textContent).toBe("https://oai-gw-002.openai.azure.com");
    expect(steps[1].querySelector("[data-route-protocol]")).toBeNull();
    expect(steps[1].querySelector("[data-route-api-version]")).not.toBeNull();
    expect(steps[2].querySelector("[data-route-address]"), "a candidate that was left out has no address line, as ever").toBeNull();
    expect(steps[0].querySelector("p.break-all")?.textContent).toBe(`https://gw.example.com/proxy/openai/responses · ${words}`);
  });
});

describe("the protocol in the debug panel", () => {
  const entry = (extra: Partial<LlmDebugEntry>): LlmDebugEntry => ({ id: "e", at: 1, kind: "chat", model: "gpt-5.2", status: "done", ...extra });

  it("is a badge of the attempt, before its version, when the entry has it; Chat Completions has none", () => {
    const badges = attemptBadges(entry({ stream: true, protocol: "responses", thinking: "high" }), "en");
    expect(badges.map((badge) => badge.id)).toEqual(["stream", "protocol", "thinking"]);
    expect(badges[1]).toEqual({ id: "protocol", key: "debug.attempt.protocolResponses" });
    expect(attemptBadges(entry({ stream: true }), "en").map((badge) => badge.id)).toEqual(["stream"]);
    expect(i18n.t("debug.attempt.protocolResponses")).toBe("Responses API");
  });

  it("says how a stream of the Responses API ended with its own words: it has no [DONE]", async () => {
    const transport = { end: "done" as const, bytes: 10, chunks: 2 };
    const keys = (protocol?: "responses") => transportBadges(transport, true, "en", "debug.attempt", protocol).find((badge) => badge.id === "streamEnd")?.key;
    expect(keys()).toBe("debug.attempt.end.done");
    expect(keys("responses")).toBe("debug.attempt.end.doneResponses");
    expect(transportBadges({ end: "closed" as const }, true, "en", "debug.attempt", "responses").find((badge) => badge.id === "streamEnd")?.key).toBe("debug.attempt.end.closedResponses");
    expect(transportBadges({ end: "reset" as const }, true, "en", "debug.attempt", "responses").find((badge) => badge.id === "streamEnd")?.key, "the other ends are the same").toBe("debug.attempt.end.reset");
    expect(transportBadges({ end: "done" as const }, true, "en", "autopilot.failure.transport", "responses").find((badge) => badge.id === "streamEnd")?.key).toBe("autopilot.failure.transport.end.doneResponses");
    for (const language of ["en", "it"]) {
      await i18n.changeLanguage(language);
      for (const scope of ["debug.attempt", "autopilot.failure.transport"]) {
        for (const key of ["doneResponses", "closedResponses"]) expect(i18n.exists(`${scope}.end.${key}`), `${scope}.end.${key} (${language})`).toBe(true);
      }
    }
    expect(attemptBadges(entry({ status: "error", protocol: "responses", transport }), "en").find((badge) => badge.id === "streamEnd")?.key).toBe("debug.attempt.end.doneResponses");
  });

  it("keeps only the word that the engine says: the store keeps flags, numbers and the few words of the engine, whatever it is given", () => {
    expect(redactLlmDebugEntry(entry({ protocol: "responses" })).protocol).toBe("responses");
    expect(redactLlmDebugEntry(entry({ protocol: "chat-completions" as never })).protocol).toBeUndefined();
    expect(redactLlmDebugEntry(entry({ protocol: "https://gw.example.com/responses?key=sk-secret" as never })).protocol).toBeUndefined();
  });
});
