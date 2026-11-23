import { beforeAll, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import "@/i18n/aiRouter";
import { guideText, loadGuides } from "./helpers/guides";

type Language = "en" | "it";
const LANGUAGES: Language[] = ["en", "it"];
const text = (language: Language, key: string) => i18n.t(key, { lng: language }) as string;

beforeAll(loadGuides);

describe.each(LANGUAGES)("the help to the AI Router names the «Tools only» switch as the page does (%s)", (language) => {
  it("calls it by the name of the switch, in bold, and not by the old name that said it was for the autopilot", () => {
    const help = guideText("ai-router", language);
    const label = text(language, "routing.toolsOnly.label");
    expect(label).toBe(language === "en" ? "Tools only" : "Solo tool");
    expect(help).toContain(`**${label}** ${language === "en" ? "is the switch at the top of the page" : "è l'interruttore in cima alla pagina"}`);
    expect(help).not.toContain(language === "en" ? "Tools only for the autopilot" : "Solo tool per l'autopilot");
  });

  it("says that it covers the autopilot and the structured answers of the Copilot, and that the prose of the Copilot is not concerned", () => {
    const help = guideText("ai-router", language);
    const paragraph = help.split("\n").find((line) => line.startsWith(`**${text(language, "routing.toolsOnly.label")}**`)) ?? "";
    expect(paragraph).toContain("autopilot");
    expect(paragraph).toContain("Copilot");
    expect(paragraph).toMatch(language === "en" ? /prose of the Copilot is never affected/ : /prosa del Copilot non cambia mai/);
  });

  it("explains it on the page with the same two names: the autopilot and the Copilot's structured answers", () => {
    const hint = text(language, "routing.toolsOnly.hint");
    expect(hint).toMatch(/autopilot/);
    expect(hint).toMatch(language === "en" ? /structured answer of the Copilot/ : /risposta strutturata del Copilot/);
  });
});
