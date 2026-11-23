/** Testi della scheda che collega un libro locale a GitHub, nelle impostazioni del libro, caricati con quella pagina (vedi `@/i18n/bookGithub`). */
const bookGithubIt = {
  bookSettings: {
    loadRemoteBranches: "Carica branch remoti",
    deviceOnly: "Solo su questo dispositivo",
    connectGithub: {
      title: "Collega il libro a GitHub",
      description: "La working copy locale esistente verrà mantenuta e pubblicata in una repository privata.",
      owner: "Proprietario",
      repository: "Repository",
      overwrite: "Sovrascrivi repository esistente",
      overwriteHint: "Se la repository non è vuota, il suo branch verrà sostituito con questo libro locale.",
      submit: "Crea o collega repository privata",
      noToken: "Collega GitHub o configura un PAT.",
      done: "Libro collegato a GitHub",
    },
  },
};

export default bookGithubIt;
