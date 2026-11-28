import type { LlmMessage } from "@/assistant/llm";
import { chatTextTokens, resolveModelTokenBudgets, type ModelWindow } from "@/assistant/promptBudget";
import { TOOL_RESULTS_WARNING } from "@/assistant/toolResults";

/**
 * How full the context of a chat is (#122): what a request of the Copilot or of Brainstorming carries, part by part, against the window of the model it goes to. The tokens are
 * the repo's likely estimate (`likelyTextTokens`, about four characters a token, the one the engine judges a window with; never fewer than one a character beyond ASCII,
 * `chatTextTokens`), corrected by what the provider counted for the requests of the same model (`tokenRatio`): the provider's own count is the measure, and the estimate only
 * covers what it has not counted yet (the new messages, the draft).
 */

/** The parts of a request, as the chat shows them. */
export type ContextPart = "system" | "files" | "pageState" | "attachments" | "summary" | "conversation" | "request";

export const CONTEXT_PARTS: readonly ContextPart[] = ["system", "files", "pageState", "attachments", "summary", "conversation", "request"];

/** A request as it was sent, in likely tokens, part by part: the instructions and the tools, the book's files and canon, the page, the attachments, the summary of what was compacted, the conversation, the request. */
export interface RequestShape {
  system: number;
  /** The tokens of the schema of a forced function. */
  tools: number;
  files: number;
  pageState: number;
  attachments: number;
  summary: number;
  conversation: number;
  request: number;
  /** What the tools gave in the rounds of a turn: not sent again with the next message. */
  results: number;
  other: number;
}

const MESSAGE_OVERHEAD_TOKENS = 4;
const IMAGE_TOKENS = 4_096;

/** The part of a request a block of the prompt belongs to, by its name (`untrustedData`, `currentRequest`). */
function partOfBlock(name: string, content: string): keyof RequestShape {
  switch (name) {
    case "repository_content":
      return content.startsWith(`${TOOL_RESULTS_WARNING}\nTOOL RESULTS:`) ? "results" : "files";
    case "repository_manifest":
    case "external_content":
    case "metadata":
      return "files";
    case "page_state":
      return "pageState";
    case "attachment_content":
    case "attachment_manifest":
    case "pasted_material":
    case "user_content":
      return "attachments";
    case "compaction_summary":
      return "summary";
    case "prior_transcript":
      return "conversation";
    case "current_request":
      return "request";
    default:
      return "other";
  }
}

const BLOCK = /<([a-z_]+) trust="(?:untrusted-data|user-instruction)">\n([\s\S]*?)\n<\/\1>/g;

/** Adds a text to a shape: its blocks to their parts, the rest to `rest`. */
function addText(shape: RequestShape, text: string, rest: keyof RequestShape): void {
  const outside: string[] = [];
  let last = 0;
  for (const match of text.matchAll(BLOCK)) {
    outside.push(text.slice(last, match.index ?? 0));
    last = (match.index ?? 0) + match[0].length;
    shape[partOfBlock(match[1], match[2])] += chatTextTokens(match[0]);
  }
  outside.push(text.slice(last));
  shape[rest] += chatTextTokens(outside.join(""));
}

export function emptyShape(): RequestShape {
  return { system: 0, tools: 0, files: 0, pageState: 0, attachments: 0, summary: 0, conversation: 0, request: 0, results: 0, other: 0 };
}

/** The shape of a request as it is sent: the system message is the instructions (the manifest of the files in it is the files), the user message is read block by block. */
export function requestShape(messages: readonly LlmMessage[], toolTokens = 0): RequestShape {
  const shape = emptyShape();
  shape.tools = Math.max(0, Math.round(toolTokens));
  for (const message of messages) {
    shape[message.role === "system" ? "system" : "other"] += MESSAGE_OVERHEAD_TOKENS;
    const parts = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    for (const part of parts) {
      if (part.type === "text") addText(shape, part.text, message.role === "system" ? "system" : "other");
      else shape.attachments += IMAGE_TOKENS;
    }
  }
  return shape;
}

export function shapeTotal(shape: RequestShape): number {
  return Object.values(shape).reduce((sum, value) => sum + value, 0);
}

/**
 * The conversation as a request carries it (`prior_transcript`): every message of the author and of the assistant, its role and its words, in order. The chat's own notes
 * (`system`: what `/context` prints, a request that did not fit) are not part of it. The Copilot and Brainstorming send it this way, and the ring counts it this way.
 */
export function conversationText(messages: readonly { role: string; text: string }[]): string {
  return messages.filter((message) => message.role !== "system" && message.text.trim()).map((message) => `${message.role.toUpperCase()}: ${message.text.trim()}`).join("\n\n");
}

/** The tokens of a text as it goes in a block of the prompt (its tag and warning included), as the chat counts them (`chatTextTokens`). */
export function blockTokens(text: string): number {
  return text ? chatTextTokens(text) + 24 : 0;
}

/**
 * The ratio between what a provider counted and the likely estimate, by model: learned from the calls of this tab, or from the last request of a chat (its shape and the usage
 * its provider reported, kept with the chat). 1.25 for a model not measured yet: prose in Italian, markdown and the schemas of the tools take more tokens than four characters
 * each, and a request is never cut, nor compacted, later than the window really ends. A count that no tokenizer gives (a provider or a proxy that reports a fixed number) is
 * not a measure.
 */
const ratios = new Map<string, number>();
export const DEFAULT_TOKEN_RATIO = 1.25;
const MIN_RATIO = 0.6;
const MAX_RATIO = 2.5;
const ratioKey = (integrationId: string | undefined, model: string | undefined) => `${integrationId ?? ""}\u0000${model ?? ""}`;

function measuredRatio(likely: number, reportedInputTokens: number): number | null {
  if (!(likely > 200) || !(reportedInputTokens > 0)) return null;
  const ratio = reportedInputTokens / likely;
  return ratio >= MIN_RATIO && ratio <= MAX_RATIO ? ratio : null;
}

/** The ratio of a model: the one this tab measured, else the one of the chat's last request when it went to the same model, else the default. */
export function tokenRatio(candidate: { integrationId?: string; model?: string } | null | undefined, last?: { integrationId: string; model: string; shape: RequestShape; usage?: { inputTokens: number } } | null): number {
  const known = candidate ? ratios.get(ratioKey(candidate.integrationId, candidate.model)) : undefined;
  if (known !== undefined) return known;
  if (candidate && last?.usage && last.integrationId === candidate.integrationId && last.model === candidate.model) {
    const seeded = measuredRatio(shapeTotal(last.shape), last.usage.inputTokens);
    if (seeded !== null) return seeded;
  }
  return DEFAULT_TOKEN_RATIO;
}

/** What a provider counted for a request the router estimated at `likely`: the ratio of its model moves halfway to it (a single odd request does not decide it). */
export function recordTokenUsage(candidate: { integrationId?: string; model?: string }, likely: number, reportedInputTokens: number): void {
  const measured = measuredRatio(likely, reportedInputTokens);
  if (measured === null) return;
  const key = ratioKey(candidate.integrationId, candidate.model);
  const known = ratios.get(key);
  ratios.set(key, known === undefined ? measured : (known + measured) / 2);
}

export function forgetTokenRatios(): void {
  ratios.clear();
}

export type ContextState = "normal" | "full" | "compacting" | "over";

/** The least start a provider caches (OpenAI and Anthropic alike: about 1,024 tokens): a shorter one is read again each time. */
export const MIN_CACHED_PREFIX = 1_024;

export interface ContextEstimate {
  /** The parts of the next request, in tokens (likely, times the ratio of the model). `attachments` holds the material set apart too (`material`). */
  parts: Record<ContextPart, number>;
  /** Of `parts.attachments`, the material the author set apart: sent whole, and only the window may cut it (the reply says so). */
  material: number;
  total: number;
  window: ModelWindow;
  /** What the window leaves for a request once the answer and a 5% margin are set aside: past it, the request is cut. */
  inputBudget: number;
  /** Where an automatic compaction starts: the threshold of the settings, never past the room for a request. */
  compactAt: number;
  /** The share of the window the next request takes, 0 to 100 (more when it does not fit). */
  percent: number;
  state: ContextState;
  /** The instructions, the files and the page are the ones of a request that was sent (else they are not counted yet). */
  measured: boolean;
  ratio: number;
  /** The part of the next request that is the same as the start of the last one: what a provider that caches prompts may serve from its cache. */
  cacheable: number;
}

/** What the next request has in common with the last one, in the order a request is made of (see `estimateContext`). */
export interface SameStart {
  attachments: boolean;
  summary: boolean;
  material: boolean;
}

export interface ContextEstimateInput {
  /** The last request of the chat, when there was one: its instructions, tools, files and page are what the next one carries too. */
  shape: RequestShape | null;
  /** The attached files and images the next request carries, in likely tokens (`attachmentTokens`). */
  attachments: number;
  /** The material set apart that it carries, in likely tokens. */
  material: number;
  /** The summary of the compacted conversation that goes with the next request (`""` when none). */
  summary: string;
  /** The conversation that goes with it, as it is sent (`conversationText`). */
  conversation: string;
  /** What the author is writing. */
  draft: string;
  window: ModelWindow;
  /** The room the model's answer takes in its window. */
  outputTokens?: number;
  ratio: number;
  /** The threshold of the automatic compaction, in % of the window. */
  threshold: number;
  compacting?: boolean;
  /** What is the same as in the last request (absent: nothing is known of it). */
  same?: SameStart;
  /** The Copilot sends the material before the conversation, Brainstorming after the request. */
  materialBeforeConversation?: boolean;
  /** The model does not cache prompts (its row says so): nothing is served from a cache. */
  noCache?: boolean;
}

export function estimateContext(input: ContextEstimateInput): ContextEstimate {
  const shape = input.shape;
  const ratio = input.ratio;
  const scale = (value: number) => Math.round(value * ratio);
  const material = scale(input.material);
  const parts: Record<ContextPart, number> = {
    system: scale((shape?.system ?? 0) + (shape?.tools ?? 0) + (shape?.other ?? 0)),
    files: scale(shape?.files ?? 0),
    pageState: scale(shape?.pageState ?? 0),
    attachments: scale(input.attachments) + material,
    summary: scale(blockTokens(input.summary)),
    conversation: scale(blockTokens(input.conversation)),
    request: scale(input.draft.trim() ? blockTokens(input.draft) : 0),
  };
  const total = CONTEXT_PARTS.reduce((sum, part) => sum + parts[part], 0);
  const budgets = resolveModelTokenBudgets(input.window.tokens, input.outputTokens);
  const inputBudget = budgets.inputTokens;
  const compactAt = Math.min(Math.round((input.window.tokens * input.threshold) / 100), Math.round(inputBudget * 0.97));
  const state: ContextState = input.compacting ? "compacting" : total > inputBudget ? "over" : total >= compactAt * 0.85 ? "full" : "normal";
  return {
    parts,
    material,
    total,
    window: input.window,
    inputBudget,
    compactAt,
    percent: Math.round((total / Math.max(1, input.window.tokens)) * 100),
    state,
    measured: Boolean(shape),
    ratio,
    cacheable: input.noCache || !shape || !input.same ? 0 : cacheableStart(parts, material, scale(shape.conversation), input.same, input.materialBeforeConversation ?? true),
  };
}

/**
 * The start the next request has in common with the last one, which a provider that caches prompts serves from its cache: the instructions and the tools, the files, then the
 * attachments, the summary and the page while they are the same, then (in the Copilot) the material, then the conversation that was sent before. The first part that changed ends
 * it; the new messages and the request follow it. A start shorter than what a provider caches is not served from a cache.
 */
function cacheableStart(parts: Record<ContextPart, number>, material: number, previousConversation: number, same: SameStart, materialBefore: boolean): number {
  let start = parts.system + parts.files;
  const sequence: Array<[boolean, number]> = [
    [same.attachments, parts.attachments - material],
    [same.summary, parts.summary + parts.pageState],
    ...(materialBefore ? [[same.material, material] as [boolean, number]] : []),
    [true, Math.min(previousConversation, parts.conversation)],
  ];
  for (const [kept, tokens] of sequence) {
    if (!kept) break;
    start += tokens;
  }
  return start >= MIN_CACHED_PREFIX ? start : 0;
}

/** The likely tokens of the attachments of a chat as a request carries them: the text of the files within their limit, an image as the app counts one, the material set apart whole. */
export function attachmentTokens(attachments: readonly { kind: string; material?: boolean; textContent?: string; name: string }[], sentFileChars: number | null, readsFiles: boolean): { files: number; material: number } {
  const materialText = attachments.filter((attachment) => attachment.material && attachment.kind === "text").map((attachment) => attachment.textContent ?? "").join("\n\n");
  const material = materialText ? chatTextTokens(materialText.slice(0, MATERIAL_MAX_CHARS)) + 24 : 0;
  if (!readsFiles) return { files: 0, material };
  const fileText = attachments.filter((attachment) => attachment.kind === "text" && !attachment.material).map((attachment) => attachment.textContent ?? "").join("");
  // The text the limits of the attachments let through: its share of the whole, counted as the whole is.
  const textTokens = fileText ? Math.ceil(chatTextTokens(fileText) * Math.min(1, (sentFileChars ?? fileText.length) / fileText.length)) + 24 : 0;
  const images = attachments.filter((attachment) => attachment.kind === "image");
  const files = textTokens + (images.length ? images.length * IMAGE_TOKENS + Math.ceil(images.reduce((sum, image) => sum + image.name.length + 40, 0) / 4) + 24 : 0);
  return { files, material };
}

/** The most of a pasted text the Copilot sends (`materialBlock`): the ring counts no more of it. */
export const MATERIAL_MAX_CHARS = 400_000;

/** The estimated cost of the next request's input at the model's prices (the part a cache may serve at its cached price), and of an answer as long as the last one: `null` without an input price. */
export function nextRequestCost(estimate: Pick<ContextEstimate, "total" | "cacheable">, pricing: { inputPerMTok?: number; cachedPerMTok?: number; outputPerMTok?: number } | undefined, lastOutputTokens?: number): { input: number; output: number | null } | null {
  if (!pricing?.inputPerMTok) return null;
  const cached = pricing.cachedPerMTok ?? pricing.inputPerMTok;
  const input = ((estimate.total - estimate.cacheable) * pricing.inputPerMTok + estimate.cacheable * cached) / 1_000_000;
  const output = pricing.outputPerMTok && lastOutputTokens ? (lastOutputTokens * pricing.outputPerMTok) / 1_000_000 : null;
  return { input, output };
}

/** The share of an input the provider served from its cache, 0 to 1: what it reported, never an estimate. */
export function reportedCachedShare(usage: { inputTokens: number; cachedInputTokens: number } | undefined): number | null {
  if (!usage || !(usage.inputTokens > 0)) return null;
  return Math.min(1, Math.max(0, usage.cachedInputTokens / usage.inputTokens));
}
