import { beforeAll, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { appDocEntries } from "@/lib/appDocs";
import { guideText, loadGuides } from "./helpers/guides";

type Language = "en" | "it";

const helpOf = (slug: string, language: Language) => {
  const entry = appDocEntries.find((candidate) => candidate.slug === slug);
  if (!entry) throw new Error(`the help ${slug} is missing`);
  return guideText(slug, language);
};

beforeAll(loadGuides);

/** The names the menu and the configuration give to their parts: the help calls them the same, in bold. */
const AUTOPILOT_LABELS = [
  "nav.autopilotLive",
  "nav.autopilotSettings",
  "autopilot.live.configure",
  "autopilot.live.editRules",
  "autopilot.config.tabs.overview",
  "autopilot.config.tabs.review",
  "autopilot.config.tabs.publishing",
  "autopilot.config.sections.rules",
  "autopilot.config.sections.profiles",
  "autopilot.config.rules.edit",
  "autopilot.config.rules.remove",
  "autopilot.setup.save",
  "autopilot.setup.pauseAfterEachChapter",
  "autopilot.danger.title",
  "autopilot.actions.reset",
  "autopilot.actions.start",
];

const MENU_LABELS = ["nav.groupBook", "autopilot.title", "nav.groupProfiles", "nav.groupTools", "bookPage.bookSettings"];

beforeAll(async () => {
  await loadAutopilotTranslations();
});

describe.each<Language>(["en", "it"])("the help of the new menu and of the two pages of the autopilot (%s)", (language) => {
  it("names the parts of the configuration and of the live page the way the pages do", () => {
    const t = i18n.getFixedT(language);
    const help = helpOf("autopilot", language);
    expect(AUTOPILOT_LABELS.map((key) => t(key)).filter((label) => !help.includes(`**${label}**`))).toEqual([]);
  });

  it("no longer puts the settings and the danger zone on the live page", () => {
    const help = helpOf("autopilot", language);
    expect(help).not.toMatch(language === "en" ? /the settings and a \*\*Danger zone\*\*/ : /le impostazioni e una \*\*Zona pericolosa\*\*/);
    expect(help).toMatch(language === "en" ? /## The configuration/ : /## La configurazione/);
  });

  it("describes the menu of a book in its groups, with the settings of the book at the bottom", () => {
    const t = i18n.getFixedT(language);
    const help = helpOf("overview", language);
    expect(help).toMatch(language === "en" ? /## The menu of a book/ : /## Il menu di un libro/);
    expect(MENU_LABELS.map((key) => t(key)).filter((label) => !help.includes(`**${label}**`))).toEqual([]);
  });
});
