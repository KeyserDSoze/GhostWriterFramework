/** Texts of the frozen chapters, bundled with the views that show them (see `@/i18n/frozen`): the app entry does not carry them. */
const frozenIt = {
  frozen: {
    badge: {
      autopilot: "Congelato il {{date}} dall'autopilot",
      author: "Congelato il {{date}} da te",
      help: "Un capitolo congelato conserva una traccia del suo testo: quando lo modifichi, l'autopilot ti chiede cosa fare.",
      problem: "Il congelamento di questo capitolo non si legge, quindi conta come non congelato: correggi chapter.md, oppure congelalo di nuovo.",
    },
    toggle: {
      freeze: "Congela capitolo",
      unfreeze: "Scongela capitolo",
    },
    unfreeze: {
      title: "Scongelare questo capitolo?",
      description: "L'autopilot non noterà più le tue modifiche e una decisione che lo aspetta viene annullata. Puoi congelarlo di nuovo quando vuoi.",
      confirm: "Scongela",
    },
    change: {
      title: "Hai modificato questo capitolo dopo che era stato congelato",
      intro: "Cosa deve fare l'autopilot con la tua modifica?",
      modified: "Modificati: {{list}}.",
      added: "Aggiunti: {{list}}.",
      removed: "Tolti: {{list}}.",
      body: "È cambiato il testo della pagina del capitolo.",
      queuedAi: "Una revisione chiama l'AI: resta in coda e l'autopilot la fa alla sua prossima esecuzione.",
      notInPlan: "L'autopilot non ha un piano per questo capitolo: puoi solo segnarlo come rivisto.",
      inHands: "L'autopilot sta lavorando a questo capitolo: lo congela di nuovo quando ha finito, e ti chiede di ogni modifica che non ha fatto lui.",
      checking: "Controllo di cosa si può fare con la tua modifica…",
    },
    actions: {
      "review-and-update": "Rivedi e aggiorna il libro da questa modifica",
      "review-only": "Solo una review del capitolo",
      "mark-reviewed": "Segna come rivisto",
      "rewrite-to-outline": "Riscrivi il capitolo secondo la Scaletta",
      "keep-text": "Tieni il testo, aggiorna solo la Scaletta",
    },
    actionHelp: {
      "review-and-update": "Il direttore rilegge il capitolo e l'autopilot aggiorna i capitoli successivi che non tornano più. Il tuo testo non viene riscritto.",
      "review-only": "Solo il giudizio del direttore sul capitolo: nient'altro cambia.",
      "mark-reviewed": "Il capitolo viene congelato di nuovo così com'è. Nessuna chiamata all'AI.",
      "rewrite-to-outline": "L'autopilot riscrive il capitolo secondo la sua nuova voce, poi controlla i capitoli successivi.",
      "keep-text": "Il piano segue la nuova voce, il testo del capitolo resta com'è. Nessuna chiamata all'AI.",
    },
    queued: {
      title: "In coda: {{action}}",
      next: "L'autopilot lo fa alla sua prossima esecuzione.",
      running: "L'autopilot è in esecuzione: lo fa al prossimo passo.",
      start: "Avvia ora",
      follow: "Seguilo In diretta",
    },
    done: {
      reviewed: "Segnato come rivisto: il capitolo è di nuovo congelato così com'è.",
      queued: "La tua decisione è in coda: l'autopilot se ne occupa alla sua prossima esecuzione.",
      frozen: "Il capitolo è congelato.",
      unfrozen: "Il capitolo non è più congelato.",
    },
    server: {
      unsupported: "Il tuo server personale è più vecchio della {{version}} e non conosce i capitoli congelati: aggiornalo per deciderne da qui.",
    },
  },
};

export default frozenIt;
