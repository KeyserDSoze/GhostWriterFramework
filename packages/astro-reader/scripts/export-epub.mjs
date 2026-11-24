import { defaultBookRoot } from "./book-config.mjs";
import { exportReaderEpub, isProtectedBuildRequested, removePublicEpub } from "./book-dev-utils.mjs";

if (isProtectedBuildRequested()) {
  // Astro publishes everything in public/: a protected book's EPUB is published only by the reader, encrypted.
  await removePublicEpub();
  console.log("[narrarium-reader] Protected book: no EPUB in clear in public/downloads (the reader publishes it encrypted).");
  process.exit(0);
}

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
