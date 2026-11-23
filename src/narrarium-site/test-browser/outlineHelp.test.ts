import { beforeAll, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import "@/i18n/outline";
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

/** The controls of the Outline the help names in bold: the help and the page must call them the same thing. */
const LABELS = [
  "nav.outline",
  "outline.book.title",
  "outline.book.idea",
  "outline.entry.titleLabel",
  "outline.entry.bodyLabel",
  "outline.entry.ghostwriterLabel",
  "outline.entry.ghostwriterDefault",
  "outline.entry.unsaved",
  "outline.status.autopilot",
  "outline.status.author",
  "outline.status.written",
  "outline.status.approved",
  "outline.status.replan",
  "outline.actions.add",
  "outline.actions.saveAll",
  "outline.actions.undo",
  "outline.delete.renumber",
  "outline.reload",
  "outline.filter.label",
  "outline.jump.label",
  "outline.empty.addFirst",
  "outline.empty.autopilot",
  "outline.empty.convert",
  "outline.assist.improveEntry",
  "outline.assist.summarizeEntry",
  "outline.assist.develop",
  "outline.assist.check",
  "outline.assist.apply",
  "autopilot.setup.fillOutline",
  "assistant.applyAllFiles",
  "assistant.undoChanges",
];

beforeAll(async () => {
  await loadAutopilotTranslations();
});

describe.each<Language>(["en", "it"])("the help of the Outline (%s)", (language) => {
  it("names the controls of the page the way the page does", () => {
    const t = i18n.getFixedT(language);
    const help = helpOf("outline", language);
    const missing = LABELS.map((key) => t(key)).filter((label) => !help.includes(`**${label}**`));
    expect(missing).toEqual([]);
    expect(help).toContain(`**${t("autopilot.task.replan", { number: "N" })}**`);
    expect(help).toContain(`**${t("common.save")}**`);
  });

  it("is where the page sends the author, and the autopilot's help points to it", () => {
    expect(appDocEntries.some((entry) => entry.slug === "outline" && entry.href === "/docs/outline")).toBe(true);
    const t = i18n.getFixedT(language);
    const autopilot = helpOf("autopilot", language);
    expect(autopilot).toContain(`**${t("nav.outline")}**`);
    expect(autopilot).toContain(`**${t("evaluationStyle.title")}**`);
  });
});
