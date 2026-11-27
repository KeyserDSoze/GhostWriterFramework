/** Testi delle schede di Account e sincronizzazione: un accesso scaduto, lo stato della sincronizzazione, la sincronizzazione automatica (vedi `@/i18n/accountSyncStatus`). */
const accountSyncStatusIt = {
  accountSyncStatus: {
    sync: {
      allSynced: "Tutto sincronizzato · ultimo controllo {{time}}",
      allSyncedDate: "Tutto sincronizzato · ultimo controllo {{date}}",
      pending: {
        "local-changes": "Le modifiche su questo dispositivo aspettano di essere inviate.",
        "remote-newer": "{{service}} ha dati più recenti di questo dispositivo.",
        "different-copies": "Questo dispositivo e {{service}} hanno copie diverse: ti verrà chiesto quale tenere.",
        "never-synced": "Non ancora sincronizzato.",
      },
      syncing: "Sincronizzo…",
      off: "La sincronizzazione automatica è spenta per questo servizio: nulla viene inviato o ricevuto da solo.",
      offline: "Questo dispositivo è offline. La sincronizzazione riprende da sola quando torna online.",
      error: "L'ultima sincronizzazione non è riuscita. Riprova.",
      sync: "Sincronizza",
      tryAgain: "Riprova",
      checkNow: "Controlla ora",
      checkNowHint: "Cerca le modifiche fatte su un altro dispositivo.",
    },
    auto: {
      allTitle: "Sincronizzazione automatica per tutti i servizi",
      allOn: "Attiva",
      allOff: "Spenta",
      allHelp: "Quando è attiva, ogni servizio collegato invia e riceve le tue modifiche da solo, un attimo dopo che le fai. Un servizio che ha una sua impostazione qui sotto la mantiene, qualunque cosa dica questa.",
      serviceLabel: "Sincronizzazione automatica",
      inherit: "Segue l'impostazione generale, che è {{state}}.",
      own: "Impostata solo per questo servizio: {{state}}. Prevale sull'impostazione generale.",
      followGeneral: "Segui l'impostazione generale",
      stateOn: "attiva",
      stateOff: "spenta",
    },
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
