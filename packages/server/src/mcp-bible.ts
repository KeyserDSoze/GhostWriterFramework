import {
  BIBLE_DECISIONS_FILE,
  BIBLE_THEMES_FILE,
  BIBLE_THREADS_FILE,
  BIBLE_WORLD_FILE,
  OUTLINE_DESIGN_FIELDS,
  OutlineReader,
  askQuestion,
  captureDecision,
  designFindings,
  findingText,
  isDesignEmpty,
  loadDesignCheckInput,
  loadTimelineEvents,
  loadSpoilerSecretsOfBook,
  loadWrittenChapters,
  missingDesignFields,
  nextThreadId,
  openQuestions,
  lockedDecisions,
  outlineDesignGaps,
  readBibleDecisions,
  readBibleThemes,
  readBibleThreads,
  readBibleWorld,
  serializeBibleDecisions,
  serializeBibleThemes,
  serializeBibleThreads,
  serializeBibleWorld,
  spoilerChecks,
  type AutopilotState,
  type BibleThread,
  type BookFileChange,
  type DesignFinding,
  type ThreadStatus,
} from "narrarium-engine";
import { asInteger, json, ToolError, type McpTool, type ToolContext } from "./mcp-kit.js";
import { boolean, choice, integer, list, nullable, shape, string } from "./mcp-schema.js";

/**
 * The tools of the Bible: what the book has agreed (its decisions, the open questions, the threads of setup and payoff, the timeline, the tone and the audience, the rules of the
 * world), the design of every chapter with what the checks find in it, and the one tool that writes `bible/`. A decision is captured OPEN and a question is asked open: only the
 * author locks a decision and answers a question, in the app (a lock binds every agent, and an assistant must not give itself that power). `write_file` does not write this folder
 * (`mcp-policy.ts`): the engine writes it, with the formats it owns.
 */

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
/** It adds (a decision captured twice is two decisions) and replaces what it names: not idempotent, not destructive of anything it was not asked to change. */
const EDIT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

const BIBLE_PARTS = ["decisions", "questions", "threads", "timeline", "themes", "world"] as const;
type BiblePart = (typeof BIBLE_PARTS)[number];

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

async function autopilotState(context: ToolContext): Promise<AutopilotState | null> {
  return (await context.runtime.session.snapshot()).state;
}

const readBibleTool: McpTool = {
  name: "read_bible",
  title: "Read the Bible",
  description: "Reads what the book has agreed, from the files of `bible/` and the timeline: the decisions (the log, with the ones the author LOCKED: they bind every agent, so never propose what contradicts one), the open questions (not yours to settle), the threads of setup and payoff, the events of the timeline with their date and chapter, the themes, the tone and the audience, and the rules of the world. `part` reads one of them.",
  scope: "read",
  annotations: READ_ONLY,
  inputSchema: shape({
    part: choice("One part only: `decisions`, `questions`, `threads`, `timeline`, `themes`, `world`. Default: all of them.", BIBLE_PARTS),
  }),
  async run(context, args) {
    const part = (typeof args.part === "string" ? args.part : undefined) as BiblePart | undefined;
    const wants = (name: BiblePart) => !part || part === name;
    const { store } = context.runtime;
    context.touch(BIBLE_DECISIONS_FILE, BIBLE_THREADS_FILE, BIBLE_THEMES_FILE, BIBLE_WORLD_FILE);
    const [decisionsFile, threadsFile, themesFile, worldFile] = await Promise.all([store.read(BIBLE_DECISIONS_FILE), store.read(BIBLE_THREADS_FILE), store.read(BIBLE_THEMES_FILE), store.read(BIBLE_WORLD_FILE)]);
    const decisions = readBibleDecisions(decisionsFile?.content);
    const result: Record<string, unknown> = {};
    if (wants("decisions")) result.decisions = { locked: lockedDecisions(decisions.value).length, hash: decisionsFile?.hash ?? null, items: decisions.value.decisions, ...(decisions.problems.length ? { problems: decisions.problems } : {}) };
    if (wants("questions")) result.questions = { open: openQuestions(decisions.value).length, items: decisions.value.questions };
    if (wants("threads")) result.threads = { hash: threadsFile?.hash ?? null, items: readBibleThreads(threadsFile?.content).value.threads };
    if (wants("themes")) {
      const themes = readBibleThemes(themesFile?.content);
      result.themes = { themes: themes.themes, tone: themes.tone, audience: themes.audience, hash: themesFile?.hash ?? null };
    }
    if (wants("world")) result.world = { rules: readBibleWorld(worldFile?.content).rules, hash: worldFile?.hash ?? null };
    if (wants("timeline")) {
      result.timeline = (await loadTimelineEvents(store, await context.snapshot())).sort((left, right) => (left.date ?? "~").localeCompare(right.date ?? "~") || left.title.localeCompare(right.title));
    }
    return json(result);
  },
};

const FIELD_KEYS = OUTLINE_DESIGN_FIELDS.map((field) => field.key);

interface FindingView {
  code: string;
  severity: string;
  chapter?: number;
  secret?: string;
  text: string;
}

const findingView = (finding: DesignFinding, language: string): FindingView => ({
  code: finding.code,
  severity: finding.severity,
  ...(finding.chapter !== undefined ? { chapter: finding.chapter } : {}),
  ...(finding.secret ? { secret: finding.secret.slug } : {}),
  text: findingText(finding, language),
});

const readDesign: McpTool = {
  name: "read_design",
  title: "Read the design of the chapters",
  description: `Reads the design of the chapters of the Synopsis (their \`design:\`: ${FIELD_KEYS.join(", ")}) with the fields each lacks, and what the deterministic checks of the design find: a secret told too early, a clue that names the secret, a character acting on a secret before learning it, a thread without a payoff, a date or a place that contradicts another, a name the canon does not have. They are findings, never blockers. With \`written\` it also reads the chapters already written and lists the sentences that state a secret before its reveal.`,
  scope: "read",
  annotations: READ_ONLY,
  inputSchema: shape({
    from: integer("First chapter (default 1).", 1, 1_000_000),
    to: integer("Last chapter (default: the last).", 1, 1_000_000),
    limit: integer("How many chapters to return (default 40, at most 100).", 1, 100),
    findings: boolean("Add the findings of the checks (default true)."),
    written: boolean("Also check the written chapters for secrets stated before their reveal (default false: it reads their text)."),
  }),
  async run(context, args) {
    const snapshot = await context.snapshot();
    const { store } = context.runtime;
    const reader = OutlineReader.of(store, snapshot);
    const state = await autopilotState(context);
    const from = asInteger(args.from, 1);
    const to = asInteger(args.to, Number.MAX_SAFE_INTEGER);
    const limit = asInteger(args.limit, 40);
    const entries = (await reader.chapters()).filter((entry) => entry.number >= from && entry.number <= to);
    const shown = entries.slice(0, limit);
    const chapters = shown.map((entry) => ({
      number: entry.number,
      title: entry.title,
      design: entry.design ?? null,
      gaps: entry.design && !isDesignEmpty(entry.design) ? missingDesignFields(entry.design) : [...FIELD_KEYS].filter((key) => ["goal", "pov", "events", "ending"].includes(key)),
    }));
    const result: Record<string, unknown> = { chapters, total: entries.length, ...(entries.length > shown.length ? { nextFrom: entries[shown.length].number } : {}) };
    if (args.findings !== false) {
      const input = await loadDesignCheckInput(store, snapshot, reader, state ?? { concept: { done: false, generated: false, secrets: [] }, plan: null });
      const language = snapshot.book.language || "en";
      const all = [...designFindings(input), ...outlineDesignGaps(input.chapters)];
      if (args.written === true) {
        const [written, secrets] = await Promise.all([loadWrittenChapters(store, snapshot), loadSpoilerSecretsOfBook(store, snapshot, new Map((state?.concept.secrets ?? []).map((secret) => [secret.slug, secret.revealChapter])))]);
        all.push(...spoilerChecks({ chapters: written, secrets }));
        result.writtenChapters = written.length;
      }
      result.findings = all.slice(0, 200).map((finding) => findingView(finding, language));
      result.findingsTotal = all.length;
    }
    return json(result);
  },
};

// ─── The one tool that writes `bible/` ──────────────────────────────────────

const decisionShape = shape({
  decision: string("What was decided, in a sentence.", { minLength: 1, maxLength: 1200 }),
  reason: string("Why it was decided, in a sentence.", { maxLength: 1200 }),
  chapters: list("The chapters it is about: a change to the entry of these chapters in the Synopsis is held until the author decides.", integer("A chapter number.", 1, 1_000_000), 40),
  files: list("Files it is about (`secrets/the-wreck.md`).", string("A path.", { maxLength: 300 }), 20),
  secrets: list("Secrets it is about, by slug.", string("A slug.", { maxLength: 120 }), 20),
  avoid: list("Phrases it forbids: a change whose new text has one is held.", string("A phrase.", { maxLength: 200 }), 20),
}, ["decision"]);

const questionShape = shape({
  question: string("What the story still has to settle.", { minLength: 1, maxLength: 1200 }),
  chapters: list("The chapters it is about.", integer("A chapter number.", 1, 1_000_000), 40),
}, ["question"]);

const threadShape = shape({
  id: string("An existing thread to change (`t-001`); without it a new thread is made.", { maxLength: 20 }),
  title: string("What is planted.", { maxLength: 300 }),
  setupChapter: nullable(integer("The chapter that plants it.", 1, 1_000_000)),
  payoffChapter: nullable(integer("The chapter that pays it off.", 1, 1_000_000)),
  status: choice("`open`, `paid` or `dropped` (given up on purpose).", ["open", "paid", "dropped"]),
}, []);

const editBible: McpTool = {
  name: "edit_bible",
  title: "Edit the Bible",
  description: "Writes `bible/` as ONE commit: captures decisions (ALWAYS open: only the author locks one, in the app, and a lock is what binds every agent), adds open questions (only the author answers them), adds or changes threads of setup and payoff, and sets the themes, the tone, the audience and the rules of the world. Nothing is overwritten that the call does not name; a decision or a question is added at the end of the log, never rewritten. Read the Bible first (`read_bible`) so as not to repeat what it says.",
  scope: "write",
  annotations: EDIT,
  inputSchema: shape({
    decisions: list("Decisions to capture, open.", decisionShape, 20),
    questions: list("Open questions to add.", questionShape, 20),
    threads: list("Threads to add or change.", threadShape, 30),
    themes: list("The themes of the book, replacing the ones it has.", string("A theme.", { maxLength: 300 }), 30),
    tone: string("The tone of the book, replacing the one it has.", { maxLength: 600 }),
    audience: string("The audience of the book, replacing the one it has.", { maxLength: 600 }),
    rules: list("The rules of the world the story must never break, replacing the ones it has.", string("A rule.", { maxLength: 600 }), 60),
  }),
  async run(context, args) {
    const { store } = context.runtime;
    context.touch(BIBLE_DECISIONS_FILE, BIBLE_THREADS_FILE, BIBLE_THEMES_FILE, BIBLE_WORLD_FILE);
    const [decisionsFile, threadsFile, themesFile, worldFile] = await Promise.all([store.read(BIBLE_DECISIONS_FILE), store.read(BIBLE_THREADS_FILE), store.read(BIBLE_THEMES_FILE), store.read(BIBLE_WORLD_FILE)]);
    const changes: BookFileChange[] = [];
    const applied: string[] = [];
    const now = new Date();

    const decisions = Array.isArray(args.decisions) ? (args.decisions as Array<Record<string, unknown>>) : [];
    const questions = Array.isArray(args.questions) ? (args.questions as Array<Record<string, unknown>>) : [];
    if (decisions.length || questions.length) {
      let content = decisionsFile?.content ?? null;
      let added = 0;
      for (const item of decisions) {
        const captured = captureDecision(content, { decision: text(item.decision), reason: text(item.reason), by: "copilot", status: "open", chapters: item.chapters as number[] | undefined, files: item.files as string[] | undefined, secrets: item.secrets as string[] | undefined, avoid: item.avoid as string[] | undefined }, now);
        if ("content" in captured) {
          content = captured.content;
          added += 1;
          applied.push(`decision ${captured.decision.id} captured, open`);
        }
      }
      for (const item of questions) {
        const asked = askQuestion(content, { question: text(item.question), by: "copilot", chapters: item.chapters as number[] | undefined }, now);
        if ("content" in asked) {
          content = asked.content;
          added += 1;
          applied.push(`question ${asked.question.id} added, open`);
        }
      }
      if (added && content !== null) changes.push({ path: BIBLE_DECISIONS_FILE, content, expectedHash: decisionsFile?.hash ?? null });
    }

    const threadEdits = Array.isArray(args.threads) ? (args.threads as Array<Record<string, unknown>>) : [];
    if (threadEdits.length) {
      const current = readBibleThreads(threadsFile?.content).value;
      const threads: BibleThread[] = current.threads.map((thread) => ({ ...thread }));
      for (const edit of threadEdits) {
        const id = text(edit.id);
        const existing = id ? threads.find((thread) => thread.id === id) : undefined;
        if (id && !existing) throw new ToolError("not_found", `There is no thread ${id}: read the Bible (read_bible) for the ids.`);
        const target: BibleThread = existing ?? { id: nextThreadId(threads), title: text(edit.title), status: "open" };
        if (!existing) {
          if (!target.title) throw new ToolError("invalid_input", "A new thread needs a title.");
          threads.push(target);
        }
        if (typeof edit.title === "string" && text(edit.title)) target.title = text(edit.title);
        if (edit.setupChapter === null) delete target.setup;
        else if (typeof edit.setupChapter === "number") target.setup = { chapter: edit.setupChapter, note: target.setup?.note ?? "" };
        if (edit.payoffChapter === null) delete target.payoff;
        else if (typeof edit.payoffChapter === "number") target.payoff = { chapter: edit.payoffChapter, note: target.payoff?.note ?? "" };
        if (edit.status === "open" || edit.status === "paid" || edit.status === "dropped") target.status = edit.status as ThreadStatus;
        applied.push(`thread ${target.id} ${existing ? "changed" : "added"}`);
      }
      changes.push({ path: BIBLE_THREADS_FILE, content: serializeBibleThreads({ threads, notes: current.notes }, threadsFile?.content), expectedHash: threadsFile?.hash ?? null });
    }

    if (Array.isArray(args.themes) || typeof args.tone === "string" || typeof args.audience === "string") {
      const current = readBibleThemes(themesFile?.content);
      const themes = Array.isArray(args.themes) ? (args.themes as unknown[]).filter((item): item is string => typeof item === "string") : current.themes;
      changes.push({
        path: BIBLE_THEMES_FILE,
        content: serializeBibleThemes({ themes, tone: typeof args.tone === "string" ? args.tone : current.tone, audience: typeof args.audience === "string" ? args.audience : current.audience, notes: current.notes }, themesFile?.content),
        expectedHash: themesFile?.hash ?? null,
      });
      applied.push("themes, tone and audience set");
    }
    if (Array.isArray(args.rules)) {
      const current = readBibleWorld(worldFile?.content);
      changes.push({ path: BIBLE_WORLD_FILE, content: serializeBibleWorld({ rules: (args.rules as unknown[]).filter((item): item is string => typeof item === "string"), notes: current.notes }, worldFile?.content), expectedHash: worldFile?.hash ?? null });
      applied.push("rules of the world set");
    }
    if (!changes.length) return json({ edited: false, message: "Nothing to change: the call named no decision, question, thread, theme, tone, audience or rule." });
    context.touch(...changes.map((change) => change.path));
    const commit = await context.commit(changes, `edit bible: ${applied.join("; ")}`.slice(0, 200));
    return json({ edited: true, applied, files: changes.map((change) => change.path), ...(commit ? { commit } : {}) });
  },
};

export const BIBLE_READ_TOOLS: McpTool[] = [readBibleTool, readDesign];
export const BIBLE_WRITE_TOOLS: McpTool[] = [editBible];
