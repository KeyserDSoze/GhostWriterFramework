import { AI_CALLS_FORMAT_VERSION, type AiCallRecord, type AiCallStore, type AiCallTaskHeader, type AiCallField } from "narrarium-engine";

/**
 * The file of one task: `calls/YYYY/MM/DD/<HHmmss>-<activityId>.ndjson.gz` (the `calls/` or `ai-calls/<bookId>/` root depends on the target). It is a gzip of
 * newline-delimited JSON (`gunzip -c file | jq .`), one JSON object per line:
 *
 * - line 1, `{"type":"task","formatVersion":1,"exportedAt":…,"header":AiCallTaskHeader}` (`exportedAt` is when the task ended, so that a task written twice is the same bytes);
 * - then one line per call, in the order of `seq`: `{"type":"call","record":AiCallRecord,"system":"…","user":"…","responses":[{"attempt":1,"text":"…"}]}`.
 *
 * `system` and `user` are the texts as the call kept them, `responses` the text of each provider attempt that had text, numbered as `record.attempts[].textAttempt`.
 * Keys, headers and URLs are never in a record (see the engine's AI calls). A reader skips a line whose `type` it does not know, and keeps a file of a newer
 * `formatVersion` as it is, saying so (`newer`). The format is documented in docs/autopilot-spec.md.
 */
export interface TaskFileCall {
  record: AiCallRecord;
  system: string;
  user: string;
  responses: Array<{ attempt: number; text: string }>;
}

export interface TaskFile {
  formatVersion: number;
  exportedAt: string;
  header: AiCallTaskHeader;
  calls: TaskFileCall[];
  /** True when the file was written by a newer format than this reader knows: its lines are returned as they are. */
  newer: boolean;
}

export const TASK_FILE_EXTENSION = ".ndjson.gz";

function two(value: number): string {
  return String(value).padStart(2, "0");
}

/** The day-folder of a task, `YYYY/MM/DD`, from the UTC time it started. */
export function taskDayOf(startedAt: string): string {
  const date = new Date(startedAt);
  const valid = Number.isNaN(date.getTime()) ? new Date(0) : date;
  return `${valid.getUTCFullYear()}/${two(valid.getUTCMonth() + 1)}/${two(valid.getUTCDate())}`;
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120) || "task";
}

/** The path of a task's file under the root of the archive: the same name wherever it is copied, so a task is never copied twice. */
export function taskFilePath(header: Pick<AiCallTaskHeader, "activityId" | "startedAt">): string {
  const date = new Date(header.startedAt);
  const valid = Number.isNaN(date.getTime()) ? new Date(0) : date;
  const time = `${two(valid.getUTCHours())}${two(valid.getUTCMinutes())}${two(valid.getUTCSeconds())}`;
  return `${taskDayOf(header.startedAt)}/${time}-${safeSegment(header.activityId)}${TASK_FILE_EXTENSION}`;
}

/** The day-folder of a path made by `taskFilePath`, or null. */
export function dayOfPath(path: string): string | null {
  return /^(\d{4}\/\d{2}\/\d{2})\//.exec(path)?.[1] ?? null;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

async function pump(bytes: Uint8Array, transform: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }): Promise<Uint8Array> {
  const writer = transform.writable.getWriter();
  const written = writer.write(bytes).then(() => writer.close());
  const reader = transform.readable.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.length;
  }
  await written;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

export function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  return pump(bytes, new CompressionStream("gzip") as unknown as { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> });
}

export function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  return pump(bytes, new DecompressionStream("gzip") as unknown as { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> });
}

/** The NDJSON text of a task file, uncompressed. */
export function taskFileText(file: Pick<TaskFile, "header" | "calls"> & { exportedAt?: string }): string {
  const lines = [JSON.stringify({ type: "task", formatVersion: AI_CALLS_FORMAT_VERSION, exportedAt: file.exportedAt ?? file.header.endedAt ?? file.header.startedAt, header: file.header })];
  for (const call of file.calls) lines.push(JSON.stringify({ type: "call", record: call.record, system: call.system, user: call.user, responses: call.responses }));
  return `${lines.join("\n")}\n`;
}

export async function encodeTaskFile(file: Pick<TaskFile, "header" | "calls"> & { exportedAt?: string }): Promise<Uint8Array> {
  return gzipBytes(encoder.encode(taskFileText(file)));
}

/** Reads the NDJSON text of a task file. Throws when the first line is not a task header. */
export function parseTaskFileText(text: string): TaskFile {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const first = lines.length ? JSON.parse(lines[0]) as { type?: unknown; formatVersion?: unknown; exportedAt?: unknown; header?: unknown } : null;
  if (!first || first.type !== "task" || typeof first.formatVersion !== "number" || !first.header || typeof first.header !== "object") throw new Error("This is not a task file of the AI calls.");
  const calls: TaskFileCall[] = [];
  for (const line of lines.slice(1)) {
    const entry = JSON.parse(line) as { type?: unknown; record?: AiCallRecord; system?: unknown; user?: unknown; responses?: unknown };
    if (entry.type !== "call" || !entry.record) continue;
    const responses = Array.isArray(entry.responses)
      ? (entry.responses as Array<{ attempt?: unknown; text?: unknown }>).filter((response) => typeof response.attempt === "number" && typeof response.text === "string").map((response) => ({ attempt: response.attempt as number, text: response.text as string }))
      : [];
    calls.push({ record: entry.record, system: typeof entry.system === "string" ? entry.system : "", user: typeof entry.user === "string" ? entry.user : "", responses });
  }
  return {
    formatVersion: first.formatVersion,
    exportedAt: typeof first.exportedAt === "string" ? first.exportedAt : "",
    header: first.header as AiCallTaskHeader,
    calls,
    newer: first.formatVersion > AI_CALLS_FORMAT_VERSION,
  };
}

/** The small reader: the bytes of a `.ndjson.gz` file to the task it holds. */
export async function decodeTaskFile(bytes: Uint8Array): Promise<TaskFile> {
  return parseTaskFileText(decoder.decode(await gunzipBytes(bytes)));
}

async function readWholeText(store: AiCallStore, bookId: string, callId: string, field: AiCallField, attempt?: number): Promise<string> {
  let from = 0;
  let text = "";
  for (let guard = 0; guard < 10_000; guard += 1) {
    const chunk = await store.readText(bookId, callId, field, from, attempt);
    if (!chunk) break;
    text += chunk.text;
    if (chunk.next >= chunk.size || chunk.next <= from) break;
    from = chunk.next;
  }
  return text;
}

/** Reads a finished task and its texts from the local store, and returns what a file holds (null when the task is not kept, or has not finished). */
export async function readTaskForCopy(store: AiCallStore, bookId: string, activityId: string): Promise<{ header: AiCallTaskHeader; calls: TaskFileCall[] } | null> {
  const task = await store.readTask(bookId, activityId);
  if (!task || task.header.status === "running") return null;
  const calls: TaskFileCall[] = [];
  for (const record of task.calls) {
    const system = await readWholeText(store, bookId, record.callId, "system");
    const user = await readWholeText(store, bookId, record.callId, "user");
    const attempts = [...new Set(record.attempts.map((attempt) => attempt.textAttempt).filter((value): value is number => typeof value === "number"))].sort((a, b) => a - b);
    const responses: Array<{ attempt: number; text: string }> = [];
    for (const attempt of attempts) responses.push({ attempt, text: await readWholeText(store, bookId, record.callId, "response", attempt) });
    calls.push({ record, system, user, responses });
  }
  return { header: task.header, calls };
}
