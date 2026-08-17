import type { AppSettings } from "@/types/settings";
import { ensureBuiltinCopilotToolsRegistered } from "@/assistant/tools/builtinTools";
import { localizeCopilotToolArea, localizeCopilotToolText, localizeCopilotToolsLabel } from "@/assistant/tools/presentation";
import { copilotToolRegistry, isCopilotToolEnabled } from "@/assistant/tools/registry";
import type { AssistantMessage } from "@/assistant/store";
import { isExplicitNavigationPrompt, isReaderEvaluationsNavigationPrompt, matchesToolKeyword } from "@/assistant/orchestratorRules";
import { classifyMutationIntent, type MutationIntent } from "@/assistant/mutationIntent";
import type { CopilotToolContractResult } from "@/assistant/tools/runtimeContract";

export interface OrchestratorToolContext {
  prompt: string;
  lowered: string;
  settings: AppSettings;
  spokenMode?: boolean;
  evaluateContract?: (tool: ReturnType<typeof copilotToolRegistry.list>[number]) => CopilotToolContractResult;
}

export type OrchestratorHandler = () => Promise<AssistantMessage>;
export type OrchestratorHandlerMap = Record<string, OrchestratorHandler>;

export interface OrchestratorToolMatch {
  toolId: string;
  handlerId: string;
  enabled: boolean;
  mutationIntent?: MutationIntent;
  missingRequirements: string[];
}


export function isCapabilityQuestion(prompt: string): boolean {
  return /\b(cosa puoi fare|che strumenti hai|come mi puoi aiutare|quali funzionalita supporti|quali funzionalità supporti|what can you do|what tools do you have|how can you help)\b/i.test(prompt);
}

export function buildCapabilitiesMessage(prompt: string, settings: AppSettings, availableHandlerIds: ReadonlySet<string>, evaluateContract?: OrchestratorToolContext["evaluateContract"]): AssistantMessage {
  ensureBuiltinCopilotToolsRegistered();
  const language = capabilityMessageLanguage(prompt, settings);
  const tools = copilotToolRegistry.list().filter((tool) => (
    isCopilotToolEnabled(settings, tool)
    && Boolean(tool.handlerId)
    && availableHandlerIds.has(tool.handlerId!)
    && (!evaluateContract || evaluateContract(tool).available)
  ));
  const grouped = new Map<string, string[]>();
  for (const tool of tools) {
    const area = localizeCopilotToolArea(tool.area, language);
    const name = localizeCopilotToolText(tool, "name", language);
    const description = localizeCopilotToolText(tool, "description", language);
    grouped.set(area, [...(grouped.get(area) ?? []), `- ${name}: ${description}`]);
  }
  const sections = [...grouped.entries()].map(([area, lines]) => `**${area}**\n${lines.join("\n")}`).join("\n\n");
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    text: `${localizeCopilotToolsLabel("capabilitiesIntro", language, "I can help with these tool groups right now:")}\n\n${sections}`,
  };
}

export function chooseToolHandlerId(context: OrchestratorToolContext, availableHandlerIds: Set<string>): string | null {
  const match = chooseToolMatch(context, availableHandlerIds);
  return match?.enabled && (!match.mutationIntent || match.mutationIntent === "positive") ? match.handlerId : null;
}

export function chooseToolMatch(context: OrchestratorToolContext, availableHandlerIds: Set<string>): OrchestratorToolMatch | null {
  ensureBuiltinCopilotToolsRegistered();
  const prompt = context.lowered;
  if (isReaderEvaluationsNavigationPrompt(prompt) && availableHandlerIds.has("open-reader-evaluations")) {
    const tool = copilotToolRegistry.get("open-reader-evaluations");
    if (tool?.handlerId) return { toolId: tool.id, handlerId: tool.handlerId, enabled: isCopilotToolEnabled(context.settings, tool), missingRequirements: context.evaluateContract?.(tool).missing ?? [] };
  }
  const explicitToolId = explicitIntentToolId(prompt);
  if (explicitToolId) {
    const tool = copilotToolRegistry.get(explicitToolId);
    if (tool?.handlerId && availableHandlerIds.has(tool.handlerId)) {
      return {
        toolId: tool.id,
        handlerId: tool.handlerId,
        enabled: isCopilotToolEnabled(context.settings, tool),
        missingRequirements: context.evaluateContract?.(tool).missing ?? [],
        mutationIntent: tool.mutatesData ? classifyMutationIntent(prompt, tool.id) : undefined,
      };
    }
  }
  let best: { tool: ReturnType<typeof copilotToolRegistry.list>[number]; score: number } | null = null;
  for (const tool of copilotToolRegistry.list()) {
    if (!tool.handlerId || !availableHandlerIds.has(tool.handlerId)) continue;
    // Destination words such as "chapter" or "research" are also common in
    // editorial questions. Navigation must be explicit, otherwise a question
    // is intercepted before it reaches the configured AI router.
    if (tool.handlerId === "navigate" && !isExplicitNavigationPrompt(prompt)) continue;
    let score = 0;
    for (const keyword of tool.keywords) {
      if (matchesToolKeyword(prompt, keyword)) score += Math.max(1, keyword.length);
    }
    if (score <= 0) continue;
    // Prefer local/non-LLM tools on ties to reduce token usage.
    if (!best || score > best.score || (score === best.score && isBetterTie(tool, best.tool, context.settings))) {
      best = { tool, score };
    }
  }
  if (!best?.tool.handlerId) return null;
  return {
    toolId: best.tool.id,
    handlerId: best.tool.handlerId,
    enabled: isCopilotToolEnabled(context.settings, best.tool),
    missingRequirements: context.evaluateContract?.(best.tool).missing ?? [],
    mutationIntent: best.tool.mutatesData ? classifyMutationIntent(prompt, best.tool.id) : undefined,
  };
}

function explicitIntentToolId(prompt: string): string | null {
  if (/\b(?:create|add|write|draft|crea|aggiungi|scrivi|genera)(?:\s+(?:a|an|the|uno?|il))?\s+(?:paragraph|scene|paragrafo|scena)\b/i.test(prompt)) return "create-paragraph";
  if (/\b(?:create|add|write|crea|aggiungi|scrivi|genera)(?:\s+(?:a|an|the|uno?|il))?\s+(?:script|scene script|scaletta)\b/i.test(prompt)) return "create-script";
  if (!/\b(?:feedback|reader|readers|lettore|lettori)\b/i.test(prompt) && /\b(?:create|add|write|generate|crea|aggiungi|scrivi|genera)(?:\s+(?:a|an|the|una?|la))?\s+(?:draft|bozza)\b/i.test(prompt)) return "create-draft";
  if (/\b(?:write|create|refresh|update|save|scrivi|crea|aggiorna|salva)\b[\s\S]*\b(?:chapter resume|resume|riassunto del capitolo|riassunto)\b/i.test(prompt)) return "write-resume";
  if (/\b(?:create|open|make|submit|crea|apri|invia)(?:\s+(?:a|an|the|una?|la))?\s+(?:pull request|pr)\b/i.test(prompt)) return "create-pull-request";
  if (/\b(?:create|add|define|crea|aggiungi|definisci)(?:\s+(?:a|an|the|uno?|il))?\s+(?:(?:custom|simulated|personalizzato|simulato)\s+)?(?:reader|lettore)\b/i.test(prompt)) return "create-simulated-reader";
  if (/\b(?:summarize|compare|write|save|riassumi|sintetizza|confronta|scrivi|salva)\b[\s\S]*\b(?:reader evaluations?|reader reviews?|valutazioni (?:dei |del )?lettori|valutazioni (?:del )?lettore)\b/i.test(prompt)) return "summarize-reader-evaluations";
  if (/\b(?:evaluate|review|run|valuta|recensisci|esegui|fai valutare)\b[\s\S]*\b(?:with|using|con|usando)\s+(?:(?:the|i|dei)\s+)?(?:readers?|lettori)\b/i.test(prompt)) return "evaluate-with-readers";
  if (/\b(?:evaluate|review|valuta|recensisci)\b[\s\S]*\b(?:all|every|tutti|ogni)\b[\s\S]*\b(?:paragraphs?|scenes?|paragrafi|scene)\b/i.test(prompt)) return "evaluate-chapter-paragraphs";
  return null;
}

function isBetterTie(
  next: ReturnType<typeof copilotToolRegistry.list>[number],
  prev: ReturnType<typeof copilotToolRegistry.list>[number],
  settings: AppSettings,
): boolean {
  const nextEnabled = isCopilotToolEnabled(settings, next);
  const prevEnabled = isCopilotToolEnabled(settings, prev);
  if (nextEnabled !== prevEnabled) return !nextEnabled;
  if (next.requiresLlm !== prev.requiresLlm) return !next.requiresLlm;
  if (next.mutatesData !== prev.mutatesData) return !next.mutatesData;
  return false;
}

function capabilityMessageLanguage(prompt: string, settings: AppSettings): "it" | "en" {
  if (/\b(cosa puoi fare|che strumenti hai|come mi puoi aiutare|quali funzionalita supporti|quali funzionalità supporti)\b/i.test(prompt)) return "it";
  if (/\b(what can you do|what tools do you have|how can you help)\b/i.test(prompt)) return "en";
  return settings.ui.language === "it" ? "it" : "en";
}
