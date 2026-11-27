/** Testi delle schede di Account e sincronizzazione: un accesso scaduto, lo stato della sincronizzazione, la sincronizzazione automatica (vedi `@/i18n/accountSyncStatus`). */
const accountSyncStatusIt = {
  accountSyncStatus: {
    technicalDetails: "Dettagli tecnici",
    signIn: {
      title: "Accedi di nuovo a {{service}} su questo dispositivo",
      action: "Accedi di nuovo a {{service}} su questo dispositivo",
      why: {
        session: "Questo dispositivo ha fatto l'accesso a {{service}} con credenziali di sessione: durano poco (circa un'ora per Google, circa un giorno per Microsoft) e poi il servizio chiede di accedere di nuovo. Sono scadute. I tuoi dati sono al sicuro su questo dispositivo e non si perde nulla.",
        "long-lived": "L'accesso di lunga durata a {{service}} è stato rifiutato o non è più conservato su questo dispositivo, quindi va rifatto. I tuoi dati sono al sicuro su questo dispositivo e non si perde nulla.",
        missing: "Su questo dispositivo non c'è un accesso salvato a {{service}} (non è stato conservato, o questo è un altro dispositivo). I tuoi dati sono al sicuro su questo dispositivo e non si perde nulla.",
      },
      offerLongLived: "Per non dover accedere di nuovo: le credenziali di lunga durata si rinnovano da sole in background tramite il servizio di accesso di Narrarium. Passa a quelle qui sotto, dopo aver fatto di nuovo l'accesso.",
    },
  },
};

export default accountSyncStatusIt;
