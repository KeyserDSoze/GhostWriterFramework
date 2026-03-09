import { defaultBookRoot } from "./book-config.mjs";
import { exportReaderEpub } from "./book-dev-utils.mjs";

const { result } = await exportReaderEpub(defaultBookRoot);
console.log(`Exported EPUB with ${result.chapterCount} chapters to ${result.outputPath}`);
