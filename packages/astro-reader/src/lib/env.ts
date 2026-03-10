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

export function readReaderBookRootEnv(sources: EnvSource[] = [process.env, astroEnv]): string | undefined {
  const value = readReaderEnv(["NARRARIUM_BOOK_ROOT", "GHOSTWRITER_BOOK_ROOT"], sources);
  if (!value || isClearlyInvalidBookRootValue(value)) {
    return undefined;
  }

  return value;
}
