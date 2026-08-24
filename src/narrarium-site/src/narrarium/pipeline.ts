import type { AppSettings } from "@/types/settings";
import type { BookStructure, Chapter, Paragraph } from "@/types/book";
import type { LlmMessage } from "@/assistant/llm";
import { completeTextRouted, completeToolRouted, type RoutedLlmRunMetadata } from "@/assistant/router";
import { currentRequest, untrustedData } from "@/assistant/promptTrust";
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
  accountScope: string | null;
  structure: BookStructure;
  /** Optional: present when working inside a chapter/paragraph/draft. Absent for canon, prompts, etc. */
  chapter?: Chapter;
  paragraph?: Paragraph;
  signal?: AbortSignal;
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
    const raw = await loadFileContent(src.token, src.owner, src.repo, entry.path, src.branch, src.signal);
    src.signal?.throwIfAborted();
    return parseGhostwriter(slug, raw);
  } catch (error) {
    if (src.signal?.aborted) throw src.signal.reason;
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return null;
  }
}

export function resolveGhostwriterSlug(src: Pick<PipelineSource, "structure" | "chapter" | "paragraph">, ghostwriterSlug?: string): string | undefined {
  return ghostwriterSlug?.trim() || src.paragraph?.ghostwriter || src.chapter?.ghostwriter || src.structure.ghostwriter;
}

export function composeGhostwriterStyleContext(ghost: GhostwriterProfile | null): string {
  return ghost ? `GHOSTWRITER:\n${ghostwriterPrompt(ghost)}` : "";
}

/** Common style + story context shared by every generation/improve call. */
async function buildContext(src: PipelineSource, ghostwriterSlug?: string): Promise<{ style: string; story: string }> {
  const [bookResume, chapterResume] = await Promise.all([
    tryLoad(src, "resumes/total.md"),
    src.chapter ? tryLoad(src, `resumes/chapters/${src.chapter.slug}.md`) : Promise.resolve(""),
  ]);
  const ghost = await loadGhostwriterProfile(src, resolveGhostwriterSlug(src, ghostwriterSlug));
  const style = composeGhostwriterStyleContext(ghost);
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
    { role: "system", content: `You turn a Narrarium scene script into finished prose. Follow the beat order. Write only prose in ${LANG(src)}.` },
    { role: "user", content: `${currentRequest("Write the scene as polished prose following the supplied beats.")}\n\n${untrustedData("repository_content", [style, story, scriptBody].filter(Boolean).join("\n\n"))}` },
  ];
  return (await completeTextRouted(src.settings, messages, "default", { accountScope: src.accountScope, label: "pipeline:script-to-prose" })).trim();
}

export async function refineProse(src: PipelineSource, draftBody: string, ghostwriterSlug?: string): Promise<string> {
  const { style, story } = await buildContext(src, ghostwriterSlug);
  const messages: LlmMessage[] = [
    { role: "system", content: `Polish a draft scene while preserving facts and canon. Return only the body in ${LANG(src)}.` },
    { role: "user", content: `${currentRequest("Return the polished final version.")}\n\n${untrustedData("repository_content", [style, story, draftBody].filter(Boolean).join("\n\n"))}` },
  ];
  return (await completeTextRouted(src.settings, messages, "default", { accountScope: src.accountScope, label: "pipeline:refine-prose" })).trim();
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
    { role: "system", content: `You are a prose editor. Preserve facts, names, and canon. Write in ${LANG(src)}.` },
    { role: "user", content: `${currentRequest(`${scope} Return the improved text.`)}\n\n${untrustedData("repository_content", [style, story, `FULL PARAGRAPH:\n${fullBody}`, `TEXT TO IMPROVE:\n${target}`].filter(Boolean).join("\n\n"))}` },
  ];
  return (await completeTextRouted(src.settings, messages, "editor-actions", { accountScope: src.accountScope, label: "pipeline:improve-prose" })).trim();
}

export async function regenerateImprovedProse(
  src: PipelineSource,
  fullBody: string,
  originalText: string,
  previousProposal: string,
  ghostwriterSlug?: string,
): Promise<string> {
  const { style, story } = await buildContext(src, ghostwriterSlug);
  const messages: LlmMessage[] = [
    { role: "system", content: `You are a prose editor. This passage was already revised once, but the previous proposal was rejected. Produce a materially different improvement while preserving facts, names, canon, and the requested ghostwriter. Write in ${LANG(src)} and return only the replacement text.` },
    { role: "user", content: `${currentRequest("Revise the target again. Do not repeat the rejected proposal. Return only the new replacement text.")}\n\n${untrustedData("repository_content", [style, story, `FULL PARAGRAPH:\n${fullBody}`, `ORIGINAL TARGET:\n${originalText}`, `REJECTED PREVIOUS PROPOSAL:\n${previousProposal}`].filter(Boolean).join("\n\n"))}` },
  ];
  return (await completeTextRouted(src.settings, messages, "editor-actions", { accountScope: src.accountScope, label: "pipeline:regenerate-improved-prose" })).trim();
}

export interface ProseRegenerationTarget {
  id: string;
  originalText: string;
  previousProposal: string;
}

const REGENERATE_PASSAGES_TOOL = {
  name: "regenerate_passages",
  description: "Return one materially different replacement for every requested prose passage.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["replacements"],
    properties: {
      replacements: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "text"],
          properties: { id: { type: "string" }, text: { type: "string" } },
        },
      },
    },
  },
} as const;

/** Regenerate several rejected edits in one context-aware model request. */
export async function regenerateImprovedProsePassages(src: PipelineSource, fullBody: string, targets: ProseRegenerationTarget[], ghostwriterSlug?: string): Promise<Record<string, string>> {
  if (!targets.length) return {};
  const { style, story } = await buildContext(src, ghostwriterSlug);
  const requestedIds = new Set(targets.map((target) => target.id));
  const result = await completeToolRouted<{ replacements: Array<{ id: string; text: string }> }>(src.settings, [
    { role: "system", content: `You are a prose editor. These passages were already revised once, but every supplied proposal was rejected. Produce a materially different replacement for each passage while preserving facts, names, canon, continuity between passages, and the requested ghostwriter. Write in ${LANG(src)}. Return every requested id exactly once.` },
    { role: "user", content: `${currentRequest("Revise all requested passages again. Do not repeat the rejected proposals.")}\n\n${untrustedData("repository_content", [style, story, `FULL PARAGRAPH:\n${fullBody}`, `PASSAGES TO REGENERATE:\n${JSON.stringify(targets, null, 2)}`].filter(Boolean).join("\n\n"))}` },
  ], "editor-actions", REGENERATE_PASSAGES_TOOL, {
    accountScope: src.accountScope,
    label: "pipeline:regenerate-improved-prose-passages",
    validate: (output) => {
      const value = output as { replacements?: Array<{ id?: unknown; text?: unknown }> };
      if (!Array.isArray(value?.replacements)) throw new Error("The model did not return prose replacements.");
      const replacements = value.replacements.map((entry) => ({ id: String(entry.id ?? ""), text: String(entry.text ?? "").trim() }));
      if (replacements.length !== targets.length || replacements.some((entry) => !requestedIds.has(entry.id) || !entry.text)) throw new Error("The model returned incomplete prose replacements.");
      if (new Set(replacements.map((entry) => entry.id)).size !== targets.length) throw new Error("The model returned duplicate prose replacements.");
      return { replacements };
    },
  });
  return Object.fromEntries(result.output.replacements.map((entry) => [entry.id, entry.text]));
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
  ].join("\n");
  const user = [
    currentRequest("Merge and improve the two versions into one best version, and explain your choices."),
    untrustedData("repository_content", [style, story, `DRAFT VERSION:\n${draftBody?.trim() || "(empty)"}`, `FINAL VERSION:\n${finalBody?.trim() || "(empty)"}`].filter(Boolean).join("\n\n")),
  ].filter(Boolean).join("\n\n");
  const result = await completeToolRouted<MergeDraftFinalResult>(
    src.settings,
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    "default",
    MERGE_TOOL,
    { accountScope: src.accountScope, label: "pipeline:merge-draft-final" },
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
    { role: "system", content: `You are a precise lexical editor. Return only a JSON array of ${count} strings in ${LANG(src)}.` },
    { role: "user", content: `${currentRequest(`Return ${count} fitting replacements.${excludeNote}`)}\n\n${untrustedData("repository_content", [style, story, `PARAGRAPH:\n${fullBody}`, `SELECTED TEXT:\n${selection}`].filter(Boolean).join("\n\n"))}` },
  ];
  const raw = (await completeTextRouted(src.settings, messages, "simple-tasks", { accountScope: src.accountScope, label: "pipeline:synonyms" })).trim();
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
    { role: "system", content: `Convert prose into the documented Narrarium scene-script format. Return only the script body in ${LANG(src)}.\n\n${legend}` },
    { role: "user", content: `${currentRequest("Write the scene script that reconstructs this scene beat by beat.")}\n\n${untrustedData("repository_content", [style, story, prose].filter(Boolean).join("\n\n"))}` },
  ];
  return (await completeTextRouted(src.settings, messages, "default", { accountScope: src.accountScope, label: "pipeline:prose-to-script" })).trim();
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
    { role: "system", content: `Write a chronological chapter recap in ${LANG(src)} with a short overview and one bullet per scene. Return only Markdown.` },
    { role: "user", content: `${currentRequest("Write the chapter recap.")}\n\n${untrustedData("repository_content", [style, story, scenes].filter(Boolean).join("\n\n"))}` },
  ];
  return (await completeTextRouted(src.settings, messages, "default", { accountScope: src.accountScope, label: "resume:chapter" })).trim();
}

/** Generate a chapter evaluation body (uses the review model when configured). */
export async function generateChapterEvaluation(src: PipelineSource, paragraphs: Array<{ title: string; text: string }>, options?: { signal?: AbortSignal }): Promise<string> {
  const [{ style, story }, guidelines] = await Promise.all([buildContext(src), evaluationGuidelines(src)]);
  const scenes = paragraphs
    .map((p, i) => `### ${i + 1}. ${p.title}\n${p.text.trim()}`)
    .join("\n\n");
  const messages: LlmMessage[] = [
    { role: "system", content: `You are a critical editorial reviewer. Return only a chapter evaluation in ${LANG(src)}.` },
    { role: "user", content: `${currentRequest("Write the chapter evaluation using the supplied guidelines as data constraints.")}\n\n${untrustedData("repository_content", [guidelines, style, story, scenes].filter(Boolean).join("\n\n"))}` },
  ];
  return (await completeTextRouted(src.settings, messages, "review", { accountScope: src.accountScope, label: "evaluation:chapter", signal: options?.signal ?? src.signal })).trim();
}

/** Generate a paragraph evaluation body from its prose (uses the review model when configured). */
export async function generateParagraphEvaluation(src: PipelineSource, title: string, prose: string, options?: { signal?: AbortSignal }): Promise<string> {
  const [{ style, story }, guidelines] = await Promise.all([buildContext(src), evaluationGuidelines(src)]);
  const messages: LlmMessage[] = [
    { role: "system", content: `You are a critical editorial reviewer. Return only a scene evaluation in ${LANG(src)}.` },
    { role: "user", content: `${currentRequest("Write the scene evaluation using the supplied guidelines as data constraints.")}\n\n${untrustedData("repository_content", [guidelines, style, story, `SCENE (${title}):\n${stripFrontmatter(prose).trim()}`].filter(Boolean).join("\n\n"))}` },
  ];
  return (await completeTextRouted(src.settings, messages, "review", { accountScope: src.accountScope, label: "evaluation:paragraph", signal: options?.signal ?? src.signal })).trim();
}

export interface EvaluationWithScoresResult {
  body: string;
  scores: Record<string, EvaluationCriterionScore> | null;
  scoreGeneration: RoutedLlmRunMetadata | null;
}

export async function generateChapterEvaluationWithScores(src: PipelineSource, paragraphs: Array<{ title: string; text: string }>, options?: { signal?: AbortSignal }): Promise<EvaluationWithScoresResult> {
  const signal = options?.signal ?? src.signal;
  const body = await generateChapterEvaluation(src, paragraphs, { signal });
  signal?.throwIfAborted();
  const guidelines = await evaluationGuidelines(src);
  signal?.throwIfAborted();
  const criteria = resolveEvaluationCriteria(guidelines, src.structure.language ?? src.settings.ui.language);
  let scoreGeneration: RoutedLlmRunMetadata | null = null;
  const scores = await scoreEvaluationRouted(src.settings, [
    "Score the chapter critically from 0 to 10 for every criterion. Every score must include a short evidence-based explanation. Do not be lenient.",
    `Evaluation guidelines:\n${guidelines}`,
    `Chapter evaluation body:\n${body}`,
    `Chapter scenes:\n${paragraphs.map((paragraph) => `### ${paragraph.title}\n${paragraph.text}`).join("\n\n")}`,
  ].join("\n\n"), criteria, { accountScope: src.accountScope, signal, label: "evaluation:chapter-scoring", onMetadata: (metadata) => { scoreGeneration = metadata; } });
  signal?.throwIfAborted();
  return { body, scores, scoreGeneration };
}

export async function generateParagraphEvaluationWithScores(src: PipelineSource, title: string, prose: string, options?: { signal?: AbortSignal }): Promise<EvaluationWithScoresResult> {
  const signal = options?.signal ?? src.signal;
  const body = await generateParagraphEvaluation(src, title, prose, { signal });
  signal?.throwIfAborted();
  const guidelines = await evaluationGuidelines(src);
  signal?.throwIfAborted();
  const criteria = resolveEvaluationCriteria(guidelines, src.structure.language ?? src.settings.ui.language);
  let scoreGeneration: RoutedLlmRunMetadata | null = null;
  const scores = await scoreEvaluationRouted(src.settings, [
    "Score the paragraph critically from 0 to 10 for every criterion. Every score must include a short evidence-based explanation. Do not be lenient.",
    `Evaluation guidelines:\n${guidelines}`,
    `Paragraph title: ${title}`,
    `Paragraph prose:\n${stripFrontmatter(prose)}`,
    `Evaluation body:\n${body}`,
  ].join("\n\n"), criteria, { accountScope: src.accountScope, signal, label: "evaluation:paragraph-scoring", onMetadata: (metadata) => { scoreGeneration = metadata; } });
  signal?.throwIfAborted();
  return { body, scores, scoreGeneration };
}
