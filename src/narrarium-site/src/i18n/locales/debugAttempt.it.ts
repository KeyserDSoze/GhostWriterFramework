/** Texts of the attempt details of the debug panel, bundled with the panel that shows them (see `@/i18n/debugAttempt`). */
const debugAttemptIt = {
  debug: {
    attempt: {
      title: "Come è stata chiesta",
      tools: "Richiesta come chiamata di funzione",
      json: "JSON nel messaggio",
      streaming: "In streaming",
      notStreaming: "Non in streaming",
      thinking: "Thinking: {{level}}",
      reasoningParameter: "Livello inviato come {{parameter}}",
      calledYes: "Funzione chiamata: sì",
      calledNo: "Funzione chiamata: no",
      skipped: "Saltati: {{models}} (senza tool call)",
      firstByte: "Primo byte: {{time}}",
      toolsOnlyOn: "Solo tool: attivo",
      toolsOnlyOff: "Solo tool: spento",
      limits: "Limiti: inizio {{start}}, silenzio {{idle}}",
      limitsRaised: "Limiti: inizio {{start}} (alzato da {{from}}), silenzio {{idle}}",
    },
  },
};

export default debugAttemptIt;
