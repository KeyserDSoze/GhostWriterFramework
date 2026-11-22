import { beforeAll, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { appDocEntries } from "@/lib/appDocs";

type Language = "en" | "it";

const helpOf = (language: Language) => {
  const entry = appDocEntries.find((candidate) => candidate.slug === "autopilot");
  if (!entry) throw new Error("the Autopilot help is missing");
  return (entry.translations?.[language] ?? entry).markdown;
};

/** The controls of the page that the help names in bold: the help and the page must call them the same thing. */
const LABELS = [
  "autopilot.tabs.overview",
  "autopilot.tabs.timeline",
  "autopilot.tabs.plan",
  "autopilot.tabs.rules",
  "autopilot.actions.intervene",
  "autopilot.actions.retry",
  "autopilot.actions.addChapters",
  "autopilot.actions.writeNewChapters",
  "autopilot.actions.resume",
  "autopilot.actions.reset",
  "autopilot.danger.title",
  "autopilot.quick.more",
  "autopilot.dockLive",
  "autopilot.dockBook",
  "autopilot.where.title",
];

beforeAll(async () => {
  await loadAutopilotTranslations();
});

describe.each<Language>(["en", "it"])("the help of the autopilot (%s)", (language) => {
  it("names the controls of the page the way the page does", () => {
    const t = i18n.getFixedT(language);
    const help = helpOf(language);
    const missing = LABELS.map((key) => t(key)).filter((label) => !help.includes(`**${label}**`));
    expect(missing).toEqual([]);
    expect(help).toContain(`**${t("autopilot.actions.readChapter", { number: "N" })}**`);
  });

  it("describes the control band, the tabs and the mini-player, and no longer the panels they replace", () => {
    const help = helpOf(language);
    const gone = language === "en" ? [/progress card/i, /live panel/i] : [/scheda di avanzamento/i, /pannello in diretta/i];
    expect(gone.filter((pattern) => pattern.test(help)).map(String)).toEqual([]);
    expect(help).toMatch(language === "en" ? /## The Autopilot page/ : /## La pagina Autopilot/);
    expect(help).toContain("mini-player");
  });
});
