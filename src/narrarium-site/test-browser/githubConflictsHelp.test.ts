import { beforeAll, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import "@/i18n/githubConflicts";
import { guideText, loadGuides } from "./helpers/guides";

type Language = "en" | "it";

beforeAll(async () => {
  await Promise.all([loadGuides(), loadAutopilotTranslations()]);
});

/** The label of the page, in a language: the help must call the controls what the page calls them. */
const label = (key: string, language: Language, options: Record<string, unknown> = {}) => i18n.t(key, { lng: language, ...options }) as string;

const section = (text: string, heading: string): string => {
  const start = text.indexOf(`\n## ${heading}\n`);
  expect(start, `the guide has the section «${heading}»`).toBeGreaterThan(-1);
  const next = text.indexOf("\n## ", start + 4);
  return text.slice(start, next === -1 ? undefined : next);
};

const HEADING: Record<Language, string> = { en: "Conflicts with GitHub", it: "Conflitti con GitHub" };

describe.each(["en", "it"] as const)("the help to the autopilot explains the conflicts with GitHub (%s)", (language) => {
  const guide = () => guideText("autopilot", language);
  const conflicts = () => section(guide(), HEADING[language]);

  it("has a section of its own, after the personal server and before the AI router", () => {
    const text = guide();
    const headings = [...text.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    const index = headings.indexOf(HEADING[language]);
    expect(index).toBeGreaterThan(headings.indexOf(language === "en" ? "Personal server" : "Server personale"));
    expect(index).toBeLessThan(headings.indexOf(language === "en" ? "AI router" : "Router AI"));
  });

  it("names every control by the words of the page, in bold", () => {
    const body = conflicts();
    for (const key of ["githubConflicts.resolve", "githubConflicts.choose.server", "githubConflicts.choose.github", "githubConflicts.rest.legend", "githubConflicts.actions.resolve", "autopilot.actions.resume", "autopilot.where.title", "autopilot.where.sync"]) {
      expect(body, key).toContain(`**${label(key, language)}**`);
    }
    expect(body).toContain(`**${label("githubConflicts.error.title", language)}**`);
    expect(body).toContain(`**${label("githubConflicts.actions.pause", language)}**`);
  });

  it("says what these conflicts are, and that nothing is lost", () => {
    const body = conflicts();
    if (language === "en") {
      expect(body).toMatch(/same file/);
      expect(body).toMatch(/nothing is lost/i);
      expect(body).toMatch(/personal server/);
    } else {
      expect(body).toMatch(/stesso file/);
      expect(body).toMatch(/non si perde nulla/i);
      expect(body).toMatch(/server personale/);
    }
  });

  it("says where the author is told: the panel of the error, «Where it runs», and a manual sync", () => {
    const body = conflicts();
    expect(body).toContain(label("autopilot.where.title", language));
    expect(body).toContain(label("autopilot.where.sync", language));
    expect(body).toContain(label("autopilot.quick.publish.now", language));
  });

  it("says what each choice does, what stays in the history, and that fifty files are shown at a time", () => {
    const body = conflicts();
    if (language === "en") {
      expect(body).toMatch(/one merge commit/);
      expect(body).toMatch(/git history/);
      expect(body).toMatch(/fifty at a time/);
      expect(body).toMatch(/nothing is changed until you press/i);
    } else {
      expect(body).toMatch(/un solo commit di unione/);
      expect(body).toMatch(/cronologia git/);
      expect(body).toMatch(/cinquanta alla volta/);
      expect(body).toMatch(/finché non premi/i);
    }
  });

  it("says why the autopilot's own files are not asked about, and which side keeps them", () => {
    const body = conflicts();
    if (language === "en") {
      expect(body).toMatch(/state, log and plan/);
      expect(body).toMatch(/never asked about/);
    } else {
      expect(body).toMatch(/stato, registro e piano/);
      expect(body).toMatch(/non vengono mai chiesti/);
    }
  });

  it("says what happens when publishing is off, and when GitHub refuses the push", () => {
    const body = conflicts();
    if (language === "en") {
      expect(body).toMatch(/publishing is off/);
      expect(body).toMatch(/next sync publishes it/);
    } else {
      expect(body).toMatch(/pubblicazione è spenta/);
      expect(body).toMatch(/prossima sincronizzazione/);
    }
  });

  it("says that the autopilot never restarts by itself, and that it must be paused before", () => {
    const body = conflicts();
    if (language === "en") {
      expect(body).toMatch(/never restarts by itself/);
      expect(body).toMatch(/pause/i);
    } else {
      expect(body).toMatch(/non riparte mai da solo/);
      expect(body).toMatch(/pausa/i);
    }
  });

  it("says what to do with a personal server that is too old", () => {
    const body = conflicts();
    expect(body).toContain(label("githubConflicts.oldServer.link", language));
    expect(body).toContain(language === "en" ? "Version and updates" : "Versione e aggiornamenti");
  });

  it("says what the refusals of the window mean: GitHub moved again, nothing to resolve, not on GitHub, no common history, a name the server cannot write", () => {
    const body = conflicts();
    if (language === "en") {
      for (const part of [/changed again/, /nothing left to resolve/, /not on GitHub/, /no history in common/, /cannot write/]) expect(body).toMatch(part);
    } else {
      for (const part of [/cambiato di nuovo/, /nulla da risolvere/, /non è su GitHub/, /nessuna cronologia in comune/, /non può scrivere/]) expect(body).toMatch(part);
    }
  });

  it("tells the conflicts with GitHub from those between this device and the server", () => {
    const body = conflicts();
    expect(body).toContain(label("autopilot.where.keepLocal", language));
  });

  it("is named in the part about errors, which now lists the title of this one", () => {
    const body = section(guide(), language === "en" ? "When something goes wrong" : "Quando qualcosa va storto");
    expect(body).toContain(label("githubConflicts.error.title", language));
    expect(body).toContain(label("githubConflicts.resolve", language));
  });
});

describe.each(["en", "it"] as const)("the help to synchronization points to it (%s)", (language) => {
  it("sends a book run by the personal server to the conflicts of the Autopilot guide", () => {
    const text = guideText("github-sync", language);
    expect(text).toContain(HEADING[language]);
    expect(text).toContain(language === "en" ? "Autopilot" : "Autopilot");
  });
});

describe("the section of the help to the MCP server that is about the Synopsis", () => {
  const EN = "An assistant that may read the book can read its **Synopsis** (your chapter-by-chapter plan, which the autopilot follows) with two tools: `read_outline`, which gives the description of the book and the entries a page at a time (it can also look for a number or some words), and `read_outline_entry`, which gives one entry whole, with whether its chapter is already written or frozen and what the autopilot would do if the entry changed. An assistant that may change the book edits the Synopsis with `edit_outline`: up to 50 edits in a row (add, insert, move, remove or change an entry, change the description of the book), saved together as **one commit** that you can undo. The Synopsis is changed only this way, like the Copilot's «Edit the Synopsis» tool: the assistant cannot write its files as plain files. What it writes there is **yours** (the autopilot follows it and never rewrites it). It can replace the text of an entry only after reading it, and if you changed it meanwhile nothing is written. A change that would touch more than 1,000 files (for example a new chapter at the head of a very long synopsis) is left to you, in the Synopsis page.";
  const IT = "Un assistente che può leggere il libro può leggerne la **Sinossi** (il tuo piano capitolo per capitolo, che l'autopilot segue) con due strumenti: `read_outline`, che dà la descrizione del libro e le voci una pagina alla volta (può anche cercare un numero o delle parole), e `read_outline_entry`, che dà una voce intera, con l'indicazione se il suo capitolo è già scritto o congelato e cosa farebbe l'autopilot se la voce cambiasse. Un assistente che può modificare il libro cambia la Sinossi con `edit_outline`: fino a 50 modifiche di fila (aggiungere, inserire, spostare, togliere o cambiare una voce, cambiare la descrizione del libro), salvate insieme in **un solo commit** che puoi annullare. La Sinossi si cambia solo così, come fa lo strumento «Modifica la Sinossi» del Copilot: l'assistente non può scriverne i file come file qualsiasi. Ciò che scrive lì è **tuo** (l'autopilot lo segue e non lo riscrive mai). Può sostituire il testo di una voce solo dopo averla letta, e se nel frattempo l'hai cambiata non scrive nulla. Una modifica che toccherebbe più di 1.000 file (per esempio un nuovo capitolo in testa a una Sinossi lunghissima) resta a te, nella pagina Sinossi.";

  it.each([["en", "The Synopsis", EN], ["it", "La Sinossi", IT]] as const)("has «%s» with the text of the specification, between ChatGPT and Claude.ai and the risk (%s)", (language, heading, text) => {
    const guide = guideText("book-mcp", language);
    const body = section(guide, heading);
    expect(body.trim()).toBe(`## ${heading}\n\n${text}`);
    const headings = [...guide.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(headings.indexOf(heading)).toBe(headings.length - 2);
    expect(headings[headings.length - 1]).toBe(language === "en" ? "The risk" : "Il rischio");
    expect(headings[headings.length - 3]).toBe(language === "en" ? "ChatGPT and Claude.ai" : "ChatGPT e Claude.ai");
  });

  it("names the three tools of the MCP server of the book, the same in both languages", () => {
    for (const language of ["en", "it"] as const) {
      const body = guideText("book-mcp", language);
      for (const tool of ["`read_outline`", "`read_outline_entry`", "`edit_outline`"]) expect(body, `${language}: ${tool}`).toContain(tool);
    }
  });
});
