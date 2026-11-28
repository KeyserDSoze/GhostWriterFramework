import { z } from "zod";
import { BIBLE_DECISIONS_FILE, OUTLINE_BRAINSTORM_FILE, OutlineReader, decisionConflicts, sha256Hex, type DecisionConflict, changeOfWritten, chapterFilePath, clipMiddle, designFindingText, designText, outlineDesignGaps, outlinePlanStatus, unescapePromptDataDeep, type BookStore, type OutlineChangeOutcome, type OutlineChapterEntry } from "narrarium-engine";
import { sourceRevisionFromFiles } from "@/assistant/actionValidation";
import { composeOutlineProposal, modelOutlineEditSchema, outlineProposalMessage, toOutlineEdits } from "@/assistant/outlineProposal";
import type { AssistantMessage } from "@/assistant/store";
import { ensureBuiltinCopilotToolsRegistered } from "@/assistant/tools/builtinTools";
import { isCopilotToolIdEnabled } from "@/assistant/tools/registry";
import { BRAINSTORM_CANON_SECTIONS, brainstormContextText, summaryOf, type BrainstormContext } from "@/assistant/brainstorm/context";
import { matchKey } from "@/lib/matchText";
import { heldLines } from "@/assistant/decisionHold";
import { runScopedTool, scopedToolLines, toolData, toolRefused, type ScopedTool, type ScopedToolOutcome } from "@/assistant/scopedTools";
import { filterEntries } from "@/outline/outlineModel";
import { BRAINSTORMING_CAPABILITY, type AppSettings } from "@/types/settings";
import type { SynopsisSections } from "@/assistant/synopsisImport";

/**
 * Brainstorming's tools, and only these: it reads the Synopsis, an entry, the summary of a written chapter and an entry of the canon, it proposes a
 * series of edits of the Synopsis (composed by the engine, applied by the author), it runs the coherence check of the whole Synopsis and it proposes
 * to save the decisions of a brainstorm in the book. It cannot write prose, change a chapter, open a page, use GitHub or reach any tool of the
 * Copilot: this registry is its own, the Copilot's is never asked, and a call to anything else is refused here, in code, whatever the model writes.
 */

export const BRAINSTORM_TOOL_IDS = ["read_synopsis", "read_synopsis_entry", "read_chapter_summary", "read_canon_entry", "propose_synopsis_edits", "import_synopsis_text", "check_synopsis", "save_brainstorm_notes", "propose_bible_decisions", "ask_the_room"] as const;
export type BrainstormToolId = (typeof BRAINSTORM_TOOL_IDS)[number];

/** What Brainstorming's tools work on: the context of the request (the book as Brainstorming knows it) and the settings of the author. */
export interface BrainstormToolEnv {
  context: BrainstormContext;
  settings: AppSettings;
  /** The words the author reads (a proposal, a finding) are Italian. */
  italian: boolean;
  now?: () => Date;
  accountScope?: string | null;
  signal?: AbortSignal;
  /** The author's request, apart from what they pasted. */
  instruction?: string;
  /** The chapters of a synopsis the author pasted with the request (see `synopsisSections`): what `import_synopsis_text` reads. */
  sections?: SynopsisSections;
  onProgress?: (progress: { from: number; to: number; total: number }) => void;
  /** What the room said in this turn (`ask_the_room`), each consultation as the chat shows it: the turn puts it before the synthesis. */
  room?: string[];
}

export type BrainstormToolOutcome = ScopedToolOutcome<BrainstormToolId>;

/** A tool of Brainstorming: the assistant's scoped tool (`@/assistant/scopedTools`), on Brainstorming's context. */
type BrainstormTool<A> = ScopedTool<A, BrainstormToolEnv, BrainstormToolId>;

const number = z.number().int().min(1).max(1_000_000);
const WHOLE_ENTRY_CHARS = 20_000;
const LISTED_ENTRY_CHARS = 4_000;
const LISTED_ENTRIES = 30;
const CANON_CHARS = 8_000;
const NOTES_CHARS = 20_000;

const data = (tool: BrainstormToolId, text: string, note?: string): BrainstormToolOutcome => toolData(tool, text, note);
const refused = (tool: string, text: string): BrainstormToolOutcome => toolRefused(tool, text);

function entryText(entry: OutlineChapterEntry, chars: number): string {
  const design = entry.design ? `\nDesign:\n${designText(entry.design, chars)}` : "";
  return `Chapter ${entry.number}${entry.title ? ` — ${entry.title}` : ""}${entry.ghostwriter ? ` [ghostwriter: ${entry.ghostwriter}]` : ""}${entry.intact ? " [written by the autopilot, untouched]" : " [the author's]"}:\n${clipMiddle(entry.body.trim(), chars) || "(no text yet)"}${design}`;
}

const OUTCOMES: Record<OutlineChangeOutcome, string> = {
  ask: "the chapter is written and closed: the autopilot will ask the author whether to rewrite it to follow the new entry",
  auto: "the chapter is written and closed: the autopilot will rewrite it to follow the new entry, without asking",
  notify: "the chapter is written and closed: the autopilot will only report the change",
  later: "the autopilot is writing or revising the chapter: the change is decided once it is closed",
  replan: "the chapter is not written yet: the autopilot plans it again from the new entry",
  unplan: "the chapter is not written: it leaves the plan",
  stays: "the chapter is written: it stays in the book, and the autopilot only says its entry is gone",
  none: "no plan of the autopilot follows this entry yet",
};

const readSynopsis: BrainstormTool<{ from?: number; to?: number; query?: string }> = {
  id: "read_synopsis",
  description: "chapter entries of the Synopsis whole, a range of chapter numbers or the ones whose title or text has some words",
  args: '{"from"?:N,"to"?:N,"query"?:"words"}',
  schema: z.object({ from: number.optional(), to: number.optional(), query: z.string().max(200).optional() }).strict(),
  async run(args, { context }) {
    const all = context.synopsis.outline.chapters;
    const ranged = all.filter((entry) => (args.from === undefined || entry.number >= args.from) && (args.to === undefined || entry.number <= args.to));
    const found = filterEntries(ranged, args.query ?? "");
    const shown = found.slice(0, LISTED_ENTRIES);
    const next = found[LISTED_ENTRIES]?.number;
    return data("read_synopsis", [
      `${found.length} of the ${all.length} entries${args.query ? ` match «${args.query}»` : ""}${shown.length < found.length ? `; the first ${shown.length} follow (call again with from=${next} for the rest)` : ""}.`,
      ...shown.map((entry) => entryText(entry, LISTED_ENTRY_CHARS)),
    ].join("\n\n"));
  },
};

const readSynopsisEntry: BrainstormTool<{ number: number }> = {
  id: "read_synopsis_entry",
  description: "one entry of the Synopsis whole (its design too: goal, point of view, characters, setting, time, events, scenes, conflicts, emotions, reveals, what stays hidden, clues, links, ending, cliffhanger, notes for the ghostwriter), with whether its chapter is written, approved, frozen or imported, and what the autopilot does if the entry changes",
  args: '{"number":N}',
  schema: z.object({ number }).strict(),
  async run({ number: wanted }, { context }) {
    const entry = context.synopsis.outline.chapters.find((candidate) => candidate.number === wanted);
    const written = context.written.find((chapter) => chapter.number === wanted);
    const chapter = written ? `Its chapter is written («${written.title || written.slug}»: ${written.states.join(", ")}).` : "Its chapter is not written yet.";
    if (!entry) return data("read_synopsis_entry", `Chapter ${wanted} has no entry in the Synopsis. ${chapter}`);
    return data("read_synopsis_entry", [
      entryText(entry, WHOLE_ENTRY_CHARS),
      chapter,
      `If the entry changes: ${OUTCOMES[changeOfWritten(context.state, wanted)]}. If it is deleted: ${OUTCOMES[changeOfWritten(context.state, wanted, { entry: "removed" })]}.`,
    ].join("\n"));
  },
};

const readChapterSummary: BrainstormTool<{ number: number }> = {
  id: "read_chapter_summary",
  description: "the summary of a chapter already written, and whether it is approved, frozen or imported (never its text)",
  args: '{"number":N}',
  schema: z.object({ number }).strict(),
  async run({ number: wanted }, { context }) {
    const chapter = context.written.find((candidate) => candidate.number === wanted);
    if (!chapter) return data("read_chapter_summary", `Chapter ${wanted} is not written yet.`);
    const summary = chapter.summary || summaryOf((await context.source.readFiles([chapterFilePath(chapter.slug)]).catch(() => []))[0]?.content);
    return data("read_chapter_summary", `Chapter ${chapter.number} «${chapter.title || chapter.slug}» [${chapter.states.join(", ")}]: ${summary ? clipMiddle(summary, WHOLE_ENTRY_CHARS) : "it has no summary yet."}`);
  },
};

const readCanonEntry: BrainstormTool<{ name: string }> = {
  id: "read_canon_entry",
  description: `one entry of the canon (${BRAINSTORM_CANON_SECTIONS.join(", ")}) by its name`,
  args: '{"name":"…"}',
  schema: z.object({ name: z.string().trim().min(1).max(200) }).strict(),
  async run({ name }, { context }) {
    const key = matchKey(name);
    const exact = context.canon.filter((entry) => matchKey(entry.name) === key || entry.path === name);
    const found = exact.length ? exact : context.canon.filter((entry) => matchKey(entry.name).includes(key));
    if (!found.length) {
      const names = context.canon.slice(0, 40).map((entry) => entry.name).join(", ");
      return data("read_canon_entry", `The canon has no entry named «${name}».${names ? ` Its names: ${names}${context.canon.length > 40 ? ", …" : ""}.` : ""}`);
    }
    const entry = found[0];
    const file = (await context.source.readFiles([entry.path]).catch(() => []))[0];
    return data("read_canon_entry", `${entry.section}: ${entry.name} (${entry.path})\n${file ? clipMiddle(file.content.trim(), CANON_CHARS) : "(the file cannot be read in this browser)"}`);
  },
};

/** Whether the author lets the assistant change the Synopsis: the Copilot's «Edit the Synopsis» in Settings > Tools for Copilot says it for both modes. */
function synopsisEditsEnabled(settings: AppSettings): boolean {
  ensureBuiltinCopilotToolsRegistered();
  return isCopilotToolIdEnabled(settings, "edit-outline");
}

const disabledEdits = (tool: BrainstormToolId) => refused(tool, "Changes of the Synopsis by the assistant are turned off (Settings > Tools for Copilot, «Edit the Synopsis»): say so to the author, and describe the change instead.");

const proposeSynopsisEdits: BrainstormTool<{ summary?: string; edits: Array<z.infer<typeof modelOutlineEditSchema>> }> = {
  id: "propose_synopsis_edits",
  description: "a series of edits of the Synopsis, made in order (each on what the one before left), shown to the author with the files and what the autopilot will do about each chapter, and applied only if the author confirms. Edits: {\"kind\":\"update\",\"number\":3,\"title\":\"…\",\"body\":\"…\",\"ghostwriter\":\"slug\"|null,\"design\":{\"goal\":\"…\",\"pov\":[\"…\"],\"events\":[\"…\"],\"clues\":[\"…\"],\"ending\":\"…\",\"cliffhanger\":true}} (only the fields given change, the design field by field, null takes one away; a new body replaces the whole text; the design fields are goal, pov, characters, setting, time, events, scenes, conflicts, emotions, reveals, withholds, clues, previous, next, ending, cliffhanger, notes); {\"kind\":\"append\",\"title\":\"…\",\"body\":\"…\"}; {\"kind\":\"insert\",\"at\":4,\"title\":\"…\",\"body\":\"…\"} (the entries from 4 on move one number up); {\"kind\":\"move\",\"from\":5,\"to\":7}; {\"kind\":\"remove\",\"number\":4,\"renumber\":false}; {\"kind\":\"book\",\"title\":\"…\",\"body\":\"…\"} (the working title and the idea of the book)",
  args: '{"summary":"one sentence for the author","edits":[…]}',
  schema: z.object({ summary: z.string().max(4_000).optional(), edits: z.array(modelOutlineEditSchema).min(1).max(60) }).strict(),
  async run(args, { context, settings, italian }) {
    if (!synopsisEditsEnabled(settings)) return disabledEdits("propose_synopsis_edits");
    const edits = toOutlineEdits(unescapePromptDataDeep(args.edits));
    const proposal = await composeOutlineProposal(context.synopsis, edits, context.ghostwriters, unescapePromptDataDeep(args.summary ?? "").trim());
    const message = outlineProposalMessage(proposal, { italian, book: context.book, branch: context.branch });
    if (message.action?.kind !== "apply-file-updates") return data("propose_synopsis_edits", `Not proposed: ${message.text}`, message.text);
    const held = heldByDecisions(context, message.action.updates);
    return {
      tool: "propose_synopsis_edits",
      kind: "proposal",
      message: held.length ? { ...message, text: `${message.text}\n\n${heldLines(held, italian ? "it" : "en").join("\n")}\n${italian ? "Prima di applicarla ti verrà chiesto." : "You will be asked before it is applied."}` } : message,
      text: `Proposed to the author: ${proposal.changes.length} file(s) of the Synopsis. Nothing is applied until the author confirms.${held.length ? ` WARNING: it goes against a locked decision of the author, which the author will be asked about before anything is applied: ${heldLines(held, "en").join(" ")} Propose something that respects it, or say plainly why it must change.` : ""}`,
    };
  },
};

/** What of the files a proposal would write goes against a locked decision of the book (the files as Brainstorming holds them now). */
function heldByDecisions(context: BrainstormContext, updates: ReadonlyArray<{ path: string; content: string | null }>): DecisionConflict[] {
  return decisionConflicts(updates.map((update) => ({ path: update.path, before: context.synopsis.files.get(update.path)?.content ?? null, after: update.content })), context.decisions);
}

const importSynopsisText: BrainstormTool<Record<string, never>> = {
  id: "import_synopsis_text",
  description: "the synopsis of several chapters the author pasted with this request, read a few chapters at a time into the entries of the Synopsis (title, what happens, and the fields of their design the text gives, nothing it does not say), shown to the author in one table and applied only if the author confirms; an entry the author wrote is never replaced unless the author asks",
  args: "{}",
  schema: z.object({}).strict(),
  async run(_args, env) {
    if (!synopsisEditsEnabled(env.settings)) return disabledEdits("import_synopsis_text");
    if (!env.sections) return refused("import_synopsis_text", "The author pasted no synopsis of several chapters with this request: there is nothing to import. Say so, or propose the edits yourself.");
    const { importSynopsis } = await import("@/assistant/synopsisImport");
    const message = await importSynopsis({
      settings: env.settings,
      accountScope: env.accountScope ?? null,
      ...(env.signal ? { signal: env.signal } : {}),
      capability: BRAINSTORMING_CAPABILITY,
      instruction: env.instruction ?? "",
      sections: env.sections,
      source: env.context.source,
      ghostwriters: env.context.ghostwriters,
      italian: env.italian,
      book: env.context.book,
      branch: env.context.branch,
      ...(env.onProgress ? { onProgress: env.onProgress } : {}),
    });
    if (message.action?.kind !== "apply-file-updates") return data("import_synopsis_text", `Not proposed: ${message.text}`, message.text);
    return { tool: "import_synopsis_text", kind: "proposal", message, text: `Proposed to the author: ${message.action.updates.length} entries of the Synopsis from the pasted text. Nothing is applied until the author confirms.` };
  },
};

const checkSynopsis: BrainstormTool<Record<string, never>> = {
  id: "check_synopsis",
  description: "the coherence check of the whole Synopsis: what the engine finds odd in its files, the entries without text, the ghostwriters that do not exist, the chapters written without an entry, and what the plan of the autopilot says of the entries that changed",
  args: "{}",
  schema: z.object({}).strict(),
  async run(_args, { context, italian }) {
    const findings = await synopsisFindings(context);
    const text = findings.length ? findings.map((finding) => `- ${finding.en}`).join("\n") : "- Nothing to report: every entry can be read, has a text and names a ghostwriter the book has, and the plan follows every entry.";
    const note = findings.length
      ? `${italian ? "Controllo di coerenza della Sinossi" : "Coherence check of the Synopsis"}:\n${findings.slice(0, 12).map((finding) => `- ${italian ? finding.it : finding.en}`).join("\n")}${findings.length > 12 ? `\n- … ${italian ? `e altri ${findings.length - 12}` : `and ${findings.length - 12} more`}` : ""}`
      : italian ? "Controllo di coerenza della Sinossi: niente da segnalare." : "Coherence check of the Synopsis: nothing to report.";
    return data("check_synopsis", `COHERENCE CHECK (${findings.length} finding${findings.length === 1 ? "" : "s"}):\n${text}`, note);
  },
};

export interface SynopsisFinding {
  number?: number;
  en: string;
  it: string;
}

/** The coherence check of the whole Synopsis, from the engine's own reading of it (`parseOutline`) and its rule for the plan (`outlinePlanStatus`). */
export async function synopsisFindings(context: BrainstormContext): Promise<SynopsisFinding[]> {
  const outline = context.synopsis.outline;
  const findings: SynopsisFinding[] = [];
  for (const warning of outline.warnings) {
    findings.push({ ...(warning.number ? { number: warning.number } : {}), en: `${warning.code}: ${warning.message}`, it: `${warning.code}: ${warning.message}` });
  }
  const ghostwriters = new Set(context.ghostwriters);
  for (const entry of outline.chapters) {
    if (!entry.body.trim()) findings.push({ number: entry.number, en: `Chapter ${entry.number} has no text: nothing says what happens in it.`, it: `Il capitolo ${entry.number} non ha testo: niente dice cosa succede.` });
    if (entry.ghostwriter && !ghostwriters.has(entry.ghostwriter)) findings.push({ number: entry.number, en: `Chapter ${entry.number} names the ghostwriter «${entry.ghostwriter}», which the book does not have.`, it: `Il capitolo ${entry.number} indica il ghostwriter «${entry.ghostwriter}», che il libro non ha.` });
  }
  // The designs of the entries that lack a key field (the engine's soft warnings of the Synopsis).
  for (const gap of outlineDesignGaps(outline.chapters)) findings.push({ number: gap.chapter, en: designFindingText(gap, "en"), it: designFindingText(gap, "it") });
  const entries = new Set(outline.chapters.map((entry) => entry.number));
  if (entries.size) {
    for (const chapter of context.written) {
      if (!entries.has(chapter.number)) findings.push({ number: chapter.number, en: `Chapter ${chapter.number} «${chapter.title}» is written but has no entry in the Synopsis.`, it: `Il capitolo ${chapter.number} «${chapter.title}» è scritto ma non ha una voce nella Sinossi.` });
    }
  }
  if (context.state?.plan) {
    const status = await outlinePlanStatus(snapshotReader(context), context.state, context.language || "en");
    for (const [chapter, change] of status.changed) {
      findings.push({ number: chapter, en: `Chapter ${chapter} is about to be started and its entry ${change === "removed" ? "was deleted: it leaves the plan" : "changed since the plan: it is planned again"}.`, it: `Il capitolo ${chapter} sta per iniziare e la sua voce ${change === "removed" ? "è stata cancellata: esce dal piano" : "è cambiata dopo il piano: viene ripianificato"}.` });
    }
    for (const change of status.written.values()) {
      findings.push({ number: change.number, en: `Chapter ${change.number} is written and closed, and its entry changed since: ${OUTCOMES[changeOfWritten(context.state, change.number)]}.`, it: `Il capitolo ${change.number} è scritto e chiuso, e la sua voce è cambiata dopo: l'autopilot farà ciò che dice la sua configurazione (chiedere, riscrivere o solo segnalare).` });
    }
    for (const note of status.notes) findings.push({ ...(note.chapterNumber ? { number: note.chapterNumber } : {}), en: note.title, it: note.title });
  }
  return findings.sort((left, right) => (left.number ?? 0) - (right.number ?? 0));
}

/** The engine's reader of the outline over the files Brainstorming already holds: it reads nothing more. */
function snapshotReader(context: BrainstormContext): OutlineReader {
  const files = context.synopsis.files;
  const store = { read: async (path: string) => { const file = files.get(path); return file ? { path, content: file.content, hash: file.hash } : null; } } as unknown as BookStore;
  return OutlineReader.of(store, { files: new Map([...files].map(([path, file]) => [path, file.hash])) });
}

/** The notes as they are with a new section at the end: dated, with its title, the decisions as the author reads them. */
export function appendBrainstormNotes(current: string, section: { title: string; notes: string; at: Date }): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = `${section.at.getFullYear()}-${pad(section.at.getMonth() + 1)}-${pad(section.at.getDate())} ${pad(section.at.getHours())}:${pad(section.at.getMinutes())}`;
  const head = current.trim() ? current.replace(/\s*$/, "\n\n") : "# Brainstorming\n\n";
  return `${head}## ${date}${section.title.trim() ? ` · ${section.title.trim()}` : ""}\n\n${section.notes.trim()}\n`;
}

const saveBrainstormNotes: BrainstormTool<{ title?: string; notes: string }> = {
  id: "save_brainstorm_notes",
  description: `the decisions of this brainstorm, as a short Markdown list, saved in the book's brainstorm notes (${OUTLINE_BRAINSTORM_FILE}, a dated section at the end) when the author confirms`,
  args: '{"title":"…","notes":"- …"}',
  schema: z.object({ title: z.string().max(200).optional(), notes: z.string().trim().min(1).max(NOTES_CHARS) }).strict(),
  async run(args, { context, settings, italian, now }) {
    if (!synopsisEditsEnabled(settings)) return disabledEdits("save_brainstorm_notes");
    const before = context.synopsis.files.get(OUTLINE_BRAINSTORM_FILE);
    const content = appendBrainstormNotes(before?.content ?? "", { title: unescapePromptDataDeep(args.title ?? ""), notes: unescapePromptDataDeep(args.notes), at: now?.() ?? new Date() });
    const sourceRevisions = { [OUTLINE_BRAINSTORM_FILE]: before?.hash ?? null };
    const message: AssistantMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      text: italian ? "Salvo queste decisioni negli appunti di Brainstorming del libro? Nulla è scritto finché non lo confermi." : "Save these decisions in the book's Brainstorming notes? Nothing is written until you confirm.",
      action: {
        kind: "apply-file-updates",
        bookId: context.book.id,
        toolId: "edit-outline",
        owner: context.book.owner,
        repo: context.book.repo,
        branch: context.branch,
        sourceRevision: sourceRevisionFromFiles(sourceRevisions),
        sourceRevisions,
        generatedAt: new Date().toISOString(),
        updates: [{ path: OUTLINE_BRAINSTORM_FILE, content, reason: italian ? "Appunti di Brainstorming" : "Brainstorming notes" }],
      },
    };
    return { tool: "save_brainstorm_notes", kind: "proposal", message, text: "Proposed to the author: the decisions, appended to the brainstorm notes. Nothing is written until the author confirms." };
  },
};

const decisionFields = z.object({
  decision: z.string().trim().min(1).max(1_200),
  reason: z.string().max(1_200).optional(),
  chapters: z.array(number).max(40).optional(),
  files: z.array(z.string().max(300)).max(20).optional(),
  secrets: z.array(z.string().max(120)).max(20).optional(),
  avoid: z.array(z.string().max(200)).max(20).optional(),
}).strict();

const proposeBibleDecisions: BrainstormTool<{ decisions?: Array<z.infer<typeof decisionFields>>; questions?: Array<{ question: string; chapters?: number[] }> }> = {
  id: "propose_bible_decisions",
  description: "«capture this decision»: what the author settled in this conversation, and the questions it leaves open, added to the log of decisions of the book (bible/decisions.md) when the author confirms. A decision is always proposed OPEN: only the author locks one, in the Bible. Add `chapters`, `files`, `secrets` or `avoid` (phrases it forbids) only when the author said what the decision covers",
  args: '{"decisions":[{"decision":"…","reason":"…","chapters":[3],"avoid":["…"]}],"questions":[{"question":"…","chapters":[5]}]}',
  schema: z.object({ decisions: z.array(decisionFields).max(20).optional(), questions: z.array(z.object({ question: z.string().trim().min(1).max(1_200), chapters: z.array(number).max(40).optional() }).strict()).max(20).optional() }).strict(),
  async run(args, { context, settings, italian }) {
    if (!synopsisEditsEnabled(settings)) return disabledEdits("propose_bible_decisions");
    const current = context.synopsis.files.get(BIBLE_DECISIONS_FILE) ?? (await context.source.readFiles([BIBLE_DECISIONS_FILE]))[0];
    const outcome = (await import("@/assistant/decisionCapture")).decisionCaptureProposal({
      book: context.book,
      branch: context.branch,
      current: current ? { content: current.content, hash: "hash" in current && typeof current.hash === "string" ? current.hash : await sha256Hex(current.content) } : null,
      by: "brainstorming",
      italian,
      request: unescapePromptDataDeep(args),
      reason: italian ? "Brainstorming: decisioni e domande per la Bibbia" : "Brainstorming: decisions and questions for the Bible",
      text: (decisions, questions) => (italian
        ? `Registro nella Bibbia del libro ${decisions} decisioni e ${questions} domande aperte? Le decisioni restano aperte: le blocchi tu. Nulla è scritto finché non lo confermi.`
        : `Capture ${decisions} decisions and ${questions} open questions in the Bible of the book? The decisions stay open: you lock them. Nothing is written until you confirm.`),
    });
    if ("problem" in outcome) return refused("propose_bible_decisions", `Nothing to capture: ${outcome.problem}. Give at least one decision or one question.`);
    return { tool: "propose_bible_decisions", kind: "proposal", message: outcome.message, text: `Proposed to the author: ${outcome.decisions} decision(s) and ${outcome.questions} open question(s) for the Bible. Nothing is written until the author confirms.` };
  },
};

/** Voices of the room a request of Brainstorming may ask, at most and by default. */
const ROOM_MAX_VOICES = 4;

/**
 * Ask the room: two to four wildcards («Fuori dal coro») read the Synopsis and the author's question, each in a call of its own, and answer as their own
 * characters with ideas, never a score. The chat shows them before the synthesis; the model reads them to synthesise, and turns the ideas the author likes
 * into a proposal of the Synopsis only as every proposal is made. Brainstorming never sees a secret, so no voice that knows them sits in its room.
 */
const askTheRoom: BrainstormTool<{ question: string; voices?: string[]; preset?: "creative-room" | "pre-mortem" }> = {
  id: "ask_the_room",
  description: "asks 2 to 4 wildcards of the room («Fuori dal coro»: provocateurs such as subversive, devils-advocate, cliche-hunter, twist-engineer, genre-guest, naive, antagonist, chaos-maker, poet, or the author's own) about the Synopsis and a question; each answers as its own character with ideas, never a score. The author sees their answers in the chat; you get them back to synthesise: what they agree on, the strongest idea, the risks. Choose the voices by slug or name, or a preset (creative-room, pre-mortem); without either, the creative room",
  args: '{"question":"what the author asks the room","voices"?:["subversive","antagonist"],"preset"?:"creative-room|pre-mortem"}',
  schema: z.object({ question: z.string().trim().min(1).max(2_000), voices: z.array(z.string().trim().min(1).max(120)).max(ROOM_MAX_VOICES).optional(), preset: z.enum(["creative-room", "pre-mortem"]).optional() }).strict(),
  async run(args, env) {
    const { context, settings, italian } = env;
    const [{ pickWildcardVoices, runWildcardRoom }, { rejectedFromJournal, roomAi, roomPanelOf, roomWindow }, { roomForModel, roomTranscript }] = await Promise.all([import("narrarium-engine"), import("@/wildcards/roomRunner"), import("@/wildcards/roomText")]);
    const files = context.source.readFolder ? await context.source.readFolder("wildcards/").catch(() => []) : [];
    // No voice that knows the secrets as the author does: Brainstorming keeps them out of its whole conversation.
    const panel = roomPanelOf(settings, context.language || settings.ui.language, files).filter((profile) => !(profile.group === "sentinel" && profile.secrets === "author"));
    const voices = pickWildcardVoices(panel, { ...(args.voices?.length ? { slugs: args.voices.map((voice) => panel.find((profile) => matchKey(profile.name) === matchKey(voice))?.slug ?? voice) } : { preset: args.preset ?? "creative-room" }), max: ROOM_MAX_VOICES });
    if (!voices.length) return refused("ask_the_room", `No wildcard of the room answers to ${args.voices?.length ? args.voices.map((voice) => `«${voice}»`).join(", ") : `the preset ${args.preset ?? "creative-room"}`} (the ones that are on: ${panel.filter((profile) => profile.enabled).map((profile) => profile.slug).join(", ")}).`);
    const journal = (await context.source.readFiles(["bible/ideas.yml"]).catch(() => []))[0]?.content;
    const window = roomWindow(settings);
    const result = await runWildcardRoom({
      ai: roomAi({ settings, book: context.book, ...(env.accountScope !== undefined ? { accountScope: env.accountScope } : {}), ...(env.signal ? { signal: env.signal } : {}) }),
      voices,
      target: { kind: "conversation", label: italian ? "La conversazione di Brainstorming" : "The Brainstorming conversation" },
      material: brainstormContextText(context),
      context: { title: context.title, language: context.language || settings.ui.language },
      question: args.question,
      rejected: rejectedFromJournal(journal),
      parallel: ROOM_MAX_VOICES,
      ...(window ? { windowTokens: window } : {}),
      cacheKey: `${context.book.id}/wildcards`,
      ...(env.signal ? { signal: env.signal } : {}),
    });
    env.room?.push(roomTranscript(result, italian));
    return data("ask_the_room", [
      `The room answered (${result.voices.filter((voice) => voice.status === "ok").length} of ${result.voices.length} voices); the author already sees each voice in the chat, so do not repeat them one by one.`,
      roomForModel(result),
      "Now synthesise for the author, briefly: what the voices agree on, the strongest idea and why, the risks, and what you would do. Offer to turn the ideas the author chooses into a proposal of the Synopsis; propose it only when the author asks or agrees.",
    ].join("\n"));
  },
};

const TOOLS = [readSynopsis, readSynopsisEntry, readChapterSummary, readCanonEntry, proposeSynopsisEdits, importSynopsisText, checkSynopsis, saveBrainstormNotes, proposeBibleDecisions, askTheRoom] as const;

/** Brainstorming's registry: these tools, in this order, and nothing else. */
export const brainstormToolRegistry: ReadonlyMap<string, BrainstormTool<never>> = new Map(TOOLS.map((tool) => [tool.id, tool as unknown as BrainstormTool<never>]));

export function brainstormToolIds(): BrainstormToolId[] {
  return [...brainstormToolRegistry.keys()] as BrainstormToolId[];
}

/** The tools as the model reads them in its instructions. */
export function brainstormToolLines(): string[] {
  return scopedToolLines(TOOLS);
}

/** Runs one call of the model: a tool of Brainstorming with valid arguments, or nothing at all (a refusal the model and the author are told). */
export async function runBrainstormTool(call: { tool: string; args?: unknown }, env: BrainstormToolEnv): Promise<BrainstormToolOutcome> {
  return runScopedTool(brainstormToolRegistry, call, env, (tool) => `There is no tool «${tool}» in Brainstorming, so nothing was run. Its only tools are ${BRAINSTORM_TOOL_IDS.join(", ")}: it cannot write prose, change chapters, open pages or use GitHub.`) as Promise<BrainstormToolOutcome>;
}
