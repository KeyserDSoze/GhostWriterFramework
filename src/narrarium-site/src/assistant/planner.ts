import type { LoadedWriterContext } from "@/assistant/context";
import type { AssistantAction } from "@/assistant/store";
import { hasAssistantActionProvenance, sourceRevisionFromFiles } from "@/assistant/actionValidation";
import type { Chapter } from "@/types/book";
import { resolveChapterTarget, resolveParagraphTarget } from "@/assistant/targetRules";
import { isReaderEvaluationsNavigationPrompt } from "@/assistant/orchestratorRules";

export type NavigateAction = Extract<AssistantAction, { kind: "navigate" }>;
export type ReadAloudAction = Extract<AssistantAction, { kind: "read-aloud" }>;

export function bindReadAloudActionProvenance(action: ReadAloudAction, input: {
  owner: string;
  repo: string;
  branch: string;
  sourceRevisions: Record<string, string>;
  generatedAt?: string;
}): ReadAloudAction {
  return {
    ...action,
    toolId: "read-current-page",
    owner: input.owner,
    repo: input.repo,
    branch: input.branch,
    sourceRevision: sourceRevisionFromFiles(input.sourceRevisions),
    sourceRevisions: input.sourceRevisions,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };
}

export function readAloudReplaySource(action: ReadAloudAction): { bookId: string; owner: string; repo: string; branch: string } | null {
  return hasAssistantActionProvenance(action)
    ? { bookId: action.bookId, owner: action.owner, repo: action.repo, branch: action.branch }
    : null;
}

const READ_KEYWORDS = /\b(leggi|leggimi|leggile|leggilo|riproduci|ascolta|recita|read|read aloud|read out|play)\b/i;
const NAV_KEYWORDS = /\b(apri|apre|aprimi|vai|va'|vammi|portami|mostra|mostrami|naviga|open|go to|goto|show me|show|navigate|take me|jump to)\b/i;
const FRONTMATTER_KEYWORDS = /\b(frontmatter|metadat|metadata|intestazion|header|campi|fields)\b/i;

/** Build the ordered repo paths that make up a read target (chapter intro + paragraphs, or a single paragraph). */
function chapterReadPaths(chapter: Chapter): string[] {
  return [`${chapter.path}/chapter.md`, ...chapter.paragraphs.map((paragraph) => paragraph.path)];
}

/**
 * No-LLM resolver: turns a "read/leggi ..." prompt into a read-aloud action carrying the
 * repo paths to speak. The UI executes the actual TTS (navigation/audio stay in the UI layer).
 */
export function resolveReadAloudAction(
  prompt: string,
  context: LoadedWriterContext,
  bookId: string,
): ReadAloudAction | null {
  const lower = prompt.toLowerCase();
  if (!READ_KEYWORDS.test(lower)) return null;
  const structure = context.structure;
  if (!structure) return null;
  const includeFrontmatter = FRONTMATTER_KEYWORDS.test(lower);
  const chapterResolution = resolveChapterTarget(prompt, structure.chapters, context.chapter);
  const paragraphResolution = resolveParagraphTarget(prompt, chapterResolution, context.chapter, context.paragraph);
  if ((chapterResolution.explicit && !chapterResolution.value) || (paragraphResolution.explicit && !paragraphResolution.value)) return null;
  if (paragraphResolution.value) return { kind: "read-aloud", bookId, title: paragraphResolution.value.paragraph.title, paths: [paragraphResolution.value.paragraph.path], includeFrontmatter };
  if (chapterResolution.value) return { kind: "read-aloud", bookId, title: chapterResolution.value.title, paths: chapterReadPaths(chapterResolution.value), includeFrontmatter };

  // "read this / leggi questa pagina" with no explicit target: read whatever is loaded here.
  if (context.paragraph && context.chapter) {
    return { kind: "read-aloud", bookId, title: context.paragraph.title, paths: [context.paragraph.path], includeFrontmatter };
  }
  if (context.chapter) {
    return { kind: "read-aloud", bookId, title: context.chapter.title, paths: chapterReadPaths(context.chapter), includeFrontmatter };
  }
  return null;
}

/**
 * No-LLM resolver: turns an "open/apri/vai ..." prompt into a navigate action carrying an app route.
 * The UI performs the actual navigation.
 */
export function resolveNavigateAction(
  prompt: string,
  context: LoadedWriterContext,
  bookId: string | null,
): NavigateAction | null {
  const lower = prompt.toLowerCase();
  if (!NAV_KEYWORDS.test(lower)) return null;
  if (/\b(impostazion|settings|preferenz)\b/.test(lower) && !/\b(libro|book)\b/.test(lower)) {
    return { kind: "navigate", to: `/app/settings`, label: "Settings" };
  }
  if (!bookId) return null;
  const base = `/app/books/${bookId}`;
  const routeTarget = routeNavigationTarget(context);
  const chapterResolution = resolveChapterTarget(prompt, context.structure?.chapters ?? [], context.chapter);
  const paragraphResolution = resolveParagraphTarget(prompt, chapterResolution, context.chapter, context.paragraph);
  const routeMatchesExplicitChapter = routeTarget && explicitChapterMatchesRoute(lower, routeTarget.chapterId);
  const routeMatchesExplicitParagraph = routeTarget?.paragraphNum && explicitParagraphMatchesRoute(lower, routeTarget.paragraphNum);
  if ((chapterResolution.explicit && !chapterResolution.value && !routeMatchesExplicitChapter) || (paragraphResolution.explicit && !paragraphResolution.value && !routeMatchesExplicitParagraph)) return null;
  if (isReaderEvaluationsNavigationPrompt(lower) && (chapterResolution.value || routeTarget)) {
    const explicitTarget = chapterResolution.explicit || paragraphResolution.explicit;
    const chapterId = chapterResolution.value?.slug ?? routeTarget!.chapterId;
    const paragraphNum = paragraphResolution.value?.paragraph.number ?? (explicitTarget ? undefined : routeTarget?.paragraphNum);
    const to = paragraphNum
      ? `${base}/chapters/${chapterId}/paragraphs/${paragraphNum}/reader-evaluations`
      : `${base}/chapters/${chapterId}/reader-evaluations`;
    return { kind: "navigate", to, label: "Reader evaluations" };
  }

  if (paragraphResolution.explicit && paragraphResolution.value) {
    const { chapter, paragraph } = paragraphResolution.value;
    return { kind: "navigate", to: `${base}/chapters/${chapter.slug}/paragraphs/${paragraph.number}`, label: `${chapter.title} · ${paragraph.title}` };
  }

  if (/\b(reader|lettore|lettura)\b/.test(lower)) {
    return { kind: "navigate", to: `${base}/reader`, label: "Reader" };
  }
  if (/\b(research|ricerca|ricerche)\b/.test(lower)) {
    return { kind: "navigate", to: `${base}/research`, label: "Research" };
  }
  if (/\b(export|esporta|esportazione|epub|pdf)\b/.test(lower)) {
    return { kind: "navigate", to: `${base}/export`, label: "Export" };
  }
  if (/\b(dashboard|cruscotto|panoramica)\b/.test(lower)) {
    return { kind: "navigate", to: `${base}/dashboard`, label: "Dashboard" };
  }
  if (/\b(assets|risorse|immagini|media)\b/.test(lower)) {
    return { kind: "navigate", to: `${base}/assets`, label: "Assets" };
  }
  if (/\b(ghostwriter|ghostwriters|autor)\b/.test(lower)) {
    return { kind: "navigate", to: `${base}/ghostwriters`, label: "Ghostwriters" };
  }
  if (/\b(impostazion|settings|preferenz)\b/.test(lower)) return { kind: "navigate", to: `${base}/settings`, label: "Book settings" };

  if (/\b(paragrafo|paragraph|scena|scene)\b/.test(lower) && routeTarget?.paragraphNum) {
    return { kind: "navigate", to: `${base}/chapters/${routeTarget.chapterId}/paragraphs/${routeTarget.paragraphNum}`, label: `Paragraph ${routeTarget.paragraphNum}` };
  }

  if (/\b(capitolo|chapter)\b/.test(lower) && (chapterResolution.value || routeTarget)) {
    const chapterId = chapterResolution.value?.slug ?? routeTarget!.chapterId;
    return { kind: "navigate", to: `${base}/chapters/${chapterId}`, label: chapterResolution.value?.title ?? `Chapter ${chapterId}` };
  }

  return null;
}

function routeNavigationTarget(context: LoadedWriterContext): { chapterId: string; paragraphNum?: string } | null {
  const route = context.route;
  if (!route || !("chapterId" in route)) return null;
  return { chapterId: route.chapterId, ...("paragraphNum" in route ? { paragraphNum: route.paragraphNum } : {}) };
}

function explicitChapterMatchesRoute(prompt: string, chapterId: string): boolean {
  const numeric = prompt.match(/(?:capitolo|chapter)\s+(\d+)\b/i)?.[1];
  return Boolean(numeric && Number(chapterId.match(/^\d+/)?.[0]) === Number(numeric));
}

function explicitParagraphMatchesRoute(prompt: string, paragraphNum: string): boolean {
  const numeric = prompt.match(/(?:paragrafo|paragraph|scena|scene)\s+(\d+)\b/i)?.[1];
  return Boolean(numeric && Number(paragraphNum) === Number(numeric));
}
