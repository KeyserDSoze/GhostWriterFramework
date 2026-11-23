import { AI_CALLS_FORMAT_VERSION, MemoryAiCallStore, aiCallIdOf, type AiCallAttempt, type AiCallEnd, type AiCallRecord, type AiCallTextInfo } from "narrarium-engine";
import { localCallsSource } from "@/autopilot/calls/sourceLocal";
import { provideCallsSources } from "@/autopilot/calls/sourceHook";
import type { CallsSource } from "@/autopilot/calls/source";

/** The book, the step and its calls the tests of the task view use. */
export const BOOK = "book-1";
export const STEP = "activity_0f3a9c2e-5b1d-4c7e-9a8b-1d2e3f4a5b6c";
export const T0 = Date.parse("2026-11-23T10:00:00.000Z");
export const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

const encoder = new TextEncoder();
export const infoOf = (text: string, truncated = false): AiCallTextInfo => ({ characters: text.length, bytes: encoder.encode(text).length, storedBytes: encoder.encode(text).length, truncated });

export interface CallSpec {
  seq?: number;
  label?: string;
  system?: string;
  user?: string;
  structured?: boolean;
  tool?: string | null;
  startedAt?: string;
}

/** The record of a call as the recorder begins it: running, with nothing received yet. */
export function beginRecord(activityId: string, spec: CallSpec = {}): { record: AiCallRecord; system: string; user: string } {
  const seq = spec.seq ?? 1;
  const system = spec.system ?? "You are the ghostwriter of «The Glass Harbor».\nWrite in the past tense.";
  const user = spec.user ?? "Write scene 3 of chapter 5: the keeper climbs to the lantern room.";
  const record: AiCallRecord = {
    formatVersion: AI_CALLS_FORMAT_VERSION,
    callId: aiCallIdOf(activityId, seq),
    bookId: BOOK,
    accountScope: null,
    runId: "run-1",
    activityId,
    seq,
    stepAttempt: 1,
    task: "write",
    chapter: 5,
    scene: 3,
    label: spec.label ?? `Write scene 3 of chapter 5 (call ${seq})`,
    capability: "autopilot",
    host: "browser",
    request: { system: infoOf(system), user: infoOf(user), images: 0, tool: spec.tool ?? null, toolSchemaHash: null, structured: spec.structured ?? false, maxOutputTokens: null, temperature: null },
    status: "running",
    response: { text: null, partial: false },
    attempts: [],
    timing: { startedAt: spec.startedAt ?? at(seq * 60), firstTextAt: null, endedAt: null },
    storedBytes: encoder.encode(system).length + encoder.encode(user).length,
    dropped: null,
  };
  return { record, system, user };
}

/** A provider attempt as the end of a call reports it. */
export function attemptOf(index: number, patch: Partial<AiCallAttempt> = {}): AiCallAttempt {
  return {
    index,
    textAttempt: index,
    text: null,
    provider: "openai",
    model: "gpt-5",
    integrationId: "main",
    endpoint: "https://api.openai.com",
    stream: true,
    tools: false,
    firstByteMs: 900,
    durationMs: 41_000,
    outcome: "ok",
    finishReason: "stop",
    reasoningCharacters: null,
    usage: { inputTokens: 31_200, outputTokens: 2_100, cachedInputTokens: 4_000 },
    usageKnown: true,
    cost: 0.0412,
    costKnown: true,
    currency: "USD",
    transport: null,
    error: null,
    partialCharacters: null,
    ...patch,
  };
}

/** The end of a call whose responses are `texts` (by text attempt), with its attempts. */
export function endOf(record: AiCallRecord, status: AiCallEnd["status"], texts: string[], attempts: AiCallAttempt[], seconds = 42): AiCallEnd {
  const last = texts.length ? infoOf(texts[texts.length - 1]) : null;
  const withText = attempts.map((attempt) => ({ ...attempt, text: attempt.textAttempt && texts[attempt.textAttempt - 1] !== undefined ? infoOf(texts[attempt.textAttempt - 1]) : null }));
  return {
    status,
    response: { text: last, partial: status !== "ok" && last !== null },
    attempts: withText,
    timing: { startedAt: record.timing.startedAt, firstTextAt: new Date(Date.parse(record.timing.startedAt) + 1200).toISOString(), endedAt: new Date(Date.parse(record.timing.startedAt) + seconds * 1000).toISOString() },
    storedBytes: record.storedBytes + texts.reduce((sum, text) => sum + encoder.encode(text).length, 0),
    dropped: null,
  };
}

/** Writes a whole call that ended: its begin, its responses (one per text attempt), its end, and the header of its task. */
export async function recordCall(store: MemoryAiCallStore, activityId: string, spec: CallSpec & { status?: AiCallEnd["status"]; texts?: string[]; attempts?: AiCallAttempt[]; seconds?: number } = {}): Promise<AiCallRecord> {
  const { record, system, user } = beginRecord(activityId, spec);
  await store.begin({ record, system, user });
  const texts = spec.texts ?? ["The keeper climbed the stairs counting the steps under his breath."];
  for (let index = 0; index < texts.length; index += 1) await store.append(record.callId, index + 1, 0, texts[index]);
  const attempts = spec.attempts ?? texts.map((_, index) => attemptOf(index + 1, index < texts.length - 1 ? { outcome: "failed" } : {}));
  await store.end(record.callId, endOf(record, spec.status ?? "ok", texts, attempts, spec.seconds));
  return (await store.readTask(BOOK, activityId))!.calls.find((call) => call.callId === record.callId)!;
}

/** The header of a task. */
export async function saveTask(store: MemoryAiCallStore, activityId: string, status: "running" | "done" | "failed" | "stopped" = "done", title = "Writing scene 3 of chapter 5"): Promise<void> {
  await store.saveTask({ bookId: BOOK, activityId, title, kind: "write", chapter: 5, scene: 3, status, startedAt: at(0), endedAt: status === "running" ? null : at(300) });
}

/** A store, given to every view as the source of the book's records (and the source itself, to spy on). */
export function storeAsSource(store = new MemoryAiCallStore()): { store: MemoryAiCallStore; source: CallsSource } {
  const source = localCallsSource(store);
  provideCallsSources(() => source);
  return { store, source };
}
