import { beforeAll, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { guideText, loadGuides } from "./helpers/guides";

type Language = "en" | "it";

/** What the help of the autopilot names in bold of the page of every book and of the director: the help and the pages must call them the same. */
const HUB = ["autopilot.hub.openLive", "autopilot.hub.openResult", "autopilot.hub.start", "autopilot.dockTitle", "autopilot.hub.state.question", "autopilot.hub.state.plan", "autopilot.hub.state.retrying"];
const DIRECTOR = [
  "director.strictness",
  "director.approvalScore",
  "director.maxReviewRounds",
  "director.scale.lenient",
  "director.scale.balanced",
  "director.scale.strict",
  "director.preview.title",
  "director.language",
  "director.bar.discard",
  "director.save",
  "director.trend.title",
  "director.trend.byChapter",
  "director.trend.byDate",
];

beforeAll(async () => {
  await loadGuides();
  await loadAutopilotTranslations();
});

describe.each<Language>(["en", "it"])("the help of the Autopilot page and of the director (%s)", (language) => {
  it("names the cards of the books and their actions as the page does", () => {
    const t = i18n.getFixedT(language);
    const help = guideText("autopilot", language);
    expect(HUB.map((key) => t(key)).filter((label) => !help.includes(`**${label}**`))).toEqual([]);
  });

  it("names what the director's sheet shows as the page does, and says that strictness is not a rule", () => {
    const t = i18n.getFixedT(language);
    const help = guideText("autopilot", language);
    expect(DIRECTOR.map((key) => t(key)).filter((label) => !help.includes(`**${label}**`))).toEqual([]);
    expect(help).toMatch(language === "en" ? /strictness[^.]*instructions/i : /severità[^.]*istruzioni/i);
  });
});
