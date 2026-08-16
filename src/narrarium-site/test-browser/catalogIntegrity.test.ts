import { describe, expect, it } from "vitest";
import { assertExecutableHandlerMap, COPILOT_HANDLER_IDS, LLM_COPILOT_TOOL_IDS } from "@/assistant/handlerCatalog";
import { mutatingToolIds } from "@/assistant/mutationIntent";
import { buildCapabilitiesMessage } from "@/assistant/orchestrator";
import { runAssistantPrompt } from "@/assistant/service";
import { BUILTIN_TOOLS, ensureBuiltinCopilotToolsRegistered } from "@/assistant/tools/builtinTools";
import { validateToolCatalog } from "@/assistant/tools/catalogValidation";
import { copilotToolRegistry, ToolRegistry } from "@/assistant/tools/registry";
import type { CopilotToolDescriptor } from "@/assistant/tools/types";
import type { AppSettings } from "@/types/settings";
import type { LoadedWriterContext } from "@/assistant/context";
import { evaluateToolContract } from "@/assistant/tools/runtimeContract";
import type { CopilotToolPrerequisite } from "@/assistant/tools/types";

const settings = { ui: { language: "en" }, copilotTools: { toolOverrides: {} } } as unknown as AppSettings;

const EXPECTED_PREREQUISITES: Record<string, CopilotToolPrerequisite[]> = {
  "search-book": ["book open", "git token", "context loaded"],
  "switch-branch": ["book open", "git token"],
  "import-attachments": ["attachments", "book open", "git token", "context loaded"],
  "create-chapter": ["book open", "git token", "context loaded"],
  "create-paragraph": ["chapter open", "git token", "context loaded"],
  "create-entity": ["book open", "git token", "context loaded"],
  "create-script": ["chapter or paragraph open", "git token", "context loaded"],
  "create-draft": ["chapter or paragraph open", "git token", "context loaded"],
  "update-plot": ["book open", "git token", "context loaded"],
  "write-resume": ["chapter open", "git token", "context loaded"],
  "write-evaluation": ["book open", "git token", "context loaded"],
  "evaluate-chapter-paragraphs": ["book open", "git token", "context loaded"],
  "rewrite-current-paragraph": ["paragraph open", "git token", "context loaded"],
  "create-note": ["book open", "git token", "context loaded"],
  "multi-file-edit": ["book open", "git token", "context loaded"],
  "review-context": ["context loaded"],
  "summarize-context": ["context loaded"],
  "answer-from-context": ["context loaded"],
  "get-book": ["book open", "context loaded"],
  "get-chapter": ["book open", "context loaded"],
  "get-paragraph": ["chapter open", "git token", "context loaded"],
  "get-character": ["book open", "git token", "context loaded"],
  "get-location": ["book open", "git token", "context loaded"],
  "get-faction": ["book open", "git token", "context loaded"],
  "get-item": ["book open", "git token", "context loaded"],
  "get-secret": ["book open", "git token", "context loaded"],
  "get-timeline-event": ["book open", "git token", "context loaded"],
  "get-body": ["context loaded", "git token"],
  "get-frontmatter": ["context loaded", "git token"],
  "run-audit": ["book open", "git token", "context loaded"],
  "open-audit": ["book open"],
  "update-audit": ["book open", "git token", "context loaded"],
  "set-audit-finding-status": ["book open", "git token", "context loaded"],
  "deep-research": ["book open", "git token", "context loaded"],
  "create-from-research": ["book open", "research available", "git token", "context loaded"],
  "read-current-page": ["current page", "book open", "git token", "context loaded"],
  "list-simulated-readers": ["book open", "git token", "context loaded"],
  "create-simulated-reader": ["book open", "git token", "context loaded"],
  "toggle-simulated-reader": ["book open", "git token", "context loaded"],
  "evaluate-with-readers": ["chapter or paragraph open", "git token", "context loaded"],
  "summarize-reader-evaluations": ["reader evaluations available", "git token", "context loaded"],
  "open-reader-evaluations": ["chapter or paragraph open"],
  "generate-draft-from-feedback": ["chapter or paragraph open"],
  "restore-previous-drafts": ["chapter or paragraph open"],
  "feedback-rewrite-status": ["chapter or paragraph open"],
  "cancel-feedback-rewrite": ["chapter or paragraph open"],
  "open-reader": ["book open"],
  "navigate-app": ["local app"],
  "list-branches": ["book open", "git token"],
  "show-branch-diff": ["book open", "git token"],
  "list-commits": ["book open", "git token"],
  "list-pull-requests": ["book open", "git token"],
  "create-pull-request": ["book open", "git token", "non-default branch"],
  "delete-current-note": ["note open", "git token", "context loaded"],
  "delete-current-paragraph": ["paragraph open", "git token", "context loaded"],
  "delete-current-entity": ["canon entity open", "git token", "context loaded"],
  "delete-reader-evaluation": ["chapter or paragraph open", "git token", "context loaded"],
  "delete-audit": ["book open", "git token", "context loaded"],
};

describe("Copilot catalog integrity", () => {
  it("validates every built-in descriptor against executable handlers and mutation policy", () => {
    expect(() => validateToolCatalog(BUILTIN_TOOLS, COPILOT_HANDLER_IDS, new Set(mutatingToolIds()), LLM_COPILOT_TOOL_IDS)).not.toThrow();
    expect(new Set(BUILTIN_TOOLS.map((tool) => tool.id)).size).toBe(BUILTIN_TOOLS.length);
    expect(new Set(BUILTIN_TOOLS.map((tool) => tool.handlerId)).size).toBe(BUILTIN_TOOLS.length);
    for (const tool of BUILTIN_TOOLS) {
      expect(tool.handlerId).toBeTruthy();
      expect(tool.prerequisites.length).toBeGreaterThan(0);
      expect(new Set(tool.params.map((param) => param.name)).size).toBe(tool.params.length);
      expect(tool.params.every((param) => param.name && param.type && param.description)).toBe(true);
      if (tool.destructive) expect(tool).toMatchObject({ mutatesData: true, defaultEnabled: false });
      expect(tool.mutatesData).toBe(new Set(mutatingToolIds()).has(tool.id));
      expect(tool.requiresLlm).toBe(LLM_COPILOT_TOOL_IDS.has(tool.id));
    }
    expect(BUILTIN_TOOLS.find((tool) => tool.id === "run-audit")?.requiresLlm).toBe(true);
    expect(BUILTIN_TOOLS.find((tool) => tool.id === "update-audit")?.requiresLlm).toBe(true);
  });

  it("fails closed for duplicate IDs and incomplete executable coverage", () => {
    const registry = new ToolRegistry();
    registry.register(BUILTIN_TOOLS[0]);
    expect(() => registry.register(BUILTIN_TOOLS[0])).toThrow("Duplicate Copilot tool ID");
    expect(() => validateToolCatalog(BUILTIN_TOOLS, [], new Set(mutatingToolIds()), LLM_COPILOT_TOOL_IDS)).toThrow("coverage mismatch");
    expect(() => validateToolCatalog(BUILTIN_TOOLS, [...COPILOT_HANDLER_IDS, COPILOT_HANDLER_IDS[0]], new Set(mutatingToolIds()), LLM_COPILOT_TOOL_IDS)).toThrow("Duplicate IDs");
    expect(() => assertExecutableHandlerMap({ orphan: () => undefined })).toThrow("handler catalog mismatch");
    const invalid = { ...BUILTIN_TOOLS[0], id: "unsafe-delete", destructive: true, mutatesData: false, defaultEnabled: true } satisfies CopilotToolDescriptor;
    expect(() => validateToolCatalog([invalid], [invalid.handlerId!], new Set(), new Set())).toThrow("must mutate data and default to disabled");
    const badPrerequisite = { ...BUILTIN_TOOLS[0], id: "bad-prerequisite", prerequisites: ["" as never] } satisfies CopilotToolDescriptor;
    expect(() => validateToolCatalog([badPrerequisite], [badPrerequisite.handlerId!], new Set(), new Set())).toThrow("invalid prerequisites");
    const badParams = { ...BUILTIN_TOOLS[0], id: "bad-params", params: [{ name: "query", type: "", description: "Missing type" }] } satisfies CopilotToolDescriptor;
    expect(() => validateToolCatalog([badParams], [badParams.handlerId!], new Set(), new Set())).toThrow("invalid parameter metadata");
  });

  it("advertises only enabled tools with available executable handlers", () => {
    ensureBuiltinCopilotToolsRegistered();
    expect(copilotToolRegistry.list().length).toBe(BUILTIN_TOOLS.length);
    const message = buildCapabilitiesMessage("what can you do", settings, new Set(["search-book"]));
    expect(message.text).toContain("Search Book");
    expect(message.text).not.toContain("Create Chapter");
    const disabled = { ...settings, copilotTools: { toolOverrides: { "search-book": { enabled: false } } } } as unknown as AppSettings;
    expect(buildCapabilitiesMessage("what can you do", disabled, new Set(["search-book"])).text).not.toContain("Search Book");
  });

  it("builds capability answers from the real service handler map", async () => {
    const context = { branchReady: false, branch: "main", structure: null } as unknown as LoadedWriterContext;
    const message = await runAssistantPrompt({ prompt: "what can you do", context, settings, book: null, branch: "main", token: "", history: [], compactSummary: "", compactedMessageCount: 0, attachments: [], accountScope: null });
    expect(message.text).not.toContain("Search Book");
    expect(message.text).not.toContain("Deep Research");
    expect(message.text).not.toContain("Create From Research");
    expect(message.text).not.toContain("No GitHub token");
  });

  it("does not globally block local tools and reports selected-tool requirements", async () => {
    const context = { route: { kind: "book", bookId: "book-id" }, branchReady: false, branch: "main", structure: null, chapter: null, paragraph: null, relevantFiles: [] } as unknown as LoadedWriterContext;
    const book = { id: "book-id", name: "Book", owner: "owner", repo: "repo", tokenIndex: null, addedAt: "now" };
    const local = await runAssistantPrompt({ prompt: "open reader", context, settings, book, branch: "main", token: "", history: [], compactSummary: "", compactedMessageCount: 0, attachments: [], accountScope: null });
    expect(local.action).toMatchObject({ kind: "navigate", to: "/app/books/book-id/reader" });
    const blocked = await runAssistantPrompt({ prompt: "search for Ada", context, settings, book, branch: "main", token: "", history: [], compactSummary: "", compactedMessageCount: 0, attachments: [], accountScope: null });
    expect(blocked.text).toContain("Missing requirements: git token, context loaded");
  });

  it("enforces the complete local-versus-repository prerequisite matrix", () => {
    const emptyContext = { route: { kind: "settings" }, branchReady: false, branch: "main", structure: null, chapter: null, paragraph: null, relevantFiles: [] } as unknown as LoadedWriterContext;
    const loadedContext = { ...emptyContext, route: { kind: "book", bookId: "book-id" }, branchReady: true, structure: { defaultBranch: "main", readerEvaluationFiles: [], researchFiles: [] } } as unknown as LoadedWriterContext;
    const book = { id: "book-id", name: "Book", owner: "owner", repo: "repo", tokenIndex: null, addedAt: "now" };
    const runtime = (context: LoadedWriterContext, token = "", selectedBook: typeof book | null = book) => ({ settings, book: selectedBook, token, branch: "main", context, attachments: [] });
    expect(Object.keys(EXPECTED_PREREQUISITES).sort()).toEqual(BUILTIN_TOOLS.map((tool) => tool.id).sort());

    for (const tool of BUILTIN_TOOLS) {
      expect(tool.prerequisites, tool.id).toEqual(EXPECTED_PREREQUISITES[tool.id]);
      const empty = evaluateToolContract(tool, runtime(emptyContext, "", null));
      if (tool.id === "navigate-app") expect(empty.available, tool.id).toBe(true);
      if (EXPECTED_PREREQUISITES[tool.id].includes("git token")) {
        expect(evaluateToolContract(tool, runtime(loadedContext)).missing, tool.id).toContain("git token");
      }
      if (EXPECTED_PREREQUISITES[tool.id].includes("context loaded")) {
        expect(evaluateToolContract(tool, runtime(emptyContext, "token")).missing, tool.id).toContain("context loaded");
      }
    }
  });

  it.each([
    ["open reader", "/app/books/book-id/reader"],
    ["open research", "/app/books/book-id/research"],
    ["open export", "/app/books/book-id/export"],
    ["open dashboard", "/app/books/book-id/dashboard"],
    ["open assets", "/app/books/book-id/assets"],
    ["open ghostwriters", "/app/books/book-id/ghostwriters"],
    ["open book settings", "/app/books/book-id/settings"],
    ["open settings", "/app/settings"],
  ])("navigates locally without credentials or loaded structure: %s", async (prompt, to) => {
    const context = { route: { kind: "book", bookId: "book-id" }, branchReady: false, branch: "main", structure: null, chapter: null, paragraph: null, relevantFiles: [] } as unknown as LoadedWriterContext;
    const book = { id: "book-id", name: "Book", owner: "owner", repo: "repo", tokenIndex: null, addedAt: "now" };
    const message = await runAssistantPrompt({ prompt, context, settings, book, branch: "main", token: "", history: [], compactSummary: "", compactedMessageCount: 0, attachments: [], accountScope: null });
    expect(message.action).toMatchObject({ kind: "navigate", to });
  });

  it("opens global settings without a selected book", async () => {
    const context = { route: { kind: "settings" }, branchReady: false, branch: "main", structure: null, chapter: null, paragraph: null, relevantFiles: [] } as unknown as LoadedWriterContext;
    const message = await runAssistantPrompt({ prompt: "open settings", context, settings, book: null, branch: "main", token: "", history: [], compactSummary: "", compactedMessageCount: 0, attachments: [], accountScope: null });
    expect(message.action).toMatchObject({ kind: "navigate", to: "/app/settings" });
  });

  it.each([
    ["open reader evaluations", "/app/books/book-id/chapters/chapter-1/reader-evaluations"],
    ["generate draft from feedback", "/app/books/book-id/chapters/chapter-1/reader-evaluations?workflow=generate"],
    ["restore previous drafts", "/app/books/book-id/chapters/chapter-1/reader-evaluations?workflow=restore"],
    ["feedback rewrite status", "/app/books/book-id/chapters/chapter-1/reader-evaluations?workflow=status"],
    ["open audit", "/app/books/book-id/chapters/chapter-1/audit"],
  ])("uses route-known local tool targets without repository context: %s", async (prompt, to) => {
    const context = { route: { kind: "chapter", bookId: "book-id", chapterId: "chapter-1" }, branchReady: false, branch: "main", structure: null, chapter: null, paragraph: null, relevantFiles: [] } as unknown as LoadedWriterContext;
    const book = { id: "book-id", name: "Book", owner: "owner", repo: "repo", tokenIndex: null, addedAt: "now" };
    const message = await runAssistantPrompt({ prompt, context, settings, book, branch: "main", token: "", history: [], compactSummary: "", compactedMessageCount: 0, attachments: [], accountScope: null });
    expect(message.action).toMatchObject({ kind: "navigate", to });
  });

  it.each([
    ["open current chapter", "/app/books/book-id/chapters/001-opening"],
    ["open chapter 1", "/app/books/book-id/chapters/001-opening"],
    ["open current paragraph", "/app/books/book-id/chapters/001-opening/paragraphs/002"],
    ["open paragraph 2", "/app/books/book-id/chapters/001-opening/paragraphs/002"],
    ["open reader evaluations", "/app/books/book-id/chapters/001-opening/paragraphs/002/reader-evaluations"],
    ["feedback rewrite status", "/app/books/book-id/chapters/001-opening/paragraphs/002/reader-evaluations?workflow=status"],
    ["open audit", "/app/books/book-id/chapters/001-opening/paragraphs/002/audit"],
  ])("resolves current route targets without repository context: %s", async (prompt, to) => {
    const context = { route: { kind: "paragraph", bookId: "book-id", chapterId: "001-opening", paragraphNum: "002" }, branchReady: false, branch: "main", structure: null, chapter: null, paragraph: null, relevantFiles: [] } as unknown as LoadedWriterContext;
    const book = { id: "book-id", name: "Book", owner: "owner", repo: "repo", tokenIndex: null, addedAt: "now" };
    const message = await runAssistantPrompt({ prompt, context, settings, book, branch: "main", token: "", history: [], compactSummary: "", compactedMessageCount: 0, attachments: [], accountScope: null });
    expect(message.action).toMatchObject({ kind: "navigate", to });
  });
});
