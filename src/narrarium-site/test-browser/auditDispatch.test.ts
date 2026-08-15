import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAssistantPrompt } from "@/assistant/service";
import { auditRunBlocker, claimAuditQueryOperation } from "@/narrarium/auditAvailability";
import type { LoadedWriterContext } from "@/assistant/context";
import type { AppSettings, BookEntry } from "@/types/settings";

const { listBranchCommits } = vi.hoisted(() => ({ listBranchCommits: vi.fn() }));

vi.mock("@/github/githubClient", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/github/githubClient")>(),
  listBranchCommits,
}));

const book = {
  id: "book-id",
  name: "Book",
  owner: "owner",
  repo: "repo",
  tokenIndex: null,
  addedAt: "2026-01-01T00:00:00.000Z",
} satisfies BookEntry;

const structure = {
  title: "Test Book",
  chapters: [],
  auditFiles: [{ path: "audit/book.md" }],
} as unknown as NonNullable<LoadedWriterContext["structure"]>;

const context = {
  branchReady: true,
  branch: "main",
  structure,
  chapter: null,
  paragraph: null,
} as unknown as LoadedWriterContext;

const settings = {
  ui: { language: "en" },
  copilotTools: { toolOverrides: {} },
  aiIntegrations: [{
    id: "ai",
    name: "AI",
    provider: "openai",
    apiKey: "key",
    chatModels: [{ id: "audit-model", name: "model", capabilities: ["audit"] }],
  }],
} as unknown as AppSettings;

function prompt(text: string, nextBook = book, nextSettings = settings) {
  return runAssistantPrompt({
    prompt: text,
    context,
    settings: nextSettings,
    book: nextBook,
    branch: "main",
    token: "token",
    history: [],
    compactSummary: "",
    compactedMessageCount: 0,
    attachments: [],
  });
}

describe("audit Copilot dispatch", () => {
  beforeEach(() => {
    listBranchCommits.mockReset();
    listBranchCommits.mockResolvedValue([{ sha: "head-sha" }]);
  });

  it.each([
    ["run audit", "run-audit"],
    ["update audit", "update-audit"],
  ])("dispatches %s as one run request", async (request, toolId) => {
    const message = await prompt(request);
    expect(message.action).toMatchObject({
      kind: "navigate",
      to: "/app/books/book-id/audit?action=run",
      toolId,
    });
    expect(listBranchCommits).toHaveBeenCalledTimes(1);
  });

  it("opens an existing audit without requiring a model or starting execution", async () => {
    const message = await prompt("open audit", book, { ...settings, aiIntegrations: [] } as unknown as AppSettings);
    expect(message.action).toMatchObject({ kind: "navigate", to: "/app/books/book-id/audit", toolId: "open-audit" });
    expect(message.text).toContain("Opening the audit");
  });

  it("explains disabled audit and links to the book setting", async () => {
    const disabledBook = { ...book, auditSettings: { enabled: false } };
    const message = await prompt("run audit", disabledBook);
    expect(message.text).toContain("disabled for this book");
    expect(message.action).toMatchObject({ kind: "navigate", to: "/app/books/book-id/settings" });
    expect(listBranchCommits).not.toHaveBeenCalled();
  });

  it("explains a missing Audit model and links to the router", async () => {
    const noModel = { ...settings, aiIntegrations: [] } as unknown as AppSettings;
    const message = await prompt("run audit", book, noModel);
    expect(message.text).toContain("No executable AI model");
    expect(message.action).toMatchObject({ kind: "navigate", to: "/app/settings/ai-router" });
    expect(auditRunBlocker(book, noModel)).toBe("missing-model");
  });

  it("reports dispatch preparation failures without promising execution", async () => {
    listBranchCommits.mockRejectedValueOnce(new Error("head unavailable"));
    const message = await prompt("run audit");
    expect(message.text).toContain("could not prepare the audit action safely");
    expect(message.text).toContain("head unavailable");
    expect(message.action).toBeUndefined();
  });

  it("claims each query-triggered audit operation exactly once", () => {
    const handled = new Set<string>();
    expect(claimAuditQueryOperation(handled, "nav-1", "audit/book.md", "?action=run")).toBe(true);
    expect(claimAuditQueryOperation(handled, "nav-1", "audit/book.md", "?action=run")).toBe(false);
    expect(claimAuditQueryOperation(handled, "nav-2", "audit/book.md", "?action=run")).toBe(true);
  });
});
