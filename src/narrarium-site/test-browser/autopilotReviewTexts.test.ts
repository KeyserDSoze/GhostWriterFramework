import { act } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AutopilotEvent } from "narrarium-engine";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { presentFeedEvent, voteText } from "@/autopilot/format";
import { useSettingsStore } from "@/store/settingsStore";

type Language = "en" | "it";
type Insight = Extract<AutopilotEvent, { type: "insight" }>;
const fixed = (language: Language) => i18n.getFixedT(language);
const ENGINE_WORDS = "The engine's own words";

const insight = (body: Partial<Insight>): AutopilotEvent => ({ type: "insight", tone: "info", title: ENGINE_WORDS, bookId: "book-1", at: "2026-11-26T10:00:00.000Z", seq: 1, ...body }) as AutopilotEvent;
const text = (language: Language, body: Partial<Insight>) => presentFeedEvent(fixed(language), insight(body))?.text ?? "";

/** Every code of a review of the book and of the caps, with the numbers the engine gives it. */
const SAID: Array<Partial<Insight>> = [
  { code: "reviewChapterDone", chapterNumber: 3, figures: { score: 8.5, target: 8, round: 1 } },
  { code: "reviewChapterSkipped", chapterNumber: 4 },
  { code: "reviewRoundDone", figures: { round: 2, target: 8, lowest: 6.5, book: 7, below: 2 } },
  { code: "reviewDone", figures: { round: 3, rounds: 3, target: 8, lowest: 8, book: 8.5, below: 0, outcome: "target" } },
  { code: "reviewStopped", figures: { round: 2, rounds: 2, target: 9, lowest: 6, book: 6, below: 1, outcome: "plateau" } },
  { code: "reviewStopped", figures: { round: 1, rounds: 1, target: 8, lowest: 8, book: 7, below: 0, outcome: "chapters" } },
  { code: "reviewHeld", figures: { round: 3, rounds: 2, limit: 2, target: 9 } },
  { code: "budgetReached", figures: { used: 2.5032, limit: 2.5, currency: "USD" } },
  { code: "tokenBudgetReached", figures: { used: 1_200_300, limit: 1_200_000 } },
];

beforeAll(async () => {
  await loadAutopilotTranslations();
  useSettingsStore.setState((store) => ({ settings: { ...store.settings, costCurrency: "USD", costRates: [], costRelabels: [] } }));
});

afterEach(async () => {
  await act(async () => { await i18n.changeLanguage("en"); });
});

describe("the insights of a review of the book and of the caps", () => {
  it.each<Language>(["en", "it"])("are said in the language of the app, with their numbers (%s)", (language) => {
    for (const body of SAID) {
      const said = text(language, body);
      expect(said, body.code).not.toBe(ENGINE_WORDS);
      expect(said, body.code).not.toContain("{{");
    }
  });

  it("say the votes, the target and how the review ended", async () => {
    expect(text("en", SAID[0])).toBe("Chapter 3 reviewed again: 8.5/10 (target 8/10).");
    // The numbers are the app's language's: the votes have its decimal separator.
    await act(async () => { await i18n.changeLanguage("it"); });
    expect(text("it", SAID[0])).toBe("Capitolo 3 rivisto di nuovo: 8,5/10 (obiettivo 8/10).");
    expect(text("it", SAID[6])).toBe("2 giri della revisione fatti, quanti ne hai permessi: riavvia l'autopilot per continuare.");
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(text("en", SAID[2])).toBe("Round 2 of the review is over: lowest chapter 6.5/10, the book 7/10 (target 8/10).");
    expect(text("en", SAID[3])).toBe("The book reached the target: 8.5/10, every chapter at 8/10 or more (3 rounds).");
    expect(text("en", { ...SAID[3], figures: { ...SAID[3].figures, rounds: 1 } })).toContain("(1 round)");
    expect(text("en", SAID[4])).toContain("two rounds in a row raised neither the lowest chapter (6/10) nor the book (6/10)");
    expect(text("en", SAID[5])).toContain("the book as a whole got 7/10");
  });

  it("write the money of a cap in the currency it was counted in, and the tokens as a count", () => {
    expect(text("en", SAID[7])).toBe("Money cap reached: $2.50 spent of $2.50. Raise the cap to go on.");
    expect(text("en", SAID[8])).toContain("1,200,300 tokens of 1,200,000");
  });

  it("keep the engine's own words for an event without its numbers (an older engine)", () => {
    for (const code of ["reviewChapterDone", "reviewRoundDone", "reviewDone", "reviewStopped", "reviewHeld", "budgetReached", "tokenBudgetReached"] as const) {
      expect(text("it", { code }), code).toBe(ENGINE_WORDS);
    }
    expect(text("it", { code: "reviewChapterSkipped" })).toBe(ENGINE_WORDS);
  });

  it("write a vote nobody gave as a dash", () => {
    expect(voteText(null)).toBe("—");
    expect(voteText(undefined)).toBe("—");
    expect(voteText(7)).toBe("7/10");
  });
});
