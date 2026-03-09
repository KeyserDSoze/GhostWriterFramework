import { mkdir } from "node:fs/promises";
import path from "node:path";
import { exportEpub } from "narrarium";

const configuredBookRoot = process.env.NARRARIUM_BOOK_ROOT ?? process.env.GHOSTWRITER_BOOK_ROOT;
const bookRoot = configuredBookRoot
  ? path.resolve(configuredBookRoot)
  : path.resolve(process.cwd(), "../../example-book");
const outputPath = path.resolve(process.cwd(), "public", "downloads", "book.epub");

await mkdir(path.dirname(outputPath), { recursive: true });
const result = await exportEpub(bookRoot, { outputPath });
console.log(`Exported EPUB with ${result.chapterCount} chapters to ${result.outputPath}`);
