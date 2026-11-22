import { act } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AutopilotEvent } from "narrarium-engine";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { presentFeedEvent, taskLabel } from "@/autopilot/format";
import { categoryOf } from "@/autopilot/timelineModel";

type Language = "en" | "it";
const fixed = (language: Language) => i18n.getFixedT(language);
const ENGINE_WORDS = "The engine's own words";

const insight = (body: Partial<Extract<AutopilotEvent, { type: "insight" }>>): AutopilotEvent => ({ type: "insight", tone: "info", title: ENGINE_WORDS, bookId: "book-1", at: "2026-11-22T10:00:00.000Z", seq: 1, ...body }) as AutopilotEvent;
const text = (language: Language, body: Partial<Extract<AutopilotEvent, { type: "insight" }>>) => presentFeedEvent(fixed(language), insight(body))?.text ?? "";

/** The codes of the frozen chapters that say which chapter they are about. */
const CHAPTER_CODES = ["frozenChanged", "frozenAuto", "outlineWrittenAuto", "frozenReviewed", "frozenCleared", "frozenInvalid"] as const;

beforeAll(async () => {
  await loadAutopilotTranslations();
});

afterEach(async () => {
  await act(async () => { await i18n.changeLanguage("en"); });
});

describe("the insights of the engine about the frozen chapters", () => {
  it.each<Language>(["en", "it"])("say which chapter they are about, in the language of the app (%s)", (language) => {
    for (const code of CHAPTER_CODES) {
      const said = text(language, { code, chapterNumber: 7 });
      expect(said, code).toContain("7");
      expect(said, code).not.toBe(ENGINE_WORDS);
      expect(said, code).not.toContain("{{");
    }
  });

  it.each<Language>(["en", "it"])("say that the chapters an older engine approved are frozen now, without a number to give (%s)", (language) => {
    const said = text(language, { code: "frozenMigrated", detail: "001-one, 002-two" });
    expect(said).not.toBe(ENGINE_WORDS);
    expect(said).not.toContain("{{");
    expect(presentFeedEvent(fixed(language), insight({ code: "frozenMigrated", detail: "001-one, 002-two" }))?.detail).toBe("001-one, 002-two");
  });

  it("tell a chapter left without scenes, which is frozen as it is, from a decision carried out", () => {
    const done = text("en", { code: "frozenReviewed", chapterNumber: 4, tone: "ok" });
    const empty = text("en", { code: "frozenReviewed", chapterNumber: 4, tone: "warning" });
    expect(empty).not.toBe(done);
    expect(empty).toContain("4");
    expect(text("it", { code: "frozenReviewed", chapterNumber: 4, tone: "warning" })).not.toBe(empty);
  });

  it("keep the engine's own words when an older event carries the code without the chapter", () => {
    for (const code of CHAPTER_CODES) expect(text("it", { code }), code).toBe(ENGINE_WORDS);
  });

  it("are said differently in Italian, never copied from English", () => {
    for (const code of [...CHAPTER_CODES, "frozenMigrated"]) {
      expect(fixed("it")(`autopilot.insight.${code}`), code).not.toBe(fixed("en")(`autopilot.insight.${code}`));
    }
  });
});

describe("the step that freezes chapters without the model", () => {
  it("has a name in both languages, and is one of the other steps", () => {
    expect(taskLabel(fixed("en"), "freeze")).toBe("Freezing chapters");
    expect(taskLabel(fixed("it"), "freeze")).toBe("Congelamento dei capitoli");
    expect(categoryOf("freeze")).toBe("other");
  });
});
