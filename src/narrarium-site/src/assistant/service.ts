import { parseDocument, stringify } from "yaml";
import { createFile, loadFileContent, readFileWithSha, slugToTitle, updateFile } from "@/github/githubClient";
import type { AppSettings, BookEntry } from "@/types/settings";
import type { LoadedWriterContext } from "@/assistant/context";
import {
  completeText,
  resolveReviewIntegration,
  resolveWritingIntegration,
  type LlmContentPart,
  type LlmMessage,
} from "@/assistant/llm";
import type {
  AssistantAction,
  AssistantAttachment,
  AssistantMessage,
  AssistantSession,
} from "@/assistant/store";

type PromptInput = {
  prompt: string;
  context: LoadedWriterContext;
  settings: AppSettings;
  history: AssistantMessage[];
  compactSummary: string;
  compactedMessageCount: number;
  attachments: AssistantAttachment[];
};

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
  attachments: AssistantAttachment[];
}): Promise<AssistantMessage> {
  const { prompt, context, settings, book, branch, token, history, compactSummary, compactedMessageCount, attachments } = input;
  const lowered = prompt.toLowerCase();
  const promptInput: PromptInput = { prompt, context, settings, history, compactSummary, compactedMessageCount, attachments };

  if (!book || !token) {
    return makeAssistantMessage("assistant", "No GitHub token is configured for the current book, so I cannot read or write repository files from this context.");
  }
  if (!context.structure) {
    return makeAssistantMessage("assistant", "The current book structure is not loaded yet. Open the book page first so I can gather the right context.");
  }

  if (looksLikeSearch(lowered)) return searchCurrentBook({ ...promptInput, book, token });
  if (looksLikeUpdatePlot(lowered)) return writePlotUpdate({ ...promptInput, book, branch, token });
  if (looksLikeWriteResume(lowered)) return writeResume({ ...promptInput, book, branch, token });
  if (looksLikeWriteEvaluation(lowered)) return writeEvaluation({ ...promptInput, book, branch, token });
  if (looksLikeMultiFileEdit(lowered)) return proposeMultiFileUpdates({ ...promptInput, book, token });
  if (looksLikeRewrite(lowered)) return rewriteCurrentParagraph({ ...promptInput, book, branch, token });
  if (looksLikeNote(lowered)) return createContextNote({ ...promptInput, book, branch, token });
  if (looksLikeReview(lowered)) return reviewCurrentContext(promptInput);
  if (looksLikeSummary(lowered)) return summarizeCurrentContext(promptInput);
  return answerFromContext(promptInput);
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
        "Summarize the conversation so far for future continuation. Keep goals, decisions, open questions, created notes, requested edits, and canon-sensitive facts. Return concise bullet points. Do not imply that full file contents are preserved; file contents must be reloaded when needed.",
    },
    { role: "user", content },
  ]);

  return { ...session, compactSummary: summary.trim(), compactedMessageCount: targetCount };
}

export async function applyParagraphRewrite(input: {
  action: Extract<AssistantAction, { kind: "apply-paragraph-rewrite" }>;
  book: BookEntry;
  branch: string;
  token: string;
}): Promise<void> {
  const { action, book, branch, token } = input;
  const file = await readFileWithSha(token, book.owner, book.repo, branch, action.paragraphPath);
  const parsed = parseMarkdown(file.content);
  const nextRaw = renderMarkdown(parsed.frontmatter, action.proposedBody);
  await updateFile(token, book.owner, book.repo, branch, action.paragraphPath, file.sha, nextRaw, `Rewrite paragraph ${action.chapterSlug}: ${action.paragraphPath.split("/").pop()}`);
}

async function summarizeCurrentContext(input: PromptInput): Promise<AssistantMessage> {
  const integration = resolveWritingIntegration(input.settings);
  if (!integration) return noAiMessage();
  const answer = await completeText(integration, [
    buildSystemMessage(input, "You are Narrarium's writing assistant. Summarize the current context clearly and concretely. Use compact paragraphs and bullet points when useful."),
    buildUserMessage(input, `Request: ${input.prompt}`),
  ]);
  return makeAssistantMessage("assistant", answer.trim());
}

async function reviewCurrentContext(input: PromptInput): Promise<AssistantMessage> {
  const integration = resolveReviewIntegration(input.settings) ?? resolveWritingIntegration(input.settings);
  if (!integration) return noAiMessage();
  const answer = await completeText(integration, [
    buildSystemMessage(input, "You are Narrarium's editorial reviewer. Review the current context with concrete strengths, issues, and specific next actions. Preserve facts; do not invent canon."),
    buildUserMessage(input, `Review request: ${input.prompt}`),
  ], "review");
  return makeAssistantMessage("assistant", answer.trim());
}

async function answerFromContext(input: PromptInput): Promise<AssistantMessage> {
  const integration = resolveWritingIntegration(input.settings);
  if (!integration) return noAiMessage();
  const answer = await completeText(integration, [
    buildSystemMessage(input, "You are Narrarium's contextual writing copilot. Answer only from the provided repository context and current location. The manifest lists available files; only LOADED FILE contents are available in full. If needed content is not loaded, say which file you need."),
    buildUserMessage(input, `User request: ${input.prompt}`),
  ]);
  return makeAssistantMessage("assistant", answer.trim());
}

async function writeResume(input: PromptInput & { book: BookEntry; branch: string; token: string }): Promise<AssistantMessage> {
  const chapter = input.context.chapter;
  if (!chapter) {
    return makeAssistantMessage("assistant", "Resume writing works when you are inside a chapter or one of its paragraph/workspace pages.");
  }
  const integration = resolveWritingIntegration(input.settings);
  if (!integration) return noAiMessage();
  const targetPath = `resumes/chapters/${chapter.slug}.md`;
  const answer = await completeText(integration, [
    buildSystemMessage(input, "Write a chapter resume suitable for the chapter resume file. Preserve chronology and visible canon. Return only the markdown body, no frontmatter."),
    buildUserMessage(input, `Write or refresh the resume for chapter ${chapter.slug}. Request: ${input.prompt}`),
  ]);
  await upsertStructuredMarkdownFile({
    token: input.token,
    owner: input.book.owner,
    repo: input.book.repo,
    branch: input.branch,
    path: targetPath,
    frontmatter: { type: "resume", id: `resume:chapter:${chapter.slug}`, title: `Resume ${chapter.slug}` },
    body: answer.trim(),
    message: `Update chapter resume ${chapter.slug}`,
  });
  return makeAssistantMessage("assistant", `I wrote the chapter resume to \`${targetPath}\`.\n\n${answer.trim()}`);
}

async function writeEvaluation(input: PromptInput & { book: BookEntry; branch: string; token: string }): Promise<AssistantMessage> {
  const integration = resolveReviewIntegration(input.settings) ?? resolveWritingIntegration(input.settings);
  if (!integration) return noAiMessage();

  if (input.context.paragraph && input.context.chapter) {
    const paragraphSlug = input.context.paragraph.path.split("/").pop()?.replace(/\.md$/i, "") ?? input.context.paragraph.number;
    const targetPath = `evaluations/paragraphs/${input.context.chapter.slug}/${paragraphSlug}.md`;
    const answer = await completeText(integration, [
      buildSystemMessage(input, "Write a paragraph evaluation suitable for the paragraph evaluation file. Use markdown headings and concise bullet points. Return only the body, no frontmatter."),
      buildUserMessage(input, `Write or refresh the evaluation for paragraph ${paragraphSlug}. Request: ${input.prompt}`),
    ], "review");
    await upsertStructuredMarkdownFile({
      token: input.token,
      owner: input.book.owner,
      repo: input.book.repo,
      branch: input.branch,
      path: targetPath,
      frontmatter: {
        type: "evaluation",
        id: `evaluation:paragraph:${input.context.chapter.slug}:${paragraphSlug}`,
        title: `Evaluation ${input.context.chapter.slug} ${paragraphSlug}`,
        chapter: `chapter:${input.context.chapter.slug}`,
        paragraph: `paragraph:${input.context.chapter.slug}:${paragraphSlug}`,
      },
      body: answer.trim(),
      message: `Update paragraph evaluation ${paragraphSlug}`,
    });
    return makeAssistantMessage("assistant", `I wrote the paragraph evaluation to \`${targetPath}\`.\n\n${answer.trim()}`);
  }

  const chapter = input.context.chapter;
  if (!chapter) {
    return makeAssistantMessage("assistant", "Evaluation writing works from a chapter or paragraph context.");
  }
  const targetPath = `evaluations/chapters/${chapter.slug}.md`;
  const answer = await completeText(integration, [
    buildSystemMessage(input, "Write a chapter evaluation suitable for the chapter evaluation file. Use markdown headings and concise bullet points. Return only the body, no frontmatter."),
    buildUserMessage(input, `Write or refresh the evaluation for chapter ${chapter.slug}. Request: ${input.prompt}`),
  ], "review");
  await upsertStructuredMarkdownFile({
    token: input.token,
    owner: input.book.owner,
    repo: input.book.repo,
    branch: input.branch,
    path: targetPath,
    frontmatter: { type: "evaluation", id: `evaluation:chapter:${chapter.slug}`, title: `Evaluation ${chapter.slug}` },
    body: answer.trim(),
    message: `Update chapter evaluation ${chapter.slug}`,
  });
  return makeAssistantMessage("assistant", `I wrote the chapter evaluation to \`${targetPath}\`.\n\n${answer.trim()}`);
}

async function writePlotUpdate(input: PromptInput & { book: BookEntry; branch: string; token: string }): Promise<AssistantMessage> {
  const integration = resolveWritingIntegration(input.settings);
  if (!integration) return noAiMessage();
  const targetPath = "plot.md";
  const answer = await completeText(integration, [
    buildSystemMessage(input, "Update the book plot document in markdown. Keep it concise, structural, and consistent with the loaded canon. Return only the body, no frontmatter."),
    buildUserMessage(input, `Refresh plot.md for this book. Request: ${input.prompt}`),
  ]);
  await upsertStructuredMarkdownFile({
    token: input.token,
    owner: input.book.owner,
    repo: input.book.repo,
    branch: input.branch,
    path: targetPath,
    frontmatter: { type: "plot", id: "plot:main", title: "Plot" },
    body: answer.trim(),
    message: "Update plot.md",
  });
  return makeAssistantMessage("assistant", `I updated \`${targetPath}\`.\n\n${answer.trim()}`);
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
    buildSystemMessage(input, "You are Narrarium's prose editor. Rewrite only the paragraph body. Preserve facts, chronology, names, and visible canon. Return only the revised paragraph body, no markdown fences, no commentary. Use any loaded writing-style files if present."),
    buildUserMessage(input, `Current paragraph body:\n${paragraphBody}\n\nRewrite request: ${input.prompt}`),
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

async function proposeMultiFileUpdates(input: PromptInput & { book: BookEntry; token: string }): Promise<AssistantMessage> {
  const integration = resolveWritingIntegration(input.settings);
  if (!integration) return noAiMessage();
  const answer = await completeText(integration, [
    buildSystemMessage(input, 'You are Narrarium file editor. Propose multi-file changes only for files in the available manifest or obvious notes/workspace files. Return ONLY JSON: {"summary":"...","updates":[{"path":"relative/path.md","content":"FULL NEW FILE CONTENT","reason":"..."}]}. Do not wrap in markdown.'),
    buildUserMessage(input, `User multi-file request: ${input.prompt}`),
  ]);
  const parsed = parseJsonObject(answer);
  const updates = Array.isArray(parsed?.updates)
    ? parsed.updates.filter((entry): entry is { path: string; content: string; reason?: string } => typeof entry?.path === "string" && typeof entry?.content === "string" && isSafeRelativePath(entry.path)).slice(0, 8)
    : [];
  if (!updates.length) {
    return makeAssistantMessage("assistant", `I could not extract a safe multi-file update plan from the model response. Raw response:\n\n${answer.trim()}`);
  }
  const summary = typeof parsed?.summary === "string" ? parsed.summary : "Multi-file update proposal";
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    text: `${summary}\n\nProposed files:\n${updates.map((entry) => `- ${entry.path}${entry.reason ? `: ${entry.reason}` : ""}`).join("\n")}`,
    action: { kind: "apply-file-updates", bookId: input.book.id, updates },
  };
}

async function createContextNote(input: PromptInput & { book: BookEntry; branch: string; token: string }): Promise<AssistantMessage> {
  const integration = resolveWritingIntegration(input.settings);
  if (!integration) return noAiMessage();
  const targetPath = input.context.noteTargetPath;
  if (!targetPath) return makeAssistantMessage("assistant", "I could not determine where to save a note from the current screen.");
  const answer = await completeText(integration, [
    buildSystemMessage(input, "You create concise writer notes for the current context. Return only the note body in markdown, no frontmatter and no wrapping commentary."),
    buildUserMessage(input, `Create a note for this request: ${input.prompt}`),
  ]);
  await upsertNoteFile({ token: input.token, owner: input.book.owner, repo: input.book.repo, branch: input.branch, path: targetPath, title: defaultNoteTitle(targetPath), noteBody: answer.trim() });
  return makeAssistantMessage("assistant", `I saved a note to \`${targetPath}\`.\n\n${answer.trim()}`);
}

async function searchCurrentBook(input: PromptInput & { book: BookEntry; token: string }): Promise<AssistantMessage> {
  const { context, prompt, book, token } = input;
  const structure = context.structure;
  if (!structure) return makeAssistantMessage("assistant", "The book structure is not loaded yet.");
  const terms = extractSearchTerms(prompt);
  if (!terms.length) return makeAssistantMessage("assistant", "Tell me what keywords to search for, for example: 'find a character about memory and debt' or 'search paragraph gate lantern'.");
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
      for (const file of matched.slice(0, 4)) results.push(`- ${section}: ${file.path}`);
    }
  }
  if (!sectionHint || sectionHint === "paragraphs") {
    const paragraphCandidates = structure.chapters.flatMap((chapter) => chapter.paragraphs.map((paragraph) => ({ chapter, paragraph })));
    const matchedByTitle = paragraphCandidates.filter(({ chapter, paragraph }) => matchText(`${chapter.title} ${paragraph.title} ${paragraph.path}`));
    for (const hit of matchedByTitle.slice(0, 5)) results.push(`- paragraph: ${hit.chapter.slug}/${hit.paragraph.number} ${hit.paragraph.title}`);
    if (matchedByTitle.length === 0) {
      for (const hit of paragraphCandidates.slice(0, 24)) {
        try {
          const content = await loadFileContent(token, book.owner, book.repo, hit.paragraph.path, input.context.structure?.loadedBranch);
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
  if (results.length === 0) return makeAssistantMessage("assistant", `I could not find a match for: ${terms.join(", ")}. Try fewer or broader keywords.`);
  return makeAssistantMessage("assistant", `Search results for **${terms.join(", ")}**:\n\n${results.join("\n")}`);
}

async function upsertStructuredMarkdownFile(input: {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
  message: string;
}) {
  try {
    const existing = await readFileWithSha(input.token, input.owner, input.repo, input.branch, input.path);
    await updateFile(input.token, input.owner, input.repo, input.branch, input.path, existing.sha, renderMarkdown(input.frontmatter, `${input.body.trim()}\n`), input.message);
    return;
  } catch {
    await createFile(input.token, input.owner, input.repo, input.branch, input.path, renderMarkdown(input.frontmatter, `${input.body.trim()}\n`), input.message);
  }
}

async function upsertNoteFile(input: { token: string; owner: string; repo: string; branch: string; path: string; title: string; noteBody: string }) {
  const timestamp = new Date().toISOString();
  const section = `## ${timestamp}\n\n${input.noteBody.trim()}\n`;
  try {
    const existing = await readFileWithSha(input.token, input.owner, input.repo, input.branch, input.path);
    const parsed = parseMarkdown(existing.content);
    const nextBody = `${parsed.body.trim()}\n\n${section}`.trim() + "\n";
    await updateFile(input.token, input.owner, input.repo, input.branch, input.path, existing.sha, renderMarkdown(parsed.frontmatter, nextBody), `Update notes ${input.path}`);
    return;
  } catch {
    const frontmatter = input.path === "notes.md"
      ? { type: "note", id: "note:book:notes", title: input.title, scope: "book", bucket: "notes", entries: [] }
      : chapterDraftNoteFrontmatter(input.path, input.title);
    await createFile(input.token, input.owner, input.repo, input.branch, input.path, renderMarkdown(frontmatter, section), `Add notes ${input.path}`);
  }
}

function buildSystemMessage(input: PromptInput, instruction: string): LlmMessage {
  return { role: "system", content: `${instruction}\n\n${systemContextBundle(input)}` };
}

function buildUserMessage(input: PromptInput, requestText: string): LlmMessage {
  const parts: LlmContentPart[] = [
    { type: "text", text: `${userContextBundle(input)}\n\n${requestText}` },
    ...input.attachments.filter((attachment) => attachment.kind === "image" && attachment.imageDataUrl).map((attachment) => ({ type: "image" as const, dataUrl: attachment.imageDataUrl! })),
  ];
  return { role: "user", content: parts };
}

function systemContextBundle(input: PromptInput): string {
  const available = input.context.availableFiles.slice(0, 200).map((entry) => `- ${entry.path} (${entry.role})`).join("\n");
  const loadedList = input.context.loadedFilePaths.length ? input.context.loadedFilePaths.map((path) => `- ${path}`).join("\n") : "- none";
  return [
    `Current route title: ${input.context.title}`,
    `Current route summary: ${input.context.summary}`,
    `Available repository files (manifest only):\n${available || "- none"}`,
    `Loaded files available in full this turn:\n${loadedList}`,
    input.context.noteTargetPath ? `Default note target: ${input.context.noteTargetPath}` : "",
  ].filter(Boolean).join("\n\n");
}

function userContextBundle(input: PromptInput): string {
  const files = input.context.relevantFiles.map((entry) => `LOADED FILE: ${entry.path}\n${entry.content}`).join("\n\n---\n\n");
  const recentMessages = input.history.slice(input.compactedMessageCount).slice(-8).map((message) => `${message.role.toUpperCase()}: ${message.text}`).join("\n\n");
  const textAttachments = input.attachments.filter((attachment) => attachment.kind === "text" && attachment.textContent).map((attachment) => `ATTACHMENT: ${attachment.name}\n${attachment.textContent}`).join("\n\n---\n\n");
  const imageAttachments = input.attachments.filter((attachment) => attachment.kind === "image").map((attachment) => `IMAGE ATTACHMENT: ${attachment.name} (${attachment.mimeType})`).join("\n");
  return [
    input.compactSummary ? `Conversation compact summary (does not preserve full file contents):\n${input.compactSummary}` : "",
    recentMessages ? `Recent conversation:\n${recentMessages}` : "",
    files ? `Loaded repository file contents:\n\n${files}` : "",
    textAttachments ? `Extracted attachment text:\n\n${textAttachments}` : "",
    imageAttachments ? `Image attachments included separately in this request:\n${imageAttachments}` : "",
  ].filter(Boolean).join("\n\n");
}

function chapterDraftNoteFrontmatter(path: string, title: string) {
  const match = /^drafts\/([^/]+)\/notes\.md$/.exec(path);
  const chapterSlug = match?.[1] ?? "unknown";
  return { type: "note", id: `note:chapter-draft:notes:${chapterSlug}`, title, scope: "chapter-draft", bucket: "notes", chapter: `chapter:${chapterSlug}`, entries: [] };
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
  return { frontmatter: (doc.toJSON() as Record<string, unknown>) ?? {}, body: match[2] };
}

function renderMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${body.replace(/^\n+/, "")}`;
}

function extractSearchTerms(prompt: string): string[] {
  return prompt.toLowerCase().replace(/[^a-z0-9à-ÿ\s-]/gi, " ").split(/\s+/).filter((token) => token.length > 2).filter((token) => !new Set(["find", "search", "cerca", "trova", "paragraph", "paragrafo", "character", "characters", "personaggio", "personaggi", "canon", "book"]).has(token)).slice(0, 5);
}

function detectSectionHint(prompt: string): "characters" | "paragraphs" | "canon" | null {
  const lowered = prompt.toLowerCase();
  if (/\b(character|characters|personaggio|personaggi)\b/.test(lowered)) return "characters";
  if (/\b(paragraph|paragraphs|paragrafo|paragrafi|scene|scena)\b/.test(lowered)) return "paragraphs";
  if (/\b(canon|entity|entities|lore)\b/.test(lowered)) return "canon";
  return null;
}

function looksLikeSummary(prompt: string): boolean { return /\b(summary|summar|riassunt|recap|overview)\b/.test(prompt); }
function looksLikeWriteResume(prompt: string): boolean { return /\b(resume|riassunto)\b/.test(prompt) && /\b(write|save|refresh|aggiorna|scrivi|salva|crea)\b/.test(prompt); }
function looksLikeWriteEvaluation(prompt: string): boolean { return /\b(evaluation|evaluate|review file|valutazione)\b/.test(prompt) && /\b(write|save|refresh|aggiorna|scrivi|salva|crea)\b/.test(prompt); }
function looksLikeUpdatePlot(prompt: string): boolean { return /\b(plot)\b/.test(prompt) && /\b(update|refresh|aggiorna|scrivi|salva|sync)\b/.test(prompt); }
function looksLikeReview(prompt: string): boolean { return /\b(review|critique|feedback|editorial|analy[sz]e|valuta|reviewa)\b/.test(prompt); }
function looksLikeNote(prompt: string): boolean { return /\b(note|notes|appunto|appunti|memo)\b/.test(prompt); }
function looksLikeRewrite(prompt: string): boolean { return /\b(rewrite|revise|fix|improve|polish|sistema|riscrivi|migliora|paragrafo)\b/.test(prompt); }
function looksLikeSearch(prompt: string): boolean { return /\b(search|find|lookup|cerca|trova|keyword|keywords|search for)\b/.test(prompt); }
function looksLikeMultiFileEdit(prompt: string): boolean { return /\b(multi[- ]?file|piu file|più file|several files|update files|modifica.*file|aggiorna.*file|attachment|allegat)\b/.test(prompt); }

function parseJsonObject(value: string): Record<string, unknown> | null {
  const trimmed = value.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isSafeRelativePath(path: string): boolean {
  return !path.startsWith("/") && !path.includes("..") && path.endsWith(".md");
}

function makeAssistantMessage(role: "assistant" | "system", text: string): AssistantMessage {
  return { id: crypto.randomUUID(), role, text };
}

function noAiMessage(): AssistantMessage {
  return makeAssistantMessage("assistant", "No AI integration is configured yet. Add an Azure OpenAI or OpenAI-compatible provider in Settings -> AI integrations.");
}
