import { mkdir } from "node:fs/promises";
import path from "node:path";
import { exportEpub } from "@ghostwriter/core";

const bookRoot = process.env.GHOSTWRITER_BOOK_ROOT
  ? path.resolve(process.env.GHOSTWRITER_BOOK_ROOT)
  : path.resolve(process.cwd(), "../../example-book");
const outputPath = path.resolve(process.cwd(), "public", "downloads", "book.epub");

await mkdir(path.dirname(outputPath), { recursive: true });
const result = await exportEpub(bookRoot, { outputPath });
console.log(`Exported EPUB with ${result.chapterCount} chapters to ${result.outputPath}`);
