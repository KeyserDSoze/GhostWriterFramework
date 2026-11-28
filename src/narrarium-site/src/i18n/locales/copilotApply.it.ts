/** Cosa dice una modifica del Copilot sulla sua consegna a GitHub, e di un file cambiato dopo la proposta, nel pacchetto del pannello del Copilot (vedi `@/i18n/copilotApply`). */
const copilotApplyIt = {
  copilotApply: {
    appliedSynced_one: "Applicato e sincronizzato: 1 tua modifica e {{count}} precedente",
    appliedSynced_other: "Applicato e sincronizzato: 1 tua modifica e {{count}} precedenti",
    undoneSynced_one: "Annullato e sincronizzato: 1 tua modifica e {{count}} precedente",
    undoneSynced_other: "Annullato e sincronizzato: 1 tua modifica e {{count}} precedenti",
    pulledToo_one: "È arrivato anche {{count}} file da GitHub.",
    pulledToo_other: "Sono arrivati anche {{count}} file da GitHub.",
    saved: {
      "no-credential": "È salvata su questo dispositivo. GitHub non è collegato, o non accetta la credenziale: collegalo, e la prossima sincronizzazione invia tutto.",
      offline: "È salvata su questo dispositivo. Sei offline: la prossima sincronizzazione la invia, con il resto del tuo lavoro, quando torni online.",
      unreachable: "È salvata su questo dispositivo. GitHub non è raggiungibile: la prossima sincronizzazione la invia, con il resto del tuo lavoro.",
      "branch-unpublished": "È salvata su questo dispositivo. Questo ramo non è ancora su GitHub: la prossima sincronizzazione invia il ramo e questa modifica.",
      held: "È salvata su questo dispositivo. Una parte del tuo lavoro aspetta ancora di essere inviata: premi Sincronizza per inviarla.",
      failed: "È salvata su questo dispositivo. La sincronizzazione non è andata a buon fine ({{reason}}): premi Sincronizza per riprovare; non si perde nulla.",
    },
    conflictApplied: "Applicato e salvato su questo dispositivo. La sincronizzazione si è fermata su un conflitto",
    conflictUndone: "Annullato e salvato su questo dispositivo. La sincronizzazione si è fermata su un conflitto",
    conflict_one: "{{files}} è cambiato su GitHub e qui. La finestra dei conflitti è aperta: scegli quale versione tenere. La modifica è salvata e nulla è stato sovrascritto.",
    conflict_other: "{{files}} sono cambiati su GitHub e qui. La finestra dei conflitti è aperta: scegli quale versione tenere per ognuno. La modifica è salvata e nulla è stato sovrascritto.",
    openConflict: "Apri la finestra dei conflitti",
    openConflictLabel: "Apri la finestra dei conflitti della sincronizzazione",
    completedCounts: "Applicate: {{applied}}; in attesa: {{pending}}; fermate: {{failed}}.",
    failed: {
      changed: "{{file}} è cambiato dopo che il Copilot ha proposto questa modifica. Non è stato cambiato nulla: scegli qui sotto, oppure chiedi di nuovo al Copilot.",
      undoChanged: "{{file}} è cambiato dopo l'applicazione di questa modifica, quindi non è stata annullata. Non è stato cambiato nulla: modificalo a mano, oppure chiedi al Copilot.",
      cancelled: "L'operazione è stata annullata. Non è stato cambiato nulla.",
      generic: "Non è stato possibile applicare la modifica, e non è stato cambiato nulla. Riprova, oppure chiedi di nuovo al Copilot.",
    },
    conflictChoice: {
      title: "Un file è cambiato dopo questa proposta",
      "local-edits": "{{file}} ha modifiche tue non ancora salvate come cambiamento, fatte dopo la proposta del Copilot. Tieni la tua versione, oppure usa la proposta: la tua versione resta disponibile con Annulla.",
      changed: "{{file}} è cambiato dopo che il Copilot ha proposto questa modifica (qui, o su GitHub). Tieni la versione attuale, oppure usa la proposta: la versione attuale resta disponibile con Annulla.",
      keepMine: "Tieni la mia",
      keepMineFor: "Tieni la mia: {{file}}",
      useProposal: "Usa la proposta",
      useProposalFor: "Usa la proposta: {{file}}",
      keptOne: "Hai tenuto la tua versione di {{file}}: la modifica proposta per quel file è stata scartata.",
      keptWhole: "Hai tenuto la tua versione di {{file}}: la proposta non è stata applicata.",
    },
  },
};

export default copilotApplyIt;
