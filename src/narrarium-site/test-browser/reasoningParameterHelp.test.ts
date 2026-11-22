import { describe, expect, it } from "vitest";
import { AI_REASONING_PARAMETERS } from "narrarium-engine";
import i18n from "@/i18n";
import "@/i18n/aiRouter";
import { appDocEntries } from "@/lib/appDocs";

type Language = "en" | "it";
const LANGUAGES: Language[] = ["en", "it"];
const text = (language: Language, key: string) => i18n.t(key, { lng: language }) as string;

/** The section about thinking of the guide to the AI Router, where an author looks for how a level reaches a model. */
function thinkingSection(language: Language): string {
  const entry = appDocEntries.find((candidate) => candidate.slug === "ai-router");
  if (!entry) throw new Error("the guide to the AI Router is missing");
  const help = (entry.translations?.[language] ?? entry).markdown;
  const start = help.indexOf("\n## Thinking\n");
  expect(start, "the guide has a section about thinking").toBeGreaterThan(-1);
  const next = help.indexOf("\n## ", start + 4);
  return help.slice(start, next === -1 ? undefined : next);
}

describe.each(LANGUAGES)("the in-app help describes the thinking parameter of a model as the page calls it (%s)", (language) => {
  it("names the setting under the name the page gives it, in the section about thinking", () => {
    expect(thinkingSection(language)).toContain(`**${text(language, "settings.thinkingParameter")}**`);
  });

  it("gives the three values as they are written, and says that Muse Glimmer on llama.cpp wants the chat-template one", () => {
    const section = thinkingSection(language);
    for (const value of AI_REASONING_PARAMETERS) expect(section, value).toContain(value);
    expect(section).toContain("Muse Glimmer");
    expect(section).toContain("llama.cpp");
  });

  it("names the button of the suggestion, and says that it is never applied by itself", () => {
    const section = thinkingSection(language);
    expect(section).toContain(`**${text(language, "settings.thinkingParameterUse")}**`);
    expect(section).toMatch(language === "en" ? /never by itself/ : /mai da sola/);
  });

  it("says that «none» sends no level and does not turn thinking off", () => {
    expect(thinkingSection(language)).toMatch(language === "en" ? /does not turn thinking off/ : /non spegne il thinking/);
  });
});
