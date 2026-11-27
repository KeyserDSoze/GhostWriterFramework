/** Testi dei permessi Google aggiuntivi e del controllo della configurazione Google (vedi `@/i18n/googleAccess`). */
const googleAccessIt = {
  googleAccess: {
    full: {
      title: "Per questo serve l'accesso completo al tuo Google Drive",
      body: "Narrarium chiede a Google solo i file e le cartelle che crea lui, così non può mai leggere il resto del tuo Drive. {{reason}} Per andare avanti, Google deve dare a Narrarium l'accesso a tutti i file del tuo Drive. Google lo chiama permesso limitato e ti avvisa che questa app non è verificata per esso. Puoi consentirlo solo per ora (resta solo finché questa pagina è aperta) e ritirarlo su myaccount.google.com/connections.",
      reason: {
        export: "La cartella che hai scelto c'era già prima di Narrarium, quindi Google non la mostra a Narrarium.",
        browse: "Google mostra a Narrarium solo le cartelle che ha creato lui.",
        legacy: "Le chat della versione precedente possono stare in una cartella che Google non mostra a Narrarium.",
      },
      allow: "Consenti l'accesso completo a Drive",
      allowing: "In attesa di Google…",
      dismiss: "Non ora",
      granted: "L'accesso completo a Drive è consentito finché non chiudi questa pagina.",
      error: {
        unavailable: "L'accesso con Google non è ancora caricato. Aspetta un momento e riprova.",
        denied: "Google non ha dato l'accesso (è stato rifiutato o il permesso non era spuntato). Non è cambiato nulla.",
        "popup-blocked": "Il browser ha bloccato la finestra di Google. Consenti i pop-up per questo sito e riprova.",
        failed: "Google non è riuscito a dare l'accesso. Riprova tra un momento.",
      },
    },
    folders: {
      note: "Narrarium mostra le cartelle che ha creato. Una cartella che c'era già nel tuo Drive viene nascosta da Google.",
      showAll: "Mostra tutte le mie cartelle…",
      showingAll: "Sono mostrate tutte le tue cartelle, con l'accesso completo che hai consentito per ora.",
      fullToken: "L'accesso completo è consentito per ora, quindi sono elencate tutte le cartelle.",
    },
    folderAccess: {
      title: "Narrarium non può usare questa cartella",
      body: "Google non lascia che Narrarium scriva in una cartella che non ha creato lui. Scegli una cartella creata da Narrarium, oppure consenti l'accesso completo a Drive per questa esportazione.",
    },
    legacy: {
      intro: "Recupera le conversazioni conservate nella vecchia cartella Google Drive/Narrarium/chats. L'importazione non modifica mai i file originali.",
      notFound: "Con l'accesso che ha Narrarium non sono state trovate chat più vecchie. Se usavi una versione precedente, possono stare in una cartella che Google nasconde a Narrarium.",
    },
    check: {
      title: "Controlla la configurazione di Google",
      open: "Controlla la configurazione di Google",
      close: "Nascondi il controllo",
      intro: "Cosa questo sito chiederà a Google, e cosa guardare nel progetto Google Cloud se l'accesso non riesce. Non viene mostrato nulla di segreto.",
      scopes: "Permessi chiesti a ogni accesso",
      scope: {
        openid: "openid — chi sei",
        profile: "profile — il tuo nome e la tua immagine",
        email: "email — il tuo indirizzo",
        appdata: "drive.appdata — una cartella nascosta dell'app (non sensibile)",
        file: "drive.file — i file e le cartelle che Narrarium crea (non sensibile)",
      },
      notAsked: "Mai chiesto all'accesso: l'accesso completo a Drive (lo scope limitato «drive»). Si chiede solo se lo scegli.",
      client: "Client id di questa versione",
      clientValue: "Numero del progetto {{project}} (il resto dell'id non viene mostrato)",
      clientUnknown: "Non è stato possibile leggere il client id.",
      checklist: "Se sei il proprietario del progetto Google Cloud",
      items: {
        audience: "Pubblico: lo stato di pubblicazione deve essere «In produzione». In «Test» possono accedere solo gli utenti di prova e l'accesso scade dopo 7 giorni.",
        project: "Client: il client id OAuth di questa versione deve appartenere a quel progetto (il numero qui sopra deve coincidere con il numero del progetto nella console).",
        scopes: "Accesso ai dati: gli scope nella console devono coincidere con l'elenco qui sopra. drive.appdata e drive.file non richiedono verifica; uno scope limitato come drive sì.",
        origins: "Origini JavaScript autorizzate: l'indirizzo di questo sito, esatto.",
        grants: "Prima di riprovare, togli i vecchi consensi di Narrarium su myaccount.google.com/connections, poi accedi di nuovo.",
      },
      proxy: "Restare connessi per mesi funziona solo se il proxy di autenticazione serve Google: la scheda di Google dice che tipo di accesso è in uso.",
    },
  },
};

export default googleAccessIt;
