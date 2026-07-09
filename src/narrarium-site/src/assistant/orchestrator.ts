import type { AppSettings } from "@/types/settings";
import { ensureBuiltinCopilotToolsRegistered } from "@/assistant/tools/builtinTools";
import { copilotToolRegistry, isCopilotToolEnabled } from "@/assistant/tools/registry";
import type { AssistantMessage } from "@/assistant/store";

export interface OrchestratorToolContext {
  prompt: string;
  lowered: string;
  settings: AppSettings;
  spokenMode?: boolean;
}

export type OrchestratorHandler = () => Promise<AssistantMessage>;
export type OrchestratorHandlerMap = Record<string, OrchestratorHandler>;

export function isCapabilityQuestion(prompt: string): boolean {
  return /\b(cosa puoi fare|che strumenti hai|come mi puoi aiutare|quali funzionalita supporti|quali funzionalità supporti|what can you do|what tools do you have|how can you help)\b/i.test(prompt);
}

export function buildCapabilitiesMessage(settings: AppSettings): AssistantMessage {
  ensureBuiltinCopilotToolsRegistered();
  const tools = copilotToolRegistry.list().filter((tool) => isCopilotToolEnabled(settings, tool));
  const grouped = new Map<string, string[]>();
  for (const tool of tools) {
    grouped.set(tool.area, [...(grouped.get(tool.area) ?? []), `- ${tool.name}: ${tool.description}`]);
  }
  const sections = [...grouped.entries()].map(([area, lines]) => `**${titleCase(area)}**\n${lines.join("\n")}`).join("\n\n");
  return { id: crypto.randomUUID(), role: "assistant", text: `I can help with these tool groups right now:\n\n${sections}` };
}

export function chooseToolHandlerId(context: OrchestratorToolContext, availableHandlerIds: Set<string>): string | null {
  ensureBuiltinCopilotToolsRegistered();
  const prompt = context.lowered;
  let best: { id: string; score: number } | null = null;
  for (const tool of copilotToolRegistry.list()) {
    if (!tool.handlerId || !availableHandlerIds.has(tool.handlerId)) continue;
    if (!isCopilotToolEnabled(context.settings, tool)) continue;
    let score = 0;
    for (const keyword of tool.keywords) {
      if (prompt.includes(keyword.toLowerCase())) score += Math.max(1, keyword.length);
    }
    if (score <= 0) continue;
    // Prefer local/non-LLM tools on ties to reduce token usage.
    if (!best || score > best.score || (score === best.score && isBetterTie(tool.handlerId, best.id, context.settings))) {
      best = { id: tool.handlerId, score };
    }
  }
  return best?.id ?? null;
}

function isBetterTie(nextId: string, prevId: string, settings: AppSettings): boolean {
  const next = copilotToolRegistry.list().find((tool) => tool.handlerId === nextId);
  const prev = copilotToolRegistry.list().find((tool) => tool.handlerId === prevId);
  if (!next || !prev) return false;
  if (next.requiresLlm !== prev.requiresLlm) return !next.requiresLlm;
  if (next.mutatesData !== prev.mutatesData) return !next.mutatesData;
  return isCopilotToolEnabled(settings, next);
}

function titleCase(value: string): string {
  return value.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
