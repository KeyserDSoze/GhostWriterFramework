import { stringify } from "yaml";
import { isEmptyValue, listEntry, numericValue, quoted, readProfileFile } from "./read.js";

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
  /** What is wrong with `ghostwriters/<slug>.md`, each problem naming it (YAML that cannot be read, a value that is not understood). Empty when the file is as it says: the autopilot does not write with a profile that has warnings. */
  warnings?: string[];
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
    warnings: [],
  };
}

/**
 * The ghostwriter of `ghostwriters/<slug>.md`. It never throws: YAML that cannot be read, a text field that is a list, a
 * temperature that is not a number, a list that is not one are warnings that name the file (the field is then empty or the
 * default, as it always was). A temperature written as text (`'0.7'`, `'0,7'`) is read.
 */
export function parseGhostwriter(slug: string, raw: string): GhostwriterProfile {
  const { frontmatter: fm, body, warnings, warn } = readProfileFile(`ghostwriters/${slug}.md`, raw);
  const str = (key: string): string => {
    const value = fm[key];
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (!isEmptyValue(value)) warn(`${key} must be text (${quoted(value)} is not): it is left empty`);
    return "";
  };
  const asArray = (key: string): string[] => {
    const value = fm[key];
    if (Array.isArray(value)) {
      let skipped = 0;
      const items: string[] = [];
      for (const entry of value) {
        const item = listEntry(entry);
        if (item === undefined) skipped += 1;
        else if (item) items.push(item);
      }
      if (skipped) warn(`${skipped === 1 ? "one entry" : `${skipped} entries`} of ${key} cannot be read as text and ${skipped === 1 ? "was" : "were"} left out`);
      return items;
    }
    if (typeof value === "string" && value.trim()) return value.split(",").map((part) => part.trim()).filter(Boolean);
    if (!isEmptyValue(value)) warn(`${key} must be a list (${quoted(value)} is not one): it is left empty`);
    return [];
  };
  let temperature = 0.8;
  if (!isEmptyValue(fm.temperature)) {
    const parsed = numericValue(fm.temperature);
    if (parsed === undefined) warn(`temperature ${quoted(fm.temperature)} is not a number: 0.8 is used`);
    else temperature = parsed;
  }
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
    influences: asArray("influences"),
    strengths: asArray("strengths"),
    avoid: asArray("avoid"),
    temperature,
    body,
    warnings,
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
