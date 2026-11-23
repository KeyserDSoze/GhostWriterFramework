import { beforeAll, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { appDocEntries } from "@/lib/appDocs";
import { guideText, loadGuides } from "./helpers/guides";

type Language = "en" | "it";

const helpOf = (language: Language) => {
  const entry = appDocEntries.find((candidate) => candidate.slug === "autopilot");
  if (!entry) throw new Error("the Autopilot help is missing");
  return guideText("autopilot", language);
};

beforeAll(loadGuides);

/** The controls of the page that the help names in bold: the help and the page must call them the same thing. */
const LABELS = [
  "autopilot.tabs.overview",
  "autopilot.tabs.timeline",
  "autopilot.tabs.plan",
  "autopilot.tabs.rules",
  "autopilot.actions.intervene",
  "autopilot.actions.retry",
  "autopilot.actions.addChapters",
  "autopilot.actions.writeNewChapters",
  "autopilot.actions.resume",
  "autopilot.actions.reset",
  "autopilot.danger.title",
  "autopilot.quick.more",
  "autopilot.dockLive",
  "autopilot.dockBook",
  "autopilot.where.title",
  "autopilot.activity.title",
  "autopilot.timeline.filter.all",
  "autopilot.timeline.filter.problems",
  "autopilot.timeline.filter.director",
  "autopilot.timeline.filter.readers",
  "autopilot.timeline.filter.writing",
  "autopilot.timeline.hide",
  "autopilot.result.title",
  "autopilot.result.actions.add",
  "autopilot.result.actions.read",
  "autopilot.result.actions.export",
  "autopilot.result.actions.ask",
  "autopilot.result.scores.order.lowest",
  "autopilot.failure.actions.retry",
  "autopilot.failure.actions.integrations",
  "autopilot.failure.actions.copy",
  "autopilot.presets.legend",
  "autopilot.presets.story.name",
  "autopilot.presets.novella.name",
  "autopilot.presets.novel-draft.name",
  "autopilot.estimate.title",
  "autopilot.estimate.stats.calls",
  "autopilot.estimate.stats.inputTokens",
  "autopilot.estimate.stats.outputTokens",
  "autopilot.estimate.stats.cost",
  "autopilot.estimate.stats.minutes",
  "autopilot.estimate.notKnown",
  "autopilot.estimate.notEstimated",
  "autopilot.estimate.assumptions.title",
  "autopilot.estimate.severity.error",
  "autopilot.estimate.severity.warning",
  "autopilot.estimate.severity.info",
  "autopilot.estimate.actions.integrations",
  "autopilot.estimate.actions.server",
  "autopilot.approval.rest.title",
  "autopilot.approval.rest.tokens",
  "autopilot.approval.rest.router",
  "autopilot.approval.rest.full",
];

beforeAll(async () => {
  await loadAutopilotTranslations();
});

describe.each<Language>(["en", "it"])("the help of the autopilot (%s)", (language) => {
  it("names the controls of the page the way the page does", () => {
    const t = i18n.getFixedT(language);
    const help = helpOf(language);
    const missing = LABELS.map((key) => t(key)).filter((label) => !help.includes(`**${label}**`));
    expect(missing).toEqual([]);
    expect(help).toContain(`**${t("autopilot.actions.readChapter", { number: "N" })}**`);
  });

  it("describes the control band, the tabs and the mini-player, and no longer the panels they replace", () => {
    const help = helpOf(language);
    const gone = language === "en" ? [/progress card/i, /live panel/i, /live feed/i] : [/scheda di avanzamento/i, /pannello in diretta/i, /feed in diretta/i];
    expect(gone.filter((pattern) => pattern.test(help)).map(String)).toEqual([]);
    expect(help).toMatch(language === "en" ? /## The Autopilot page/ : /## La pagina Autopilot/);
    expect(help).toContain("mini-player");
  });

  it("describes the sizes and the preview of the run: what it says, what it cannot say, and why the cost or the time may be not known", () => {
    const help = helpOf(language);
    expect(help).toContain(language === "en" ? "## What to expect from a run" : "## Cosa aspettarsi da una corsa");
    const said = language === "en"
      ? ["rounds of review", "Director", "thinking before it answers", "billed again", "retries", "no price", "your own computer", "learned from the steps", "personal server", "AI Router", "Add chapters", "Outline"]
      : ["giri di revisione", "Direttore", "ragionare prima di rispondere", "fatturato di nuovo", "nuovi tentativi", "senza prezzo", "tuo computer", "si impara dai passi", "server personale", "Router AI", "Aggiungi capitoli", "Scaletta"];
    expect(said.filter((word) => !help.includes(word))).toEqual([]);
    // The guide says that a size never writes the director, and that a book that never ran has no empty card.
    expect(help).toMatch(language === "en" ? /file is not touched/ : /file non viene toccato/);
    expect(help).toMatch(language === "en" ? /no card yet/ : /non ha ancora la scheda/);
  });

  it("describes what the rest will cost at the end of the plan to approve: for the plan as it is, only what is left, with the models of the place where the book runs, and the problems with their way to the AI Router", () => {
    const help = helpOf(language);
    const from = help.indexOf(language === "en" ? "## The plan to approve" : "## Il piano da approvare");
    const to = help.indexOf(language === "en" ? "## The map of the chapters" : "## La mappa dei capitoli");
    expect(from).toBeGreaterThan(0);
    const section = help.slice(from, to);
    const t = i18n.getFixedT(language);
    expect(section).toContain(`**${t("autopilot.approval.rest.title")}**`);
    const said = language === "en"
      ? ["as it is now and not from the numbers of the brief", "only the chapters still to write", "rounds of review your director allows", "your Outline", "personal server", "just before it is written", "never the book", "announces nothing", "Not known", "Not estimated", "the steps of the planning already count", "shown once", "made again"]
      : ["così com'è ora e non sui numeri del brief", "solo i capitoli ancora da scrivere", "giri di revisione che il tuo direttore permette", "la tua Scaletta", "server personale", "subito prima di scriverlo", "mai il libro", "non annuncia nulla", "Non noto", "Non stimato", "i passi della pianificazione contano già", "una volta sola", "rifatto"];
    expect(said.filter((phrase) => !section.includes(phrase))).toEqual([]);
    // The part about the estimate tells where the same estimate is on the screen of the plan, and the screen of the plan where the estimate of the form is.
    expect(help.slice(help.indexOf(language === "en" ? "## What to expect from a run" : "## Cosa aspettarsi da una corsa"), from)).toContain(language === "en" ? "at the end of the plan that waits for you" : "in fondo al piano che aspetta te");
    expect(section).toContain(language === "en" ? "What to expect from a run" : "Cosa aspettarsi da una corsa");
  });

  it("describes the result of a finished book and the panel of an error, with the kinds of error by their titles", () => {
    const t = i18n.getFixedT(language);
    const help = helpOf(language);
    for (const kind of ["network", "auth", "rate_limit", "timeout", "truncated", "refused", "conflict", "budget", "limit", "profile", "config", "provider"]) {
      expect(help, kind).toContain(t(`autopilot.failure.kind.${kind}.title`));
    }
    expect(help).toContain(language === "en" ? "countdown" : "conto alla rovescia");
  });
});
