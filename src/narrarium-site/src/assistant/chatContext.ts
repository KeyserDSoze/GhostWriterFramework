import { attachmentTextCut } from "@/assistant/attachmentText";
import { attachmentTokens, blockTokens, conversationText, estimateContext, nextRequestCost, reportedCachedShare, tokenRatio, type ContextEstimate } from "@/assistant/contextBudget";
import { chatCapability, conversationToSend, SUMMARY_TOKENS_GUESS, type ConversationToSend } from "@/assistant/contextCompaction";
import { engineOutputLimit, requestedOutput, toolsOnly, type ChatCandidate } from "@/assistant/copilotAi";
import { modelWindow, resolveModelTokenBudgets } from "@/assistant/promptBudget";
import { resolveEffectiveTaskCandidates } from "@/assistant/router";
import type { AssistantAttachment, AssistantMessage, AssistantSession, ContextLastRequest } from "@/assistant/store";
import { DEFAULT_CONTEXT_COMPACTION, type AppSettings, type ChatCapability, type ContextCompactionSettings } from "@/types/settings";

/**
 * How full the context of a chat is, for its ring (#122): the window of the model the next request goes to (the first of its route), the parts of that request as the chat would
 * send it now with what the author is writing, the share a provider may serve from its cache, and the cost at the model's prices. Pure: the panel calls it on each change.
 */

export interface ChatContextModel {
  integrationId: string;
  integrationName: string;
  model: string;
}

export interface ChatContext {
  capability: ChatCapability;
  /** The model the next request goes to first (`null`: no model is set for the chat). */
  model: ChatContextModel | null;
  estimate: ContextEstimate;
  compaction: ContextCompactionSettings;
  /** What the next request carries of the conversation. */
  conversation: ConversationToSend;
  /** What the provider reported for the chat's last request: its input, the part of it served from its cache. */
  measured: { inputTokens: number; cachedInputTokens: number; share: number } | null;
  /** The next request at the model's prices (its input, and an answer as long as the last one); `null` without prices. */
  cost: { input: number; output: number | null } | null;
  /** The model does not cache prompts (its row in AI Integrations says so). */
  noCache: boolean;
}

/** The first model of the route of a chat's task, as the router would ask it: with «Tools only» on, the Copilot's tool loop skips a model without tool calls. */
export function firstChatCandidate(settings: AppSettings, capability: ChatCapability): ChatCandidate | null {
  const strict = capability === "copilot" && toolsOnly(settings);
  const candidate = resolveEffectiveTaskCandidates(settings, capability).find((entry) => entry.integration && entry.model && !(strict && entry.supportsToolCalls === false));
  return (candidate as ChatCandidate | undefined) ?? null;
}

export function compactionSettings(settings: AppSettings): ContextCompactionSettings {
  return settings.contextCompaction ?? DEFAULT_CONTEXT_COMPACTION;
}

/** What tells whether the attachments of the next request are the ones of the last request. */
export function attachmentsKey(attachments: readonly Pick<AssistantAttachment, "id">[]): string {
  return attachments.map((attachment) => attachment.id).join(",");
}

/** What tells whether the summary of the next request is the one of the last request. */
export function summaryKey(conversation: ConversationToSend): string {
  return conversation.compaction?.id ?? (conversation.summary ? `archive:${conversation.summary.length}` : "");
}

export function chatContextOf(input: { session: Pick<AssistantSession, "mode" | "messages" | "attachments" | "contextCompactions" | "contextLast" | "archive" | "compactSummary">; settings: AppSettings; draft: string; compacting?: boolean }): ChatContext {
  const { session, settings } = input;
  const capability = chatCapability(session.mode);
  const candidate = firstChatCandidate(settings, capability);
  const window = modelWindow(candidate);
  const outputTokens = candidate ? engineOutputLimit(settings, candidate, capability, requestedOutput(candidate), capability === "copilot") : undefined;
  const last: ContextLastRequest | undefined = session.contextLast;
  const ratio = tokenRatio(candidate ? { integrationId: candidate.integration.id, model: candidate.model } : null, last);
  const conversation = conversationToSend(session);
  const readsFiles = capability === "copilot";
  const sentFileChars = readsFiles ? attachmentTextCut(settings, session.attachments)?.sent ?? null : null;
  const attached = attachmentTokens(session.attachments, sentFileChars, readsFiles);
  const noCache = Boolean(candidate && candidate.integration.chatModels?.find((model) => model.name === candidate.model)?.promptCaching === "unsupported");
  const sameModel = Boolean(last && candidate && last.integrationId === candidate.integration.id && last.model === candidate.model);
  const sameAttachments = Boolean(last && last.attachmentsKey === attachmentsKey(session.attachments));
  const compaction = compactionSettings(settings);
  const estimate = estimateContext({
    shape: last?.shape ?? null,
    attachments: attached.files,
    material: attached.material,
    summary: conversation.summary,
    conversation: conversationText(conversation.messages),
    draft: input.draft,
    window,
    ...(outputTokens ? { outputTokens } : {}),
    ratio,
    threshold: compaction.threshold,
    compacting: input.compacting,
    ...(last && sameModel ? { same: { attachments: sameAttachments, summary: (last.summaryKey ?? "") === summaryKey(conversation), material: sameAttachments && !last.pasted } } : {}),
    materialBeforeConversation: capability === "copilot",
    noCache,
  });
  const share = reportedCachedShare(last?.usage);
  return {
    capability,
    model: candidate ? { integrationId: candidate.integration.id, integrationName: candidate.integration.name, model: candidate.model } : null,
    estimate,
    compaction,
    conversation,
    measured: last?.usage && share !== null ? { inputTokens: last.usage.inputTokens, cachedInputTokens: last.usage.cachedInputTokens, share } : null,
    cost: nextRequestCost(estimate, candidate?.pricing, last?.usage?.outputTokens),
    noCache,
  };
}

/** Whether the next request would go out cut: past the room of the window with all that the chat sends but the material set apart (which only the window may cut, and the reply says so). */
export function doesNotFit(estimate: ContextEstimate): boolean {
  return estimate.total - estimate.material > estimate.inputBudget;
}

/** Whether the chat should compact before its next request: on, and the request at its point. */
export function wantsCompaction(context: ChatContext): boolean {
  return context.compaction.auto && context.estimate.total >= context.estimate.compactAt;
}

/** What the next request would take if a compaction kept only `kept` of the messages (as they are) and a summary of about `SUMMARY_TOKENS_GUESS`. */
export function estimateWithKept(context: ChatContext, kept: readonly AssistantMessage[]): number {
  const { estimate } = context;
  const rest = estimate.total - estimate.parts.conversation - estimate.parts.summary;
  return rest + Math.round((blockTokens(conversationText(kept)) + SUMMARY_TOKENS_GUESS) * estimate.ratio);
}

/** How much of the conversation the summariser reads: what the window of the model of `chat-resume` holds, in characters (about three a token, to be safe), at least 20,000. */
export function summaryInputChars(settings: AppSettings): number {
  const candidate = resolveEffectiveTaskCandidates(settings, "chat-resume").find((entry) => entry.integration && entry.model) as ChatCandidate | undefined;
  const window = modelWindow(candidate);
  const output = candidate ? engineOutputLimit(settings, candidate, "chat-resume", requestedOutput(candidate), false) : undefined;
  const room = resolveModelTokenBudgets(window.tokens, output).inputTokens;
  return Math.max(20_000, Math.min(1_200_000, Math.floor(room * 3) - 4_000));
}
