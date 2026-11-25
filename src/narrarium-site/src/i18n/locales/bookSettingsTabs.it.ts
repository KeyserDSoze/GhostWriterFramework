/** Testi delle schede delle impostazioni di un libro, inclusi con quella pagina (vedi `@/i18n/bookSettingsTabs`). */
const bookSettingsTabsIt = {
  bookSettings: {
    tabs: {
      label: "Sezioni delle impostazioni del libro",
      general: "Generale",
      github: "GitHub",
      reader: "Lettore online",
      export: "Esportazione",
      audit: "Audit",
      discard: "Annulla le modifiche",
      unsaved: "Modifiche non salvate",
      opensNewTab: "(si apre in una nuova scheda)",
      auditHelp: "L'audit legge il libro rispetto al suo canone e segnala ciò che non torna. Queste impostazioni valgono solo per questo libro; il modello di IA è quello della rotta del compito Audit.",
      exportHelp: "I preset tengono tipografia e contenuti diversi per usi diversi, come un manoscritto per un editore o un ebook. Li usa la pagina di esportazione.",
      readerNeedsGitHub: "Il lettore online si pubblica con GitHub Pages dal repository GitHub del libro. Questo libro vive solo su questo dispositivo, quindi non può averne uno: collegalo prima a GitHub.",
      goToGitHub: "Vai alla scheda GitHub",
      repositoryTitle: "Repository",
      repositoryDescription: "Il repository GitHub in cui questo libro viene salvato.",
      branchDeviceDescription: "Il ramo di lavoro di un libro che vive su questo dispositivo esiste solo qui.",
      localBranch: "Ramo di lavoro locale",
      onlyOnDevice: "solo su questo dispositivo",
      publishedAs: "pubblicato come {{branch}} su GitHub",
      branchOnConnect: "Quando colleghi il libro a GitHub, un repository nuovo o vuoto riceve questo ramo, con il libro, come ramo predefinito; un repository che ha già dei commit tiene i suoi rami e il suo ramo predefinito, dove il libro viene pubblicato. Da allora il ramo di lavoro è un ramo di quel repository.",
    },
    tokenStatus: {
      appConnected: "Connesso come {{user}} con la GitHub App.",
      appRenews: "Connesso come {{user}} con la GitHub App. Il token da 8 ore si rinnova da solo.",
      appRenewsUntil: "Connesso come {{user}} con la GitHub App. Il token si rinnova da solo; quello attuale è valido fino a",
      appSessionUntil: "Connesso come {{user}} con la GitHub App. Questo dispositivo non conserva la connessione: il token attuale è valido fino a",
      appExpired: "Connesso come {{user}} con la GitHub App, ma il token è scaduto e su questo dispositivo non può rinnovarsi da solo. Riconnetti GitHub.",
    },
  },
};

export default bookSettingsTabsIt;
