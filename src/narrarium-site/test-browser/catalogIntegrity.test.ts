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

const settings = { ui: { language: "en" }, copilotTools: { toolOverrides: {} } } as unknown as AppSettings;

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
    const message = await runAssistantPrompt({ prompt: "what can you do", context, settings, book: null, branch: "main", token: "", history: [], compactSummary: "", compactedMessageCount: 0, attachments: [] });
    expect(message.text).not.toContain("Search Book");
    expect(message.text).not.toContain("Deep Research");
    expect(message.text).not.toContain("Create From Research");
    expect(message.text).not.toContain("No GitHub token");
  });

  it("does not globally block local tools and reports selected-tool requirements", async () => {
    const context = { route: { kind: "book", bookId: "book-id" }, branchReady: false, branch: "main", structure: null, chapter: null, paragraph: null, relevantFiles: [] } as unknown as LoadedWriterContext;
    const book = { id: "book-id", name: "Book", owner: "owner", repo: "repo", tokenIndex: null, addedAt: "now" };
    const local = await runAssistantPrompt({ prompt: "open reader", context, settings, book, branch: "main", token: "", history: [], compactSummary: "", compactedMessageCount: 0, attachments: [] });
    expect(local.action).toMatchObject({ kind: "navigate", to: "/app/books/book-id/reader" });
    const blocked = await runAssistantPrompt({ prompt: "search for Ada", context, settings, book, branch: "main", token: "", history: [], compactSummary: "", compactedMessageCount: 0, attachments: [] });
    expect(blocked.text).toContain("Missing requirements: git token, context loaded");
  });
});
