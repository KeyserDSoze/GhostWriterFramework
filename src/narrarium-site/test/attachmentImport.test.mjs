import assert from "node:assert/strict";
import test from "node:test";
import { ATTACHMENT_IMPORT_TARGETS, attachmentImportRoute, validateImportAttachments } from "../src/assistant/attachmentImport.ts";

test("every advertised attachment target has one typed import route", () => {
  const expected = {
    paragraph: { handler: "paragraph" },
    chapter: { handler: "chapter" },
    note: { handler: "note" },
    character: { handler: "entity", entityKind: "character" },
    location: { handler: "entity", entityKind: "location" },
    faction: { handler: "entity", entityKind: "faction" },
    item: { handler: "entity", entityKind: "item" },
    secret: { handler: "entity", entityKind: "secret" },
    timeline: { handler: "entity", entityKind: "timeline-event" },
    script: { handler: "script" },
    draft: { handler: "draft" },
  };
  assert.deepEqual([...ATTACHMENT_IMPORT_TARGETS], Object.keys(expected));
  for (const target of ATTACHMENT_IMPORT_TARGETS) assert.deepEqual(attachmentImportRoute(target), expected[target]);
});

test("typed entity targets do not depend on English or Italian prompt words", () => {
  assert.deepEqual(attachmentImportRoute("character"), { handler: "entity", entityKind: "character" });
  assert.deepEqual(attachmentImportRoute("location"), { handler: "entity", entityKind: "location" });
  assert.deepEqual(attachmentImportRoute("timeline"), { handler: "entity", entityKind: "timeline-event" });
});

test("rejects empty and malformed text or image attachments", () => {
  assert.match(validateImportAttachments([]), /Attach at least one/);
  assert.match(validateImportAttachments([{ id: "a", name: "empty.txt", mimeType: "text/plain", kind: "text", sizeBytes: 0, textContent: "" }]), /no readable text/);
  assert.match(validateImportAttachments([{ id: "b", name: "bad.png", mimeType: "image/png", kind: "image", sizeBytes: 10, imageDataUrl: "https://example.test/image.png" }]), /invalid image data/);
});

test("accepts valid extracted text and image attachments", () => {
  assert.equal(validateImportAttachments([{ id: "a", name: "notes.md", mimeType: "text/markdown", kind: "text", sizeBytes: 20, textContent: "Scene notes" }]), null);
  assert.equal(validateImportAttachments([{ id: "b", name: "map.png", mimeType: "image/png", kind: "image", sizeBytes: 20, imageDataUrl: "data:image/png;base64,AA==" }]), null);
});
