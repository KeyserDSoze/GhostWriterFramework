import type { AppSettings } from "@/types/settings";
import type { BookStructure, Chapter, Paragraph } from "@/types/book";
import { completeText, resolveWritingIntegration, type LlmMessage } from "@/assistant/llm";
import { loadFileContent } from "@/github/githubClient";
import { ghostwriterPrompt, parseGhostwriter, type GhostwriterProfile } from "@/narrarium/ghostwriter";

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
  chapter: Chapter;
}

async function tryLoad(src: PipelineSource, path?: string): Promise<string> {
  if (!path) return "";
  try {
    return stripFrontmatter(await loadFileContent(src.token, src.owner, src.repo, path, src.branch));
  } catch {
    return "";
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

/** Common style + story context shared by every generation/improve call. */
async function buildContext(src: PipelineSource, ghostwriterSlug?: string): Promise<{ style: string; story: string }> {
  const [globalStyle, chapterStyle, bookResume, chapterResume] = await Promise.all([
    tryLoad(src, src.structure.globalWritingStylePath),
    tryLoad(src, src.chapter.writingStylePath),
    tryLoad(src, "resumes/total.md"),
    tryLoad(src, `resumes/chapters/${src.chapter.slug}.md`),
  ]);
  const ghost = await loadGhostwriterProfile(src, ghostwriterSlug);
  const style = [
    globalStyle ? `WRITING STYLE (global):\n${globalStyle}` : "",
    chapterStyle ? `WRITING STYLE (chapter override):\n${chapterStyle}` : "",
    ghost ? `GHOSTWRITER:\n${ghostwriterPrompt(ghost)}` : "",
  ].filter(Boolean).join("\n\n");
  const story = [
    bookResume ? `BOOK SO FAR:\n${bookResume}` : "",
    chapterResume ? `CHAPTER SO FAR:\n${chapterResume}` : "",
  ].filter(Boolean).join("\n\n");
  return { style, story };
}

const LANG = (settings: AppSettings) => (settings.ui.language === "it" ? "Italian" : "English");

export async function scriptToProse(src: PipelineSource, scriptBody: string, ghostwriterSlug?: string): Promise<string> {
  const integration = resolveWritingIntegration(src.settings);
  if (!integration) throw new Error("No AI integration configured.");
  const { style, story } = await buildContext(src, ghostwriterSlug);
  const messages: LlmMessage[] = [
    { role: "system", content: `You turn a Narrarium scene script into finished prose. Each script line is an action, beat, or note in sequence. Follow the beat order. Write only the prose body, no frontmatter, no commentary, no markdown fences. Write in ${LANG(src.settings)}.\n\n${style}` },
    { role: "user", content: `${story}\n\nSCENE SCRIPT:\n${scriptBody}\n\nWrite the scene as polished prose following these beats.` },
  ];
  return (await completeText(integration, messages)).trim();
}

export async function refineProse(src: PipelineSource, draftBody: string, ghostwriterSlug?: string): Promise<string> {
  const integration = resolveWritingIntegration(src.settings);
  if (!integration) throw new Error("No AI integration configured.");
  const { style, story } = await buildContext(src, ghostwriterSlug);
  const messages: LlmMessage[] = [
    { role: "system", content: `You polish a draft scene into the final paragraph. Preserve facts, names, chronology, and visible canon. Improve prose, rhythm, and clarity. Return only the body, no frontmatter, no commentary. Write in ${LANG(src.settings)}.\n\n${style}` },
    { role: "user", content: `${story}\n\nDRAFT:\n${draftBody}\n\nReturn the polished final version.` },
  ];
  return (await completeText(integration, messages)).trim();
}

export async function improveProse(
  src: PipelineSource,
  fullBody: string,
  selection: string | null,
  ghostwriterSlug?: string,
): Promise<string> {
  const integration = resolveWritingIntegration(src.settings);
  if (!integration) throw new Error("No AI integration configured.");
  const { style, story } = await buildContext(src, ghostwriterSlug);
  const target = selection && selection.trim() ? selection : fullBody;
  const scope = selection && selection.trim()
    ? `Improve ONLY the selected fragment. Return ONLY the improved fragment, same language, ready to drop back in place of the selection. Keep length similar.`
    : `Improve the whole paragraph. Return only the improved body.`;
  const messages: LlmMessage[] = [
    { role: "system", content: `You are a prose editor. ${scope} Preserve facts, names, and canon. Write in ${LANG(src.settings)}.\n\n${style}` },
    { role: "user", content: `${story}\n\nFULL PARAGRAPH:\n${fullBody}\n\nTEXT TO IMPROVE:\n${target}\n\nReturn the improved text.` },
  ];
  return (await completeText(integration, messages)).trim();
}

/** Suggest a synonym/short replacement for a selected word or short phrase, keeping context and style. */
export async function synonymFor(src: PipelineSource, fullBody: string, selection: string, ghostwriterSlug?: string): Promise<string> {
  const integration = resolveWritingIntegration(src.settings);
  if (!integration) throw new Error("No AI integration configured.");
  const { style, story } = await buildContext(src, ghostwriterSlug);
  const messages: LlmMessage[] = [
    { role: "system", content: `You are a precise lexical editor. The user selected a short word or phrase and wants a single best synonym or replacement that fits the sentence, register, and style. Return ONLY the replacement text, no quotes, no explanation, in ${LANG(src.settings)}, matching the selection's grammatical form.\n\n${style}` },
    { role: "user", content: `${story}\n\nPARAGRAPH:\n${fullBody}\n\nSELECTED TEXT:\n${selection}\n\nReturn the best synonym/replacement for the selected text.` },
  ];
  return (await completeText(integration, messages)).trim().replace(/^["'«»]|["'«»]$/g, "");
}

/** Reverse-engineer a Narrarium scene script (one beat per line) from finished or draft prose. */
export async function proseToScript(src: PipelineSource, prose: string, ghostwriterSlug?: string): Promise<string> {
  const integration = resolveWritingIntegration(src.settings);
  if (!integration) throw new Error("No AI integration configured.");
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
    { role: "system", content: `You convert prose into a Narrarium scene script: a compact, ordered, faithful sequence of beats that captures the scene's structure and dialogue. Return ONLY the script body, no commentary, no code fences. Write notes/telling beats in ${LANG(src.settings)}.\n\n${legend}\n\n${style}` },
    { role: "user", content: `${story}\n\nPROSE:\n${prose}\n\nWrite the scene script that reconstructs this scene beat by beat.` },
  ];
  return (await completeText(integration, messages)).trim();
}

export type { PipelineSource };
export type { Paragraph };
