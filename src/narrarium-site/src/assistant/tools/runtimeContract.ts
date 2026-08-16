import type { LoadedWriterContext } from "@/assistant/context";
import { resolveTaskCandidates } from "@/assistant/router";
import type { AssistantAttachment, AssistantMessage } from "@/assistant/store";
import type { AppSettings, BookEntry, ChatCapability } from "@/types/settings";
import type { AttachmentImportTarget } from "@/assistant/attachmentImport";
import type { CopilotToolDescriptor, CopilotToolPrerequisite } from "./types";

export interface CopilotToolRuntimeContext {
  settings: AppSettings;
  book: BookEntry | null;
  token: string;
  branch: string;
  context: LoadedWriterContext;
  attachments: AssistantAttachment[];
  attachmentTarget?: AttachmentImportTarget;
}

export interface CopilotToolContractResult {
  available: boolean;
  missing: string[];
}

const LLM_TASKS: Readonly<Record<string, ChatCapability>> = {
  "answer-from-context": "copilot",
  "create-chapter": "default",
  "create-entity": "default",
  "create-from-research": "create-from-research",
  "create-note": "default",
  "create-paragraph": "default",
  "create-script": "default",
  "create-simulated-reader": "default",
  "deep-research": "deep-research",
  "evaluate-chapter-paragraphs": "review",
  "evaluate-with-readers": "reader-evaluation",
  "import-attachments": "default",
  "multi-file-edit": "default",
  "review-context": "review",
  "rewrite-current-paragraph": "default",
  "run-audit": "audit",
  "summarize-context": "copilot",
  "summarize-reader-evaluations": "reader-evaluation-summary",
  "update-audit": "audit",
  "update-plot": "default",
  "write-evaluation": "review",
  "write-resume": "chat-resume",
};

export function llmTaskForTool(toolId: string): ChatCapability | null {
  return LLM_TASKS[toolId] ?? null;
}

export function evaluateToolContract(tool: CopilotToolDescriptor, runtime: CopilotToolRuntimeContext): CopilotToolContractResult {
  const missing: string[] = tool.prerequisites.filter((requirement) => !hasPrerequisite(requirement, runtime));
  if (tool.requiresLlm) {
    const task = llmTaskForTool(tool.id);
    if (!task || !resolveTaskCandidates(runtime.settings, task).some((candidate) => candidate.integration && candidate.model)) {
      missing.push("configured compatible AI model");
    }
  }
  if (tool.id === "import-attachments" && !runtime.attachmentTarget) missing.push("attachment import target");
  return { available: missing.length === 0, missing };
}

export function assertToolExecutionResult(tool: CopilotToolDescriptor, message: AssistantMessage): void {
  if (!tool.mutatesData && message.mutation) throw new Error(`Read-only Copilot tool ${tool.id} returned a repository mutation.`);
  if (tool.destructive && message.mutation) {
    throw new Error(`Destructive Copilot tool ${tool.id} must require confirmation instead of mutating during dispatch.`);
  }
}

export function missingToolRequirementsMessage(tool: CopilotToolDescriptor, missing: readonly string[], language: string): string {
  const requirements = missing.join(", ");
  return language === "it"
    ? `Il tool ${tool.name} non può essere eseguito ora. Requisiti mancanti: ${requirements}.`
    : `${tool.name} cannot run right now. Missing requirements: ${requirements}.`;
}

function hasPrerequisite(requirement: CopilotToolPrerequisite, runtime: CopilotToolRuntimeContext): boolean {
  const { context } = runtime;
  switch (requirement) {
    case "attachments": return runtime.attachments.length > 0;
    case "book open": return Boolean(runtime.book);
    case "canon entity open": return context.route?.kind === "canon";
    case "chapter open": return Boolean(context.chapter);
    case "chapter or paragraph open": return Boolean(context.chapter || context.paragraph);
    case "context loaded": return Boolean(context.structure && context.branchReady && context.branch === runtime.branch);
    case "current page": return Boolean(context.chapter || context.paragraph || context.relevantFiles?.length);
    case "git token": return Boolean(runtime.token);
    case "non-default branch": return Boolean(context.structure && runtime.branch !== context.structure.defaultBranch);
    case "note open": return Boolean(context.noteTargetPath);
    case "paragraph open": return Boolean(context.paragraph);
    case "reader evaluations available": return Boolean(context.structure?.readerEvaluationFiles?.length && context.chapter);
    case "research available": return Boolean(context.structure?.researchFiles?.length);
  }
}
