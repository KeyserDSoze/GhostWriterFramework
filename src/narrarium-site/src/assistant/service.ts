import { parseDocument, stringify } from "yaml";
import { createFile, loadFileContent, readFileWithSha, slugToTitle, updateFile } from "@/github/githubClient";
import type { AppSettings, BookEntry } from "@/types/settings";
import type { LoadedWriterContext } from "@/assistant/context";
import { completeText, resolveReviewIntegration, resolveWritingIntegration } from "@/assistant/llm";
import type { AssistantAction, AssistantMessage, AssistantSession } from "@/assistant/store";

export async function runAssistantPrompt(input: {
  prompt: string;
  context: LoadedWriterContext;
  settings: AppSettings;
  book: BookEntry | null;
  branch: string;
  token: string;
  history: AssistantMessage[];
  compactSummary: string;
  compactedMessageCount: number;
}): Promise<AssistantMessage> {
  const { prompt, context, book, branch, token } = input;
  const lowered = prompt.toLowerCase();

  if (!book || !token) {
    return makeAssistantMessage("assistant", "No GitHub token is configured for the current book, so I cannot read or write repository files from this context.");
  }

  if (!context.structure) {
    return makeAssistantMessage("assistant", "The current book structure is not loaded yet. Open the book page first so I can gather the right context.");
  }

  if (looksLikeSearch(lowered)) {
    return searchCurrentBook({ ...input, book, token });
  }
  if (looksLikeRewrite(lowered)) {
    return rewriteCurrentParagraph({ ...input, book, branch, token });
  }
  if (looksLikeNote(lowered)) {
    return createContextNote({ ...input, book, branch, token });
  }
  if (looksLikeReview(lowered)) {
    return reviewCurrentContext(input);
  }
  if (looksLikeSummary(lowered)) {
    return summarizeCurrentContext(input);
  }

  return answerFromContext(input);
}

export async function compactAssistantSession(input: {
  session: AssistantSession;
  settings: AppSettings;
}): Promise<AssistantSession> {
  const { session, settings } = input;
  if (session.messages.length <= 12) return session;
  const targetCount = session.messages.length - 6;
  if (targetCount <= session.compactedMessageCount) return session;

  const integration = resolveWritingIntegration(settings);
  if (!integration) return session;

  const content = session.messages
    .slice(0, targetCount)
    .map((message) => `${message.role.toUpperCase()}: ${message.text}`)
    .join("\n\n");

  const summary = await completeText(integration, [
    {
      role: "system",
      content:
        "Summarize the conversation so far for future continuation. Keep goals, decisions, open questions, created notes, requested edits, and canon-sensitive facts. Return concise bullet points.",
    },
    {
      role: "user",
      content,
    },
  ]);

  return {
    ...session,
    compactSummary: summary.trim(),
    compactedMessageCount: targetCount,
  };
}

export async function applyParagraphRewrite(input: {
  action: AssistantAction;
  book: BookEntry;
  branch: string;
  token: string;
}): Promise<void> {
  const { action, book, branch, token } = input;
  const file = await readFileWithSha(token, book.owner, book.repo, branch, action.paragraphPath);
  const parsed = parseMarkdown(file.content);
  const nextRaw = renderMarkdown(parsed.frontmatter, action.proposedBody);
  await updateFile(
    token,
    book.owner,
    book.repo,
    branch,
    action.paragraphPath,
    file.sha,
    nextRaw,
    `Rewrite paragraph ${action.chapterSlug}: ${action.paragraphPath.split("/").pop()}`,
  );
}

async function summarizeCurrentContext(input: PromptInput): Promise<AssistantMessage> {
  const integration = resolveWritingIntegration(input.settings);
  if (!integration) return noAiMessage();

  const answer = await completeText(integration, [
    {
      role: "system",
      content:
        "You are Narrarium's writing assistant. Summarize the current context clearly and concretely. Use compact paragraphs and bullet points when useful.",
    },
    {
      role: "user",
      content: `${conversationBundle(input)}\n\nRequest: ${input.prompt}`,
    },
  ]);
  return makeAssistantMessage("assistant", answer.trim());
}

async function reviewCurrentContext(input: PromptInput): Promise<AssistantMessage> {
  const integration = resolveReviewIntegration(input.settings) ?? resolveWritingIntegration(input.settings);
  if (!integration) return noAiMessage();

  const answer = await completeText(integration, [
    {
      role: "system",
      content:
        "You are Narrarium's editorial reviewer. Review the current context with concrete strengths, issues, and specific next actions. Preserve facts; do not invent canon.",
    },
    {
      role: "user",
      content: `${conversationBundle(input)}\n\nReview request: ${input.prompt}`,
    },
  ], "review");
  return makeAssistantMessage("assistant", answer.trim());
}

async function answerFromContext(input: PromptInput): Promise<AssistantMessage> {
  const integration = resolveWritingIntegration(input.settings);
  if (!integration) return noAiMessage();

  const answer = await completeText(integration, [
    {
      role: "system",
      content:
        "You are Narrarium's contextual writing copilot. Answer only from the provided repository context and current location. If context is missing, say exactly what else you need.",
    },
    {
      role: "user",
      content: `${conversationBundle(input)}\n\nUser request: ${input.prompt}`,
    },
  ]);
  return makeAssistantMessage("assistant", answer.trim());
}

async function rewriteCurrentParagraph(input: PromptInput & { book: BookEntry; branch: string; token: string }): Promise<AssistantMessage> {
  const { context } = input;
  if (!context.paragraph || !context.chapter) {
    return makeAssistantMessage("assistant", "Paragraph rewrite works when you are inside a paragraph page. Open a paragraph first, then ask me to revise it.");
  }

  const integration = resolveWritingIntegration(input.settings);
  if (!integration) return noAiMessage();

  const paragraphFile = context.relevantFiles.find((entry) => entry.path === context.paragraph?.path);
  const paragraphBody = paragraphFile ? parseMarkdown(paragraphFile.content).body : "";

  const answer = await completeText(integration, [
    {
      role: "system",
      content:
        "You are Narrarium's prose editor. Rewrite only the paragraph body. Preserve facts, chronology, names, and visible canon. Return only the revised paragraph body, no markdown fences, no commentary.",
    },
    {
      role: "user",
      content: `${conversationBundle(input)}\n\nCurrent paragraph body:\n${paragraphBody}\n\nRewrite request: ${input.prompt}`,
    },
  ]);

  return {
    id: crypto.randomUUID(),
    role: "assistant",
    text: `I prepared a revised version of the current paragraph. Review it below and apply it if you want.\n\n${answer.trim()}`,
    action: {
      kind: "apply-paragraph-rewrite",
      bookId: input.book.id,
      chapterSlug: context.chapter.slug,
      paragraphPath: context.paragraph.path,
      proposedBody: answer.trim(),
    },
  };
}

async function createContextNote(input: PromptInput & { book: BookEntry; branch: string; token: string }): Promise<AssistantMessage> {
  const integration = resolveWritingIntegration(input.settings);
  if (!integration) return noAiMessage();
  const targetPath = input.context.noteTargetPath;
  if (!targetPath) {
    return makeAssistantMessage("assistant", "I could not determine where to save a note from the current screen.");
  }

  const answer = await completeText(integration, [
    {
      role: "system",
      content:
        "You create concise writer notes for the current context. Return only the note body in markdown, no frontmatter and no wrapping commentary.",
    },
    {
      role: "user",
      content: `${conversationBundle(input)}\n\nCreate a note for this request: ${input.prompt}`,
    },
  ]);

  await upsertNoteFile({
    token: input.token,
    owner: input.book.owner,
    repo: input.book.repo,
    branch: input.branch,
    path: targetPath,
    title: defaultNoteTitle(targetPath),
    noteBody: answer.trim(),
  });

  return makeAssistantMessage("assistant", `I saved a note to \`${targetPath}\`.\n\n${answer.trim()}`);
}

async function searchCurrentBook(input: PromptInput & { book: BookEntry; token: string }): Promise<AssistantMessage> {
  const { context, prompt, book, token } = input;
  const structure = context.structure;
  if (!structure) return makeAssistantMessage("assistant", "The book structure is not loaded yet.");

  const terms = extractSearchTerms(prompt);
  if (!terms.length) {
    return makeAssistantMessage("assistant", "Tell me what keywords to search for, for example: 'find a character about memory and debt' or 'search paragraph gate lantern'.");
  }

  const sectionHint = detectSectionHint(prompt);
  const results: string[] = [];

  const matchText = (value: string) => {
    const lower = value.toLowerCase();
    return terms.every((term) => lower.includes(term));
  };

  const canonSections = [
    ["characters", structure.characters],
    ["locations", structure.locations],
    ["factions", structure.factions],
    ["items", structure.items],
    ["secrets", structure.secrets],
    ["timelines", structure.timelines],
  ] as const;

  if (!sectionHint || sectionHint === "characters" || sectionHint === "canon") {
    for (const [section, files] of canonSections) {
      if (sectionHint && sectionHint !== "canon" && sectionHint !== section) continue;
      const matched = files.filter((file) => matchText(`${file.path} ${slugToTitle(file.path.split("/").pop()?.replace(/\.md$/, "") ?? file.path)}`));
      for (const file of matched.slice(0, 4)) {
        results.push(`- ${section}: ${file.path}`);
      }
    }
  }

  if (!sectionHint || sectionHint === "paragraphs") {
    const paragraphCandidates = structure.chapters.flatMap((chapter) =>
      chapter.paragraphs.map((paragraph) => ({ chapter, paragraph })),
    );

    const matchedByTitle = paragraphCandidates.filter(({ chapter, paragraph }) =>
      matchText(`${chapter.title} ${paragraph.title} ${paragraph.path}`),
    );

    for (const hit of matchedByTitle.slice(0, 5)) {
      results.push(`- paragraph: ${hit.chapter.slug}/${hit.paragraph.number} ${hit.paragraph.title}`);
    }

    if (matchedByTitle.length === 0) {
      for (const hit of paragraphCandidates.slice(0, 24)) {
        try {
          const content = await loadFileContent(token, book.owner, book.repo, hit.paragraph.path);
          if (matchText(content)) {
            results.push(`- paragraph body: ${hit.chapter.slug}/${hit.paragraph.number} ${hit.paragraph.title}`);
            if (results.length >= 5) break;
          }
        } catch {
          // ignore read failures during search
        }
      }
    }
  }

  if (results.length === 0) {
    return makeAssistantMessage("assistant", `I could not find a match for: ${terms.join(", ")}. Try fewer or broader keywords.`);
  }

  return makeAssistantMessage("assistant", `Search results for **${terms.join(", ")}**:\n\n${results.join("\n")}`);
}

async function upsertNoteFile(input: {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  path: string;
  title: string;
  noteBody: string;
}) {
  const timestamp = new Date().toISOString();
  const section = `## ${timestamp}\n\n${input.noteBody.trim()}\n`;

  try {
    const existing = await readFileWithSha(input.token, input.owner, input.repo, input.branch, input.path);
    const parsed = parseMarkdown(existing.content);
    const nextBody = `${parsed.body.trim()}\n\n${section}`.trim() + "\n";
    const nextRaw = renderMarkdown(parsed.frontmatter, nextBody);
    await updateFile(
      input.token,
      input.owner,
      input.repo,
      input.branch,
      input.path,
      existing.sha,
      nextRaw,
      `Update notes ${input.path}`,
    );
    return;
  } catch {
    const frontmatter =
      input.path === "notes.md"
        ? {
            type: "note",
            id: "note:book:notes",
            title: input.title,
            scope: "book",
            bucket: "notes",
            entries: [],
          }
        : chapterDraftNoteFrontmatter(input.path, input.title);
    await createFile(
      input.token,
      input.owner,
      input.repo,
      input.branch,
      input.path,
      renderMarkdown(frontmatter, section),
      `Add notes ${input.path}`,
    );
  }
}

function chapterDraftNoteFrontmatter(path: string, title: string) {
  const match = /^drafts\/([^/]+)\/notes\.md$/.exec(path);
  const chapterSlug = match?.[1] ?? "unknown";
  return {
    type: "note",
    id: `note:chapter-draft:notes:${chapterSlug}`,
    title,
    scope: "chapter-draft",
    bucket: "notes",
    chapter: `chapter:${chapterSlug}`,
    entries: [],
  };
}

function defaultNoteTitle(path: string): string {
  if (path === "notes.md") return "Book Notes";
  const match = /^drafts\/([^/]+)\/notes\.md$/.exec(path);
  return `Chapter Draft Notes ${match?.[1] ?? "unknown"}`;
}

function parseMarkdown(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { frontmatter: {}, body: raw };
  const doc = parseDocument(match[1]);
  return {
    frontmatter: (doc.toJSON() as Record<string, unknown>) ?? {},
    body: match[2],
  };
}

function renderMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${body.replace(/^\n+/, "")}`;
}

function conversationBundle(input: PromptInput): string {
  const files = input.context.relevantFiles
    .map((entry) => `FILE: ${entry.path}\n${entry.content}`)
    .join("\n\n---\n\n");
  const recentMessages = input.history
    .slice(input.compactedMessageCount)
    .slice(-8)
    .map((message) => `${message.role.toUpperCase()}: ${message.text}`)
    .join("\n\n");

  return [
    `Current context: ${input.context.title}`,
    input.context.summary,
    input.compactSummary ? `Conversation compact summary:\n${input.compactSummary}` : "",
    recentMessages ? `Recent conversation:\n${recentMessages}` : "",
    files ? `Repository files:\n\n${files}` : "",
  ].filter(Boolean).join("\n\n");
}

function extractSearchTerms(prompt: string): string[] {
  return prompt
    .toLowerCase()
    .replace(/[^a-z0-9à-ÿ\s-]/gi, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2)
    .filter((token) => !new Set(["find", "search", "cerca", "trova", "paragraph", "paragrafo", "character", "characters", "personaggio", "personaggi", "canon", "book"]).has(token))
    .slice(0, 5);
}

function detectSectionHint(prompt: string): "characters" | "paragraphs" | "canon" | null {
  const lowered = prompt.toLowerCase();
  if (/\b(character|characters|personaggio|personaggi)\b/.test(lowered)) return "characters";
  if (/\b(paragraph|paragraphs|paragrafo|paragrafi|scene|scena)\b/.test(lowered)) return "paragraphs";
  if (/\b(canon|entity|entities|lore)\b/.test(lowered)) return "canon";
  return null;
}

function looksLikeSummary(prompt: string): boolean {
  return /\b(summary|summar|riassunt|recap|overview)\b/.test(prompt);
}

function looksLikeReview(prompt: string): boolean {
  return /\b(review|critique|feedback|editorial|analy[sz]e|valuta|reviewa)\b/.test(prompt);
}

function looksLikeNote(prompt: string): boolean {
  return /\b(note|notes|appunto|appunti|memo)\b/.test(prompt);
}

function looksLikeRewrite(prompt: string): boolean {
  return /\b(rewrite|revise|fix|improve|polish|sistema|riscrivi|migliora|paragrafo)\b/.test(prompt);
}

function looksLikeSearch(prompt: string): boolean {
  return /\b(search|find|lookup|cerca|trova|keyword|keywords|search for)\b/.test(prompt);
}

function makeAssistantMessage(role: "assistant" | "system", text: string): AssistantMessage {
  return { id: crypto.randomUUID(), role, text };
}

function noAiMessage(): AssistantMessage {
  return makeAssistantMessage(
    "assistant",
    "No AI integration is configured yet. Add an Azure OpenAI or OpenAI-compatible provider in Settings -> AI integrations.",
  );
}

type PromptInput = {
  prompt: string;
  context: LoadedWriterContext;
  settings: AppSettings;
  history: AssistantMessage[];
  compactSummary: string;
  compactedMessageCount: number;
};
