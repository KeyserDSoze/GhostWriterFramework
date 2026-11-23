import { SERVER_CALLS_MAX_PAGE_LIMIT, SERVER_CALLS_PAGE_LIMIT, SERVER_CALL_TEXT_MAX_BYTES, isSafeAiCallId, type AiCallField } from "narrarium-engine";
import { AI_CALL_FIELD_MAX_BYTES } from "./ai-calls.js";
import { HttpError } from "./errors.js";

/**
 * What the routes of the AI call records ask of a request: every value is checked here, and a request that is wrong in itself is a `400 invalid_request` that says what to send (the
 * routes themselves are in `server.ts`, next to the others). The ids that name a task or a call are file names of the store, so only the letters, digits, `_` and `-` it accepts pass.
 */

const badRequest = (message: string): HttpError => new HttpError(400, "invalid_request", message);

/** A cursor is what `listTasks` gave as `next`: an ISO time, a bar and an id, so only those characters pass. */
const CURSOR = /^[A-Za-z0-9_.:|+-]{1,300}$/;

function number(url: URL, name: string, min: number, max: number): number | undefined {
  const value = url.searchParams.get(name);
  if (value === null) return undefined;
  const parsed = /^(?:0|[1-9][0-9]{0,9})$/.test(value) ? Number(value) : Number.NaN;
  if (!(parsed >= min && parsed <= max)) throw badRequest(`\`${name}\` must be a whole number from ${min} to ${max}.`);
  return parsed;
}

/** `?before=&limit=` of the list of tasks: `limit` is 1 to `SERVER_CALLS_MAX_PAGE_LIMIT` (default `SERVER_CALLS_PAGE_LIMIT`), `before` the `next` of the previous page. */
export function asCallsPage(url: URL): { before?: string; limit: number } {
  const before = url.searchParams.get("before");
  if (before !== null && !CURSOR.test(before)) throw badRequest("`before` is the `next` of the previous page.");
  return { ...(before !== null ? { before } : {}), limit: number(url, "limit", 1, SERVER_CALLS_MAX_PAGE_LIMIT) ?? SERVER_CALLS_PAGE_LIMIT };
}

/** The id of a task or of a call in an address: the letters, digits, `_` and `-` of a file name of the store. */
export function asCallId(value: string, what: "task" | "call"): string {
  if (!isSafeAiCallId(value)) throw badRequest(`The id of a ${what} is 1 to 160 letters, digits, _ or -.`);
  return value;
}

/** `?field=&attempt=&from=&limit=` of a piece of text: the field is required, `attempt` is a response's number from 1, `from` a byte offset and `limit` at most `SERVER_CALL_TEXT_MAX_BYTES`. */
export function asCallText(url: URL): { field: AiCallField; attempt?: number; from: number; limit: number } {
  const field = url.searchParams.get("field");
  if (field !== "system" && field !== "user" && field !== "response") throw badRequest("`field` is `system`, `user` or `response`.");
  const attempt = number(url, "attempt", 1, 256);
  return {
    field,
    ...(attempt !== undefined ? { attempt } : {}),
    from: number(url, "from", 0, AI_CALL_FIELD_MAX_BYTES) ?? 0,
    limit: number(url, "limit", 1, SERVER_CALL_TEXT_MAX_BYTES) ?? SERVER_CALL_TEXT_MAX_BYTES,
  };
}

/** The body of the pin: `{ pinned: true | false }`, and a value that is not a boolean is not a choice. */
export function asKeepBody(body: Record<string, unknown>): boolean {
  if (typeof body.pinned !== "boolean") throw badRequest("Send `pinned`: true to keep the task, false to let it go.");
  return body.pinned;
}
