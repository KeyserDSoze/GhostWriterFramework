import { DEFAULT_MAX_INPUT_TOKENS, likelyTextTokens, resolveModelTokenBudgets } from "../ai/budget.js";
import { AiReplyRejectedError, WILDCARDS_CAPABILITY, type AiPort, type AiResponse, type AiUsage } from "../ai/types.js";
import { currentRequest, untrustedData, unescapePromptDataDeep } from "../prompt/trust.js";
import { WILDCARD_MAX_VOICES, wildcardPersonaPrompt, type WildcardProfile } from "../profiles/wildcards.js";
import { clipMiddle, languageName } from "../util/text.js";
import { WILDCARD_IDEAS_TOOL, WILDCARD_MAX_IDEAS_PER_VOICE, readWildcardReply, type WildcardIdea, type WildcardTarget } from "./ideas.js";

/**
 * The room: several wildcards asked about the same material, each in a call of its own, in parallel up to a cap. Every voice answers with the structured
 * reply of `WILDCARD_IDEAS_TOOL`, read by `readWildcardReply`; a reply that cannot be read is asked again once, with what was wrong. Nothing is cut in
 * silence: material shortened to fit the model's window says so (in the prompt and in the result), ideas beyond the cap are counted, voices beyond the cap
 * are counted, a reply the output limit cut is marked. What the room gives is advisory: it never carries a score and never gates a step.
 *
 * Every voice's prompt starts the same way (the instructions of the room, then the book and the material), and only then says who the voice is and what it
 * may know of the secrets, so that a provider that caches the start of a prompt serves the shared part to every voice after the first.
 */

/** Voices asked at once, at most. */
export const WILDCARD_MAX_PARALLEL = 4;
/** The reply of a voice, in tokens. */
export const WILDCARD_OUTPUT_TOKENS = 2_400;
/**
 * What the request of a voice keeps free for its answer when the material is sized: the structured floor and the margin of a model that reasons
 * (`requestOutputLimit`), so that a material sized here is never refused by the router for the window.
 */
const OUTPUT_RESERVE_TOKENS = 4_096 + 12_000;

export interface WildcardRoomContext {
  /** The book's title and language, and what every voice may read of it: its synopsis, the canon without the secrets, the story so far. */
  title: string;
  language: string;
  synopsis?: string;
  canon?: string;
  storySoFar?: string;
}

export interface WildcardRoomSecrets {
  /** The secrets the material may know (their `reveal_in`, else `known_from`, reached): what every voice is told. Empty: none. */
  threshold: string;
  /** Every secret with its rule, as the author knows them: told only to a sentinel whose access is `author` (the Secrets Guardian). */
  author: string;
}

export interface WildcardRoomInput {
  ai: AiPort;
  voices: readonly WildcardProfile[];
  target: WildcardTarget;
  /** What the room reads: the selection, the scene, the chapter, the plan, the conversation. */
  material: string;
  context: WildcardRoomContext;
  secrets?: WildcardRoomSecrets;
  /** What the author asks the room, when they ask something (Brainstorming, the Copilot); else the room gives what each voice gives. */
  question?: string;
  /** Who asks the question: the author (default) or the director (the autopilot). */
  asker?: "author" | "director";
  /** Ideas rejected before (`rejectedIdeas` of the journal): the room is told not to give them again. */
  rejected?: readonly string[];
  /** Ideas a voice may give (at most `WILDCARD_MAX_IDEAS_PER_VOICE`). */
  maxIdeas?: number;
  /** Voices asked at once (at most `WILDCARD_MAX_PARALLEL`). */
  parallel?: number;
  /** Money the room may spend (above 0): a voice is not started once the voices that answered cost this much. 0 or absent: no cap. */
  moneyCap?: number;
  /** The context window of the model the room is routed to (`modelWindow`): the material is sized for it. */
  windowTokens?: number;
  outputTokens?: number;
  /** The scope of the prompt cache (`<book>/wildcards`). */
  cacheKey?: string;
  /** The id of the consultation (a new one when absent). */
  consultation?: string;
  signal?: AbortSignal;
  /** A voice started or ended. */
  onVoice?: (event: WildcardVoiceEvent) => void;
}

export type WildcardVoiceStatus = "ok" | "failed" | "skipped";

export interface WildcardVoiceResult {
  persona: { id: string; slug: string; name: string; group: WildcardProfile["group"] };
  status: WildcardVoiceStatus;
  ideas: WildcardIdea[];
  /** Items of its reply that were not records. */
  invalid: number;
  /** Records beyond the cap: counted, never dropped in silence. */
  omitted: number;
  /** The output limit cut its reply. */
  truncated: boolean;
  /** Its first reply could not be read and it was asked again. */
  repaired: boolean;
  /** Why it failed, or `cap` when it was not asked because the money cap was reached. */
  reason?: string;
  note?: string;
  usage?: AiUsage;
  cost?: number;
  costKnown?: boolean;
  currency?: string;
  model?: string;
  provider?: string;
}

export interface WildcardVoiceEvent {
  slug: string;
  name: string;
  status: "running" | WildcardVoiceStatus;
}

export interface WildcardRoomResult {
  consultation: string;
  target: WildcardTarget;
  voices: WildcardVoiceResult[];
  /** Every voice's records, in the order of the voices. */
  ideas: WildcardIdea[];
  /** Voices given beyond `WILDCARD_MAX_VOICES`: not asked, and said. */
  voicesOmitted: number;
  /** The material was shortened in the middle to fit the model's window: its characters before and after. */
  clipped?: { from: number; to: number };
  /** The known cost of the voices that answered. */
  cost: number;
  /** A voice was not started because the money cap was reached. */
  capped: boolean;
}

const ROOM_SYSTEM = [
  "You are one voice of a writers' room of «wildcards» (Fuori dal coro): figures who propose ideas and check what is there, next to the director, the ghostwriters and the simulated readers.",
  "What you give is advisory: you never give a score or a vote, you never decide, and nothing you say is applied unless the director or the author chooses it.",
  "Be specific to the text you are given; never generic advice. Quote or locate what you talk about. Prefer fewer, stronger items.",
  "Never reveal or guess a secret you are not told: when you are told a secret, respect what the material may know of it.",
  "Reply only with the wildcard_ideas function.",
].join("\n");

function voiceOf(profile: WildcardProfile): WildcardVoiceResult["persona"] {
  return { id: profile.id, slug: profile.slug, name: profile.name, group: profile.group };
}

function costOf(response: AiResponse): number {
  return typeof response.cost === "number" && Number.isFinite(response.cost) ? response.cost : 0;
}

/** The material sized for the window: what the prompt leaves for it once the shared context, the persona, the secrets and the reply are counted. */
function sizedMaterial(input: WildcardRoomInput, fixedTokens: number): { text: string; clipped?: { from: number; to: number } } {
  const window = input.windowTokens && input.windowTokens > 0 ? input.windowTokens : DEFAULT_MAX_INPUT_TOKENS;
  const reserve = Math.max(input.outputTokens ?? WILDCARD_OUTPUT_TOKENS, OUTPUT_RESERVE_TOKENS);
  const budget = resolveModelTokenBudgets(window, reserve).inputTokens - fixedTokens;
  const maxChars = Math.max(2_000, budget * 4);
  const text = input.material ?? "";
  if (text.length <= maxChars) return { text };
  const clipped = clipMiddle(text, maxChars);
  return { text: clipped, clipped: { from: text.length, to: clipped.length } };
}

/** The part of every prompt that the voices share: the book, then the material (`clipNote` when it was shortened). */
function sharedData(input: WildcardRoomInput, material: string, clipNote: string): string {
  const { context, target } = input;
  return untrustedData("repository_content", [
    `BOOK: ${context.title || "(untitled)"} — written in ${languageName(context.language)}`,
    context.synopsis ? `SYNOPSIS:\n${context.synopsis}` : "",
    context.canon ? `CANON (characters, places, things; no secrets):\n${context.canon}` : "",
    context.storySoFar ? `STORY SO FAR:\n${context.storySoFar}` : "",
    `WHAT THE ROOM READS: ${target.kind} — ${target.label}${clipNote}`,
    material,
  ].filter(Boolean).join("\n\n"));
}

/** What a voice is told of the secrets: the author's ledger for a sentinel with that access, else only what the material may know. */
export function wildcardSecretsBlock(profile: WildcardProfile, secrets: WildcardRoomSecrets | undefined): string {
  if (!secrets) return "";
  if (profile.group === "sentinel" && profile.secrets === "author") {
    return secrets.author ? `SECRETS OF THE BOOK (as the author knows them; check the material against their thresholds, and never repeat a truth beyond what locates a problem):\n${secrets.author}` : "";
  }
  return secrets.threshold ? `SECRETS THE MATERIAL MAY KNOW (already reachable at this point of the story):\n${secrets.threshold}` : "";
}

function voicePrompt(input: WildcardRoomInput, profile: WildcardProfile, shared: string, max: number): { user: string; cacheBreak: number } {
  const sentinel = profile.group === "sentinel";
  const own = [
    `WHO YOU ARE:\n${wildcardPersonaPrompt(profile)}`,
    wildcardSecretsBlock(profile, input.secrets),
    input.rejected?.length ? `ALREADY REJECTED BY THE AUTHOR OR THE DIRECTOR (do not propose these again):\n${input.rejected.map((title) => `- ${title}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  const asked = currentRequest([
    input.question?.trim() ? `${input.asker === "director" ? "The director" : "The author"} asks the room: ${input.question.trim()}` : "Give what you give about what the room reads.",
    `Answer as «${profile.name}», in ${languageName(input.context.language)}, with at most ${max} items, the best first: each with a title, the ${sentinel ? "problem found (with its evidence and severity)" : "idea"}, why it ${sentinel ? "matters" : "works"}, what it changes (and the chapters and secrets it touches), its risk and its audacity from 1 to 10. No score.`,
  ].join("\n"));
  const user = `${shared}\n\n${untrustedData("metadata", own, "This describes your role in the room.")}\n\n${asked}`;
  return { user, cacheBreak: shared.length + 2 };
}

const REPAIR_NOTE = "Your previous reply could not be read: reply again with the wildcard_ideas function, an \"items\" list where every item has a title, an idea, why, changes, risk and audacity.";

async function askVoice(input: WildcardRoomInput, profile: WildcardProfile, shared: string, consultation: string, max: number): Promise<WildcardVoiceResult> {
  const { user, cacheBreak } = voicePrompt(input, profile, shared, max);
  const ask = (repair: boolean) => input.ai.complete({
    capability: WILDCARDS_CAPABILITY,
    label: `wildcards:${profile.slug}`,
    system: ROOM_SYSTEM,
    // The note of a repair comes after everything else, so that the start of the prompt stays the one the cache holds.
    user: repair ? `${user}\n\n${currentRequest(REPAIR_NOTE)}` : user,
    cacheBreak,
    ...(input.cacheKey ? { cacheKey: input.cacheKey } : {}),
    json: WILDCARD_IDEAS_TOOL,
    maxOutputTokens: input.outputTokens ?? WILDCARD_OUTPUT_TOKENS,
    temperature: Math.min(1.1, 0.4 + profile.audacity * 0.06),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  let response: AiResponse | undefined;
  let repaired = false;
  let spent = 0;
  let reading: ReturnType<typeof readWildcardReply> = { ideas: [], invalid: 0, omitted: 0 };
  for (const attempt of [0, 1]) {
    try {
      response = await ask(attempt === 1);
    } catch (error) {
      if (error instanceof AiReplyRejectedError && attempt === 0) {
        repaired = true;
        continue;
      }
      throw error;
    }
    spent += costOf(response);
    reading = readWildcardReply(unescapePromptDataDeep(response.json ?? null), profile, { target: input.target, consultation, max });
    if (reading.ideas.length || attempt === 1) break;
    repaired = true;
  }
  const done = response!;
  return {
    persona: voiceOf(profile),
    status: reading.ideas.length ? "ok" : "failed",
    ideas: reading.ideas,
    invalid: reading.invalid,
    omitted: reading.omitted,
    truncated: done.truncated === true,
    repaired,
    ...(reading.ideas.length ? {} : { reason: done.truncated ? "The output limit cut the reply before any idea was complete." : "The reply had no idea that could be read, also when asked again." }),
    ...(reading.note ? { note: reading.note } : {}),
    ...(done.usage ? { usage: done.usage } : {}),
    cost: spent,
    ...(done.costKnown !== undefined ? { costKnown: done.costKnown } : {}),
    ...(done.currency ? { currency: done.currency } : {}),
    ...(done.model ? { model: done.model } : {}),
    ...(done.provider ? { provider: done.provider } : {}),
  };
}

/**
 * Ask the room. The voices are asked in parallel (at most `parallel`, never more than `WILDCARD_MAX_PARALLEL`), each at most once more when its reply
 * cannot be read; a voice that fails says why and the others go on; a voice is not started once the money cap is reached. The result lists every
 * voice asked, in the order given (at most `WILDCARD_MAX_VOICES`; the ones beyond are counted in `voicesOmitted`).
 */
export async function runWildcardRoom(input: WildcardRoomInput): Promise<WildcardRoomResult> {
  const consultation = input.consultation ?? `room-${crypto.randomUUID()}`;
  const voices = input.voices.slice(0, WILDCARD_MAX_VOICES);
  const max = Math.max(1, Math.min(WILDCARD_MAX_IDEAS_PER_VOICE, Math.round(input.maxIdeas ?? WILDCARD_MAX_IDEAS_PER_VOICE)));
  // The fixed part of the largest prompt: the instructions, the context, the longest persona with its secrets, and the request.
  const longestOwn = voices.map((voice) => `${wildcardPersonaPrompt(voice)}\n${wildcardSecretsBlock(voice, input.secrets)}`).reduce((longest, text) => (text.length > longest.length ? text : longest), "");
  const fixed = likelyTextTokens([
    ROOM_SYSTEM, input.context.synopsis ?? "", input.context.canon ?? "", input.context.storySoFar ?? "", input.question ?? "", (input.rejected ?? []).join("\n"), longestOwn, REPAIR_NOTE,
  ].join("\n")) + likelyTextTokens(JSON.stringify(WILDCARD_IDEAS_TOOL)) + 600;
  const material = sizedMaterial(input, fixed);
  const clipNote = material.clipped ? ` (shortened in the middle to fit the model: ${material.clipped.to} of its ${material.clipped.from} characters, the cut marked [\u2026])` : "";
  const shared = sharedData(input, material.text, clipNote);
  const results: WildcardVoiceResult[] = new Array(voices.length);
  const moneyCap = input.moneyCap !== undefined && Number.isFinite(input.moneyCap) && input.moneyCap > 0 ? input.moneyCap : undefined;
  let spent = 0;
  let capped = false;
  let next = 0;
  const parallel = Math.max(1, Math.min(WILDCARD_MAX_PARALLEL, Math.round(input.parallel ?? WILDCARD_MAX_PARALLEL)));
  const worker = async () => {
    while (next < voices.length) {
      const index = next;
      next += 1;
      const profile = voices[index];
      input.signal?.throwIfAborted();
      if (moneyCap !== undefined && spent >= moneyCap) {
        capped = true;
        results[index] = { persona: voiceOf(profile), status: "skipped", ideas: [], invalid: 0, omitted: 0, truncated: false, repaired: false, reason: "cap" };
        input.onVoice?.({ slug: profile.slug, name: profile.name, status: "skipped" });
        continue;
      }
      input.onVoice?.({ slug: profile.slug, name: profile.name, status: "running" });
      try {
        const result = await askVoice(input, profile, shared, consultation, max);
        spent += result.cost ?? 0;
        results[index] = result;
      } catch (error) {
        if (input.signal?.aborted) throw error;
        results[index] = { persona: voiceOf(profile), status: "failed", ideas: [], invalid: 0, omitted: 0, truncated: false, repaired: false, reason: error instanceof Error ? error.message : String(error) };
      }
      input.onVoice?.({ slug: profile.slug, name: profile.name, status: results[index].status });
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, voices.length) }, worker));
  return {
    consultation,
    target: input.target,
    voices: results,
    ideas: results.flatMap((result) => result.ideas),
    voicesOmitted: Math.max(0, input.voices.length - voices.length),
    ...(material.clipped ? { clipped: material.clipped } : {}),
    cost: spent,
    capped,
  };
}
