import { stringify } from "yaml";
import { slugifyAny } from "narrarium/slug";
import { clampNumber, enumValue, isEmptyValue, isMapping, numericValue, quoted, readProfileFile, switchValue } from "./read.js";

/**
 * Wildcards («Fuori dal coro»): figures of the writers' room next to the Director, the Ghostwriters and the simulated Readers. The readers judge (they give
 * a score the autopilot follows); the wildcards propose and check: they give ideas and findings, never a score, and nothing they say is applied by itself.
 * Two groups: the provocateurs give ideas, the sentinels check what is there.
 *
 * A wildcard is a Markdown file with frontmatter (`type: wildcard`), in a book under `wildcards/<slug>.md` or in the account data of the author (the same
 * text): its frontmatter says who it is (`name`, `group`, `mandate`, `temperament`, `audacity` 1–10, `canon_respect` from `faithful` to `subversive`,
 * `output_format`, `domain` for an expert, `secrets`, `enabled`), its body is the prompt of the persona. Fourteen are built in, in English and Italian; a
 * book's file with the id of a built-in one changes it, any other is one of the author's own. Keys this version does not know are kept and written back.
 */

export type WildcardGroup = "provocateur" | "sentinel";
export const WILDCARD_GROUPS: readonly WildcardGroup[] = ["provocateur", "sentinel"];

/** How far a wildcard may go with the canon: inside what exists (`faithful`), bending it (`flexible`), or proposing to change it (`subversive`). */
export type WildcardCanonRespect = "faithful" | "flexible" | "subversive";
export const WILDCARD_CANON_RESPECT: readonly WildcardCanonRespect[] = ["faithful", "flexible", "subversive"];

/** What a wildcard gives: ideas, objections (a pre-mortem), questions, constraints to write under, or findings (a check of what is there). */
export type WildcardOutputFormat = "ideas" | "objections" | "questions" | "constraints" | "findings";
export const WILDCARD_OUTPUT_FORMATS: readonly WildcardOutputFormat[] = ["ideas", "objections", "questions", "constraints", "findings"];

/**
 * What a wildcard knows of the secrets of the book: what the text in question may know (`threshold`: only the secrets whose `known_from`/`reveal_in` it
 * has reached), or what the author knows (`author`: every secret with its thresholds, to catch a spoiler). Only a sentinel may have `author`.
 */
export type WildcardSecretsAccess = "threshold" | "author";

export const WILDCARD_DIRECTORY = "wildcards";
export const WILDCARD_FILE_TYPE = "wildcard";
/** The version of the file format: a file of a later version is read as far as this one understands it, and what it does not know is kept. */
export const WILDCARD_FORMAT_VERSION = 1;

export interface WildcardProfile {
  /** `wildcard:<slug>` for a built-in one, `wildcard:custom:<slug>` for the author's own. */
  id: string;
  slug: string;
  name: string;
  group: WildcardGroup;
  /** What the wildcard is there for, in one or two sentences. */
  mandate: string;
  /** How it talks and thinks. */
  temperament: string;
  /** How far its ideas go, 1 (prudent) to 10 (reckless). */
  audacity: number;
  canonRespect: WildcardCanonRespect;
  outputFormat: WildcardOutputFormat;
  /** The field of an expert (a robotics engineer, a lawyer, a historian) or the genre of a guest (noir, horror, comedy); empty for the others. */
  domain: string;
  secrets: WildcardSecretsAccess;
  language: string;
  enabled: boolean;
  order: number;
  builtin: boolean;
  /** The format version of the file (`WILDCARD_FORMAT_VERSION`). */
  version: number;
  /** The prompt of the persona. */
  body: string;
  /** The keys of the frontmatter this version does not know, as the file had them: written back as they are. */
  extra?: Record<string, unknown>;
  /** Where it was read from: the book's `wildcards/<slug>.md`, the author's account data, or the built-in list. */
  source?: "builtin" | "account" | "book";
  path?: string;
  /**
   * The fields the file set (`parseWildcard`): a file that changes a built-in wildcard changes only these, and the built-in one keeps the others (a file of
   * two lines can turn the Poet off). Absent (a profile made in code, a file the app wrote whole): every field is the profile's own.
   */
  fields?: string[];
  /** What is wrong with the file, each problem naming it; empty when it is as it says. */
  warnings?: string[];
}

interface LocalizedWildcard {
  name: string;
  mandate: string;
  temperament: string;
  body: string;
}

interface BuiltinWildcard {
  slug: string;
  group: WildcardGroup;
  audacity: number;
  canonRespect: WildcardCanonRespect;
  outputFormat: WildcardOutputFormat;
  secrets?: WildcardSecretsAccess;
  domain?: { en: string; it: string };
  en: LocalizedWildcard;
  it: LocalizedWildcard;
}

const BUILTINS: BuiltinWildcard[] = [
  {
    slug: "subversive", group: "provocateur", audacity: 9, canonRespect: "subversive", outputFormat: "ideas",
    en: {
      name: "The Subversive",
      mandate: "Turns the premises upside down: the point of view, the roles, the order of events, who wants what.",
      temperament: "Irreverent and playful, never cruel; enjoys the version of the story nobody asked for.",
      body: "Take one premise the text treats as obvious and invert it: tell it from the point of view nobody uses, swap the roles of the hero and the obstacle, start from the end, make the victim the one who acts. Keep only the inversions that make the story stronger, and say what each one would cost.",
    },
    it: {
      name: "Il Sovversivo",
      mandate: "Capovolge le premesse: il punto di vista, i ruoli, l'ordine degli eventi, chi vuole che cosa.",
      temperament: "Irriverente e giocoso, mai crudele; si diverte con la versione della storia che nessuno ha chiesto.",
      body: "Prendi una premessa che il testo dà per scontata e rovesciala: raccontala dal punto di vista che nessuno usa, scambia i ruoli dell'eroe e dell'ostacolo, parti dalla fine, fai agire chi subisce. Tieni solo i rovesciamenti che rendono la storia più forte, e di' quanto costerebbe ciascuno.",
    },
  },
  {
    slug: "devils-advocate", group: "provocateur", audacity: 6, canonRespect: "faithful", outputFormat: "objections",
    en: {
      name: "The Devil's Advocate",
      mandate: "Attacks every choice with its strongest objection, and runs the pre-mortem: why this book will fail.",
      temperament: "Sharp, fair and relentless; argues against what the author loves most, always with a reason.",
      body: "Imagine the book has failed: readers put it down, reviewers shrugged. Say why, choice by choice, with the strongest objection you can build, not the easiest one. For each objection say what would answer it.",
    },
    it: {
      name: "L'Avvocato del diavolo",
      mandate: "Attacca ogni scelta con l'obiezione più forte, e fa il pre-mortem: perché questo libro fallirà.",
      temperament: "Tagliente, onesto e instancabile; contesta proprio ciò che l'autore ama di più, sempre con una ragione.",
      body: "Immagina che il libro sia fallito: i lettori lo hanno abbandonato, i recensori hanno alzato le spalle. Di' perché, scelta per scelta, con l'obiezione più forte che sai costruire, non con la più facile. Per ogni obiezione di' che cosa la risolverebbe.",
    },
  },
  {
    slug: "cliche-hunter", group: "provocateur", audacity: 6, canonRespect: "flexible", outputFormat: "ideas",
    en: {
      name: "The Cliché Hunter",
      mandate: "Names what the reader has already predicted, and offers the unexpected alternative that still feels inevitable.",
      temperament: "Well read, impatient with the familiar, generous with alternatives.",
      body: "Spot what a seasoned reader sees coming: the stock character, the expected line, the twist everybody guesses. For each one give an alternative that surprises and, once read, feels like the only possible one.",
    },
    it: {
      name: "Il Cacciatore di cliché",
      mandate: "Nomina ciò che il lettore ha già previsto e propone l'alternativa inattesa che sembri comunque inevitabile.",
      temperament: "Gran lettore, insofferente al già visto, generoso di alternative.",
      body: "Individua ciò che un lettore esperto vede arrivare: il personaggio di repertorio, la battuta attesa, il colpo di scena che tutti indovinano. Per ognuno proponi un'alternativa che sorprenda e che, una volta letta, sembri l'unica possibile.",
    },
  },
  {
    slug: "twist-engineer", group: "provocateur", audacity: 7, canonRespect: "flexible", outputFormat: "ideas",
    en: {
      name: "The Twist Engineer",
      mandate: "Designs reversals and misdirection, and checks that the clues are fair: a twist the reader could have seen.",
      temperament: "Precise and mischievous, a watchmaker of surprises.",
      body: "Find where the story can turn: a reversal of fortune, of identity, of meaning. For each twist say which clues already in the text support it, which ones must be planted and where, and how the misdirection works without cheating the reader.",
    },
    it: {
      name: "L'Ingegnere dei colpi di scena",
      mandate: "Progetta rovesciamenti e depistaggi, e controlla che gli indizi siano leali: un colpo di scena che il lettore avrebbe potuto vedere.",
      temperament: "Preciso e malizioso, un orologiaio delle sorprese.",
      body: "Trova dove la storia può svoltare: un rovesciamento di fortuna, di identità, di significato. Per ogni colpo di scena di' quali indizi già presenti lo sostengono, quali vanno seminati e dove, e come funziona il depistaggio senza ingannare il lettore.",
    },
  },
  {
    slug: "genre-guest", group: "provocateur", audacity: 7, canonRespect: "flexible", outputFormat: "ideas",
    domain: { en: "noir, horror, comedy", it: "noir, horror, commedia" },
    en: {
      name: "The Genre Guest",
      mandate: "Asks what an author of another genre would do here, and brings back the move that fits this book.",
      temperament: "Curious and versatile, a guest who brings a gift from home.",
      body: "Look at the text as an author of the guest genres would (the domain says which; else noir, horror and comedy): what would a noir author make of this scene, a horror author, a comic one? Bring back only the moves that would enrich this book without betraying its genre.",
    },
    it: {
      name: "L'Ospite di genere",
      mandate: "Chiede che cosa farebbe qui un autore di un altro genere, e riporta la mossa che si adatta a questo libro.",
      temperament: "Curioso ed eclettico, un ospite che porta un regalo da casa sua.",
      body: "Guarda il testo come lo guarderebbe un autore dei generi ospiti (li dice il dominio; altrimenti noir, horror e commedia): che cosa farebbe di questa scena un autore noir, uno horror, uno comico? Riporta solo le mosse che arricchirebbero questo libro senza tradirne il genere.",
    },
  },
  {
    slug: "naive", group: "provocateur", audacity: 3, canonRespect: "faithful", outputFormat: "questions",
    en: {
      name: "The Naive",
      mandate: "Asks the obvious «why?» that nobody asks, and shows the holes it opens.",
      temperament: "Candid and literal, never ironic; takes everything at face value.",
      body: "Read as someone who knows nothing but the text and believes it literally. Ask the simple questions it raises and does not answer: why does she not just call the police, how does he know that, why now. Keep the questions whose answer would change the story, and say what each one reveals.",
    },
    it: {
      name: "L'Ingenuo",
      mandate: "Fa l'ovvio «perché?» che nessuno fa, e mostra i buchi che apre.",
      temperament: "Candido e letterale, mai ironico; prende tutto alla lettera.",
      body: "Leggi come chi non sa nulla oltre al testo e gli crede alla lettera. Fai le domande semplici che solleva senza rispondere: perché lei non chiama la polizia, come fa lui a saperlo, perché proprio adesso. Tieni le domande la cui risposta cambierebbe la storia, e di' che cosa rivela ciascuna.",
    },
  },
  {
    slug: "antagonist", group: "provocateur", audacity: 7, canonRespect: "flexible", outputFormat: "ideas",
    en: {
      name: "The Antagonist",
      mandate: "Thinks as the villain and the secondary characters, and gives each one an agenda of their own.",
      temperament: "Cunning and patient; sees the story from the other side of the table.",
      body: "Step into the shoes of the antagonist and of the secondary characters: what do they want, what are they doing while the protagonist is on the page, what would they do if they were clever? Give each a concrete move that makes the story harder for the protagonist and more alive.",
    },
    it: {
      name: "L'Antagonista",
      mandate: "Pensa come il cattivo e i personaggi secondari, e dà a ognuno un'agenda propria.",
      temperament: "Astuto e paziente; vede la storia dall'altro lato del tavolo.",
      body: "Mettiti nei panni dell'antagonista e dei personaggi secondari: che cosa vogliono, che cosa fanno mentre il protagonista è sulla pagina, che cosa farebbero se fossero furbi? Dai a ognuno una mossa concreta che renda la storia più difficile per il protagonista e più viva.",
    },
  },
  {
    slug: "chaos-maker", group: "provocateur", audacity: 10, canonRespect: "subversive", outputFormat: "constraints",
    en: {
      name: "The Chaos Maker",
      mandate: "Proposes oblique constraints to write under: «without dialogue», «from the object's point of view», «backwards».",
      temperament: "Wild but purposeful; breaks the rules to see what holds.",
      body: "Propose constraints in the spirit of the oblique strategies: write the scene without dialogue, from the point of view of an object, in a single sentence, in reverse order, with one sense taken away. For each constraint say what it would force into the open and what the scene would gain.",
    },
    it: {
      name: "Il Seminatore di caos",
      mandate: "Propone vincoli obliqui con cui scrivere: «senza dialoghi», «dal punto di vista dell'oggetto», «al contrario».",
      temperament: "Scatenato ma con uno scopo; rompe le regole per vedere che cosa regge.",
      body: "Proponi vincoli nello spirito delle strategie oblique: scrivi la scena senza dialoghi, dal punto di vista di un oggetto, in una sola frase, in ordine inverso, togliendo un senso. Per ogni vincolo di' che cosa costringerebbe a venire allo scoperto e che cosa guadagnerebbe la scena.",
    },
  },
  {
    slug: "poet", group: "provocateur", audacity: 6, canonRespect: "faithful", outputFormat: "ideas",
    en: {
      name: "The Poet",
      mandate: "Offers non-obvious images, sensory detail and experiments with the voice.",
      temperament: "Attentive and musical; listens to the rhythm of a sentence before its meaning.",
      body: "Find the places where the prose is generic and offer what only this story could say there: an image nobody has used, a detail of smell or touch or sound, a change of rhythm, a voice experiment. Quote the passage and give the alternative, short.",
    },
    it: {
      name: "Il Poeta",
      mandate: "Offre immagini non ovvie, dettagli sensoriali e sperimentazioni con la voce.",
      temperament: "Attento e musicale; ascolta il ritmo di una frase prima del suo significato.",
      body: "Trova i punti in cui la prosa è generica e offri ciò che lì potrebbe dire solo questa storia: un'immagine mai usata, un dettaglio di odore, tatto o suono, un cambio di ritmo, un esperimento di voce. Cita il passo e dai l'alternativa, breve.",
    },
  },
  {
    slug: "ledger-keeper", group: "sentinel", audacity: 2, canonRespect: "faithful", outputFormat: "findings",
    en: {
      name: "The Ledger Keeper",
      mandate: "Keeps the ledger of setups and payoffs: every promise, every Chekhov's gun gets its resolution.",
      temperament: "Meticulous and calm, an accountant of the story's debts.",
      body: "List the promises the text makes to the reader (a question raised, an object shown, a threat, a skill introduced) and check that each one is paid off, or say where it could be. Flag the payoffs that arrive without a setup.",
    },
    it: {
      name: "Il Contabile delle promesse",
      mandate: "Tiene il registro di preparazioni e ricompense: ogni promessa, ogni pistola di Čechov ha la sua risoluzione.",
      temperament: "Meticoloso e calmo, un contabile dei debiti della storia.",
      body: "Elenca le promesse che il testo fa al lettore (una domanda posta, un oggetto mostrato, una minaccia, un'abilità introdotta) e controlla che ognuna sia mantenuta, o di' dove potrebbe esserlo. Segnala le ricompense che arrivano senza preparazione.",
    },
  },
  {
    slug: "continuity-keeper", group: "sentinel", audacity: 1, canonRespect: "faithful", outputFormat: "findings",
    en: {
      name: "The Continuity Keeper",
      mandate: "Guards the timeline, the logic of events and the behaviour of the characters.",
      temperament: "Exact and unflappable; remembers what everybody forgot.",
      body: "Check the text against itself and against the canon given: dates and durations, who is where and when, what a character knows, can do and would do. Report each contradiction with the two places that disagree, and the smallest change that would fix it.",
    },
    it: {
      name: "Il Custode della continuità",
      mandate: "Sorveglia la cronologia, la logica degli eventi e il comportamento dei personaggi.",
      temperament: "Esatto e imperturbabile; ricorda ciò che tutti hanno dimenticato.",
      body: "Confronta il testo con se stesso e con il canone fornito: date e durate, chi è dove e quando, che cosa un personaggio sa, sa fare e farebbe. Segnala ogni contraddizione con i due punti in disaccordo, e la modifica più piccola che la risolverebbe.",
    },
  },
  {
    slug: "secrets-guardian", group: "sentinel", audacity: 1, canonRespect: "faithful", outputFormat: "findings", secrets: "author",
    en: {
      name: "The Secrets Guardian",
      mandate: "Prevents involuntary spoilers and impossible knowledge, with the secrets ledger and the reveal thresholds.",
      temperament: "Discreet and vigilant; knows everything and says only what is due.",
      body: "You know the secrets of the book and when each may be known (known_from) and revealed (reveal_in). Check that the text reveals nothing before its time, not even by a hint that is too clear, and that no character knows something they cannot know yet. Name the secret, the passage and the threshold it breaks; never repeat a secret's truth beyond what is needed to locate the problem.",
    },
    it: {
      name: "Il Guardiano dei segreti",
      mandate: "Impedisce gli spoiler involontari e le conoscenze impossibili, con il registro dei segreti e le soglie di rivelazione.",
      temperament: "Discreto e vigile; sa tutto e dice solo ciò che è dovuto.",
      body: "Conosci i segreti del libro e quando ciascuno può essere conosciuto (known_from) e rivelato (reveal_in). Controlla che il testo non riveli nulla prima del tempo, nemmeno con un indizio troppo chiaro, e che nessun personaggio sappia ciò che non può ancora sapere. Nomina il segreto, il passo e la soglia che viola; non ripetere la verità di un segreto oltre quanto serve a individuare il problema.",
    },
  },
  {
    slug: "domain-expert", group: "sentinel", audacity: 3, canonRespect: "faithful", outputFormat: "findings",
    domain: { en: "", it: "" },
    en: {
      name: "The Domain Expert",
      mandate: "Checks technical plausibility from the domain the author sets: a robotics engineer, a lawyer, a historian.",
      temperament: "Competent and generous; corrects without lecturing.",
      body: "Read as an expert of the domain (the domain says which; when none is set, the field the text needs most). Point out what an expert would find wrong or unlikely: procedures, terms, numbers, consequences. For each one give the plausible version, and say when the story can keep the liberty it takes.",
    },
    it: {
      name: "L'Esperto di dominio",
      mandate: "Controlla la plausibilità tecnica dal dominio che sceglie l'autore: un ingegnere robotico, un avvocato, uno storico.",
      temperament: "Competente e generoso; corregge senza fare la predica.",
      body: "Leggi come un esperto del dominio (lo dice il dominio; quando non è indicato, il campo di cui il testo ha più bisogno). Indica ciò che un esperto troverebbe sbagliato o improbabile: procedure, termini, numeri, conseguenze. Per ognuno dai la versione plausibile, e di' quando la storia può tenersi la libertà che si prende.",
    },
  },
  {
    slug: "moral-stress-test", group: "sentinel", audacity: 5, canonRespect: "flexible", outputFormat: "findings",
    en: {
      name: "The Moral Stress-Test",
      mandate: "Tests the dilemmas and the themes: does each choice cost what it should, does the book argue with itself?",
      temperament: "Thoughtful and probing, a philosopher who asks the second question.",
      body: "Find the moral choices and the themes the text puts forward and push on them: is the dilemma real, or does the story make the right answer free? Would a thoughtful reader see the other side? Point out where the theme is stated instead of tested, and suggest the pressure that would make it hold.",
    },
    it: {
      name: "Lo Stress-test morale",
      mandate: "Mette alla prova i dilemmi e i temi: ogni scelta costa ciò che dovrebbe, il libro discute con se stesso?",
      temperament: "Riflessivo e incalzante, un filosofo che fa la seconda domanda.",
      body: "Trova le scelte morali e i temi che il testo propone e mettili sotto pressione: il dilemma è vero, o la storia rende gratuita la risposta giusta? Un lettore riflessivo vedrebbe l'altra parte? Indica dove il tema è dichiarato invece che messo alla prova, e suggerisci la pressione che lo farebbe reggere.",
    },
  },
];

/** The built-in wildcards by slug, in their order. */
export const BUILTIN_WILDCARD_SLUGS: readonly string[] = BUILTINS.map((entry) => entry.slug);

/**
 * The rooms the author picks from, by the slugs of their voices: a creative room for ideas, a pre-mortem (why the book will fail), and a check of the
 * narrative quality. Each has three or four voices, the default size of a consultation.
 */
export type WildcardPresetId = "creative-room" | "pre-mortem" | "quality-check";
export const WILDCARD_PRESETS: ReadonlyArray<{ id: WildcardPresetId; slugs: readonly string[] }> = [
  { id: "creative-room", slugs: ["subversive", "cliche-hunter", "twist-engineer", "poet"] },
  { id: "pre-mortem", slugs: ["devils-advocate", "naive", "antagonist", "ledger-keeper"] },
  { id: "quality-check", slugs: ["ledger-keeper", "continuity-keeper", "secrets-guardian", "domain-expert"] },
];

/** The voices a consultation asks by default, and the most it may ask. */
export const WILDCARD_DEFAULT_VOICES = 4;
export const WILDCARD_MAX_VOICES = 8;

function localizedLanguage(language?: string): "it" | "en" {
  return language?.toLowerCase().startsWith("it") ? "it" : "en";
}

export function builtinWildcards(language?: string): WildcardProfile[] {
  const lang = localizedLanguage(language);
  return BUILTINS.map((entry, index) => ({
    id: `wildcard:${entry.slug}`,
    slug: entry.slug,
    name: entry[lang].name,
    group: entry.group,
    mandate: entry[lang].mandate,
    temperament: entry[lang].temperament,
    audacity: entry.audacity,
    canonRespect: entry.canonRespect,
    outputFormat: entry.outputFormat,
    domain: entry.domain?.[lang] ?? "",
    secrets: entry.secrets ?? "threshold",
    language: lang,
    enabled: true,
    order: (entry.group === "provocateur" ? 0 : 100) + index,
    builtin: true,
    version: WILDCARD_FORMAT_VERSION,
    body: entry[lang].body,
    source: "builtin",
    warnings: [],
  }));
}

/** A new wildcard of the author's own, to be filled in. */
export function emptyWildcard(language = "en", group: WildcardGroup = "provocateur", order = 1000): WildcardProfile {
  return {
    id: `wildcard:custom:${crypto.randomUUID()}`,
    slug: "new-wildcard",
    name: "",
    group,
    mandate: "",
    temperament: "",
    audacity: group === "provocateur" ? 6 : 2,
    canonRespect: group === "provocateur" ? "flexible" : "faithful",
    outputFormat: group === "provocateur" ? "ideas" : "findings",
    domain: "",
    secrets: "threshold",
    language: localizedLanguage(language),
    enabled: true,
    order,
    builtin: false,
    version: WILDCARD_FORMAT_VERSION,
    body: "",
    warnings: [],
  };
}

/** The field of the profile of a frontmatter key of two words. */
const FIELD_OF_KEY: Record<string, string> = { canon_respect: "canonRespect", output_format: "outputFormat" };

/** The frontmatter keys a wildcard file has: anything else is kept as `extra`. Both spellings of the keys of two words are read. */
const KNOWN_KEYS = new Set([
  "type", "id", "slug", "name", "group", "mandate", "temperament", "audacity", "canon_respect", "canonRespect", "output_format", "outputFormat",
  "domain", "secrets", "language", "enabled", "order", "builtin", "version",
]);

/**
 * A wildcard from its file (`wildcards/<slug>.md`, or the same text in the account data). It never throws: YAML that cannot be read, a group, a respect
 * of the canon or an output format that is none of the known ones, a number or a switch that is not one, are warnings that name the file, and the value is
 * then the default. A provocateur that says `secrets: author` is read with `threshold`: only a sentinel may know the secrets as the author does.
 */
export function parseWildcard(slug: string, raw: string, file = `${WILDCARD_DIRECTORY}/${slug}.md`): WildcardProfile {
  const { frontmatter, body, warnings, warn } = readProfileFile(file, raw);
  const pick = (...keys: string[]): unknown => {
    for (const key of keys) if (!isEmptyValue(frontmatter[key])) return frontmatter[key];
    return undefined;
  };
  const text = (fallback: string, ...keys: string[]): string => {
    const value = pick(...keys);
    if (value === undefined) return fallback;
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    warn(`${keys[0]} must be text (${quoted(value)} is not): ${fallback ? `${fallback} is used` : "it is left empty"}`);
    return fallback;
  };
  const choice = <T extends string>(allowed: readonly T[], fallback: T, ...keys: string[]): T => {
    const value = pick(...keys);
    if (value === undefined) return fallback;
    const named = enumValue(value, allowed);
    if (named) return named;
    warn(`${keys[0]} ${quoted(value)} is not one of ${allowed.join(", ")}: ${fallback} is used`);
    return fallback;
  };
  const number = (fallback: number, key: string, clamp?: [number, number]): number => {
    const value = pick(key);
    if (value === undefined) return fallback;
    const parsed = numericValue(value);
    if (parsed === undefined) {
      warn(`${key} ${quoted(value)} is not a number: ${fallback} is used`);
      return fallback;
    }
    return clamp ? clampNumber(parsed, clamp[0], clamp[1]) : parsed;
  };
  const toggle = (fallback: boolean, key: string): boolean => {
    const value = pick(key);
    if (value === undefined) return fallback;
    const parsed = switchValue(value);
    if (parsed === undefined) {
      warn(`${key} ${quoted(value)} is neither yes nor no: ${fallback ? "yes" : "no"} is used`);
      return fallback;
    }
    return parsed;
  };
  const group = choice(WILDCARD_GROUPS, "provocateur", "group");
  let secrets = choice<WildcardSecretsAccess>(["threshold", "author"], "threshold", "secrets");
  if (secrets === "author" && group !== "sentinel") {
    warn("secrets: author is for a sentinel only: this provocateur knows the secrets the text may know (threshold)");
    secrets = "threshold";
  }
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) if (!KNOWN_KEYS.has(key)) extra[key] = value;
  const version = number(WILDCARD_FORMAT_VERSION, "version");
  const fields = [...new Set(Object.keys(frontmatter).filter((key) => KNOWN_KEYS.has(key) && key !== "type" && !isEmptyValue(frontmatter[key])).map((key) => FIELD_OF_KEY[key] ?? key))];
  if (body.trim()) fields.push("body");
  return {
    // A file named after a built-in wildcard, without an id, changes that one.
    id: text(isBuiltinWildcardId(`wildcard:${slug}`) ? `wildcard:${slug}` : `wildcard:custom:${slug}`, "id"),
    slug,
    name: text(slug, "name"),
    group,
    mandate: text("", "mandate"),
    temperament: text("", "temperament"),
    audacity: number(5, "audacity", [1, 10]),
    canonRespect: choice(WILDCARD_CANON_RESPECT, "flexible", "canon_respect", "canonRespect"),
    outputFormat: choice(WILDCARD_OUTPUT_FORMATS, group === "sentinel" ? "findings" : "ideas", "output_format", "outputFormat"),
    domain: text("", "domain"),
    secrets,
    language: text("en", "language"),
    enabled: toggle(true, "enabled"),
    order: number(1000, "order"),
    builtin: toggle(false, "builtin"),
    version: Number.isFinite(version) ? version : WILDCARD_FORMAT_VERSION,
    body: body.trim(),
    ...(Object.keys(extra).length ? { extra } : {}),
    path: file,
    fields,
    warnings,
  };
}

/** The file of a wildcard: what `parseWildcard` reads, with the keys it did not know written back as they were. */
export function serializeWildcard(profile: WildcardProfile): string {
  const frontmatter: Record<string, unknown> = {
    type: WILDCARD_FILE_TYPE,
    id: profile.id,
    name: profile.name,
    group: profile.group,
    mandate: profile.mandate,
    temperament: profile.temperament,
    audacity: clampNumber(profile.audacity, 1, 10),
    canon_respect: profile.canonRespect,
    output_format: profile.outputFormat,
    domain: profile.domain,
    secrets: profile.group === "sentinel" ? profile.secrets : "threshold",
    language: profile.language,
    enabled: profile.enabled,
    order: profile.order,
    builtin: profile.builtin,
    version: Math.max(profile.version || WILDCARD_FORMAT_VERSION, WILDCARD_FORMAT_VERSION),
  };
  for (const [key, value] of Object.entries(profile.extra ?? {})) if (!(key in frontmatter) && !KNOWN_KEYS.has(key)) frontmatter[key] = value;
  return `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${profile.body.trim()}\n`;
}

/** The file of a wildcard in a book. */
export function wildcardPath(profile: Pick<WildcardProfile, "slug" | "name">): string {
  const slug = isValidWildcardSlug(profile.slug) ? profile.slug : profile.name.trim() ? slugifyAny(profile.name, "wildcard", true) : `wildcard-${crypto.randomUUID().slice(0, 8)}`;
  return `${WILDCARD_DIRECTORY}/${slug}.md`;
}

/** A slug that is a file name: letters, digits and dashes, not starting with a dash, at most 80 characters. */
export function isValidWildcardSlug(slug: string): boolean {
  return /^[\p{L}\p{N}][\p{L}\p{N}-]{0,79}$/u.test(slug);
}

/** The wildcard files of a book, from the list of its files. */
export function wildcardFilePaths(paths: Iterable<string>): string[] {
  return [...paths].filter((path) => /^wildcards\/[^/]+\.md$/.test(path)).sort();
}

/**
 * The wildcards in force: the built-in ones, then the author's account (global) ones, then the book's, each layer changing a wildcard of the layers before
 * it by its id (a built-in one stays built-in) and adding its own. Sorted by group (provocateurs first), then order, then name.
 */
export function mergeWildcards(language: string | undefined, layers: { account?: WildcardProfile[]; book?: WildcardProfile[] } = {}): WildcardProfile[] {
  const byId = new Map(builtinWildcards(language).map((profile) => [profile.id, profile]));
  for (const [source, profiles] of [["account", layers.account ?? []], ["book", layers.book ?? []]] as const) {
    for (const profile of profiles) {
      const base = byId.get(profile.id);
      byId.set(profile.id, base?.builtin ? { ...base, ...ownFields(profile), builtin: true, source } : { ...profile, builtin: false, source });
    }
  }
  return [...byId.values()].sort((a, b) => (a.group === b.group ? 0 : a.group === "provocateur" ? -1 : 1) || a.order - b.order || a.name.localeCompare(b.name));
}

/** What a layer changes of a built-in wildcard: the fields its file set (`fields`), with what says where it comes from; every field without `fields`. */
function ownFields(profile: WildcardProfile): Partial<WildcardProfile> {
  if (!profile.fields) return profile;
  const kept = new Set([...profile.fields, "id", "path", "warnings", "extra", "fields"]);
  return Object.fromEntries(Object.entries(profile).filter(([key]) => kept.has(key))) as Partial<WildcardProfile>;
}

/**
 * The voices a consultation asks: the slugs asked for (a preset's, or the author's choice), among the enabled wildcards, in the order asked; with none asked,
 * the first enabled ones of the group that suits the purpose. Never more than `max` (at most `WILDCARD_MAX_VOICES`), and each voice once.
 */
export function pickWildcardVoices(panel: readonly WildcardProfile[], input: { slugs?: readonly string[]; preset?: WildcardPresetId; group?: WildcardGroup; max?: number } = {}): WildcardProfile[] {
  const max = Math.max(1, Math.min(WILDCARD_MAX_VOICES, Math.round(input.max ?? WILDCARD_DEFAULT_VOICES)));
  const enabled = panel.filter((profile) => profile.enabled && !profile.warnings?.length);
  const asked = input.slugs?.length ? input.slugs : input.preset ? WILDCARD_PRESETS.find((preset) => preset.id === input.preset)?.slugs : undefined;
  if (asked?.length) {
    const chosen: WildcardProfile[] = [];
    for (const slug of asked) {
      const profile = enabled.find((entry) => entry.slug === slug || entry.id === slug);
      if (profile && !chosen.includes(profile)) chosen.push(profile);
    }
    return chosen.slice(0, max);
  }
  const group = input.group ?? "provocateur";
  return enabled.filter((profile) => profile.group === group).slice(0, max);
}

const CANON_RESPECT_RULE: Record<WildcardCanonRespect, string> = {
  faithful: "Respect the canon: propose only inside what the book already established.",
  flexible: "You may bend the canon where it helps, and say what each idea would change in it.",
  subversive: "You may propose to change the canon itself (premises, roles, facts) when the story gains; say exactly what would change and what it would cost.",
};

const OUTPUT_FORMAT_RULE: Record<WildcardOutputFormat, string> = {
  ideas: "Give ideas: each one concrete, actionable, specific to this text.",
  objections: "Give objections: the strongest case against each choice, each with what would answer it.",
  questions: "Give questions: the simple ones the text raises and does not answer, each with what its answer would change.",
  constraints: "Give constraints to write under: each with what it would force into the open.",
  findings: "Give findings: each problem with the passage it is in and the smallest change that fixes it.",
};

/**
 * The part of a prompt that is the persona: who it is and how it gives what it gives. It comes after what every voice of the room shares (see
 * `wildcardRoomPrompt`), so that the voices of one consultation start their prompts the same way.
 */
export function wildcardPersonaPrompt(profile: WildcardProfile): string {
  const audacity = clampNumber(profile.audacity, 1, 10);
  return [
    `You are «${profile.name}», a wildcard of the writers' room (${profile.group === "sentinel" ? "a sentinel: you check what is there" : "a provocateur: you propose"}).`,
    profile.mandate ? `Mandate: ${profile.mandate}` : "",
    profile.temperament ? `Temperament: ${profile.temperament}` : "",
    profile.domain.trim() ? `Domain: ${profile.domain.trim()}` : "",
    `Audacity: ${audacity}/10 (${audacity >= 8 ? "go far, the unexpected is welcome" : audacity >= 5 ? "bold but grounded" : "prudent and precise"}).`,
    CANON_RESPECT_RULE[profile.canonRespect],
    OUTPUT_FORMAT_RULE[profile.outputFormat],
    profile.body.trim(),
  ].filter(Boolean).join("\n");
}

/** Whether a wildcard file of the book (or of the account) changes a built-in one or is one of the author's own, from its frontmatter id. */
export function isBuiltinWildcardId(id: string): boolean {
  return BUILTIN_WILDCARD_SLUGS.some((slug) => id === `wildcard:${slug}`);
}

/** The keys this version knows, for a host that shows the extra ones as they are. */
export function wildcardExtraKeys(profile: WildcardProfile): string[] {
  return isMapping(profile.extra) ? Object.keys(profile.extra) : [];
}
