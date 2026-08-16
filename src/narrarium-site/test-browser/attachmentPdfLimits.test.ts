import { deflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { parseAttachment, runPdfExtractionWorker } from "@/assistant/attachments";

function compressedPdf(content: string): File {
  const compressed = deflateSync(Buffer.from(content));
  const chunks: Buffer[] = [];
  const offsets = [0];
  let length = 0;
  const append = (value: string | Uint8Array) => {
    const chunk = typeof value === "string" ? Buffer.from(value, "binary") : Buffer.from(value);
    chunks.push(chunk);
    length += chunk.length;
  };
  const object = (number: number, value: string | Uint8Array, suffix = "") => {
    offsets[number] = length;
    append(`${number} 0 obj\n`);
    append(value);
    append(`${suffix}\nendobj\n`);
  };

  append("%PDF-1.4\n");
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  object(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>");
  offsets[4] = length;
  append(`4 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`);
  append(compressed);
  append("\nendstream\nendobj\n");
  object(5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const xref = length;
  append("xref\n0 6\n0000000000 65535 f \n");
  for (let number = 1; number <= 5; number += 1) append(`${String(offsets[number]).padStart(10, "0")} 00000 n \n`);
  append(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new File([Buffer.concat(chunks)], "compressed.pdf", { type: "application/pdf" });
}

describe("bounded PDF attachment extraction", () => {
  it("bounds a highly compressed single-page text stream by extracted UTF-8 bytes", async () => {
    const expanded = `BT /F1 12 Tf 10 700 Td ${"(secret) Tj 1 0 Td ".repeat(2_000)} ET`;
    const file = compressedPdf(expanded);
    expect(file.size).toBeLessThan(expanded.length / 10);

    const worker = fakePdfWorker({ text: "s".repeat(512), pages: 1, extractedBytes: 512, truncationReason: "PDF extraction stopped at the aggregate extracted-content limit" });
    vi.stubGlobal("Worker", function WorkerMock() { return worker.instance; });
    const attachment = await parseAttachment(file, { textCharacters: 60_000, pdfPages: 10, extractedBytes: 512 });

    expect(worker.posted?.data).toBeInstanceOf(ArrayBuffer);
    expect(worker.transfer).toEqual([worker.posted?.data]);
    expect(worker.terminated).toBe(true);
    expect(attachment.extractedBytes).toBeLessThanOrEqual(512);
    expect(attachment.extractedBytes).not.toBe(file.size);
    expect(new TextEncoder().encode(attachment.textContent).byteLength).toBeLessThanOrEqual(512);
    expect(attachment.truncated).toBe(true);
    expect(attachment.truncationReason).toMatch(/extracted-content limit/);
    vi.unstubAllGlobals();
  });

  it("keeps one giant compressed PDF text operand inside the disposable worker boundary", async () => {
    const expanded = `BT /F1 12 Tf 10 700 Td (${"A".repeat(2_000_000)}) Tj ET`;
    const file = compressedPdf(expanded);
    const worker = fakePdfWorker({ text: "A".repeat(256), pages: 1, extractedBytes: 256, truncationReason: "PDF extraction stopped at the aggregate extracted-content limit" });
    vi.stubGlobal("Worker", function WorkerMock() { return worker.instance; });

    const attachment = await parseAttachment(file, { textCharacters: 256, pdfPages: 1, extractedBytes: 256 });

    expect(file.size).toBeLessThan(expanded.length / 100);
    expect(worker.posted?.data.byteLength).toBe(file.size);
    expect(worker.posted).not.toHaveProperty("text");
    expect(worker.terminated).toBe(true);
    expect(attachment.textContent).toHaveLength(256);
    expect(attachment.truncated).toBe(true);
    vi.unstubAllGlobals();
  });

  it("terminates isolated PDF parsing immediately when attachment extraction is cancelled", async () => {
    const worker = fakePdfWorker();
    const controller = new AbortController();
    const pending = runPdfExtractionWorker(new ArrayBuffer(32), { characterLimit: 32, byteLimit: 32, pageLimit: 1 }, controller.signal, () => worker.instance);
    controller.abort(new DOMException("session switched", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.terminated).toBe(true);
  });

  it.each([
    ["PDF", "waiting.pdf", "application/pdf", "%PDF-"],
    ["DOCX", "waiting.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "PK"],
  ])("aborts %s extraction while an in-flight file read is pending", async (_label, name, type, signature) => {
    const controller = new AbortController();
    const file = new File([signature], name, { type });
    Object.defineProperty(file, "arrayBuffer", { value: () => new Promise<ArrayBuffer>(() => undefined) });
    const pending = parseAttachment(file, undefined, controller.signal);
    await Promise.resolve();
    controller.abort(new DOMException("session switched", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

function fakePdfWorker(result?: { text: string; pages: number; extractedBytes: number; truncationReason?: string }) {
  const listeners = new Map<string, Set<EventListener>>();
  const state: {
    posted?: Record<string, any>;
    transfer?: Transferable[];
    terminated: boolean;
    instance: Pick<Worker, "postMessage" | "terminate" | "addEventListener" | "removeEventListener">;
  } = {
    terminated: false,
    instance: {
      postMessage(message: Record<string, any>, transferOrOptions?: Transferable[] | StructuredSerializeOptions) {
        state.posted = message;
        state.transfer = Array.isArray(transferOrOptions) ? transferOrOptions : transferOrOptions?.transfer;
        if (result) queueMicrotask(() => {
          for (const listener of listeners.get("message") ?? []) listener({ data: { type: "result", result } } as MessageEvent);
        });
      },
      terminate() { state.terminated = true; },
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        const callback = typeof listener === "function" ? listener : listener.handleEvent.bind(listener);
        const entries = listeners.get(type) ?? new Set<EventListener>();
        entries.add(callback);
        listeners.set(type, entries);
      },
      removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        if (typeof listener === "function") listeners.get(type)?.delete(listener);
      },
    },
  };
  return state;
}
