import type { DocEntry, DocGroup } from "@/lib/generated-docs";

/** Where the text of the guides is, from the root of the repository: `<slug>.<lang>.md`, a file for each language. */
const GUIDES = "src/narrarium-site/src/content/guides";

type GuideText = { title: string; summary: string };

/**
 * A guide of the app: its title and summary in each language. Its text is the file `src/content/guides/<slug>.<lang>.md`, loaded when the guide is
 * opened (a chunk of its own: see `loadDocMarkdown`), so what lists the guides (the menu of the help, the index of the documentation) carries no text.
 */
function entry(slug: string, group: DocGroup, en: GuideText, it: GuideText): DocEntry {
  return {
    title: en.title,
    href: `/docs/${slug}`,
    slug,
    group,
    groupLabel: group,
    sourcePath: `${GUIDES}/${slug}.en.md`,
    summary: en.summary,
    translations: {
      en: { ...en, sourcePath: `${GUIDES}/${slug}.en.md` },
      it: { ...it, sourcePath: `${GUIDES}/${slug}.it.md` },
    },
  };
}

/** The guides of the app, in the order the help lists them. To add one: its two files in `src/content/guides`, a line here, then `node scripts/generate-docs.mjs`. */
export const appDocEntries: DocEntry[] = [
  entry("overview", "overview", { title: "How Narrarium works", summary: "The application architecture, where data lives, and the main writing workflow." }, { title: "Come funziona Narrarium", summary: "Architettura dell'app, posizione dei dati e flusso principale di scrittura." }),
  entry("first-book", "guides", { title: "Create your first book", summary: "GitHub account, PAT, repository creation and first book settings." }, { title: "Crea il primo libro", summary: "Account GitHub, PAT, creazione repository e prime impostazioni del libro." }),
  entry("github-sync", "guides", { title: "Git, branches and synchronization", summary: "Local working copy, clean/dirty state, commits, pulls, pushes and recovery." }, { title: "Git, branch e sincronizzazione", summary: "Working copy locale, stati clean/dirty, commit, pull, push e recupero." }),
  entry("ai-router", "guides", { title: "AI integrations and Router", summary: "Configure providers, models, task routing, fallbacks, browser speech and costs." }, { title: "Integrazioni AI e Router", summary: "Configura provider, modelli, task, fallback, voce browser e costi." }),
  entry("book-structure", "reference", { title: "Books, chapters and paragraphs", summary: "Repository structure and the relationship between the main writing documents." }, { title: "Libri, capitoli e paragrafi", summary: "Struttura repository e relazione tra i principali documenti di scrittura." }),
  entry("writing-workflow", "guides", { title: "Writing workflow", summary: "Scripts, drafts, final prose, ghostwriters and AI editing tools." }, { title: "Flusso di scrittura", summary: "Script, bozze, prosa definitiva, ghostwriter e strumenti AI di editing." }),
  entry("copilot-tools", "reference", { title: "Copilot, Fantasmino and tools", summary: "Text and voice assistants, Tool Registry, navigation, Git and local no-LLM actions." }, { title: "Copilot, Fantasmino e tool", summary: "Assistente testuale e vocale, Tool Registry, navigazione, Git e azioni locali senza LLM." }),
  entry("canon-research", "reference", { title: "Canon, research and assets", summary: "Characters, locations, factions, items, secrets, timelines, deep research and images." }, { title: "Canone, ricerche e asset", summary: "Personaggi, luoghi, fazioni, oggetti, segreti, timeline, Deep Research e immagini." }),
  entry("evaluations-readers", "guides", { title: "Evaluations and simulated readers", summary: "Critical evaluation style, numeric scores, reader personas, separate evaluations and panel summaries." }, { title: "Valutazioni e lettori simulati", summary: "Stile valutativo critico, punteggi, Reader Persona, valutazioni separate e sintesi del panel." }),
  entry("wildcards", "guides", { title: "Wildcards (Fuori dal coro)", summary: "Provocateurs and sentinels who give ideas and findings, never a score: the page, your own wildcards, and how the room is consulted." }, { title: "Fuori dal coro", summary: "Provocatori e sentinelle che danno idee e rilievi, mai un voto: la pagina, i tuoi Fuori dal coro e come si consulta la stanza." }),
  entry("outline", "guides", { title: "The Synopsis", summary: "The plan of the book chapter by chapter: what the autopilot follows, how to edit it, and how to talk to the Copilot about it." }, { title: "La Sinossi", summary: "Il piano del libro capitolo per capitolo: cosa segue l'autopilot, come modificarla e come parlarne al Copilot." }),
  entry("autopilot", "guides", { title: "Autopilot, director and personal server", summary: "Let the autopilot write while the director decides as your stand-in, follow it live, intervene, and run it on your own server." }, { title: "Autopilot, direttore e server personale", summary: "Lascia scrivere l'autopilot mentre il direttore decide al posto tuo, seguilo in diretta, intervieni e fallo girare sul tuo server." }),
  entry("book-mcp", "guides", { title: "MCP server of a book", summary: "Let Claude Code, Cursor, VS Code, ChatGPT or Claude.ai read and edit a book on your personal server, and see which apps are connected." }, { title: "Server MCP di un libro", summary: "Fai leggere e modificare un libro del tuo server personale a Claude Code, Cursor, VS Code, ChatGPT o Claude.ai, e guarda quali app sono collegate." }),
  entry("reader-export", "guides", { title: "Reader and publishing", summary: "Reading settings, visible metadata, paragraph separators and book exports." }, { title: "Reader e pubblicazione", summary: "Impostazioni di lettura, metadati visibili, separatori ed export del libro." }),
  entry("privacy-settings", "reference", { title: "Settings, privacy and recovery", summary: "Cloud settings, credentials, chats, costs, migration, backup and repair." }, { title: "Impostazioni, privacy e recupero", summary: "Impostazioni cloud, credenziali, chat, costi, migrazione, backup e riparazione." }),
];
