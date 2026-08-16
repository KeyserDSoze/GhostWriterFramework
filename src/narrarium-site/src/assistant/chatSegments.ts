import type { AssistantLosslessSegment, AssistantLosslessSegmentRef } from "./store.ts";
import { parseAssistantLosslessSegment, serializeAssistantLosslessSegment } from "./sessionSchema.ts";

export async function assistantSegmentSha256(segment: AssistantLosslessSegment): Promise<string> {
  const bytes = new TextEncoder().encode(serializeAssistantLosslessSegment(segment));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyAssistantSegment(value: unknown, expected: AssistantLosslessSegmentRef): Promise<AssistantLosslessSegment> {
  const segment = parseAssistantLosslessSegment(value);
  if (segment.id !== expected.id || await assistantSegmentSha256(segment) !== expected.sha256) throw new Error(`Chat archive segment ${expected.id} failed integrity validation.`);
  return segment;
}
