import { describe, expect, it } from "vitest";
import type { LoadedWriterContext } from "@/assistant/context";
import type { AssistantMutationResult } from "@/assistant/store";
import { BUILTIN_TOOLS } from "@/assistant/tools/builtinTools";
import { assertToolExecutionResult, evaluateToolContract, llmTaskForTool, type CopilotToolRuntimeContext } from "@/assistant/tools/runtimeContract";
import type { CopilotToolDescriptor, CopilotToolPrerequisite } from "@/assistant/tools/types";
import type { AppSettings, BookEntry } from "@/types/settings";

const book = { id: "book", name: "Book", owner: "owner", repo: "repo", tokenIndex: null, addedAt: "now" } satisfies BookEntry;
const chapter = { slug: "001-one", title: "One", path: "chapters/001-one", paragraphs: [] };
const paragraph = { number: "001", title: "Scene", path: "chapters/001-one/001-scene.md" };
const context = {
  route: { kind: "canon", bookId: "book", section: "characters", slug: "ada" },
  book,
  structure: { defaultBranch: "main", researchFiles: [{ path: "research/topic.md" }], readerEvaluationFiles: [{ path: "evaluations/readers/one.md" }] },
  chapter,
  paragraph,
  relevantFiles: [{ path: paragraph.path, content: "Text" }],
  noteTargetPath: "notes/book.md",
  branch: "feature",
  branchReady: true,
} as unknown as LoadedWriterContext;
const settings = { ui: { language: "en" }, copilotTools: { toolOverrides: {} }, aiIntegrations: [] } as unknown as AppSettings;
const runtime = { settings, book, token: "token", branch: "feature", context, attachments: [{ id: "a", name: "a.txt", mimeType: "text/plain", kind: "text", sizeBytes: 1, textContent: "a" }], attachmentTarget: "note" } as CopilotToolRuntimeContext;
const descriptor = (prerequisite: CopilotToolPrerequisite): CopilotToolDescriptor => ({ id: `test-${prerequisite}`, area: "utility", name: "Test", description: "Test tool", params: [], output: "Test", prerequisites: [prerequisite], requiresLlm: false, mutatesData: false, destructive: false, defaultEnabled: true, keywords: [], handlerId: "test" });

describe("Copilot tool runtime contracts", () => {
  it.each<[CopilotToolPrerequisite, (value: CopilotToolRuntimeContext) => CopilotToolRuntimeContext]>([
    ["attachments", (value) => ({ ...value, attachments: [] })],
    ["book open", (value) => ({ ...value, book: null })],
    ["canon entity open", (value) => ({ ...value, context: { ...value.context, route: { kind: "book", bookId: "book" } } })],
    ["chapter open", (value) => ({ ...value, context: { ...value.context, chapter: null } })],
    ["chapter or paragraph open", (value) => ({ ...value, context: { ...value.context, chapter: null, paragraph: null } })],
    ["context loaded", (value) => ({ ...value, context: { ...value.context, branchReady: false } })],
    ["current page", (value) => ({ ...value, context: { ...value.context, chapter: null, paragraph: null, relevantFiles: [] } })],
    ["git token", (value) => ({ ...value, token: "" })],
    ["non-default branch", (value) => ({ ...value, branch: "main" })],
    ["note open", (value) => ({ ...value, context: { ...value.context, noteTargetPath: null } })],
    ["paragraph open", (value) => ({ ...value, context: { ...value.context, paragraph: null } })],
    ["reader evaluations available", (value) => ({ ...value, context: { ...value.context, structure: { ...value.context.structure!, readerEvaluationFiles: [] } } })],
    ["research available", (value) => ({ ...value, context: { ...value.context, structure: { ...value.context.structure!, researchFiles: [] } } })],
  ])("enforces %s", (prerequisite, withoutRequirement) => {
    expect(evaluateToolContract(descriptor(prerequisite), runtime)).toEqual({ available: true, missing: [] });
    expect(evaluateToolContract(descriptor(prerequisite), withoutRequirement(runtime))).toEqual({ available: false, missing: [prerequisite] });
  });

  it.each(BUILTIN_TOOLS.filter((tool) => tool.requiresLlm).map((tool) => [tool.id, tool] as const))("declares an executable LLM task for %s", (_id, tool) => {
    expect(llmTaskForTool(tool.id)).not.toBeNull();
  });

  it.each(BUILTIN_TOOLS.filter((tool) => tool.destructive).map((tool) => [tool.id, tool] as const))("prevents destructive dispatch from mutating for %s", (_id, tool) => {
    const mutation: AssistantMutationResult = { changedPaths: ["file.md"], refresh: "book-structure-and-context" };
    expect(() => assertToolExecutionResult(tool, { id: "message", role: "assistant", text: "changed", mutation })).toThrow("must require confirmation");
  });

  it.each(BUILTIN_TOOLS.filter((tool) => !tool.mutatesData).map((tool) => [tool.id, tool] as const))("prevents read-only tool %s from reporting writes", (_id, tool) => {
    const mutation: AssistantMutationResult = { changedPaths: ["file.md"], refresh: "book-structure-and-context" };
    expect(() => assertToolExecutionResult(tool, { id: "message", role: "assistant", text: "changed", mutation })).toThrow("Read-only");
  });
});
