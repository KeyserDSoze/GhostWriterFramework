/** Testi della finestra che chiede quale copia dell'account tenere quando le copie sono diverse (vedi `@/i18n/accountReconcile`). */
const accountReconcileIt = {
  accountSync: {
    reconcile: {
      title: "Trovate copie dell'account diverse",
      intro: "Le copie dei dati del tuo account su questo dispositivo e sui tuoi servizi non coincidono. È già selezionata la più recente, cioè quella modificata per ultima. Nessuna copia verrà sovrascritta finché non scegli.",
      legend: "Quale copia vuoi tenere?",
      local: "Questo dispositivo",
      newest: "Copia più recente",
      superseded: "Già inclusa in una copia più recente",
      modified: "Ultima modifica",
      unknownDate: "data sconosciuta",
      device: "dispositivo {{device}}",
      useNewest: "Usa la copia più recente",
      useSelected: "Usa la copia di {{name}}",
      using: "Applico…",
      failed: "Non è stato possibile applicare la copia: {{error}}",
    },
  },
};

export default accountReconcileIt;
