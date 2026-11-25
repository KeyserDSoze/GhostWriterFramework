/** Testi dei rami che mostra la cornice dell'app (vedi `@/i18n/branchesShell`): su quale ramo si è aperto un libro, e perché. */
const branchesShellIt = {
  branchesShell: {
    personalBranch: "il tuo ramo personale",
    adopted: {
      title: "Aperto il ramo {{branch}}",
      description: "È il ramo su cui hai lavorato per ultimo, su un altro dispositivo. Questo dispositivo era su {{previous}}.",
    },
    notAdopted: {
      title: "Il ramo {{branch}} non è stato aperto",
      gone: "{{branch}}, il ramo su cui hai lavorato per ultimo su un altro dispositivo, non è su GitHub (o non ancora): il libro resta dov’era ({{previous}}).",
      "needs-github": "{{branch}}, il ramo su cui hai lavorato per ultimo su un altro dispositivo, non è su questo dispositivo, e per scaricarlo serve GitHub: il libro resta dov’era ({{previous}}).",
      failed: "{{branch}}, il ramo su cui hai lavorato per ultimo su un altro dispositivo, non si è potuto aprire qui: il libro resta dov’era ({{previous}}).",
    },
    trigger: {
      label: "Ramo {{branch}}{{state}}. Cambia ramo o creane uno",
      pending: "non pubblicato",
      off: "sincronizzazione automatica spenta",
      attention: "da controllare",
      syncing: "in sincronizzazione",
    },
  },
};

export default branchesShellIt;
