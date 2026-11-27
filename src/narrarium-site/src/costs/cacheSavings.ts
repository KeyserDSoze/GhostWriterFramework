/** What the provider's prompt cache saved a call: the input tokens it served from the cache, at the full input rate less the cached rate. Prices are per 1,000,000 tokens. */
export function cachedSaving(cachedTokens: number, pricing: { inputPerMTok?: number; cachedPerMTok?: number } | undefined): number {
  const input = pricing?.inputPerMTok;
  const cached = pricing?.cachedPerMTok;
  if (!Number.isFinite(cachedTokens) || cachedTokens <= 0 || typeof input !== "number" || typeof cached !== "number" || !Number.isFinite(input) || !Number.isFinite(cached) || cached >= input) return 0;
  return (cachedTokens / 1_000_000) * (input - cached);
}

/** The share of the input served from the cache, 0 to 1; 0 when there was no input. */
export function cachedShare(inputTokens: number, cachedTokens: number): number {
  if (!(inputTokens > 0) || !(cachedTokens > 0)) return 0;
  return Math.min(1, cachedTokens / inputTokens);
}
