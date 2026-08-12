const ORDINALS: Record<string, number> = {
  primo: 1,
  prima: 1,
  secondo: 2,
  seconda: 2,
  terzo: 3,
  terza: 3,
  quarto: 4,
  quarta: 4,
  quinto: 5,
  quinta: 5,
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
};

export function ordinalNumber(value: string): number | null {
  const numeric = Number(value);
  if (/^\d+$/.test(value) && Number.isSafeInteger(numeric)) return numeric;
  return ORDINALS[value.toLowerCase()] ?? null;
}
