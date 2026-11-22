import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import "@/i18n/endpoint";
import "@/i18n/catalog";
import { appDocEntries } from "@/lib/appDocs";

type Language = "en" | "it";
const LANGUAGES: Language[] = ["en", "it"];
const text = (language: Language, key: string, options: Record<string, unknown> = {}) => i18n.t(key, { lng: language, ...options }) as string;

const HEADING: Record<Language, string> = { en: "Reading the models of an endpoint", it: "Leggere i modelli di un endpoint" };
const NEIGHBOURS: Record<Language, [string, string]> = { en: ["GitHub Models quick start", "Task routing"], it: ["Avvio rapido GitHub Models", "Routing dei task"] };

function guide(language: Language): string {
  const entry = appDocEntries.find((candidate) => candidate.slug === "ai-router");
  if (!entry) throw new Error("the guide to the AI Router is missing");
  return (entry.translations?.[language] ?? entry).markdown;
}

/** The section of the guide to the AI Router about reading the models of an endpoint, where an author looks for how to fill an integration. */
function section(language: Language): string {
  const help = guide(language);
  const start = help.indexOf(`\n## ${HEADING[language]}\n`);
  expect(start, `the guide has a section «${HEADING[language]}»`).toBeGreaterThan(-1);
  const next = help.indexOf("\n## ", start + 4);
  return help.slice(start, next === -1 ? undefined : next);
}

describe.each(LANGUAGES)("the in-app help explains how to read the models of an endpoint and how to check the connection (%s)", (language) => {
  it("is a section of the guide to the AI Router, between the quick start of GitHub Models and the routing of the tasks, where the integrations are set up", () => {
    const help = guide(language);
    const [before, after] = NEIGHBOURS[language];
    const at = help.indexOf(`\n## ${HEADING[language]}\n`);
    expect(help.indexOf(`\n## ${before}\n`)).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(help.indexOf(`\n## ${before}\n`));
    expect(at).toBeLessThan(help.indexOf(`\n## ${after}\n`));
  });

  it("names the two buttons as the card calls them, and the button of the dialog", () => {
    const body = section(language);
    expect(body).toContain(`**${text(language, "endpoint.check")}**`);
    expect(body).toContain(`**${text(language, "endpoint.read")}**`);
    expect(body).toContain(language === "en" ? "**Add/update N models**" : "**Aggiungi/aggiorna N modelli**");
    expect(text(language, "catalog.apply", { count: 3 })).toBe(language === "en" ? "Add/update 3 models" : "Aggiungi/aggiorna 3 modelli");
  });

  it("names the three requests that are read, and says which one is needed and that a gateway that has no more leaves the list without limits", () => {
    const body = section(language);
    for (const path of ["/models", "/models/details", "/modalities"]) expect(body, path).toContain(`*${path}*`);
    expect(body).toContain("LlmProxy");
    expect(body).toMatch(language === "en" ? /needed/ : /necessari[ao]/);
  });

  it("says that a browser cannot tell a server that is off from CORS", () => {
    const body = section(language);
    expect(body).toContain("CORS");
    expect(body).toMatch(language === "en" ? /cannot tell/ : /non sa distinguer/);
  });

  it("says what an update never does: it never overwrites what the author wrote", () => {
    expect(section(language)).toMatch(language === "en" ? /never overwritten/ : /mai sovrascritt/);
  });

  it("says that the thinking parameter is only suggested, and which one", () => {
    const body = section(language);
    expect(body).toContain("chat_template_kwargs.reasoning_strength");
    expect(body).toMatch(language === "en" ? /untick/ : /togliere la spunta/);
  });

  it("says where the check is also offered, and that on a personal server it checks from the browser", () => {
    const body = section(language);
    expect(body).toMatch(language === "en" ? /error panel/ : /pannello d'errore/);
    expect(body).toMatch(language === "en" ? /from your browser/ : /dal browser/);
  });

  it("says that the older way of loading the models is still there", () => {
    expect(section(language)).toContain(`**${text(language, "settings.loadApiModels")}**`);
  });
});
