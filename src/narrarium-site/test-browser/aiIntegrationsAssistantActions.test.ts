import { describe, expect, it, vi } from "vitest";
import { runAssistantPrompt } from "@/assistant/service";
import type { LoadedWriterContext } from "@/assistant/context";
import type { AppSettings, BookEntry } from "@/types/settings";

const blocker = vi.hoisted(() => ({ value: null as "disabled" | "missing-model" | null }));

vi.mock("@/narrarium/auditAvailability", () => ({ auditRunBlocker: () => blocker.value }));

const book = { id: "book-id", name: "Book", owner: "owner", repo: "repo", tokenIndex: null, addedAt: "2026-01-01T00:00:00.000Z" } satisfies BookEntry;
const context = {
  branchReady: true,
  branch: "main",
  structure: { title: "Test Book", chapters: [], auditFiles: [{ path: "audit/book.md" }] },
  chapter: null,
  paragraph: null,
} as unknown as LoadedWriterContext;

const withModel = {
  ui: { language: "en" },
  copilotTools: { toolOverrides: {} },
  aiIntegrations: [{ id: "ai", name: "AI", provider: "openai", apiKey: "key", chatModels: [{ id: "audit-model", name: "model", capabilities: ["audit", "default", "copilot"] }] }],
} as unknown as AppSettings;
const withoutModel = { ...withModel, aiIntegrations: [] } as unknown as AppSettings;

function prompt(text: string, settings: AppSettings) {
  return runAssistantPrompt({ prompt: text, context, settings, book, branch: "main", token: "token", history: [], compactSummary: "", compactedMessageCount: 0, attachments: [], accountScope: null });
}

describe("the Copilot actions that send the author to configure an AI model", () => {
  it("opens AI Integrations when a tool needs a model and no integration can run it", async () => {
    blocker.value = null;
    const message = await prompt("run audit", withoutModel);
    expect(message.text).toContain("No executable AI model");
    expect(message.action).toMatchObject({ kind: "navigate", to: "/app/settings/ai-integrations", label: "AI Integrations" });
  });

  it("opens AI Integrations from the Audit blocker too, and still mentions the router for the routing", async () => {
    blocker.value = "missing-model";
    const message = await prompt("run audit", withModel);
    expect(message.text).toContain("No executable AI model is configured for the Audit task");
    expect(message.text).toContain("AI Integrations");
    expect(message.text).toContain("AI Router");
    expect(message.action).toMatchObject({ kind: "navigate", to: "/app/settings/ai-integrations", label: "AI Integrations" });
  });

  it("keeps the disabled-audit action pointing at the book settings", async () => {
    blocker.value = "disabled";
    const message = await prompt("run audit", withModel);
    expect(message.action).toMatchObject({ kind: "navigate", to: "/app/books/book-id/settings" });
  });

  it("never sends the author to the router to configure a provider", async () => {
    for (const next of [null, "missing-model"] as const) {
      blocker.value = next;
      const message = await prompt("run audit", next ? withModel : withoutModel);
      expect(message.action).not.toMatchObject({ to: "/app/settings/ai-router" });
    }
  });
});
