import assert from "node:assert/strict";
import test from "node:test";
import en from "../src/i18n/locales/en.ts";
import it from "../src/i18n/locales/it.ts";
import autopilotEn from "../src/i18n/locales/autopilot.en.ts";
import autopilotIt from "../src/i18n/locales/autopilot.it.ts";

function get(tree, path) {
  return path.split(".").reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), tree);
}

const placeholders = (text) => [...text.matchAll(/\{\{\s*([\w.]+)[\s,}]/g)].map((match) => match[1]).sort();

/** Read at once by the app shell or by pages that load no autopilot texts: they must be in the always-loaded bundle. */
const EAGER = [
  "autopilot.launcherProfileProblems",
  "profileFile.warningsTitle_one",
  "profileFile.warningsTitle_other",
  "profileFile.warningsBody",
  "profileFile.saveConfirm",
  "profileFile.directorOpinionNote",
  "readerPersonas.hasProblems",
];

/** Loaded with the views of the autopilot, the director and the personal server. */
const LAZY = [
  "autopilot.insight.profileProblems",
  "autopilot.profileProblems.title",
  "autopilot.profileProblems.explain",
  "autopilot.profileProblems.listLabel",
  "autopilot.profileProblems.linksLabel",
  "autopilot.profileProblems.openDirector",
  "autopilot.profileProblems.openGhostwriters",
  "autopilot.profileProblems.openReaders",
  "autopilot.profileProblems.resumeHint",
  "autopilot.fileError.openFile",
  "autopilot.fileError.openFileNamed",
  "autopilot.fileError.hint",
  "autopilot.setup.budgetTokens",
  "autopilot.setup.budgetTokensHint",
  "autopilot.progress.usageUnknown_one",
  "autopilot.progress.usageUnknown_other",
  "autopilot.progress.usageUnknownHint",
  "autopilot.progress.costUnknown_one",
  "autopilot.progress.costUnknown_other",
  "autopilot.progress.costUnknownHint",
  "autopilot.where.partial",
  "autopilot.where.skippedTitle_one",
  "autopilot.where.skippedTitle_other",
  "autopilot.where.skippedHint",
  "autopilot.where.skipReason.too-large",
  "autopilot.where.skipReason.unsafe-path",
  "autopilot.where.skipReason.not-text",
  "personalServer.pair.verification",
  "personalServer.pair.verificationWarning",
  "personalServer.pair.doneCode",
  "personalServer.compat.older",
  "personalServer.compat.newer",
];

test("the texts the app shell and the profile pages read are in the always-loaded bundle, in both languages", () => {
  for (const key of EAGER) {
    for (const [language, locale] of [["en", en], ["it", it]]) {
      assert.equal(typeof get(locale, key), "string", `${language}: ${key}`);
      assert.ok(get(locale, key).trim(), `${language}: ${key} is not empty`);
    }
    assert.equal(get(autopilotEn, key), undefined, `${key} is not repeated in the lazily loaded bundle`);
  }
});

test("the texts of the autopilot, the director and the personal server are in the bundle loaded with their views, in both languages", () => {
  for (const key of LAZY) {
    for (const [language, locale] of [["en", autopilotEn], ["it", autopilotIt]]) {
      assert.equal(typeof get(locale, key), "string", `${language}: ${key}`);
      assert.ok(get(locale, key).trim(), `${language}: ${key} is not empty`);
    }
    assert.equal(get(en, key), undefined, `${key} is not repeated in the always-loaded bundle`);
  }
});

test("each text keeps the same values to fill in, in both languages", () => {
  for (const key of EAGER) assert.deepEqual(placeholders(get(it, key)), placeholders(get(en, key)), key);
  for (const key of LAZY) assert.deepEqual(placeholders(get(autopilotIt, key)), placeholders(get(autopilotEn, key)), key);
});

test("each text is written in Italian, not copied from English", () => {
  for (const key of EAGER) assert.notEqual(get(it, key), get(en, key), key);
  for (const key of LAZY) assert.notEqual(get(autopilotIt, key), get(autopilotEn, key), key);
});

test("the notices that name a count have a form for one and for many, in both languages", () => {
  for (const base of ["profileFile.warningsTitle", "autopilot.progress.usageUnknown", "autopilot.progress.costUnknown", "autopilot.where.skippedTitle"]) {
    let found = 0;
    for (const [language, locale] of [["en", en], ["en", autopilotEn], ["it", it], ["it", autopilotIt]]) {
      const one = get(locale, `${base}_one`);
      const other = get(locale, `${base}_other`);
      if (one === undefined && other === undefined) continue;
      found += 1;
      assert.equal(typeof one, "string", `${language}: ${base}_one`);
      assert.ok(placeholders(other).includes("count"), `${language}: ${base}_other says how many`);
    }
    assert.equal(found, 2, `${base} exists once in each language`);
  }
});

test("the explanation of a stop for profiles points at the button that resumes", () => {
  for (const locale of [autopilotEn, autopilotIt]) assert.ok(get(locale, "autopilot.profileProblems.resumeHint").includes("{{action}}"));
});

/** Every text under a key, with its path: `autopilot.quick.run.step`, … */
function leaves(tree, prefix) {
  return Object.entries(tree ?? {}).flatMap(([key, child]) => (child && typeof child === "object" ? leaves(child, `${prefix}.${key}`) : [`${prefix}.${key}`]));
}

test("the texts of the quick commands are in the bundle loaded with the autopilot, in both languages, written in Italian and with the same values to fill in", () => {
  const keys = leaves(autopilotEn.autopilot.quick, "autopilot.quick");
  assert.ok(keys.length > 90, `the quick commands have their texts (saw ${keys.length})`);
  for (const key of keys) {
    for (const [language, locale] of [["en", autopilotEn], ["it", autopilotIt]]) {
      assert.equal(typeof get(locale, key), "string", `${language}: ${key}`);
      assert.ok(get(locale, key).trim(), `${language}: ${key} is not empty`);
    }
    assert.equal(get(en, key), undefined, `${key} is not repeated in the always-loaded bundle`);
    assert.deepEqual(placeholders(get(autopilotIt, key)), placeholders(get(autopilotEn, key)), key);
  }
  assert.deepEqual(leaves(autopilotIt.autopilot.quick, "autopilot.quick").sort(), keys.sort(), "the same texts in both languages");
  // The Italian is Italian: the words of the site (passo, capitolo, in diretta), not the English ones. Three texts are only a form to fill in (a name and its
  // context, a book and its panel, the brand GitHub and a way to publish) and read the same in both languages.
  const forms = new Set(["autopilot.quick.named", "autopilot.quick.contextDock", "autopilot.quick.publish.label"]);
  const same = keys.filter((key) => !forms.has(key) && get(autopilotIt, key) === get(autopilotEn, key) && get(autopilotEn, key).length > 12);
  assert.deepEqual(same, [], "texts copied from English");
});

test("the quick commands speak of steps and chapters in the words of the site, in each language", () => {
  const it_ = autopilotIt.autopilot.quick;
  const en_ = autopilotEn.autopilot.quick;
  assert.equal(it_.run.pauseStep, "Pausa dopo questo passo");
  assert.equal(it_.run.pauseChapter, "Pausa a fine capitolo");
  assert.equal(it_.run.step, "Esegui un solo passo");
  assert.equal(it_.run.chapter, "Esegui un solo capitolo");
  assert.equal(it_.publish.choice.off, "Mai");
  assert.equal(it_.publish.choice.chapter, "A ogni capitolo");
  assert.equal(it_.publish.choice.step, "A ogni passo");
  assert.equal(it_.publish.mode.chapter, "a fine capitolo", "GitHub: a fine capitolo");
  assert.equal(it_.where.hostBrowser, "Questo browser");
  assert.equal(it_.where.hostServer, "Il mio server");
  assert.equal(it_.status.pauseStep, "In pausa dopo questo passo");
  assert.equal(en_.run.pauseStep, autopilotEn.autopilot.actions.pause, "the pause of the bar is the one the site always had");
  assert.equal(it_.run.pauseStep, autopilotIt.autopilot.actions.pause);
});

test("every text that names a count has a form for one and for many, in both languages", () => {
  for (const base of ["autopilot.quick.status.stepLimit", "autopilot.quick.status.chapterLimit"]) {
    for (const locale of [autopilotEn, autopilotIt]) {
      assert.equal(typeof get(locale, `${base}_one`), "string", `${base}_one`);
      assert.ok(placeholders(get(locale, `${base}_other`)).includes("count"), `${base}_other says how many`);
    }
  }
  for (const side of ["server", "browser"]) {
    for (const locale of [autopilotEn, autopilotIt]) {
      assert.equal(typeof get(locale, `autopilot.quick.handover.runningThere.${side}_one`), "string", `${side}_one`);
      assert.ok(placeholders(get(locale, `autopilot.quick.handover.runningThere.${side}_other`)).includes("count"), `${side}_other`);
    }
  }
});

test("the texts that name a version of the server say which one, so they can be kept right when it changes", () => {
  for (const locale of [autopilotEn, autopilotIt]) {
    assert.ok(placeholders(get(locale, "autopilot.errors.controlsUnsupported")).includes("version"));
    assert.ok(placeholders(get(locale, "autopilot.quick.serverTooOld")).includes("version"));
  }
});

test("the texts of the control band, the tabs, the danger zone and the mini-player are in the bundle loaded with the autopilot, in both languages, written in Italian and with the same values to fill in", () => {
  const trees = ["autopilot.band", "autopilot.tabs", "autopilot.danger", "autopilot.dock"];
  const alone = ["autopilot.actions.retry", "autopilot.actions.addChapters", "autopilot.actions.writeNewChapters", "autopilot.actions.readChapter", "autopilot.actions.intervene"];
  const keys = [...trees.flatMap((tree) => leaves(get(autopilotEn, tree), tree)), ...alone];
  assert.ok(keys.length > 45, `the band and the mini-player have their texts (saw ${keys.length})`);
  for (const key of keys) {
    for (const [language, locale] of [["en", autopilotEn], ["it", autopilotIt]]) {
      assert.equal(typeof get(locale, key), "string", `${language}: ${key}`);
      assert.ok(get(locale, key).trim(), `${language}: ${key} is not empty`);
    }
    assert.equal(get(en, key), undefined, `${key} is not repeated in the always-loaded bundle`);
    assert.deepEqual(placeholders(get(autopilotIt, key)), placeholders(get(autopilotEn, key)), key);
  }
  for (const tree of trees) assert.deepEqual(leaves(get(autopilotIt, tree), tree).sort(), leaves(get(autopilotEn, tree), tree).sort(), `${tree}: the same texts in both languages`);
  // A name and its context (“Chapters approved — Autopilot live”) is only a form to fill in, and reads the same in both languages. So do the words of the router that the Italian interface
  // keeps as they are, with the number or the level to fill in: «Fallback 1» and «Thinking: High» (the AI Router says «Imposta prima il fallback 1» and «Thinking per …»).
  const forms = new Set(["autopilot.band.named", "autopilot.band.attempt.fallback", "autopilot.band.attempt.thinking"]);
  const same = keys.filter((key) => !forms.has(key) && get(autopilotIt, key) === get(autopilotEn, key) && get(autopilotEn, key).length > 12);
  assert.deepEqual(same, [], "texts copied from English");
});

test("the band speaks of steps, chapters and the author in the words of the site, in each language", () => {
  const it_ = autopilotIt.autopilot;
  assert.equal(it_.band.now, "Ora");
  assert.equal(it_.actions.retry, "Riprova");
  assert.equal(it_.actions.addChapters, "Aggiungi capitoli");
  assert.deepEqual([it_.tabs.overview, it_.tabs.timeline, it_.tabs.plan, it_.tabs.rules], ["Panoramica", "Cronologia", "Piano", "Regole"]);
  assert.match(it_.band.cycle.label, /Passi del capitolo/);
  assert.equal(it_.band.where.chapterScene, "Capitolo {{chapter}} · scena {{scene}}");
  assert.equal(autopilotEn.autopilot.actions.addChapters, "Add chapters");
  assert.equal(autopilotEn.autopilot.actions.retry, "Retry");
});

test("the counts of the band have a form for one and for many, in both languages", () => {
  for (const base of ["autopilot.band.usage.calls"]) {
    for (const locale of [autopilotEn, autopilotIt]) {
      assert.equal(typeof get(locale, `${base}_one`), "string", `${base}_one`);
      assert.ok(placeholders(get(locale, `${base}_other`)).includes("count"), `${base}_other says how many`);
    }
  }
});

test("the texts of the timeline are in the bundle loaded with the autopilot, in both languages, written in Italian and with the same values to fill in", () => {
  const keys = leaves(get(autopilotEn, "autopilot.timeline"), "autopilot.timeline");
  assert.ok(keys.length >= 30, `the timeline has its texts (saw ${keys.length})`);
  for (const key of keys) {
    for (const [language, locale] of [["en", autopilotEn], ["it", autopilotIt]]) {
      assert.equal(typeof get(locale, key), "string", `${language}: ${key}`);
      assert.ok(get(locale, key).trim(), `${language}: ${key} is not empty`);
    }
    assert.equal(get(en, key), undefined, `${key} is not repeated in the always-loaded bundle`);
    assert.deepEqual(placeholders(get(autopilotIt, key)), placeholders(get(autopilotEn, key)), key);
  }
  assert.deepEqual(leaves(get(autopilotIt, "autopilot.timeline"), "autopilot.timeline").sort(), keys.sort(), "the same texts in both languages");
  const same = keys.filter((key) => get(autopilotIt, key) === get(autopilotEn, key) && get(autopilotEn, key).length > 12);
  assert.deepEqual(same, [], "texts copied from English");
  for (const key of ["autopilot.dock.pageLists", "autopilot.dock.pageListsAll"]) {
    assert.ok(get(autopilotEn, key) && get(autopilotIt, key), key);
    assert.notEqual(get(autopilotIt, key), get(autopilotEn, key), `${key} is written in Italian`);
  }
});

test("the timeline speaks of steps, chapters and rounds in the words of the site, in each language", () => {
  const it_ = autopilotIt.autopilot.timeline;
  const en_ = autopilotEn.autopilot.timeline;
  assert.deepEqual(["all", "problems", "director", "readers", "writing"].map((key) => it_.filter[key]), ["Tutto", "Errori e avvisi", "Direttore", "Lettori", "Scrittura"]);
  assert.deepEqual(["all", "problems", "director", "readers", "writing"].map((key) => en_.filter[key]), ["All", "Errors and warnings", "Director", "Readers", "Writing"]);
  assert.equal(it_.group.chapter, "Capitolo {{chapter}} · giro {{round}}");
  assert.equal(en_.group.chapter, "Chapter {{chapter}} · round {{round}}");
  assert.equal(it_.hide, "Nascondi fino a ora");
  assert.equal(en_.hide, "Hide until now");
  assert.match(it_.more, /Mostra/);
  assert.ok(placeholders(it_.more).includes("count") && placeholders(en_.more).includes("count"));
});

test("every text of the timeline that names a count has a form for one and for many, in both languages", () => {
  for (const base of ["autopilot.timeline.hidden", "autopilot.timeline.group.steps", "autopilot.timeline.group.failed", "autopilot.timeline.row.attempts", "autopilot.timeline.row.warnings"]) {
    for (const locale of [autopilotEn, autopilotIt]) {
      assert.equal(typeof get(locale, `${base}_one`), "string", `${base}_one`);
      assert.ok(placeholders(get(locale, `${base}_other`)).includes("count"), `${base}_other says how many`);
    }
  }
});

test("the texts of the result of a book and of the error panel are in the bundle loaded with the autopilot, in both languages, written in Italian and with the same values to fill in", () => {
  for (const [base, least] of [["autopilot.result", 45], ["autopilot.failure", 55]]) {
    const keys = leaves(get(autopilotEn, base), base);
    assert.ok(keys.length >= least, `${base} has its texts (saw ${keys.length})`);
    for (const key of keys) {
      for (const [language, locale] of [["en", autopilotEn], ["it", autopilotIt]]) {
        assert.equal(typeof get(locale, key), "string", `${language}: ${key}`);
        assert.ok(get(locale, key).trim(), `${language}: ${key} is not empty`);
      }
      assert.equal(get(en, key), undefined, `${key} is not repeated in the always-loaded bundle`);
      assert.deepEqual(placeholders(get(autopilotIt, key)), placeholders(get(autopilotEn, key)), key);
    }
    assert.deepEqual(leaves(get(autopilotIt, base), base).sort(), keys.sort(), `the same texts of ${base} in both languages`);
    const same = keys.filter((key) => get(autopilotIt, key) === get(autopilotEn, key) && get(autopilotEn, key).length > 12);
    assert.deepEqual(same, [], `texts of ${base} copied from English`);
  }
});

test("every kind of error the engine tells has a title, an explanation and a short word, in both languages, and the Italian titles are the ones of the design", () => {
  const kinds = ["network", "auth", "rate_limit", "timeout", "truncated", "refused", "conflict", "budget", "limit", "profile", "config", "provider", "unknown"];
  for (const locale of [autopilotEn, autopilotIt]) {
    assert.deepEqual(Object.keys(get(locale, "autopilot.failure.kind")).sort(), [...kinds].sort());
    for (const kind of kinds) for (const part of ["title", "explain", "short"]) assert.ok(get(locale, `autopilot.failure.kind.${kind}.${part}`)?.trim(), `${kind}.${part}`);
  }
  assert.deepEqual(kinds.map((kind) => get(autopilotIt, `autopilot.failure.kind.${kind}.title`)), [
    "Problema di connessione", "Accesso rifiutato dal provider", "Troppe richieste", "Risposta troppo lenta", "Risposta troncata dal limite di output", "Il provider ha rifiutato la richiesta",
    "Il libro è cambiato altrove", "Budget raggiunto", "Limite raggiunto", "Un file del profilo ha problemi", "Configurazione dell'AI da correggere", "Errore del provider", "Errore",
  ]);
  // A title says what happened; the explanation says what it means and what to do, and is a sentence of its own.
  for (const kind of kinds) assert.notEqual(get(autopilotEn, `autopilot.failure.kind.${kind}.title`), get(autopilotEn, `autopilot.failure.kind.${kind}.explain`));
});

test("every text of the result and of the error panel that names a count has a form for one and for many, in both languages", () => {
  for (const base of ["autopilot.result.scores.showAll", "autopilot.result.read.why.rounds", "autopilot.result.read.why.both", "autopilot.failure.repeats", "autopilot.timeline.round.accepted", "autopilot.timeline.round.rejected"]) {
    for (const locale of [autopilotEn, autopilotIt]) {
      assert.equal(typeof get(locale, `${base}_one`), "string", `${base}_one`);
      assert.ok(placeholders(get(locale, `${base}_other`)).includes("count"), `${base}_other says how many`);
    }
  }
});

test("the result speaks of the verdict, the figures and the next steps in the words of the site, in each language", () => {
  const it_ = autopilotIt.autopilot.result;
  const en_ = autopilotEn.autopilot.result;
  assert.deepEqual([it_.verdict.approve, it_.verdict.revise, it_.verdict.rewrite], ["Approvato", "Da rivedere", "Da riscrivere"]);
  assert.deepEqual([en_.verdict.approve, en_.verdict.revise], ["Approved", "Needs revision"]);
  assert.deepEqual([it_.actions.add, it_.actions.read, it_.actions.export, it_.actions.ask], ["Aggiungi capitoli", "Leggi il libro", "Esporta", "Chiedi al direttore"]);
  assert.deepEqual([en_.actions.add, en_.actions.read, en_.actions.export, en_.actions.ask], ["Add chapters", "Read the book", "Export", "Ask the director"]);
  assert.equal(it_.numbers.time, "Tempo di lavoro");
  assert.equal(it_.scores.round, "Giro {{number}}");
  assert.equal(en_.scores.round, "Round {{number}}");
});

test("the error panel and the live regions around it use the words of the site, in each language", () => {
  const it_ = autopilotIt.autopilot.failure;
  const en_ = autopilotEn.autopilot.failure;
  assert.equal(en_.actions.retry, "Retry now");
  assert.equal(it_.actions.retry, "Riprova ora");
  assert.equal(it_.actions.integrations, "Apri le integrazioni AI");
  assert.equal(en_.actions.integrations, "Open AI Integrations");
  assert.equal(it_.countdown.in, "Nuovo tentativo tra {{time}}");
  assert.equal(en_.countdown.in, "Trying again in {{time}}");
  // The announcements are sentences of their own: they say it once, when it starts and when it ends.
  assert.ok(placeholders(it_.countdown.announceStart).includes("time") && placeholders(en_.countdown.announceStart).includes("time"));
  assert.ok(!placeholders(en_.countdown.announceNow).length);
});
