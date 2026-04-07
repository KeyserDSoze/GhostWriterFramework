import { createHash } from "node:crypto";
import { readReaderEnv } from "./env.js";

export function isFullCanonMode(): boolean {
  const raw = String(readReaderEnv(["NARRARIUM_READER_CANON_MODE", "NARRARIUM_READER_ALLOW_FULL_CANON"]) ?? "")
    .trim()
    .toLowerCase();

  return raw === "1" || raw === "true" || raw === "full" || raw === "author" || raw === "spoilers";
}

/**
 * Returns the raw NARRARIUM_READER_PASSWORD env var value, or null when the
 * variable is not set. Used at build time to derive the AES-256-GCM key for
 * content encryption. Never embedded in the built HTML.
 */
export function getReaderPassword(): string | null {
  return readReaderEnv(["NARRARIUM_READER_PASSWORD"]) ?? null;
}

/**
 * Returns a SHA-256 hex hash of the NARRARIUM_READER_PASSWORD env var,
 * or null when the variable is not set. The hash is embedded in the built
 * HTML and compared against the user's input at runtime via SubtleCrypto
 * as a fast pre-filter before the more expensive PBKDF2 key derivation.
 */
export function getReaderPasswordHash(): string | null {
  const raw = readReaderEnv(["NARRARIUM_READER_PASSWORD"]);
  if (!raw) return null;
  return createHash("sha256").update(raw).digest("hex");
}
