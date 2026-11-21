import { afterEach, beforeAll, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { formatAgo, formatClock, formatCost, formatCount, formatDateTime } from "@/autopilot/format";

const WHEN = "2026-11-21T14:05:09.000Z";

beforeAll(async () => {
  await loadAutopilotTranslations();
});

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("dates, times and numbers follow the language of the app, not the one of the browser", () => {
  it.each(["en", "it"])("writes dates and times in %s", async (language) => {
    await i18n.changeLanguage(language);
    const date = new Date(WHEN);
    expect(formatDateTime(WHEN)).toBe(date.toLocaleString(language, { dateStyle: "medium", timeStyle: "short" }));
    expect(formatClock(WHEN)).toBe(date.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    expect(formatCount(98765)).toBe(new Intl.NumberFormat(language, { notation: "standard", maximumFractionDigits: 1 }).format(98765));
    expect(formatCount(1234567)).toBe(new Intl.NumberFormat(language, { notation: "compact", maximumFractionDigits: 1 }).format(1234567));
    expect(formatCost(12.5, "EUR")).toBe(new Intl.NumberFormat(language, { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(12.5));
  });

  it("is different in Italian from what a browser in English would show", async () => {
    await i18n.changeLanguage("en");
    const english = { date: formatDateTime(WHEN), count: formatCount(98765) };
    await i18n.changeLanguage("it");
    expect(formatDateTime(WHEN)).not.toBe(english.date);
    expect(formatCount(98765)).not.toBe(english.count);
  });

  it("is empty for what is not a date", () => {
    expect(formatDateTime(undefined)).toBe("");
    expect(formatDateTime("not a date")).toBe("");
    expect(formatClock("not a date")).toBe("");
  });
});

describe("how long ago", () => {
  it.each([
    ["en", 4 * 60_000, "4 minutes ago"],
    ["it", 4 * 60_000, "4 minuti fa"],
    ["en", 3 * 3_600_000, "3 hours ago"],
    ["it", 3 * 3_600_000, "3 ore fa"],
    ["en", 10 * 86_400_000, "10 days ago"],
    ["it", 10 * 86_400_000, "10 giorni fa"],
    ["en", 25_000, "25 seconds ago"],
    ["it", 25_000, "25 secondi fa"],
  ])("in %s, %i ms is “%s”", async (language, ms, expected) => {
    await i18n.changeLanguage(language);
    expect(formatAgo(ms)).toBe(expected);
  });

  it("says “now” for a moment ago, and never a negative age", async () => {
    await i18n.changeLanguage("en");
    expect(formatAgo(0)).toBe("now");
    expect(formatAgo(-5_000)).toBe("now");
    await i18n.changeLanguage("it");
    expect(formatAgo(2_000)).toBe("ora");
  });
});

describe("counts are written as one or many", () => {
  it.each([
    ["en", "autopilot.characters", { count: 1 }, "1 character"],
    ["en", "autopilot.characters", { count: 2 }, "2 characters"],
    ["it", "autopilot.characters", { count: 1 }, "1 carattere"],
    ["it", "autopilot.characters", { count: 5 }, "5 caratteri"],
    ["en", "autopilot.plan.scenes", { count: 1 }, "1 scene"],
    ["en", "autopilot.plan.scenes", { count: 3 }, "3 scenes"],
    ["it", "autopilot.plan.scenes", { count: 1 }, "1 scena"],
    ["it", "autopilot.plan.scenes", { count: 3 }, "3 scene"],
  ])("%s %s %j → “%s”", (language, key, options, expected) => {
    expect(i18n.t(key, { ...options, lng: language })).toBe(expected);
  });

  it.each([
    ["en", 1, "AI on the server: 1 integration, sent yesterday"],
    ["en", 3, "AI on the server: 3 integrations, sent yesterday"],
    ["it", 1, "AI sul server: 1 integrazione, inviata yesterday"],
    ["it", 3, "AI sul server: 3 integrazioni, inviate yesterday"],
  ])("the server's AI configuration in %s with %i integration(s)", (language, count, expected) => {
    expect(i18n.t("personalServer.aiOnServer", { lng: language, count, time: "yesterday" })).toBe(expected);
  });

  it("has a form for every count in both languages, even a million", () => {
    for (const language of ["en", "it"]) {
      for (const count of [0, 1, 2, 11, 1_000_000]) {
        for (const key of ["autopilot.characters", "autopilot.plan.scenes", "personalServer.aiOnServer"]) {
          const text = i18n.t(key, { lng: language, count, time: "t" });
          expect(text, `${key} ${language} ${count}`).not.toBe(key);
          expect(text).not.toMatch(/\{\{/);
        }
      }
    }
  });
});

describe("what used to be written in one language only", () => {
  it.each(["en", "it"])("has a name in %s for the button that shows more activity", (language) => {
    expect(i18n.exists("autopilot.activity.more", { lng: language })).toBe(true);
    expect(i18n.t("autopilot.activity.more", { lng: language })).not.toBe("…");
  });
});
