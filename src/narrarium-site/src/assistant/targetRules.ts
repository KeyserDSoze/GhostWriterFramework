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

const ORDINAL_WORDS = Object.keys(ORDINALS).join("|");

export interface TargetParagraphLike {
  number: string;
  title: string;
  path: string;
}

export interface TargetChapterLike<P extends TargetParagraphLike = TargetParagraphLike> {
  slug: string;
  title: string;
  paragraphs: P[];
}

export interface TargetResolution<T> {
  value: T | null;
  explicit: boolean;
  status: "ambient" | "resolved" | "missing" | "ambiguous";
  reference?: string;
}

export function ordinalNumber(value: string): number | null {
  const numeric = Number(value);
  if (/^\d+$/.test(value) && Number.isSafeInteger(numeric)) return numeric;
  return ORDINALS[value.toLowerCase()] ?? null;
}

function normalizeTargetText(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function namedReference<T extends { title: string }>(prompt: string, nouns: string, values: T[]): string | null {
  const patterns = [
    new RegExp(`(?:${nouns})\\s+(?:named|titled|chiamat[oa]|intitolat[oa])\\s+["“”']([^"“”']+)["“”']`, "i"),
    new RegExp(`(?:${nouns})\\s+["“”']([^"“”']+)["“”']`, "i"),
  ];
  const quoted = patterns.map((pattern) => prompt.match(pattern)?.[1]?.trim()).find(Boolean);
  if (quoted) return quoted;

  const labeled = prompt.match(new RegExp(`(?:${nouns})\\s+(?:named|titled|chiamat[oa]|intitolat[oa])\\s+([^,.!?;]+)`, "i"))?.[1]?.trim();
  const trailing = labeled ?? prompt.match(new RegExp(`(?:${nouns})\\s+([^,.!?;]+)`, "i"))?.[1]?.trim();
  if (!trailing) return null;
  const normalizedTrailing = normalizeTargetText(trailing);
  const knownMatches = values
    .filter((value) => {
      const title = normalizeTargetText(value.title);
      if (normalizedTrailing === title) return true;
      if (!normalizedTrailing.startsWith(`${title} `)) return false;
      const remainder = normalizedTrailing.slice(title.length + 1);
      return /^(?:(?:in|of) (?:the )?(?:chapter|capitolo)\b|(?:nel|del|della) capitolo\b|(?:with|using|con|usando) (?:readers?|lettori|feedback)\b|in detail\b|nel dettaglio\b|deeply\b|briefly\b|thoroughly\b|carefully\b|approfonditamente\b|brevemente\b|attentamente\b|(?:to|per) (?:improve|rewrite|review|evaluate|migliorare|riscrivere|rivedere|valutare)\b)/.test(remainder);
    })
    .sort((left, right) => normalizeTargetText(right.title).length - normalizeTargetText(left.title).length);
  if (knownMatches.length) return knownMatches[0].title;

  const candidate = trailing
    .split(/\b(?:in|of)\s+(?:the\s+)?(?:chapter|capitolo)\b|\b(?:nel|del|della)\s+capitolo\b|\b(?:with|using|con|usando)\s+(?:readers?|lettori|feedback)\b|\b(?:and then|e poi)\b|\b(?:in detail|nel dettaglio|deeply|briefly|thoroughly|carefully|approfonditamente|brevemente|attentamente)\b|\b(?:to|per)\s+(?:improve|rewrite|review|evaluate|migliorare|riscrivere|rivedere|valutare)\b/i)[0]
    .trim();
  if (!candidate || /^(?:this|current|the current|questo|questa|corrente|\d+|primo|prima|secondo|seconda|terzo|terza|quarto|quarta|quinto|quinta|first|second|third|fourth|fifth|ultimo|ultima|latest|last|named|titled|chiamato|chiamata|intitolato|intitolata|aloud|ad alta voce|info|information|details|dettagli|evaluation|valutazione|review|summary|riassunto|body|text|testo|critically|critical|critico|criticamente)$/i.test(candidate)) return null;
  return candidate;
}

export function resolveChapterTarget<C extends TargetChapterLike>(prompt: string, chapters: C[], ambient: C | null): TargetResolution<C> {
  const lower = prompt.toLowerCase();
  const numeric = lower.match(/(?:capitolo|chapter)\s+(\d+)\b/);
  if (numeric) {
    const padded = numeric[1].padStart(3, "0");
    return { value: chapters.find((chapter) => chapter.slug.startsWith(`${padded}-`)) ?? null, explicit: true, status: chapters.some((chapter) => chapter.slug.startsWith(`${padded}-`)) ? "resolved" : "missing", reference: numeric[0] };
  }

  const ordinal = lower.match(new RegExp(`(?:capitolo|chapter)\\s+(${ORDINAL_WORDS})\\b|\\b(${ORDINAL_WORDS})\\s+(?:capitolo|chapter)\\b`, "i"));
  if (ordinal) {
    const number = ordinalNumber(ordinal[1] ?? ordinal[2]);
    const value = number ? chapters[number - 1] ?? null : null;
    return { value, explicit: true, status: value ? "resolved" : "missing", reference: ordinal[0] };
  }

  const latest = lower.match(/(?:ultimo|ultima|latest|last)\s+(?:capitolo|chapter)\b|(?:capitolo|chapter)\s+(?:ultimo|ultima|latest|last)\b/);
  if (latest) {
    const value = chapters[chapters.length - 1] ?? null;
    return { value, explicit: true, status: value ? "resolved" : "missing", reference: latest[0] };
  }

  const named = namedReference(prompt, "capitolo|chapter", chapters);
  if (named) {
    const matches = chapters.filter((chapter) => normalizeTargetText(chapter.title) === normalizeTargetText(named));
    return { value: matches.length === 1 ? matches[0] : null, explicit: true, status: matches.length > 1 ? "ambiguous" : matches.length === 1 ? "resolved" : "missing", reference: named };
  }

  return { value: ambient, explicit: false, status: ambient ? "ambient" : "missing" };
}

export function resolveParagraphTarget<C extends TargetChapterLike<P>, P extends TargetParagraphLike>(
  prompt: string,
  chapterResolution: TargetResolution<C>,
  ambientChapter: C | null,
  ambientParagraph: P | null,
): TargetResolution<{ chapter: C; paragraph: P }> {
  const lower = prompt.toLowerCase();
  const chapterOnly = /\b(capitolo|chapter)\b/.test(lower) && !/\b(paragrafo|paragraph|scena|scene)\b/.test(lower);
  const numeric = lower.match(/(?:paragrafo|paragraph|scena|scene)\s+(\d+)\b/);
  const ordinal = lower.match(new RegExp(`(?:paragrafo|paragraph|scena|scene)\\s+(${ORDINAL_WORDS})\\b|\\b(${ORDINAL_WORDS})\\s+(?:paragrafo|paragraph|scena|scene)\\b`, "i"));
  const latest = lower.match(/(?:ultimo|ultima|latest|last)\s+(?:paragrafo|paragraph|scena|scene)\b|(?:paragrafo|paragraph|scena|scene)\s+(?:ultimo|ultima|latest|last)\b/);
  const named = namedReference(prompt, "paragrafo|paragraph|scena|scene", chapterResolution.value?.paragraphs ?? ambientChapter?.paragraphs ?? []);
  const explicit = Boolean(numeric || ordinal || latest || named);

  if (chapterResolution.explicit && !chapterResolution.value) {
    return { value: null, explicit, status: chapterResolution.status, reference: explicit ? numeric?.[0] ?? ordinal?.[0] ?? latest?.[0] ?? named ?? undefined : chapterResolution.reference };
  }
  const chapter = chapterResolution.value ?? ambientChapter;
  if (!chapter) return { value: null, explicit, status: "missing", reference: numeric?.[0] ?? ordinal?.[0] ?? latest?.[0] ?? named ?? undefined };

  let matches: P[] = [];
  let reference: string | undefined;
  if (numeric) {
    matches = chapter.paragraphs.filter((paragraph) => paragraph.number === numeric[1].padStart(3, "0"));
    reference = numeric[0];
  } else if (ordinal) {
    const number = ordinalNumber(ordinal[1] ?? ordinal[2]);
    matches = number && chapter.paragraphs[number - 1] ? [chapter.paragraphs[number - 1]] : [];
    reference = ordinal[0];
  } else if (latest) {
    matches = chapter.paragraphs.length ? [chapter.paragraphs[chapter.paragraphs.length - 1]] : [];
    reference = latest[0];
  } else if (named) {
    matches = chapter.paragraphs.filter((paragraph) => normalizeTargetText(paragraph.title) === normalizeTargetText(named));
    reference = named;
  }

  if (matches.length > 1) return { value: null, explicit: true, status: "ambiguous", reference };
  if (matches.length === 1) return { value: { chapter, paragraph: matches[0] }, explicit: true, status: "resolved", reference };
  if (explicit) return { value: null, explicit: true, status: "missing", reference };
  if (chapterOnly) return { value: null, explicit: false, status: "missing" };
  if (chapterResolution.explicit) return { value: null, explicit: false, status: "missing" };
  if (ambientParagraph && ambientChapter?.slug === chapter.slug) return { value: { chapter, paragraph: ambientParagraph }, explicit: false, status: "ambient" };
  return { value: null, explicit: false, status: "missing" };
}
