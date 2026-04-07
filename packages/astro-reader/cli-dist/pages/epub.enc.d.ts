import type { APIRoute } from "astro";
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
export declare const GET: APIRoute;
//# sourceMappingURL=epub.enc.d.ts.map