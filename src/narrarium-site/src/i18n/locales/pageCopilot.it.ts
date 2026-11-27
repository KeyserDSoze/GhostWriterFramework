/** Testi del Copilot che conosce la pagina (la pagina su cui lavora, la revisione di una proposta per una pagina), nel bundle del pannello (vedi `@/i18n/pageCopilot`). */
const pageCopilotIt = {
  pageCopilot: {
    workingOn: "Sto lavorando su: {{page}}",
    workingOnHint: "Le richieste riguardano prima questa pagina; tutto il resto che il Copilot sa fare resta disponibile.",
    pages: {
      readers: "Lettori simulati",
      ghostwriters: "Ghostwriter",
      director: "Direttore",
      "evaluation-style": "Stile di valutazione",
      "autopilot-settings": "Configurazione dell'autopilot",
      canon: "Canone",
      assets: "Asset",
    },
    review: {
      title: { default: "Modifiche proposte", readers: "Modifiche proposte ai lettori simulati" },
      item: { default: "Elemento", readers: "Lettore" },
      caption: "{{title}}: ogni elemento con il suo stato dopo la modifica ({{changed}} cambiano, {{count}} in tutto)",
      state: "Acceso / spento",
      change: "Modifica",
      on: "Acceso",
      off: "Spento",
      none: "Nessuno",
      becomes: "diventa",
      builtin: "predefinito",
      kept: "Predefinito: spento, mai cancellato",
      changes: { created: "Creato", edited: "Modificato", "turned-on": "Acceso", "turned-off": "Spento", removed: "Rimosso", unchanged: "Nessuna modifica" },
      counts: {
        created_one: "{{count}} creato",
        created_other: "{{count}} creati",
        edited_one: "{{count}} modificato",
        edited_other: "{{count}} modificati",
        "turned-on_one": "{{count}} acceso",
        "turned-on_other": "{{count}} accesi",
        "turned-off_one": "{{count}} spento",
        "turned-off_other": "{{count}} spenti",
        removed_one: "{{count}} rimosso",
        removed_other: "{{count}} rimossi",
      },
      after: "dopo: {{on}} accesi su {{total}}",
      nothing: "Nulla cambia",
      apply: "Applica",
      discard: "Scarta",
      undo: "Annulla",
      appliedBadge: "Applicata",
      applied: "Applicata: {{summary}}.",
      undone: "Annullata: tutto è com'era prima.",
      discarded: "Scartata: non è cambiato nulla.",
      fields: {
        name: "nome", description: "descrizione", profile: "profilo", aspects: "aspetti", preferredGenres: "generi preferiti", dislikedGenres: "generi non graditi",
        experienceLevel: "esperienza", severity: "severità", audienceAge: "età del pubblico", interests: "interessi", appreciatedElements: "elementi apprezzati",
        frequentCriticisms: "critiche frequenti", customPrompt: "prompt personalizzato",
      },
    },
  },
  copilotTools: {
    tools: {
      "edit-page": {
        name: "Modifica questa pagina",
        description: "Propone un unico insieme di modifiche alla pagina su cui sei: in Lettori simulati, lettori creati (anche più d'uno alla volta), modificati, accesi o spenti e rimossi; i lettori predefiniti si spengono, non si cancellano mai. Vedi ogni elemento con il suo stato finale, applichi tutto in una sola modifica e puoi annullarla.",
        output: "Elenco da rivedere di ogni elemento con il suo stato finale",
      },
    },
  },
};

export default pageCopilotIt;
