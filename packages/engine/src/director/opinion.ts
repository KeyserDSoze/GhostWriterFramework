import type { AiJsonSchema, AiPort, AiUsage } from "../ai/types.js";
import { AI_CAPABILITIES, AiProviderError, AiReplyRejectedError } from "../ai/types.js";
import { normalizeScore, requireStructuredFields } from "../ai/structured.js";
import { layoutChapters, listSection, type ChapterFormat, type WindowedList } from "../autopilot/outline.js";
import { importedChapters } from "../autopilot/planner.js";
import { DEFAULT_BRIEF, parseAutopilotState } from "../autopilot/state.js";
import { readStorySoFar } from "../autopilot/story-so-far.js";
import {
  canonManifest,
  ghostwriterBlock,
  loadChapterParagraphs,
  loadDirectorProfile,
  loadGhostwriter,
  markedChapterText,
  readBody,
  readDocument,
  secretRules,
} from "../book/context.js";
import { AUTOPILOT_STATE_FILE, PLOT_FILE, STORY_DESIGN_FILE, chapterResumePath, directorOpinionPath, readerSummaryPath, type EvaluationTarget } from "../book/paths.js";
import { findChapter, findParagraph, loadBookSnapshot, type BookSnapshot, type ChapterInfo } from "../book/snapshot.js";
import type { BookStore } from "../book/store.js";
import { frontmatterNumber, frontmatterString, parseMarkdown, renderMarkdown } from "../markdown/frontmatter.js";
import { directorPrompt, type DirectorProfile } from "../profiles/director.js";
import { currentRequest, unescapePromptDataDeep, untrustedData } from "../prompt/trust.js";
import { asArray, asOneOf, asRecord, asString, asStringList } from "../util/json.js";
import { sha256Hex } from "../util/hash.js";
import { clipMiddle, isItalian, languageName, sceneCharacterLimit, scaleOutputTokens, tail, truncate } from "../util/text.js";

export type DirectorVerdict = "approve" | "revise" | "rewrite";

export interface DirectorConcern {
  severity: "critical" | "major" | "minor";
  issue: string;
  evidence?: string;
  suggestion: string;
}

export interface DirectorOpinion {
  target: EvaluationTarget;
  targetTitle: string;
  question?: string;
  verdict: DirectorVerdict;
  score: number;
  summary: string;
  answer?: string;
  strengths: string[];
  concerns: DirectorConcern[];
  decisions: string[];
  nextSteps: string[];
  questionsForAuthor: string[];
  createdAt: string;
  source: "on-demand" | "autopilot";
  directorName: string;
  model?: string;
  provider?: string;
  usage?: AiUsage;
  cost?: number;
  currency?: string;
  sourceHash?: string;
}

/** Saved opinion as listed in the app (the Markdown body is rendered as is). */
export interface DirectorOpinionRecord {
  path: string;
  targetType: EvaluationTarget["kind"];
  targetId: string;
  title: string;
  verdict: DirectorVerdict;
  score: number;
  createdAt: string;
  source: "on-demand" | "autopilot";
  question?: string;
  body: string;
}

export const DIRECTOR_OPINION_TOOL: AiJsonSchema = {
  name: "director_opinion",
  description: "Return the director's editorial opinion as the author's stand-in.",
  parameters: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["approve", "revise", "rewrite"], description: "approve = keep it; revise = targeted fixes; rewrite = it does not work." },
      score: { type: "number", minimum: 1, maximum: 10 },
      summary: { type: "string", description: "The director's judgement in a few sentences." },
      answer: { type: "string", description: "Direct answer to the author's question, when one was asked." },
      strengths: { type: "array", items: { type: "string" } },
      concerns: {
        type: "array",
        items: {
          type: "object",
          properties: {
            severity: { type: "string", enum: ["critical", "major", "minor"] },
            issue: { type: "string" },
            evidence: { type: "string", description: "Short verbatim quote from the text, when relevant." },
            suggestion: { type: "string" },
          },
          required: ["severity", "issue", "suggestion"],
        },
      },
      decisions: { type: "array", items: { type: "string" }, description: "What the director decides, as the author's stand-in." },
      nextSteps: { type: "array", items: { type: "string" } },
      questionsForAuthor: { type: "array", items: { type: "string" }, description: "Only questions the director cannot settle alone." },
    },
    required: ["verdict", "score", "summary", "strengths", "concerns", "decisions", "nextSteps"],
  },
};

/** The director's verdict whatever its case, spacing or wording ("Approved", "da rivedere"); `null` for anything else. */
export function parseDirectorVerdict(value: unknown): DirectorVerdict | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase().replace(/\s+/g, " ");
  if (/^approv/.test(text)) return "approve";
  if (/^(?:da )?(?:revis|rived|rivist|rework|respin|reject)/.test(text)) return "revise";
  if (/^(?:da )?(?:rewrit|riscriv|rifar)/.test(text)) return "rewrite";
  return null;
}

/** Why an approval was not accepted: the director's score is under the approval score of the director profile. */
export function withheldApprovalNote(score: number, approvalScore: number, language: string): string {
  return isItalian(language)
    ? `L'approvazione è sospesa: il punteggio ${score}/10 è sotto il punteggio di approvazione del direttore (${approvalScore}/10), quindi il verdetto è «da rivedere».`
    : `The approval is withheld: the score ${score}/10 is below the director's approval score of ${approvalScore}/10, so the verdict is revise.`;
}

export function normalizeDirectorOpinionOutput(value: unknown): Pick<DirectorOpinion, "verdict" | "score" | "summary" | "answer" | "strengths" | "concerns" | "decisions" | "nextSteps" | "questionsForAuthor"> {
  const source = asRecord(value);
  const answer = asString(source.answer);
  return {
    verdict: parseDirectorVerdict(source.verdict) ?? "revise",
    score: Math.round((normalizeScore(source.score) ?? 5) * 10) / 10,
    summary: asString(source.summary),
    ...(answer ? { answer } : {}),
    strengths: asStringList(source.strengths, 12),
    concerns: asArray(source.concerns).map((entry) => {
      const concern = asRecord(entry);
      const evidence = asString(concern.evidence);
      return {
        severity: asOneOf(concern.severity, ["critical", "major", "minor"] as const, "minor"),
        issue: asString(concern.issue),
        ...(evidence ? { evidence } : {}),
        suggestion: asString(concern.suggestion),
      };
    }).filter((concern) => concern.issue).slice(0, 20),
    decisions: asStringList(source.decisions, 12),
    nextSteps: asStringList(source.nextSteps, 12),
    questionsForAuthor: asStringList(source.questionsForAuthor, 6),
  };
}

/** System prompt shared by every director task. */
export function directorSystemPrompt(profile: DirectorProfile, language: string): string {
  return [
    "You are the Director of this book: the author's stand-in and final editorial authority whenever the author is not deciding personally.",
    "Decide as the author would, guided by the director profile below: vision, priorities, taste and red lines. The author's explicit constraints always win over your own taste.",
    "Be critical, specific and constructive. Base every judgement on evidence from the supplied text and canon. Never rewrite the book yourself: decide and give precise, minimal instructions.",
    "Simulated readers and specialists are opinions, not orders: weigh them, accept what serves the book, reject the rest with a reason.",
    `Write every field in ${languageName(language)}.`,
    "",
    directorPrompt(profile),
  ].join("\n");
}

const LABELS = {
  en: { title: "Director's opinion", question: "Question", answer: "Answer", verdict: "Verdict", strengths: "Strengths", concerns: "Concerns", decisions: "Decisions", nextSteps: "Next steps", questions: "Questions for the author", approve: "Approve", revise: "Revise", rewrite: "Rewrite", critical: "Critical", major: "Major", minor: "Minor" },
  it: { title: "Parere del direttore", question: "Domanda", answer: "Risposta", verdict: "Verdetto", strengths: "Punti di forza", concerns: "Criticità", decisions: "Decisioni", nextSteps: "Prossimi passi", questions: "Domande per l'autore", approve: "Approvato", revise: "Da rivedere", rewrite: "Da riscrivere", critical: "Critico", major: "Importante", minor: "Minore" },
};

export function directorTargetId(target: EvaluationTarget): string {
  if (target.kind === "book") return "book";
  if (target.kind === "chapter") return `chapter:${target.chapter}`;
  return `paragraph:${target.chapter}:${target.paragraph}`;
}

export function renderDirectorOpinion(opinion: DirectorOpinion, language: string): string {
  const labels = isItalian(language) ? LABELS.it : LABELS.en;
  const list = (items: string[]) => items.length ? items.map((item) => `- ${item}`).join("\n") : "-";
  const frontmatter: Record<string, unknown> = {
    type: "director-opinion",
    id: `director-opinion:${directorTargetId(opinion.target)}`,
    target_type: opinion.target.kind,
    target_id: directorTargetId(opinion.target),
    title: opinion.targetTitle,
    director: opinion.directorName,
    verdict: opinion.verdict,
    score: opinion.score,
    question: opinion.question,
    source: opinion.source,
    created_at: opinion.createdAt,
    source_hash: opinion.sourceHash,
    model: opinion.model,
    provider: opinion.provider,
    input_tokens: opinion.usage?.inputTokens,
    output_tokens: opinion.usage?.outputTokens,
    cost: opinion.cost,
    currency: opinion.currency,
  };
  const body = [
    `# ${labels.title} — ${opinion.targetTitle}`,
    opinion.question ? `\n> **${labels.question}:** ${opinion.question.replace(/\n+/g, " ")}` : "",
    opinion.answer ? `\n## ${labels.answer}\n\n${opinion.answer}` : "",
    `\n## ${labels.verdict}\n\n**${labels[opinion.verdict]}** — ${opinion.score}/10\n\n${opinion.summary}`,
    `\n## ${labels.strengths}\n\n${list(opinion.strengths)}`,
    `\n## ${labels.concerns}\n\n${opinion.concerns.length ? opinion.concerns.map((concern) => `- **${labels[concern.severity]}** — ${concern.issue}${concern.evidence ? ` «${concern.evidence}»` : ""}\n  → ${concern.suggestion}`).join("\n") : "-"}`,
    `\n## ${labels.decisions}\n\n${list(opinion.decisions)}`,
    `\n## ${labels.nextSteps}\n\n${list(opinion.nextSteps)}`,
    opinion.questionsForAuthor.length ? `\n## ${labels.questions}\n\n${list(opinion.questionsForAuthor)}` : "",
  ].filter(Boolean).join("\n");
  return renderMarkdown(frontmatter, body);
}

export function parseDirectorOpinionRecord(path: string, raw: string): DirectorOpinionRecord | null {
  const document = parseMarkdown(raw);
  if (document.frontmatter.type !== "director-opinion") return null;
  const targetType = asOneOf(document.frontmatter.target_type, ["book", "chapter", "paragraph"] as const, "book");
  return {
    path,
    targetType,
    targetId: frontmatterString(document.frontmatter, "target_id") ?? "",
    title: frontmatterString(document.frontmatter, "title") ?? path,
    verdict: asOneOf(document.frontmatter.verdict, ["approve", "revise", "rewrite"] as const, "revise"),
    score: frontmatterNumber(document.frontmatter, "score") ?? 0,
    createdAt: frontmatterString(document.frontmatter, "created_at") ?? "",
    source: document.frontmatter.source === "autopilot" ? "autopilot" : "on-demand",
    question: frontmatterString(document.frontmatter, "question"),
    body: document.body,
  };
}

interface DirectorMaterial {
  title: string;
  sections: string[];
  sourceHash: string;
}

/** Up to this many chapters, every chapter's readers' score is read; beyond it, only the ones the list can show in full. */
const SCORES_FOR_EVERY_CHAPTER = 200;

function bookChapters(scores: ReadonlyMap<string, number>): ChapterFormat<ChapterInfo> {
  const scenes = (chapters: ChapterInfo[]) => chapters.reduce((sum, chapter) => sum + chapter.paragraphs.length, 0);
  return {
    render(chapter, detail) {
      const head = `- Chapter ${chapter.number} «${chapter.title}» (${chapter.paragraphs.length} scenes)`;
      if (detail === "title") return head;
      const readerScore = detail === "full" ? scores.get(chapter.slug) : undefined;
      return `${head}${chapter.summary ? `: ${truncate(chapter.summary, 400)}` : ""}${readerScore ? ` — readers ${readerScore}/10` : ""}`;
    },
    collapse(chapters, titles) {
      const range = `Chapters ${chapters[0].number}-${chapters[chapters.length - 1].number}`;
      return titles ? `- ${range}: ${chapters.map((chapter) => chapter.title).join("; ")}` : `- ${range} (${scenes(chapters)} scenes)`;
    },
  };
}

/** The whole book as one line per chapter, condensed around the latest written chapter when it is too long for a prompt. */
async function bookChapterList(store: BookStore, snapshot: BookSnapshot): Promise<WindowedList> {
  const chapters = snapshot.chapters;
  const around = [...chapters].reverse().find((chapter) => chapter.paragraphs.length > 0)?.number ?? chapters.at(-1)?.number;
  const shown = chapters.length <= SCORES_FOR_EVERY_CHAPTER
    ? chapters
    : chapters.filter((chapter, index) => index < 5 || index >= chapters.length - 5 || Math.abs(chapter.number - (around ?? 0)) <= 30);
  const scores = new Map<string, number>();
  await Promise.all(shown.map(async (chapter) => {
    const summary = await readDocument(store, readerSummaryPath({ kind: "chapter", chapter: chapter.slug }));
    const readerScore = summary ? frontmatterNumber(summary.document.frontmatter, "score") : undefined;
    if (readerScore) scores.set(chapter.slug, readerScore);
  }));
  return layoutChapters(chapters, bookChapters(scores), { around });
}

async function bookMaterial(store: BookStore, snapshot: BookSnapshot): Promise<DirectorMaterial> {
  const chapterList = await bookChapterList(store, snapshot);
  const [design, plot, autopilot] = await Promise.all([
    readBody(store, STORY_DESIGN_FILE, 5000),
    readBody(store, PLOT_FILE, 4000),
    store.read(AUTOPILOT_STATE_FILE),
  ]);
  const state = parseAutopilotState(autopilot?.content);
  const resume = await readStorySoFar(store, { chapters: state?.plan?.chapters ?? importedChapters(snapshot), max: 7000 });
  const directorNotes = state
    ? [...state.constraints.slice(-30).map((entry) => `Author rule: ${entry}`), ...state.directorNotes.map((entry) => `Director note: ${entry}`)].join("\n")
    : "";
  return {
    title: snapshot.book.title,
    sections: [
      `BOOK: ${snapshot.book.title}`,
      design ? `STORY DESIGN:\n${design}` : "",
      plot ? `PLOT MAP:\n${plot}` : "",
      resume ? `STORY SO FAR:\n${resume}` : "",
      chapterList.text ? listSection("CHAPTERS", chapterList) : "CHAPTERS: none yet.",
      directorNotes ? `STANDING RULES AND NOTES:\n${directorNotes}` : "",
    ],
    sourceHash: await sha256Hex([...snapshot.files.entries()].filter(([path]) => path.startsWith("chapters/")).map(([path, hash]) => `${path}:${hash}`).sort().join("\n")),
  };
}

async function chapterMaterial(store: BookStore, snapshot: BookSnapshot, slug: string): Promise<DirectorMaterial> {
  const chapter = findChapter(snapshot, slug);
  if (!chapter) throw new Error(`Chapter not found: ${slug}`);
  const paragraphs = await loadChapterParagraphs(store, chapter);
  const [state, readers, previous, design] = await Promise.all([
    store.read(AUTOPILOT_STATE_FILE).then((file) => parseAutopilotState(file?.content)),
    readBody(store, readerSummaryPath({ kind: "chapter", chapter: slug }), 3000),
    readBody(store, directorOpinionPath({ kind: "chapter", chapter: slug }), 2500),
    readBody(store, STORY_DESIGN_FILE, 2500),
  ]);
  const resume = await readStorySoFar(store, { chapters: state?.plan?.chapters ?? importedChapters(snapshot), beforeChapter: chapter.number, max: 5000 });
  const ghostwriter = await loadGhostwriter(store, snapshot, chapter);
  // What the book asks of a scene (the brief when there is one) with room to spare; never less than the limit these opinions always had.
  const perScene = Math.max(3000, Math.floor(60000 / Math.max(1, paragraphs.length)), sceneCharacterLimit(state?.brief.wordsPerScene ?? DEFAULT_BRIEF.wordsPerScene));
  return {
    title: `${chapter.number}. ${chapter.title}`,
    sections: [
      `CHAPTER ${chapter.number}: ${chapter.title}${chapter.summary ? `\nPlanned summary: ${chapter.summary}` : ""}`,
      design ? `STORY DESIGN (excerpt):\n${design}` : "",
      resume ? `STORY SO FAR (before this chapter):\n${resume}` : "",
      `CANON:\n${canonManifest(snapshot, { includeSecrets: false, max: 60 }) || "-"}`,
      `SECRETS AND REVEAL RULES:\n${await secretRules(store, snapshot, chapter.number) || "-"}`,
      `GHOSTWRITER:\n${ghostwriterBlock(ghostwriter)}`,
      readers ? `SIMULATED READERS (panel summary):\n${readers}` : "",
      previous ? `YOUR PREVIOUS OPINION ON THIS CHAPTER:\n${previous}` : "",
      paragraphs.length ? `CHAPTER TEXT:\n${markedChapterText(paragraphs, perScene)}` : "CHAPTER TEXT: no scenes written yet.",
    ],
    sourceHash: await sha256Hex(paragraphs.map((paragraph) => paragraph.hash).join(":")),
  };
}

async function paragraphMaterial(store: BookStore, snapshot: BookSnapshot, chapterSlug: string, paragraphSlug: string): Promise<DirectorMaterial> {
  const chapter = findChapter(snapshot, chapterSlug);
  const paragraph = findParagraph(snapshot, chapterSlug, paragraphSlug);
  if (!chapter || !paragraph) throw new Error(`Paragraph not found: ${chapterSlug}/${paragraphSlug}`);
  const document = await readDocument(store, paragraph.path);
  if (!document) throw new Error(`Paragraph not found: ${paragraph.path}`);
  const index = chapter.paragraphs.findIndex((entry) => entry.slug === paragraphSlug);
  const previous = index > 0 ? await readDocument(store, chapter.paragraphs[index - 1].path) : null;
  const [chapterResume, readers, earlier] = await Promise.all([
    readBody(store, chapterResumePath(chapterSlug), 2500),
    readBody(store, readerSummaryPath({ kind: "paragraph", chapter: chapterSlug, paragraph: paragraphSlug }), 2500),
    readBody(store, directorOpinionPath({ kind: "paragraph", chapter: chapterSlug, paragraph: paragraphSlug }), 2000),
  ]);
  const ghostwriter = await loadGhostwriter(store, snapshot, chapter, paragraph);
  const state = parseAutopilotState((await store.read(AUTOPILOT_STATE_FILE))?.content);
  return {
    title: `${chapter.number}.${paragraph.number} ${paragraph.title}`,
    sections: [
      `CHAPTER ${chapter.number}: ${chapter.title}${chapter.summary ? ` — ${chapter.summary}` : ""}`,
      chapterResume ? `CHAPTER RECAP:\n${chapterResume}` : "",
      `CANON:\n${canonManifest(snapshot, { includeSecrets: false, max: 50 }) || "-"}`,
      `SECRETS AND REVEAL RULES:\n${await secretRules(store, snapshot, chapter.number) || "-"}`,
      `GHOSTWRITER:\n${ghostwriterBlock(ghostwriter)}`,
      readers ? `SIMULATED READERS (panel summary):\n${readers}` : "",
      earlier ? `YOUR PREVIOUS OPINION ON THIS SCENE:\n${earlier}` : "",
      previous ? `PREVIOUS SCENE ENDING:\n${tail(previous.document.body, 1500)}` : "",
      `SCENE ${paragraph.number}: ${paragraph.title}\n${clipMiddle(document.document.body, Math.max(30000, sceneCharacterLimit(state?.brief.wordsPerScene ?? DEFAULT_BRIEF.wordsPerScene)))}`,
    ],
    sourceHash: document.file.hash,
  };
}

export interface AskDirectorInput {
  store: BookStore;
  ai: AiPort;
  target: EvaluationTarget;
  /** Free question for the director; when empty the director gives a general opinion. */
  question?: string;
  /** Write the opinion to `evaluations/director/…` (one current opinion per target). */
  save?: boolean;
  signal?: AbortSignal;
  now?: () => Date;
  snapshot?: BookSnapshot;
  source?: DirectorOpinion["source"];
  /** Extra instruction appended to the request (used by the autopilot's final review). */
  instruction?: string;
}

export interface AskDirectorResult {
  opinion: DirectorOpinion;
  path: string;
  saved: boolean;
  /**
   * What is wrong with `director.md` (YAML that cannot be read, a value that is not understood), each problem naming the file;
   * empty when it is fine. The opinion is given with the director as far as it could be read: the author is told, and the file is
   * never replaced by the defaults. Always there in what `askDirector` returns; absent in an answer that comes from an older server.
   */
  warnings?: string[];
}

/** "What does the director think?" — the same call works in the browser and on the personal server. */
export async function askDirector(input: AskDirectorInput): Promise<AskDirectorResult> {
  const now = input.now ?? (() => new Date());
  const snapshot = input.snapshot ?? await loadBookSnapshot(input.store);
  const language = snapshot.book.language;
  const director = await loadDirectorProfile(input.store, language);
  const material = input.target.kind === "book"
    ? await bookMaterial(input.store, snapshot)
    : input.target.kind === "chapter"
      ? await chapterMaterial(input.store, snapshot, input.target.chapter)
      : await paragraphMaterial(input.store, snapshot, input.target.chapter, input.target.paragraph);
  const question = input.question?.trim();
  const kindLabel = input.target.kind === "book" ? "the whole book" : input.target.kind === "chapter" ? "this chapter" : "this scene";
  const request = [
    question
      ? `The author asks you about ${kindLabel}: "${question}". Answer the question directly in "answer", then give your full opinion.`
      : `Give your opinion on ${kindLabel} as the author's stand-in.`,
    "Judge it against the vision, the plan, the canon and the reveal rules. Be concrete; quote short evidence for concerns. Decide what you would do if the author left the decision to you.",
    input.instruction ?? "",
  ].filter(Boolean).join(" ");
  const response = await input.ai.complete({
    capability: AI_CAPABILITIES.director,
    label: `director:${input.target.kind}`,
    system: directorSystemPrompt(director, language),
    user: `${currentRequest(request)}\n\n${untrustedData("repository_content", material.sections.filter(Boolean).join("\n\n"))}`,
    json: DIRECTOR_OPINION_TOOL,
    maxOutputTokens: scaleOutputTokens(4000, language),
    signal: input.signal,
  });
  // A reply cut by the output limit is never an opinion, also outside the autopilot.
  if (response.truncated) throw new AiProviderError(`${[response.provider, response.model].filter(Boolean).join(" ") || "The model"}: the reply was cut by the output token limit. Nothing was applied.`, undefined, false, { truncated: true, usage: response.usage, cost: response.cost, model: response.model, provider: response.provider });
  // A reply without a verdict or a score must never become an opinion (nor close the book in the autopilot).
  const subject = "The director's opinion";
  const reply = requireStructuredFields(unescapePromptDataDeep(response.json), { verdict: "text", summary: "text", score: "score" }, subject);
  if (parseDirectorVerdict(reply.verdict) === null) throw new AiReplyRejectedError(`${subject} was rejected: the field "verdict" must be one of "approve", "revise" or "rewrite".`);
  const output = normalizeDirectorOpinionOutput(reply);
  if (output.verdict === "approve" && output.score < director.approvalScore) {
    output.verdict = "revise";
    output.decisions = [withheldApprovalNote(output.score, director.approvalScore, language), ...output.decisions];
  }
  const opinion: DirectorOpinion = {
    target: input.target,
    targetTitle: material.title,
    ...(question ? { question } : {}),
    ...output,
    createdAt: now().toISOString(),
    source: input.source ?? "on-demand",
    directorName: director.name,
    model: response.model,
    provider: response.provider,
    usage: response.usage,
    cost: response.cost,
    currency: response.currency,
    sourceHash: material.sourceHash,
  };
  const path = directorOpinionPath(input.target);
  if (input.save) {
    const existing = await input.store.read(path);
    await input.store.commit([{ path, content: renderDirectorOpinion(opinion, language), expectedHash: existing?.hash ?? null }], `Director: opinion on ${material.title}`);
  }
  return { opinion, path, saved: Boolean(input.save), warnings: director.warnings ?? [] };
}

/** Saved director opinions found in the book, newest first. */
export async function listDirectorOpinions(store: BookStore): Promise<DirectorOpinionRecord[]> {
  const entries = (await store.list()).filter((entry) => entry.path.startsWith("evaluations/director/") && entry.path.endsWith(".md"));
  const records = await Promise.all(entries.map(async (entry) => {
    const file = await store.read(entry.path);
    return file ? parseDirectorOpinionRecord(entry.path, file.content) : null;
  }));
  return records.filter((record): record is DirectorOpinionRecord => Boolean(record)).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
