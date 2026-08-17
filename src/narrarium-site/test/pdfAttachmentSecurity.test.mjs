import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workerSource = await readFile(new URL("../src/assistant/pdfAttachment.worker.ts", import.meta.url), "utf8");
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("PDF attachment extraction uses a patched parser without viewer scripting components", () => {
  const version = packageJson.dependencies["pdfjs-dist"];
  assert.match(version, /^\^6\.(?:[3-9]|[1-9]\d)\.|^\^6\.2\.(?:10[8-9]|1[1-9]\d|[2-9]\d\d)|^[>=~^]*[7-9]\./);
  const pdfImports = [...workerSource.matchAll(/from\s+["'](pdfjs-dist\/[^"']+)["']/g)].map((match) => match[1]);
  assert.deepEqual(pdfImports, [
    "pdfjs-dist/legacy/build/pdf.mjs",
    "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url",
  ]);
  assert.doesNotMatch(workerSource, /pdfjs-dist\/web|viewer|PDFScriptingManager|pdf_scripting_manager|AnnotationLayerBuilder|enableScripting/i);
  assert.match(workerSource, /pdfjs\.getDocument\s*\(/);
});
