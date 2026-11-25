/** Testi dei rami che si caricano con la sincronizzazione dei rami e con il selettore (vedi `@/i18n/branches`): la cornice dell'app non li porta. */
const branchesIt = {
  branches: {
    outcome: {
      divergedTitle: "GitHub e questo dispositivo hanno cambiato entrambi {{branch}}",
      diverged: "Non è stato sovrascritto nulla. Sincronizza per unire le due versioni: se lo stesso file è cambiato da entrambe le parti, scegli tu quale tenere.",
      syncNow: "Sincronizza ora",
      goneTitle: "{{branch}} non è più su GitHub",
      gone: "La copia su questo dispositivo resta, con le sue modifiche. Per pubblicarle, crea un nuovo ramo a partire da questo.",
      nameTakenTitle: "Su GitHub c’è già un ramo che si chiama {{branch}}",
      nameTaken: "Ha altre modifiche, quindi questo ramo non è stato pubblicato e non è stato sovrascritto nulla. Per pubblicarlo, crea da questo un ramo con un altro nome.",
      failedTitle: "La sincronizzazione automatica di {{branch}} non è riuscita",
      failed: "{{reason}} Riproverà più tardi.",
    },
  },
};

export default branchesIt;
