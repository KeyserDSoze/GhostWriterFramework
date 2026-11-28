import { AI_CAPABILITIES, WILDCARDS_CAPABILITY, estimateModelOf, estimateWildcardRoom, pickAiRuntimeConfig, type WildcardRoomEstimate } from "narrarium-engine";
import type { AppSettings } from "@/types/settings";

/**
 * What one consultation of the room of the wildcards costs the autopilot, before a run: its voices and the director's triage (`estimateWildcardRoom`), priced with the models
 * this browser routes the task Wildcards and the Director to. The room reads the book chapter by chapter (a line of the plan, or a summary), what the book says of itself and the
 * director's points: sized here from the chapters, as an interval. Pure, but for the settings it is given.
 */

/** Characters the room reads for each chapter, and what it reads besides (the description, the story design, the director's points); what every voice shares of the book. */
const CHAPTER_CHARS = 420;
const FIXED_CHARS = 6_000;
const CONTEXT_CHARS = 8_000;

function modelOf(settings: AppSettings, capability: string): ReturnType<typeof estimateModelOf> {
  try {
    return estimateModelOf(pickAiRuntimeConfig(settings), capability);
  } catch {
    return null;
  }
}

export function autopilotRoomEstimate(settings: AppSettings, input: { voices: number; chapters: number }): WildcardRoomEstimate {
  return estimateWildcardRoom({
    voices: input.voices,
    materialChars: FIXED_CHARS + Math.max(1, input.chapters) * CHAPTER_CHARS,
    contextChars: CONTEXT_CHARS,
    model: modelOf(settings, WILDCARDS_CAPABILITY),
    triage: { model: modelOf(settings, AI_CAPABILITIES.director) },
    ...(settings.costCurrency ? { currency: settings.costCurrency } : {}),
  });
}
