import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, MAX_IDLE_TIMEOUT_MS, MIN_IDLE_TIMEOUT_MS, MIN_REQUEST_TIMEOUT_MS } from "narrarium-engine";
import i18n from "@/i18n";
import { DEFAULT_PROVIDER_TIMEOUT_MS } from "@/assistant/executionLimits";
import { appDocEntries } from "@/lib/appDocs";
import { guideText, loadGuides } from "./helpers/guides";

type Language = "en" | "it";
const LANGUAGES: Language[] = ["en", "it"];
const text = (language: Language, key: string) => i18n.t(key, { lng: language }) as string;
const number = (language: Language, value: number) => new Intl.NumberFormat(language).format(value);

const KEYS = ["settings.requestTimeoutHint", "settings.idleTimeoutMs", "settings.idleTimeoutHint", "settings.idleTimeoutOffNote", "settings.streamMode", "settings.streamModeAuto", "settings.streamModeOff", "settings.streamModeHint"];
const CONTROLS = ["settings.requestTimeoutMs", "settings.idleTimeoutMs", "settings.streamMode", "settings.streamModeAuto", "settings.streamModeOff"];

const guide = (slug: string, language: Language) => {
  const entry = appDocEntries.find((candidate) => candidate.slug === slug);
  if (!entry) throw new Error(`the guide ${slug} is missing`);
  return guideText(slug, language);
};

beforeAll(loadGuides);

describe.each(LANGUAGES)("the texts of the request settings (%s)", (language) => {
  it("has every new text, none of them empty", () => {
    for (const key of KEYS) {
      expect(i18n.exists(key, { lng: language }), key).toBe(true);
      expect(text(language, key).trim().length, key).toBeGreaterThan(2);
    }
  });

  it("writes the hints with the figures as parameters, never with a figure of its own", () => {
    for (const key of ["settings.requestTimeoutHint", "settings.idleTimeoutHint"]) expect(text(language, key), key).toMatch(/\{\{\w+\}\}/);
    for (const key of ["settings.requestTimeoutHint", "settings.idleTimeoutHint", "settings.streamModeHint"]) expect(text(language, key), key).not.toMatch(/\b\d{4,}\b/);
  });
});

describe("the Italian texts are translated, not copied from English", () => {
  it.each(KEYS.filter((key) => key !== "settings.streamMode"))("%s", (key) => {
    expect(text("it", key)).not.toBe(text("en", key));
  });

  it("Streaming is the same word in both languages on purpose: the engine's error quotes it", () => {
    expect(text("it", "settings.streamMode")).toBe("Streaming");
    expect(text("it", "settings.streamMode")).toBe(text("en", "settings.streamMode"));
  });
});

describe.each(LANGUAGES)("the in-app help names the new settings as the page does (%s)", (language) => {
  it("describes the three settings of an integration in the guide to AI integrations, each under the name the page gives it", () => {
    const help = guide("ai-router", language);
    for (const key of CONTROLS) expect(help, key).toContain(`**${text(language, key)}**`);
    expect(help).toMatch(language === "en" ? /## Timeouts and streaming/ : /## Timeout e streaming/);
  });

  it("gives the figures of the engine", () => {
    const help = guide("ai-router", language);
    for (const value of [MIN_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, MIN_IDLE_TIMEOUT_MS, MAX_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_PROVIDER_TIMEOUT_MS]) {
      expect(help, `${value} ms`).toContain(number(language, value));
    }
  });

  it("says what each setting does: the start of the answer, the silence of a stream, and when to switch streaming off", () => {
    const help = guide("ai-router", language);
    expect(help).toMatch(language === "en" ? /start answering/ : /cominciare a rispondere/);
    expect(help).toMatch(language === "en" ? /silence between two pieces of a streamed reply/ : /silenzio più lungo ammesso tra due pezzi di una risposta in streaming/);
    expect(help).toMatch(language === "en" ? /refuses streamed replies/ : /rifiuta le risposte in streaming/);
    expect(help).toContain("400");
  });

  it("warns that a personal server older than 0.1.7 does not know the two new settings", () => {
    const help = guide("ai-router", language);
    expect(help).toContain("0.1.7");
    expect(help).toContain(`**${text(language, "settings.idleTimeoutMs")}**`);
  });

  it("sends the author whose autopilot was too slow to those settings, from the help of the autopilot", () => {
    const help = guide("autopilot", language);
    for (const key of ["settings.requestTimeoutMs", "settings.idleTimeoutMs", "settings.streamMode"]) expect(help, key).toContain(`**${text(language, key)}**`);
  });
});
