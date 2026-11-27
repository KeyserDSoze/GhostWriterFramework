import { loadReaderPersonas } from "@/narrarium/readerPanel";
import type { ReaderPersonaProfile } from "@/narrarium/readerPersona";
import { pageViewText } from "@/assistant/pages/view";
import type { PageCapability, PageEnv, PageView } from "@/assistant/pages/types";

/**
 * The Simulated readers page with the Copilot: it sees every reader of the book, the built-in ones included, with whether each is on, and what the author has
 * selected or filtered on the page.
 */

const READERS_PROMPT = [
  "The author is on the Simulated readers page of the book: the readers that read and judge its chapters and paragraphs.",
  "Built-in readers ship with Narrarium (standard ones, on by default, and genre ones, off by default); custom readers are the author's. Each reader is on or off: only the readers that are on read the book.",
  "A request about «readers», «the reader» or «this reader» means these readers; «this reader» is the one selected on the page.",
].join(" ");

function origin(reader: ReaderPersonaProfile): string {
  return reader.builtin ? "built-in" : `custom${reader.path ? ` (${reader.path})` : ""}`;
}

/** One line of a reader, as the model reads it: on or off, its name, id, type, origin, severity and the genres it likes. */
export function readerLine(reader: ReaderPersonaProfile): string {
  const genres = reader.preferredGenres.length ? ` · likes ${reader.preferredGenres.join(", ")}` : "";
  return `- ${reader.enabled ? "on" : "off"} · ${reader.name} · ${reader.id} · ${reader.readerType} · ${origin(reader)} · severity ${reader.severity}/10${genres}`;
}

/** What the Copilot sees of the page: how many readers and which are on, what the author is looking at, and every reader on one line. */
export function readersStateText(readers: readonly ReaderPersonaProfile[], view: PageView | null): string {
  const builtin = readers.filter((reader) => reader.builtin).length;
  const on = readers.filter((reader) => reader.enabled);
  const looking = pageViewText(view);
  return [
    `Simulated readers: ${readers.length} (${builtin} built-in, ${readers.length - builtin} custom); ${on.length} on${on.length ? `: ${on.map((reader) => reader.name).join(", ")}` : ""}.`,
    looking ? `On the page now: ${looking}.` : "",
    "Every reader (on/off · name · id · type · origin · severity · genres):",
    ...readers.map(readerLine),
  ].filter(Boolean).join("\n");
}

export async function loadPageReaders(env: Pick<PageEnv, "token" | "book" | "branch" | "structure">): Promise<ReaderPersonaProfile[]> {
  return loadReaderPersonas({ token: env.token, book: env.book, branch: env.branch, structure: env.structure });
}

export const readersPage: PageCapability = {
  id: "readers",
  prompt: READERS_PROMPT,
  async state(env) {
    const view = env.view;
    // The page publishes the id of the reader it has open: the model reads its name too.
    const readers = await loadPageReaders(env);
    const selected = typeof view?.selected === "string" ? readers.find((reader) => reader.id === view.selected) : undefined;
    return readersStateText(readers, selected && view ? { ...view, selected: `${selected.name} (${selected.id})` } : view);
  },
  tools: [],
};
