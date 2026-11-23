import { MemoryAiCallStore, ServerRequestError, type AiCallTaskHeader, type AiCallAttempt, type AiCallEnd, type AiCallField, type AiCallRecord, type AiCallTask, type AiCallTaskPage, type ServerCallText } from "narrarium-engine";
import type { ServerCallsApi } from "@/autopilot/calls/copier";

// A personal server's AI call records, as the copier reads them: a memory store plays the server, and the API over it cuts what it reads into small pieces, as a
// server that limits what one answer carries does.

export const BOOK = "book-1";
export const IDENTITY = "workspace:a";
const encoder = new TextEncoder();

interface Counters {
  list: number;
  task: number;
  text: number;
}

/** The server: a store of its own, and the API over it that the copier reads. */
export class FakeServer implements ServerCallsApi {
  readonly store = new MemoryAiCallStore();
  readonly counts: Counters = { list: 0, task: 0, text: 0 };
  /** The most bytes one answer of `readCallText` carries. */
  chunkBytes = 37;
  supported = true;
  onList: (() => void | Promise<void>) | null = null;
  onText: ((count: number, read: { callId: string; field: AiCallField; from: number }) => void | Promise<void>) | null = null;
  failList: Error | null = null;

  available = () => this.supported;

  async listCalls(bookId: string, page: { before?: string; limit?: number }): Promise<AiCallTaskPage> {
    this.counts.list += 1;
    await this.onList?.();
    if (this.failList) throw this.failList;
    return this.store.listTasks(bookId, { ...(page.before === undefined ? {} : { before: page.before }), limit: page.limit ?? 20 });
  }

  /** Like the engine's client: a task the server does not hold is a 404, not a null. */
  async readCallTask(bookId: string, activityId: string): Promise<AiCallTask> {
    this.counts.task += 1;
    const task = await this.store.readTask(bookId, activityId);
    if (!task) throw new ServerRequestError("The server holds no such task.", 404, "call_task_not_found");
    return task;
  }

  async readCallText(bookId: string, callId: string, options: { field: AiCallField; attempt?: number; from?: number; limit?: number }): Promise<ServerCallText> {
    this.counts.text += 1;
    const field = options.field;
    const from = options.from ?? 0;
    await this.onText?.(this.counts.text, { callId, field, from });
    const chunk = await this.store.readText(bookId, callId, field, from, options.attempt);
    if (!chunk) throw new ServerRequestError("The server does not hold the call.", 404, "call_not_found");
    let used = 0;
    let text = "";
    for (const character of chunk.text) {
      const width = encoder.encode(character).length;
      if (used + width > this.chunkBytes) break;
      used += width;
      text += character;
    }
    const next = chunk.from + used;
    return { text, from: chunk.from, next, size: chunk.size, attempt: field === "response" ? options.attempt ?? 1 : null, done: chunk.complete && next >= chunk.size };
  }

  /** A task of the server with calls: each call has a system and a user message and the responses of its attempts (by their number). */
  async addTask(activityId: string, startedAt: string, options: { status?: "done" | "running"; bookId?: string; calls?: Array<{ system: string; user: string; responses?: Record<number, string> }> } = {}): Promise<void> {
    const bookId = options.bookId ?? BOOK;
    const calls = options.calls ?? [{ system: `system of ${activityId}`, user: `user of ${activityId}`, responses: { 1: `Il gabbiano è già volato via — 你好 😀 (${activityId}).` } }];
    const running = options.status === "running";
    await this.store.saveTask({ bookId, activityId, title: `Task ${activityId}`, kind: "write", chapter: 1, scene: 1, status: running ? "running" : "done", startedAt, endedAt: running ? null : startedAt });
    for (const [index, call] of calls.entries()) {
      const callId = `${activityId}-${String(index + 1).padStart(4, "0")}`;
      await this.store.begin({ record: recordOf(callId, activityId, index + 1, bookId, startedAt), system: call.system, user: call.user });
      for (const [attempt, text] of Object.entries(call.responses ?? {})) await this.store.append(callId, Number(attempt), 0, text);
      if (!running || index < calls.length - 1) await this.store.end(callId, endOf(Object.keys(call.responses ?? {}).map(Number), startedAt));
    }
  }

  /** The running task ends: its last call and its header. */
  async finish(activityId: string, startedAt: string, calls: number, bookId = BOOK): Promise<void> {
    const callId = `${activityId}-${String(calls).padStart(4, "0")}`;
    await this.store.end(callId, endOf([1], startedAt));
    await this.store.saveTask({ bookId, activityId, title: `Task ${activityId}`, kind: "write", chapter: 1, scene: 1, status: "done", startedAt, endedAt: startedAt });
  }
}

export function recordOf(callId: string, activityId: string, seq: number, bookId: string, startedAt: string): AiCallRecord {
  return {
    formatVersion: 1, callId, bookId, accountScope: null, runId: "run_1", activityId, seq, stepAttempt: 1, task: "write", chapter: 1, scene: 1, label: "Write the scene", capability: "autopilot", host: "server",
    request: { system: { characters: 3, bytes: 3, storedBytes: 3, truncated: false }, user: { characters: 3, bytes: 3, storedBytes: 3, truncated: false }, images: 0, tool: null, toolSchemaHash: null, structured: false, maxOutputTokens: null, temperature: null },
    status: "running", response: { text: null, partial: false }, attempts: [], timing: { startedAt, firstTextAt: null, endedAt: null }, storedBytes: 6, dropped: null,
  };
}

function attemptOf(index: number, textAttempt: number | null): AiCallAttempt {
  return { index, textAttempt, text: textAttempt ? { characters: 10, bytes: 10, storedBytes: 10, truncated: false } : null, provider: "openai", model: "muse", integrationId: "i1", endpoint: "https://llm.example.com", stream: true, tools: false, firstByteMs: 20, durationMs: 400, outcome: "ok", finishReason: "stop", reasoningCharacters: 0, usage: { inputTokens: 10, outputTokens: 20, cachedInputTokens: 0 }, usageKnown: true, cost: null, costKnown: false, currency: null, transport: { status: 200, end: "done" }, error: null, partialCharacters: null };
}

function endOf(textAttempts: number[], startedAt: string): AiCallEnd {
  return {
    status: "ok", response: { text: textAttempts.length ? { characters: 10, bytes: 10, storedBytes: 10, truncated: false } : null, partial: false },
    attempts: textAttempts.map((number, index) => attemptOf(index + 1, number)), timing: { startedAt, firstTextAt: startedAt, endedAt: startedAt }, storedBytes: 6, dropped: null,
  };
}

export const day = (n: number) => `2026-11-${String(n).padStart(2, "0")}T10:00:00.000Z`;
export const keyOf = (header: AiCallTaskHeader) => `${header.startedAt}|${header.activityId}`;

