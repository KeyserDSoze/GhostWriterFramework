import type { EstimateCallKind, EstimateCapability } from "./estimate.js";

/** The words of the estimate in the language of the book: Italian for an Italian book, English for every other. */
const CAPABILITY_LABEL: Record<"en" | "it", Record<EstimateCapability, string>> = {
  en: { autopilot: "Autopilot", director: "Director", "reader-evaluation": "Reader evaluation", "reader-evaluation-summary": "Reader evaluation summary", review: "Review", "simple-tasks": "Simple tasks" },
  it: { autopilot: "Autopilot", director: "Direttore", "reader-evaluation": "Valutazione lettore", "reader-evaluation-summary": "Sintesi valutazioni lettori", review: "Revisione", "simple-tasks": "Task semplici" },
};

const STEP_LABEL: Record<"en" | "it", Record<EstimateCallKind, string>> = {
  en: {
    "design-pitches": "alternative pitches",
    "design-pitch-reader": "reader's reaction to the pitches",
    "design-pitch-review": "director's judgement of the pitches",
    concept: "concept",
    "summarize-imported": "summary of a chapter the author wrote",
    plan: "chapter plan",
    "plan-reader": "reader's reaction to the plan",
    "design-chapter-review": "review of the chapters of the design",
    "design-coherence": "analysis of the structure of the design",
    "plan-review": "review of the plan",
    scenes: "plan of the scenes",
    write: "writing a scene",
    "scene-summary": "summary of a scene",
    reader: "reader's evaluation of a chapter",
    "readers-summary": "summary of the readers' evaluations",
    specialists: "specialists' review",
    "director-review": "director's review of a chapter",
    repair: "repair of a scene",
    consolidate: "closing of a chapter",
    final: "director's final review of the book",
  },
  it: {
    "design-pitches": "pitch alternativi",
    "design-pitch-reader": "reazione di un lettore ai pitch",
    "design-pitch-review": "giudizio del direttore sui pitch",
    concept: "concept",
    "summarize-imported": "riassunto di un capitolo dell'autore",
    plan: "piano dei capitoli",
    "plan-reader": "reazione di un lettore al piano",
    "design-chapter-review": "revisione dei capitoli del progetto",
    "design-coherence": "analisi della struttura del progetto",
    "plan-review": "revisione del piano",
    scenes: "piano delle scene",
    write: "scrittura di una scena",
    "scene-summary": "riassunto di una scena",
    reader: "valutazione di un lettore su un capitolo",
    "readers-summary": "sintesi delle valutazioni dei lettori",
    specialists: "revisione degli specialisti",
    "director-review": "revisione di un capitolo del direttore",
    repair: "correzione di una scena",
    consolidate: "chiusura di un capitolo",
    final: "giudizio finale del direttore sul libro",
  },
};

/** A whole number with the separator of the language between thousands: `8,192` in English, `8.192` in Italian. */
export function formatCount(value: number, italian: boolean): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, italian ? "." : ",");
}

/** A number of tokens a word costs, as it is written: `2.4` in English, `2,4` in Italian. */
function formatFactor(value: number, italian: boolean): string {
  const text = String(Math.round(value * 100) / 100);
  return italian ? text.replace(".", ",") : text;
}

/** Everything the estimate says in words. `italian` picks the language; no text is built anywhere else. */
export function estimateTexts(italian: boolean) {
  const set = italian ? "it" : "en";
  const count = (value: number) => formatCount(value, italian);
  const capability = (id: EstimateCapability) => CAPABILITY_LABEL[set][id];
  const step = (kind: EstimateCallKind) => STEP_LABEL[set][kind];
  return {
    capability,
    noModel: (id: EstimateCapability) => (italian
      ? `Nessun modello è configurato per «${capability(id)}»: l'autopilot si fermerebbe al primo passo che lo richiede.`
      : `No model is configured for «${capability(id)}»: the autopilot would stop at the first step that needs it.`),
    smallWindow: (id: EstimateCapability, model: string, window: number, budget: number, prompt: number, kind: EstimateCallKind, fits: boolean) => (italian
      ? `«${capability(id)}»: la finestra di ${model} (${count(window)} token) lascia ${count(budget)} token a un prompt; il più grande, nel passo «${step(kind)}», è di circa ${count(prompt)} token${fits ? ": ci sta, ma con poco margine" : ": non ci sta"}.`
      : `«${capability(id)}»: the window of ${model} (${count(window)} tokens) leaves ${count(budget)} tokens for a prompt; the largest one, in the step «${step(kind)}», is about ${count(prompt)} tokens${fits ? ": it fits, with little room to spare" : ": it does not fit"}.`),
    smallOutput: (id: EstimateCapability, model: string, limit: number, reply: number, kind: EstimateCallKind) => (italian
      ? `«${capability(id)}»: ${model} non può rispondere con più di ${count(limit)} token, e la risposta tipica del passo «${step(kind)}» è di circa ${count(reply)}: verrebbe tagliata.`
      : `«${capability(id)}»: ${model} cannot answer with more than ${count(limit)} tokens, and the typical reply of the step «${step(kind)}» is about ${count(reply)}: it would be cut.`),
    noPrice: (id: EstimateCapability, model: string) => (italian
      ? `«${capability(id)}»: ${model} non ha un prezzo, quindi il costo non è noto.`
      : `«${capability(id)}»: ${model} has no price, so the cost is not known.`),
    noSpeed: (id: EstimateCapability, model: string) => (italian
      ? `«${capability(id)}»: la velocità di ${model} non è nota, quindi il tempo non è stimato.`
      : `«${capability(id)}»: the speed of ${model} is not known, so the time is not estimated.`),
    reasoningModel: (id: EstimateCapability, model: string) => (italian
      ? `«${capability(id)}»: ${model} ragiona prima di rispondere e spende token di ragionamento che non sono contati qui.`
      : `«${capability(id)}»: ${model} reasons before it answers and spends reasoning tokens that are not counted here.`),
    /** The assumptions, one sentence each, in the order of the pipeline. */
    assumptions: (facts: AssumptionFacts): string[] => {
      const lines: string[] = [];
      const factor = formatFactor(facts.tokensPerWord, italian);
      const written = facts.written > 0;
      if (facts.design) {
        lines.push(italian
          ? `Il progetto copre ${count(facts.chapters)} capitoli, ${count(facts.design.batch)} per chiamata, senza prosa: il concept, il progetto di ogni capitolo e il registro dei segreti. Nessuna scena è scritta e il libro non è giudicato.`
          : `The design covers ${count(facts.chapters)} chapters, ${count(facts.design.batch)} a call, with no prose: the concept, the design of every chapter and the ledger of the secrets. No scene is written and the book is not judged.`);
        lines.push(italian
          ? `Il caso migliore approva il progetto alla prima revisione; il peggiore usa tutte le ${count(facts.design.rounds)} revisioni, riprogettando ogni volta tutti i capitoli. ${facts.planReaders > 0 ? `${count(facts.planReaders)} lettori simulati lo leggono prima ${facts.design.readerRounds === 1 ? "della prima revisione" : `delle prime ${count(facts.design.readerRounds)} revisioni`}.` : "Nessun lettore simulato lo legge."}`
          : `The best case approves the design at its first review; the worst case uses all its ${count(facts.design.rounds)} reviews, designing every chapter again each time. ${facts.planReaders > 0 ? `${count(facts.planReaders)} simulated readers read it before ${facts.design.readerRounds === 1 ? "the first review" : `the first ${count(facts.design.readerRounds)} reviews`}.` : "No simulated reader reads it."}`);
      }
      const flow = facts.design?.workflow;
      if (flow && (flow.rubric || flow.chapterReview || flow.coherence || flow.alternatives > 0)) {
        const parts = italian
          ? [
            flow.alternatives > 0 ? `propone ${count(flow.alternatives)} pitch alternativi giudicati dal direttore${facts.planReaders > 0 ? " e dai lettori" : ""}` : "",
            flow.chapterReview ? "rivede ogni capitolo insieme a quelli accanto, quattro per chiamata" : "",
            flow.coherence ? "analizza l'intera struttura per contraddizioni e buchi di trama" : "",
            flow.rubric ? "chiede al direttore e ai lettori i dodici criteri della valutazione" : "",
          ]
          : [
            flow.alternatives > 0 ? `proposes ${count(flow.alternatives)} alternative pitches judged by the director${facts.planReaders > 0 ? " and the readers" : ""}` : "",
            flow.chapterReview ? "reviews every chapter with the chapters beside it, four a call" : "",
            flow.coherence ? "analyses the whole structure for contradictions and plot holes" : "",
            flow.rubric ? "asks the director and the readers for the twelve criteria of the rubric" : "",
          ];
        const said = parts.filter(Boolean);
        const joined = said.length > 1 ? `${said.slice(0, -1).join(", ")}${italian ? " e " : " and "}${said[said.length - 1]}` : said[0];
        lines.push(italian
          ? `Il progetto ${joined}. Ogni revisione riprogettata fa rivedere di nuovo i capitoli che cambiano e rianalizzare la struttura: il caso peggiore le ripete tutte.`
          : `The design also ${joined}. Each round that designs again has the chapters that change reviewed again and the structure analysed again: the worst case repeats them all.`);
      }
      if (!facts.design) lines.push(italian
        ? `Il libro ha ${count(facts.chapters)} capitoli di ${count(facts.scenes)} scene di circa ${count(facts.wordsPerScene)} parole${written ? `; ${count(facts.written)} sono già scritti e restano ${count(facts.toWrite)} da scrivere` : ""} (${count(facts.words)} parole da scrivere). Un capitolo scritto a metà conta per intero.`
        : `The book has ${count(facts.chapters)} chapters of ${count(facts.scenes)} scenes of about ${count(facts.wordsPerScene)} words${written ? `; ${count(facts.written)} are already written and ${count(facts.toWrite)} are left` : ""} (${count(facts.words)} words to write). A chapter written halfway counts as a whole one.`);
      if (facts.design) {
        // Said above, for a design.
      } else if (facts.pinned) {
        lines.push(italian
          ? `I giri di revisione (${facts.rounds}), le scene corrette per capitolo (${facts.repairs}) e le revisioni del piano (${facts.revisions}) sono quelli dati: il numero di chiamate è uno solo.`
          : `The rounds of review (${facts.rounds}), the scenes repaired in a chapter (${facts.repairs}) and the revisions of the plan (${facts.revisions}) are the ones given: the number of calls is a single one.`);
      } else {
        lines.push(italian
          ? `Le chiamate sono contate dalla pipeline passo per passo. Il caso migliore approva ogni capitolo alla prima revisione e il piano al primo sguardo; il peggiore dà a ogni capitolo ${count(facts.maxRounds)} giri di revisione con ogni scena corretta e fa rivedere il piano due volte. Una corsa vera sta in mezzo.`
          : `The calls are counted from the pipeline, step by step. The best case approves every chapter at its first review and the plan at its first look; the worst case gives every chapter ${count(facts.maxRounds)} rounds of review with every scene repaired and has the plan revised twice. A real run falls in between.`);
      }
      if (!facts.design) lines.push(italian
        ? `${facts.readers > 0 ? `${count(facts.readers)} lettori simulati leggono ogni capitolo` : "Nessun lettore simulato legge i capitoli"}${facts.planReaders > 0 ? `, ${count(facts.planReaders)} leggono il piano` : ""}${facts.specialists ? "; gli specialisti rivedono ogni capitolo" : ""}. Il gruppo di lettori è di ${count(facts.panel)}.`
        : `${facts.readers > 0 ? `${count(facts.readers)} simulated readers read every chapter` : "No simulated reader reads the chapters"}${facts.planReaders > 0 ? `, ${count(facts.planReaders)} read the plan` : ""}${facts.specialists ? "; the specialists review every chapter" : ""}. The panel of readers has ${count(facts.panel)}.`);
      lines.push(italian
        ? `I prompt sono contati come li conta il router del motore (quattro caratteri per token); il testo del libro a ${formatFactor(facts.inputPerWord, true)} token a parola e le risposte a ${factor} token a parola (il fattore del motore per la lingua, generoso per l'inglese e l'italiano): le risposte e il costo sono un'ipotesi prudente.`
        : `Prompts are counted the way the engine's router counts them (four characters a token); the text of the book at ${formatFactor(facts.inputPerWord, false)} tokens a word and the replies at ${factor} tokens a word (the engine's own factor for the language, generous for English and Italian): replies and cost are a prudent guess.`);
      lines.push(italian
        ? "I file del libro e le risposte hanno una dimensione tipica (ESTIMATE_TYPICAL): passa in «context» quello che hai misurato per sostituirla."
        : "The files of the book and the replies are given a typical size (ESTIMATE_TYPICAL): pass what you have measured in \"context\" to replace it.");
      lines.push(italian
        ? "Il tempo è fatto dei token che i modelli scrivono, alla velocità misurata o dichiarata di ciascun modello: la lettura del prompt, la rete e i nuovi tentativi non sono contati."
        : "The time is the tokens the models write, at the speed measured or declared for each model: reading the prompt, the network and the retries are not counted.");
      lines.push(italian
        ? "Un modello che ragiona spende token di ragionamento che qui non sono contati, né in token né in denaro."
        : "A model that reasons spends reasoning tokens that are not counted here, neither in tokens nor in money.");
      if (facts.cached) {
        const measured = facts.cacheMeasured;
        const share = measured ? (measured.min === measured.max ? `${measured.min}%` : `${measured.min}-${measured.max}%`) : "";
        lines.push(measured
          ? (italian
            ? `Il caso migliore conta come in cache la parte dell'input che il provider ha servito dalla cache nelle chiamate che hai già fatto (${share}, misurata) al prezzo della cache; il peggiore non conta nessuna cache.`
            : `The best case counts the part of the input that the provider served from its cache in the calls you already made (${share}, measured) at the cached price; the worst case counts no cache.`)
          : (italian
            ? "Il caso migliore conta l'inizio fisso di ogni richiesta (le istruzioni e le funzioni, se arriva ai 1.024 token che i provider mettono in cache) al prezzo della cache; il peggiore non conta nessuna cache."
            : "The best case counts the fixed start of every request (the instructions and the functions, when it reaches the 1,024 tokens that providers cache) at the cached price; the worst case counts no cache."));
      }
      if (facts.outlineWords > 0) {
        lines.push(italian
          ? `La Sinossi pesa ${count(facts.outlineWords)} parole.`
          : `The synopsis weighs ${count(facts.outlineWords)} words.`);
      }
      lines.push(italian
        ? "Le pause, i budget e le opzioni che non cambiano quello che si chiede ai modelli (pausa dopo il piano o dopo ogni capitolo, capitoli per corsa, riempimento della Sinossi) non cambiano i numeri."
        : "The pauses, the budgets and the options that do not change what is asked of the models (pause after the plan or after each chapter, chapters per run, filling the synopsis) do not change the numbers.");
      return lines;
    },
  };
}

/** What the assumptions say of the book, so that the words are built in one place. */
export interface AssumptionFacts {
  /** A design run: the chapters of a call, its reviews at most and the reviews the readers read before, and what it does besides the plain design (`DesignWorkflow`). */
  design?: { batch: number; rounds: number; readerRounds: number; workflow?: { rubric: boolean; chapterReview: boolean; coherence: boolean; alternatives: number } };
  chapters: number;
  written: number;
  toWrite: number;
  scenes: number;
  wordsPerScene: number;
  words: number;
  pinned: boolean;
  /** As text, for a book whose rounds, repairs and revisions were given. */
  rounds: string;
  repairs: string;
  revisions: string;
  maxRounds: number;
  readers: number;
  planReaders: number;
  panel: number;
  specialists: boolean;
  tokensPerWord: number;
  inputPerWord: number;
  cached: boolean;
  /** The share of the input that the providers served from their caches in the calls the host made, when the best case counts on it (see `EstimateModel.cacheHitRate`): in per cent, the least and the most of the models asked. */
  cacheMeasured?: { min: number; max: number };
  outlineWords: number;
}
