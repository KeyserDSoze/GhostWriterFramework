/**
 * A long analytic synopsis of a 37-chapter novel, in Italian, in the style an author pastes into the Copilot: a title and a premise, then for every chapter
 * «Riassunto», «Eventi salienti», «Evoluzione dei personaggi», «Chiusura e colpo di scena», «Funzione narrativa» and «Collegamenti futuri», then tables that
 * cross the chapters, the revelations to protect and a closing note. Its sentences are full of «non … crea», «senza aggiungere», «non ho modificato»: what a
 * text of 60,000 characters always has, and what must never decide what the author asked.
 */

const NAMES = ["Elena", "Marco", "Livia", "Teodoro", "Nadia", "Bruno", "Irene", "Ottavio"];
const PLACES = ["al porto di Ancona", "alla villa sul colle", "all'archivio comunale", "al faro abbandonato", "alla stazione di Falconara", "al mercato del pesce", "alla cattedrale di San Ciriaco", "alla cava di pietra"];
const OBJECTS = ["il diario del nonno", "una chiave d'ottone", "la mappa delle correnti", "un registro navale", "la lettera mai spedita", "una fotografia bruciata"];

function pick<T>(items: readonly T[], index: number): T {
  return items[index % items.length];
}

/** The title of chapter `n`, as the synopsis gives it. */
export function longSynopsisTitle(n: number): string {
  const titles = ["Il ritorno", "La chiave", "Le correnti", "Il registro", "La lettera", "Il faro", "La cava", "Il mercato", "La villa", "L'archivio"];
  return `${pick(titles, n - 1)} ${n > titles.length ? `(${Math.ceil(n / titles.length)})` : ""}`.trim();
}

function chapter(n: number): string {
  const a = pick(NAMES, n);
  const b = pick(NAMES, n + 3);
  const place = pick(PLACES, n);
  const object = pick(OBJECTS, n);
  const later = Math.min(37, n + 4);
  return [
    `## Capitolo ${n} — ${longSynopsisTitle(n)}`,
    "",
    `**Riassunto.** ${a} arriva ${place} con ${object} e capisce che qualcuno lo ha cercato prima di lei. ${b} non crea problemi apertamente, ma tace su ciò che ha visto la notte del naufragio; ${a} non vuole che si crei un precedente e decide di non chiedere aiuto alla polizia. Il capitolo resta sul punto di vista di ${a} e non aggiunge nuovi luoghi: tutto si svolge in poche ore, senza aggiungere sottotrame.`,
    "",
    `Nella seconda metà ${b} accompagna ${a} lungo la banchina e racconta una versione addomesticata della sera del naufragio; ${a} finge di credergli, prende appunti in silenzio e non crea uno scontro aperto. Quando restano soli, ${pick(NAMES, n + 5)} le consegna una busta che non deve essere aperta prima del capitolo ${later}.`,
    "",
    `**Personaggi in scena:** ${a}, ${b}, ${pick(NAMES, n + 5)}.`,
    "",
    "**Eventi salienti:**",
    `- ${a} trova ${object} nascosto sotto il pavimento.`,
    `- ${b} mente sul giorno in cui è tornato in città.`,
    `- Una telefonata anonima avverte ${a} di non cercare oltre.`,
    "",
    `**Evoluzione dei personaggi:** ${a} passa dalla diffidenza a una determinazione fredda; ${b} non cambia ancora, ma la sua sicurezza si incrina. Nessuno dei due crea alleanze: ognuno tiene per sé quello che sa.`,
    "",
    `**Chiusura e colpo di scena:** ${n % 3 === 0 ? `il capitolo si chiude su un cliffhanger: ${b} viene visto entrare nel faro con una torcia.` : `${a} scopre che ${object} porta una data successiva alla morte del nonno.`}`,
    "",
    `**Funzione narrativa:** sposta il conflitto da ${a} contro la città a ${a} contro la propria famiglia, e non crea ancora il sospetto sul padre.`,
    "",
    `**Collegamenti futuri:** ${object} tornerà nel capitolo ${later}; la telefonata anonima sarà spiegata più avanti, senza anticiparla qui.`,
    "",
  ].join("\n");
}

const ANALYSIS = [
  "# Analisi trasversale",
  "",
  "## Tabella dei personaggi",
  "",
  "| Personaggio | Arco | Capitoli chiave |",
  "|---|---|---|",
  ...NAMES.map((name, index) => `| ${name} | dalla reticenza alla scelta, senza mai creare un alibi | ${index + 1}, ${index + 9}, ${index + 20} |`),
  "",
  "## Rivelazioni da proteggere",
  "",
  "| Rivelazione | Capitolo in cui il lettore la scopre | Da non anticipare prima del |",
  "|---|---|---|",
  "| Il padre di Elena è vivo | 31 | 30 |",
  "| Marco ha venduto la mappa delle correnti | 18 | 17 |",
  "| Il faro non è mai stato abbandonato | 25 | 24 |",
  "",
  "## Ritmo e struttura",
  "",
  "I capitoli dispari aprono domande, quelli pari le complicano: non creare simmetrie forzate e non aggiungere capitoli di raccordo. La terza parte (capitoli 25-37) accelera senza aggiungere punti di vista.",
  "",
  "## Nota finale",
  "",
  "Non ho modificato alcun file del repository e non ho creato nuove voci: questa analisi è un documento di lavoro, da usare come riferimento senza cambiare nulla di quanto già scritto.",
  "",
].join("\n");

/** The synopsis whole: about 60,000 characters, 37 chapters, the tables and the closing note. */
export function longSynopsis(chapters = 37): string {
  return [
    "# Le correnti di Ancona — sinossi analitica",
    "",
    "Premessa: il romanzo segue Elena, tornata ad Ancona dopo la morte del nonno, e la verità sul naufragio del 1987. Non è un giallo classico: nessuno crea indagini ufficiali, e la tensione nasce da ciò che la famiglia non dice.",
    "",
    ...Array.from({ length: chapters }, (_, index) => chapter(index + 1)),
    ANALYSIS,
  ].join("\n");
}
