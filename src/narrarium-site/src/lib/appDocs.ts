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

- **GitHub repository:** book metadata, canon, chapters, paragraphs, drafts, scripts, evaluations, research, assets, writing style, simulated readers and reader evaluations.
- **Local browser repository:** the active working copy used for fast local-first editing, commits, pulls and pushes.
- **Google Drive or OneDrive:** private application settings, AI credentials, connected books, Copilot chats, clipboard and cost ledger.
- **AI providers:** requests are sent directly from the browser using integrations configured by the user.

## Main capabilities

- structured book and canon management;
- chapter and paragraph writing;
- Script → Draft → Final workflow;
- writing-style and evaluation-style contracts;
- Copilot and Fantasmino with a configurable Tool Registry;
- Router-based AI tasks and fallbacks;
- deep research and promotion into canon;
- editorial and simulated-reader evaluations;
- reader preview and DOCX, PDF and EPUB export;
- local Git working copy with commit, pull, push, branch and PR operations.
`,
  }, {
    title: "Come funziona Narrarium",
    summary: "Architettura dell'app, posizione dei dati e flusso principale di scrittura.",
    markdown: `# Come funziona Narrarium

Narrarium è un'applicazione browser per scrivere libri in cui il repository è la fonte di verità.

## Dove vivono i dati

- **Repository GitHub:** metadati libro, canone, capitoli, paragrafi, bozze, script, valutazioni, ricerche, asset, stile di scrittura, lettori simulati e relative valutazioni.
- **Repository locale del browser:** working copy local-first usata per modifica rapida, commit, pull e push.
- **Google Drive o OneDrive:** impostazioni private, credenziali AI, libri collegati, chat Copilot, clipboard e registro costi.
- **Provider AI:** le richieste partono direttamente dal browser usando le integrazioni configurate dall'utente.

## Capability principali

- gestione strutturata del libro e del canone;
- scrittura di capitoli e paragrafi;
- flusso Script → Bozza → Definitivo;
- contratti di stile di scrittura e stile valutativo;
- Copilot e Fantasmino con Tool Registry configurabile;
- Router AI con task e fallback;
- Deep Research e promozione nel canone;
- valutazioni editoriali e con lettori simulati;
- reader preview ed export DOCX, PDF ed EPUB;
- working copy Git locale con commit, pull, push, branch e PR.
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

Open **My Books → Add Book**. You can connect an existing Narrarium repository or create a new one. New books include book metadata, writing style, evaluation style, standard simulated readers, plot, notes and the main directory structure.

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

Apri **I miei libri → Aggiungi libro**. Puoi collegare un repository Narrarium esistente o crearne uno nuovo. I nuovi libri includono metadati, stile di scrittura, stile valutativo, lettori simulati standard, plot, note e struttura principale.

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

Narrarium uses your AI integrations. Configure Azure OpenAI, OpenAI-compatible endpoints or GitHub Models in **Settings → AI Router**.

## GitHub Models quick start

Create a GitHub PAT authorized for GitHub Models, add a **GitHub Models** integration, load the model catalog and assign capabilities to the models you want to use.

## Task routing

Each task can have a primary integration/model and ordered fallbacks. Tasks include Copilot, review, simple tasks, chat resume, deep research, reader evaluation, reader-evaluation summary, TTS, STT and image generation.

Browser TTS and STT are virtual Router integrations and do not consume AI tokens.

## Costs

When pricing is configured, Narrarium records input, cached-input and output tokens plus media costs. Reader evaluations save their own provider/model/token/cost metadata while using the same cost engine.
`,
  }, {
    title: "Integrazioni AI e Router",
    summary: "Configura provider, modelli, task, fallback, voce browser e costi.",
    markdown: `# Integrazioni AI e Router

Narrarium usa le tue integrazioni AI. Configura Azure OpenAI, endpoint compatibili OpenAI o GitHub Models in **Impostazioni → AI Router**.

## Avvio rapido GitHub Models

Crea un PAT GitHub abilitato a GitHub Models, aggiungi un'integrazione **GitHub Models**, carica il catalogo e assegna ai modelli le capability desiderate.

## Routing dei task

Ogni task può avere integrazione/modello primario e fallback ordinati. I task includono Copilot, review, task semplici, resume chat, deep research, valutazione lettore, sintesi valutazioni, TTS, STT e immagini.

TTS e STT browser sono integrazioni virtuali del Router e non consumano token AI.

## Costi

Quando configuri i prezzi, Narrarium registra token input, input in cache e output, oltre ai costi media. Le valutazioni dei lettori salvano provider, modello, token e costo usando lo stesso motore.
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

## Writing style and Ghostwriters

The book writing style is an always-on Markdown contract. Chapters can add local overrides. Ghostwriter profiles provide reusable voice, tone, rhythm, dialogue and vocabulary instructions.

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

## Stile di scrittura e Ghostwriter

Lo stile del libro è un contratto Markdown sempre attivo. I capitoli possono aggiungere override locali. I Ghostwriter forniscono istruzioni riutilizzabili per voce, tono, ritmo, dialoghi e lessico.

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

## Settings

Configure AI Router, Deep Search, Copilot tools, GitHub credentials, speech and local repository synchronization. Book-specific settings control branches, dedicated PATs, reader/export metadata and Drive export destinations.

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

## Impostazioni

Configura AI Router, Deep Search, tool Copilot, credenziali GitHub, voce e sincronizzazione repository locale. Le impostazioni libro controllano branch, PAT dedicati, metadati reader/export e destinazioni Drive.

## Migrazione e cancellazione

La pagina migrazione copia i dati cloud Narrarium tra account Google e Microsoft. La cancellazione cloud non elimina i repository GitHub.

## Recupero

Gli strumenti repository forniscono backup ZIP, pull remote-wins, riparazione locale come fonte di verità, reclone e guarigione dei clone incompleti. Mantieni backup GitHub e locali per i progetti importanti.
`,
  }),
];
