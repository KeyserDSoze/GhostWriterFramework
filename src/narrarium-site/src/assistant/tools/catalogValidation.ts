import type { CopilotToolDescriptor, CopilotToolPrerequisite } from "./types";

export const COPILOT_TOOL_PREREQUISITES: ReadonlySet<CopilotToolPrerequisite> = new Set([
  "attachments", "book open", "canon entity open", "chapter open", "chapter or paragraph open", "context loaded",
  "current page", "git token", "non-default branch", "note open", "paragraph open", "reader evaluations available", "research available",
]);

export function validateToolCatalog(descriptors: readonly CopilotToolDescriptor[], handlerIds: readonly string[], mutationToolIds: ReadonlySet<string>, llmToolIds: ReadonlySet<string>): void {
  const toolIds = new Set<string>();
  const descriptorHandlers = new Set<string>();
  if (new Set(handlerIds).size !== handlerIds.length) throw new Error("Duplicate IDs in the Copilot executable handler catalog.");
  const executableHandlers = new Set(handlerIds);
  for (const tool of descriptors) {
    if (!tool.id.trim() || toolIds.has(tool.id)) throw new Error(`Duplicate or empty Copilot tool ID: ${tool.id || "(empty)"}`);
    toolIds.add(tool.id);
    if (!tool.handlerId?.trim()) throw new Error(`Copilot tool ${tool.id} has no executable handler.`);
    if (descriptorHandlers.has(tool.handlerId)) throw new Error(`Duplicate Copilot handler ID: ${tool.handlerId}`);
    descriptorHandlers.add(tool.handlerId);
    if (!tool.name.trim() || !tool.description.trim() || !tool.output.trim()) throw new Error(`Copilot tool ${tool.id} has incomplete display metadata.`);
    if (!tool.prerequisites.length || new Set(tool.prerequisites).size !== tool.prerequisites.length || tool.prerequisites.some((item) => !COPILOT_TOOL_PREREQUISITES.has(item))) throw new Error(`Copilot tool ${tool.id} has invalid prerequisites.`);
    if (tool.destructive && (!tool.mutatesData || tool.defaultEnabled)) throw new Error(`Destructive Copilot tool ${tool.id} must mutate data and default to disabled.`);
    if (tool.mutatesData !== mutationToolIds.has(tool.id)) throw new Error(`Copilot mutation policy mismatch for ${tool.id}.`);
    if (tool.requiresLlm !== llmToolIds.has(tool.id)) throw new Error(`Copilot LLM metadata mismatch for ${tool.id}.`);
    if (new Set(tool.keywords).size !== tool.keywords.length || tool.keywords.some((keyword) => !keyword.trim())) throw new Error(`Copilot tool ${tool.id} has invalid keywords.`);
  }
  const missing = [...descriptorHandlers].filter((id) => !executableHandlers.has(id));
  const orphaned = handlerIds.filter((id) => !descriptorHandlers.has(id));
  if (missing.length || orphaned.length) throw new Error(`Copilot executable coverage mismatch. Missing handlers: ${missing.join(", ") || "none"}; undocumented handlers: ${orphaned.join(", ") || "none"}.`);
}
