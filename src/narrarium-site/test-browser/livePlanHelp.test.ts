import { beforeAll, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { guideText, loadGuides } from "./helpers/guides";
import { readFileSync } from "node:fs";
import path from "node:path";

type Language = "en" | "it";

/** What the help of the autopilot names in bold of the approval of the plan and of the map of the chapters: the help and the page must call them the same. */
const APPROVAL = [
  "autopilot.approval.title",
  "autopilot.approval.concept.title",
  "autopilot.approval.cast.title",
  "autopilot.approval.director.title",
  "autopilot.approval.readers.title",
  "autopilot.approval.chapters.title",
  "autopilot.approval.chapters.collapseAll",
  "autopilot.approval.chapters.outlineAuthor",
  "autopilot.approval.chapters.outlineAutopilot",
  "autopilot.approval.change.askShort",
  "autopilot.approval.reviseTitle",
  "autopilot.approval.reviseAction",
  "autopilot.actions.approvePlan",
];
const MAP = [
  "autopilot.map.title",
  "autopilot.map.view.table",
  "autopilot.map.window.filter",
  "autopilot.map.window.jump",
  "autopilot.chapterPanel.rounds.title",
  "autopilot.chapterPanel.current.title",
  "autopilot.chapterPanel.opinion.show",
];
const SCENE_STATES = ["todo", "writing", "written", "review", "approved", "rewrite", "frozen"];

beforeAll(async () => {
  await loadGuides();
  await loadAutopilotTranslations();
});

describe.each<Language>(["en", "it"])("the help of the approval of the plan and of the map of the chapters (%s)", (language) => {
  it("names the parts of the approval and its actions as the page does, and says what asking for a change does", () => {
    const t = i18n.getFixedT(language);
    const help = guideText("autopilot", language);
    expect(APPROVAL.map((key) => t(key)).filter((label) => !help.includes(`**${label}**`))).toEqual([]);
    // The effect of the intervention is said, with the case of a book that has chapters written.
    expect(help).toMatch(language === "en" ? /rule of the book[\s\S]*made again/i : /regola del libro[\s\S]*rifatto/i);
    expect(help).toMatch(language === "en" ? /chapters written[^.]*revised/i : /capitoli scritti[^.]*rivisti/i);
  });

  it("names the map, its states in words, its table and its panel as the page does, and says the keys", () => {
    const t = i18n.getFixedT(language);
    const help = guideText("autopilot", language);
    expect(MAP.map((key) => t(key)).filter((label) => !help.includes(`**${label}**`))).toEqual([]);
    expect(SCENE_STATES.map((state) => t(`autopilot.map.scene.${state}`)).filter((word) => !help.includes(word))).toEqual([]);
    expect(help).toMatch(language === "en" ? /Enter[\s\S]*Escape/ : /Invio[\s\S]*Esc/);
  });
});

describe("the specification of the autopilot", () => {
  it("has the approval of the plan and the map of the chapters, with where their data come from", () => {
    const spec = readFileSync(path.resolve(process.cwd(), "../../docs/autopilot-spec.md"), "utf8");
    expect(spec).toMatch(/## The approval of the plan/);
    expect(spec).toMatch(/## The map of the chapters/);
    expect(spec).toMatch(/plan\.readerReactions/);
    expect(spec).toMatch(/PlannedChapter\.rounds|chapter\.rounds/);
    expect(spec).toMatch(/estimateAutopilotRun/);
  });
});
