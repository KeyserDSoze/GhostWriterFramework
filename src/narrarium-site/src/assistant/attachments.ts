import type { AssistantAttachment } from "@/assistant/store";

const MAX_TEXT_LENGTH = 60_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export async function parseAttachment(file: File): Promise<AssistantAttachment> {
  const lowerName = file.name.toLowerCase();
  if (isImage(file, lowerName)) {
    return parseImageAttachment(file);
  }
  if (isPlainText(file, lowerName)) {
    const text = await file.text();
    return buildTextAttachment(file, text);
  }
  if (isPdf(file, lowerName)) {
    const text = await extractPdfText(file);
    return buildTextAttachment(file, text);
  }
  if (isDocx(file, lowerName)) {
    const text = await extractDocxText(file);
    return buildTextAttachment(file, text);
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

function buildTextAttachment(file: File, text: string): AssistantAttachment {
  return {
    id: crypto.randomUUID(),
    name: file.name,
    mimeType: file.type || "text/plain",
    kind: "text",
    sizeBytes: file.size,
    textContent: normalizeExtractedText(text),
  };
}

async function parseImageAttachment(file: File): Promise<AssistantAttachment> {
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`${file.name} is too large. Images must be 5 MB or smaller.`);
  }
  const dataUrl = await readAsDataUrl(file);
  return {
    id: crypto.randomUUID(),
    name: file.name,
    mimeType: file.type || "image/png",
    kind: "image",
    sizeBytes: file.size,
    imageDataUrl: dataUrl,
  };
}

async function extractPdfText(file: File): Promise<string> {
  const [pdfjs, workerModule] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerModule.default;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const document = await pdfjs.getDocument({ data: bytes }).promise;
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    const page = await document.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => {
        if ("str" in item) return item.str;
        return "";
      })
      .join(" ");
    pages.push(pageText);
  }
  return pages.join("\n\n");
}

async function extractDocxText(file: File): Promise<string> {
  const { default: mammoth } = await import("mammoth");
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
}

function normalizeExtractedText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_TEXT_LENGTH);
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error(`Could not read ${file.name} as data URL.`));
    };
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}
