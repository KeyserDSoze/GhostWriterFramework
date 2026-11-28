/** Testi della pagina del Brainstormer, inclusi con essa (vedi `@/i18n/brainstormer`). */
const brainstormerIt = {
  brainstormerPage: {
    title: "Brainstormer",
    description: "Il co-autore del progetto: propone pitch alternativi dalla tua idea, sviluppa la struttura del libro e riscrive le parti deboli del progetto con la sua voce. La progettazione legge questa scheda; il file è brainstormer.md.",
    defaults: "Questo libro non ha ancora un Brainstormer suo: quello mostrato è il predefinito. Salvalo per tenerlo nel libro.",
    loadFailed: "Non è stato possibile leggere il Brainstormer.",
    saved: "Il Brainstormer è salvato.",
    saveFailed: "Non è stato possibile salvare il Brainstormer.",
    changedElsewhere: "Il file è cambiato altrove. Ricaricalo per vedere la nuova versione; le tue modifiche restano finché non lo fai.",
    reload: "Ricarica il file",
    sections: { identity: "Chi è", boldness: "Quanto osa", cares: "Cosa gli sta a cuore e cosa rifiuta", method: "Il suo metodo" },
    name: "Nome",
    language: "Lingua",
    languageHint: "Un codice come en o it. Il progetto è scritto nella lingua del libro qualunque cosa dica questo campo.",
    persona: "Personalità",
    personaHint: "Voce e temperamento: come discute, com'è lavorarci insieme.",
    boldness: {
      label: "Audacia",
      value: "{{value}} su 10, {{caption}}",
      help: "Quanto si allontana da ciò che idea e genere si aspettano: poco resta vicino a loro, molto mette in discussione la premessa e propone ciò che nessuno si aspetta.",
      scale: { low: "Prudente", middle: "Equilibrato", high: "Audace" },
      captions: { prudent: "resta a ciò che il genere si aspetta", balanced: "rischia dove migliora il libro", daring: "mette in discussione la premessa e osa di più", breaking: "propone la versione che nessuno scriverebbe" },
      asNumber: "Audacia come numero",
    },
    priorities: "Priorità, in ordine",
    avoid: "Cliché e artifici che rifiuta",
    listHint: "Uno per riga.",
    method: "Note di metodo",
    methodHint: "Regole libere in Markdown: come lavora, cosa fa sempre per prima cosa.",
    bar: { label: "Salva il Brainstormer", saved: "Il Brainstormer è salvato", unsaved: "Il Brainstormer ha modifiche", defaults: "Il Brainstormer predefinito: non è ancora nel libro", saving: "Salvataggio del Brainstormer…", failed: "Non è stato possibile salvare il Brainstormer: {{reason}}", conflict: "Il file è cambiato altrove e non è stato sovrascritto.", discard: "Scarta le modifiche" },
    save: "Salva il Brainstormer",
    open: "Apri il progetto",
  },
};

export default brainstormerIt;
