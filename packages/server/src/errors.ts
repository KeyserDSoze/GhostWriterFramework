/** An error with an HTTP status and a stable code, returned to clients as `{ code, message }`. */
export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export function badRequest(message = "The request is not valid."): HttpError {
  return new HttpError(400, "invalid_request", message);
}
