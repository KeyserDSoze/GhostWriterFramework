import { DEFAULT_MAX_INPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS, modelWindow, resolveModelTokenBudgets } from "narrarium-engine";
import type { LlmContentPart, LlmMessage } from "@/assistant/llm";

// A model's window, and what it leaves for a prompt, are the engine's (`modelWindow`): the Copilot, Brainstorming and the autopilot judge a prompt by the same window, the
// model's own or the default for a model whose window is not set.
export { DEFAULT_MAX_INPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS, modelWindow, resolveModelTokenBudgets };
export type { ModelWindow, ModelWindowSource } from "narrarium-engine";

const MESSAGE_OVERHEAD_TOKENS = 4;
const IMAGE_TOKENS = 4_096;
const TRUNCATION_NOTICE = "[Context truncated to reserve this model's output tokens and fit its context window.]";
const SHORT_TRUNCATION_NOTICE = "[Context truncated]";
const IMAGE_NOTICE = "[One or more image attachments were omitted to fit this model's context window.]";

const encoder = new TextEncoder();

export function textTokenUpperBound(value: string): number {
  // Byte-level BPE tokenizers cannot emit more tokens than the UTF-8 bytes supplied.
  return encoder.encode(value).byteLength;
}

export function estimateMessageTokens(messages: LlmMessage[]): number {
  return messages.reduce((total, message) => {
    const contentTokens = typeof message.content === "string"
      ? textTokenUpperBound(message.content)
      : message.content.reduce((sum, part) => sum + (part.type === "text" ? textTokenUpperBound(part.text) : IMAGE_TOKENS), 0);
    return total + MESSAGE_OVERHEAD_TOKENS + contentTokens;
  }, 0);
}

/**
 * Likely token count, about four characters per token. Unlike the upper bound it can be lower than
 * the provider's count, so it only serves to refuse prompts that clearly cannot fit a known window.
 */
export function likelyTextTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

export function likelyMessageTokens(messages: LlmMessage[]): number {
  return messages.reduce((total, message) => {
    const contentTokens = typeof message.content === "string"
      ? likelyTextTokens(message.content)
      : message.content.reduce((sum, part) => sum + (part.type === "text" ? likelyTextTokens(part.text) : IMAGE_TOKENS), 0);
    return total + MESSAGE_OVERHEAD_TOKENS + contentTokens;
  }, 0);
}

function takeUtf8(value: string, maxBytes: number, fromEnd = false): string {
  const characters = Array.from(value);
  let bytes = 0;
  const selected: string[] = [];
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[fromEnd ? characters.length - 1 - index : index];
    const size = textTokenUpperBound(character);
    if (bytes + size > maxBytes) break;
    bytes += size;
    if (fromEnd) selected.unshift(character); else selected.push(character);
  }
  return selected.join("");
}

function truncateText(text: string, maxTokens: number): string {
  if (textTokenUpperBound(text) <= maxTokens) return text;
  const noticeTokens = textTokenUpperBound(TRUNCATION_NOTICE) + 2;
  if (maxTokens <= noticeTokens) {
    if (maxTokens <= textTokenUpperBound(SHORT_TRUNCATION_NOTICE)) return takeUtf8(text, maxTokens);
    const markerTokens = textTokenUpperBound(SHORT_TRUNCATION_NOTICE);
    return `${takeUtf8(text, maxTokens - markerTokens)}${SHORT_TRUNCATION_NOTICE}`;
  }
  const remaining = maxTokens - noticeTokens;
  const head = Math.ceil(remaining * 0.6);
  return `${takeUtf8(text, head)}\n${TRUNCATION_NOTICE}\n${takeUtf8(text, remaining - head, true)}`;
}

/**
 * Approximate provider tokenization conservatively, preserving the beginning and end of
 * every text block so instructions and the latest request remain visible after truncation.
 */
export function budgetLlmMessages(messages: LlmMessage[], maxContextTokens = DEFAULT_MAX_INPUT_TOKENS, maxOutputTokens?: number, reservedInputTokens = 0): LlmMessage[] {
  const { inputTokens: maxInputTokens } = resolveModelTokenBudgets(maxContextTokens, maxOutputTokens);
  const messageBudget = Math.max(0, maxInputTokens - Math.max(0, Math.floor(reservedInputTokens)));
  if (estimateMessageTokens(messages) <= messageBudget) return messages;

  const messageSlots = Math.floor(messageBudget / (MESSAGE_OVERHEAD_TOKENS + 1));
  if (messageSlots === 0) return [];
  let retainedMessages = messages;
  if (messages.length > messageSlots) {
    const firstSystem = messages[0]?.role === "system" ? messages[0] : undefined;
    const recentSlots = firstSystem && messageSlots > 1 ? messageSlots - 1 : messageSlots;
    const recent = messages.slice(-recentSlots);
    retainedMessages = firstSystem && !recent.includes(firstSystem) ? [firstSystem, ...recent] : recent;
  }
  const cloned = retainedMessages.map((message) => ({
    ...message,
    content: Array.isArray(message.content) ? message.content.map((part) => ({ ...part })) : message.content,
  }));
  const overhead = cloned.length * MESSAGE_OVERHEAD_TOKENS;
  let available = Math.max(0, messageBudget - overhead);
  let omittedImages = 0;

  for (const message of cloned) {
    if (!Array.isArray(message.content)) continue;
    const retained: LlmContentPart[] = [];
    for (const part of message.content) {
      if (part.type === "image" && available >= IMAGE_TOKENS) {
        retained.push(part);
        available -= IMAGE_TOKENS;
      } else if (part.type === "image") {
        omittedImages += 1;
      } else {
        retained.push(part);
      }
    }
    message.content = retained;
  }

  const textParts: Array<{ get: () => string; set: (value: string) => void }> = [];
  for (const message of cloned) {
    if (typeof message.content === "string") {
      textParts.push({ get: () => message.content as string, set: (value) => { message.content = value; } });
    } else {
      for (const part of message.content) {
        if (part.type === "text") textParts.push({ get: () => part.text, set: (value) => { part.text = value; } });
      }
    }
  }
  if (omittedImages && textParts.length) {
    const last = textParts[textParts.length - 1];
    last.set(`${last.get()}\n\n${IMAGE_NOTICE}`);
  }

  const totalTokens = textParts.reduce((sum, part) => sum + textTokenUpperBound(part.get()), 0);
  if (totalTokens > available && totalTokens > 0) {
    let remainingTokens = available;
    let remainingSourceTokens = totalTokens;
    for (const [index, part] of textParts.entries()) {
      const source = part.get();
      const sourceTokens = textTokenUpperBound(source);
      const share = index === textParts.length - 1
        ? remainingTokens
        : Math.floor(remainingTokens * sourceTokens / remainingSourceTokens);
      part.set(truncateText(source, Math.max(0, share)));
      remainingTokens -= Math.min(share, textTokenUpperBound(part.get()));
      remainingSourceTokens -= sourceTokens;
    }
  }
  return cloned;
}
