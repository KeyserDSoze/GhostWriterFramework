import { afterEach, beforeAll, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import english from "@/i18n/locales/en";
import italian from "@/i18n/locales/it";
import { generatedNameLabel, renumberedTitle } from "@/lib/fallbackTitle";
import { researchListTitle } from "@/pages/DeepResearchPage";

const KEYS = ["scene", "chapter", "character", "location", "faction", "item", "secret", "timelineEvent", "ghostwriter", "reader", "research"].map((key) => `fallbackTitle.${key}`);

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("the neutral names shown for a title the app could not read", () => {
  it("exist in both languages, and are written in Italian rather than copied from English", () => {
    for (const key of KEYS) {
      for (const lng of ["en", "it"]) {
        expect(i18n.exists(key, { lng }), `${key} (${lng})`).toBe(true);
        expect(i18n.t(key, { lng, number: 7, date: "2026-11-21" }), `${key} (${lng})`).not.toBe(key);
      }
      if (key !== "fallbackTitle.ghostwriter") expect(i18n.t(key, { lng: "it", number: 7, date: "2026-11-21" }), key).not.toBe(i18n.t(key, { lng: "en", number: 7, date: "2026-11-21" }));
    }
    expect(i18n.t("fallbackTitle.scene", { lng: "it", number: 7 })).toBe("Scena 7");
    expect(i18n.t("fallbackTitle.chapter", { lng: "it", number: 12 })).toBe("Capitolo 12");
  });

  it("are the same set of texts in both languages", () => {
    expect(Object.keys(italian.fallbackTitle).sort()).toEqual(Object.keys(english.fallbackTitle).sort());
    expect(Object.keys(english.fallbackTitle).map((key) => `fallbackTitle.${key}`).sort()).toEqual([...KEYS].sort());
    for (const key of ["scene", "chapter"] as const) {
      expect(english.fallbackTitle[key]).toContain("{{number}}");
      expect(italian.fallbackTitle[key]).toContain("{{number}}");
    }
    expect(english.fallbackTitle.research).toContain("{{date}}");
    expect(italian.fallbackTitle.research).toContain("{{date}}");
  });

  it("carry the number in the file name, and nothing else of its name", async () => {
    expect(generatedNameLabel("001-scene")).toBe("Scene 1");
    expect(generatedNameLabel("012-chapter")).toBe("Chapter 12");
    expect(generatedNameLabel("1000-chapter")).toBe("Chapter 1000");
    await i18n.changeLanguage("it");
    expect(generatedNameLabel("003-scene")).toBe("Scena 3");
    expect(generatedNameLabel("040-chapter")).toBe("Capitolo 40");
  });

  it.each([
    ["character-0crj2m", "Character"],
    ["location-1abcde", "Location"],
    ["faction-0crj2m", "Faction"],
    ["item-zzzzzz", "Item"],
    ["secret-0crj2m", "Secret"],
    ["timeline-event-0crj2m", "Timeline event"],
    ["ghostwriter-0crj2m", "Ghostwriter"],
    ["reader-0crj2m", "Reader"],
    ["character-1z141z3", "Character"],
    ["2026-11-21-research-0crj2m", "Research 2026-11-21"],
  ])("never show the code in %s", (slug, label) => {
    expect(generatedNameLabel(slug)).toBe(label);
  });

  it("leave every other name to be shown as it is", () => {
    for (const slug of ["001-the-gate", "001-scene-two", "lyra-vale", "character-mothers", "character", "scene", "001", "007-chapter-one", "characters-0crj2m", "李明", "001-海辺の朝", "2026-11-21-roman-aqueducts", "2026-11-21-research-0crj2m1"]) {
      expect(generatedNameLabel(slug), slug).toBeNull();
    }
  });

  it("number again a scene that moves, and keep a title the author wrote", () => {
    expect(renumberedTitle("Scene 3", "003-scene", "001-scene")).toBe("Scene 1");
    expect(renumberedTitle("朝の港", "003-scene", "001-scene")).toBe("朝の港");
    expect(renumberedTitle("Scene", "003-scene", "001-scene")).toBe("Scene");
    expect(renumberedTitle("The Gate", "003-the-gate", "001-the-gate")).toBe("The Gate");
    expect(renumberedTitle("Scene 3", "003-the-gate", "001-the-gate")).toBe("Scene 3");
  });
});

describe("the research documents listed by the research page", () => {
  const entry = { path: "research/2026-11-21-research-0crj2m.md", sha: "sha", slug: "2026-11-21-research-0crj2m", title: "Research 2026-11-21" };

  it("show the title written in each file, in any script", () => {
    expect(researchListTitle(entry, "---\ntitle: 罗马水道的建造\nquery: 罗马水道\n---\n\nText.")).toBe("罗马水道的建造");
    expect(researchListTitle(entry, '---\ntitle: "Тихая гавань: заметки"\n---\n\nText.')).toBe("Тихая гавань: заметки");
  });

  it("keep the name the book structure gives until the file is read, or when it has no title or cannot be read", () => {
    expect(researchListTitle(entry, undefined)).toBe("Research 2026-11-21");
    expect(researchListTitle(entry, "---\nquery: x\n---\n\nText.")).toBe("Research 2026-11-21");
    expect(researchListTitle(entry, "No frontmatter at all")).toBe("Research 2026-11-21");
    expect(researchListTitle(entry, "---\ntitle: [unclosed\n---\n\nText.")).toBe("Research 2026-11-21");
    expect(researchListTitle({ ...entry, title: "" }, "")).toBe("2026-11-21-research-0crj2m");
  });
});
