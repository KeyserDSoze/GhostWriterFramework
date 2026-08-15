const STOPWORDS = new Set(["a", "an", "and", "are", "about", "book", "canon", "chapter", "character", "characters", "for", "find", "in", "of", "on", "or", "paragraph", "paragraphs", "research", "search", "show", "the", "to", "with", "book", "capitolo", "capitoli", "cerca", "cercare", "di", "e", "il", "in", "la", "le", "libro", "mi", "mostra", "nel", "nella", "o", "paragrafo", "paragrafi", "personaggio", "personaggi", "per", "ricerca", "su", "tra", "trova"]);

function normalize(value: string): string { return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); }

export function parseBookSearchQuery(query: string): { terms: string[]; phrases: string[] } {
  const phrases = [...query.matchAll(/["“”]([^"“”]+)["“”]/g)].map((match) => normalize(match[1]).trim()).filter(Boolean);
  const withoutPhrases = query.replace(/["“”][^"“”]+["“”]/g, " ");
  const terms = [...new Set(normalize(withoutPhrases).match(/[\p{L}\p{N}]+/gu)?.filter((term) => term.length > 1 && !STOPWORDS.has(term)) ?? [])];
  return { terms, phrases };
}

export interface SearchableBookText { path: string; role: string; content: string; }
export interface RankedBookSearchResult { path: string; role: string; score: number; excerpt: string; }

export function searchBookTexts(files: SearchableBookText[], query: string, limit = 12): { results: RankedBookSearchResult[]; total: number } {
  const parsed = parseBookSearchQuery(query);
  const needles = [...parsed.phrases, ...parsed.terms];
  if (!needles.length) return { results: [], total: 0 };
  const ranked: RankedBookSearchResult[] = [];
  for (const file of files) {
    const normalizedPath = normalize(file.path);
    const normalizedContent = normalize(file.content);
    const matched = needles.filter((needle) => normalizedPath.includes(needle) || normalizedContent.includes(needle));
    if (!matched.length) continue;
    const coverage = matched.length / needles.length;
    const phraseHits = parsed.phrases.filter((phrase) => normalizedContent.includes(phrase)).length;
    const pathHits = matched.filter((needle) => normalizedPath.includes(needle)).length;
    const score = Math.round((coverage * 100) + phraseHits * 80 + pathHits * 30);
    const first = matched.map((needle) => normalizedContent.indexOf(needle)).filter((index) => index >= 0).sort((a, b) => a - b)[0];
    const start = first === undefined ? 0 : Math.max(0, first - 100);
    const excerpt = first === undefined ? "" : file.content.slice(start, Math.min(file.content.length, start + 280)).replace(/\s+/g, " ").trim();
    ranked.push({ path: file.path, role: file.role, score, excerpt });
  }
  ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return { results: ranked.slice(0, limit), total: ranked.length };
}
