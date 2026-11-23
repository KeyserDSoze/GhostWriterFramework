import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import enLocale from "@/i18n/locales/en";
import itLocale from "@/i18n/locales/it";
import autopilotEn from "@/i18n/locales/autopilot.en";
import autopilotIt from "@/i18n/locales/autopilot.it";
import { appDocEntries } from "@/lib/appDocs";
import { loadDocMarkdown } from "@/lib/docContent";
import { docEntries } from "@/lib/generated-docs";
import { guideText, loadGuides } from "./helpers/guides";

type Tree = { [key: string]: string | Tree };
type Language = "en" | "it";

const LOCALES: Record<Language, Tree> = { en: enLocale as unknown as Tree, it: itLocale as unknown as Tree };
const AUTOPILOT_LOCALES: Record<Language, Tree> = { en: autopilotEn as unknown as Tree, it: autopilotIt as unknown as Tree };
const INTEGRATIONS: Record<Language, string> = { en: "AI Integrations", it: "Integrazioni AI" };
const ROUTER = "AI Router";
const LANGUAGES: Language[] = ["en", "it"];

function lookup(tree: Tree, path: string): string | undefined {
  const value = path.split(".").reduce<string | Tree | undefined>((node, key) => (node && typeof node === "object" ? node[key] : undefined), tree);
  return typeof value === "string" ? value : undefined;
}

function flatten(node: string | Tree | undefined, prefix = ""): string[] {
  if (node === undefined || typeof node === "string") return [];
  return Object.entries(node).flatMap(([key, child]) => (typeof child === "string" ? [`${prefix}${key}`] : flatten(child, `${prefix}${key}.`)));
}

const NEW_OR_REWORDED_KEYS = [
  "settingsSection.aiIntegrationsTitle",
  "settingsSection.aiIntegrationsDescription",
  "settingsSection.aiRouterDescription",
  "routing.noIntegrationsTitle",
  "routing.noIntegrationsBody",
  "routing.noIntegrationsAction",
  "routing.modelsFromIntegrations",
  "settings.nextRouteTasks",
  "books.quickStart.aiBody",
  "books.quickStart.aiAction",
  "onboarding.steps.3.body",
  "onboarding.steps.3.action",
  "audit.actions.openAiIntegrations",
];

describe("texts of the AI Integrations and AI Router sections", () => {
  test.each(LANGUAGES)("every new or reworded text exists in %s", (language) => {
    for (const key of NEW_OR_REWORDED_KEYS) expect(lookup(LOCALES[language], key)?.trim(), `${key} (${language})`).toBeTruthy();
  });

  test("the Italian texts are translated, not copied from English", () => {
    for (const key of NEW_OR_REWORDED_KEYS) expect(lookup(LOCALES.it, key), key).not.toBe(lookup(LOCALES.en, key));
    expect(lookup(LOCALES.it, "settingsSection.aiIntegrationsTitle")).toBe("Integrazioni AI");
    expect(lookup(LOCALES.en, "settingsSection.aiIntegrationsTitle")).toBe("AI Integrations");
    expect(lookup(LOCALES.it, "settingsSection.aiRouterTitle")).toBe(ROUTER);
    expect(lookup(LOCALES.en, "settingsSection.aiRouterTitle")).toBe(ROUTER);
  });

  test("the settings sections keep the same keys in both languages", () => {
    for (const namespace of ["nav", "settingsSection", "routing", "settings", "books.quickStart", "onboarding", "audit.actions"]) {
      const english = flatten(namespace.split(".").reduce<string | Tree | undefined>((node, key) => (node as Tree | undefined)?.[key], LOCALES.en)).sort();
      const italian = flatten(namespace.split(".").reduce<string | Tree | undefined>((node, key) => (node as Tree | undefined)?.[key], LOCALES.it)).sort();
      expect(italian, namespace).toEqual(english);
    }
  });

  test.each(LANGUAGES)("the cards describe what each page is for (%s)", (language) => {
    const integrations = lookup(LOCALES[language], "settingsSection.aiIntegrationsDescription")!;
    const router = lookup(LOCALES[language], "settingsSection.aiRouterDescription")!;
    if (language === "en") {
      expect(integrations).toMatch(/providers.*keys.*models.*prices/i);
      expect(router).toMatch(/which model.*each task.*fallbacks.*limits/i);
    } else {
      expect(integrations).toMatch(/provider.*endpoint.*chiavi.*modelli.*prezzi/i);
      expect(router).toMatch(/quale modello.*ogni task.*fallback.*limiti/i);
    }
    expect(integrations).not.toBe(router);
  });

  test.each(LANGUAGES)("everything that sends the author to configure a provider names AI Integrations (%s)", (language) => {
    const names = INTEGRATIONS[language];
    for (const key of ["books.quickStart.aiAction", "onboarding.steps.3.action", "audit.actions.openAiIntegrations", "routing.noIntegrationsAction", "books.quickStart.aiBody", "onboarding.steps.3.body"]) {
      expect(lookup(LOCALES[language], key), `${key} (${language})`).toContain(names);
    }
    for (const key of ["books.quickStart.aiAction", "onboarding.steps.3.action", "audit.actions.openAiIntegrations"]) {
      expect(lookup(LOCALES[language], key), `${key} (${language})`).not.toContain("Router");
    }
    expect(lookup(LOCALES[language], "settings.nextRouteTasks")).toContain(ROUTER);
    expect(lookup(LOCALES[language], "audit.actions.openAiRouter")).toBeUndefined();
  });

  test.each(LANGUAGES)("the Autopilot texts point prices, model limits and the missing model at AI Integrations (%s)", (language) => {
    const autopilot = AUTOPILOT_LOCALES[language];
    expect(lookup(autopilot, "autopilot.errors.aiMissing")).toContain(INTEGRATIONS[language]);
    expect(lookup(autopilot, "autopilot.setup.budgetHint")).toContain(INTEGRATIONS[language]);
    expect(lookup(autopilot, "autopilot.modelHint")).toContain(INTEGRATIONS[language]);
    for (const key of ["autopilot.setup.budgetHint", "autopilot.modelHint"]) expect(lookup(autopilot, key), key).not.toMatch(/router/i);
  });
});

describe("the in-app documentation of the two settings pages", () => {
  const path = (language: Language, page: string) => `${language === "en" ? "Settings" : "Impostazioni"} → ${page}`;

  beforeAll(loadGuides);

  test.each(LANGUAGES)("tells the author to add providers in AI Integrations and then to route tasks in AI Router (%s)", (language) => {
    const markdown = guideText("ai-router", language);
    const paragraph = markdown.split("\n").find((line) => line.includes("Azure OpenAI"))!;
    const integrations = paragraph.indexOf(path(language, INTEGRATIONS[language]));
    const router = paragraph.indexOf(path(language, ROUTER));
    expect(integrations).toBeGreaterThan(-1);
    expect(router).toBeGreaterThan(integrations);
  });

  test.each(LANGUAGES)("lists both pages in the overview of the settings (%s)", (language) => {
    const markdown = guideText("privacy-settings", language);
    expect(markdown).toContain(`${INTEGRATIONS[language]}, ${ROUTER},`);
  });

  test.each(LANGUAGES)("still sends the routing of the Autopilot and Director tasks to AI Router (%s)", (language) => {
    expect(guideText("autopilot", language)).toContain(path(language, ROUTER));
  });

  test("the getting-started guide is read from the repository docs and names the new page", async () => {
    const guideTwo = docEntries.find((entry) => entry.slug === "guide-2-getting-started")!;
    for (const language of LANGUAGES) {
      const source = readFileSync(resolve(process.cwd(), `../../docs/guide-2-getting-started.${language}.md`), "utf8");
      expect(guideTwo.translations[language]!.sourcePath).toBe(`docs/guide-2-getting-started.${language}.md`);
      expect(await loadDocMarkdown(guideTwo, language), `the guide is not the text of docs/guide-2-getting-started.${language}.md`).toBe(source);
      expect(source).toContain(path(language, INTEGRATIONS[language]));
      expect(source).toContain(path(language, ROUTER));
    }
  });

  test("no documentation sends the author to AI Router to add a provider", async () => {
    const sendsToRouter = /(Configure|Add|Connect|Configura|Aggiungi|Collega)[^\n.→]*(Azure OpenAI|GitHub Models|OpenAI)[^\n.→]*(Settings|Impostazioni) → AI Router/;
    expect(appDocEntries.length + docEntries.length).toBeGreaterThanOrEqual(40);
    for (const entry of [...appDocEntries, ...docEntries]) {
      for (const language of LANGUAGES) expect(await loadDocMarkdown(entry, language), `${entry.slug} (${language})`).not.toMatch(sendsToRouter);
    }
  });
});
