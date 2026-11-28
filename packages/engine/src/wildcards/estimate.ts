import { likelyTextTokens } from "../ai/budget.js";
import type { EstimateModel } from "../autopilot/estimate.js";
import { WILDCARD_MAX_VOICES } from "../profiles/wildcards.js";
import { WILDCARD_IDEAS_TOOL, WILDCARD_MAX_IDEAS_PER_VOICE } from "./ideas.js";
import { WILDCARD_OUTPUT_TOKENS } from "./room.js";
import { WILDCARD_TRIAGE_TOOL } from "./triage.js";

/**
 * What a consultation of the room will cost before it runs, as an interval: at the least every voice answers at once and briefly, and the voices after
 * the first are served the shared start of their prompt from the provider's cache (when the model declares a cached price); at the most every voice is
 * asked twice (a reply that could not be read) and fills its output limit, with no cache. The Director's triage, when there is one, is counted the same way.
 */

/** Characters of the parts of a voice's prompt that are not the material or the book: the room's instructions, the persona, the request. */
const VOICE_FIXED_CHARS = 3_200;
/** Tokens of an answer of a voice at the least. */
const VOICE_SHORT_ANSWER_TOKENS = 500;
/** Characters of one idea as the Director reads it. */
const IDEA_CHARS = 520;
const TRIAGE_FIXED_CHARS = 2_600;
const TRIAGE_SHORT_ANSWER_TOKENS = 400;
const TRIAGE_OUTPUT_TOKENS = 3_000;

export interface WildcardRoomEstimateInput {
  voices: number;
  /** Characters of what the room reads, and of the book's context every voice shares (synopsis, canon, story so far, secrets). */
  materialChars: number;
  contextChars?: number;
  outputTokens?: number;
  /** The model the room is routed to (`estimateModelOf(config, "wildcards")`): without a price there is no cost. */
  model?: EstimateModel | null;
  /** The Director's triage after the room (the autopilot): the Director's model. */
  triage?: { model?: EstimateModel | null };
  currency?: string;
}

export interface WildcardRoomEstimate {
  calls: { min: number; max: number };
  inputTokens: { min: number; max: number };
  outputTokens: { min: number; max: number };
  /** `null` when a model that makes calls has no price. */
  cost: { min: number; max: number; currency?: string } | null;
}

function price(model: EstimateModel | null | undefined): { input: number; output: number; cached?: number } | null {
  const pricing = model?.pricing;
  if (!pricing || typeof pricing.inputPerMTok !== "number" || typeof pricing.outputPerMTok !== "number") return null;
  const cached = typeof pricing.cachedPerMTok === "number" && model?.promptCaching !== "unsupported" ? Math.min(pricing.cachedPerMTok, pricing.inputPerMTok) : undefined;
  return { input: pricing.inputPerMTok, output: pricing.outputPerMTok, ...(cached !== undefined ? { cached } : {}) };
}

export function estimateWildcardRoom(input: WildcardRoomEstimateInput): WildcardRoomEstimate {
  const voices = Math.max(0, Math.min(WILDCARD_MAX_VOICES, Math.round(input.voices)));
  const outputLimit = Math.max(1, Math.round(input.outputTokens ?? WILDCARD_OUTPUT_TOKENS));
  const tool = likelyTextTokens(JSON.stringify(WILDCARD_IDEAS_TOOL)) + 8;
  const shared = Math.ceil((Math.max(0, input.materialChars) + Math.max(0, input.contextChars ?? 0)) / 4);
  const own = Math.ceil(VOICE_FIXED_CHARS / 4) + tool;
  const perVoice = shared + own;
  const room = {
    calls: { min: voices, max: voices * 2 },
    input: { min: voices * perVoice, max: voices * 2 * perVoice },
    output: { min: voices * Math.min(outputLimit, VOICE_SHORT_ANSWER_TOKENS), max: voices * 2 * outputLimit },
    // The shared start of the prompts of the voices after the first, at the cached price in the best case.
    cachedMin: Math.max(0, voices - 1) * shared,
  };
  const roomPrice = price(input.model);
  let cost: { min: number; max: number } | null = voices === 0 ? { min: 0, max: 0 } : roomPrice ? {
    min: ((room.input.min - (roomPrice.cached !== undefined ? room.cachedMin : 0)) * roomPrice.input + (roomPrice.cached !== undefined ? room.cachedMin * roomPrice.cached : 0) + room.output.min * roomPrice.output) / 1_000_000,
    max: (room.input.max * roomPrice.input + room.output.max * roomPrice.output) / 1_000_000,
  } : null;
  const calls = { ...room.calls };
  const inputTokens = { ...room.input };
  const outputTokens = { ...room.output };
  if (input.triage && voices > 0) {
    const ideas = voices * WILDCARD_MAX_IDEAS_PER_VOICE * IDEA_CHARS;
    const triageInput = Math.ceil((Math.max(0, input.materialChars) + Math.max(0, input.contextChars ?? 0) + ideas + TRIAGE_FIXED_CHARS) / 4) + likelyTextTokens(JSON.stringify(WILDCARD_TRIAGE_TOOL)) + 8;
    calls.min += 1;
    calls.max += 2;
    inputTokens.min += triageInput;
    inputTokens.max += triageInput * 2;
    outputTokens.min += TRIAGE_SHORT_ANSWER_TOKENS;
    outputTokens.max += TRIAGE_OUTPUT_TOKENS * 2;
    const triagePrice = price(input.triage.model);
    cost = cost && triagePrice ? {
      min: cost.min + (triageInput * triagePrice.input + TRIAGE_SHORT_ANSWER_TOKENS * triagePrice.output) / 1_000_000,
      max: cost.max + (triageInput * 2 * triagePrice.input + TRIAGE_OUTPUT_TOKENS * 2 * triagePrice.output) / 1_000_000,
    } : null;
  }
  return { calls, inputTokens, outputTokens, cost: cost ? { ...cost, ...(input.currency ? { currency: input.currency } : {}) } : null };
}
