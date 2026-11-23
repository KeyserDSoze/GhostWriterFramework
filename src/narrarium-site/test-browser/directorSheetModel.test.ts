import { describe, expect, it } from "vitest";
import type { DirectorOpinionRecord } from "narrarium-engine";
import { ENGINE_LANGUAGES, approvalCaption, directorPreview, knownLanguage, languageOptions, languageValue, profileScore, strictnessCaption, trendByChapter, trendByDate } from "@/director/sheetModel";

describe("what the values of the director do, worked out from the engine's rules", () => {
  it("takes a score under the approval score to show the withheld approval: 6.5 under a bar of 7 or 8, half a point under a lower bar, none under 1", () => {
    const base = { maxReviewRounds: 2, autonomy: "ask-on-critical" as const, strictness: 7 };
    expect(directorPreview({ ...base, approvalScore: 8 }).below).toBe(6.5);
    expect(directorPreview({ ...base, approvalScore: 7 }).below).toBe(6.5);
    expect(directorPreview({ ...base, approvalScore: 6 }).below).toBe(5.5);
    expect(directorPreview({ ...base, approvalScore: 1.5 }).below).toBe(1);
    expect(directorPreview({ ...base, approvalScore: 1 }).below).toBeNull();
    expect(directorPreview({ ...base, approvalScore: 7.25 }).threshold, "the engine keeps one decimal").toBe(7.3);
  });

  it("keeps the rounds between 1 and 3 and the scores between 1 and 10, as the engine does", () => {
    const preview = directorPreview({ approvalScore: 12, maxReviewRounds: 5, autonomy: "full", strictness: -2 });
    expect(preview).toMatchObject({ threshold: 10, rounds: 3, strictness: 1, autonomy: "full" });
    expect(profileScore(Number.NaN)).toBe(1);
  });

  it("puts words on the scales", () => {
    expect([1, 3.5, 4, 6.5, 7, 10].map(strictnessCaption)).toEqual(["lenient", "lenient", "balanced", "balanced", "strict", "strict"]);
    expect([1, 5.5, 6, 7.5, 8, 10].map(approvalCaption)).toEqual(["low", "low", "medium", "medium", "high", "high"]);
  });
});

describe("the languages a director can have", () => {
  it("are the ones the engine knows, the book's first, each with its own name when it is written differently", () => {
    expect(ENGINE_LANGUAGES).toEqual(expect.arrayContaining(["en", "it", "ru", "zh", "ja", "ar", "hi"]));
    const options = languageOptions("en", "it-IT", "it");
    expect(options[0]).toMatchObject({ value: "it", book: true, name: "Italian", native: "italiano" });
    expect(options.find((option) => option.value === "ru")).toMatchObject({ native: "русский", label: "Russian — русский (ru)" });
    expect(options.find((option) => option.value === "en")?.native, "English is called English in English").toBeNull();
    expect(options).toHaveLength(ENGINE_LANGUAGES.length);
  });

  it("read a value of the file as the engine does, and keep one it does not know as it is written", () => {
    expect(knownLanguage("Italiano")).toBe("it");
    expect(knownLanguage("русский")).toBe("ru");
    expect(knownLanguage("klingon")).toBeNull();
    expect(languageValue("Italiano")).toBe("it");
    expect(languageValue("klingon")).toBe("klingon");
    expect(languageOptions("it", "en", "klingon")[0]).toMatchObject({ value: "klingon", unknown: true });
  });
});

describe("the scores of the saved opinions", () => {
  const record = (patch: Partial<DirectorOpinionRecord>): DirectorOpinionRecord => ({ path: "p", targetType: "chapter", targetId: "chapter:001-a", title: "1. A", verdict: "approve", score: 7, createdAt: "2026-11-20T00:00:00.000Z", source: "autopilot", body: "", ...patch });
  const records = [
    record({ path: "c10", targetId: "chapter:010-the-end", title: "10. The end", score: 8, createdAt: "2026-11-01T00:00:00.000Z" }),
    record({ path: "c2", targetId: "chapter:002-b", title: "2. B", score: 6, createdAt: "2026-11-03T00:00:00.000Z" }),
    record({ path: "book", targetType: "book", targetId: "book", title: "The book", score: 7, createdAt: "2026-11-02T00:00:00.000Z" }),
    record({ path: "scene", targetType: "paragraph", targetId: "paragraph:002-b:001-c", title: "2.1 C", score: 5, createdAt: "2026-11-04T00:00:00.000Z" }),
  ];

  it("are in the order of the book by chapter, the chapters only", () => {
    expect(trendByChapter(records).map((point) => [point.chapter, point.score])).toEqual([[2, 6], [10, 8]]);
  });

  it("are from the oldest to the newest by date, every opinion", () => {
    expect(trendByDate(records).map((point) => point.path)).toEqual(["c10", "book", "c2", "scene"]);
  });
});
