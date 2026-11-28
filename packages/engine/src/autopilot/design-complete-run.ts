import { normalizeScore, requireStructuredFields } from "../ai/structured.js";
import { AI_CAPABILITIES, AiReplyRejectedError, type AiJsonSchema } from "../ai/types.js";
import { canonManifest, readBody } from "../book/context.js";
import { OUTLINE_DESIGN_FIELDS, OUTLINE_DESIGN_LABELS, designText, type OutlineChapterDesign, type OutlineDesignKey } from "../book/design.js";
import { designFindings, findingText } from "../book/design-checks.js";
import type { OutlineChapterEntry } from "../book/outline.js";
import { STORY_DESIGN_FILE } from "../book/paths.js";
import { directorSystemPrompt, parseDirectorVerdict } from "../director/opinion.js";
import { readerPersonaSystemPrompt } from "../profiles/readers.js";
import { asArray, asInteger, asOneOf, asRecord, asString } from "../util/json.js";
import { clipText, isItalian, languageName, truncate } from "../util/text.js";
import { architectSystemPrompt } from "./prompts.js";
import { DESIGN_FINDING_CRITERIA, DESIGN_CANON_PROPOSAL_KINDS, COMPLETION_CANON_DESCRIPTION_CHARS, COMPLETION_CANON_MAX, COMPLETION_READING_CHARS, canonProposalId, completionBatch, completionRound, completionWaiting, missingDesignKeys, readCompletionFindings, readFieldProposals, replaceFindings } from "./design-complete.js";
import { designPlateau, designTarget, endDesign, loadDesignCheckInput } from "./design.js";
import { outlineDesignGaps } from "./outline-check.js";
import { designMaxRounds } from "./state.js";
import {
  authorOutline,
  authorRules,
  bookHeader,
  briefBlock,
  data,
  designContext,
  directorTaste,
  evaluationStyleOf,
  outlineBookSection,
  outlineOf,
  outputLimit,
  readerReply,
  request,
  sameCanonEntity,
  skipReader,
  stableFirst,
  type TaskContext,
  type TaskResult,
} from "./tasks.js";
import type { DesignCanonProposal, DesignCompletion, DesignCompletionChapter, DesignCompletionReading, DesignOutcome } from "./types.js";

/**
 * The steps of «Review and complete» (`design-complete.ts`, #125): the architect proposes what the design of a batch of the author's chapters lacks, with what does not
 * hold together in them and the canon they need; the simulated readers read the chapters with the proposals; the director reviews them, sends back the proposals that do
 * not fit, and ends the run when they do. Every step writes nothing in the book: what they find is kept in the state (`AutopilotDesign.completion`), for the author.
 */

const string = { type: "string" } as const;
const strings = { type: "array", items: { type: "string" } } as const;

/** The design fields, all of them optional, as the model writes them: what it proposes for an entry. */
const PROPOSED_FIELDS = {
  type: "object",
  description: "Only the design fields listed as missing for the chapter; leave out any its text gives nothing to base it on.",
  properties: Object.fromEntries(OUTLINE_DESIGN_FIELDS.map(({ key, kind }) => [key, kind === "flag" ? { type: "boolean", description: OUTLINE_DESIGN_LABELS[key] } : kind === "list" ? { ...strings, description: OUTLINE_DESIGN_LABELS[key] } : { ...string, description: OUTLINE_DESIGN_LABELS[key] }])),
} as const;

const FINDING = {
  type: "object",
  properties: {
    severity: { type: "string", enum: ["critical", "major", "minor"], description: "critical: it breaks the book (a contradiction, a plot hole, an impossible knowledge, a premature reveal); major: a real weakness; minor: a detail." },
    criterion: { type: "string", enum: [...DESIGN_FINDING_CRITERIA], description: "The criterion it is about." },
    issue: { ...string, description: "What does not hold together, or is weak, in a sentence or two." },
    suggestion: { ...string, description: "What the author could do about it, in a line." },
  },
  required: ["severity", "criterion", "issue", "suggestion"],
} as const;

const CHAPTER_FINDING = { ...FINDING, properties: { chapterNumber: { type: "number" }, ...FINDING.properties }, required: ["chapterNumber", ...FINDING.required] } as const;

export const DESIGN_COMPLETE_TOOL: AiJsonSchema = {
  name: "chapter_completion",
  description: "Propose what the design of the author's chapters lacks, what does not hold together in them, and the canon entries they need. Never their prose, never a change of what happens.",
  parameters: {
    type: "object",
    properties: {
      chapters: {
        type: "array",
        items: {
          type: "object",
          properties: { number: { type: "number" }, fields: PROPOSED_FIELDS, findings: { type: "array", items: FINDING } },
          required: ["number", "fields", "findings"],
        },
      },
      canon: {
        type: "array",
        description: "The characters, places, factions, items and secrets these chapters name or need that the canon lacks. Empty when there is none.",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: [...DESIGN_CANON_PROPOSAL_KINDS] },
            name: string,
            description: { ...string, description: "Who or what it is, in two or three sentences drawn from the chapters (for a secret: its truth)." },
            chapters: { type: "array", items: { type: "number" }, description: "The chapters that need it." },
          },
          required: ["kind", "name", "description", "chapters"],
        },
      },
    },
    required: ["chapters", "canon"],
  },
};

export const DESIGN_COMPLETE_READING_TOOL: AiJsonSchema = {
  name: "completion_reading",
  description: "React, as the configured reader, to the chapters of a novel not written yet and to what is proposed to complete their design.",
  parameters: {
    type: "object",
    properties: {
      interest: { type: "number", description: "How much you want to read this book, from 0 to 10." },
      reaction: { ...string, description: "Your reaction as this reader, in a few sentences." },
      findings: { type: "array", items: CHAPTER_FINDING, description: "What is inconsistent, predictable, superfluous or dull, chapter by chapter." },
    },
    required: ["interest", "reaction", "findings"],
  },
};

export const DESIGN_COMPLETE_REVIEW_TOOL: AiJsonSchema = {
  name: "completion_review",
  description: "Review the author's chapters and what is proposed to complete their design.",
  parameters: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["approve", "revise"] },
      score: { type: "number", description: "The chapters as they would be designed with the proposals, from 0 to 10." },
      summary: { ...string, description: "Your judgement, in a few sentences." },
      findings: { type: "array", items: CHAPTER_FINDING, description: "What is inconsistent or weak in the author's chapters, for the author to decide about. Empty when there is none." },
      redo: {
        type: "array",
        description: "The chapters whose proposals must be made again because they do not fit the chapter, with what to change. Empty when they all fit.",
        items: { type: "object", properties: { chapterNumber: { type: "number" }, instruction: string }, required: ["chapterNumber", "instruction"] },
      },
    },
    required: ["verdict", "score", "summary", "findings", "redo"],
  },
};

const COMPLETE_ARCHITECT_ROLE = [
  "This is «Review and complete»: the author has written these chapters in the Synopsis, and their text binds. You complete their design; you never rewrite them.",
  "Propose only the design fields each chapter lacks (MISSING FIELDS), drawn from what its text says and consistent with the chapters around it. Leave out a field its text gives you nothing to base it on: no proposal is better than an invented one.",
  "Never change what happens, the order of the events, the names or the title: what the author wrote is the truth of the chapter.",
  "Then say what does not hold together or is weak in each chapter (findings): a contradiction with another chapter, a plot hole, an impossible knowledge, a premature reveal, a missing setup or payoff, a flat stretch. Each finding names its severity and its criterion, and suggests what the author could do.",
  "List the characters, places, factions, items and secrets the chapters need that the canon lacks (canon), with a short description drawn from the chapters; never one the canon has.",
].join("\n");

const COMPLETE_READER_ROLE = [
  "You are reading the chapters of a novel that is not written yet, as its author wrote them in the Synopsis, with what is proposed to complete their design.",
  "React as this reader would: engagement, originality, pace, suspense, credibility, emotional impact. Say chapter by chapter what is inconsistent, predictable, superfluous or dull (findings), and what you would do instead.",
].join("\n");

/** Characters of the texts of the author's chapters a reader and the director read in all, and of what is proposed for them. */
const CHAPTERS_CHARS = { reader: 40_000, director: 60_000 };
const PROPOSALS_CHARS = { reader: 24_000, director: 40_000 };
/** Characters of a chapter to complete, of the chapter before and after a batch, and of the summaries of the others. */
const BATCH_ENTRY_CHARS = 8000;
const NEIGHBOUR_CHARS = 4000;
const OTHERS_CHARS = 12_000;

const completionOf = (ctx: TaskContext): DesignCompletion => ctx.state.design!.completion!;

function chapterHeading(entry: Pick<OutlineChapterEntry, "number" | "title">): string {
  return `Chapter ${entry.number}${entry.title ? ` «${entry.title}»` : ""}`;
}

/** The design an entry would have with the fields proposed for it that wait: what a reader and the director judge. */
function proposedDesign(entry: OutlineChapterEntry, proposals: DesignCompletionChapter | undefined): OutlineChapterDesign | undefined {
  const fields = (proposals?.fields ?? []).filter((field) => field.status !== "skipped");
  if (!fields.length) return entry.design;
  const design: Record<string, unknown> = { ...(entry.design ?? {}) };
  for (const field of fields) if (design[field.key] === undefined) design[field.key] = field.value;
  return design as OutlineChapterDesign;
}

/** What is proposed for a chapter, a line a field and a line a finding, within `max` characters. */
function proposalsText(proposals: DesignCompletionChapter | undefined, max: number, withFindings = true): string {
  if (!proposals) return "";
  const fields = proposals.fields.map((field) => `${OUTLINE_DESIGN_LABELS[field.key]} (proposed): ${Array.isArray(field.value) ? field.value.join("; ") : field.value === true ? "yes" : field.value === false ? "no" : field.value}`);
  const findings = withFindings ? proposals.findings.map((finding) => `Finding (${finding.source}${finding.by ? ` ${finding.by}` : ""}, ${finding.severity}${finding.criterion ? `, ${finding.criterion}` : ""}): ${finding.text}${finding.suggestion ? ` — ${finding.suggestion}` : ""}`) : [];
  return truncate([...fields, ...findings].join("\n"), max);
}

/** The author's chapters with what is proposed for them, each within its share of `budget`. */
function chaptersWithProposals(entries: readonly OutlineChapterEntry[], completion: DesignCompletion, budget: { chapters: number; proposals: number }, withFindings: boolean): string {
  const reviewed = entries.filter((entry) => completion.chapters.includes(entry.number));
  if (!reviewed.length) return "";
  const share = Math.max(600, Math.floor(budget.chapters / reviewed.length));
  const proposalShare = Math.max(400, Math.floor(budget.proposals / reviewed.length));
  return reviewed.map((entry) => {
    const proposals = completion.entries[String(entry.number)];
    const design = designText(entry.design, Math.floor(proposalShare / 2));
    return [
      `${chapterHeading(entry)}:`,
      truncate(entry.body, share),
      design ? `Design it has:\n${design}` : "",
      proposalsText(proposals, proposalShare, withFindings),
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

/** The chapters around a batch: the one before and the one after in full, the others as a line each. */
function neighbourSections(entries: readonly OutlineChapterEntry[], batch: readonly number[]): string[] {
  const first = batch[0];
  const last = batch[batch.length - 1];
  const inBatch = new Set(batch);
  const before = [...entries].reverse().find((entry) => entry.number < first && entry.body.trim());
  const after = entries.find((entry) => entry.number > last && !inBatch.has(entry.number) && entry.body.trim());
  const full = (entry: OutlineChapterEntry, label: string) => `${label} — ${chapterHeading(entry)}:\n${truncate(entry.body, NEIGHBOUR_CHARS)}${entry.design ? `\nIts design:\n${designText(entry.design, 1500)}` : ""}`;
  const others = entries.filter((entry) => !inBatch.has(entry.number) && entry !== before && entry !== after && (entry.title || entry.body.trim()));
  const share = others.length ? Math.max(80, Math.floor(OTHERS_CHARS / others.length)) : 0;
  return [
    before ? full(before, "THE CHAPTER BEFORE") : "",
    after ? full(after, "THE CHAPTER AFTER") : "",
    others.length ? `THE OTHER CHAPTERS OF THE SYNOPSIS (summaries):\n${others.map((entry) => `${entry.number}. ${entry.title || "(no title)"}${entry.body.trim() ? ` — ${truncate(entry.body.replace(/\s+/g, " ").trim(), share)}` : ""}`).join("\n")}` : "",
  ];
}

/** A canon proposal of the model, when the canon (and what is proposed already) does not have it. */
function canonProposalOf(ctx: TaskContext, item: Record<string, unknown>, known: DesignCanonProposal[], chapters: readonly number[]): DesignCanonProposal | null {
  const kind = asOneOf(item.kind, DESIGN_CANON_PROPOSAL_KINDS, "character");
  if (!DESIGN_CANON_PROPOSAL_KINDS.includes(item.kind as DesignCanonProposal["kind"])) return null;
  const name = clipText(asString(item.name), 160).trim();
  if (!name) return null;
  if (ctx.snapshot.canon.some((entry) => entry.kind === kind && sameCanonEntity(kind, name, [entry.name, ...entry.aliases]))) return null;
  if (known.some((entry) => entry.kind === kind && sameCanonEntity(kind, name, [entry.name]))) return null;
  const wanted = asArray(item.chapters).map((value) => asInteger(value, 0, 0, 100_000)).filter((number) => chapters.includes(number));
  return {
    id: canonProposalId(kind, name),
    kind,
    name,
    description: clipText(asString(item.description), COMPLETION_CANON_DESCRIPTION_CHARS).trim(),
    chapters: [...new Set(wanted)].sort((left, right) => left - right),
    status: "waiting",
  };
}

/**
 * The architect proposes, for a batch of the author's chapters, the design fields each lacks, what does not hold together in them, and the canon entries they need. A
 * chapter the director sent back is proposed again with the director's words. A chapter that is no longer the author's (deleted, emptied) leaves the review.
 */
export async function runDesignComplete(ctx: TaskContext): Promise<TaskResult> {
  const completion = completionOf(ctx);
  const italian = isItalian(ctx.language);
  const batch = completionBatch(completion);
  const all = await outlineOf(ctx).chapters();
  const byNumber = new Map(all.map((entry) => [entry.number, entry]));
  const gone = batch.filter((number) => {
    const entry = byNumber.get(number);
    return !entry || entry.intact || entry.unreadable || !entry.body.trim();
  });
  if (gone.length) {
    completion.chapters = completion.chapters.filter((number) => !gone.includes(number));
    for (const number of gone) delete completion.entries[String(number)];
    completion.redo = (completion.redo ?? []).filter((entry) => !gone.includes(entry.chapter));
    ctx.insight("info", italian ? `${gone.length === 1 ? "Il capitolo" : "I capitoli"} ${gone.join(", ")} non ${gone.length === 1 ? "è più tuo" : "sono più tuoi"} nella Sinossi: ${gone.length === 1 ? "esce" : "escono"} dalla revisione` : `Chapter${gone.length === 1 ? "" : "s"} ${gone.join(", ")} ${gone.length === 1 ? "is" : "are"} no longer yours in the Synopsis: left out of the review`);
  }
  const chapters = batch.filter((number) => !gone.includes(number));
  if (!chapters.length) return { changes: [], summary: italian ? "Nessun capitolo da completare." : "No chapter to complete." };
  const entries = chapters.map((number) => byNumber.get(number)!);
  const redo = new Map((completion.redo ?? []).map((entry) => [entry.chapter, entry.notes]));
  const [view, designData] = await Promise.all([authorOutline(ctx), designContext(ctx)]);
  const missingOf = new Map<number, OutlineDesignKey[]>(entries.map((entry) => [entry.number, missingDesignKeys(entry.design)]));
  const sentBack = entries.filter((entry) => redo.has(entry.number));
  const response = await ctx.ai({
    capability: AI_CAPABILITIES.writer,
    label: `autopilot:design-complete:${chapters[0]}-${chapters[chapters.length - 1]}`,
    system: `${architectSystemPrompt(ctx.language)}\n\n${COMPLETE_ARCHITECT_ROLE}`,
    user: `${request([
      `Review and complete the design of ${chapters.length === 1 ? `chapter ${chapters[0]}` : `chapters ${chapters.join(", ")}`} (THE CHAPTERS TO COMPLETE, in the data): for each, the fields listed as missing, the findings, and the canon they need.`,
      sentBack.length ? "The director sent back the proposals of some of them (THE DIRECTOR SENT THESE BACK, in the data): make them again following the director's words." : "",
      "Write the fields as a design is written: a line for each item of a list, the texts short and concrete, the names as the chapters and the canon say them.",
      authorRules(ctx),
    ])}\n\n${data([
      bookHeader(ctx),
      briefBlock(ctx),
      outlineBookSection(view),
      `THE CHAPTERS TO COMPLETE (the author's, binding):\n${entries.map((entry) => [
        `${chapterHeading(entry)}:`,
        truncate(entry.body, BATCH_ENTRY_CHARS),
        entry.design ? `Design it has (keep it, never propose these):\n${designText(entry.design, 3000)}` : "Design it has: none",
        `MISSING FIELDS: ${(missingOf.get(entry.number) ?? []).join(", ") || "none"}`,
      ].join("\n")).join("\n\n")}`,
      sentBack.length ? `THE DIRECTOR SENT THESE BACK:\n${sentBack.map((entry) => `${chapterHeading(entry)}:\n${(redo.get(entry.number) ?? []).map((note) => `- ${note}`).join("\n")}\nWhat was proposed:\n${proposalsText(completion.entries[String(entry.number)], 2500, false) || "-"}`).join("\n\n")}` : "",
      ...neighbourSections(all, chapters),
      `CANON:\n${canonManifest(ctx.snapshot, { includeSecrets: true }) || "-"}`,
      completion.canon.length ? `CANON ALREADY PROPOSED (do not propose these again):\n${completion.canon.map((entry) => `- ${entry.kind}: ${entry.name}`).join("\n")}` : "",
      ...designData.sections.filter((section) => !section.startsWith("GHOSTWRITER")),
      `DIRECTOR (the author's taste):\n${directorTaste(ctx.director)}`,
    ])}`,
    json: DESIGN_COMPLETE_TOOL,
    maxOutputTokens: outputLimit(ctx, 1500 + chapters.length * 1400),
    temperature: 0.6,
  });
  const output = requireStructuredFields(response.json, { chapters: "list" }, "The proposals of the chapters");
  const proposed = new Map(asArray(output.chapters).map(asRecord).map((item) => [asInteger(item.number, 0, 0, 100_000), item]));
  if (!chapters.some((number) => proposed.has(number))) {
    throw new AiReplyRejectedError(`The proposals have none of the chapters asked: return chapters ${chapters.join(", ")}, each with its number, its fields and its findings.`);
  }
  const round = ctx.state.design!.rounds.length;
  let fields = 0;
  let findings = 0;
  for (const entry of entries) {
    const item = proposed.get(entry.number) ?? {};
    const before = completion.entries[String(entry.number)];
    const proposals: DesignCompletionChapter = {
      number: entry.number,
      title: entry.title,
      digest: entry.contentDigest,
      fields: readFieldProposals(item.fields, missingOf.get(entry.number) ?? [], entry.number),
      findings: before?.findings ?? [],
    };
    const next = replaceFindings(proposals, "architect", readCompletionFindings(item.findings, "architect", (index) => `a${entry.number}-${round}-${index}`));
    completion.entries[String(entry.number)] = next;
    fields += next.fields.length;
    findings += next.findings.filter((finding) => finding.source === "architect").length;
  }
  completion.redo = (completion.redo ?? []).filter((entry) => !chapters.includes(entry.chapter));
  if (!completion.redo.length) delete completion.redo;
  for (const item of asArray(output.canon).map(asRecord)) {
    if (completion.canon.length >= COMPLETION_CANON_MAX) break;
    const proposal = canonProposalOf(ctx, item, completion.canon, completion.chapters);
    if (proposal) completion.canon.push(proposal);
  }
  const which = chapters.length === 1 ? `${chapters[0]}` : `${chapters[0]}-${chapters[chapters.length - 1]}`;
  return {
    changes: [],
    summary: italian
      ? `Capitoli ${which}: ${fields === 1 ? "un campo proposto" : `${fields} campi proposti`}, ${findings === 1 ? "un rilievo" : `${findings} rilievi`}.`
      : `Chapters ${which}: ${fields === 1 ? "one field proposed" : `${fields} fields proposed`}, ${findings === 1 ? "one finding" : `${findings} findings`}.`,
  };
}

/** A simulated reader reads the author's chapters with what is proposed for them: a vote, a reaction, and the weak points chapter by chapter. */
export async function runDesignCompleteReader(ctx: TaskContext): Promise<TaskResult> {
  const completion = completionOf(ctx);
  const round = completionRound(ctx.state.design!);
  const reader = ctx.readerPanel.find((entry) => entry.slug === ctx.task.reader);
  if (!reader) {
    completion.skippedReaders = [...new Set([...(completion.skippedReaders ?? []), ctx.task.reader ?? ""])].filter(Boolean);
    return { changes: [], summary: "Reader not available." };
  }
  const [entries, premise] = await Promise.all([outlineOf(ctx).chapters(), readBody(ctx.store, STORY_DESIGN_FILE, 2500)]);
  const asked = await readerReply(ctx, ctx.ai({
    capability: AI_CAPABILITIES.reader,
    label: `autopilot:design-complete-reader:${reader.slug}`,
    system: `${readerPersonaSystemPrompt(reader, languageName(ctx.language), "brief")}\n\n${COMPLETE_READER_ROLE}`,
    user: `${request(["React as this reader: would you read this book? What excites you, what worries you, and what is inconsistent, predictable, superfluous or dull, chapter by chapter?"])}\n\n${data([
      bookHeader(ctx),
      ctx.state.brief.idea ? `PITCH:\n${ctx.state.brief.idea}` : "",
      premise ? `PREMISE:\n${premise}` : "",
      `THE CHAPTERS (the author's, with the design proposed for them):\n${chaptersWithProposals(entries, completion, { chapters: CHAPTERS_CHARS.reader, proposals: PROPOSALS_CHARS.reader }, false)}`,
    ])}`,
    json: DESIGN_COMPLETE_READING_TOOL,
    maxOutputTokens: outputLimit(ctx, 3000),
  }), (response) => requireStructuredFields(response.json, { interest: "score", reaction: "text" }, "The reader's reading"));
  if ("skipped" in asked) {
    completion.skippedReaders = [...new Set([...(completion.skippedReaders ?? []), reader.slug])];
    return skipReader(ctx, reader.name, asked.skipped);
  }
  const output = asked.value;
  const score = Math.round(Math.max(0, normalizeScore(output.interest) ?? 5) * 10) / 10;
  const reading: DesignCompletionReading = { slug: reader.slug, name: reader.name, round, score, summary: clipText(asString(output.reaction), COMPLETION_READING_CHARS).trim() };
  completion.readings = [...completion.readings.filter((entry) => !(entry.slug === reader.slug && entry.round === round)), reading];
  const byChapter = new Map<number, unknown[]>();
  for (const item of asArray(output.findings).map(asRecord)) {
    const number = asInteger(item.chapterNumber, 0, 0, 100_000);
    if (!completion.entries[String(number)]) continue;
    byChapter.set(number, [...(byChapter.get(number) ?? []), item]);
  }
  // A new reading says again what this reader finds: what it found before is replaced, in every chapter.
  for (const [key, entry] of Object.entries(completion.entries)) {
    const number = Number(key);
    completion.entries[key] = replaceFindings(entry, "reader", readCompletionFindings(byChapter.get(number) ?? [], "reader", (index) => `r${number}-${reader.slug}-${round}-${index}`, { slug: reader.slug, name: reader.name }), reader.slug);
  }
  ctx.insight(score >= 7 ? "ok" : score >= 5 ? "info" : "warning", `${reader.name}: ${score}/10`, reading.summary);
  return { changes: [], summary: `${score}/10 — ${truncate(reading.summary, 240)}` };
}

/**
 * The director reviews the author's chapters with what is proposed for them, the readers' readings and the checks that need no model: a vote, what is inconsistent or weak
 * (findings, for the author), and the chapters whose proposals must be made again. The review ends the run when it approves at the target, when nothing is sent back, or when
 * the reviews of the policy are used (or stopped improving); else the chapters sent back are proposed again. The author's text is never asked to change.
 */
export async function runDesignCompleteReview(ctx: TaskContext): Promise<TaskResult> {
  const design = ctx.state.design!;
  const completion = completionOf(ctx);
  const italian = isItalian(ctx.language);
  const outline = outlineOf(ctx);
  const [entries, view, storyDesign, checkInput] = await Promise.all([
    outline.chapters(),
    authorOutline(ctx),
    readBody(ctx.store, STORY_DESIGN_FILE, 5000),
    loadDesignCheckInput(ctx.store, ctx.snapshot, outline, ctx.state),
  ]);
  // The checks read the design every chapter would have with the proposals.
  const byNumber = new Map(entries.map((entry) => [entry.number, entry]));
  const checked = { ...checkInput, chapters: checkInput.chapters.map((chapter) => {
    const entry = byNumber.get(chapter.number);
    const design = entry ? proposedDesign(entry, completion.entries[String(chapter.number)]) : chapter.design;
    return { ...chapter, ...(design ? { design } : {}) };
  }) };
  const checks = [...designFindings(checked), ...outlineDesignGaps(checked.chapters.filter((chapter) => completion.chapters.includes(chapter.number)))];
  const style = evaluationStyleOf(ctx, "plan");
  const target = designTarget(ctx.state, ctx.director);
  const maxRounds = designMaxRounds(design);
  const round = completionRound(design);
  const lastRound = round >= maxRounds;
  const readings = completion.readings.filter((reading) => reading.round === round);
  const response = await ctx.ai({
    capability: AI_CAPABILITIES.director,
    label: "autopilot:design-complete-review",
    system: directorSystemPrompt(ctx.director, ctx.language),
    ...stableFirst([
      bookHeader(ctx),
      briefBlock(ctx),
      outlineBookSection(view),
      style.block,
      storyDesign ? `STORY DESIGN:\n${storyDesign}` : "",
      `CANON:\n${canonManifest(ctx.snapshot, { includeSecrets: true }) || "-"}`,
    ], [
      `THE AUTHOR'S CHAPTERS, WITH WHAT IS PROPOSED FOR THEM (the chapters bind; the proposals are yours to judge):\n${chaptersWithProposals(entries, completion, { chapters: CHAPTERS_CHARS.director, proposals: PROPOSALS_CHARS.director }, true)}`,
      completion.canon.length ? `CANON PROPOSED:\n${completion.canon.map((entry) => `- ${entry.kind} «${entry.name}» (chapters ${entry.chapters.join(", ") || "-"}): ${truncate(entry.description, 240)}`).join("\n")}` : "",
      checks.length ? `DESIGN CHECKS (found without a model):\n${checks.slice(0, 30).map((finding) => `- ${findingText(finding, "en")}`).join("\n")}${checks.length > 30 ? `\n- … and ${checks.length - 30} more` : ""}` : "DESIGN CHECKS (found without a model): nothing.",
      readings.length ? `SIMULATED READERS:\n${readings.map((reading) => `- ${reading.name} (weight ${ctx.director.readerWeights[reading.slug] ?? 1}): ${reading.score}/10 — ${reading.summary}`).join("\n")}` : "",
    ], request([
      `Review the chapters the author wrote and what is proposed to complete their design (review ${round} of at most ${Math.max(maxRounds, round)}).`,
      "The author's text binds: never ask to change what happens in a chapter, its order or its title. You judge the proposals (the design fields proposed for each chapter) and the chapters as they would be designed with them.",
      `Approve when the proposals fit their chapters and complete them well, and the chapters as designed deserve ${target}/10 or more; otherwise send back (redo) the chapters whose proposals must be made again, with what to change.`,
      "List what is inconsistent or weak in the author's chapters (findings), chapter by chapter, each with its severity, its criterion and what the author could do: they are for the author, who decides. Do not repeat a finding the data already has.",
      "Weigh the simulated readers by their weights, and the DESIGN CHECKS: they are found without a model and may be noise.",
      lastRound ? "This is the final review: approve unless a proposal contradicts its chapter." : "",
      style.rule,
      authorRules(ctx, false),
    ])),
    json: DESIGN_COMPLETE_REVIEW_TOOL,
    maxOutputTokens: outputLimit(ctx, 3000 + Math.min(completion.chapters.length, 40) * 120),
  });
  const output = requireStructuredFields(response.json, { verdict: "text", score: "score" }, "The director's review of the proposals");
  const verdict = parseDirectorVerdict(output.verdict);
  if (!verdict) throw new AiReplyRejectedError("The director's review of the proposals was rejected: the field \"verdict\" must be \"approve\" or \"revise\".");
  const score = Math.round(normalizeScore(output.score)! * 10) / 10;
  const summary = asString(output.summary);
  const byChapter = new Map<number, unknown[]>();
  for (const item of asArray(output.findings).map(asRecord)) {
    const number = asInteger(item.chapterNumber, 0, 0, 100_000);
    if (!completion.entries[String(number)]) continue;
    byChapter.set(number, [...(byChapter.get(number) ?? []), item]);
  }
  // The director's findings of this review replace those of the one before, in every chapter.
  let critical = 0;
  for (const [key, entry] of Object.entries(completion.entries)) {
    const number = Number(key);
    const next = replaceFindings(entry, "director", readCompletionFindings(byChapter.get(number) ?? [], "director", (index) => `d${number}-${round}-${index}`));
    critical += next.findings.filter((finding) => finding.source === "director" && finding.severity === "critical").length;
    completion.entries[key] = next;
  }
  const redo = new Map<number, string[]>();
  for (const item of asArray(output.redo).map(asRecord)) {
    const number = asInteger(item.chapterNumber, 0, 0, 100_000);
    const instruction = clipText(asString(item.instruction), 600).trim();
    if (!instruction || !completion.chapters.includes(number)) continue;
    redo.set(number, [...(redo.get(number) ?? []), instruction].slice(0, 8));
  }
  const scores = readings.map((reading) => reading.score);
  const readers = scores.length ? Math.round((scores.reduce((sum, value) => sum + value, 0) / scores.length) * 10) / 10 : undefined;
  const at = ctx.now().toISOString();
  design.rounds = [...design.rounds, { round, score, verdict: "revise", ...(readers !== undefined ? { readers } : {}), critical, findings: checks.length, at }];
  const plateau = designPlateau(design);
  let outcome: DesignOutcome | null = null;
  if (verdict === "approve" && score >= target) outcome = "target";
  else if (!redo.size) outcome = "unchanged";
  else if (lastRound || plateau) outcome = lastRound ? "rounds" : "plateau";
  const figures = { round, rounds: maxRounds, score, target, critical, findings: checks.length };
  if (outcome) {
    design.rounds[design.rounds.length - 1].verdict = "approve";
    delete completion.redo;
    endDesign(ctx.state, outcome, at);
    const ended = ctx.state.design!.completion!;
    ended.awaitingAuthor = true;
    const waiting = completionWaiting(ended);
    ctx.insight(
      critical ? "warning" : "ok",
      italian
        ? `Revisione e completamento finiti: ${waiting.waiting === 1 ? "una proposta" : `${waiting.waiting} proposte`} per ${waiting.chapters === 1 ? "un capitolo" : `${waiting.chapters} capitoli`}, ${score}/10`
        : `Review and complete is done: ${waiting.waiting === 1 ? "one proposal" : `${waiting.waiting} proposals`} for ${waiting.chapters === 1 ? "one chapter" : `${waiting.chapters} chapters`}, ${score}/10`,
      summary,
      { code: "designCompletionReady", figures: { ...figures, designOutcome: outcome, chapters: waiting.chapters } },
    );
  } else {
    completion.redo = [...redo.entries()].map(([chapter, notes]) => ({ chapter, notes }));
    ctx.insight(
      "warning",
      italian
        ? `Giro ${round} della revisione: ${score}/10 (obiettivo ${target}/10), ${redo.size === 1 ? "un capitolo da riproporre" : `${redo.size} capitoli da riproporre`}`
        : `Review round ${round}: ${score}/10 (target ${target}/10), ${redo.size === 1 ? "one chapter to propose again" : `${redo.size} chapters to propose again`}`,
      [...redo.entries()].slice(0, 3).map(([chapter, notes]) => `${italian ? "Capitolo" : "Chapter"} ${chapter}: ${notes[0]}`).join(" · "),
      { code: "designRound", figures },
    );
  }
  return { changes: [], summary: `${score}/10 — ${truncate(summary, 240)}` };
}
