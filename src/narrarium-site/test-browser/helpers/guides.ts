import { appDocEntries } from "@/lib/appDocs";
import { loadDocMarkdown } from "@/lib/docContent";

type Language = "en" | "it";

const texts = new Map<string, string>();

/** Load the text of every guide of the app, in both languages, through the loader the help pages use (one chunk per guide and language). Call it in `beforeAll`. */
export async function loadGuides(): Promise<void> {
  for (const entry of appDocEntries) {
    for (const language of ["en", "it"] as const) texts.set(`${entry.slug}:${language}`, await loadDocMarkdown(entry, language));
  }
}

/** The text of a guide, as `loadGuides` loaded it. */
export function guideText(slug: string, language: Language): string {
  const text = texts.get(`${slug}:${language}`);
  if (text === undefined) throw new Error(`The guide ${slug} (${language}) is missing: is there such a guide, and did beforeAll call loadGuides()?`);
  return text;
}
