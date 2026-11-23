/** Testi della parte della pagina pubblica /mcp che descrive l'MCP di un libro su un server personale: vedi `mcpBookPage.en.ts`. */
const mcpBookPageIt = {
  mcpBookPage: {
    intro: "Come gli assistenti raggiungono Narrarium: l'MCP di ogni libro sul tuo server, il pacchetto locale e l'endpoint pubblico.",
    jump: {
      label: "In questa pagina",
    },
    title: "MCP di un libro sul tuo server personale",
    lead: "Ogni libro sul tuo server personale può avere il suo indirizzo MCP, /mcp/<nome>. Un assistente che vi si collega può leggere il libro e, solo se lo consenti, modificarlo e guidare il suo autopilot, con strumenti simili a quelli del Copilot di Narrarium.",
    use: {
      title: "A cosa serve",
      body: "Lavora su un libro dall'assistente che già usi: ChatGPT, Claude.ai, Claude Code, Cursor o VS Code. Può leggere capitoli, scene, canone e la Scaletta e vedere cosa sta facendo l'autopilot; con il tuo permesso può anche modificare il libro e guidare l'autopilot.",
    },
    start: {
      title: "Come si attiva",
      body: "Avvia il tuo server personale (npx narrarium-server) e metti il libro sul server. Apri le impostazioni del libro e attiva Server MCP di questo libro: compare il suo indirizzo, pronto da copiare. Per ogni libro è spento finché non lo accendi. ChatGPT e Claude.ai richiedono inoltre che il server abbia un indirizzo pubblico https.",
      guide: "Guida: Server MCP di un libro",
      server: "Server personale: MCP per ogni libro",
    },
    permissions: {
      title: "Cosa può fare un assistente",
      read: {
        name: "Leggere il libro",
        text: "Capitoli, scene, canone, file, la Scaletta e cosa sta facendo l'autopilot. Non può cambiare nulla.",
      },
      write: {
        name: "Modificare il libro",
        text: "Creare e modificare capitoli, scene, canone, file e la Scaletta. Ogni modifica è un commit git che puoi annullare.",
      },
      run: {
        name: "Controllare l'autopilot",
        text: "Metterlo in pausa o riprenderlo, riprovare un passo fallito, dargli note e rispondere alle sue domande. Un autopilot ripreso spende i tuoi crediti AI, entro i limiti che hai impostato.",
      },
    },
    access: {
      title: "Come si collega un'app",
      oauth: "ChatGPT e Claude.ai si collegano da soli (OAuth): incolli l'indirizzo del libro e una pagina del tuo server ti chiede di consentire l'app, con una passkey o il codice admin.",
      readOnly: "La sola lettura è la scelta di partenza: modificare il libro e controllare l'autopilot restano spenti finché non li attivi.",
      revoke: "Le app collegate a ogni libro sono elencate e puoi revocarne una qualsiasi.",
      token: "Claude Code, Cursor e VS Code possono usare un token che crei per ciascuno, con i soli permessi che servono.",
    },
    risk: {
      label: "Rischio:",
      text: "Un modello che legge il libro può essere convinto a usare gli strumenti dal testo che legge: dai il permesso di modifica solo alle app di cui ti fidi; ogni modifica è un commit che puoi annullare.",
    },
    tools: {
      intro: "Questi sono tutti gli strumenti dell'MCP di un libro, generati dagli strumenti della versione attuale del server personale: nomi e parametri sono quelli che vede un assistente, e ogni riga riassume la descrizione più lunga che legge. Un assistente vede solo gli strumenti dei permessi che gli hai dato.",
      legend: "Un * indica un parametro obbligatorio. Le etichette sono i suggerimenti che ogni strumento dà agli assistenti: legge soltanto, può sostituire o rimuovere ciò che c'è, oppure non sovrascrive nulla.",
    },
    tables: {
      read: "Ogni connessione ha questo permesso: senza, un assistente non raggiunge affatto il libro.",
      write: "Solo per una connessione a cui è permesso modificare il libro.",
      run: "Solo per una connessione a cui è permesso controllare l'autopilot.",
    },
    notes: {
      readOnly: "Sola lettura",
      destructive: "Può sostituire o rimuovere",
      additive: "Non sovrascrive",
    },
    takes: {
      label: "Parametri",
      required: "obbligatorio",
    },
    packages: {
      title: "MCP locale e pubblico",
    },
  },
};

export default mcpBookPageIt;
