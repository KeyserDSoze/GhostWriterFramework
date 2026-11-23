import { beforeAll, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import "@/i18n/outline";
import "@/i18n/frozen";
import "@/i18n/frozenCopilot";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { appDocEntries } from "@/lib/appDocs";
import { guideText, loadGuides } from "./helpers/guides";

type Language = "en" | "it";

const helpOf = (slug: string, language: Language) => {
  const entry = appDocEntries.find((candidate) => candidate.slug === slug);
  if (!entry) throw new Error(`the help «${slug}» is missing`);
  return guideText(slug, language);
};

beforeAll(loadGuides);

/** What the help of the autopilot names in bold about frozen chapters: the help and the pages must call it the same thing. */
const LABELS = [
  "frozen.toggle.freeze",
  "frozen.toggle.unfreeze",
  "frozen.actions.review-and-update",
  "frozen.actions.review-only",
  "frozen.actions.mark-reviewed",
  "frozen.actions.rewrite-to-outline",
  "frozen.actions.keep-text",
  "frozen.queued.start",
  "nav.autopilotLive",
  "nav.autopilotSettings",
  "autopilot.config.sections.review",
  "autopilot.config.frozenEdits.title",
  "autopilot.config.frozenEdits.ask",
  "autopilot.config.frozenEdits.auto",
  "autopilot.config.frozenEdits.notify",
];

beforeAll(async () => {
  await loadAutopilotTranslations();
});

describe.each<Language>(["en", "it"])("the help of frozen chapters (%s)", (language) => {
  it("names what the pages show the way they do", () => {
    const t = i18n.getFixedT(language);
    const help = helpOf("autopilot", language);
    expect(help).toContain(language === "en" ? "## Frozen chapters" : "## Capitoli congelati");
    expect(LABELS.map((key) => t(key)).filter((label) => !help.includes(`**${label}**`))).toEqual([]);
    expect(help, "a personal server needs the version that knows them").toContain("0.1.9");
  });

  it("is where the Outline sends the author about a written chapter, with the same choices", () => {
    const t = i18n.getFixedT(language);
    const outline = helpOf("outline", language);
    for (const key of ["outline.status.frozen", "frozen.actions.rewrite-to-outline", "frozen.actions.keep-text", "frozen.actions.mark-reviewed"]) expect(outline).toContain(`**${t(key)}**`);
    expect(outline).toContain(language === "en" ? "*Frozen chapters*" : "*Capitoli congelati*");
    expect(outline, "the revision of a written chapter is no longer a promise").not.toMatch(language === "en" ? /will come with the frozen chapters/ : /arriverà con i capitoli congelati/);
  });
});
