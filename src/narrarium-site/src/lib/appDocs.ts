import type { DocEntry, DocGroup } from "@/lib/generated-docs";

function entry(slug: string, group: DocGroup, en: { title: string; summary: string; markdown: string }, it: { title: string; summary: string; markdown: string }): DocEntry {
  return {
    title: en.title,
    href: `/docs/${slug}`,
    slug,
    group,
    groupLabel: group,
    sourcePath: `app:${slug}:en`,
    summary: en.summary,
    markdown: en.markdown,
    translations: {
      en: { ...en, sourcePath: `app:${slug}:en` },
      it: { ...it, sourcePath: `app:${slug}:it` },
    },
  };
}

export const appDocEntries: DocEntry[] = [
  entry("overview", "overview", {
    title: "How Narrarium works",
    summary: "The application architecture, where data lives, and the main writing workflow.",
    markdown: `# How Narrarium works

Narrarium is a browser application for writing books whose repository is the source of truth.

## Where data lives

- **GitHub repository:** book metadata, canon, chapters, paragraphs, drafts, scripts, evaluations, research, assets, ghostwriters, simulated readers and reader evaluations.
- **Local browser repository:** the active working copy used for fast local-first editing, commits, pulls and pushes.
- **Google Drive or OneDrive:** private application settings, AI credentials, connected books, Copilot chats, clipboard and cost ledger.
- **AI providers:** requests are sent directly from the browser using integrations configured by the user.

## Main capabilities

- structured book and canon management;
- chapter and paragraph writing;
- Script → Draft → Final workflow;
- ghostwriter prose contracts and evaluation-style contracts;
- Copilot and Fantasmino with a configurable Tool Registry;
- Router-based AI tasks and fallbacks;
- deep research and promotion into canon;
- editorial and simulated-reader evaluations;
- reader preview and DOCX, PDF and EPUB export;
- local Git working copy with commit, pull, push, branch and PR operations.

## The menu of a book

When a book is open, the menu groups its pages: **Book** (Overview, Dashboard, Reader, Export), **Autopilot** (Live, Configuration), **Profiles** (Director, Ghostwriters, Evaluation style, Simulated readers) and **Tools** (Audit, Research, Assets). **Book settings** is at the bottom of the menu of the book, apart, and the canon comes after it. The title of a group opens and closes it: this device remembers the groups you closed, and the group of the page you are on is always open.
`,
  }, {
    title: "Come funziona Narrarium",
    summary: "Architettura dell'app, posizione dei dati e flusso principale di scrittura.",
    markdown: `# Come funziona Narrarium

Narrarium è un'applicazione browser per scrivere libri in cui il repository è la fonte di verità.

## Dove vivono i dati

- **Repository GitHub:** metadati libro, canone, capitoli, paragrafi, bozze, script, valutazioni, ricerche, asset, ghostwriter, lettori simulati e relative valutazioni.
- **Repository locale del browser:** working copy local-first usata per modifica rapida, commit, pull e push.
- **Google Drive o OneDrive:** impostazioni private, credenziali AI, libri collegati, chat Copilot, clipboard e registro costi.
- **Provider AI:** le richieste partono direttamente dal browser usando le integrazioni configurate dall'utente.

## Capability principali

- gestione strutturata del libro e del canone;
- scrittura di capitoli e paragrafi;
- flusso Script → Bozza → Definitivo;
- contratti di prosa dei ghostwriter e stile valutativo;
- Copilot e Fantasmino con Tool Registry configurabile;
- Router AI con task e fallback;
- Deep Research e promozione nel canone;
- valutazioni editoriali e con lettori simulati;
- reader preview ed export DOCX, PDF ed EPUB;
- working copy Git locale con commit, pull, push, branch e PR.

## Il menu di un libro

Quando un libro è aperto, il menu raggruppa le sue pagine: **Libro** (Panoramica, Dashboard, Reader, Esporta), **Autopilot** (In diretta, Configurazione), **Profili** (Direttore, Ghostwriter, Stile di valutazione, Lettori simulati) e **Strumenti** (Audit, Ricerche, Asset). **Impostazioni libro** sta in fondo al menu del libro, a parte, e il canone viene subito dopo. Il titolo di un gruppo lo apre e lo chiude: questo dispositivo ricorda i gruppi che hai chiuso, e il gruppo della pagina in cui sei è sempre aperto.
`,
  }),
  entry("first-book", "guides", {
    title: "Create your first book",
    summary: "GitHub account, PAT, repository creation and first book settings.",
    markdown: `# Create your first book

## 1. Create a GitHub account

Create an account at [github.com](https://github.com). Narrarium stores each book as a GitHub repository.

## 2. Create a fine-grained PAT

Open **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens**.

Choose the repositories the token can access and grant:

- Contents: read and write;
- Metadata: read.

Copy the token immediately. GitHub will not show it again.

## 3. Configure the token

In Narrarium open **Settings → GitHub** and save the token as the default PAT, or add a dedicated PAT while connecting a book.

## 4. Create or connect a book

Open **My Books → Add Book**. You can connect an existing Narrarium repository or create a new one. New books include book metadata, a selected default ghostwriter, evaluation style, standard simulated readers, plot, notes and the main directory structure.

## 5. Configure the book

Use **Book Settings** for the active branch, export metadata, paragraph separators, Drive destination and repository-specific credentials.
`,
  }, {
    title: "Crea il primo libro",
    summary: "Account GitHub, PAT, creazione repository e prime impostazioni del libro.",
    markdown: `# Crea il primo libro

## 1. Crea un account GitHub

Crea un account su [github.com](https://github.com). Narrarium salva ogni libro come repository GitHub.

## 2. Crea un PAT fine-grained

Apri **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens**.

Scegli i repository accessibili e assegna:

- Contents: read and write;
- Metadata: read.

Copia subito il token: GitHub non lo mostrerà una seconda volta.

## 3. Configura il token

In Narrarium apri **Impostazioni → GitHub** e salva il token come PAT predefinito, oppure aggiungi un PAT dedicato mentre colleghi il libro.

## 4. Crea o collega un libro

Apri **I miei libri → Aggiungi libro**. Puoi collegare un repository Narrarium esistente o crearne uno nuovo. I nuovi libri includono metadati, un ghostwriter predefinito selezionato, stile valutativo, lettori simulati standard, plot, note e struttura principale.

## 5. Configura il libro

Usa **Impostazioni libro** per branch attivo, metadati di export, separatori dei paragrafi, destinazione Drive e credenziali specifiche.
`,
  }),
  entry("github-sync", "guides", {
    title: "Git, branches and synchronization",
    summary: "Local working copy, clean/dirty state, commits, pulls, pushes and recovery.",
    markdown: `# Git, branches and synchronization

Narrarium clones the active branch into an IndexedDB working copy. Editing writes locally first when the working copy is available.

## Repository status

- **Clean:** no local changes or unpushed commits.
- **Local changes:** files changed but not committed.
- **Ahead:** local commits waiting for push.
- **Remote changed:** GitHub has commits that are not local yet.
- **Sync incomplete:** the local clone has not been fully verified.

## Full sync

Full Sync reconciles remote changes, preserves or commits local work when possible, and pushes according to the configured policy. Use the repository status dialog for explicit Fetch, Pull, Commit, Push, backup, reclone and repair operations.

## Branches and pull requests

Each book can select an active branch. Copilot and the Git dialogs can list branches, switch/create branches, inspect diffs and commits, and create pull requests.
`,
  }, {
    title: "Git, branch e sincronizzazione",
    summary: "Working copy locale, stati clean/dirty, commit, pull, push e recupero.",
    markdown: `# Git, branch e sincronizzazione

Narrarium clona il branch attivo in una working copy IndexedDB. Quando disponibile, le modifiche vengono scritte prima in locale.

## Stato repository

- **Pulito:** nessuna modifica locale o commit da pushare.
- **Modifiche locali:** file modificati ma non committati.
- **Avanti:** commit locali in attesa di push.
- **Remote cambiato:** GitHub contiene commit non ancora locali.
- **Sync incompleta:** il clone locale non è stato verificato completamente.

## Sync completo

Il Sync completo riconcilia le modifiche remote, preserva o committa il lavoro locale quando possibile e pusha secondo la policy configurata. Il dialog stato repository espone Fetch, Pull, Commit, Push, backup, reclone e riparazione.

## Branch e pull request

Ogni libro può scegliere un branch attivo. Copilot e i dialog Git possono elencare branch, cambiarli o crearli, mostrare diff e commit e aprire pull request.
`,
  }),
  entry("ai-router", "guides", {
    title: "AI integrations and Router",
    summary: "Configure providers, models, task routing, fallbacks, browser speech and costs.",
    markdown: `# AI integrations and Router

Narrarium uses your AI integrations. Add Azure OpenAI, OpenAI-compatible endpoints or GitHub Models in **Settings → AI Integrations**, which also holds keys, models, prices and default models. Then choose in **Settings → AI Router** which model handles each task.

## GitHub Models quick start

Create a GitHub PAT authorized for GitHub Models, add a **GitHub Models** integration in **AI Integrations**, load the model catalog and assign capabilities to the models you want to use.

## Reading the models of an endpoint

In the card of an **OpenAI / compatible** integration, two buttons next to the key work with the address and the key as they are written. They are not there for Azure OpenAI, GitHub Models or Microsoft 365 Copilot, which have no such list.

**Check the connection** asks the endpoint one short question, its list of models, and says in one line how fast it answered and how many models it lists («Responds in 120 ms · 6 models»), or what to correct: error 401 is the key, 404 an address that does not end with the version path (for example */v1*), 429 and 5xx an endpoint that is limiting requests or busy. When nothing answers, a browser cannot tell a server that is off from a wrong address or from a server that does not allow this site (CORS), and the line says so; the engine's own words are in the technical details. The error panel of the autopilot offers the same check, with the same result and a link to the card, on the integration of the step that failed, for network, authentication, timeout and provider failures; when the run is on your personal server, the check still asks from your browser.

**Read the models from the endpoint** opens a list of what the endpoint says it has, by kind (text, images, text-to-speech, transcription, embedding, other), with the context window, the largest answer and what each model can do (tool calls, streaming, reasoning, vision), and whether the integration already has it. It reads */models* (the list, needed) and, when the gateway has them, */models/details* and */modalities* (LlmProxy's: the limits, the capabilities and the kind of each model). Without them the dialog says «Only /models», lists every model as text and ticks none, because nothing says which of them chat.

Tick what to add or update and press **Add/update N models**. The new text models are ticked at first. A model you already have is updated only where it is empty (its limits and the capabilities the endpoint declares); what you wrote is never overwritten: your numbers, a capability you set (a switch turned off included), its roles, names, prices and Thinking parameter. A capability the endpoint does not declare is not turned into a restriction. A new model gets what the endpoint declares of it, and the first model of an integration that has none takes the default roles. For a name that the engine knows (Muse Glimmer today) the dialog suggests the **Thinking parameter** *chat_template_kwargs.reasoning_strength*, already ticked, and you can untick it before confirming. A model that is not for chat can be set as the image, text-to-speech or transcription model of the integration while that field is empty.

**Load models from API**, in the list of chat models, still works, for endpoints that answer in a simpler way.

## Task routing

**AI Router** has one table for each kind of task: **Text (chat)**, **Text-to-speech (TTS)**, **Speech-to-text (STT)** and **Images**. A table lists the endpoint (the integration) and the model of each task; the text table also has **Thinking**, and its first row, **Default**, is used by every task that has no route of its own. A row without a choice of its own shows, dimmed, what Narrarium would use. The privacy of fallbacks and the execution limits are in the box **Routing options**.

The tabs above a table are the **Primary** and the **fallbacks**, tried in order when the primary fails (rate limit, network). Every tab works the same way, with the same filters and the same group editing. **New tab** adds a fallback level, up to the maximum number of candidates in *Routing options*. **Swap with…** exchanges the targets of two tabs, thinking included, for the selected rows or, with nothing selected, for all of them; it tells what it did and offers **Undo**. The **…** menu moves a tab left or right (a swap with its neighbour) and deletes it, after asking how many rows lose it.

**Tools only for the autopilot** is the switch at the top of the page. With it on (the default) every agent of the autopilot (writer, director, readers, specialists, summaries) answers by calling its own function, and not with a JSON written in the message: a model marked as without tool calls is skipped, and a reply in text instead of the call is refused. When no model of a task can call a function, the autopilot stops with **The AI configuration needs fixing**, and the page lists those tasks under the switch. To use such a model, turn on **Forced tool calls** for it in **AI Integrations**, or turn the switch off.

**Thinking** is how hard a model is asked to think. *Low*, *Medium*, *High* and *Extra high* are sent to the provider; *Automatic* sends nothing; *Inherit from integration* takes the **Default thinking** set in the card of the integration in **AI Integrations**. The level of a route always wins over the integration's. The **Default** row has no level of its own, because it only chooses the endpoint of the tasks without a route: they use the one of the endpoint. A model that does not reason may refuse a level (error 400): choose *Automatic* for it.

## Editing many tasks at once

In the text table, filter by group (Autopilot, Copilot and actions, Review, Research), by name, or with **Only customized**. Tick the rows, or **Select all visible tasks**, and use the panel that appears: choose the **endpoint**, then the **model** (only models valid for every selected task), then the **thinking**, and press **Apply**. Nothing changes until you do. What you do not choose stays as it was, so you can change endpoint and model and leave the thinking, change only the model, or change everything. When the new endpoint does not have the model of a row, that row takes the first valid one and the message says so. A fallback needs a primary: rows without one are skipped, and the message says so too.

## Thinking

For chat tasks, **Thinking** is how much the model is asked to think before it answers (the provider's *reasoning_effort* setting). **Low** is fast; **High** and **Extra high** are slower and use more tokens. **Automatic** sends nothing, and a blank value takes the level of the integration. Each target has its own: the primary and every fallback. The Copilot sends a level only when it is explicit.

**Thinking parameter** is how the level reaches a model, and it is set per model, in the card of the integration in **AI Integrations**, next to **Forced tool calls**. By default the level goes as *reasoning_effort*, the OpenAI field. Muse Glimmer on llama.cpp takes it as *chat_template_kwargs.reasoning_strength* and ignores *reasoning_effort*: for a model with that name the card suggests it, and **Use it** applies it, never by itself. *none* sends no level to that model, and it does not turn thinking off. It works the same for the autopilot and for the Copilot, and the debug panel says when a level went as the argument of the chat template.

A model that cannot call tools is marked **no tool calls**: the structured steps of the autopilot cannot use it while *Tools only* is on.

Browser TTS and STT are virtual Router integrations and do not consume AI tokens.

## Timeouts and streaming

Every integration in **AI Integrations** has three settings that decide how long a slow model is given. The autopilot uses them, in the browser and on your personal server (they go with your AI configuration, so send it again after a change).

- **Provider timeout (ms)**: how long the provider may take to start answering. The minimum is 30,000 ms (a lower value is raised to it, and the setting keeps what you wrote) and empty means 600,000 ms (10 minutes). Copilot, voice and images count it as the time of the whole request instead, 60,000 ms when it is empty.
- **Idle timeout (ms)**: the longest silence between two pieces of a streamed reply, from 30,000 to 3,600,000 ms; empty means 600,000 ms. Every piece that arrives starts the count again, so a model that keeps writing is never cut off, however long it takes (one call lasts four hours at most). It is not used while Streaming is Off.
- **Streaming**: with **Automatic (recommended)** every reply of the autopilot arrives in pieces, the structured ones too, so a slow model is not cut off by a proxy or a tunnel that closes a connection that stays silent. Choose **Off** only if the provider refuses streamed replies together with function calls: its error is a 400 that mentions stream, and the message tells you to set **Streaming** of the integration to off. With Off the whole reply has to arrive within the provider timeout.

When a step fails because the response was too slow, the technical details of the error say which wait ran out and which of these settings to change. A personal server older than 0.1.7 does not know **Idle timeout (ms)** and **Streaming**: it waits as it always did until you update it (**Version and updates** in **Settings → Personal server**).

## Costs

When pricing is configured in AI Integrations, Narrarium records input, cached-input and output tokens plus media costs. Reader evaluations save their own provider/model/token/cost metadata while using the same cost engine.
`,
  }, {
    title: "Integrazioni AI e Router",
    summary: "Configura provider, modelli, task, fallback, voce browser e costi.",
    markdown: `# Integrazioni AI e Router

Narrarium usa le tue integrazioni AI. Aggiungi Azure OpenAI, endpoint compatibili OpenAI o GitHub Models in **Impostazioni → Integrazioni AI**, dove trovi anche chiavi, modelli, prezzi e modelli predefiniti. Poi scegli in **Impostazioni → AI Router** quale modello gestisce ogni task.

## Avvio rapido GitHub Models

Crea un PAT GitHub abilitato a GitHub Models, aggiungi un'integrazione **GitHub Models** in **Integrazioni AI**, carica il catalogo e assegna ai modelli le capability desiderate.

## Leggere i modelli di un endpoint

Nella scheda di un'integrazione **OpenAI / compatibile** due pulsanti accanto alla chiave lavorano con l'indirizzo e la chiave così come li hai scritti. Non ci sono per Azure OpenAI, GitHub Models e Microsoft 365 Copilot, che non hanno un elenco di questo tipo.

**Verifica la connessione** fa all'endpoint una domanda breve, il suo elenco di modelli, e dice in una riga quanto ci ha messo a rispondere e quanti modelli elenca («Risponde in 120 ms · 6 modelli»), o che cosa correggere: l'errore 401 è la chiave, il 404 un indirizzo che non finisce con il percorso della versione (per esempio */v1*), il 429 e i 5xx un endpoint che limita le richieste o è occupato. Quando nessuno risponde, un browser non sa distinguere un server spento da un indirizzo sbagliato o da un server che non ammette questo sito (CORS), e la riga lo dice; le parole del motore sono nei dettagli tecnici. Il pannello d'errore dell'autopilot offre la stessa verifica, con lo stesso risultato e il collegamento alla scheda, sull'integrazione del passo fallito, per gli errori di rete, di autenticazione, di timeout e del provider; se l'esecuzione è sul tuo server personale, la verifica parte comunque dal browser.

**Leggi i modelli dall'endpoint** apre un elenco di ciò che l'endpoint dice di avere, per tipo (testo, immagini, sintesi vocale, trascrizione, embedding, altro), con la finestra di contesto, la risposta massima e ciò che ogni modello sa fare (tool call, streaming, ragionamento, visione), e se l'integrazione lo ha già. Legge */models* (l'elenco, necessario) e, quando il gateway li ha, */models/details* e */modalities* (quelli di LlmProxy: i limiti, le capacità e il tipo di ogni modello). Senza di essi la finestra dice «Solo /models», elenca ogni modello come testo e non ne seleziona nessuno, perché niente dice quali conversano.

Seleziona cosa aggiungere o aggiornare e premi **Aggiungi/aggiorna N modelli**. I modelli di testo nuovi sono selezionati all'inizio. Un modello che hai già viene aggiornato solo dove è vuoto (i limiti e le capacità che l'endpoint dichiara); ciò che hai scritto non viene mai sovrascritto: i tuoi numeri, una capacità che hai impostato (anche un interruttore spento), i ruoli, i nomi, i prezzi e il Parametro del thinking. Una capacità che l'endpoint non dichiara non diventa una restrizione. Un modello nuovo prende ciò che l'endpoint dichiara, e il primo modello di un'integrazione che non ne ha prende i ruoli predefiniti. Per un nome che il motore conosce (oggi Muse Glimmer) la finestra suggerisce il **Parametro del thinking** *chat_template_kwargs.reasoning_strength*, già selezionato, e puoi togliere la spunta prima di confermare. Un modello che non è di chat può essere impostato come modello per le immagini, di sintesi vocale o di trascrizione dell'integrazione finché quel campo è vuoto.

**Carica modelli dall'API**, nell'elenco dei modelli chat, funziona ancora, per gli endpoint che rispondono in modo più semplice.

## Routing dei task

**AI Router** ha una tabella per ogni tipo di attività: **Testo (chat)**, **Sintesi vocale (TTS)**, **Trascrizione (STT)** e **Immagini**. Una tabella elenca endpoint (l'integrazione) e modello di ogni task; la tabella del testo ha anche il **Thinking**, e la sua prima riga, **Predefinito**, vale per ogni task senza una rotta propria. Una riga senza scelte proprie mostra, attenuato, ciò che Narrarium userebbe. La riservatezza dei fallback e i limiti di esecuzione sono nel riquadro **Opzioni di instradamento**.

Le schede sopra una tabella sono il **Primario** e i **fallback**, provati in ordine quando il primario fallisce (limite, rete). Ogni scheda funziona allo stesso modo, con gli stessi filtri e le stesse modifiche di gruppo. **Nuova scheda** aggiunge un livello di fallback, fino al numero massimo di candidati delle *Opzioni di instradamento*. **Scambia con…** scambia le destinazioni di due schede, thinking compreso, per le righe selezionate o, senza selezione, per tutte; dice cosa ha fatto e offre **Annulla**. Il menu **…** sposta una scheda a sinistra o a destra (uno scambio con la vicina) e la elimina, chiedendo prima quante righe la perdono.

**Solo tool per l'autopilot** è l'interruttore in cima alla pagina. Acceso (è il predefinito) ogni agente dell'autopilot (scrittore, direttore, lettori, specialisti, riassunti) risponde chiamando la propria funzione, e non con un JSON scritto nel messaggio: un modello segnato come senza tool call viene saltato, e una risposta in testo al posto della chiamata viene rifiutata. Quando nessun modello di un'attività sa chiamare funzioni, l'autopilot si ferma con **Configurazione dell'AI da correggere**, e la pagina elenca quelle attività sotto l'interruttore. Per usare un modello così attiva **Tool call forzati** per quel modello in **Integrazioni AI**, oppure spegni l'interruttore.

Il **Thinking** è quanto si chiede a un modello di ragionare. *Low*, *Medium*, *High* ed *Extra high* vengono inviati al provider; *Automatico* non invia nulla; *Eredita dall'integrazione* prende il **Thinking predefinito** impostato nella scheda dell'integrazione in **Integrazioni AI**. Il livello di una rotta vince sempre su quello dell'integrazione. La riga **Predefinito** non ha un livello suo, perché sceglie solo l'endpoint delle attività senza rotta: usano quello dell'endpoint. Un modello che non ragiona può rifiutare un livello (errore 400): per lui scegli *Automatico*.

## Modificare molte attività insieme

Nella tabella del testo filtra per gruppo (Autopilot, Copilot e azioni, Revisione, Ricerca), per nome o con **Solo personalizzate**. Spunta le righe, o **Seleziona tutte le attività visibili**, e usa il pannello che compare: scegli l'**endpoint**, poi il **modello** (solo quelli validi per tutte le attività scelte), poi il **thinking**, e premi **Applica**. Nulla cambia finché non lo fai. Ciò che non scegli resta com'era: puoi cambiare endpoint e modello lasciando il thinking, solo il modello, oppure tutto. Se il nuovo endpoint non ha il modello di una riga, quella riga prende il primo valido e il messaggio lo dice. Un fallback richiede un primario: le righe che non ce l'hanno vengono saltate, e anche questo il messaggio lo dice.

## Thinking

Per i task di chat, il **Thinking** è quanto si chiede al modello di ragionare prima di rispondere (il parametro *reasoning_effort* del provider). **Low** è rapido; **High** ed **Extra high** sono più lenti e usano più token. **Automatico** non invia nulla, e il valore vuoto prende il livello dell'integrazione. Ogni destinazione ha il proprio: il primario e ogni fallback. Il Copilot invia un livello solo quando è esplicito.

Il **Parametro del thinking** è il modo in cui il livello arriva a un modello, e si imposta per modello, nella scheda dell'integrazione in **Integrazioni AI**, accanto a **Tool call forzati**. Di norma il livello va come *reasoning_effort*, il campo di OpenAI. Muse Glimmer su llama.cpp lo prende come *chat_template_kwargs.reasoning_strength* e ignora *reasoning_effort*: per un modello con quel nome la scheda lo suggerisce, e **Usalo** lo applica, mai da sola. *none* non invia nessun livello a quel modello e non spegne il thinking. Vale allo stesso modo per l'autopilot e per il Copilot, e il pannello di debug dice quando un livello è andato come argomento del chat template.

Un modello che non può chiamare tool è segnato **senza tool call**: i passi strutturati dell'autopilot non possono usarlo finché *Solo tool* è attivo.

TTS e STT browser sono integrazioni virtuali del Router e non consumano token AI.

## Timeout e streaming

Ogni integrazione in **Integrazioni AI** ha tre impostazioni che decidono quanto tempo ha un modello lento. Le usa l'autopilot, nel browser e sul tuo server personale (viaggiano con la configurazione AI, quindi dopo una modifica inviala di nuovo).

- **Timeout provider (ms)**: quanto tempo può impiegare il provider per cominciare a rispondere (nei messaggi di errore si chiama *Provider timeout*). Il minimo è 30.000 ms (un valore più basso viene portato a quel minimo, e l'impostazione conserva quello che hai scritto) e vuoto significa 600.000 ms (10 minuti). Copilot, voce e immagini lo contano invece come tempo dell'intera richiesta, 60.000 ms se è vuoto.
- **Inattività massima (ms)**: il silenzio più lungo ammesso tra due pezzi di una risposta in streaming (nei messaggi di errore si chiama *Idle timeout*), da 30.000 a 3.600.000 ms; vuoto significa 600.000 ms. Ogni pezzo che arriva fa ripartire il conteggio, quindi un modello che continua a scrivere non viene mai interrotto, per quanto ci metta (una chiamata dura al massimo quattro ore). Non vale quando Streaming è Spento.
- **Streaming**: con **Automatico (consigliato)** ogni risposta dell'autopilot arriva a pezzi, anche quelle strutturate, così un modello lento non viene interrotto da un proxy o da un tunnel che chiude una connessione rimasta in silenzio. Scegli **Spento** solo se il provider rifiuta le risposte in streaming insieme alle chiamate di funzione: il suo errore è un 400 che parla di stream, e il messaggio ti dice di portare **Streaming** dell'integrazione su off. Con Spento l'intera risposta deve arrivare entro il timeout provider.

Quando un passo fallisce perché la risposta è stata troppo lenta, i dettagli tecnici dell'errore dicono quale attesa è scaduta e quale di queste impostazioni cambiare. Un server personale più vecchio della 0.1.7 non conosce **Inattività massima (ms)** e **Streaming**: aspetta come ha sempre fatto finché non lo aggiorni (**Versione e aggiornamenti** in **Impostazioni → Server personale**).

## Costi

Quando configuri i prezzi in Integrazioni AI, Narrarium registra token input, input in cache e output, oltre ai costi media. Le valutazioni dei lettori salvano provider, modello, token e costo usando lo stesso motore.
`,
  }),
  entry("book-structure", "reference", {
    title: "Books, chapters and paragraphs",
    summary: "Repository structure and the relationship between the main writing documents.",
    markdown: `# Books, chapters and paragraphs

The root **book.md** contains book metadata and description. Chapters live under **chapters/<number-slug>/** and every final paragraph is a numbered Markdown file.

## Chapter

A chapter contains chapter metadata, ordered final paragraphs, optional chapter writing-style override, resume and evaluation.

## Paragraph

A paragraph or scene contains frontmatter plus the final prose body. The paragraph page opens in reader mode; switch to Edit to change metadata and prose. Returning to reader mode asks whether to save or discard pending edits.

## Companion files

Paragraphs can have scripts, drafts, evaluations, reader evaluations and image assets. Reorder and deletion operations update managed companion paths.
`,
  }, {
    title: "Libri, capitoli e paragrafi",
    summary: "Struttura repository e relazione tra i principali documenti di scrittura.",
    markdown: `# Libri, capitoli e paragrafi

Il file root **book.md** contiene metadati e descrizione del libro. I capitoli vivono in **chapters/<numero-slug>/** e ogni paragrafo definitivo è un file Markdown numerato.

## Capitolo

Un capitolo contiene metadati, paragrafi definitivi ordinati, eventuale override dello stile, resume e valutazione.

## Paragrafo

Un paragrafo o scena contiene frontmatter e body di prosa definitivo. La pagina paragrafo si apre in modalità reader; passa a Modifica per cambiare metadati e prosa. Tornando al reader scegli se salvare o scartare le modifiche.

## File collegati

I paragrafi possono avere script, bozze, valutazioni, valutazioni lettore e asset immagine. Riordino e cancellazione aggiornano i percorsi gestiti.
`,
  }),
  entry("writing-workflow", "guides", {
    title: "Writing workflow",
    summary: "Scripts, drafts, final prose, ghostwriters and AI editing tools.",
    markdown: `# Writing workflow

Narrarium supports **Script → Draft → Final** for every scene.

- **Script:** structured scene beats, dialogue, actions, emotions, canon links and protected secrets.
- **Draft:** rough prose generated from the script or written manually.
- **Final:** definitive paragraph, optionally refined from the draft.

## Ghostwriters

The selected ghostwriter is the complete prose contract. Its profile defines voice, writing style, punctuation, tone, rhythm, dialogue and vocabulary. A book has a default profile, with optional chapter and paragraph selections.

## Selection tools

In registered editors, select text and use the context menu to improve, summarize or find synonyms. AI proposals use diff/confirmation flows before replacing text.
`,
  }, {
    title: "Flusso di scrittura",
    summary: "Script, bozze, prosa definitiva, ghostwriter e strumenti AI di editing.",
    markdown: `# Flusso di scrittura

Narrarium supporta **Script → Bozza → Definitivo** per ogni scena.

- **Script:** beat strutturati, dialoghi, azioni, emozioni, collegamenti canonici e segreti protetti.
- **Bozza:** prosa grezza generata dallo script o scritta manualmente.
- **Definitivo:** paragrafo finale, eventualmente rifinito dalla bozza.

## Ghostwriter

Il ghostwriter selezionato è il contratto completo della prosa. Il profilo definisce voce, stile di scrittura, punteggiatura, tono, ritmo, dialoghi e lessico. Il libro ha un profilo predefinito, con selezioni opzionali per capitolo e paragrafo.

## Strumenti sulla selezione

Negli editor registrati seleziona testo e usa il menu contestuale per migliorare, riassumere o trovare sinonimi. Le proposte AI usano diff e conferma prima della sostituzione.
`,
  }),
  entry("copilot-tools", "reference", {
    title: "Copilot, Fantasmino and tools",
    summary: "Text and voice assistants, Tool Registry, navigation, Git and local no-LLM actions.",
    markdown: `# Copilot, Fantasmino and tools

Copilot and the voice assistant share the same orchestration engine. The difference is the input/output channel.

## Tool Registry

Tools are discoverable and individually configurable under **Settings → Tools**. The orchestrator prefers local/no-LLM tools when possible and uses Router tasks only when generation or reasoning is required.

Capabilities include creation and editing, search, navigation, read-aloud, canon, research, notes, Git branches/diffs/commits/PRs, evaluations, reader personas and exports.

## Chat

Chat renders Markdown, streams conversational responses, supports Shift+Enter submission, formatted/Markdown copy, saving to notes and PDF/Markdown download or Drive upload.
`,
  }, {
    title: "Copilot, Fantasmino e tool",
    summary: "Assistente testuale e vocale, Tool Registry, navigazione, Git e azioni locali senza LLM.",
    markdown: `# Copilot, Fantasmino e tool

Copilot e assistente vocale condividono lo stesso motore di orchestrazione. Cambia soltanto il canale input/output.

## Tool Registry

I tool sono scopribili e configurabili singolarmente in **Impostazioni → Tools**. L'orchestrator preferisce tool locali/senza LLM quando possibile e usa il Router solo quando servono generazione o ragionamento.

Le capability includono creazione e modifica, ricerca, navigazione, lettura vocale, canone, research, note, branch/diff/commit/PR Git, valutazioni, Reader Persona ed export.

## Chat

La chat renderizza Markdown, mostra in streaming le risposte conversazionali, supporta invio con Shift+Invio, copia formattata/Markdown, salvataggio in nota e download o upload Drive in PDF/Markdown.
`,
  }),
  entry("canon-research", "reference", {
    title: "Canon, research and assets",
    summary: "Characters, locations, factions, items, secrets, timelines, deep research and images.",
    markdown: `# Canon, research and assets

Canon files cover Characters, Locations, Factions, Items, Secrets and Timeline events. Each entity has structured frontmatter, prose body and optional image assets.

## Dossier

The Dossier keeps a canon entry visible while writing. Entity mentions in reader prose can open rich canon details.

## Deep Research

Research routes by intent—news, encyclopedia or internet—through configured providers. Results are saved as Markdown and can be deepened, edited and promoted into canon.

## Assets

Book, chapter, paragraph and canon images use the repository asset tree. Prompts, generated images, captions and accessibility text remain versioned with the book.
`,
  }, {
    title: "Canone, ricerche e asset",
    summary: "Personaggi, luoghi, fazioni, oggetti, segreti, timeline, Deep Research e immagini.",
    markdown: `# Canone, ricerche e asset

I file canonici includono Personaggi, Luoghi, Fazioni, Oggetti, Segreti ed eventi Timeline. Ogni entità ha frontmatter strutturato, body descrittivo ed eventuali asset immagine.

## Dossier

Il Dossier mantiene un'entità visibile mentre scrivi. Le menzioni nel reader possono aprire i dettagli canonici.

## Deep Research

La ricerca usa intent news, enciclopedia o internet e li instrada ai provider configurati. I risultati vengono salvati come Markdown e possono essere approfonditi, modificati e promossi nel canone.

## Asset

Immagini di libro, capitolo, paragrafo e canone usano l'albero asset del repository. Prompt, immagini generate, caption e testo accessibile restano versionati col libro.
`,
  }),
  entry("evaluations-readers", "guides", {
    title: "Evaluations and simulated readers",
    summary: "Critical evaluation style, numeric scores, reader personas, separate evaluations and panel summaries.",
    markdown: `# Evaluations and simulated readers

## Editorial evaluations

The root **evaluation-guidelines.md** defines critical method, required sections and numeric criteria. Chapter and paragraph evaluations contain a discursive review plus forced-tool scores and explanations.

## Simulated readers

Narrarium provides standard readers—general, emotional, critical, character, plot, style, worldbuilding and continuity—plus twenty genre presets and custom profiles.

Reader Personas can be enabled, disabled, customized, duplicated, reset and ordered. Each reader writes one current evaluation file per target. Rerunning overwrites that file while preserving creation metadata and updating source hash, model, tokens and cost.

## Stale state and summaries

Evaluation source hashes identify outdated feedback after the source text changes. Panel summaries preserve consensus, disagreements, recurring strengths/problems and revision priorities without replacing individual evaluations.
`,
  }, {
    title: "Valutazioni e lettori simulati",
    summary: "Stile valutativo critico, punteggi, Reader Persona, valutazioni separate e sintesi del panel.",
    markdown: `# Valutazioni e lettori simulati

## Valutazioni editoriali

Il file root **evaluation-guidelines.md** definisce metodo critico, sezioni obbligatorie e criteri numerici. Le valutazioni di capitolo e paragrafo contengono review discorsiva più punteggi e motivazioni ottenuti con forced tool.

## Lettori simulati

Narrarium fornisce lettori generalista, emotivo, critico, orientato a personaggi, trama, stile, worldbuilding e continuità, oltre a venti preset di genere e profili custom.

Le Reader Persona possono essere abilitate, disabilitate, personalizzate, duplicate, ripristinate e ordinate. Ogni lettore scrive un solo file corrente per target. Il rerun sovrascrive quel file mantenendo data di creazione e aggiornando hash, modello, token e costo.

## Stato stale e sintesi

Gli hash sorgente identificano feedback non aggiornati dopo la modifica del testo. Le sintesi del panel mantengono convergenze, disaccordi, punti forti/problemi ricorrenti e priorità senza sostituire le valutazioni singole.
`,
  }),
  entry("outline", "guides", {
    title: "The Outline (Scaletta)",
    summary: "The plan of the book chapter by chapter: what the autopilot follows, how to edit it, and how to talk to the Copilot about it.",
    markdown: `# The Outline (Scaletta)

The Outline is the plan of the book, chapter by chapter: a rough description of the book and, for every chapter, a hypothetical title, what happens in it and, when it is not the book's, the ghostwriter that writes it. Open it from the book's menu (**Outline**). It lives in the files of the book (\`outline/book.md\` and one \`outline/chapters/<NNN>.md\` per chapter), so it travels with the book like everything else.

## The page

At the top, **The book**: a working title (optional: the book's own title stays in its settings) and the **Rough description of the book**. Below, one card per chapter with its **Hypothetical title**, **What happens** (plain text: the events, the turning points, who is there; not prose) and its **Ghostwriter**, where **The book's ghostwriter (default)** is the first choice.

Every card says in words, with an icon, what became of it: **Written by the autopilot, untouched**, **Yours**, **Chapter already written** (a link to the chapter), **Frozen chapter**, **Chapter approved**, or **Changed after the plan: the autopilot will plan it again**. A ghostwriter that does not exist, and a file the Outline cannot read, are said on the card.

The buttons of a card move it up or down (also with Alt+↑ and Alt+↓ inside the card), insert a chapter before or after it, or delete it. Deleting asks first: a chapter already written keeps its text in the book, and the autopilot does not delete it; **Renumber the following chapters** closes the gap. **Add a chapter at the end** is at the top of the page. After every action **Undo** takes it back exactly.

## Saving

What you type is saved when you choose **Save** on the card, or **Save all** (also Ctrl+S) for everything: until then the card says **Unsaved changes**, and leaving the page asks first. Nothing is saved while you type, on purpose: the autopilot plans a chapter again as soon as its entry changes. Every save is a commit of the book, published like the others. If the Outline changed elsewhere meanwhile (the autopilot, the Copilot, another tab), your text is kept and the page says so; **Reload the outline** shows the new version and discards what you had not saved.

## Long books

The page shows 50 chapters at a time, with **Previous** and **Next**. **Filter chapters…** finds chapters by number, title or what happens, and **Go to chapter** jumps to one. An Outline of 5000 chapters opens as fast as one of ten.

## An empty Outline

**Add the first chapter**, **Let the autopilot write it** (the autopilot's **Configuration** opens), or, when the brief has a chapter-by-chapter synopsis, **Convert the brief's synopsis**: the lines «Chapter 1: …» become chapters, the rest becomes the description, and you see everything before anything is written.

## What the autopilot does with it

The autopilot follows the Outline as binding: the same chapters, in the same order, with your titles and your events. When it plans, it fills the chapters that have no entry yet, as its own (**Written by the autopilot, untouched**), and never touches yours; as soon as you change an entry it wrote, the entry is yours. When you change the entry of a chapter it has not written yet, it plans that chapter again (**Replanning chapter N** in its history); when you delete one, the chapter leaves its plan and the following chapters keep their numbers. When you change the entry of a chapter it has already written and closed, it does what its **Configuration** says for a changed frozen chapter: by default it asks you what to do: **Rewrite the chapter to follow the Outline**, **Keep the text, update only the Outline** or **Mark as reviewed** (see *Frozen chapters* in the autopilot's help). The card says so before you save, and the page says it again once saved. A chapter takes the ghostwriter of its entry; one that does not exist is said, and the book's writes it. **Fill the Outline with the plan**, in the autopilot's **Configuration** (under **The book**), turns the filling off. The chapter-by-chapter synopsis of the brief still works, and where the two differ the Outline wins.

## The assistant in the text areas

The menu of a text area of the Outline (right click, or the round button on a touch screen) offers **Improve the entry**, **Summarize the entry**, **Develop this chapter** (events and key points consistent with the description, the nearby chapters and the canon) and **Check against the canon and the nearby chapters** (what does not hold). Each shows its answer first: **Apply** puts it in the card as an unsaved change, **Cancel** leaves the card as it was. Your custom actions for the book appear there too.

## Talking to the Copilot about it

On the Outline page and on the autopilot's pages, «chapter 3» means entry 3 of the Outline; on every other page of the book it means the written chapter 3. «Outline» or «scaletta» always means the Outline, wherever you are, and «the written chapter» or «the chapter's text» always means the chapter. When it is not clear, the Copilot asks which one. Its changes to the Outline are a proposal: nothing is written until you choose **Apply all file updates**, they are applied together and saved like the page's saves (**Undo assistant changes** takes them back), and every entry it writes is yours.
`,
  }, {
    title: "La Scaletta",
    summary: "Il piano del libro capitolo per capitolo: cosa segue l'autopilot, come modificarla e come parlarne al Copilot.",
    markdown: `# La Scaletta

La Scaletta è il piano del libro, capitolo per capitolo: una descrizione di massima del libro e, per ogni capitolo, un titolo ipotetico, cosa succede e, quando non è quello del libro, il ghostwriter che lo scrive. Aprila dal menu del libro (**Scaletta**). Vive nei file del libro (\`outline/book.md\` e un \`outline/chapters/<NNN>.md\` per capitolo), quindi viaggia con il libro come tutto il resto.

## La pagina

In alto, **Il libro**: un titolo di lavoro (facoltativo: il titolo vero del libro resta nelle sue impostazioni) e la **Descrizione di massima del libro**. Sotto, una scheda per capitolo con il **Titolo ipotetico**, **Cosa succede** (testo semplice: gli eventi, le svolte, chi c'è; non prosa) e il **Ghostwriter**, dove la prima scelta è **Ghostwriter del libro (predefinito)**.

Ogni scheda dice a parole, con un'icona, cosa ne è stato: **Scritto dall'autopilot, non toccato**, **Tuo**, **Capitolo già scritto** (con il collegamento al capitolo), **Capitolo congelato**, **Capitolo approvato**, oppure **Cambiato dopo il piano: l'autopilot lo ripianificherà**. Un ghostwriter che non esiste, e un file che la Scaletta non riesce a leggere, sono segnalati sulla scheda.

I pulsanti di una scheda la spostano su o giù (anche con Alt+↑ e Alt+↓ dentro la scheda), inseriscono un capitolo prima o dopo, oppure la eliminano. Prima di eliminare la pagina chiede conferma: un capitolo già scritto tiene il suo testo nel libro e l'autopilot non lo cancella; **Rinumera i capitoli successivi** chiude il vuoto. **Aggiungi un capitolo in fondo** è in cima alla pagina. Dopo ogni azione **Annulla** la riporta indietro esattamente.

## Salvare

Quello che scrivi si salva quando scegli **Salva** sulla scheda, oppure **Salva tutto** (anche Ctrl+S) per tutto: fino ad allora la scheda dice **Modifiche non salvate**, e lasciare la pagina chiede conferma. Di proposito nulla si salva mentre scrivi: l'autopilot ripianifica un capitolo appena la sua voce cambia. Ogni salvataggio è un commit del libro, pubblicato come gli altri. Se nel frattempo la Scaletta è cambiata altrove (l'autopilot, il Copilot, un'altra scheda), il tuo testo resta e la pagina lo dice; **Ricarica la Scaletta** mostra la versione nuova e scarta quello che non avevi salvato.

## Libri lunghi

La pagina mostra 50 capitoli alla volta, con **Precedenti** e **Successivi**. **Filtra capitoli…** trova i capitoli per numero, titolo o cosa succede, e **Vai al capitolo** salta a uno. Una Scaletta di 5000 capitoli si apre veloce come una di dieci.

## Una Scaletta vuota

**Aggiungi il primo capitolo**, **Lascia che la scriva l'autopilot** (si apre la **Configurazione** dell'autopilot) oppure, quando il brief ha una sinossi capitolo per capitolo, **Converti la sinossi del brief**: le righe «Capitolo 1: …» diventano capitoli, il resto diventa la descrizione, e vedi tutto prima che venga scritto qualcosa.

## Cosa ne fa l'autopilot

L'autopilot segue la Scaletta come vincolante: gli stessi capitoli, nello stesso ordine, con i tuoi titoli e i tuoi eventi. Quando pianifica riempie i capitoli che non hanno ancora una voce, come suoi (**Scritto dall'autopilot, non toccato**), e non tocca mai le tue; appena cambi una voce che ha scritto lui, la voce è tua. Quando cambi la voce di un capitolo che non ha ancora scritto, lo ripianifica (**Ripianificazione del capitolo N** nella sua cronologia); quando ne elimini una, il capitolo esce dal piano e i capitoli successivi mantengono il loro numero. Quando cambi la voce di un capitolo che ha già scritto e chiuso, fa quello che dice la sua **Configurazione** per un capitolo congelato modificato: di norma ti chiede cosa fare: **Riscrivi il capitolo secondo la Scaletta**, **Tieni il testo, aggiorna solo la Scaletta** oppure **Segna come rivisto** (vedi *Capitoli congelati* nell'aiuto dell'autopilot). La scheda lo dice prima che tu salvi, e la pagina lo ripete dopo il salvataggio. Un capitolo prende il ghostwriter della sua voce; uno che non esiste viene segnalato, e lo scrive quello del libro. **Riempi la Scaletta con il piano**, nella **Configurazione** dell'autopilot (in **Il libro**), spegne il riempimento. La sinossi capitolo per capitolo del brief funziona ancora, e dove le due differiscono vince la Scaletta.

## L'assistente nelle aree di testo

Il menu di un'area di testo della Scaletta (clic destro, o il pulsante rotondo su uno schermo touch) offre **Migliora la voce**, **Riassumi la voce**, **Sviluppa questo capitolo** (eventi e punti chiave coerenti con la descrizione, i capitoli vicini e il canone) e **Controlla con il canone e i capitoli vicini** (ciò che non torna). Ognuna mostra prima la risposta: **Applica** la mette nella scheda come modifica non salvata, **Annulla** lascia la scheda com'era. Lì compaiono anche le tue azioni personalizzate per il libro.

## Parlarne al Copilot

Nella pagina Scaletta e nelle pagine dell'autopilot, «capitolo 3» è la voce 3 della Scaletta; in tutte le altre pagine del libro è il capitolo 3 scritto. «Scaletta» o «outline» indica sempre la Scaletta, ovunque tu sia, e «il capitolo scritto» o «il testo del capitolo» indica sempre il capitolo. Quando non è chiaro, il Copilot chiede quale dei due. Le sue modifiche alla Scaletta sono una proposta: nulla viene scritto finché non scegli **Applica tutte le modifiche**, si applicano tutte insieme e si salvano come quelle della pagina (**Annulla modifiche dell'assistente** le riporta indietro), e ogni voce che scrive è tua.
`,
  }),
  entry("autopilot", "guides", {
    title: "Autopilot, director and personal server",
    summary: "Let the autopilot write while the director decides as your stand-in, follow it live, intervene, and run it on your own server.",
    markdown: `# Autopilot, director and personal server

The autopilot writes the book step by step: concept, chapter plan, scenes, simulated readers, specialists and the director's decisions. In the menu of a book its group has two pages: **Live**, what the autopilot is doing, and **Configuration**, its brief and its settings. **Autopilot** in the library shows every book.

## Start

Open **Configuration**, write an idea (one sentence is enough) or a binding chapter-by-chapter synopsis, choose chapters, scenes per chapter and words per scene, then **Start autopilot** at the bottom of the page: the autopilot starts and **Live** opens. A book that never started shows **Configure the autopilot** on its live page. When the book has an **Outline**, the autopilot follows it as binding, and it fills in the chapters the Outline does not have yet (see *The Outline (Scaletta)*). By default it pauses when the plan is ready: read it, then **Approve the plan and continue**. A book that already has chapters is continued after the last one.

## The configuration

**Configuration** has the brief and the settings in three parts. **The book** has the idea, the chapters, the scenes per chapter, the words per scene, the genre, the audience and the chapter-by-chapter synopsis (kept for compatibility: the **Outline** takes its place), and **Fill the Outline with the plan**. **Review** has the simulated readers and how many they are, their reactions to the plan, the specialists, the pause when the plan is ready, **Pause after every chapter**, the chapters per session, the two budgets and **When you change a frozen chapter** (see *Frozen chapters*). **Publishing**, for a book kept on GitHub, chooses where it is published: every step, every chapter or never. **Save settings** saves them while the autopilot is stopped. While it runs, only where it publishes, the pause after every chapter and what it does with a changed frozen chapter can change (they apply from the next step); the rest is locked and the page says why.

**Permanent rules** lists the rules you gave with **Intervene** → **From now on**: **Edit** changes one and **Remove** takes it away, also while the autopilot runs. A rule is at most 800 characters, and a rule that changed in the meantime (on another device, or with your answer to the director) is never overwritten: the page says so and shows it as it is now. A personal server older than 0.1.6 cannot change the rules: there they are only listed, with a note to update it. **Profiles used** leads to **Director**, **Ghostwriters**, **Evaluation style** and **Simulated readers**, each with its state: in the book, the defaults, or with problems. The **Danger zone** holds **Reset**, which asks before it forgets anything. The button at the bottom of the page, **Resume** for a book that is stopped, saves what you changed and starts the autopilot again.

## The director

The director is your stand-in. It approves the plan, decides on every finding of readers and specialists, scores each chapter and keeps standing guidance for the next ones. Configure it on the **Director** page (in **Profiles**, and in **Profiles used** of the configuration): persona, autonomy (decide alone, ask only on critical matters, or let you review the plan and every chapter), strictness, approval score, review rounds, priorities, taste, red lines and the weight of each simulated reader. The profile is saved in **director.md**.

On any book, chapter or scene, **Ask the director** gives its opinion, answers your question and can keep the opinion in **evaluations/director/**.

## The Autopilot page

**Live** is the page of what is happening. A band at the top of the page stays in sight while you scroll and says everything at a glance: whether the autopilot is running, paused, waiting for you, stopped by an error or finished (always with an icon and in words), where it runs (this browser or your personal server, and how long ago the server last made itself heard), what it is doing now and for how long (while the model answers a step that asks for a value, a line says «The model is answering…» with how much has arrived, in KB; nothing of the reply), how far the book has got, the phases, the steps of the chapter in progress (write, readers, specialists, director, fix) and, on one line, the cost and the tokens used against the budget. The quick commands are in the band too. When it has to wait for you, what it needs is right under the band: the director's question or a question about a chapter you changed, the error, the profile problems or the plan to approve.

Below that comes the history, **Everything that happened**: one list for the steps and for what happened around them. It is grouped by chapter and by round of the review (round 1 is everything up to the first judgement of the director; each judgement that asks for fixes starts a new round; the numbers of the rounds are the ones the plan recorded, so they stay right when the log has lost the first reviews of a chapter), and the header of a round gives the director's verdict and score when there is one; open the group to see what the readers gave and what the director decided in that round. The chapter in hand is open and the others are closed. The step in progress is not a row, because the band says what it is, but the text it is writing is at the top of the list. Open a step to see why it was done, what it wrote, the model, the tokens, the cost, the files it changed and the notes of the readers, the specialists and the director; a step that failed shows what kind of failure it was, with an icon and a word, and one that was repeated is one row with every attempt in it, each retry told in words. **All**, **Errors and warnings**, **Director**, **Readers** and **Writing** choose what the list shows (the choice is kept for as long as you work), **Hide until now** hides what is over, and a button at the end of a long group gives more rows. The notes of the runs (started, paused, stopped) are in the group where they happened. The log keeps the last 200 steps, and the notes of a step are there when this browser followed it.

On a wide screen the plan, **Intervene**, the rules and **Where it runs** sit in a second column; the rules are there to read, and **Edit the rules** leads to the configuration. On a narrower screen the page has four tabs, **Overview**, **Timeline**, **Plan** and **Rules**, and the **Plan** tab opens by itself while the plan waits for you. On a phone the band is short and the commands move to a bar at the bottom of the screen. **Configuration**, at the top of the page, leads to the brief and the settings.

When the autopilot is paused after closing a chapter, **Read chapter N** sits next to **Resume**. After an error the main button is **Retry**, and a panel under the band says what went wrong (see *When something goes wrong*). A finished book offers **Add chapters** (the configuration opens with the number of chapters ready to change), or **Write the new chapters** when the settings already ask for more chapters than the plan has, and a card under the band says how it went (see *The result of a finished book*).

## The result of a finished book

When the book is complete, a card under the band, **How the book turned out**, says how it went. It has the director's verdict on the whole book (the score, the verdict in words, approved or needs revision, and the director's own words, which you can read whole); the figures of the run (chapters, scenes, words, the working time the autopilot counted, and since when, for a book that was started before the count began; the cost, the tokens and the calls); and the scores by chapter: a picture of the final score of each chapter, and a table with the final score, the score of each round of the review (a round that sent the chapter back for fixes is marked with ↻) and the average of the readers. **Lowest score first** puts the weakest chapters on top, and a long book shows its first ten rows with a button for the rest. **Read these first** names the three chapters that need the most attention, the ones with the lowest scores or with many rounds of review, says why in one line and links to each. The card ends with **Read the book**, **Export**, **Ask the director** and **Add chapters**. A book written by an older version of the app has what its log still says (the verdict of the last review, the working time as *at least* for a long book) and nothing more: nothing is made up.

## When something goes wrong

When a step fails and the autopilot is going to try again, or when it stops on an error, one panel under the band says what happened. It has a title: Connection problem, Access refused by the provider, Too many requests, The response was too slow, Response cut off by the output limit, The provider refused the request, The book changed elsewhere, Budget reached, Limit reached, A profile file has problems, The AI configuration needs fixing, Provider error or Error. It says what that means, how many times the step failed in a row (said once, not once for each attempt) and where it happened: the endpoint, the model, the provider, the integration, the HTTP status and which retry. While the autopilot waits to try again by itself, a countdown says when the next attempt is; a screen reader is told only when it begins and when it ends. **Retry now** resumes the run, **Open AI Integrations** goes to where the key, the model and the limits are, an error that names a file of the book has **Open the file**, and **Copy diagnostics** copies a short text, with no key, no path of your computer and nothing of the book, to send to whoever helps you. The words of the provider are under **Technical details**. For a response that was too slow the panel says which limit ran out (waiting for the response to begin, silence between two pieces of it, or the total limit of 4 hours) and how long it was; the settings to change, **Provider timeout (ms)**, **Idle timeout (ms)** and **Streaming**, are in the card of the integration in **AI Integrations**. When the provider asks to wait (a rate limit), the panel says how long, next to the countdown. For **The AI configuration needs fixing** it names the models that were left out, **Open the AI Router** goes straight to the **Tools only** switch, and **Retry now** is not offered until the configuration has changed: it would give the same error.

## Follow and intervene

The **Autopilot** button next to Copilot opens a mini-player that stays open while you work on other pages: the state of the book, what it is doing now, how far it has got and its commands. Its **Live** tab lists the latest events of every book, one line each; the whole history is on the Autopilot page. On the Autopilot pages the page already shows all this, so the mini-player stays closed there and a small button brings it back, and its **Live** tab leaves out the events that the page lists. On a phone it never covers the buttons or the fields of the assistant. Copilot has an **Autopilot** tab too. You can pause after the current step or stop now, answer the director's questions, and, with **Intervene**, give instructions for the next step only, from now on, or to revise what is already written (the director picks the scenes to rewrite). Your instructions always win.

## Quick commands

A bar with the commands you reach for most is in the band of the Autopilot page (on a phone, in the bar at the bottom), in the **This book** tab of the mini-player, and above the latest events in its **Live** tab for the book in focus (the book you are in, else the only one that runs, else the one that worked last; when several run, choose the one to command with **Book**). Where the page is narrow, **GitHub** and **Runs on** are behind **More**. Every control says in words what it does and which book it commands, and one that is not available says why.

- **Pause after this step** is the main button. Its menu adds **Pause at the end of the chapter** (the autopilot goes on to the end of the chapter in progress, closes it and publishes it, then pauses) and **Cancel the pause** while one waits. A chip with a cross says what is waiting, and the cross takes it back. **Stop now** abandons the request in flight, and the provider may still bill it.
- **Run** does one step only, one chapter only, or goes on until you stop it. The limit is for that run: the next one has none unless you ask again.
- **GitHub**, for books kept on GitHub, chooses where the book is published: never, every chapter or every step. It changes from the next step, also while the autopilot runs, in the browser and on the server (the browser publishes every chapter unless you chose, the server every step). **Publish now** does it at once. It needs a GitHub token to use.
- **Runs on** passes the autopilot to the other side, the browser or your personal server: after this step, which is what you will want most of the time; now, when the step in progress is done again on the other side; or one step there, and then back. It starts on the other side only if it was running, and the way back goes on here only if it was. If anything goes wrong while the book is being moved (files changed on both sides, a server that cannot be reached, another operation holding the book) the book stays where it was, stopped, with the reason, and nothing is lost. If it goes wrong after the book has moved (the autopilot could not start there), the book is not moved back: the message says it is already on the other side. A quick switch never sends your keys or tokens by itself: when the server does not have your AI configuration or the book's GitHub token, it takes you to **Where it runs**, where you choose what to send. The plan lives in this tab, so closing it before the switch happens forgets the plan; a run that is already on the server goes on.

A server older than 0.1.5 does not know the pause at the end of the chapter, the limit of a run or the change of publishing during a run: those commands say so and stay off until you update the server.

## When the autopilot waits for you

Besides a question of the director, the autopilot can stop with **Waiting for you** because a profile file has a problem: the director, a ghostwriter or a simulated reader with YAML that cannot be read, or with a value nobody knows. It stops before spending anything, lists the problems, and replaces nothing with the defaults. It checks the **Evaluation style** (\`evaluation-guidelines.md\`) the same way. Correct the files in **Director**, **Ghostwriters**, **Simulated readers** or **Evaluation style** (each page shows what it could not read, and asks before you save over the file), then choose **Resume**: the files are checked again. If a step stops because a chapter, scene or canon file has front matter that cannot be read, the error names the file and the line: correct it and resume.

## Frozen chapters

A chapter is **frozen** when the director approves it, or when you freeze it yourself with **Freeze chapter** on its page: it keeps a record of its text, and the page says **Frozen on** the day **by the autopilot** or **by you**. **Unfreeze chapter** takes the record away, after asking.

When you change a frozen chapter, the page of the chapter (and of its scenes) says so under the text, with three choices: **Review and update the book from this change** (the director reads the chapter again and the autopilot updates the later chapters that no longer fit; your text is not rewritten), **Only a review of the chapter**, and **Mark as reviewed** (frozen again as it is, with no AI call). A choice that calls the AI waits in a queue, and the autopilot carries it out at its next run: **Start now** starts it. The band of **Live** and the mini-player say how many frozen chapters changed, and **Live** lists the decisions that wait.

What the autopilot does when it finds a change is chosen in **Configuration** → **Review** → **When you change a frozen chapter**: **Ask me every time** (the default: it stops before spending anything and asks on **Live**, with the same choices as buttons; your own words instead start a review that calls the AI, with them as a note for the director), **Review automatically** (it says so in the history), or **Only report it**. The choice can change while it runs. Nothing starts by itself unless you choose **Review automatically**.

When you change the Outline entry of a chapter already written, the autopilot asks in the same way what to do: **Rewrite the chapter to follow the Outline**, **Keep the text, update only the Outline** or **Mark as reviewed**. A proposal of Copilot that changes the text of a frozen chapter says what will happen once you apply it. Copilot and the apps connected through the book's MCP server never freeze or unfreeze a chapter: what they change in a frozen chapter keeps it frozen, and you decide about it as about your own changes. On a personal server, frozen chapters need version 0.1.9 or newer: with an older one the pages say to update it.

## Budgets and costs

Each book can have a money budget (it needs the prices of your models in AI Integrations) and a **token budget** (it works with every model, even without prices), both in **Review** of the configuration; 0 means no limit. The autopilot stops before the next call once a budget is reached. The cost line of the band says how many calls had no token count or no price, so you know how much of the totals is an estimate.

## Personal server

Run \`npx narrarium-server\` on the computer that will keep your books (Node.js 22.14 or newer). It installs a copy verified on npm and opens an admin panel at \`http://127.0.0.1:24243\` on that computer; \`npx narrarium-server admin-code\` shows the code to sign in.

1. In the admin panel choose **Generate a pairing code**.
2. In **Settings → Personal server** type the nine digits and choose **Pair**, then approve the request in the admin panel. Tick **allow updates** if this device may update the server.
3. Send your AI configuration and approve its AI endpoints in the admin panel.
4. On the **Live** page of a book's autopilot, in **Where it runs**, choose **Move to my server**: the autopilot keeps working with the browser closed. GitHub books travel through GitHub; local books are synced file by file.

Narrarium checks the server's signed identity at every connection and refuses a server whose key changed. **Version and updates** in the same settings page shows when a newer verified release exists and installs it: the server stops, installs the package after checking its npm signature and provenance, and restarts; if anything fails the previous version stays. To use the server from other devices, publish it over HTTPS, for example with the Cloudflare connector in its admin panel.

While you pair, the page shows four digits: check that the admin panel shows the same ones next to the request, and cancel if it does not. If the server and the app speak different versions, a notice says which one to update. **Disconnect** signs the device out on the server before it forgets the token. A sync that leaves files out (too large, not text, not a safe path) lists them with the reason instead of saying everything is synced.

## AI router

Route the **Autopilot** and **Director** tasks in **Settings → AI Router**; the **Autopilot** group of the text table lists every task the autopilot uses. Readers use **Reader evaluation**, specialists use **Review**. Tasks without a route use models tagged default.
`,
  }, {
    title: "Autopilot, direttore e server personale",
    summary: "Lascia scrivere l'autopilot mentre il direttore decide al posto tuo, seguilo in diretta, intervieni e fallo girare sul tuo server.",
    markdown: `# Autopilot, direttore e server personale

L'autopilot scrive il libro passo dopo passo: concept, piano dei capitoli, scene, lettori simulati, specialisti e decisioni del direttore. Nel menu di un libro il suo gruppo ha due pagine: **In diretta**, cosa sta facendo l'autopilot, e **Configurazione**, il suo brief e le sue impostazioni. **Autopilot** nella libreria mostra tutti i libri.

## Avvio

Apri **Configurazione**, scrivi un'idea (basta una frase) oppure una sinossi capitolo per capitolo vincolante, scegli capitoli, scene per capitolo e parole per scena, poi **Avvia l'autopilot** in fondo alla pagina: l'autopilot parte e si apre **In diretta**. Un libro che non è mai partito mostra **Configura l'autopilot** nella sua pagina In diretta. Quando il libro ha una **Scaletta**, l'autopilot la segue come vincolante e riempie i capitoli che la Scaletta non ha ancora (vedi *La Scaletta*). Di norma si ferma quando il piano è pronto: rileggilo, poi **Approva il piano e continua**. Un libro che ha già capitoli prosegue dopo l'ultimo.

## La configurazione

**Configurazione** ha il brief e le impostazioni in tre parti. **Il libro** ha l'idea, i capitoli, le scene per capitolo, le parole per scena, il genere, il pubblico e la sinossi capitolo per capitolo (resta per compatibilità: al suo posto c'è la **Scaletta**), e **Riempi la Scaletta con il piano**. **Revisione** ha i lettori simulati e quanti sono, le loro reazioni al piano, gli specialisti, la pausa quando il piano è pronto, **Fermati dopo ogni capitolo**, i capitoli per sessione, i due budget e **Quando modifichi un capitolo congelato** (vedi *Capitoli congelati*). **Pubblicazione**, per un libro su GitHub, sceglie dove si pubblica: a ogni passo, a ogni capitolo o mai. **Salva impostazioni** le salva mentre l'autopilot è fermo. Mentre lavora si possono cambiare solo dove pubblica, la pausa dopo ogni capitolo e cosa fa con un capitolo congelato modificato (valgono dal prossimo passo); il resto è bloccato e la pagina dice perché.

**Regole permanenti** elenca le regole che hai dato con **Intervieni** → **D'ora in poi**: **Modifica** ne cambia una e **Rimuovi** la toglie, anche mentre l'autopilot lavora. Una regola ha al massimo 800 caratteri, e una regola cambiata nel frattempo (su un altro dispositivo, o con la tua risposta al direttore) non viene mai sovrascritta: la pagina lo dice e la mostra com'è adesso. Un server personale più vecchio della 0.1.6 non sa cambiare le regole: lì sono solo elencate, con l'invito ad aggiornarlo. **Profili usati** porta a **Direttore**, **Ghostwriter**, **Stile di valutazione** e **Lettori simulati**, ognuno con il suo stato: nel libro, predefinito o con problemi. La **Zona pericolosa** contiene **Azzera**, che chiede conferma prima di dimenticare qualcosa. Il pulsante in fondo alla pagina, **Riprendi** per un libro fermo, salva ciò che hai cambiato e fa ripartire l'autopilot.

## Il direttore

Il direttore ti sostituisce. Approva il piano, decide su ogni rilievo di lettori e specialisti, dà un voto a ogni capitolo e conserva indicazioni per i successivi. Configuralo nella pagina **Direttore** (in **Profili**, e in **Profili usati** della configurazione): personalità, autonomia (decide da solo, chiede solo le questioni critiche, oppure ti fa rileggere piano e capitoli), severità, voto di approvazione, giri di revisione, priorità, gusto, linee rosse e peso di ogni lettore simulato. Il profilo è salvato in **director.md**.

Su qualsiasi libro, capitolo o scena, **Chiedi al direttore** restituisce il suo parere, risponde alla tua domanda e può conservare il parere in **evaluations/director/**.

## La pagina Autopilot

**In diretta** è la pagina di ciò che succede. In cima alla pagina una fascia resta in vista mentre scorri e dice tutto a colpo d'occhio: se l'autopilot sta lavorando, è in pausa, aspetta te, si è fermato per un errore o ha finito (sempre con un'icona e a parole), dove gira (questo browser o il tuo server personale e, per il server, da quanto tempo non si fa sentire), cosa sta facendo adesso e da quanto (mentre il modello risponde a un passo che chiede un valore, una riga dice «Il modello sta rispondendo…» con quanto è arrivato, in KB; nulla della risposta), a che punto è il libro, le fasi, i passi del capitolo in corso (scrittura, lettori, specialisti, direttore, correzioni) e, in una riga, il costo e i token usati rispetto al budget. Nella fascia ci sono anche i comandi rapidi. Se deve aspettare te, ciò che serve sta subito sotto la fascia: la domanda del direttore o una domanda su un capitolo che hai modificato, l'errore, i problemi di un profilo o il piano da approvare.

Più sotto c'è la cronologia, **Tutto ciò che è successo**: un'unica lista per i passi e per ciò che è successo intorno a loro. È raggruppata per capitolo e per giro di revisione (il giro 1 è tutto fino al primo giudizio del direttore; ogni giudizio che chiede correzioni apre un nuovo giro; i numeri dei giri sono quelli che il piano ha registrato, quindi restano giusti anche quando il registro ha perso le prime revisioni di un capitolo), e l'intestazione di un giro riporta il verdetto e il voto del direttore quando ci sono; apri il gruppo per vedere cosa hanno dato i lettori e cosa ha deciso il direttore in quel giro. Il capitolo in corso è aperto e gli altri sono chiusi. Il passo in corso non è una riga, perché lo dice la fascia, ma il testo che sta scrivendo è in cima alla lista. Apri un passo per vedere perché è stato fatto, cosa ha scritto, il modello, i token, il costo, i file modificati e le note di lettori, specialisti e direttore; un passo che è fallito mostra che tipo di errore è stato, con un'icona e una parola, e uno che è stato ripetuto è una sola riga con dentro ogni tentativo, e ogni ripetizione è raccontata a parole. **Tutto**, **Errori e avvisi**, **Direttore**, **Lettori** e **Scrittura** scelgono cosa mostra la lista (la scelta resta finché lavori), **Nascondi fino a ora** nasconde ciò che è finito, e un pulsante in fondo a un gruppo lungo mostra altre righe. Le note delle esecuzioni (partita, in pausa, fermata) stanno nel gruppo in cui sono successe. Il registro conserva gli ultimi 200 passi, e le note di un passo ci sono se questo browser lo ha seguito.

Su uno schermo largo il piano, **Intervieni**, le regole e **Dove gira** stanno in una seconda colonna; le regole sono lì da leggere, e **Modifica le regole** porta alla configurazione. Su uno schermo più stretto la pagina ha quattro schede, **Panoramica**, **Cronologia**, **Piano** e **Regole**, e la scheda **Piano** si apre da sola mentre il piano aspetta te. Sul telefono la fascia è corta e i comandi passano in una barra in fondo allo schermo. **Configurazione**, in cima alla pagina, porta al brief e alle impostazioni.

Quando l'autopilot è in pausa dopo aver chiuso un capitolo, **Leggi il capitolo N** sta accanto a **Riprendi**. Dopo un errore il pulsante principale è **Riprova**, e un pannello sotto la fascia dice cosa è andato storto (vedi *Quando qualcosa va storto*). Un libro finito propone **Aggiungi capitoli** (si apre la configurazione con il numero di capitoli pronto da cambiare), oppure **Scrivi i nuovi capitoli** quando le impostazioni ne chiedono già più di quanti ne ha il piano, e una scheda sotto la fascia dice com'è andata (vedi *Il risultato di un libro finito*).

## Il risultato di un libro finito

Quando il libro è completo, una scheda sotto la fascia, **Com'è venuto il libro**, dice com'è andata. C'è il verdetto del direttore sull'intero libro (il voto, il verdetto a parole, approvato o da rivedere, e le parole del direttore, che puoi leggere per intero); i numeri della corsa (capitoli, scene, parole, il tempo di lavoro che l'autopilot ha contato, e da quando, per un libro iniziato prima che il conteggio cominciasse; il costo, i token e le chiamate); e i voti per capitolo: un'immagine del voto finale di ogni capitolo e una tabella con il voto finale, il voto di ogni giro di revisione (un giro che ha rimandato il capitolo per le correzioni è segnato con ↻) e la media dei lettori. **Prima i voti più bassi** mette in cima i capitoli più deboli, e un libro lungo mostra le prime dieci righe con un pulsante per il resto. **Da leggere per primi** indica i tre capitoli che chiedono più attenzione, quelli con i voti più bassi o con molti giri di revisione, dice il perché in una riga e collega a ciascuno. La scheda finisce con **Leggi il libro**, **Esporta**, **Chiedi al direttore** e **Aggiungi capitoli**. Un libro scritto da una versione più vecchia dell'app ha ciò che il suo registro ancora dice (il verdetto dell'ultima revisione, il tempo di lavoro come *almeno* per un libro lungo) e niente di più: nulla è inventato.

## Quando qualcosa va storto

Quando un passo fallisce e l'autopilot sta per riprovare, o quando si ferma per un errore, un solo pannello sotto la fascia dice cosa è successo. Ha un titolo: Problema di connessione, Accesso rifiutato dal provider, Troppe richieste, Risposta troppo lenta, Risposta troncata dal limite di output, Il provider ha rifiutato la richiesta, Il libro è cambiato altrove, Budget raggiunto, Limite raggiunto, Un file del profilo ha problemi, Configurazione dell'AI da correggere, Errore del provider o Errore. Dice cosa significa, quante volte di fila il passo non è riuscito (detto una volta sola, non una per ogni tentativo) e dove è successo: l'indirizzo, il modello, il provider, l'integrazione, lo stato HTTP e quale tentativo era. Mentre l'autopilot aspetta per riprovare da solo, un conto alla rovescia dice quando parte il prossimo tentativo; un lettore di schermo lo sente solo quando comincia e quando finisce. **Riprova ora** riprende la corsa, **Apri le integrazioni AI** porta dove stanno la chiave, il modello e i limiti, un errore che nomina un file del libro ha **Apri il file**, e **Copia la diagnostica** copia un breve testo, senza chiavi, senza percorsi del tuo computer e senza nulla del libro, da mandare a chi ti aiuta. Le parole del provider sono sotto **Dettagli tecnici**. Per una risposta troppo lenta il pannello dice quale limite è scaduto (l'attesa dell'inizio della risposta, il silenzio tra due pezzi, o il tetto totale di 4 ore) e quanto durava; le impostazioni da cambiare, **Timeout provider (ms)**, **Inattività massima (ms)** e **Streaming**, sono nella scheda dell'integrazione in **Integrazioni AI**. Quando il provider chiede di aspettare (un limite di richieste), il pannello dice quanto, accanto al conto alla rovescia. Per **Configurazione dell'AI da correggere** nomina i modelli lasciati fuori, **Apri il Router AI** porta dritto all'interruttore **Solo tool**, e **Riprova ora** non viene offerto finché la configurazione non è cambiata: darebbe lo stesso errore.

## Seguire e intervenire

Il pulsante **Autopilot** accanto a Copilot apre un mini-player che resta aperto mentre lavori nelle altre pagine: lo stato del libro, cosa sta facendo adesso, a che punto è e i suoi comandi. La scheda **In diretta** elenca gli ultimi eventi di tutti i libri, uno per riga; la cronologia completa è nella pagina Autopilot. Nelle pagine dell'autopilot la pagina mostra già tutto questo, quindi lì il mini-player resta chiuso e un piccolo pulsante lo riporta, e la sua scheda **In diretta** lascia fuori gli eventi che la pagina elenca. Sul telefono non copre mai i pulsanti né i campi dell'assistente. Anche Copilot ha una scheda **Autopilot**. Puoi mettere in pausa dopo il passo corrente o fermare subito, rispondere alle domande del direttore e, con **Intervieni**, dare istruzioni solo per il prossimo passo, d'ora in poi, oppure per rivedere quanto già scritto (il direttore sceglie le scene da riscrivere). Le tue istruzioni vincono sempre.

## Comandi rapidi

Una barra con i comandi che usi di più sta nella fascia della pagina Autopilot (sul telefono, nella barra in fondo allo schermo), nella scheda **Questo libro** del mini-player e sopra gli ultimi eventi della sua scheda **In diretta**, per il libro a fuoco (il libro in cui sei, altrimenti l'unico che gira, altrimenti quello che ha lavorato per ultimo; se girano più libri, scegli quale comandare con **Libro**). Dove la pagina è stretta, **GitHub** e **Gira su** stanno dietro **Altro**. Ogni controllo dice a parole cosa fa e quale libro comanda, e uno che non è disponibile dice perché.

- **Pausa dopo questo passo** è il pulsante principale. Nel suo menu trovi **Pausa a fine capitolo** (l'autopilot prosegue fino alla fine del capitolo in corso, lo chiude e lo pubblica, poi si ferma) e **Annulla la pausa** finché una è in attesa. Un'etichetta con una croce dice cosa è in attesa, e la croce lo annulla. **Ferma subito** abbandona la richiesta in corso: il provider potrebbe comunque addebitarla.
- **Esegui** fa un solo passo, un solo capitolo, oppure va avanti finché non lo fermi. Il limite vale per quella sessione: la prossima non ne ha, a meno che tu lo chieda di nuovo.
- **GitHub**, per i libri su GitHub, sceglie dove si pubblica il libro: mai, a ogni capitolo o a ogni passo. Cambia dal prossimo passo, anche mentre l'autopilot lavora, nel browser e sul server (il browser pubblica a ogni capitolo, salvo tua scelta, il server a ogni passo). **Pubblica ora** lo fa subito. Serve un token GitHub utilizzabile.
- **Gira su** passa l'autopilot all'altra parte, il browser o il tuo server personale: dopo questo passo, che è ciò che vorrai quasi sempre; subito, e il passo in corso viene rifatto dall'altra parte; oppure un passo là e poi di nuovo qui. Ripartire dall'altra parte succede solo se girava, e il ritorno prosegue qui solo se girava. Se qualcosa va storto mentre il libro si sposta (file cambiati da entrambe le parti, un server irraggiungibile, un'altra operazione che tiene il libro) il libro resta dov'era, fermo, con il motivo, e non si perde nulla. Se va storto dopo che il libro si è spostato (l'autopilot non è riuscito a partire là), il libro non viene riportato indietro: il messaggio dice che è già dall'altra parte. Un passaggio rapido non invia mai da solo le tue chiavi o i tuoi token: se il server non ha la tua configurazione AI o il token GitHub del libro, ti porta in **Dove gira**, dove scegli cosa inviare. Il piano vive in questa scheda: chiuderla prima che il passaggio avvenga fa dimenticare il piano; una corsa già sul server continua.

Un server più vecchio della 0.1.5 non conosce la pausa a fine capitolo, il limite di una sessione né il cambio di pubblicazione durante una sessione: quei comandi lo dicono e restano spenti finché non aggiorni il server.

## Quando l'autopilot aspetta te

Oltre a una domanda del direttore, l'autopilot può fermarsi con **Aspetta te** perché un file di profilo ha un problema: il direttore, un ghostwriter o un lettore simulato con un YAML che non si legge, o con un valore che nessuno conosce. Si ferma prima di spendere qualsiasi cosa, elenca i problemi e non sostituisce nulla con i valori predefiniti. Controlla allo stesso modo lo **Stile di valutazione** (\`evaluation-guidelines.md\`). Correggi i file in **Direttore**, **Ghostwriter**, **Lettori simulati** o **Stile di valutazione** (ogni pagina mostra ciò che non ha saputo leggere e chiede conferma prima che tu salvi sopra il file), poi scegli **Riprendi**: i file vengono controllati di nuovo. Se un passo si ferma perché un capitolo, una scena o un file di canone ha un frontmatter che non si legge, l'errore indica il file e la riga: correggila e riprendi.

## Capitoli congelati

Un capitolo è **congelato** quando il direttore lo approva, oppure quando lo congeli tu con **Congela capitolo** nella sua pagina: conserva una traccia del suo testo, e la pagina dice **Congelato il** giorno **dall'autopilot** oppure **da te**. **Scongela capitolo** toglie la traccia, dopo averlo chiesto.

Quando modifichi un capitolo congelato, la pagina del capitolo (e delle sue scene) lo dice sotto il testo, con tre scelte: **Rivedi e aggiorna il libro da questa modifica** (il direttore rilegge il capitolo e l'autopilot aggiorna i capitoli successivi che non tornano più; il tuo testo non viene riscritto), **Solo una review del capitolo** e **Segna come rivisto** (congelato di nuovo così com'è, senza chiamate all'AI). Una scelta che chiama l'AI resta in coda, e l'autopilot la porta a termine alla sua prossima esecuzione: **Avvia ora** la fa partire. La fascia di **In diretta** e il mini-player dicono quanti capitoli congelati sono stati modificati, e **In diretta** elenca le decisioni in attesa.

Cosa fa l'autopilot quando trova una modifica si sceglie in **Configurazione** → **Revisione** → **Quando modifichi un capitolo congelato**: **Chiedimi ogni volta** (di norma: si ferma prima di spendere qualsiasi cosa e chiede in **In diretta**, con le stesse scelte come pulsanti; un tuo testo invece avvia una revisione che chiama l'AI, con le tue parole come nota per il direttore), **Rivedi in automatico** (lo dice nella cronologia) oppure **Solo segnala**. La scelta si può cambiare anche mentre lavora. Nulla parte da solo, a meno che tu scelga **Rivedi in automatico**.

Quando cambi la voce della Scaletta di un capitolo già scritto, l'autopilot chiede allo stesso modo cosa fare: **Riscrivi il capitolo secondo la Scaletta**, **Tieni il testo, aggiorna solo la Scaletta** oppure **Segna come rivisto**. Una proposta del Copilot che modifica il testo di un capitolo congelato dice cosa succederà dopo che l'avrai applicata. Il Copilot e le app collegate con il server MCP del libro non congelano né scongelano mai un capitolo: quello che cambiano in un capitolo congelato lo lascia congelato, e ne decidi tu come per le tue modifiche. Su un server personale i capitoli congelati richiedono la versione 0.1.9 o successiva: con una più vecchia le pagine invitano ad aggiornarlo.

## Budget e costi

Ogni libro può avere un budget in denaro (richiede i prezzi dei tuoi modelli in Integrazioni AI) e un **budget in token** (vale con qualsiasi modello, anche senza prezzi), entrambi in **Revisione** della configurazione; 0 significa nessun limite. L'autopilot si ferma prima della chiamata successiva quando un budget è raggiunto. La riga del costo nella fascia dice quante chiamate non avevano il conteggio dei token o il prezzo, così sai quanta parte dei totali è una stima.

## Server personale

Esegui \`npx narrarium-server\` sul computer che custodirà i tuoi libri (Node.js 22.14 o successivo). Installa una copia verificata su npm e apre un pannello di amministrazione su \`http://127.0.0.1:24243\` su quel computer; \`npx narrarium-server admin-code\` mostra il codice per accedere.

1. Nel pannello di amministrazione scegli **Genera un codice di abbinamento**.
2. In **Impostazioni → Server personale** digita le nove cifre e scegli **Abbina**, poi approva la richiesta nel pannello. Spunta **consenti aggiornamenti** se questo dispositivo può aggiornare il server.
3. Invia la configurazione AI e approva i suoi endpoint AI nel pannello di amministrazione.
4. Nella pagina **In diretta** dell'autopilot di un libro, in **Dove gira**, scegli **Sposta sul mio server**: l'autopilot continua anche a browser chiuso. I libri GitHub viaggiano tramite GitHub; quelli locali sono sincronizzati file per file.

Narrarium verifica l'identità firmata del server a ogni connessione e rifiuta un server la cui chiave è cambiata. **Versione e aggiornamenti** nella stessa pagina delle impostazioni mostra quando esiste una release verificata più recente e la installa: il server si ferma, installa il pacchetto dopo averne verificato firma npm e provenienza, e riparte; se qualcosa va storto resta la versione precedente. Per usare il server da altri dispositivi pubblicalo in HTTPS, per esempio con il connettore Cloudflare del suo pannello di amministrazione.

Mentre abbini, la pagina mostra quattro cifre: controlla che il pannello di amministrazione mostri le stesse accanto alla richiesta, e annulla se non è così. Se server e app parlano versioni diverse, un avviso dice quale aggiornare. **Scollega** disconnette il dispositivo sul server prima di dimenticare il token. Una sincronizzazione che lascia fuori dei file (troppo grandi, non di testo, percorso non sicuro) li elenca con il motivo invece di dire che è tutto sincronizzato.

## Router AI

Instrada i task **Autopilot** e **Direttore** in **Impostazioni → AI Router**; il gruppo **Autopilot** della tabella del testo elenca tutti i task che l'autopilot usa. I lettori usano **Valutazione lettore**, gli specialisti **Revisione**. I task senza instradamento usano i modelli con capability predefinita.
`,
  }),
  entry("book-mcp", "guides", {
    title: "MCP server of a book",
    summary: "Let Claude Code, Cursor, VS Code, ChatGPT or Claude.ai read and edit a book on your personal server, and see which apps are connected.",
    markdown: `# MCP server of a book

Every book on your personal server can have its own **MCP server**: an address of the server (\`/mcp/<name>\`) where an assistant such as Claude Code, Cursor, VS Code, ChatGPT or Claude.ai reads the book and edits it with tools like the Narrarium Copilot's (the [Model Context Protocol](https://modelcontextprotocol.io)). It is off for every book until you switch it on, one book at a time.

## Where it is

Open the book and go to **Book settings**: the **MCP server** section is at the bottom of the page. What you change there applies at once on the server, without **Save**. The section is for a book that is on your personal server (move it there from **Where it runs**, on the **Live** page of its autopilot); for any other book it has one line with the way to **Settings** → **Personal server**. A server too old for it says so: update it from the same settings.

## Switch it on

Turn on **MCP server for this book**. The section then shows the **Address** of the book, with a button that copies it, and its **Address name**, the last part of the address: lowercase letters, digits and single hyphens, up to 80 characters. **Change the address** gives it another name; if the server refuses one (another book has it, or it is not a valid name), the field says why.

Switching it off, or changing the address, **disconnects every app** connected to the book: each has to ask you again, and every assistant needs the new address. The page asks before doing either, and says how many apps are connected.

If the server has no public address yet, the address works only on the computer that runs the server, and the section says so with the server's own words: ChatGPT, Claude.ai and assistants on other devices need a public **https** address, which you set in the admin panel of the server (**Approved network**).

## Claude Code, Cursor and VS Code

These assistants send a **token** in a header. Create one for the assistant in the admin panel of the server (**Clients**), with only the permissions it needs, and put it in place of \`YOUR_TOKEN\` in the configuration the section shows for each of them, for example:

\`\`\`bash
claude mcp add --transport http the-glass-harbor https://books.example.net/mcp/the-glass-harbor \\
  --header "Authorization: Bearer YOUR_TOKEN"
\`\`\`

The token goes in the \`Authorization\` header, never in the address. Narrarium never shows the token of this device.

## ChatGPT and Claude.ai

On a server that lets apps connect by themselves (through OAuth), paste the address: in Claude.ai as a custom connector, in ChatGPT as a connector in developer mode, with OAuth. A page of **your** server opens: you prove that it is you with a **passkey** (or the admin code) and choose what the app may do. Read only is the default; changing the book and controlling the autopilot stay off until you turn them on.

**Connected apps** lists the apps connected to the book: the name the app gave itself, what it may do (read the book, change the book, control the autopilot), the address it goes back to, when it was connected and when it was last used. **Revoke** disconnects one, after asking; **Refresh the list** reads it again, for an app you have just allowed. Your passkeys and the log of the latest calls are in the admin panel of the server, under **Connected apps (MCP)**.

## The risk

A model that reads the book reads text, and text can say anything: it can be talked into using the tools (this is called prompt injection). So give write access only to apps you trust, give each assistant only the permissions it needs, and switch the MCP server off for a book you do not work on with an assistant. Every change an assistant makes is a commit of the book, which you can undo.
`,
  }, {
    title: "Server MCP di un libro",
    summary: "Fai leggere e modificare un libro del tuo server personale a Claude Code, Cursor, VS Code, ChatGPT o Claude.ai, e guarda quali app sono collegate.",
    markdown: `# Server MCP di un libro

Ogni libro sul tuo server personale può avere il suo **Server MCP**: un indirizzo del server (\`/mcp/<nome>\`) dove un assistente come Claude Code, Cursor, VS Code, ChatGPT o Claude.ai legge il libro e lo modifica con strumenti simili a quelli del Copilot di Narrarium (il [Model Context Protocol](https://modelcontextprotocol.io)). È spento per ogni libro finché non lo accendi, un libro alla volta.

## Dove si trova

Apri il libro e vai in **Impostazioni libro**: la sezione **Server MCP** è in fondo alla pagina. Ciò che cambi lì vale subito sul server, senza **Salva**. La sezione è per un libro che sta sul tuo server personale (spostalo lì da **Dove gira**, nella pagina **In diretta** del suo autopilot); per ogni altro libro ha una riga con la strada per **Impostazioni** → **Server personale**. Un server troppo vecchio per averlo lo dice: aggiornalo dalle stesse impostazioni.

## Accenderlo

Attiva **Server MCP di questo libro**. La sezione mostra allora l'**Indirizzo** del libro, con un pulsante che lo copia, e il suo **Nome dell'indirizzo**, l'ultima parte dell'indirizzo: lettere minuscole, cifre e trattini singoli, fino a 80 caratteri. **Cambia l'indirizzo** gli dà un altro nome; se il server ne rifiuta uno (ce l'ha un altro libro, o non è un nome valido), il campo dice perché.

Spegnerlo, o cambiare l'indirizzo, **scollega ogni app** collegata al libro: ognuna dovrà chiederti di nuovo il permesso, e ogni assistente avrà bisogno del nuovo indirizzo. La pagina chiede conferma prima di fare l'una o l'altra cosa, e dice quante app sono collegate.

Se il server non ha ancora un indirizzo pubblico, l'indirizzo funziona solo sul computer del server, e la sezione lo dice con le parole del server: ChatGPT, Claude.ai e gli assistenti su altri dispositivi hanno bisogno di un indirizzo pubblico **https**, che imposti nel pannello di amministrazione del server (**Rete approvata**).

## Claude Code, Cursor e VS Code

Questi assistenti mandano un **token** in un'intestazione. Creane uno per l'assistente nel pannello di amministrazione del server (**Client**), con i soli permessi che gli servono, e mettilo al posto di \`IL_TUO_TOKEN\` nella configurazione che la sezione mostra per ciascuno, per esempio:

\`\`\`bash
claude mcp add --transport http il-porto-di-vetro https://books.example.net/mcp/il-porto-di-vetro \\
  --header "Authorization: Bearer IL_TUO_TOKEN"
\`\`\`

Il token va nell'intestazione \`Authorization\`, mai nell'indirizzo. Narrarium non mostra mai il token di questo dispositivo.

## ChatGPT e Claude.ai

Su un server che lascia collegare le app da sole (con OAuth), incolla l'indirizzo: in Claude.ai come connettore personalizzato, in ChatGPT come connettore in modalità sviluppatore, con OAuth. Si apre una pagina del **tuo** server: dimostri che sei tu con una **passkey** (o il codice amministratore) e scegli cosa può fare l'app. Di base può solo leggere; modificare il libro e comandare l'autopilot restano spenti finché non li accendi.

**App collegate** elenca le app collegate al libro: il nome che l'app si è data, cosa può fare (leggere il libro, modificare il libro, comandare l'autopilot), l'indirizzo a cui torna, quando è stata collegata e quando è stata usata l'ultima volta. **Revoca** ne scollega una, dopo aver chiesto conferma; **Aggiorna l'elenco** lo rilegge, per un'app che hai appena autorizzato. Le tue passkey e il registro delle ultime chiamate sono nel pannello di amministrazione del server, in **App collegate (MCP)**.

## Il rischio

Un modello che legge il libro legge testo, e il testo può dire qualsiasi cosa: può essere convinto a usare gli strumenti (si chiama prompt injection). Quindi dai il permesso di modifica solo alle app di cui ti fidi, dai a ogni assistente solo i permessi che gli servono, e spegni il server MCP di un libro su cui non lavori con un assistente. Ogni modifica di un assistente è un commit del libro, che puoi annullare.
`,
  }),
  entry("reader-export", "guides", {
    title: "Reader and publishing",
    summary: "Reading settings, visible metadata, paragraph separators and book exports.",
    markdown: `# Reader and publishing

The reader supports font family, size, line height, margins, source/dialogue/book line-break modes, images, rich canon links, bookmarks and fullscreen reading.

Paragraph pages open in reader mode and switch to editing with save/discard confirmation.

## Editorial metadata

Book Settings choose which book, chapter and paragraph frontmatter values are visible. Missing values are skipped. The same presentation rules and paragraph separator are applied to reader, paragraph preview, DOCX, PDF and EPUB.

## Export

Exports support Word, PDF, EPUB and submission packages, full book or sample scope, images, typography, frontmatter debug output, paragraph titles, chapter summaries, presets, local download and Drive upload.
`,
  }, {
    title: "Reader e pubblicazione",
    summary: "Impostazioni di lettura, metadati visibili, separatori ed export del libro.",
    markdown: `# Reader e pubblicazione

Il reader supporta font, dimensione, interlinea, margini, modalità a capo source/dialogue/book, immagini, link canonici ricchi, segnalibri e fullscreen.

Le pagine paragrafo si aprono in modalità reader e passano alla modifica con conferma salva/scarta.

## Metadati editoriali

Le impostazioni libro scelgono quali valori frontmatter di libro, capitolo e paragrafo sono visibili. I valori mancanti vengono ignorati. Le stesse regole e il separatore tra paragrafi sono usati in reader, preview paragrafo, DOCX, PDF ed EPUB.

## Export

Gli export supportano Word, PDF, EPUB e submission package, libro completo o demo, immagini, tipografia, frontmatter tecnico, titoli paragrafo, summary capitolo, preset, download locale e upload Drive.
`,
  }),
  entry("privacy-settings", "reference", {
    title: "Settings, privacy and recovery",
    summary: "Cloud settings, credentials, chats, costs, migration, backup and repair.",
    markdown: `# Settings, privacy and recovery

Narrarium does not store your book or credentials on Narrarium servers. GitHub stores the book; your Drive stores private settings and app data; configured AI providers process AI requests.

## Staying signed in to Google Drive and OneDrive

Account & Sync connects with **long-lived credentials** when the Narrarium token service is available, so you do not have to sign in again every hour. The service is a Cloudflare Worker that keeps the Google and Microsoft client secrets and renews tokens for your browser; it stores nothing. Your browser keeps the refresh token, only if you chose **Remember connection on this device**, sealed with a key that cannot be exported. It never goes into synced data, exports or logs. This protects the stored copy, not against a script running in the page.

- **Google:** no expiry until you revoke access (the app must be published, otherwise 7 days). **Microsoft:** 90 days, renewed at every use.
- **Disconnect** forgets the credentials on this device and revokes Google's; Microsoft's can only be revoked from your Microsoft account.
- Without the service nothing changes: the usual one-hour (Google) or 24-hour (Microsoft) sign-in applies and no offer appears.

## Settings

Configure AI Integrations, AI Router, Deep Search, Copilot tools, GitHub credentials, speech and local repository synchronization. Book-specific settings control branches, dedicated PATs, reader/export metadata and Drive export destinations.

## Migration and deletion

The migration page copies Narrarium cloud data between Google and Microsoft accounts. Cloud-data deletion does not delete GitHub repositories.

## Recovery

Repository tools provide backup ZIP, remote-wins pull, local-source-of-truth repair, reclone and incomplete-clone healing. Keep GitHub and local backups for important projects.
`,
  }, {
    title: "Impostazioni, privacy e recupero",
    summary: "Impostazioni cloud, credenziali, chat, costi, migrazione, backup e riparazione.",
    markdown: `# Impostazioni, privacy e recupero

Narrarium non conserva libro o credenziali su server Narrarium. GitHub conserva il libro; il tuo Drive conserva impostazioni e dati privati; i provider configurati elaborano le richieste AI.

## Restare collegati a Google Drive e OneDrive

Account e sincronizzazione si collega con **credenziali durature** quando il servizio di accesso di Narrarium è disponibile, così non devi accedere di nuovo ogni ora. Il servizio è un Worker Cloudflare che custodisce i segreti client di Google e Microsoft e rinnova i token per il tuo browser; non conserva nulla. Il refresh token lo tiene il tuo browser, solo se hai scelto **Ricorda la connessione su questo dispositivo**, sigillato con una chiave che non si può esportare. Non finisce mai nei dati sincronizzati, nelle esportazioni o nei log. Questo protegge la copia conservata, non da uno script che gira nella pagina.

- **Google:** nessuna scadenza finché non revochi l'accesso (l'app deve essere pubblicata, altrimenti 7 giorni). **Microsoft:** 90 giorni, rinnovati a ogni uso.
- **Disconnetti** le dimentica su questo dispositivo e revoca quelle di Google; quelle di Microsoft si possono revocare solo dal tuo account Microsoft.
- Senza il servizio non cambia nulla: vale l'accesso di sempre, di un'ora (Google) o di 24 ore (Microsoft), e non compare nessuna offerta.

## Impostazioni

Configura Integrazioni AI, AI Router, Deep Search, tool Copilot, credenziali GitHub, voce e sincronizzazione repository locale. Le impostazioni libro controllano branch, PAT dedicati, metadati reader/export e destinazioni Drive.

## Migrazione e cancellazione

La pagina migrazione copia i dati cloud Narrarium tra account Google e Microsoft. La cancellazione cloud non elimina i repository GitHub.

## Recupero

Gli strumenti repository forniscono backup ZIP, pull remote-wins, riparazione locale come fonte di verità, reclone e guarigione dei clone incompleti. Mantieni backup GitHub e locali per i progetti importanti.
`,
  }),
];
