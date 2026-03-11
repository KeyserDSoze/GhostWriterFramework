import { defaultBookRoot } from "./book-config.mjs";
import { exportReaderEpub } from "./book-dev-utils.mjs";

const exportState = await exportReaderEpub(defaultBookRoot);
if (exportState.result.skipped) {
  console.log(`[narrarium-reader] ${exportState.validation.detail}`);
} else {
  console.log(`Exported EPUB with ${exportState.result.chapterCount} chapters to ${exportState.result.outputPath}`);
}
if (exportState.validation.status === "passed") {
  console.log(`[narrarium-reader] ${exportState.validation.detail}`);
} else if (exportState.validation.status === "failed") {
  console.error(`[narrarium-reader] ${exportState.validation.detail}`);
  process.exitCode = 1;
} else {
  console.log(`[narrarium-reader] ${exportState.validation.detail}`);
}
