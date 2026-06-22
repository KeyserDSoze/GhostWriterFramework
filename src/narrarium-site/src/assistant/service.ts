import { parseDocument, stringify } from "yaml";
import { createFile, readFileWithSha, updateFile } from "@/github/githubClient";
import type { AppSettings, BookEntry } from "@/types/settings";
import type { LoadedWriterContext } from "@/assistant/context";
import { completeText, resolveReviewIntegration, resolveWritingIntegration } from "@/assistant/llm";
import type { AssistantAction, AssistantMessage } from "@/assistant/store";

export async function runAssistantPrompt(input: {
  prompt: string;
  context: LoadedWriterContext;
  settings: AppSettings;
  book: BookEntry | null;
  branch: string;
  token: string;
}): Promise<AssistantMessage> {
  const { prompt, context, settings, book, branch, token } = input;
  const lowered = prompt.toLowerCase();

  if (!book || !token) {
    return makeAssistantMessage("assistant", "No GitHub token is configured for the current book, so I cannot read or write repository files from this context.");
  }

  if (!context.structure) {
    return makeAssistantMessage("assistant", "The current book structure is not loaded yet. Open the book page first so I can gather the right context.");
  }

  if (looksLikeRewrite(lowered)) {
    return rewriteCurrentParagraph({ prompt, context, settings, book, branch, token });
  }
  if (looksLikeNote(lowered)) {
    return createContextNote({ prompt, context, settings, book, branch, token });
  }
  if (looksLikeReview(lowered)) {
    return reviewCurrentContext({ prompt, context, settings });
  }
  if (looksLikeSummary(lowered)) {
    return summarizeCurrentContext({ prompt, context, settings });
  }

  return answerFromContext({ prompt, context, settings });
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

async function summarizeCurrentContext(input: {
  prompt: string;
  context: LoadedWriterContext;
  settings: AppSettings;
}): Promise<AssistantMessage> {
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
      content: `${contextBundle(input.context)}\n\nRequest: ${input.prompt}`,
    },
  ]);
  return makeAssistantMessage("assistant", answer.trim());
}

async function reviewCurrentContext(input: {
  prompt: string;
  context: LoadedWriterContext;
  settings: AppSettings;
}): Promise<AssistantMessage> {
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
      content: `${contextBundle(input.context)}\n\nReview request: ${input.prompt}`,
    },
  ], "review");
  return makeAssistantMessage("assistant", answer.trim());
}

async function answerFromContext(input: {
  prompt: string;
  context: LoadedWriterContext;
  settings: AppSettings;
}): Promise<AssistantMessage> {
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
      content: `${contextBundle(input.context)}\n\nUser request: ${input.prompt}`,
    },
  ]);
  return makeAssistantMessage("assistant", answer.trim());
}

async function rewriteCurrentParagraph(input: {
  prompt: string;
  context: LoadedWriterContext;
  settings: AppSettings;
  book: BookEntry;
  branch: string;
  token: string;
}): Promise<AssistantMessage> {
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
      content: `${contextBundle(context)}\n\nCurrent paragraph body:\n${paragraphBody}\n\nRewrite request: ${input.prompt}`,
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

async function createContextNote(input: {
  prompt: string;
  context: LoadedWriterContext;
  settings: AppSettings;
  book: BookEntry;
  branch: string;
  token: string;
}): Promise<AssistantMessage> {
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
      content: `${contextBundle(input.context)}\n\nCreate a note for this request: ${input.prompt}`,
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

function contextBundle(context: LoadedWriterContext): string {
  const files = context.relevantFiles
    .map((entry) => `FILE: ${entry.path}\n${entry.content}`)
    .join("\n\n---\n\n");
  return [
    `Current context: ${context.title}`,
    context.summary,
    files ? `\nRepository files:\n\n${files}` : "",
  ].filter(Boolean).join("\n\n");
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

function makeAssistantMessage(role: "assistant" | "system", text: string): AssistantMessage {
  return { id: crypto.randomUUID(), role, text };
}

function noAiMessage(): AssistantMessage {
  return makeAssistantMessage(
    "assistant",
    "No AI integration is configured yet. Add an Azure OpenAI or OpenAI-compatible provider in Settings -> AI integrations.",
  );
}
