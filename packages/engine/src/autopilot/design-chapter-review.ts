import { AI_CAPABILITIES, AiReplyRejectedError } from "../ai/types.js";
import { requireStructuredFields } from "../ai/structured.js";
import { canonManifest, readBody } from "../book/context.js";
import { designText } from "../book/design.js";
import type { OutlineChapterEntry } from "../book/outline.js";
import { STORY_DESIGN_FILE } from "../book/paths.js";
import { directorSystemPrompt } from "../director/opinion.js";
import { asArray, asInteger, asRecord } from "../util/json.js";
import { isItalian, truncate } from "../util/text.js";
import { chapterReviewSignature, nextChapterReview } from "./design-flow.js";
import { DESIGN_SUMMARY_CHARACTERS, DESIGN_WEAK_SCORE, type DesignCriterionScore } from "./design-review-types.js";
import { DESIGN_RUBRIC_TOKENS, designRubricRule, readDesignRubric, recordRubric, rubricOverall, rubricLine, weakCriteria } from "./design-rubric.js";
import { DESIGN_CHAPTER_REVIEW_TOOL, DESIGN_PANEL_ROLE } from "./prompts.js";
import { authorRules, bookHeader, briefBlock, data, designContext, directorGuidance, directorTaste, outlineOf, outputLimit, request, stableFirst, type TaskContext, type TaskResult } from "./tasks.js";

/**
 * The review of the design of the chapters, chapter by chapter (`design-chapter-review`): a panel (the director for the author's taste, the ghostwriter who will write the
 * chapter for whether it can be written, the simulated readers for whether they would turn the page) judges every chapter with the chapters beside it on the twelve
 * criteria of the rubric. One call for a few chapters in a row. What it keeps (`AutopilotDesign.reviewed`, the rubric of `chapter:<number>`) says which chapters were
 * judged as they are, so that only the ones that changed are judged again, and a run that stopped goes on where it was.
 */

export { DESIGN_CHAPTER_REVIEW_TOOL } from "./prompts.js";

/** Characters of the design of a chapter that a prompt of this review keeps: the chapters under review, whole enough to judge. */
const REVIEWED_CHARACTERS = 2600;
/** Characters of a neighbour of the chapters under review, and of a line of the structure of the book. */
const NEIGHBOUR_CHARACTERS = 700;
const STRUCTURE_LINE_CHARACTERS = 110;
/** The chapters the structure of the book lists, at most: a longer book lists the neighbourhood of what is reviewed. */
const STRUCTURE_CHAPTERS = 60;

function hasText(entry: OutlineChapterEntry): boolean {
  return Boolean(entry.title.trim() || entry.body.trim() || entry.design);
}

function entryText(entry: OutlineChapterEntry, characters: number): string {
  const design = designText(entry.design, characters);
  const body = entry.body.trim();
  return [entry.title ? `Title: ${entry.title}` : "", body ? `Text of the entry: ${truncate(body.replace(/\s+/g, " "), design ? 500 : characters)}` : "", design].filter(Boolean).join("\n");
}

function structureLine(entry: OutlineChapterEntry): string {
  const gist = entry.design?.goal || entry.body.replace(/\s+/g, " ").trim();
  return `${entry.number}. ${entry.title || "(untitled)"}${gist ? ` — ${truncate(gist, STRUCTURE_LINE_CHARACTERS)}` : ""}`;
}

/** What the panel reads of the readers of the book: who they are, a line each. */
function panelSection(ctx: TaskContext): string {
  const readers = ctx.readerPanel.filter((reader) => reader.enabled).slice(0, 6);
  if (!readers.length) return "";
  return `READERS OF THE PANEL:\n${readers.map((reader) => `- ${reader.name}: ${truncate((reader.description || reader.profile).replace(/\s+/g, " "), 160)}`).join("\n")}`;
}

/** What the review of the chapters said of one chapter, told in a line for a prompt of the director. */
export function chapterReviewLine(number: number, title: string, review: { overall: number | null; verdict: string; summary: string }, latest: readonly DesignCriterionScore[]): string {
  const weak = weakCriteria(latest).slice(0, 3).map((entry) => `${entry.criterion} ${entry.score}`);
  return `- Chapter ${number}${title ? ` «${title}»` : ""}: ${review.overall ?? "-"}/10, ${review.verdict}${weak.length ? `; weak: ${weak.join(", ")}` : ""}${review.summary ? ` — ${review.summary}` : ""}`;
}

/** The chapters the director is told of at most: a longer book tells the weakest ones, and counts the rest. */
const REVIEWS_IN_PROMPT = 40;

/**
 * What the review of the chapters said, for the prompt of the director who reviews the whole design: a line for each chapter reviewed (the weakest first when there are
 * too many to tell), with its overall, its verdict, its weakest criteria and what the panel said. Empty when no chapter was reviewed.
 */
export async function chapterReviewsSection(ctx: TaskContext): Promise<string> {
  const reviewed = ctx.state.design?.reviewed;
  const numbers = Object.keys(reviewed ?? {}).map(Number).filter((number) => reviewed![String(number)].overall !== null).sort((left, right) => left - right);
  if (!numbers.length) return "";
  const titles = new Map((await outlineOf(ctx).chapters()).map((entry) => [entry.number, entry.title]));
  const chosen = numbers.length > REVIEWS_IN_PROMPT
    ? [...numbers].sort((left, right) => (reviewed![String(left)].overall ?? 10) - (reviewed![String(right)].overall ?? 10)).slice(0, REVIEWS_IN_PROMPT).sort((left, right) => left - right)
    : numbers;
  const lines = chosen.map((number) => chapterReviewLine(number, titles.get(number) ?? "", reviewed![String(number)], ctx.state.design!.rubric?.[`chapter:${number}`]?.latest ?? []));
  const more = numbers.length - chosen.length;
  return `CHAPTER-BY-CHAPTER REVIEW (by the panel, each chapter with the chapters beside it):\n${lines.join("\n")}${more > 0 ? `\n- … and ${more} more chapters, each better than these.` : ""}`;
}

export async function runDesignChapterReview(ctx: TaskContext): Promise<TaskResult> {
  const design = ctx.state.design!;
  const italian = isItalian(ctx.language);
  const batch = nextChapterReview(ctx.state, ctx.snapshot, ctx.task.chapterNumber ?? 1);
  if (!batch) return { changes: [], summary: italian ? "Nessun capitolo da rivedere." : "No chapter to review." };
  const entries = await outlineOf(ctx).chapters();
  const byNumber = new Map(entries.map((entry) => [entry.number, entry]));
  const numbers = Array.from({ length: batch.to - batch.from + 1 }, (_, index) => batch.from + index);
  const asked = numbers.filter((number) => byNumber.has(number) && hasText(byNumber.get(number)!));
  const round = design.rounds.length + 1;
  const at = ctx.now().toISOString();
  const reviewed = { ...(design.reviewed ?? {}) };
  // An entry with nothing in it has nothing to judge: it is marked as seen, so that it is not asked for again.
  for (const number of numbers.filter((entry) => !asked.includes(entry))) reviewed[String(number)] = { sig: chapterReviewSignature(ctx.snapshot, number), round, at, overall: null, verdict: "ok", summary: "" };
  if (!asked.length) {
    design.reviewed = reviewed;
    return { changes: [], summary: italian ? `Capitoli ${batch.from}-${batch.to}: nessun testo da rivedere.` : `Chapters ${batch.from}-${batch.to}: nothing to review.` };
  }
  const [storyDesign, designData] = await Promise.all([readBody(ctx.store, STORY_DESIGN_FILE, 3000), designContext(ctx)]);
  const around = new Set<number>();
  for (const number of numbers) for (const near of [number - 1, number + 1]) if (!numbers.includes(near) && byNumber.has(near)) around.add(near);
  const structure = entries.length > STRUCTURE_CHAPTERS
    ? entries.filter((entry) => entry.number >= batch.from - STRUCTURE_CHAPTERS / 2 && entry.number <= batch.to + STRUCTURE_CHAPTERS / 2)
    : entries;
  const response = await ctx.ai({
    capability: AI_CAPABILITIES.director,
    label: "autopilot:design-chapter-review",
    system: `${directorSystemPrompt(ctx.director, ctx.language)}\n\n${DESIGN_PANEL_ROLE}`,
    ...stableFirst([
      bookHeader(ctx),
      briefBlock(ctx),
      storyDesign ? `STORY DESIGN:\n${storyDesign}` : "",
      `CANON:\n${canonManifest(ctx.snapshot, { includeSecrets: true }) || "-"}`,
      ...designData.sections,
      directorTaste(ctx.director) ? `THE DIRECTOR'S VISION:\n${directorTaste(ctx.director)}` : "",
      panelSection(ctx),
      directorGuidance(ctx),
    ], [
      `STRUCTURE OF THE BOOK:\n${structure.map(structureLine).join("\n")}`,
      [...around].length ? `THE CHAPTERS BESIDE THEM (for what they take and leave; not under review):\n${[...around].sort((left, right) => left - right).map((number) => `Chapter ${number}${byNumber.get(number)!.intact ? "" : " (the author's)"}:\n${entryText(byNumber.get(number)!, NEIGHBOUR_CHARACTERS)}`).join("\n\n")}` : "",
      `CHAPTERS UNDER REVIEW:\n${asked.map((number) => `Chapter ${number}${byNumber.get(number)!.intact ? "" : " (the author's entry: binding)"}:\n${entryText(byNumber.get(number)!, REVIEWED_CHARACTERS)}`).join("\n\n")}`,
    ], request([
      `Review the design of ${asked.length === 1 ? `chapter ${asked[0]}` : `chapters ${asked.join(", ")}`} of the book, each with the chapters beside it, before any prose is written. ${design.reviewing ? "This is a review on request of the design as it is now." : `Round ${round} of the design${round > 1 ? ": the design was rewritten since the last round, so judge the chapters as they are now" : ""}.`}`,
      ...designRubricRule("applicable"),
      "For every chapter give its verdict (ok: it can be written as it is; revise: a criterion falls short and its design should change) and a summary of what works and what to change.",
      authorRules(ctx, false),
    ])),
    json: DESIGN_CHAPTER_REVIEW_TOOL,
    maxOutputTokens: outputLimit(ctx, Math.round(DESIGN_RUBRIC_TOKENS * 0.8) * asked.length + 400),
  });
  const output = requireStructuredFields(response.json, { chapters: "present" }, "The review of the chapters");
  const items = asArray(output.chapters).map(asRecord);
  const results = new Map<number, { scores: DesignCriterionScore[]; verdict: "ok" | "revise"; summary: string }>();
  for (const number of asked) {
    const subject = `The review of chapter ${number}`;
    const matching = items.filter((item) => asInteger(item.chapterNumber, -1, -1, 1_000_000) === number);
    if (matching.length !== 1) throw new AiReplyRejectedError(`The review of the chapters was rejected: ${matching.length ? `chapter ${number} is reviewed ${matching.length} times` : `chapter ${number} is not reviewed`}. Return one review for each of the chapters ${asked.join(", ")}.`);
    const item = matching[0];
    const verdict = typeof item.verdict === "string" ? item.verdict.trim().toLowerCase() : "";
    if (verdict !== "ok" && verdict !== "revise") throw new AiReplyRejectedError(`${subject} was rejected: the field "verdict" must be "ok" or "revise".`);
    const summary = typeof item.summary === "string" ? item.summary.trim() : "";
    if (!summary) throw new AiReplyRejectedError(`${subject} was rejected: the field "summary" is missing.`);
    if (summary.length > DESIGN_SUMMARY_CHARACTERS) throw new AiReplyRejectedError(`${subject} was rejected: the summary is ${summary.length} characters long, over the ${DESIGN_SUMMARY_CHARACTERS} allowed: return it shorter, whole.`);
    results.set(number, { scores: readDesignRubric(item.rubric, { subject, mode: "applicable" }), verdict, summary });
  }
  let rubric = design.rubric;
  let weak = 0;
  const overalls: number[] = [];
  for (const number of asked) {
    const { scores, verdict, summary } = results.get(number)!;
    const overall = rubricOverall(scores);
    if (overall !== null) overalls.push(overall);
    if (weakCriteria(scores, DESIGN_WEAK_SCORE).length) weak += 1;
    reviewed[String(number)] = { sig: chapterReviewSignature(ctx.snapshot, number), round, at, overall, verdict, summary };
    rubric = recordRubric(rubric, `chapter:${number}`, scores, { round, at }, { whole: false });
  }
  design.reviewed = reviewed;
  design.rubric = rubric;
  const mean = overalls.length ? Math.round((overalls.reduce((sum, value) => sum + value, 0) / overalls.length) * 10) / 10 : 0;
  const where = batch.from === batch.to ? (italian ? `Capitolo ${batch.from}` : `Chapter ${batch.from}`) : (italian ? `Capitoli ${batch.from}-${batch.to}` : `Chapters ${batch.from}-${batch.to}`);
  ctx.insight(
    weak ? "warning" : "ok",
    italian
      ? `${where} rivisti: ${mean}/10 in media${weak ? `, ${weak === 1 ? "uno ha" : `${weak} hanno`} punti deboli` : ""}`
      : `${where} reviewed: ${mean}/10 on average${weak ? `, ${weak === 1 ? "one has" : `${weak} have`} weak points` : ""}`,
    asked.map((number) => `${italian ? "Capitolo" : "Chapter"} ${number}: ${rubricLine(results.get(number)!.scores.filter((entry) => entry.score !== null && entry.score < DESIGN_WEAK_SCORE)) || (italian ? "nessun punto debole" : "no weak point")}`).join("\n"),
    { code: "designChapterReview", figures: { from: batch.from, to: batch.to, score: mean, weak } },
  );
  return { changes: [], summary: `${where}: ${mean}/10, ${weak} weak` };
}
