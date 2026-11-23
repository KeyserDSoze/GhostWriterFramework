/**
 * Text kept compressed when the browser can compress it (`CompressionStream`, in every current browser), as it is when it cannot. A short text is kept as it is: the
 * header of a gzip stream costs more than it saves.
 */

/** The shortest text that is compressed. */
export const MIN_COMPRESSED_BYTES = 1024;

/** How a kept text is stored. */
export type TextEncoding = "gzip" | "plain";

/** Whether this browser compresses and decompresses (a page that cannot decompress what another one compressed would lose texts, so both are needed). */
export function canCompress(): boolean {
  return typeof CompressionStream === "function" && typeof DecompressionStream === "function";
}

async function through(transform: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }, input: Uint8Array): Promise<Uint8Array> {
  const reader = transform.readable.getReader();
  const writer = transform.writable.getWriter();
  const parts: Uint8Array[] = [];
  let total = 0;
  const reading = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      parts.push(value);
      total += value.length;
    }
  })();
  const writing = (async () => {
    await writer.write(input);
    await writer.close();
  })();
  const [read, written] = await Promise.allSettled([reading, writing]);
  if (read.status === "rejected") throw read.reason;
  if (written.status === "rejected") throw written.reason;
  const output = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    output.set(part, at);
    at += part.length;
  }
  return output;
}

/** The gzip of `bytes`. */
export function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return through(new CompressionStream("gzip") as unknown as { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }, bytes);
}

/** What a gzip stream holds. */
export function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  return through(new DecompressionStream("gzip") as unknown as { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }, bytes);
}

/** A text as it is kept: compressed when that is possible and smaller, as it is otherwise. The result never shares its buffer with `bytes`. */
export async function packText(bytes: Uint8Array): Promise<{ encoding: TextEncoding; data: Uint8Array }> {
  if (bytes.length >= MIN_COMPRESSED_BYTES && canCompress()) {
    try {
      const packed = await gzip(bytes);
      if (packed.length < bytes.length) return { encoding: "gzip", data: packed };
    } catch {
      // A browser that fails to compress keeps the text as it is.
    }
  }
  return { encoding: "plain", data: bytes.slice() };
}

/** The bytes of a text as it is kept. */
export async function unpackText(row: { encoding: TextEncoding; data: Uint8Array }): Promise<Uint8Array> {
  return row.encoding === "gzip" ? gunzip(row.data) : row.data;
}
