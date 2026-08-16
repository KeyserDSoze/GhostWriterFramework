import type { LlmContentPart, LlmMessage } from "@/assistant/llm";

const MESSAGE_OVERHEAD_TOKENS = 4;
const IMAGE_TOKENS = 4_096;
const TRUNCATION_NOTICE = "[Context truncated to reserve this model's output tokens and fit its context window.]";
const SHORT_TRUNCATION_NOTICE = "[Context truncated]";
const IMAGE_NOTICE = "[One or more image attachments were omitted to fit this model's context window.]";
export const DEFAULT_MAX_INPUT_TOKENS = 32_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 2_048;

const encoder = new TextEncoder();

export function textTokenUpperBound(value: string): number {
  // Byte-level BPE tokenizers cannot emit more tokens than the UTF-8 bytes supplied.
  return encoder.encode(value).byteLength;
}

export function resolveModelTokenBudgets(maxContextTokens = DEFAULT_MAX_INPUT_TOKENS, configuredOutputTokens?: number): { contextTokens: number; inputTokens: number; outputTokens: number; safetyTokens: number } {
  const contextTokens = Math.max(3, Math.floor(maxContextTokens || DEFAULT_MAX_INPUT_TOKENS));
  const safetyTokens = Math.min(Math.max(32, Math.ceil(contextTokens * 0.05)), contextTokens - 2);
  const requestedOutput = configuredOutputTokens && configuredOutputTokens > 0
    ? Math.floor(configuredOutputTokens)
    : Math.min(DEFAULT_MAX_OUTPUT_TOKENS, Math.max(1, Math.floor(contextTokens * 0.25)));
  const outputTokens = Math.min(requestedOutput, Math.max(1, contextTokens - safetyTokens - 1));
  return { contextTokens, inputTokens: contextTokens - safetyTokens - outputTokens, outputTokens, safetyTokens };
}

export function estimateMessageTokens(messages: LlmMessage[]): number {
  return messages.reduce((total, message) => {
    const contentTokens = typeof message.content === "string"
      ? textTokenUpperBound(message.content)
      : message.content.reduce((sum, part) => sum + (part.type === "text" ? textTokenUpperBound(part.text) : IMAGE_TOKENS), 0);
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
