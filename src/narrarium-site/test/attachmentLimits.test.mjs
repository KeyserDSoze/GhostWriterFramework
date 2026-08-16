import assert from "node:assert/strict";
import test from "node:test";
import {
  ATTACHMENT_LIMITS,
  constrainAttachmentsToTokenBudget,
  parseAttachment,
  pdfPageLimit,
  validateAttachmentSelection,
} from "../src/assistant/attachments.ts";

function file(name, size, type = "text/plain", contents = "x") {
  return new File([contents.padEnd(size, "x")], name, { type });
}

test("accepts attachment count and bytes exactly at the aggregate boundaries", () => {
  const size = ATTACHMENT_LIMITS.aggregateBytes / ATTACHMENT_LIMITS.count;
  const files = Array.from({ length: ATTACHMENT_LIMITS.count }, (_, index) => file(`${index}.txt`, size));
  assert.doesNotThrow(() => validateAttachmentSelection(files));
});

test("rejects oversized and many-file selections before extraction", () => {
  assert.throws(() => validateAttachmentSelection(Array.from({ length: ATTACHMENT_LIMITS.count + 1 }, (_, index) => file(`${index}.txt`, 1))), /at most 8/);
  assert.throws(() => validateAttachmentSelection([file("large.txt", ATTACHMENT_LIMITS.fileBytes + 1)]), /too large/);
  assert.throws(() => validateAttachmentSelection([file("one.png", ATTACHMENT_LIMITS.imageBytes, "image/png"), file("two.png", ATTACHMENT_LIMITS.imageBytes + 1, "image/png")]), /too large/);
});

test("rejects corrupt PDF and DOCX signatures before loading extractors", async () => {
  await assert.rejects(parseAttachment(new File(["not a pdf"], "bad.pdf", { type: "application/pdf" })), /not a valid PDF/);
  await assert.rejects(parseAttachment(new File(["not a docx"], "bad.docx", { type: "application\/vnd.openxmlformats-officedocument.wordprocessingml.document" })), /not a valid DOCX/);
});

test("marks per-file extraction truncation in attachment metadata", async () => {
  const attachment = await parseAttachment(new File(["a".repeat(ATTACHMENT_LIMITS.textCharactersPerFile + 10)], "long.txt", { type: "text/plain" }));
  assert.equal(attachment.textContent.length, ATTACHMENT_LIMITS.textCharactersPerFile);
  assert.equal(attachment.truncated, true);
  assert.match(attachment.truncationReason, /text limit/);
});

test("does not read a file after the aggregate extraction budget is exhausted", async () => {
  let read = false;
  const input = new File(["unreachable"], "late.txt", { type: "text/plain" });
  Object.defineProperty(input, "text", { value: async () => { read = true; return "unreachable"; } });
  const attachment = await parseAttachment(input, { textCharacters: 0, pdfPages: 0, extractedBytes: 0 });
  assert.equal(read, false);
  assert.equal(attachment.truncated, true);
  assert.match(attachment.truncationReason, /before extraction/);
});

test("caps PDF extraction at per-file and aggregate page boundaries", () => {
  assert.equal(pdfPageLimit(100, 200), 100);
  assert.equal(pdfPageLimit(101, 200), ATTACHMENT_LIMITS.pdfPagesPerFile);
  assert.equal(pdfPageLimit(100, 7), 7);
  assert.equal(pdfPageLimit(100, 0), 0);
});

test("rejects a highly compressed DOCX before Mammoth extraction", async () => {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file("word/document.xml", "a".repeat(1024 * 1024));
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 9 } });
  await assert.rejects(parseAttachment(new File([Uint8Array.from(bytes).buffer], "bomb.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })), /safe DOCX extraction limit/);
});

test("incrementally extracts a normal DOCX and reports measured output bytes", async () => {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const xml = "<w:document><w:p><w:r><w:t>Normal chapter text</w:t></w:r></w:p></w:document>";
  zip.file("word/document.xml", xml);
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });

  const attachment = await parseAttachment(new File([Uint8Array.from(bytes).buffer], "normal.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));

  assert.match(attachment.textContent, /Normal chapter text/);
  assert.equal(attachment.extractedBytes, new TextEncoder().encode(xml).byteLength);
  assert.equal(attachment.truncated, false);
});

test("measures actual DOCX output instead of trusting forged ZIP sizes", async () => {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file("word/document.xml", `<w:document><w:p><w:r><w:t>${"secret ".repeat(100_000)}</w:t></w:r></w:p></w:document>`);
  const generated = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 9 } });
  const forged = Uint8Array.from(generated);
  forgeZipUncompressedSizes(forged, 1);

  await assert.rejects(
    parseAttachment(new File([forged.buffer], "forged.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), { textCharacters: 60_000, pdfPages: 0, extractedBytes: 4_096 }),
    /safe DOCX extraction limit/,
  );
});

test("fits attachment excerpts to the selected model budget with a visible reason", () => {
  const [attachment] = constrainAttachmentsToTokenBudget([{ id: "a", name: "notes.txt", mimeType: "text/plain", kind: "text", sizeBytes: 100, textContent: "a".repeat(100), estimatedTokens: 25 }], 10);
  assert.equal(attachment.textContent.length, 40);
  assert.equal(attachment.estimatedTokens, 10);
  assert.equal(attachment.truncated, true);
  assert.match(attachment.truncationReason, /selected model/);
});

test("marks images omitted from a selected model budget", () => {
  const [attachment] = constrainAttachmentsToTokenBudget([{ id: "i", name: "map.png", mimeType: "image/png", kind: "image", sizeBytes: 1024, imageDataUrl: "data:image/png;base64,AA==", estimatedTokens: 2 }], 1);
  assert.equal(attachment.imageDataUrl, undefined);
  assert.equal(attachment.truncated, true);
  assert.match(attachment.truncationReason, /omitted this image/);
});

test("does not trust persisted image size metadata or non-image data URLs", () => {
  const oversized = `data:image/png;base64,${"A".repeat(Math.ceil((ATTACHMENT_LIMITS.imageBytes + 1) * 4 / 3))}`;
  const constrained = constrainAttachmentsToTokenBudget([
    { id: "i", name: "large.png", mimeType: "image/png", kind: "image", sizeBytes: 1, imageDataUrl: oversized },
    { id: "j", name: "fake.png", mimeType: "image/png", kind: "image", sizeBytes: 1, imageDataUrl: "data:text/html;base64,PHNjcmlwdD4=" },
  ], ATTACHMENT_LIMITS.estimatedTokens);
  assert.equal(constrained[0].imageDataUrl, undefined);
  assert.match(constrained[0].truncationReason, /boundary/);
  assert.equal(constrained[1].imageDataUrl, undefined);
  assert.match(constrained[1].truncationReason, /unsafe image/);
});

test("session ownership can discard a completed parse after switching sessions", async () => {
  let activeSessionId = "first";
  const requestedSessionId = activeSessionId;
  const parsed = await parseAttachment(new File(["safe"], "safe.txt", { type: "text/plain" }));
  activeSessionId = "second";
  const committed = activeSessionId === requestedSessionId ? [parsed] : [];
  assert.deepEqual(committed, []);
});

function forgeZipUncompressedSizes(bytes, value) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset <= bytes.byteLength - 30; offset += 1) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x04034b50) view.setUint32(offset + 22, value, true);
    if (signature === 0x02014b50) view.setUint32(offset + 24, value, true);
  }
}
