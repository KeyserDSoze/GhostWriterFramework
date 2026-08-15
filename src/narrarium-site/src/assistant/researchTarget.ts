export interface ResearchTargetCandidate { path: string; slug: string; title: string; }
export type ResearchTargetResolution = { status: "resolved"; file: ResearchTargetCandidate } | { status: "missing" | "ambiguous"; matches: ResearchTargetCandidate[] };

const normalize = (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9/.-]+/g, " ").trim();

export function isCreateFromResearchPrompt(prompt: string): boolean {
  const entity = /\b(?:character|personaggio|location|luogo|faction|fazione|item|oggetto|secret|segreto|timeline|event|evento)\b/i.test(prompt);
  return entity && /\b(?:from|using|da|dalla|usando|partendo)\b[\s\S]{0,60}\b(?:research|ricerca)\b/i.test(prompt);
}

export function resolveResearchTarget(prompt: string, files: ResearchTargetCandidate[], currentSlug?: string): ResearchTargetResolution {
  const lower = normalize(prompt);
  const explicitPath = /research\/([a-z0-9._/-]+\.md)/.exec(lower)?.[0];
  if (explicitPath) {
    const found = files.filter((file) => normalize(file.path) === explicitPath);
    return found.length === 1 ? { status: "resolved", file: found[0] } : { status: "missing", matches: [] };
  }
  if (/\b(this research|questa ricerca|current research|ricerca corrente)\b/i.test(prompt) && currentSlug) {
    const current = files.filter((file) => file.slug === currentSlug);
    return current.length === 1 ? { status: "resolved", file: current[0] } : { status: "missing", matches: [] };
  }
  const exact = files.filter((file) => lower.includes(normalize(file.slug)) || lower.includes(normalize(file.title)));
  if (exact.length === 1) return { status: "resolved", file: exact[0] };
  if (exact.length > 1) return { status: "ambiguous", matches: exact };
  const generic = new Set(["create", "crea", "from", "dalla", "dalla", "research", "ricerca", "character", "personaggio", "location", "luogo", "faction", "fazione", "item", "oggetto", "secret", "segreto", "timeline", "event", "evento"]);
  const terms = lower.split(/[^a-z0-9]+/).filter((term) => term.length >= 4 && !generic.has(term));
  const partial = files.filter((file) => terms.some((term) => normalize(`${file.slug} ${file.title}`).split(/[^a-z0-9]+/).includes(term)));
  if (partial.length > 1) return { status: "ambiguous", matches: partial };
  return { status: "missing", matches: [] };
}
