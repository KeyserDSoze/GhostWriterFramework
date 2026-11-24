import { existsSync } from "node:fs";
import path from "node:path";

type EnvSource = Record<string, string | undefined> | null | undefined;

const astroEnv = ((import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {}) as Record<
  string,
  string | undefined
>;

export function normalizeReaderEnvValue(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim() || undefined;
  }

  return trimmed;
}

export function isClearlyInvalidBookRootValue(value: string | null | undefined): boolean {
  const normalized = normalizeReaderEnvValue(value);
  if (!normalized) {
    return true;
  }

  return normalized === "/" || normalized === "\\" || /^[a-zA-Z]:(?:[\\/])?$/.test(normalized);
}

export function readReaderEnv(keys: string[], sources: EnvSource[] = [process.env, astroEnv]): string | undefined {
  for (const source of sources) {
    if (!source) {
      continue;
    }

    for (const key of keys) {
      const value = normalizeReaderEnvValue(source[key]);
      if (value) {
        return value;
      }
    }
  }

  return undefined;
}

/**
 * The raw values of these variables, the process's first and then the ones Astro read from `.env` (`astro build` does not put those in
 * `process.env`). Raw: a JSON of secrets must reach its parser as it is.
 */
export function readReaderEnvSnapshot(keys: string[], sources: EnvSource[] = [process.env, astroEnv]): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of keys) {
    for (const source of sources) {
      const value = source?.[key];
      if (typeof value === "string" && value.trim()) {
        snapshot[key] = value;
        break;
      }
    }
  }
  return snapshot;
}

export function readReaderBookRootEnv(sources: EnvSource[] = [process.env, astroEnv]): string | undefined {
  const value = readReaderEnv(["NARRARIUM_BOOK_ROOT", "GHOSTWRITER_BOOK_ROOT"], sources);
  if (!value || isClearlyInvalidBookRootValue(value)) {
    return undefined;
  }

  return value;
}

export function resolveReaderBookRootCandidate(value: string | null | undefined, cwd = process.cwd()): string | undefined {
  const normalized = normalizeReaderEnvValue(value);
  if (!normalized || isClearlyInvalidBookRootValue(normalized)) {
    return undefined;
  }

  const resolved = path.resolve(cwd, normalized);
  return existsSync(path.join(resolved, "book.md")) ? resolved : undefined;
}
