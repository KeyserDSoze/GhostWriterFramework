/** Testi dello stato del repository di un libro che vive su questo dispositivo o che ora non raggiunge GitHub: si caricano con la finestra (vedi `@/i18n/localFirstStatus`), non con il guscio dell'app. */
const localFirstStatusIt = {
  localFirst: {
    statusLocal: "Questo libro è conservato su questo dispositivo: sincronizzazione, fetch, pull, push e nuovo clone richiedono GitHub. Collegalo a GitHub dalle impostazioni del libro; fino ad allora esporta un backup per tenerne una copia altrove.",
    statusOffline: "Sei offline: le azioni che richiedono GitHub riprendono quando torna la connessione. Le tue modifiche restano su questo dispositivo.",
    statusNoCredential: "Questo libro non ha una credenziale GitHub su questo dispositivo: qui lo leggi, lo scrivi e lo salvi come commit locali. Sincronizzazione, fetch, pull, push e nuovo clone richiedono GitHub: collega GitHub, e la sincronizzazione successiva pubblica ciò che hai salvato.",
    diffUnavailable: "Diff non disponibile",
    diffBinary: "File binario: diff non disponibile",
    diffNoBase: "La versione precedente di questo file non è conservata su questo dispositivo, quindi non si può confrontare.",
    diffOffline: "La versione precedente di questo file è su GitHub: connettiti a internet per confrontarla.",
    restoreNoBase: "In un libro conservato su questo dispositivo si possono annullare solo i file nuovi: la versione precedente degli altri file non è conservata.",
    restoreNoCredential: "La versione precedente di un file modificato è su GitHub: collega GitHub per annullare la modifica. I file nuovi si possono annullare qui.",
    restoreOffline: "La versione precedente di un file modificato è su GitHub: connettiti a internet per annullare la modifica. I file nuovi si possono annullare qui.",
    selectAll: "Seleziona tutti",
    clearSelection: "Deseleziona",
    restoreSelected: "Ripristina selezionati",
    restoredFiles: "Ripristinati {{count}} file",
    selectForRestore: "Seleziona {{path}} per ripristinarlo",
    showDiff: "Mostra diff",
    hideDiff: "Nascondi diff",
    exportRecovery: "Esporta",
    deleteRecovery: "Elimina",
    deleteRecoveryConfirm: "Eliminare il recovery del {{date}}?",
    recoveryDeleted: "Recovery eliminato",
  },
};

export default localFirstStatusIt;
