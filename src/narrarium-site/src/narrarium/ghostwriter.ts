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
  influences: string[];
  strengths: string[];
  avoid: string[];
  temperature: number;
  body: string;
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
  if (profile.influences.length) lines.push(`Influences: ${profile.influences.join(", ")}.`);
  if (profile.strengths.length) lines.push(`Strengths to lean on: ${profile.strengths.join(", ")}.`);
  if (profile.avoid.length) lines.push(`Avoid: ${profile.avoid.join(", ")}.`);
  if (profile.body) lines.push(`Detailed instructions:\n${profile.body}`);
  return lines.join("\n");
}
