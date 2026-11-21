export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .toLowerCase();
}

/** Cyrillic letters (Russian, Ukrainian, Belarusian, Bulgarian, Serbian, Macedonian) in plain Latin letters. */
const CYRILLIC: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o",
  п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  ґ: "g", є: "ye", і: "i", ї: "yi", ў: "u", ђ: "dj", ј: "j", љ: "lj", њ: "nj", ћ: "c", џ: "dz", ѓ: "gj", ќ: "kj", ѕ: "dz",
};

/** Greek letters (accents are removed first) in plain Latin letters. */
const GREEK: Record<string, string> = {
  α: "a", β: "v", γ: "g", δ: "d", ε: "e", ζ: "z", η: "i", θ: "th", ι: "i", κ: "k", λ: "l", μ: "m", ν: "n", ξ: "x", ο: "o", π: "p", ρ: "r",
  σ: "s", ς: "s", τ: "t", υ: "y", φ: "f", χ: "ch", ψ: "ps", ω: "o",
};

/**
 * Cyrillic and Greek text in plain Latin letters, for readable file names; every other character is left as it is
 * (Latin letters, digits, and scripts that have no simple letter-by-letter reading, such as Chinese or Arabic).
 * Cyrillic letters are read before accents are removed, so "й" is "y" and "ё" is "yo"; Greek accents go first.
 */
export function transliterate(value: string): string {
  let text = "";
  for (const character of value.normalize("NFC").toLowerCase()) {
    text += CYRILLIC[character] ?? character.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }
  text = text.replace(/ου/g, "ou");
  let output = "";
  for (const character of text) output += GREEK[character] ?? character;
  return output;
}

/** A short code (base 36) that is the same for the same text, whatever machine or program computes it. */
export function slugCode(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value.normalize("NFC").toLowerCase()) {
    const code = character.codePointAt(0) ?? 0;
    for (const byte of [code & 0xff, (code >>> 8) & 0xff, (code >>> 16) & 0xff]) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash.toString(36).padStart(6, "0");
}

/**
 * Like `slugify`, but never empty. Text that already has a Latin slug keeps exactly that slug (existing books do not
 * change). Otherwise Cyrillic and Greek are transliterated, and any other script becomes `fallback`, followed by a short
 * stable code of the text when `uniqueCode` is set (names of characters, places and the like must not collide).
 */
export function slugifyAny(value: string, fallback: string, uniqueCode = false): string {
  const plain = slugify(value);
  if (plain) return plain;
  const romanized = slugify(transliterate(value));
  if (romanized) return romanized;
  const base = slugify(fallback) || "item";
  return uniqueCode && value.trim() ? `${base}-${slugCode(value)}` : base;
}

export function formatOrdinal(value: number, width = 3): string {
  return String(value).padStart(width, "0");
}

export function chapterSlug(number: number, title: string): string {
  return `${formatOrdinal(number)}-${slugifyAny(title, "chapter")}`;
}

export function paragraphSlug(number: number, title: string): string {
  return `${formatOrdinal(number)}-${slugifyAny(title, "scene")}`;
}
