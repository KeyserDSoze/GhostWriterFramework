import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AutopilotErrorDetail, AutopilotRouteStep } from "narrarium-engine";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { RouteTrail } from "@/components/autopilot/RouteTrail";
import { diagnosticsText, errorFacts, failureSource } from "@/autopilot/errorModel";
import { attemptBadges } from "@/debug/attemptBadges";
import { redactLlmDebugEntry, type LlmDebugEntry } from "@/debug/llmDebugStore";

// The API version of an Azure OpenAI request is said wherever an attempt is told: the facts and the diagnostics of a failed step, the trail of the router, and the debug panel, so that the author
// can see which `api-version` was sent to which model (each model may have its own).

const STEPS: AutopilotRouteStep[] = [
  { position: 0, integrationId: "az", integrationName: "AzureOpenAi-GW", provider: "azure_openai", model: "gpt-6-luna", outcome: "failed", status: 404, durationMs: 210, endpoint: "https://res.openai.azure.com", apiVersion: "2024-10-21", message: "The deployment does not exist." },
  { position: 1, integrationId: "az", integrationName: "AzureOpenAi-GW", provider: "azure_openai", model: "gpt-5-sol", outcome: "failed", status: 400, durationMs: 90, endpoint: "https://res.openai.azure.com", apiVersion: "2025-01-01-preview" },
  { position: 2, integrationId: "oa", integrationName: "LlmProxy", provider: "openai", model: "muse-glimmer-30b", outcome: "failed", status: 500 },
];
const DETAIL: AutopilotErrorDetail = { status: 400, endpoint: "https://res.openai.azure.com", apiVersion: "2025-01-01-preview", model: "gpt-5-sol", provider: "azure_openai", integration: "az", route: STEPS };

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

describe("the version in the facts and the diagnostics of a failed step", () => {
  it("is a fact of the last attempt, after the endpoint, and is left out with the endpoint when the route lists every attempt", () => {
    expect(errorFacts({ endpoint: "https://res.openai.azure.com", apiVersion: "2025-01-01-preview", model: "gpt-5-sol" }).map((fact) => fact.key)).toEqual(["endpoint", "apiVersion", "model"]);
    expect(errorFacts({ apiVersion: "v1" })).toEqual([{ key: "apiVersion", value: "v1" }]);
    expect(errorFacts(DETAIL, undefined, true).map((fact) => fact.key)).toEqual(["status"]);
    expect(errorFacts({ apiVersion: "  " })).toEqual([]);
  });

  it("is in the text that is copied: its own line, and in the line of every attempt of the route that has one", () => {
    const summary = { status: "error", message: "boom", lastError: { message: "boom", at: "2026-11-25T10:00:00.000Z", errorKind: "provider", errorDetail: DETAIL } } as never;
    const source = failureSource(summary, [])!;
    const text = diagnosticsText({ source, appVersion: "0.114.0", engineVersion: "0.1.19", host: "browser", at: new Date("2026-11-25T10:05:00.000Z") });
    expect(text).toContain("API version: 2025-01-01-preview");
    expect(text).toContain("1. AzureOpenAi-GW (az) gpt-6-luna [api-version 2024-10-21]: failed, HTTP 404");
    expect(text).toContain("2. AzureOpenAi-GW (az) gpt-5-sol [api-version 2025-01-01-preview]: failed, HTTP 400");
    expect(text).toContain("3. LlmProxy (oa) muse-glimmer-30b: failed, HTTP 500");
    expect(text).not.toContain("3. LlmProxy (oa) muse-glimmer-30b [api-version");
  });
});

describe("the version in the trail of the router", () => {
  it.each([["en", "API version 2024-10-21"], ["it", "Versione API 2024-10-21"]])("says it beside the address of each attempt that has one [%s]", async (language, words) => {
    await i18n.changeLanguage(language);
    render(<RouteTrail route={STEPS} integrationName={() => undefined} />);
    const steps = document.querySelectorAll("[data-route-step]");
    expect(steps).toHaveLength(3);
    expect(steps[0].querySelector("[data-route-api-version]")).toHaveTextContent(words);
    expect(steps[1].querySelector("[data-route-api-version]")).toHaveTextContent(language === "en" ? "API version 2025-01-01-preview" : "Versione API 2025-01-01-preview");
    expect(steps[2].querySelector("[data-route-api-version]")).toBeNull();
    expect(screen.getAllByText(/gpt-6-luna|gpt-5-sol/)).toHaveLength(2);
  });

  it("says it for an attempt whose address is not known too", () => {
    render(<RouteTrail route={[{ ...STEPS[0], endpoint: undefined }]} integrationName={() => undefined} />);
    expect(document.querySelector("[data-route-api-version]")).toHaveTextContent("API version 2024-10-21");
  });
});

describe("the version in the debug panel", () => {
  const entry = (extra: Partial<LlmDebugEntry>): LlmDebugEntry => ({ id: "e", at: 1, kind: "chat", model: "gpt-6-luna", status: "done", ...extra });

  it("is a badge of the attempt, before its thinking, when the entry has it", () => {
    const badges = attemptBadges(entry({ stream: true, apiVersion: "2025-01-01-preview", thinking: "high" }), "en");
    expect(badges.map((badge) => badge.id)).toEqual(["stream", "apiVersion", "thinking"]);
    expect(badges[1]).toEqual({ id: "apiVersion", key: "debug.attempt.apiVersion", params: { version: "2025-01-01-preview" } });
    expect(attemptBadges(entry({ stream: true }), "en").map((badge) => badge.id)).toEqual(["stream"]);
  });

  it("keeps only a word that can be a version: the store keeps flags, numbers and the few words of the engine, whatever it is given", () => {
    expect(redactLlmDebugEntry(entry({ apiVersion: "2025-01-01-preview" })).apiVersion).toBe("2025-01-01-preview");
    expect(redactLlmDebugEntry(entry({ apiVersion: "v1" })).apiVersion).toBe("v1");
    expect(redactLlmDebugEntry(entry({ apiVersion: "2025 01 01?key=sk-secret" })).apiVersion).toBeUndefined();
    expect(redactLlmDebugEntry(entry({ apiVersion: "x".repeat(80) })).apiVersion).toBeUndefined();
  });
});
