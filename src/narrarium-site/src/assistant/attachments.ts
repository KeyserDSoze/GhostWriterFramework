import type { AssistantAttachment } from "@/assistant/store";

export const ATTACHMENT_LIMITS = {
  count: 8,
  fileBytes: 10 * 1024 * 1024,
  imageBytes: 2 * 1024 * 1024,
  aggregateBytes: 20 * 1024 * 1024,
  aggregateImageBytes: 4 * 1024 * 1024,
  textCharactersPerFile: 60_000,
  aggregateTextCharacters: 160_000,
  estimatedTokens: 40_000,
  pdfPagesPerFile: 100,
  aggregatePdfPages: 200,
  pdfTextItemsPerPage: 20_000,
  pdfTextChunksPerPage: 2_000,
  pdfStreamReadMs: 5_000,
  pdfExtractionMs: 15_000,
  docxExpandedBytesPerFile: 20 * 1024 * 1024,
  aggregateExtractedBytes: 30 * 1024 * 1024,
  compressionRatio: 100,
} as const;

export type ExtractionBudget = { textCharacters: number; pdfPages: number; extractedBytes: number };

export function estimateAttachmentTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function constrainAttachmentsToTokenBudget(attachments: AssistantAttachment[], tokenBudget: number): AssistantAttachment[] {
  let remaining = Math.max(0, tokenBudget);
  let acceptedCount = 0;
  let acceptedBytes = 0;
  let acceptedImageBytes = 0;
  return attachments.map((attachment) => {
    const actualImageBytes = attachment.kind === "image" ? Math.max(attachment.sizeBytes, dataUrlBytes(attachment.imageDataUrl)) : 0;
    const overStorageBoundary = acceptedCount >= ATTACHMENT_LIMITS.count
      || acceptedBytes + attachment.sizeBytes > ATTACHMENT_LIMITS.aggregateBytes
      || (attachment.kind === "image" && (actualImageBytes > ATTACHMENT_LIMITS.imageBytes || acceptedImageBytes + actualImageBytes > ATTACHMENT_LIMITS.aggregateImageBytes));
    const invalidImage = attachment.kind === "image" && !/^data:image\/(?:png|jpeg);base64,/i.test(attachment.imageDataUrl ?? "");
    if (overStorageBoundary || invalidImage) return {
      ...attachment,
      textContent: attachment.kind === "text" ? "" : attachment.textContent,
      imageDataUrl: undefined,
      estimatedTokens: 0,
      truncated: true,
      truncationReason: invalidImage ? "unsafe image payload omitted" : "aggregate attachment boundary omitted this payload",
    };
    acceptedCount += 1;
    acceptedBytes += attachment.sizeBytes;
    acceptedImageBytes += actualImageBytes;
    const estimated = attachment.estimatedTokens ?? (attachment.kind === "image" ? estimateImageTokens(actualImageBytes) : estimateAttachmentTokens(attachment.textContent ?? ""));
    if (attachment.kind === "image") {
      if (estimated > remaining) return {
        ...attachment,
        imageDataUrl: undefined,
        estimatedTokens: 0,
        truncated: true,
        truncationReason: "selected model attachment budget omitted this image",
      };
      remaining -= estimated;
      return attachment;
    }
    const allowedCharacters = Math.max(0, Math.min(attachment.textContent?.length ?? 0, remaining * 4));
    const textContent = (attachment.textContent ?? "").slice(0, allowedCharacters);
    const used = estimateAttachmentTokens(textContent);
    remaining -= used;
    if (allowedCharacters === (attachment.textContent?.length ?? 0)) return attachment;
    return {
      ...attachment,
      textContent,
      estimatedTokens: used,
      truncated: true,
      truncationReason: `selected model attachment budget limited this excerpt to ${used} tokens`,
    };
  });
}

export function validateAttachmentSelection(files: File[], existing: AssistantAttachment[] = []): void {
  if (files.length + existing.length > ATTACHMENT_LIMITS.count) throw new Error(`You can attach at most ${ATTACHMENT_LIMITS.count} files.`);
  for (const file of files) {
    const image = isImage(file, file.name.toLowerCase());
    const limit = image ? ATTACHMENT_LIMITS.imageBytes : ATTACHMENT_LIMITS.fileBytes;
    if (file.size > limit) throw new Error(`${file.name} is too large. The limit is ${formatMegabytes(limit)}.`);
  }
  const allBytes = existing.reduce((sum, attachment) => sum + attachment.sizeBytes, 0) + files.reduce((sum, file) => sum + file.size, 0);
  if (allBytes > ATTACHMENT_LIMITS.aggregateBytes) throw new Error(`Attachments exceed the ${formatMegabytes(ATTACHMENT_LIMITS.aggregateBytes)} aggregate limit.`);
  const imageBytes = existing.filter((attachment) => attachment.kind === "image").reduce((sum, attachment) => sum + attachment.sizeBytes, 0)
    + files.filter((file) => isImage(file, file.name.toLowerCase())).reduce((sum, file) => sum + file.size, 0);
  if (imageBytes > ATTACHMENT_LIMITS.aggregateImageBytes) throw new Error(`Images exceed the ${formatMegabytes(ATTACHMENT_LIMITS.aggregateImageBytes)} aggregate limit.`);
}

export async function parseAttachments(files: File[], existing: AssistantAttachment[] = [], signal?: AbortSignal): Promise<AssistantAttachment[]> {
  throwIfAborted(signal);
  validateAttachmentSelection(files, existing);
  const reservedImageTokens = files.filter((file) => isImage(file, file.name.toLowerCase())).reduce((sum, file) => sum + estimateImageTokens(file.size), 0);
  const existingTokens = existing.reduce((sum, attachment) => sum + (attachment.estimatedTokens ?? (attachment.kind === "image" ? estimateImageTokens(attachment.sizeBytes) : estimateAttachmentTokens(attachment.textContent ?? ""))), 0);
  const budget: ExtractionBudget = {
    textCharacters: Math.min(
      ATTACHMENT_LIMITS.aggregateTextCharacters - existing.reduce((sum, attachment) => sum + (attachment.textContent?.length ?? 0), 0),
      Math.max(0, ATTACHMENT_LIMITS.estimatedTokens - existingTokens - reservedImageTokens) * 4,
    ),
    pdfPages: ATTACHMENT_LIMITS.aggregatePdfPages - existing.reduce((sum, attachment) => sum + (attachment.extractedPages ?? 0), 0),
    extractedBytes: ATTACHMENT_LIMITS.aggregateExtractedBytes - existing.reduce((sum, attachment) => sum + (attachment.extractedBytes ?? 0), 0),
  };
  const parsed: AssistantAttachment[] = [];
  for (const file of files) {
    throwIfAborted(signal);
    const attachment = await parseAttachment(file, budget, signal);
    parsed.push(attachment);
    budget.textCharacters -= attachment.textContent?.length ?? 0;
    budget.pdfPages -= attachment.extractedPages ?? 0;
    budget.extractedBytes -= attachment.extractedBytes ?? 0;
  }
  return parsed;
}

export async function parseAttachment(file: File, budget: ExtractionBudget = {
  textCharacters: ATTACHMENT_LIMITS.aggregateTextCharacters,
  pdfPages: ATTACHMENT_LIMITS.aggregatePdfPages,
  extractedBytes: ATTACHMENT_LIMITS.aggregateExtractedBytes,
}, signal?: AbortSignal): Promise<AssistantAttachment> {
  throwIfAborted(signal);
  const lowerName = file.name.toLowerCase();
  validateAttachmentSelection([file]);
  if (isImage(file, lowerName)) {
    return parseImageAttachment(file, signal);
  }
  if (isPlainText(file, lowerName)) {
    if (budget.textCharacters <= 0) return buildTextAttachment(file, "", 0, 0, undefined, "aggregate text or token limit reached before extraction");
    const text = await abortable(file.text(), signal);
    throwIfAborted(signal);
    return buildTextAttachment(file, text, budget.textCharacters, file.size);
  }
  if (isPdf(file, lowerName)) {
    if (budget.textCharacters <= 0 || budget.pdfPages <= 0) return buildTextAttachment(file, "", 0, 0, 0, "aggregate text, token, or PDF page limit reached before extraction");
    if (budget.extractedBytes <= 0) return buildTextAttachment(file, "", 0, 0, 0, "aggregate PDF extraction limit reached before extraction");
    const result = await extractPdfText(file, budget, signal);
    return buildTextAttachment(file, result.text, budget.textCharacters, result.extractedBytes, result.pages, result.truncationReason);
  }
  if (isDocx(file, lowerName)) {
    if (budget.textCharacters <= 0 || budget.extractedBytes <= 0) return buildTextAttachment(file, "", 0, 0, undefined, "aggregate text, token, or extraction limit reached before extraction");
    const result = await extractDocxText(file, budget.extractedBytes, signal);
    return buildTextAttachment(file, result.text, budget.textCharacters, result.expandedBytes);
  }
  throw new Error(`Unsupported attachment type: ${file.name}`);
}

function isImage(file: File, lowerName: string): boolean {
  return file.type === "image/png" || file.type === "image/jpeg" || lowerName.endsWith(".png") || lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg");
}

function isPlainText(file: File, lowerName: string): boolean {
  return file.type.startsWith("text/") || lowerName.endsWith(".md") || lowerName.endsWith(".markdown") || lowerName.endsWith(".txt");
}

function isPdf(file: File, lowerName: string): boolean {
  return file.type === "application/pdf" || lowerName.endsWith(".pdf");
}

function isDocx(file: File, lowerName: string): boolean {
  return file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || lowerName.endsWith(".docx");
}

function buildTextAttachment(file: File, text: string, remainingCharacters: number, extractedBytes: number, extractedPages?: number, priorReason?: string): AssistantAttachment {
  const characterLimit = Math.max(0, Math.min(ATTACHMENT_LIMITS.textCharactersPerFile, remainingCharacters));
  const normalized = normalizeExtractedText(text);
  const textContent = normalized.slice(0, characterLimit);
  const truncationReason = priorReason ?? (normalized.length > textContent.length ? "extracted text limit reached" : undefined);
  return {
    id: crypto.randomUUID(),
    name: file.name,
    mimeType: file.type || "text/plain",
    kind: "text",
    sizeBytes: file.size,
    textContent,
    extractedBytes,
    extractedPages,
    estimatedTokens: estimateAttachmentTokens(textContent),
    truncated: Boolean(truncationReason),
    truncationReason,
  };
}

async function parseImageAttachment(file: File, signal?: AbortSignal): Promise<AssistantAttachment> {
  const bytes = new Uint8Array(await abortable(file.slice(0, 8).arrayBuffer(), signal));
  const mimeType = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    ? "image/png"
    : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      ? "image/jpeg"
      : null;
  if (!mimeType) throw new Error(`${file.name} is not a valid PNG or JPEG image.`);
  const dataUrl = await readAsDataUrl(new Blob([await abortable(file.arrayBuffer(), signal)], { type: mimeType }), file.name, signal);
  return {
    id: crypto.randomUUID(),
    name: file.name,
    mimeType,
    kind: "image",
    sizeBytes: file.size,
    imageDataUrl: dataUrl,
    estimatedTokens: estimateImageTokens(file.size),
  };
}

async function extractPdfText(file: File, budget: ExtractionBudget, signal?: AbortSignal): Promise<{ text: string; pages: number; extractedBytes: number; truncationReason?: string }> {
  await assertMagic(file, "%PDF-", "PDF", signal);
  throwIfAborted(signal);
  const data = await abortable(file.arrayBuffer(), signal);
  throwIfAborted(signal);
  return runPdfExtractionWorker(data, {
    characterLimit: Math.min(ATTACHMENT_LIMITS.textCharactersPerFile, budget.textCharacters),
    byteLimit: Math.max(0, budget.extractedBytes),
    pageLimit: Math.min(ATTACHMENT_LIMITS.pdfPagesPerFile, budget.pdfPages),
  }, signal);
}

async function extractDocxText(file: File, aggregateRemaining: number, signal?: AbortSignal): Promise<{ text: string; expandedBytes: number }> {
  await assertMagic(file, "PK", "DOCX", signal);
  const arrayBuffer = await abortable(file.arrayBuffer(), signal);
  throwIfAborted(signal);
  const { default: JSZip } = await import("jszip");
  throwIfAborted(signal);
  const archive = await abortable(JSZip.loadAsync(arrayBuffer), signal);
  const expandedLimit = Math.min(ATTACHMENT_LIMITS.docxExpandedBytesPerFile, Math.max(0, aggregateRemaining));
  const documentXml = archive.file("word/document.xml");
  if (!documentXml) throw new Error(`${file.name} is not a valid DOCX file.`);
  const bytes = await readZipEntryBounded(documentXml as unknown as { internalStream(type: "uint8array"): unknown }, expandedLimit, file.size, file.name, signal);
  throwIfAborted(signal);
  return { text: docxXmlToText(new TextDecoder().decode(bytes)), expandedBytes: bytes.byteLength };
}

type ZipStreamHelper = {
  on(event: "data", callback: (chunk: Uint8Array) => void): ZipStreamHelper;
  on(event: "end", callback: () => void): ZipStreamHelper;
  on(event: "error", callback: (error: unknown) => void): ZipStreamHelper;
  pause(): ZipStreamHelper;
  resume(): ZipStreamHelper;
};

async function readZipEntryBounded(entry: { internalStream(type: "uint8array"): unknown }, byteLimit: number, compressedArchiveBytes: number, name: string, signal?: AbortSignal): Promise<Uint8Array> {
  const stream = entry.internalStream("uint8array") as ZipStreamHelper;
  const chunks: Uint8Array[] = [];
  let total = 0;
  return new Promise<Uint8Array>((resolve, reject) => {
    let settled = false;
    const finishError = (error: unknown) => {
      if (settled) return;
      settled = true;
      stream.pause();
      signal?.removeEventListener("abort", abort);
      reject(error);
    };
    const abort = () => finishError(abortReason(signal));
    stream.on("data", (chunk) => {
      if (settled) return;
      total += chunk.byteLength;
      if (total > byteLimit || (compressedArchiveBytes > 0 && total / compressedArchiveBytes > ATTACHMENT_LIMITS.compressionRatio)) {
        finishError(new Error(`${name} expands beyond the safe DOCX extraction limit.`));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("error", finishError);
    stream.on("end", () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      const output = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
      }
      resolve(output);
    });
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    stream.resume();
  });
}

function normalizeExtractedText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function assertMagic(file: File, expected: string, label: string, signal?: AbortSignal): Promise<void> {
  const prefix = new TextDecoder("latin1").decode(await abortable(file.slice(0, expected.length).arrayBuffer(), signal));
  if (prefix !== expected) throw new Error(`${file.name} is not a valid ${label} file.`);
}

function formatMegabytes(bytes: number): string {
  return `${bytes / (1024 * 1024)} MB`;
}

function estimateImageTokens(bytes: number): number {
  return Math.ceil(bytes / 512);
}

function dataUrlBytes(value?: string): number {
  if (!value) return 0;
  const comma = value.indexOf(",");
  if (comma < 0) return value.length;
  return Math.ceil((value.length - comma - 1) * 0.75);
}

export function pdfPageLimit(documentPages: number, aggregateRemaining: number): number {
  return Math.max(0, Math.min(documentPages, ATTACHMENT_LIMITS.pdfPagesPerFile, aggregateRemaining));
}

type PdfWorkerBudget = { characterLimit: number; byteLimit: number; pageLimit: number };
type PdfWorkerResult = { text: string; pages: number; extractedBytes: number; truncationReason?: string };
type DisposableWorker = Pick<Worker, "postMessage" | "terminate" | "addEventListener" | "removeEventListener">;

export function runPdfExtractionWorker(data: ArrayBuffer, budget: PdfWorkerBudget, signal?: AbortSignal, createWorker: () => DisposableWorker = () => new Worker(new URL("./pdfAttachment.worker.ts", import.meta.url), { type: "module" })): Promise<PdfWorkerResult> {
  throwIfAborted(signal);
  const worker = createWorker();
  return new Promise<PdfWorkerResult>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      worker.removeEventListener("message", message);
      worker.removeEventListener("error", error);
      worker.terminate();
      callback();
    };
    const abort = () => finish(() => reject(abortReason(signal)));
    const error = () => finish(() => reject(new Error("The isolated PDF extractor failed.")));
    const message = (event: MessageEvent<{ type: "result"; result: PdfWorkerResult } | { type: "error"; message: string }>) => {
      const response = event.data;
      if (response.type === "error") return finish(() => reject(new Error(response.message)));
      const result = response.result;
      const actualBytes = utf8Encoder.encode(result.text).byteLength;
      if (!Number.isSafeInteger(result.pages) || result.pages < 0 || result.pages > budget.pageLimit
        || !Number.isSafeInteger(result.extractedBytes) || result.extractedBytes < 0 || result.extractedBytes > budget.byteLimit
        || result.text.length > budget.characterLimit || actualBytes > budget.byteLimit || actualBytes !== result.extractedBytes) {
        return finish(() => reject(new Error("The isolated PDF extractor exceeded its output boundary.")));
      }
      finish(() => resolve(result));
    };
    timer = setTimeout(() => finish(() => reject(new Error("PDF extraction exceeded the safe elapsed-time limit."))), ATTACHMENT_LIMITS.pdfExtractionMs);
    signal?.addEventListener("abort", abort, { once: true });
    worker.addEventListener("message", message as EventListener);
    worker.addEventListener("error", error);
    worker.postMessage({
      data,
      ...budget,
      itemLimit: ATTACHMENT_LIMITS.pdfTextItemsPerPage,
      chunkLimit: ATTACHMENT_LIMITS.pdfTextChunksPerPage,
      streamReadMs: ATTACHMENT_LIMITS.pdfStreamReadMs,
    }, [data]);
  });
}

function readAsDataUrl(file: Blob, name: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => {
      reader.abort();
      reject(abortReason(signal));
    };
    reader.onload = () => {
      signal?.removeEventListener("abort", abort);
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error(`Could not read ${name} as data URL.`));
    };
    reader.onerror = () => {
      signal?.removeEventListener("abort", abort);
      reject(reader.error ?? new Error(`Could not read ${name}.`));
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    reader.readAsDataURL(file);
  });
}

const utf8Encoder = new TextEncoder();

function docxXmlToText(xml: string): string {
  return decodeXml(xml
    .replace(/<w:tab\b[^>]*\/>/gi, "\t")
    .replace(/<w:(?:br|cr)\b[^>]*\/>/gi, "\n")
    .replace(/<\/w:p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, ""));
}

function decodeXml(value: string): string {
  return value
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (match, entity: string) => {
      const codePoint = entity[0].toLowerCase() === "x" ? Number.parseInt(entity.slice(1), 16) : Number.parseInt(entity, 10);
      return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    })
    .replace(/&(amp|lt|gt|quot|apos);/g, (match, entity: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[entity] ?? match);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal, onAbort?: () => void): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    onAbort?.();
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      onAbort?.();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}
