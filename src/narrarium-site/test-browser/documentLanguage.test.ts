import { afterEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";

describe("the language of the page", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("follows the language of the interface, so a screen reader pronounces the page in it (WCAG 3.1.1)", async () => {
    await i18n.changeLanguage("it");
    expect(document.documentElement.lang).toBe("it");
    await i18n.changeLanguage("en");
    expect(document.documentElement.lang).toBe("en");
  });

  it("is the resolved language, not a regional variant the browser reported", async () => {
    await i18n.changeLanguage("it-IT");
    expect(document.documentElement.lang).toBe("it");
  });

  it("is set when the interface starts, before anyone changes the language", () => {
    expect(document.documentElement.lang).toBe(i18n.resolvedLanguage);
    expect(document.documentElement.lang).toMatch(/^(en|it)$/);
  });
});
