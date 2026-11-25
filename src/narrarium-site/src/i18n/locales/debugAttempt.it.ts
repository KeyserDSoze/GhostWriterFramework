/** Texts of the attempt details of the debug panel, bundled with the panel that shows them (see `@/i18n/debugAttempt`). */
const debugAttemptIt = {
  debug: {
    attempt: {
      title: "Come è stata chiesta",
      tools: "Richiesta come chiamata di funzione",
      json: "JSON nel messaggio",
      streaming: "In streaming",
      notStreaming: "Non in streaming",
      apiVersion: "Versione API: {{version}}",
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
      received: "Ricevuti {{size}} in {{chunks}} pezzi (HTTP {{status}})",
      receivedNothing: "Niente ricevuto dopo gli header (HTTP {{status}})",
      lastChunk: "Ultimo pezzo {{after}} dopo l'inizio, {{silent}} prima della fine",
      end: {
        done: "Stream: chiuso dal provider con [DONE]",
        closed: "Stream: chiuso dal provider senza [DONE]",
        reset: "Stream: connessione persa",
        error: "Stream: il provider ha segnalato un errore",
        timeout: "Stream: un limite di tempo è scaduto",
      },
      finishReason: "Motivo di fine: {{reason}}",
      usageReported: "Token: comunicati dal provider",
      usageMissing: "Token: il provider non li ha comunicati (stimati)",
      usageNotAsked: "Token: non richiesti a questo provider (stimati)",
      requestId: "ID richiesta: {{id}}",
    },
  },
};

export default debugAttemptIt;
