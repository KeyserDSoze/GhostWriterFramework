import type { AppSettings } from "@/types/settings";
import type { BookStructure, Chapter, Paragraph } from "@/types/book";
import type { LlmMessage } from "@/assistant/llm";
import { completeTextRouted, completeToolRouted } from "@/assistant/router";
import { resolveEvaluationCriteria, scoreEvaluationRouted, type EvaluationCriterionScore } from "@/assistant/service";
import { loadFileContent } from "@/github/githubClient";
import { ghostwriterPrompt, parseGhostwriter, type GhostwriterProfile } from "@/narrarium/ghostwriter";
import { defaultEvaluationGuidelinesMarkdown, EVALUATION_GUIDELINES_PATH } from "@/narrarium/defaultGuidelines";

export function stripFrontmatter(raw: string): string {
  return raw.replace(/^---[\s\S]*?---\s*/, "").trim();
}

interface PipelineSource {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  settings: AppSettings;
  structure: BookStructure;
  /** Optional: present when working inside a chapter/paragraph/draft. Absent for canon, prompts, etc. */
  chapter?: Chapter;
}

async function tryLoad(src: PipelineSource, path?: string): Promise<string> {
  if (!path) return "";
  try {
    return stripFrontmatter(await loadFileContent(src.token, src.owner, src.repo, path, src.branch));
  } catch {
    return "";
  }
}

async function evaluationGuidelines(src: PipelineSource): Promise<string> {
  try {
    return await loadFileContent(src.token, src.owner, src.repo, EVALUATION_GUIDELINES_PATH, src.branch);
  } catch {
    return defaultEvaluationGuidelinesMarkdown(src.structure.language ?? src.settings.ui.language);
  }
}

export async function loadGhostwriterProfile(src: PipelineSource, slug?: string): Promise<GhostwriterProfile | null> {
  if (!slug) return null;
  const entry = src.structure.ghostwriters.find((g) => g.slug === slug);
  if (!entry) return null;
  try {
    return parseGhostwriter(slug, await loadFileContent(src.token, src.owner, src.repo, entry.path, src.branch));
  } catch {
    return null;
  }
}

function resolveGhostwriterSlug(src: PipelineSource, ghostwriterSlug?: string): string | undefined {
  return ghostwriterSlug?.trim() || src.chapter?.ghostwriter || src.structure.ghostwriter;
}

/** Common style + story context shared by every generation/improve call. */
async function buildContext(src: PipelineSource, ghostwriterSlug?: string): Promise<{ style: string; story: string }> {
  const [globalStyle, chapterStyle, punctuationStyle, bookResume, chapterResume] = await Promise.all([
    tryLoad(src, src.structure.globalWritingStylePath),
    tryLoad(src, src.chapter?.writingStylePath),
    tryLoad(src, src.structure.globalPunctuationStylePath),
    tryLoad(src, "resumes/total.md"),
    src.chapter ? tryLoad(src, `resumes/chapters/${src.chapter.slug}.md`) : Promise.resolve(""),
  ]);
  const ghost = await loadGhostwriterProfile(src, resolveGhostwriterSlug(src, ghostwriterSlug));
  const style = [
    globalStyle ? `WRITING STYLE (global):\n${globalStyle}` : "",
    chapterStyle ? `WRITING STYLE (chapter override):\n${chapterStyle}` : "",
    ghost ? `GHOSTWRITER:\n${ghostwriterPrompt(ghost)}` : "",
    punctuationStyle ? `PUNCTUATION STYLE (binding, always apply):\n${punctuationStyle}` : "",
  ].filter(Boolean).join("\n\n");
  const story = [
    bookResume ? `BOOK SO FAR:\n${bookResume}` : "",
    chapterResume ? `CHAPTER SO FAR:\n${chapterResume}` : "",
  ].filter(Boolean).join("\n\n");
  return { style, story };
}

const LANG = (src: PipelineSource) => {
  const code = (src.structure.language ?? src.settings.ui.language ?? "en").trim().toLowerCase().split(/[-_]/)[0];
  return code === "it" ? "Italian" : "English";
};

export async function scriptToProse(src: PipelineSource, scriptBody: string, ghostwriterSlug?: string): Promise<string> {
  const { style, story } = await buildContext(src, ghostwriterSlug);
  const messages: LlmMessage[] = [
    { role: "system", content: `You turn a Narrarium scene script into finished prose. Each script line is an action, beat, or note in sequence. Follow the beat order. Write only the prose body, no frontmatter, no commentary, no markdown fences. Write in ${LANG(src)}.\n\n${style}` },
    { role: "user", content: `${story}\n\nSCENE SCRIPT:\n${scriptBody}\n\nWrite the scene as polished prose following these beats.` },
  ];
  return (await completeTextRouted(src.settings, messages, "default", { label: "pipeline:script-to-prose" })).trim();
}

export async function refineProse(src: PipelineSource, draftBody: string, ghostwriterSlug?: string): Promise<string> {
  const { style, story } = await buildContext(src, ghostwriterSlug);
  const messages: LlmMessage[] = [
    { role: "system", content: `You polish a draft scene into the final paragraph. Preserve facts, names, chronology, and visible canon. Improve prose, rhythm, and clarity. Return only the body, no frontmatter, no commentary. Write in ${LANG(src)}.\n\n${style}` },
    { role: "user", content: `${story}\n\nDRAFT:\n${draftBody}\n\nReturn the polished final version.` },
  ];
  return (await completeTextRouted(src.settings, messages, "default", { label: "pipeline:refine-prose" })).trim();
}

export async function improveProse(
  src: PipelineSource,
  fullBody: string,
  selection: string | null,
  ghostwriterSlug?: string,
): Promise<string> {
  const { style, story } = await buildContext(src, ghostwriterSlug);
  const target = selection && selection.trim() ? selection : fullBody;
  const scope = selection && selection.trim()
    ? `Improve ONLY the selected fragment. Return ONLY the improved fragment, same language, ready to drop back in place of the selection. Keep length similar.`
    : `Improve the whole paragraph. Return only the improved body.`;
  const messages: LlmMessage[] = [
    { role: "system", content: `You are a prose editor. ${scope} Preserve facts, names, and canon. Write in ${LANG(src)}.\n\n${style}` },
    { role: "user", content: `${story}\n\nFULL PARAGRAPH:\n${fullBody}\n\nTEXT TO IMPROVE:\n${target}\n\nReturn the improved text.` },
  ];
  return (await completeTextRouted(src.settings, messages, "default", { label: "pipeline:improve-prose" })).trim();
}

export interface MergeDraftFinalResult {
  /** The merged, improved prose body (no frontmatter). */
  text: string;
  /** A markdown explanation of what was taken from each source and why. */
  explanation: string;
}

const MERGE_TOOL = {
  name: "merge_draft_and_final",
  description: "Return one merged, improved paragraph body that blends the best of the draft and the final version, plus a clear explanation of the editorial choices.",
  parameters: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The final merged prose body only. No frontmatter, no headings, no commentary, no code fences.",
      },
      explanation: {
        type: "string",
        description: "A concise markdown explanation of which parts were taken from the draft, which from the final, and what was improved and why. Use short bullet points.",
      },
    },
    required: ["text", "explanation"],
    additionalProperties: false,
  },
};

/**
 * Merge a paragraph's draft and final versions into one improved body.
 * Reads the strengths of BOTH sources, keeps canon and facts intact, and
 * returns the merged prose together with an explanation of the choices.
 */
export async function mergeDraftAndFinal(
  src: PipelineSource,
  draftBody: string,
  finalBody: string,
  ghostwriterSlug?: string,
): Promise<MergeDraftFinalResult> {
  const { style, story } = await buildContext(src, ghostwriterSlug);
  const system = [
    `You are Narrarium's senior prose editor. You are given two versions of the same paragraph: a DRAFT and a FINAL.`,
    `Produce ONE superior merged version that takes the strongest sentences, images, rhythm, and intentions from BOTH, and improves weak spots.`,
    `Rules:`,
    `- Preserve established canon, facts, names, chronology, and any reveal already present.`,
    `- Do not invent new plot facts. You may sharpen phrasing, rhythm, imagery, and clarity.`,
    `- Keep the same language as the sources for the merged body. Write in ${LANG(src)}.`,
    `- If one side is empty, treat the other as the base and improve it.`,
    `- Return the merged body via the tool "text", and a short markdown rationale via "explanation" describing what you took from the draft, what from the final, and what you improved and why.`,
    `- IMPORTANT: write BOTH the merged "text" AND the "explanation" entirely in ${LANG(src)}. Never write the explanation in another language.`,
    ``,
    style,
  ].join("\n");
  const user = [
    story,
    `DRAFT VERSION:\n${draftBody?.trim() || "(empty)"}`,
    `FINAL VERSION:\n${finalBody?.trim() || "(empty)"}`,
    `Merge and improve them into one best version, and explain your choices.`,
  ].filter(Boolean).join("\n\n");
  const result = await completeToolRouted<MergeDraftFinalResult>(
    src.settings,
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    "default",
    MERGE_TOOL,
    { label: "pipeline:merge-draft-final" },
  );
  return {
    text: String(result.output.text ?? "").trim(),
    explanation: String(result.output.explanation ?? "").trim(),
  };
}

/** Suggest several synonym/short replacements for a selected word or short phrase, keeping context and style. */
export async function synonymsFor(
  src: PipelineSource,
  fullBody: string,
  selection: string,
  options?: { count?: number; exclude?: string[]; ghostwriterSlug?: string },
): Promise<string[]> {
  const count = options?.count ?? 3;
  const exclude = options?.exclude ?? [];
  const { style, story } = await buildContext(src, options?.ghostwriterSlug);
  const excludeNote = exclude.length ? `\nDo NOT repeat any of these already-proposed options: ${exclude.join(", ")}.` : "";
  const messages: LlmMessage[] = [
    { role: "system", content: `You are a precise lexical editor. The user selected a short word or phrase and wants ${count} alternative synonyms/replacements that fit the sentence, register, and style, matching the grammatical form. Return ONLY a JSON array of ${count} strings, no commentary. Write in ${LANG(src)}.${excludeNote}\n\n${style}` },
    { role: "user", content: `${story}\n\nPARAGRAPH:\n${fullBody}\n\nSELECTED TEXT:\n${selection}\n\nReturn ${count} replacements as a JSON array.` },
  ];
  const raw = (await completeTextRouted(src.settings, messages, "simple-tasks", { label: "pipeline:synonyms" })).trim();
  return parseStringList(raw, count, exclude);
}

function parseStringList(raw: string, count: number, exclude: string[]): string[] {
  const cleaned = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let list: string[] = [];
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) list = parsed.map((v) => String(v));
  } catch {
    list = cleaned.split(/\r?\n|,|;/).map((s) => s.replace(/^[\s\d.)\-*"'«»]+|["'«»]+$/g, "").trim());
  }
  const excludeLower = new Set(exclude.map((e) => e.trim().toLowerCase()));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const value = item.trim();
    const key = value.toLowerCase();
    if (!value || excludeLower.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= count) break;
  }
  return out;
}

/** Reverse-engineer a Narrarium scene script (one beat per line) from finished or draft prose. */
export async function proseToScript(src: PipelineSource, prose: string, ghostwriterSlug?: string): Promise<string> {
  const { style, story } = await buildContext(src, ghostwriterSlug);
  const legend = [
    "Narrarium nested script format. Containers use curly braces `{ ... }` and can nest other blocks; primitives use square brackets `[ ... ]` and are leaves.",
    "Open a container with `{<kind> attr=value attr=\"quoted\"` on its own line and close it with `}` on its own line.",
    "Containers: section (attrs: title, goal, pov=character:slug, location=location:slug), dialogue (attr: speaker=character:slug), secret (attrs: ref=secret:slug, mode=protect|seed|partial|misdirect|reveal), location/character/item/faction (attr: ref=...:slug), timeline (attrs: ref=timeline-event:slug, date).",
    "Primitives: `[tell] narration text`, `[action] physical action`, `[emotion] inner state`, `[line speaker=character:slug subtext=\"...\" delivery=\"...\"] «spoken line»`.",
    "Inside a secret container put primitives `[surface] ...`, `[reveal] ...`, `[truth] ...` (use [tell] if unsure).",
    "Wrap a whole scene in one top-level `{section ...}` and put the beats inside, in order. Keep dialogue exchanges inside a `{dialogue ...}` container.",
    "Return ONLY the script body, no commentary, no code fences. Keep dialogue text in its original language.",
  ].join("\n");
  const messages: LlmMessage[] = [
    { role: "system", content: `You convert prose into a Narrarium scene script: a compact, ordered, faithful sequence of beats that captures the scene's structure and dialogue. Return ONLY the script body, no commentary, no code fences. Write notes/telling beats in ${LANG(src)}.\n\n${legend}\n\n${style}` },
    { role: "user", content: `${story}\n\nPROSE:\n${prose}\n\nWrite the scene script that reconstructs this scene beat by beat.` },
  ];
  return (await completeTextRouted(src.settings, messages, "default", { label: "pipeline:prose-to-script" })).trim();
}

export type { PipelineSource };
export type { Paragraph };

/** Generate the chapter resume (riassunto) body from the ordered paragraph texts. */
export async function generateChapterResume(src: PipelineSource, paragraphs: Array<{ title: string; text: string }>): Promise<string> {
  const { style, story } = await buildContext(src);
  const scenes = paragraphs
    .map((p, i) => `### ${i + 1}. ${p.title}\n${p.text.trim()}`)
    .join("\n\n");
  const messages: LlmMessage[] = [
    { role: "system", content: `You write a chapter "riassunto" (recap) for the chapter resume file. Start with a 2-4 sentence overview, then a blank line, then one "- " bullet per scene in order, each one concise sentence capturing what happens and what changes. Preserve chronology and visible canon. Return ONLY the markdown body, no frontmatter, no code fences. Write in ${LANG(src)}.\n\n${style}` },
    { role: "user", content: `${story}\n\nSCENES:\n${scenes}\n\nWrite the chapter recap.` },
  ];
  return (await completeTextRouted(src.settings, messages, "default", { label: "resume:chapter" })).trim();
}

/** Generate a chapter evaluation body (uses the review model when configured). */
export async function generateChapterEvaluation(src: PipelineSource, paragraphs: Array<{ title: string; text: string }>): Promise<string> {
  const [{ style, story }, guidelines] = await Promise.all([buildContext(src), evaluationGuidelines(src)]);
  const scenes = paragraphs
    .map((p, i) => `### ${i + 1}. ${p.title}\n${p.text.trim()}`)
    .join("\n\n");
  const messages: LlmMessage[] = [
    { role: "system", content: `You are an editorial reviewer. Follow the evaluation-guidelines.md contract below. Be critical and specific: do not give comfort scores or generic praise. Write a chapter evaluation using the required markdown headings and concrete revision suggestions. Return ONLY the markdown body, no frontmatter, no code fences. Write in ${LANG(src)}.\n\n${guidelines}\n\n${style}` },
    { role: "user", content: `${story}\n\nCHAPTER SCENES:\n${scenes}\n\nWrite the chapter evaluation.` },
  ];
  return (await completeTextRouted(src.settings, messages, "review", { label: "evaluation:chapter" })).trim();
}

/** Generate a paragraph evaluation body from its prose (uses the review model when configured). */
export async function generateParagraphEvaluation(src: PipelineSource, title: string, prose: string): Promise<string> {
  const [{ style, story }, guidelines] = await Promise.all([buildContext(src), evaluationGuidelines(src)]);
  const messages: LlmMessage[] = [
    { role: "system", content: `You are an editorial reviewer. Follow the evaluation-guidelines.md contract below. Be critical and specific: do not give comfort scores or generic praise. Write an evaluation of a single scene/paragraph using the required markdown headings and concrete suggestions. Return ONLY the markdown body, no frontmatter, no code fences. Write in ${LANG(src)}.\n\n${guidelines}\n\n${style}` },
    { role: "user", content: `${story}\n\nSCENE (${title}):\n${stripFrontmatter(prose).trim()}\n\nWrite the evaluation.` },
  ];
  return (await completeTextRouted(src.settings, messages, "review", { label: "evaluation:paragraph" })).trim();
}

export async function generateChapterEvaluationWithScores(src: PipelineSource, paragraphs: Array<{ title: string; text: string }>): Promise<{ body: string; scores: Record<string, EvaluationCriterionScore> | null }> {
  const body = await generateChapterEvaluation(src, paragraphs);
  const guidelines = await evaluationGuidelines(src);
  const criteria = resolveEvaluationCriteria(guidelines, src.structure.language ?? src.settings.ui.language);
  const scores = await scoreEvaluationRouted(src.settings, [
    "Score the chapter critically from 0 to 10 for every criterion. Every score must include a short evidence-based explanation. Do not be lenient.",
    `Evaluation guidelines:\n${guidelines}`,
    `Chapter evaluation body:\n${body}`,
    `Chapter scenes:\n${paragraphs.map((paragraph) => `### ${paragraph.title}\n${paragraph.text}`).join("\n\n")}`,
  ].join("\n\n"), criteria);
  return { body, scores };
}

export async function generateParagraphEvaluationWithScores(src: PipelineSource, title: string, prose: string): Promise<{ body: string; scores: Record<string, EvaluationCriterionScore> | null }> {
  const body = await generateParagraphEvaluation(src, title, prose);
  const guidelines = await evaluationGuidelines(src);
  const criteria = resolveEvaluationCriteria(guidelines, src.structure.language ?? src.settings.ui.language);
  const scores = await scoreEvaluationRouted(src.settings, [
    "Score the paragraph critically from 0 to 10 for every criterion. Every score must include a short evidence-based explanation. Do not be lenient.",
    `Evaluation guidelines:\n${guidelines}`,
    `Paragraph title: ${title}`,
    `Paragraph prose:\n${stripFrontmatter(prose)}`,
    `Evaluation body:\n${body}`,
  ].join("\n\n"), criteria);
  return { body, scores };
}
