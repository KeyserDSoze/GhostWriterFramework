import type { APIRoute } from "astro";
import { exportEpub, pathExists } from "narrarium";
import path from "node:path";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { getBookRoot } from "../lib/book.js";
import { getReaderPassword } from "../lib/reader-mode.js";
import { encryptBufferRaw } from "../lib/content-crypto.js";

/**
 * Build-time endpoint that generates the book EPUB and — when a reader
 * password is configured — encrypts it with the same AES-256-GCM key used
 * for page content.
 *
 * Wire format (encrypted):
 *   [12-byte IV][ciphertext ∥ 16-byte GCM auth tag]
 *
 * The client downloads this blob, slices the IV from the first 12 bytes, and
 * decrypts the rest with the already-derived AES key stored in localStorage.
 *
 * Wire format (no password):
 *   Raw EPUB bytes (application/epub+zip).
 */
export const GET: APIRoute = async () => {
  const root = getBookRoot();
  const ready = await pathExists(path.join(root, "book.md"));
  if (!ready) {
    return new Response("Book not found", { status: 404 });
  }

  const password = getReaderPassword();
  const tempId = randomBytes(8).toString("hex");
  const tempPath = path.join(tmpdir(), `narrarium-epub-${tempId}.epub`);

  try {
    await exportEpub(root, { outputPath: tempPath });
    const epubBytes = await readFile(tempPath);

    if (password) {
      const { iv, ct } = encryptBufferRaw(epubBytes, password);
      const combined = Buffer.concat([iv, ct]);
      return new Response(combined, {
        headers: { "Content-Type": "application/octet-stream" },
      });
    }

    return new Response(epubBytes, {
      headers: { "Content-Type": "application/octet-stream" },
    });
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
};
