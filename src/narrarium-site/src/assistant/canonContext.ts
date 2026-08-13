export interface CanonContextCandidate {
  path: string;
  name?: string;
  section: "characters" | "locations" | "factions" | "items" | "timelines";
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function titleFromPath(path: string): string {
  return (path.split("/").pop() ?? path)
    .replace(/\.md$/i, "")
    .replace(/^\d{3}-/, "")
    .replace(/[-_]+/g, " ");
}

function containsPhrase(text: string, phrase: string): boolean {
  const normalizedText = ` ${normalize(text)} `;
  const normalizedPhrase = normalize(phrase);
  return normalizedPhrase.length >= 3 && normalizedText.includes(` ${normalizedPhrase} `);
}

/** Select only canon entries explicitly mentioned in the target prose or request. */
export function selectMentionedCanonFiles(
  candidates: CanonContextCandidate[],
  text: string,
  limit = 12,
): CanonContextCandidate[] {
  const selected: CanonContextCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const names = [candidate.name, titleFromPath(candidate.path)].filter((value): value is string => Boolean(value));
    if (!names.some((name) => containsPhrase(text, name))) continue;
    if (seen.has(candidate.path)) continue;
    selected.push(candidate);
    seen.add(candidate.path);
    if (selected.length >= limit) break;
  }
  return selected.filter((candidate) => {
    const candidateName = normalize(candidate.name ?? titleFromPath(candidate.path));
    return !selected.some((other) => {
      if (other === candidate || other.section !== candidate.section) return false;
      const otherName = normalize(other.name ?? titleFromPath(other.path));
      return otherName.length > candidateName.length && otherName.includes(candidateName);
    });
  });
}
