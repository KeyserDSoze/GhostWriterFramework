import i18next from "i18next";
import en from "@/i18n/locales/en";

// A code is six base-36 digits, or seven (starting with 1) for the larger half of the 32-bit numbers it stands for.
const CODE = "(?:[0-9a-z]{6}|1[0-9a-z]{6})";
const NUMBERED = /^(\d{3,})-(scene|chapter)$/;
const RESEARCH = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})-research-${CODE}$`);
const CODED = new RegExp(`^(character|location|faction|item|secret|timeline-event|ghostwriter|reader)-${CODE}$`);
const CODED_KEYS = { character: "character", location: "location", faction: "faction", item: "item", secret: "secret", "timeline-event": "timelineEvent", ghostwriter: "ghostwriter", reader: "reader" } as const;

/** The text in the language of the app; English where the translations are not loaded (this module sits below the screens). */
function label(key: keyof typeof en.fallbackTitle, values: Record<string, string | number> = {}): string {
  const defaultValue = en.fallbackTitle[key];
  const translated = i18next.t(`fallbackTitle.${key}`, { defaultValue, ...values }) as string | undefined;
  return translated ?? defaultValue.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values[name] ?? ""));
}

/**
 * A neutral name, in the language of the app, for something that has no title when its file name is only what the app
 * makes up for a title it cannot read (`001-scene`, `character-0crj2m`): "Scene 1", "Character". The number is the one in
 * the file name, never the code (a research document shows its date). Null for every other name, which is better shown as it is.
 */
export function generatedNameLabel(slug: string): string | null {
  const numbered = NUMBERED.exec(slug);
  if (numbered) return label(numbered[2] as "scene" | "chapter", { number: Number(numbered[1]) });
  const coded = CODED.exec(slug);
  if (coded) return label(CODED_KEYS[coded[1] as keyof typeof CODED_KEYS]);
  const research = RESEARCH.exec(slug);
  return research ? label("research", { date: research[1] }) : null;
}

/** The title a scene shows once its number changed: its own, or the numbered label again when that is all it ever had. */
export function renumberedTitle(title: string, oldSlug: string, newSlug: string): string {
  return title === generatedNameLabel(oldSlug) ? generatedNameLabel(newSlug) ?? title : title;
}
