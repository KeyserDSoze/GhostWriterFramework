import type { DeadlineClock } from "./deadlines.js";

// What reading a body from an endpoint needs, whoever reads it: the chat client, the model catalog and the probe. Internal: not exported by the package.

/** Stops reading without waiting for the other side: whatever it does with the cancel, the call must not hang on it. */
export function release(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // A reader that cannot be cancelled is of no use any more.
  }
}

/** Lets a body go that nobody is going to read (an error, a reply that arrived too late, or one that the call gave up). */
export function discardBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // A body that is locked or already read has nothing left to discard.
  }
}

/** Why a body could not be read as JSON: it is not (`invalid`), it is bigger than it may be (`too-large`), or the connection broke while it was read (`lost`). */
export type BodyFault = "invalid" | "too-large" | "lost";

/** A body that cannot be used. It says only why, never what the body held. */
export class BodyError extends Error {
  constructor(readonly fault: BodyFault) {
    super(`The body could not be read (${fault}).`);
    this.name = "BodyError";
  }
}

const JSON_TYPE = /\/json(?:\s*;|$)|\+json(?:\s*;|$)/i;

/**
 * Reads a body that has to be one small JSON value, from an endpoint nobody vouches for. A type that says it is not JSON, a length that is not a number
 * or is over `maxBytes` is refused before a byte is read (the body is let go); a body that grows past `maxBytes` whatever its length said is cut where
 * it passes the limit; every piece restarts the silence the clock watches, and the reader is let go however the read ends but by the end of the body.
 * A deadline or the author's cancel is the clock's (it rejects at once, whatever the read does); anything else that goes wrong is a `BodyError`.
 */
export async function readBoundedJson(response: Response, clock: DeadlineClock, maxBytes: number): Promise<unknown> {
  const type = response.headers?.get?.("content-type") ?? "";
  if (type && !JSON_TYPE.test(type)) {
    discardBody(response);
    throw new BodyError("invalid");
  }
  const length = response.headers?.get?.("content-length") ?? null;
  if (length !== null) {
    if (!/^\d+$/.test(length.trim())) {
      discardBody(response);
      throw new BodyError("invalid");
    }
    if (Number(length) > maxBytes) {
      discardBody(response);
      throw new BodyError("too-large");
    }
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.body?.getReader();
  } catch {
    discardBody(response);
    throw new BodyError("invalid");
  }
  if (!reader) throw new BodyError("invalid");
  let exhausted = false;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      let piece: ReadableStreamReadResult<Uint8Array>;
      try {
        piece = await clock.guard(reader.read());
      } catch (error) {
        // A deadline or the author's cancel is told by the clock; anything else here is the connection.
        if (clock.interrupted()) throw error;
        throw new BodyError("lost");
      }
      if (piece.done) {
        exhausted = true;
        break;
      }
      clock.activity();
      size += piece.value.byteLength;
      if (size > maxBytes) throw new BodyError("too-large");
      chunks.push(piece.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw new BodyError("invalid");
    }
  } finally {
    if (!exhausted) release(reader);
    try {
      reader.releaseLock();
    } catch {
      // A read that is still pending cannot be released: the cancel above is what lets it go.
    }
  }
}
