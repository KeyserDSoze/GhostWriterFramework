import assert from "node:assert/strict";
import test from "node:test";
import { chapterOutputSchema, entityOutputSchema, multiFileOutputSchema, parseStructuredOutput, readerOutputSchema } from "../src/assistant/structuredOutput.ts";

test("rejects empty malformed non-object partial and wrong-type responses", () => {
  assert.throws(() => parseStructuredOutput("", chapterOutputSchema), /Invalid JSON/);
  assert.throws(() => parseStructuredOutput("{bad", chapterOutputSchema), /Invalid JSON/);
  assert.throws(() => parseStructuredOutput("[]", chapterOutputSchema), /one JSON object/);
  assert.throws(() => parseStructuredOutput('{"title":"Only"}', chapterOutputSchema), /summary|body/);
  assert.throws(() => parseStructuredOutput('{"title":4,"summary":"","body":"Body"}', chapterOutputSchema), /title/);
});

test("strict schemas reject extra top-level fields", () => {
  assert.throws(() => parseStructuredOutput('{"title":"Title","summary":"Summary","body":"Body","unexpected":true}', chapterOutputSchema), /Unrecognized key/);
});

test("entity output requires complete non-placeholder content", () => {
  assert.throws(() => parseStructuredOutput('{"label":"","summary":"","body":"","extraFrontmatter":{}}', entityOutputSchema), /label|body/);
  assert.deepEqual(parseStructuredOutput('{"label":"Lyra","summary":"Lead","body":"Description","extraFrontmatter":{}}', entityOutputSchema), { label: "Lyra", summary: "Lead", body: "Description", extraFrontmatter: {} });
});

test("reader output rejects partial profiles", () => {
  assert.throws(() => parseStructuredOutput('{"name":"Reader"}', readerOutputSchema), /description/);
});

test("one malformed multi-file entry rejects the complete plan", () => {
  const raw = JSON.stringify({ summary: "Plan", updates: [{ path: "good.md", content: "Good", reason: "Needed" }, { path: "../bad.md", content: "Bad", reason: "Unsafe" }] });
  assert.throws(() => parseStructuredOutput(raw, multiFileOutputSchema), /safe relative/);
});
