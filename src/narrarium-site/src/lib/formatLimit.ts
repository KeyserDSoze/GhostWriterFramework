/** A length of time in the units a person reads it: "150 ms", "30 s", "600 s", "4 h". Figures are written as the language does. */
export function formatLimit(milliseconds: number, language?: string): string {
  const number = (value: number) => new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(value);
  if (milliseconds < 1000) return `${number(milliseconds)} ms`;
  if (milliseconds < 3_600_000) return `${number(milliseconds / 1000)} s`;
  return `${number(milliseconds / 3_600_000)} h`;
}
