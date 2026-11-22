/** Testi della verifica della connessione e del pulsante che legge i modelli di un endpoint, caricati con i blocchi che li mostrano (vedi `@/i18n/endpoint`). */
const endpointIt = {
  endpoint: {
    check: "Verifica la connessione",
    checkNamed: "Verifica la connessione di {{name}}",
    checking: "Verifica della connessione in corso…",
    read: "Leggi i modelli dall'endpoint",
    readNamed: "Leggi i modelli dall'endpoint di {{name}}",
    details: "Dettagli tecnici",
    checkDetails: "Dettagli tecnici della verifica",
    why: "il server può essere spento, l'indirizzo sbagliato o il CORS può non ammettere questo sito; il browser non sa distinguere i casi",
    open: "Apri questa integrazione",
    fromBrowser: "La verifica parte dal tuo browser, non dal server personale che esegue l'autopilot.",
    result: {
      ok_one: "Risponde in {{ms}} ms · {{count}} modello",
      ok_other: "Risponde in {{ms}} ms · {{count}} modelli",
      okEmpty: "Risponde in {{ms}} ms, ma non elenca nessun modello. Se è un gateway, avviaci un modello.",
      okNoList: "Risponde in {{ms}} ms, ma non con un elenco di modelli: controlla che l'indirizzo sia la base dell'API, per esempio …/v1.",
      error: "Risponde con errore {{status}}: {{remedy}}",
      unreachable: "Non raggiungibile: {{why}}.",
      failed: "Non è stato possibile verificare la connessione.",
    },
    remedy: {
      key: "controlla la chiave",
      forbidden: "controlla la chiave e ciò che le è permesso",
      address: "a questo indirizzo non c'è un elenco di modelli: controlla che finisca con /v1",
      wait: "l'endpoint sta limitando le richieste: aspetta un momento e riprova",
      busy: "l'endpoint ha un guasto o è occupato: riprova tra poco",
      other: "controlla l'indirizzo e la chiave",
    },
  },
};

export default endpointIt;
