import { stringify, parseDocument } from "yaml";

export interface GhostwriterProfile {
  slug: string;
  name: string;
  language: string;
  tone: string;
  voice: string;
  povDefault: string;
  tenseDefault: string;
  sentenceRhythm: string;
  dialogueStyle: string;
  vocabulary: string;
  writingStyle: string;
  punctuationStyle: string;
  influences: string[];
  strengths: string[];
  avoid: string[];
  temperature: number;
  body: string;
}

export function ghostwriterReferencePaths(files: Array<{ path: string }>): string[] {
  return Array.from(new Set(files.map((file) => file.path))).filter(
    (path) => path === "book.md" || /^(?:chapters|drafts|scripts)\/.*\.md$/.test(path),
  );
}

export function canDeleteGhostwriter(slug: string, defaultSlug: string | undefined, profileCount: number): boolean {
  return profileCount > 1 && slug !== defaultSlug;
}

export function emptyGhostwriter(name: string): Omit<GhostwriterProfile, "slug"> {
  return {
    name,
    language: "",
    tone: "",
    voice: "",
    povDefault: "",
    tenseDefault: "",
    sentenceRhythm: "",
    dialogueStyle: "",
    vocabulary: "",
    writingStyle: "",
    punctuationStyle: "",
    influences: [],
    strengths: [],
    avoid: [],
    temperature: 0.8,
    body: "Describe how this ghostwriter writes: their craft, instincts, and what makes their prose recognizable.\n",
  };
}

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value === "string" && value.trim()) return value.split(",").map((part) => part.trim()).filter(Boolean);
  return [];
}

export function parseGhostwriter(slug: string, raw: string): GhostwriterProfile {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  const fm = (match ? (parseDocument(match[1]).toJSON() as Record<string, unknown>) : {}) ?? {};
  const body = match ? match[2].trim() : raw.trim();
  const str = (key: string) => (typeof fm[key] === "string" ? (fm[key] as string) : "");
  return {
    slug,
    name: str("name") || slug,
    language: str("language"),
    tone: str("tone"),
    voice: str("voice"),
    povDefault: str("pov_default"),
    tenseDefault: str("tense_default"),
    sentenceRhythm: str("sentence_rhythm"),
    dialogueStyle: str("dialogue_style"),
    vocabulary: str("vocabulary"),
    writingStyle: str("writing_style"),
    punctuationStyle: str("punctuation_style"),
    influences: asArray(fm["influences"]),
    strengths: asArray(fm["strengths"]),
    avoid: asArray(fm["avoid"]),
    temperature: typeof fm["temperature"] === "number" ? (fm["temperature"] as number) : 0.8,
    body,
  };
}

export function serializeGhostwriter(profile: GhostwriterProfile): string {
  const frontmatter: Record<string, unknown> = {
    type: "ghostwriter",
    id: `ghostwriter:${profile.slug}`,
    name: profile.name,
    language: profile.language || undefined,
    tone: profile.tone || undefined,
    voice: profile.voice || undefined,
    pov_default: profile.povDefault || undefined,
    tense_default: profile.tenseDefault || undefined,
    sentence_rhythm: profile.sentenceRhythm || undefined,
    dialogue_style: profile.dialogueStyle || undefined,
    vocabulary: profile.vocabulary || undefined,
    writing_style: profile.writingStyle || undefined,
    punctuation_style: profile.punctuationStyle || undefined,
    influences: profile.influences,
    strengths: profile.strengths,
    avoid: profile.avoid,
    temperature: profile.temperature,
  };
  for (const key of Object.keys(frontmatter)) if (frontmatter[key] === undefined) delete frontmatter[key];
  return `---\n${stringify(frontmatter).trim()}\n---\n\n${profile.body.trim()}\n`;
}

/** Render a ghostwriter profile as a compact natural-language instruction block for the LLM. */
export function ghostwriterPrompt(profile: GhostwriterProfile): string {
  const lines: string[] = [`Ghostwriter persona: ${profile.name}.`];
  if (profile.language) lines.push(`Language: ${profile.language}.`);
  if (profile.tone) lines.push(`Tone: ${profile.tone}.`);
  if (profile.voice) lines.push(`Voice: ${profile.voice}.`);
  if (profile.povDefault) lines.push(`Default POV: ${profile.povDefault}.`);
  if (profile.tenseDefault) lines.push(`Default tense: ${profile.tenseDefault}.`);
  if (profile.sentenceRhythm) lines.push(`Sentence rhythm: ${profile.sentenceRhythm}.`);
  if (profile.dialogueStyle) lines.push(`Dialogue style: ${profile.dialogueStyle}.`);
  if (profile.vocabulary) lines.push(`Vocabulary: ${profile.vocabulary}.`);
  if (profile.writingStyle) lines.push(`Writing style: ${profile.writingStyle}.`);
  if (profile.punctuationStyle) lines.push(`Binding punctuation style: ${profile.punctuationStyle}.`);
  if (profile.influences.length) lines.push(`Influences: ${profile.influences.join(", ")}.`);
  if (profile.strengths.length) lines.push(`Strengths to lean on: ${profile.strengths.join(", ")}.`);
  if (profile.avoid.length) lines.push(`Avoid: ${profile.avoid.join(", ")}.`);
  if (profile.body) lines.push(`Detailed instructions:\n${profile.body}`);
  return lines.join("\n");
}

export function defaultGhostwriter(language?: string): GhostwriterProfile {
  const italian = language?.trim().toLowerCase().startsWith("it");
  return {
    slug: "default",
    ...emptyGhostwriter(italian ? "Ghostwriter predefinito" : "Default Ghostwriter"),
    language: italian ? "Italiano" : "English",
    tone: italian ? "Naturale, concreto e misurato" : "Natural, concrete, and measured",
    voice: italian ? "Chiara, narrativa e coerente con il punto di vista" : "Clear, narrative, and consistent with the viewpoint",
    sentenceRhythm: italian ? "Alterna frasi brevi e medie secondo tensione e respiro della scena" : "Alternate short and medium sentences according to scene tension and breathing room",
    dialogueStyle: italian ? "Dialoghi leggibili, naturali e attribuiti con action beat sobri" : "Readable, natural dialogue with restrained action beats",
    vocabulary: italian ? "Preciso e accessibile, senza ricercatezza gratuita" : "Precise and accessible, without gratuitous ornament",
    writingStyle: italian
      ? "Preserva canone e intento; usa scene concrete, punto di vista leggibile, dettagli sensoriali pertinenti e ritmo intenzionale. Evita riassunti generici e spiegazioni ridondanti."
      : "Preserve canon and intent; use concrete scenes, a readable viewpoint, relevant sensory detail, and purposeful rhythm. Avoid generic summary and redundant explanation.",
    punctuationStyle: italian
      ? "Usa la punteggiatura italiana standard. Per i dialoghi usa le caporali « » in modo coerente; usa il carattere unico … per i puntini di sospensione."
      : "Use standard English punctuation. Keep dialogue quotation marks consistent and use the single ellipsis character … rather than three periods.",
    body: italian
      ? "Scrivi una prosa narrativa pulita e professionale. Migliora chiarezza, tensione e precisione emotiva senza introdurre fatti non richiesti."
      : "Write clean, professional narrative prose. Improve clarity, tension, and emotional precision without introducing unrequested facts.",
  };
}
