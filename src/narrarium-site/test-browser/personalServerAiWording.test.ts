import { describe, expect, test } from "vitest";
import autopilotEn from "@/i18n/locales/autopilot.en";
import autopilotIt from "@/i18n/locales/autopilot.it";

/** What the browser sends to the personal server is the whole AI setup (integrations, routing, defaults), not just the router. */
describe("the texts about sending the AI setup to the personal server", () => {
  test.each([
    ["en", autopilotEn, "AI configuration", /integrations and routing/i, "API keys"],
    ["it", autopilotIt, "configurazione AI", /integrazioni e routing/i, "API key"],
  ] as const)("name the whole configuration, not the router (%s)", (_language, locale, name, parts, keys) => {
    const consent = locale.autopilot.where.consentAi;
    expect(consent).toContain(name);
    expect(consent).toMatch(parts);
    expect(consent).toContain(keys);
    expect(consent).not.toMatch(/router/i);

    const button = locale.personalServer.sendAi;
    expect(button).toContain(name);
    expect(button).not.toMatch(/router/i);
  });

  test("the Italian texts are translated, not copied from English", () => {
    expect(autopilotIt.autopilot.where.consentAi).not.toBe(autopilotEn.autopilot.where.consentAi);
    expect(autopilotIt.personalServer.sendAi).not.toBe(autopilotEn.personalServer.sendAi);
  });

  test.each([["en", autopilotEn], ["it", autopilotIt]] as const)("no personal-server or autopilot text still calls the AI setup a router configuration (%s)", (_language, locale) => {
    const texts: string[] = [];
    const collect = (node: unknown) => { if (typeof node === "string") texts.push(node); else if (node && typeof node === "object") Object.values(node).forEach(collect); };
    collect(locale.autopilot);
    collect(locale.personalServer);
    expect(texts.filter((text) => /(router configuration|configurazione del router)/i.test(text))).toEqual([]);
  });
});
