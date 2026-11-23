/**
 * An error with an HTTP status and a stable code, returned to clients as `{ code, message }` (plus these headers). `data` is what the answer says
 * besides them (the files of a refusal, a list as it is now): its fields go into the answer, never in place of `code` and `message`.
 */
export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly headers: Readonly<Record<string, string>> = {}, readonly data?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "HttpError";
  }
}

export function badRequest(message = "The request is not valid."): HttpError {
  return new HttpError(400, "invalid_request", message);
}

/** The `Retry-After` header for a wait in milliseconds (whole seconds, at least one). */
export function retryAfter(milliseconds: number): Record<string, string> {
  return { "retry-after": String(Math.max(1, Math.ceil(milliseconds / 1000))) };
}
