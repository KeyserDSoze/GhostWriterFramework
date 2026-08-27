import { AsyncLocalStorage } from "node:async_hooks";
import { readReaderEnv } from "./env.js";

type ReaderCanonMode = "full" | "public" | undefined;

const readerCanonModeStorage = new AsyncLocalStorage<ReaderCanonMode>();

export function isFullCanonMode(): boolean {
  const requestMode = readerCanonModeStorage.getStore();
  if (requestMode === "full") return true;
  if (requestMode === "public") return false;

  const raw = String(readReaderEnv(["NARRARIUM_READER_CANON_MODE", "NARRARIUM_READER_ALLOW_FULL_CANON"]) ?? "")
    .trim()
    .toLowerCase();

  return raw === "1" || raw === "true" || raw === "full" || raw === "author" || raw === "spoilers";
}

export function runWithReaderCanonMode<T>(mode: ReaderCanonMode, callback: () => T): T {
  return readerCanonModeStorage.run(mode, callback);
}

export function readerCanonModeFromCookieHeader(cookieHeader: string): ReaderCanonMode {
  const value = cookieHeader
    .split(";")
    .map((part) => part.trim().split("=", 2))
    .find(([name]) => name === "narrarium-canon")?.[1]
    ?.trim()
    .toLowerCase();

  if (value === "full") return "full";
  if (value === "public") return "public";
  return undefined;
}

/**
 * Returns the raw NARRARIUM_READER_PASSWORD env var value, or null when the
 * variable is not set. Used at build time to derive the AES-256-GCM key for
 * content encryption. Never embedded in the built HTML.
 */
export function getReaderPassword(): string | null {
  return readReaderEnv(["NARRARIUM_READER_PASSWORD"]) ?? null;
}
