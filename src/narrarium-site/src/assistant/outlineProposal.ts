import { z } from "zod";
import { clipMiddle, type BookFileChange, type OutlineEdit, type OutlineWarning } from "narrarium-engine";
import { currentRequest, untrustedData } from "@/assistant/promptTrust";
import type { LlmMessage } from "@/assistant/llm";
import { sourceRevisionFromFiles } from "@/assistant/actionValidation";
import type { AssistantActionProvenance, AssistantFileUpdate, AssistantMessage } from "@/assistant/store";
import { chapterTargetInstruction } from "@/assistant/outlineTarget";
import { composeEdits, snapshotOf, type OutlineSnapshot } from "@/outline/outlineModel";
import { browserOutlineSource, type OutlineSource } from "@/outline/outlineSource";
import type { BookEntry } from "@/types/settings";

/**
 * How the Copilot turns a request about the outline (the Scaletta) into a proposal: the engine makes every edit (`outlineChanges`, composed
 * into the files of one commit), so every entry it writes is the author's and no frontmatter is written by hand; the author sees what changes
 * and applies it, or not. Nothing here writes. The Copilot loads this module with the first request about the outline, so the app does not
 * carry the outline's code (nor the engine's) until then.
 */

/** Files of the outline a proposal may change: more than that is a work for the Outline page. */
export const MAX_OUTLINE_PROPOSAL_FILES = 100;
/** Entries a request shows the model whole: the outline has no maximum, and the ones the request names come first. */
const WHOLE_ENTRIES = 40;
const ENTRY_CHARS = 1_500;
const DESCRIPTION_CHARS = 3_000;
const LISTED_TITLES = 400;

const NUMBER = String.raw`(\d{1,6})`;
const CHAPTER = String.raw`(?:(?:il|lo|la|del|al|dal|the|of)\s+)?(?:capitolo|chapter|voce|entry)\s+`;
const MOVE = new RegExp(String.raw`(?:sposta|muovi|porta|move|put)\s+${CHAPTER}${NUMBER}\s+(dopo|prima|after|before)\s+(?:(?:di|il|lo|la|del|al|the)\s+)*(?:(?:capitolo|chapter|voce|entry)\s+)?${NUMBER}`, "i");
const MOVE_TO = new RegExp(String.raw`(?:sposta|muovi|porta|move|put)\s+${CHAPTER}${NUMBER}\s+(?:al\s+posto|in\s+posizione|alla\s+posizione|to\s+position|to\s+place|at\s+position)\s+${NUMBER}`, "i");
const REMOVE = new RegExp(String.raw`(?:elimina|rimuovi|cancella|togli|delete|remove|drop)\s+${CHAPTER}${NUMBER}(?![\d])`, "i");
const RENUMBER = /(?<![\p{L}])(?:rinumer\p{L}*|renumber\p{L}*|chiudi\s+il\s+(?:buco|vuoto)|close\s+the\s+gap)/iu;

export type OutlineCommand = { kind: "move"; from: number; to: number } | { kind: "remove"; number: number; renumber: boolean };

/**
 * The simple requests that need no model: move an entry before or after another, or to a position, and delete one (closing the gap only when
 * asked). `numbers` are the chapters the outline has: a request about one it does not have is left to the model, which can explain.
 */
export function parseOutlineCommand(prompt: string, numbers: readonly number[]): OutlineCommand | null {
  const has = new Set(numbers);
  const moveTo = MOVE_TO.exec(prompt);
  if (moveTo) {
    const from = Number(moveTo[1]);
    const to = Number(moveTo[2]);
    return has.has(from) && to >= 1 && from !== to ? { kind: "move", from, to } : null;
  }
  const move = MOVE.exec(prompt);
  if (move) {
    const from = Number(move[1]);
    const after = /^(?:dopo|after)$/i.test(move[2]);
    const reference = Number(move[3]);
    if (!has.has(from) || !has.has(reference) || from === reference) return null;
    const to = after ? (from < reference ? reference : reference + 1) : (from < reference ? reference - 1 : reference);
    return to === from ? null : { kind: "move", from, to };
  }
  const remove = REMOVE.exec(prompt);
  if (remove) {
    const removed = Number(remove[1]);
    return has.has(removed) ? { kind: "remove", number: removed, renumber: RENUMBER.test(prompt) } : null;
  }
  return null;
}

const fields = {
  title: z.string().max(400).optional(),
  body: z.string().max(40_000).optional(),
  ghostwriter: z.string().max(200).nullable().optional(),
};
const number = z.number().int().min(1).max(1_000_000);

export const outlineEditSchema = z.object({
  summary: z.string().max(4_000).default(""),
  edits: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("update"), number, ...fields }),
    z.object({ kind: z.literal("append"), ...fields }),
    z.object({ kind: z.literal("insert"), at: number, ...fields }),
    z.object({ kind: z.literal("move"), from: number, to: number }),
    z.object({ kind: z.literal("remove"), number, renumber: z.boolean().optional() }),
    z.object({ kind: z.literal("book"), title: z.string().max(400).nullable().optional(), body: z.string().max(40_000).optional() }),
  ])).max(60),
});

export type ModelOutlineEdits = z.infer<typeof outlineEditSchema>;

/** The edits of the model as the engine's edits: only the fields it gave, so that what it did not mention stays. */
export function toOutlineEdits(edits: ModelOutlineEdits["edits"]): OutlineEdit[] {
  const entry = (value: { title?: string; body?: string; ghostwriter?: string | null }) => ({
    ...(value.title !== undefined ? { title: value.title } : {}),
    ...(value.body !== undefined ? { body: value.body } : {}),
    ...(value.ghostwriter !== undefined ? { ghostwriter: value.ghostwriter || null } : {}),
  });
  return edits.map((edit): OutlineEdit => {
    switch (edit.kind) {
      case "update": return { kind: "update", number: edit.number, entry: entry(edit) };
      case "append": return { kind: "append", entry: entry(edit) };
      case "insert": return { kind: "insert", at: edit.at, entry: entry(edit) };
      case "move": return { kind: "move", from: edit.from, to: edit.to };
      case "remove": return { kind: "remove", number: edit.number, renumber: edit.renumber === true };
      default: return { kind: "book", ...(edit.title !== undefined ? { title: edit.title } : {}), ...(edit.body !== undefined ? { body: edit.body } : {}) };
    }
  });
}

/** The chapter numbers a request names, for the entries the model reads whole. */
function namedNumbers(prompt: string): number[] {
  return [...prompt.matchAll(/(?<![\p{L}\p{N}])(\d{1,6})(?![\p{L}\p{N}])/gu)].map((match) => Number(match[1])).filter((value) => value >= 1);
}

/** The outline as the model reads it: the description, the entries the request names (and the ones around them) whole, the titles of the others. */
export function outlineData(snapshot: OutlineSnapshot, prompt: string, ghostwriters: readonly string[]): string {
  const entries = snapshot.outline.chapters;
  const named = namedNumbers(prompt);
  const near = (value: number) => named.some((wanted) => Math.abs(wanted - value) <= 3);
  const whole = entries.length <= WHOLE_ENTRIES ? entries : entries.filter((entry) => near(entry.number)).slice(0, WHOLE_ENTRIES);
  const wholeNumbers = new Set(whole.map((entry) => entry.number));
  const others = entries.filter((entry) => !wholeNumbers.has(entry.number));
  return [
    `DESCRIPTION OF THE BOOK (outline/book.md)${snapshot.outline.book?.title ? `, working title «${snapshot.outline.book.title}»` : ""}:\n${clipMiddle(snapshot.outline.book?.body.trim() ?? "", DESCRIPTION_CHARS) || "(none)"}`,
    `ENTRIES OF THE OUTLINE (${entries.length}; the numbers are the chapters):\n${whole.map((entry) => `Chapter ${entry.number}${entry.title ? ` — ${entry.title}` : ""}${entry.ghostwriter ? ` [ghostwriter: ${entry.ghostwriter}]` : ""}:\n${clipMiddle(entry.body.trim(), ENTRY_CHARS) || "(no text)"}`).join("\n\n") || "(none)"}`,
    others.length ? `OTHER ENTRIES (titles only):\n${others.slice(0, LISTED_TITLES).map((entry) => `${entry.number}. ${entry.title || "(untitled)"}`).join("\n")}${others.length > LISTED_TITLES ? `\n… and ${others.length - LISTED_TITLES} more` : ""}` : "",
    `GHOSTWRITERS OF THE BOOK (slugs; null is the book's own): ${ghostwriters.join(", ") || "(none)"}`,
  ].filter(Boolean).join("\n\n");
}

export function outlineEditMessages(input: { prompt: string; route: { kind: string }; language: string; data: string }): LlmMessage[] {
  return [
    {
      role: "system",
      content: [
        "You edit the outline (the Scaletta) of a book in Narrarium on behalf of the author, turning their request into edits of it.",
        "An entry is a plan in plain text: a hypothetical title, what happens in the chapter (not prose, no dialogue) and, optionally, the slug of the ghostwriter that writes it (null: the book's own).",
        "An update replaces only the fields it gives: when you change what happens, give the whole new text, keeping every event the entry already has unless the request removes it.",
        "Edits: {\"kind\":\"update\",\"number\":3,\"title\":\"…\",\"body\":\"…\",\"ghostwriter\":\"slug\"|null}; {\"kind\":\"append\",\"title\":\"…\",\"body\":\"…\"}; {\"kind\":\"insert\",\"at\":4,\"title\":\"…\",\"body\":\"…\"} (the entries from 4 on move one number up); {\"kind\":\"move\",\"from\":5,\"to\":7}; {\"kind\":\"remove\",\"number\":4,\"renumber\":false}; {\"kind\":\"book\",\"title\":\"…\",\"body\":\"…\"} (the working title and the description).",
        `Write the texts in the language of the book (${input.language || "the one the outline is written in"}); the summary in the language of the request.`,
        "If the request is not a change of the outline, or names a chapter the outline does not have, return no edits and say why in the summary.",
        chapterTargetInstruction(input.route),
        "Return ONLY JSON: {\"summary\":\"one sentence for the author\",\"edits\":[…]}.",
      ].filter(Boolean).join("\n"),
    },
    { role: "user", content: `${currentRequest(input.prompt)}\n\n${untrustedData("repository_content", input.data)}` },
  ];
}

export interface OutlineProposal {
  summary: string;
  edits: OutlineEdit[];
  changes: BookFileChange[];
  warnings: OutlineWarning[];
  before: OutlineSnapshot;
  /** The version of each file the proposal was made on (`null`: it did not exist). */
  sourceRevisions: Record<string, string | null>;
}

/**
 * The proposal for a request: the edits come from the request itself when it is a simple move or deletion (`parseOutlineCommand`), from the model
 * otherwise (`complete` answers the messages with the JSON of `outlineEditSchema`).
 */
export async function proposeOutlineEdit(input: {
  prompt: string;
  route: { kind: string };
  language: string;
  source: OutlineSource;
  ghostwriters: readonly string[];
  complete: (messages: LlmMessage[]) => Promise<ModelOutlineEdits>;
}): Promise<OutlineProposal> {
  const before = await snapshotOf(await input.source.files());
  const command = parseOutlineCommand(input.prompt, before.outline.chapters.map((entry) => entry.number));
  let summary = "";
  let edits: OutlineEdit[];
  if (command) {
    edits = [command];
  } else {
    const answer = await input.complete(outlineEditMessages({ prompt: input.prompt, route: input.route, language: input.language, data: outlineData(before, input.prompt, input.ghostwriters) }));
    summary = answer.summary.trim();
    edits = toOutlineEdits(answer.edits);
  }
  const composed = edits.length ? await composeEdits(before, edits, input.ghostwriters) : { changes: [], warnings: [] };
  const sourceRevisions = Object.fromEntries(composed.changes.map((change) => [change.path, before.files.get(change.path)?.hash ?? null]));
  return { summary, edits, changes: composed.changes, warnings: composed.warnings, before, sourceRevisions };
}

/** What a proposal does, one line per edit, in the language of the request. */
export function describeOutlineEdits(edits: readonly OutlineEdit[], before: OutlineSnapshot, italian: boolean): string[] {
  const last = before.outline.chapters.reduce((highest, entry) => Math.max(highest, entry.number), 0);
  const titleOf = (value: number) => before.outline.chapters.find((entry) => entry.number === value)?.title;
  const named = (value: number) => {
    const title = titleOf(value);
    return italian ? `il capitolo ${value}${title ? ` «${title}»` : ""}` : `chapter ${value}${title ? ` «${title}»` : ""}`;
  };
  return edits.map((edit) => {
    switch (edit.kind) {
      case "update": {
        const parts = [edit.entry.title !== undefined ? (italian ? "titolo" : "title") : "", edit.entry.body !== undefined ? (italian ? "cosa succede" : "what happens") : "", edit.entry.ghostwriter !== undefined ? "ghostwriter" : ""].filter(Boolean).join(", ");
        const exists = Boolean(before.outline.chapters.some((entry) => entry.number === edit.number));
        return exists
          ? (italian ? `Nella Scaletta cambia ${named(edit.number)}: ${parts}.` : `In the outline, ${named(edit.number)} changes: ${parts}.`)
          : (italian ? `Nella Scaletta nasce la voce del capitolo ${edit.number}.` : `The outline gets an entry for chapter ${edit.number}.`);
      }
      case "append": return italian ? `Un nuovo capitolo ${last + 1} in fondo alla Scaletta.` : `A new chapter ${last + 1} at the end of the outline.`;
      case "insert": return italian ? `Un nuovo capitolo ${edit.at} nella Scaletta: i successivi slittano di un posto.` : `A new chapter ${edit.at} in the outline: the following chapters move one number up.`;
      case "move": return italian ? `Nella Scaletta ${named(edit.from)} diventa il capitolo ${edit.to}.` : `In the outline, ${named(edit.from)} becomes chapter ${edit.to}.`;
      case "remove": return italian
        ? `${named(edit.number).replace(/^il/, "Il")} esce dalla Scaletta${edit.renumber ? ": i successivi risalgono di un posto" : ": i successivi mantengono il loro numero"}.`
        : `${named(edit.number).replace(/^chapter/, "Chapter")} leaves the outline${edit.renumber ? ": the following chapters move one number down" : ": the following chapters keep their numbers"}.`;
      default: return italian ? "Cambia la descrizione del libro nella Scaletta." : "The description of the book in the outline changes.";
    }
  });
}

/**
 * «Edit the Outline»: the request becomes edits of the outline (the engine writes every file, as the author's), shown as a proposal of the files
 * it changes. Nothing is written until the author applies it, all together. `complete` asks the model for the edits, with their schema.
 */
export async function outlineEditMessage(input: {
  prompt: string;
  /** The Copilot's own words in Italian (the request is). */
  italian: boolean;
  route: { kind: string };
  language: string;
  book: BookEntry;
  branch: string;
  ghostwriters: readonly string[];
  complete: (messages: LlmMessage[], schema: typeof outlineEditSchema) => Promise<ModelOutlineEdits>;
}): Promise<AssistantMessage> {
  const { italian } = input;
  const proposal = await proposeOutlineEdit({
    prompt: input.prompt,
    route: input.route,
    language: input.language,
    source: browserOutlineSource(input.book, input.branch),
    ghostwriters: input.ghostwriters,
    complete: (messages) => input.complete(messages, outlineEditSchema),
  });
  const message = (text: string): AssistantMessage => ({ id: crypto.randomUUID(), role: "assistant", text });
  if (!proposal.changes.length) {
    return message(proposal.summary || (italian ? "Per questa richiesta nella Scaletta non c'è niente da cambiare." : "There is nothing to change in the outline for this request."));
  }
  if (proposal.changes.length > MAX_OUTLINE_PROPOSAL_FILES) {
    return {
      ...message(italian
        ? `Questa modifica tocca ${proposal.changes.length} voci della Scaletta: falla nella pagina Scaletta, dove puoi anche annullarla.`
        : `This change touches ${proposal.changes.length} entries of the outline: make it on the Outline page, where you can also undo it.`),
      action: { kind: "navigate", to: `/app/books/${encodeURIComponent(input.book.id)}/outline`, label: italian ? "Scaletta" : "Outline" },
    };
  }
  const lines = describeOutlineEdits(proposal.edits, proposal.before, italian);
  const warnings = proposal.warnings.filter((warning) => warning.code !== "gap").map((warning) => `- ⚠ ${warning.message}`);
  const updates: AssistantFileUpdate[] = proposal.changes.map((change) => {
    const number = /^outline\/chapters\/(\d+)\.md$/.exec(change.path)?.[1];
    const label = number ? (italian ? `Capitolo ${Number(number)} della Scaletta` : `Chapter ${Number(number)} of the outline`) : (italian ? "Descrizione del libro" : "Description of the book");
    return { path: change.path, content: change.content, reason: change.content === null ? `${label}: ${italian ? "eliminata" : "deleted"}` : label };
  });
  const provenance: AssistantActionProvenance = {
    toolId: "edit-outline",
    owner: input.book.owner,
    repo: input.book.repo,
    branch: input.branch,
    sourceRevision: sourceRevisionFromFiles(proposal.sourceRevisions),
    sourceRevisions: proposal.sourceRevisions,
    generatedAt: new Date().toISOString(),
  };
  const text = [
    proposal.summary,
    lines.map((line) => `- ${line}`).join("\n"),
    warnings.join("\n"),
    italian ? "Nulla è salvato finché non applichi le modifiche, tutte insieme: ogni voce che scrivo diventa tua." : "Nothing is saved until you apply the changes, all together: every entry I write becomes yours.",
  ].filter(Boolean).join("\n\n");
  return { ...message(text), action: { ...provenance, kind: "apply-file-updates", bookId: input.book.id, updates } };
}
