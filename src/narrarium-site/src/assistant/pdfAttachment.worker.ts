import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type PdfExtractionRequest = {
  data: ArrayBuffer;
  characterLimit: number;
  byteLimit: number;
  pageLimit: number;
  itemLimit: number;
  chunkLimit: number;
  streamReadMs: number;
};

type PdfExtractionResult = { text: string; pages: number; extractedBytes: number; truncationReason?: string };
const encoder = new TextEncoder();

self.onmessage = (event: MessageEvent<PdfExtractionRequest>) => {
  void extractPdf(event.data).then(
    (result) => self.postMessage({ type: "result", result }),
    (error) => self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) }),
  );
};

async function extractPdf(request: PdfExtractionRequest): Promise<PdfExtractionResult> {
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(request.data) });
  const stop = () => { void loadingTask.destroy().catch(() => undefined); };
  try {
    const document = await loadingTask.promise;
    const pageLimit = Math.min(document.numPages, request.pageLimit);
    const parts: string[] = [];
    let characterCount = 0;
    let extractedBytes = 0;
    let pagesRead = 0;
    let limitReason: string | undefined;

    outer: for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      pagesRead = pageNumber;
      const reader = page.streamTextContent().getReader();
      let textItems = 0;
      let chunks = 0;
      let pageHasText = false;
      try {
        while (true) {
          const result = await readChunk(reader, request.streamReadMs);
          if (!result) {
            limitReason = "PDF extraction stopped at the safe page-processing limit";
            await reader.cancel();
            break outer;
          }
          if (result.done) break;
          chunks += 1;
          if (chunks > request.chunkLimit) {
            limitReason = "PDF extraction stopped at the safe stream-chunk limit";
            await reader.cancel();
            break outer;
          }
          for (const item of result.value.items) {
            textItems += 1;
            if (textItems > request.itemLimit) {
              limitReason = "PDF extraction stopped at the safe text-item limit";
              await reader.cancel();
              break outer;
            }
            if (!("str" in item) || !item.str) continue;
            const separator = pageHasText ? " " : pagesRead > 1 ? "\n\n" : "";
            const appended = takeText(`${separator}${item.str}`, request.characterLimit - characterCount, request.byteLimit - extractedBytes);
            if (appended.text) {
              parts.push(appended.text);
              characterCount += appended.characters;
              extractedBytes += appended.bytes;
              pageHasText = true;
            }
            if (!appended.complete || characterCount >= request.characterLimit || extractedBytes >= request.byteLimit) {
              limitReason = extractedBytes >= request.byteLimit
                ? "PDF extraction stopped at the aggregate extracted-content limit"
                : "PDF extraction stopped at the extracted text limit";
              await reader.cancel();
              break outer;
            }
          }
        }
      } finally {
        page.cleanup();
      }
    }
    return {
      text: parts.join(""),
      pages: pagesRead,
      extractedBytes,
      truncationReason: limitReason ?? (pagesRead < document.numPages ? `PDF extraction stopped after ${pagesRead} of ${document.numPages} pages` : undefined),
    };
  } finally {
    stop();
  }
}

async function readChunk(reader: ReadableStreamDefaultReader<any>, timeoutMs: number): Promise<ReadableStreamReadResult<any> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function takeText(value: string, maxCharacters: number, maxBytes: number): { text: string; characters: number; bytes: number; complete: boolean } {
  if (maxCharacters <= 0 || maxBytes <= 0) return { text: "", characters: 0, bytes: 0, complete: false };
  let characters = 0;
  let bytes = 0;
  let text = "";
  for (const character of value) {
    const size = encoder.encode(character).byteLength;
    if (characters + character.length > maxCharacters || bytes + size > maxBytes) return { text, characters, bytes, complete: false };
    text += character;
    characters += character.length;
    bytes += size;
  }
  return { text, characters, bytes, complete: true };
}
