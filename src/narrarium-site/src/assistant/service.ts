import OpenAI, { AzureOpenAI } from "openai";
import { parseDocument, stringify } from "yaml";
import {
  compareBranches,
  createFile,
  createPullRequest,
  listBranchCommits,
  listBranches,
  listOpenPullRequests,
  loadFileContent,
  readFileWithSha,
  slugToTitle,
  updateFile,
} from "@/github/githubClient";
import type { AppSettings, BookEntry } from "@/types/settings";
import type { ChatCapability } from "@/types/settings";
import type { LoadedWriterContext } from "@/assistant/context";
import {
  type LlmContentPart,
  type LlmMessage,
} from "@/assistant/llm";
import { completeTextRouted, resolveTaskCandidates } from "@/assistant/router";
import { buildCapabilitiesMessage, chooseToolHandlerId, isCapabilityQuestion } from "@/assistant/orchestrator";
import { resolveNavigateAction, resolveReadAloudAction } from "@/assistant/planner";
import type {
  AssistantAction,
  AssistantAttachment,
  AssistantMessage,
  AssistantSession,
} from "@/assistant/store";
import {
  createCanonEntity,
  createChapter,
  createParagraphDocument,
  type EntityKind,
} from "@/narrarium/canon";
import {
  createChapterDraftArtifacts,
  createParagraphDraftArtifact,
  createParagraphScriptArtifact,
} from "@/narrarium/workspace";
import { GITHUB_MODELS_INFERENCE_URL } from "@/config/githubModels";
import { defaultEvaluationCriteria, defaultEvaluationGuidelinesMarkdown, EVALUATION_GUIDELINES_PATH } from "@/narrarium/defaultGuidelines";
import { emptyReaderPersona } from "@/narrarium/readerPersona";
import { generateReaderEvaluationSummary, hashReaderSource, loadReaderPersonas, parseReaderEvaluation, runReaderEvaluations, saveReaderPersona, type ReaderEvaluationRecord, type ReaderEvaluationTarget } from "@/narrarium/readerEvaluations";

async function completeForTask(
  settings: AppSettings,
  messages: LlmMessage[],
  capability: ChatCapability,
  options?: { signal?: AbortSignal; label?: string; onText?: (text: string) => void },
): Promise<string | null> {
  try {
    return await completeTextRouted(settings, messages, capability, options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/No AI integration configured/i.test(message)) return null;
    throw err;
  }
}

type PromptInput = {
  prompt: string;
  context: LoadedWriterContext;
  settings: AppSettings;
  history: AssistantMessage[];
  compactSummary: string;
  compactedMessageCount: number;
  attachments: AssistantAttachment[];
  spokenMode?: boolean;
  signal?: AbortSignal;
  onText?: (text: string) => void;
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
    spokenMode?: boolean;
    signal?: AbortSignal;
    onText?: (text: string) => void;
}): Promise<AssistantMessage> {
  const {
    prompt,
    context,
    settings,
    book,
    branch,
    token,
    history,
    compactSummary,
    compactedMessageCount,
    attachments,
    spokenMode,
    signal,
    onText,
  } = input;
  const lowered = prompt.toLowerCase();
  const promptInput: PromptInput = {
    prompt,
    context,
    settings,
    history,
    compactSummary,
    compactedMessageCount,
    attachments,
    spokenMode,
    signal,
    onText,
  };

  if (isCapabilityQuestion(prompt)) return buildCapabilitiesMessage(prompt, settings);

  if (!book || !token) {
    return makeAssistantMessage(
      "assistant",
      "No GitHub token is configured for the current book, so I cannot read or write repository files from this context.",
    );
  }
  if (!context.structure) {
    return makeAssistantMessage(
      "assistant",
      "The current book structure is not loaded yet. Open the book page first so I can gather the right context.",
    );
  }

  const handlers = {
    "search-book": () => searchCurrentBook({ ...promptInput, book, token }),
    "switch-branch": () => switchBookBranchFromPrompt({ ...promptInput, book, branch, token }),
    "import-attachments": () => importAttachmentsIntoBook({ ...promptInput, book, branch, token }),
    "create-chapter": () => createChapterFromPrompt({ ...promptInput, book, branch, token }),
    "create-paragraph": () => createParagraphFromPrompt({ ...promptInput, book, branch, token }),
    "create-entity": () => createEntityFromPrompt({ ...promptInput, book, branch, token }),
    "create-script": () => createScriptFromPrompt({ ...promptInput, book, branch, token }),
    "create-draft": () => createDraftFromPrompt({ ...promptInput, book, branch, token }),
    "update-plot": () => writePlotUpdate({ ...promptInput, book, branch, token }),
    "write-resume": () => writeResume({ ...promptInput, book, branch, token }),
    "write-evaluation": () => writeEvaluation({ ...promptInput, book, branch, token }),
    "evaluate-chapter-paragraphs": () => writeAllParagraphEvaluations({ ...promptInput, book, branch, token }),
    "rewrite-paragraph": () => rewriteCurrentParagraph({ ...promptInput, book, branch, token }),
    "create-note": () => createContextNote({ ...promptInput, book, branch, token }),
    "review-context": () => reviewCurrentContext(promptInput),
    "summarize-context": () => summarizeCurrentContext(promptInput, token),
    "answer-from-context": () => answerFromContext(promptInput),
    "open-reader": () => openReaderNavigation({ ...promptInput, book }),
    "navigate": () => navigateFromPrompt({ ...promptInput, book }),
    "read-current-page": () => readCurrentPageFromPrompt({ ...promptInput, book }),
    "list-simulated-readers": () => listSimulatedReaders({ ...promptInput, book, branch, token }),
    "create-simulated-reader": () => createSimulatedReaderFromPrompt({ ...promptInput, book, branch, token }),
    "toggle-simulated-reader": () => toggleSimulatedReaderFromPrompt({ ...promptInput, book, branch, token }),
    "evaluate-with-readers": () => evaluateWithReadersFromPrompt({ ...promptInput, book, branch, token }),
    "summarize-reader-evaluations": () => summarizeReaderEvaluationsFromPrompt({ ...promptInput, book, branch, token }),
    "open-reader-evaluations": () => openReaderEvaluationsFromContext({ ...promptInput, book }),
    "list-branches": () => listBranchesMessage({ ...promptInput, book, token }),
    "show-branch-diff": () => showBranchDiffMessage({ ...promptInput, book, branch, token }),
    "list-commits": () => listCommitsMessage({ ...promptInput, book, branch, token }),
    "list-pull-requests": () => listPullRequestsMessage({ ...promptInput, book, token }),
    "create-pull-request": () => createPullRequestFromPrompt({ ...promptInput, book, branch, token }),
    "get-book": () => getBookInfo({ ...promptInput, book }),
    "get-chapter": () => getChapterInfo({ ...promptInput, book, token }),
    "get-paragraph": () => getParagraphInfo({ ...promptInput, book, branch, token }),
    "get-character": () => getCanonEntityInfo("characters", { ...promptInput, book, branch, token }),
    "get-location": () => getCanonEntityInfo("locations", { ...promptInput, book, branch, token }),
    "get-faction": () => getCanonEntityInfo("factions", { ...promptInput, book, branch, token }),
    "get-item": () => getCanonEntityInfo("items", { ...promptInput, book, branch, token }),
    "get-secret": () => getCanonEntityInfo("secrets", { ...promptInput, book, branch, token }),
    "get-timeline-event": () => getCanonEntityInfo("timelines", { ...promptInput, book, branch, token }),
    "get-body": () => getBodyInfo({ ...promptInput, book, branch, token }),
    "get-frontmatter": () => getFrontmatterInfo({ ...promptInput, book, branch, token }),
    "delete-current-note": () => requestDeleteNote({ ...promptInput, book }),
    "delete-current-paragraph": () => requestDeleteParagraph({ ...promptInput, book }),
    "delete-current-entity": () => requestDeleteEntity({ ...promptInput, book }),
  } as const;

  const handlerId = chooseToolHandlerId({ prompt, lowered, settings, spokenMode }, new Set(Object.keys(handlers)));
  if (handlerId && handlerId in handlers) return handlers[handlerId as keyof typeof handlers]();

  // Fallback while the registry coverage is still growing. Keep existing behavior for unmatched prompts.
  if (looksLikeSearch(lowered)) return searchCurrentBook({ ...promptInput, book, token });
  if (looksLikeBranchSwitch(lowered)) return switchBookBranchFromPrompt({ ...promptInput, book, branch, token });
  if (looksLikeImportAttachment(lowered)) return importAttachmentsIntoBook({ ...promptInput, book, branch, token });
  if (looksLikeCreateChapter(lowered)) return createChapterFromPrompt({ ...promptInput, book, branch, token });
  if (looksLikeCreateParagraph(lowered)) return createParagraphFromPrompt({ ...promptInput, book, branch, token });
  if (looksLikeCreateEntity(lowered)) return createEntityFromPrompt({ ...promptInput, book, branch, token });
  if (looksLikeCreateScript(lowered)) return createScriptFromPrompt({ ...promptInput, book, branch, token });
  if (looksLikeCreateDraft(lowered)) return createDraftFromPrompt({ ...promptInput, book, branch, token });
  if (looksLikeUpdatePlot(lowered)) return writePlotUpdate({ ...promptInput, book, branch, token });
  if (looksLikeWriteResume(lowered)) return writeResume({ ...promptInput, book, branch, token });
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

  const content = session.messages
    .slice(0, targetCount)
    .map((message) => `${message.role.toUpperCase()}: ${message.text}`)
    .join("\n\n");

  const summary = await completeForTask(settings, [
    {
      role: "system",
      content:
        "Summarize the conversation so far for future continuation. Keep goals, decisions, open questions, created notes, requested edits, and canon-sensitive facts. Return concise bullet points. Do not imply that full file contents are preserved; file contents must be reloaded when needed.",
    },
    { role: "user", content },
  ], "chat-resume", { label: "copilot:compact" });
  if (!summary) return session;

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

async function summarizeCurrentContext(input: PromptInput, token?: string): Promise<AssistantMessage> {
  // Hybrid pipeline: when a concrete chapter/paragraph target is resolvable, send only its
  // body to the LLM instead of the whole context bundle, to keep the request small and cheap.
  const target = token ? await resolveTargetBody(input, token) : null;
  if (target) {
    const answer = await completeForTask(input.settings, [
      { role: "system", content: `You summarize the provided text clearly and concisely. Keep the key facts, characters, and events. Return a compact summary.${languageInstruction(input, "user")}` },
      { role: "user", content: `Summarize this ${target.kind} titled "${target.title}":\n\n${target.body}` },
    ], "copilot", { signal: input.signal, label: "copilot:summarize-body", onText: input.onText });
    if (answer) return makeAssistantMessage("assistant", answer.trim());
  }
  const answer = await completeForTask(input.settings, [
    buildSystemMessage(input, "You are Narrarium's writing assistant. Summarize the current context clearly and concretely. Use compact paragraphs and bullet points when useful."),
    buildUserMessage(input, `Request: ${input.prompt}`),
  ], "copilot", { signal: input.signal, label: "copilot:summarize", onText: input.onText });
  if (!answer) return noAiMessage();
  return makeAssistantMessage("assistant", answer.trim());
}

async function reviewCurrentContext(input: PromptInput): Promise<AssistantMessage> {
  const answer = await completeForTask(input.settings, [
    buildSystemMessage(input, "You are Narrarium's editorial reviewer. Review the current context with concrete strengths, issues, and specific next actions. Preserve facts; do not invent canon."),
    buildUserMessage(input, `Review request: ${input.prompt}`),
  ], "review", { signal: input.signal, label: "copilot:review", onText: input.onText });
  if (!answer) return noAiMessage();
  return makeAssistantMessage("assistant", answer.trim());
}

async function answerFromContext(input: PromptInput): Promise<AssistantMessage> {
  const answer = await completeForTask(input.settings, [
    buildSystemMessage(input, "You are Narrarium's contextual writing copilot. Answer only from the provided repository context and current location. The manifest lists available files; only LOADED FILE contents are available in full. If needed content is not loaded, say which file you need."),
    buildUserMessage(input, `User request: ${input.prompt}`),
  ], "copilot", { signal: input.signal, label: "copilot", onText: input.onText });
  if (!answer) return noAiMessage();
  return makeAssistantMessage("assistant", answer.trim());
}


async function switchBookBranchFromPrompt(input: PromptInput & { book: BookEntry; branch: string; token: string }): Promise<AssistantMessage> {
  const branchName = extractBranchName(input.prompt);
  if (!branchName) {
    return makeAssistantMessage("assistant", "Tell me the branch name, for example: switch to branch feature/new-ending or create branch fix/chapter-7.");
  }
  const createIfMissing = /\b(create|new|crea|nuovo)\b/.test(input.prompt.toLowerCase());
  const baseBranch = input.context.structure?.defaultBranch ?? "main";
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    text: createIfMissing
      ? "I can create branch `" + branchName + "` from `" + baseBranch + "` and switch this book to it."
      : "I can switch this book to branch `" + branchName + "`." ,
    action: {
      kind: "switch-book-branch",
      bookId: input.book.id,
      branchName,
      createIfMissing,
      baseBranch,
    },
  };
}

async function openReaderNavigation(input: PromptInput & { book: BookEntry }): Promise<AssistantMessage> {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    text: "Opening the reader.",
    action: { kind: "navigate", to: `/app/books/${input.book.id}/reader`, label: "Reader" },
  };
}

async function navigateFromPrompt(input: PromptInput & { book: BookEntry }): Promise<AssistantMessage> {
  const action = resolveNavigateAction(input.prompt, input.context, input.book.id);
  if (!action) {
    return makeAssistantMessage("assistant", "Tell me where to go, for example: open the reader, go to chapter 3, or open research.");
  }
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    text: `Opening ${action.label ?? action.to}.`,
    action,
  };
}

async function readCurrentPageFromPrompt(input: PromptInput & { book: BookEntry }): Promise<AssistantMessage> {
  const action = resolveReadAloudAction(input.prompt, input.context, input.book.id);
  if (!action) {
    return makeAssistantMessage("assistant", "I couldn't find a chapter or paragraph to read here. Open one, or say for example: read chapter 3.");
  }
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    text: `Reading ${action.title} aloud.`,
    action,
  };
}

async function listBranchesMessage(input: PromptInput & { book: BookEntry; token: string }): Promise<AssistantMessage> {
  const branches = await listBranches(input.token, input.book.owner, input.book.repo);
  if (!branches.length) return makeAssistantMessage("assistant", "No branches found in this repository.");
  const current = input.context.structure?.loadedBranch;
  const lines = branches.map((entry) => `- ${entry.name === current ? "**" + entry.name + "** (current)" : entry.name}${entry.protected ? " · protected" : ""}`);
  return makeAssistantMessage("assistant", `Branches in ${input.book.owner}/${input.book.repo}:\n${lines.join("\n")}`);
}

async function showBranchDiffMessage(input: PromptInput & { book: BookEntry; branch: string; token: string }): Promise<AssistantMessage> {
  const base = input.context.structure?.defaultBranch ?? "main";
  const head = input.branch;
  if (base === head) return makeAssistantMessage("assistant", `You are on the default branch \`${base}\`, so there is nothing to compare.`);
  const files = await compareBranches(input.token, input.book.owner, input.book.repo, base, head);
  if (!files.length) return makeAssistantMessage("assistant", `No differences between \`${head}\` and \`${base}\`.`);
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const lines = files.slice(0, 20).map((file) => `- ${file.status}: ${file.filename} (+${file.additions}/-${file.deletions})`);
  const more = files.length > 20 ? `\n…and ${files.length - 20} more files.` : "";
  return makeAssistantMessage("assistant", `\`${head}\` vs \`${base}\`: ${files.length} file(s), +${additions}/-${deletions}.\n${lines.join("\n")}${more}`);
}

async function listCommitsMessage(input: PromptInput & { book: BookEntry; branch: string; token: string }): Promise<AssistantMessage> {
  const commits = await listBranchCommits(input.token, input.book.owner, input.book.repo, input.branch);
  if (!commits.length) return makeAssistantMessage("assistant", `No commits found on \`${input.branch}\`.`);
  const lines = commits.slice(0, 15).map((commit) => `- \`${commit.sha.slice(0, 7)}\` ${commit.message} — ${commit.authorName}`);
  return makeAssistantMessage("assistant", `Recent commits on \`${input.branch}\`:\n${lines.join("\n")}`);
}

async function listPullRequestsMessage(input: PromptInput & { book: BookEntry; token: string }): Promise<AssistantMessage> {
  const pulls = await listOpenPullRequests(input.token, input.book.owner, input.book.repo);
  if (!pulls.length) return makeAssistantMessage("assistant", "There are no open pull requests in this repository.");
  const lines = pulls.map((pull) => `- #${pull.number} ${pull.title} (${pull.head} → ${pull.base})\n  ${pull.htmlUrl}`);
  return makeAssistantMessage("assistant", `Open pull requests:\n${lines.join("\n")}`);
}

async function createPullRequestFromPrompt(input: PromptInput & { book: BookEntry; branch: string; token: string }): Promise<AssistantMessage> {
  const base = input.context.structure?.defaultBranch ?? "main";
  const head = input.branch;
  if (base === head) return makeAssistantMessage("assistant", `You are on the default branch \`${base}\`. Switch to a feature branch first, then I can open a pull request.`);
  const existing = await listOpenPullRequests(input.token, input.book.owner, input.book.repo, head);
  if (existing.length) return makeAssistantMessage("assistant", `A pull request from \`${head}\` is already open: #${existing[0].number} ${existing[0].title}\n${existing[0].htmlUrl}`);
  const title = extractPullRequestTitle(input.prompt) ?? `Merge ${head} into ${base}`;
  const pull = await createPullRequest(input.token, input.book.owner, input.book.repo, { title, head, base });
  return makeAssistantMessage("assistant", `Opened pull request #${pull.number} “${pull.title}” (${pull.head} → ${pull.base}).\n${pull.htmlUrl}`);
}

function extractPullRequestTitle(prompt: string): string | null {
  const match = prompt.match(/(?:titled?|title|dal titolo|con titolo|chiamala|call it)\s+["“']?([^"”'\n]+)["”']?/i);
  const title = match?.[1]?.trim();
  return title && title.length > 1 ? title : null;
}

async function listSimulatedReaders(input: PromptInput & { book: BookEntry; branch: string; token: string }): Promise<AssistantMessage> {
  const structure = input.context.structure;
  if (!structure) return makeAssistantMessage("assistant", "Open a book first.");
  const readers = await loadReaderPersonas({ token: input.token, book: input.book, branch: input.branch, structure });
  return makeAssistantMessage("assistant", readers.map((reader) => `- ${reader.enabled ? "[on]" : "[off]"} **${reader.name}** (${reader.readerType}) — ${reader.description}`).join("\n"));
}

async function createSimulatedReaderFromPrompt(input: PromptInput & { book: BookEntry; branch: string; token: string }): Promise<AssistantMessage> {
  const structure = input.context.structure;
  if (!structure) return makeAssistantMessage("assistant", "Open a book first.");
  const answer = await completeForTask(input.settings, [
    { role: "system", content: "Return ONLY JSON for a useful simulated reader profile: {\"name\":\"...\",\"description\":\"...\",\"profile\":\"...\",\"aspects\":[\"...\"],\"preferredGenres\":[\"...\"],\"dislikedGenres\":[],\"experienceLevel\":\"...\",\"severity\":1-10,\"audienceAge\":\"...\",\"interests\":[],\"appreciatedElements\":[],\"frequentCriticisms\":[],\"customPrompt\":\"...\"}. Keep it revision-useful, not theatrical roleplay." },
    { role: "user", content: input.prompt },
  ], "default", { signal: input.signal, label: "copilot:create-reader" });
  if (!answer) return noAiMessage();
  const parsed = parseJsonObject(answer);
  const profile = emptyReaderPersona(structure.language ?? input.settings.ui.language);
  const name = typeof parsed?.name === "string" ? parsed.name.trim() : "Custom Reader";
  const next = {
    ...profile,
    name,
    slug: slugToTitle(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    description: typeof parsed?.description === "string" ? parsed.description : "",
    profile: typeof parsed?.profile === "string" ? parsed.profile : "",
    aspects: Array.isArray(parsed?.aspects) ? parsed.aspects.map(String) : [],
    preferredGenres: Array.isArray(parsed?.preferredGenres) ? parsed.preferredGenres.map(String) : [],
    dislikedGenres: Array.isArray(parsed?.dislikedGenres) ? parsed.dislikedGenres.map(String) : [],
    experienceLevel: typeof parsed?.experienceLevel === "string" ? parsed.experienceLevel : "average",
    severity: typeof parsed?.severity === "number" ? Math.max(1, Math.min(10, parsed.severity)) : 5,
    audienceAge: typeof parsed?.audienceAge === "string" ? parsed.audienceAge : "adult",
    interests: Array.isArray(parsed?.interests) ? parsed.interests.map(String) : [],
    appreciatedElements: Array.isArray(parsed?.appreciatedElements) ? parsed.appreciatedElements.map(String) : [],
    frequentCriticisms: Array.isArray(parsed?.frequentCriticisms) ? parsed.frequentCriticisms.map(String) : [],
    customPrompt: typeof parsed?.customPrompt === "string" ? parsed.customPrompt : "",
  };
  const path = await saveReaderPersona({ token: input.token, book: input.book, branch: input.branch, profile: next });
  return makeAssistantMessage("assistant", `Created simulated reader **${next.name}** at \`${path}\`.`);
}

async function toggleSimulatedReaderFromPrompt(input: PromptInput & { book: BookEntry; branch: string; token: string }): Promise<AssistantMessage> {
  const structure = input.context.structure;
  if (!structure) return makeAssistantMessage("assistant", "Open a book first.");
  const readers = await loadReaderPersonas({ token: input.token, book: input.book, branch: input.branch, structure });
  const lower = input.prompt.toLowerCase();
  const reader = readers.sort((a, b) => b.name.length - a.name.length).find((entry) => lower.includes(entry.name.toLowerCase()) || lower.includes(entry.slug.replace(/-/g, " ")));
  if (!reader) return makeAssistantMessage("assistant", "Tell me which simulated reader to enable or disable.");
  const enabled = !/\b(disable|disabilita|spegni|off)\b/.test(lower);
  await saveReaderPersona({ token: input.token, book: input.book, branch: input.branch, profile: { ...reader, enabled } });
  return makeAssistantMessage("assistant", `${reader.name} is now ${enabled ? "enabled" : "disabled"}.`);
}

async function evaluationTargetFromContext(input: PromptInput & { book: BookEntry; branch: string; token: string }): Promise<ReaderEvaluationTarget | null> {
  const chapter = resolveChapterFromPrompt(input);
  if (!chapter) return null;
  const paragraph = resolveParagraphFromPrompt(input);
  if (paragraph) {
    const file = await readFileWithSha(input.token, input.book.owner, input.book.repo, input.branch, paragraph.paragraph.path);
    return { type: "paragraph", bookId: input.book.id, chapterId: chapter.slug, paragraphId: paragraph.paragraph.path.split("/").pop()?.replace(/\.md$/i, ""), title: paragraph.paragraph.title, text: parseMarkdown(file.content).body.trim(), sourcePath: paragraph.paragraph.path, sourceVersion: file.sha };
  }
  const files = await Promise.all(chapter.paragraphs.map((entry) => readFileWithSha(input.token, input.book.owner, input.book.repo, input.branch, entry.path).catch(() => null)));
  return { type: "chapter", bookId: input.book.id, chapterId: chapter.slug, title: chapter.title, text: files.map((file, index) => file ? `## ${chapter.paragraphs[index].title}\n\n${parseMarkdown(file.content).body.trim()}` : "").filter(Boolean).join("\n\n"), sourcePath: `${chapter.path}/chapter.md`, sourceVersion: files.map((file) => file?.sha ?? "").join(":") };
}

async function evaluateWithReadersFromPrompt(input: PromptInput & { book: BookEntry; branch: string; token: string }): Promise<AssistantMessage> {
  const structure = input.context.structure;
  if (!structure) return makeAssistantMessage("assistant", "Open a book first.");
  const [target, readers] = await Promise.all([evaluationTargetFromContext(input), loadReaderPersonas({ token: input.token, book: input.book, branch: input.branch, structure })]);
  if (!target) return makeAssistantMessage("assistant", "Open or name a chapter or paragraph first.");
  const lower = input.prompt.toLowerCase();
  const named = readers.filter((reader) => lower.includes(reader.name.toLowerCase()) || reader.preferredGenres.some((genre) => lower.includes(genre.toLowerCase())));
  const selected = named.length ? named.filter((reader) => reader.enabled) : readers.filter((reader) => reader.enabled);
  if (!selected.length) return makeAssistantMessage("assistant", "No matching simulated readers are enabled.");
  const result = await runReaderEvaluations({ token: input.token, book: input.book, branch: input.branch, structure, settings: input.settings, target, readers: selected, depth: /\b(deep|approfondit)\b/.test(lower) ? "deep" : "brief", includeContext: true, concurrency: 2, signal: input.signal, onProgress: (progress) => input.onText?.(`**${progress.readerName}**: ${progress.status} (${progress.completed}/${progress.total})`) });
  return makeAssistantMessage("assistant", `Completed ${result.completed.length} reader evaluations${result.failed.length ? `; ${result.failed.length} failed` : ""}.\n\n${result.completed.map((record) => `- **${record.readerName}**: ${record.score ?? "-"}/10 — \`${record.path}\``).join("\n")}`);
}

function readerEvaluationPrefixes(target: ReaderEvaluationTarget): string[] {
  if (target.type === "chapter") return [`evaluations/readers/chapters/${target.chapterId}/`];
  const kind = target.type === "paragraph" ? "paragraphs" : "selections";
  return [`evaluations/readers/${kind}/${target.chapterId}/${target.paragraphId ?? "chapter"}/`];
}

async function summarizeReaderEvaluationsFromPrompt(input: PromptInput & { book: BookEntry; branch: string; token: string }): Promise<AssistantMessage> {
  const structure = input.context.structure;
  if (!structure) return makeAssistantMessage("assistant", "Open a book first.");
  const target = await evaluationTargetFromContext(input);
  if (!target) return makeAssistantMessage("assistant", "Open or name a chapter or paragraph first.");
  const hash = await hashReaderSource(target.text);
  const prefixes = readerEvaluationPrefixes(target);
  const records = await Promise.all(structure.readerEvaluationFiles.filter((file) => prefixes.some((prefix) => file.path.startsWith(prefix))).map(async (file) => {
    const raw = file.content ?? await loadFileContent(input.token, input.book.owner, input.book.repo, file.path, input.branch).catch(() => "");
    return raw ? parseReaderEvaluation(file.path, raw, hash) : null;
  }));
  const seen = new Set<string>();
  const latest = records
    .filter((record): record is ReaderEvaluationRecord => record !== null)
    .filter((record) => record.status === "completed" && record.readerId !== "summary" && !record.stale)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .filter((record) => !seen.has(record.readerId) && Boolean(seen.add(record.readerId)));
  if (latest.length < 2) return makeAssistantMessage("assistant", "At least two current reader evaluations are needed to create a summary.");
  const summary = await generateReaderEvaluationSummary({ token: input.token, book: input.book, branch: input.branch, settings: input.settings, target, evaluations: latest, language: structure.language, signal: input.signal });
  return makeAssistantMessage("assistant", `Saved the simulated-reader summary to \`${summary.path}\`.\n\n${summary.body}`);
}

async function openReaderEvaluationsFromContext(input: PromptInput & { book: BookEntry }): Promise<AssistantMessage> {
  const chapter = resolveChapterFromPrompt(input);
  if (!chapter) return makeAssistantMessage("assistant", "Open or name a chapter first.");
  const paragraph = resolveParagraphFromPrompt(input);
  const to = paragraph
    ? `/app/books/${input.book.id}/chapters/${chapter.slug}/paragraphs/${paragraph.paragraph.number}/reader-evaluations`
    : `/app/books/${input.book.id}/chapters/${chapter.slug}/reader-evaluations`;
  return { id: crypto.randomUUID(), role: "assistant", text: "Opening reader evaluations.", action: { kind: "navigate", to, label: "Reader evaluations" } };
}

// ─── Local utility tools (no LLM) ────────────────────────────────────────────

type CanonSectionKey = "characters" | "locations" | "factions" | "items" | "secrets" | "timelines";

function slugFromPath(path: string): string {
  return path.split("/").pop()?.replace(/\.md$/, "") ?? path;
}

function canonList(structure: NonNullable<LoadedWriterContext["structure"]>, section: CanonSectionKey) {
  return structure[section];
}

/** Best-effort match of a canon file by a name/slug mentioned in the prompt. */
function findCanonFileByPrompt<T extends { path: string; name?: string }>(files: T[], prompt: string): T | null {
  const lower = prompt.toLowerCase();
  let best: { file: T; len: number } | null = null;
  for (const file of files) {
    const candidates = [file.name, slugToTitle(slugFromPath(file.path)), slugFromPath(file.path).replace(/-/g, " ")]
      .filter((value): value is string => Boolean(value && value.length >= 3));
    for (const candidate of candidates) {
      const needle = candidate.toLowerCase();
      if (lower.includes(needle) && (!best || needle.length > best.len)) best = { file, len: needle.length };
    }
  }
  return best?.file ?? null;
}

function resolveChapterFromPrompt(input: PromptInput): NonNullable<LoadedWriterContext["chapter"]> | null {
  const structure = input.context.structure;
  if (!structure) return input.context.chapter;
  const match = input.prompt.toLowerCase().match(/(?:capitolo|chapter)\s+(\d+)/);
  if (match) {
    const padded = match[1].padStart(3, "0");
    return structure.chapters.find((chapter) => chapter.slug.startsWith(`${padded}-`)) ?? input.context.chapter;
  }
  return input.context.chapter;
}

function resolveParagraphFromPrompt(input: PromptInput): { chapter: NonNullable<LoadedWriterContext["chapter"]>; paragraph: NonNullable<LoadedWriterContext["paragraph"]> } | null {
  const chapter = resolveChapterFromPrompt(input);
  if (!chapter) return null;
  const match = input.prompt.toLowerCase().match(/(?:paragrafo|paragraph|scena|scene)\s+(\d+)/);
  const paragraph = match
    ? chapter.paragraphs.find((entry) => entry.number === match[1].padStart(3, "0")) ?? null
    : input.context.paragraph;
  if (!paragraph) return null;
  return { chapter, paragraph };
}

/** Resolve the "current file" for generic body/frontmatter tools. */
function currentFilePath(input: PromptInput): { path: string; title: string } | null {
  const paragraph = resolveParagraphFromPrompt(input);
  if (paragraph) return { path: paragraph.paragraph.path, title: paragraph.paragraph.title };
  if (input.context.route.kind === "canon") {
    const path = resolveCanonPathFromRoute(input);
    if (path) return { path, title: slugToTitle(slugFromPath(path)) };
  }
  const chapter = resolveChapterFromPrompt(input);
  if (chapter) return { path: `${chapter.path}/chapter.md`, title: chapter.title };
  return null;
}

function resolveCanonPathFromRoute(input: PromptInput): string | null {
  const route = input.context.route;
  if (route.kind !== "canon") return null;
  const structure = input.context.structure;
  if (!structure) return null;
  const map: Record<string, CanonSectionKey> = {
    characters: "characters", locations: "locations", factions: "factions",
    items: "items", secrets: "secrets", timelines: "timelines",
  };
  const section = map[route.section];
  if (!section) return null;
  return canonList(structure, section).find((file) => slugFromPath(file.path) === route.slug)?.path ?? null;
}

async function resolveTargetBody(input: PromptInput, token: string): Promise<{ kind: string; title: string; body: string } | null> {
  const book = input.context.book;
  const branch = input.context.structure?.loadedBranch;
  if (!book || !branch || !token) return null;
  const paragraph = resolveParagraphFromPrompt(input);
  if (paragraph) {
    const raw = await loadFileContent(token, book.owner, book.repo, paragraph.paragraph.path, branch).catch(() => "");
    const { body } = parseMarkdown(raw);
    if (body.trim()) return { kind: "paragraph", title: paragraph.paragraph.title, body: body.trim() };
  }
  const wantsChapter = /\b(capitolo|chapter)\b/.test(input.prompt.toLowerCase());
  if (wantsChapter || (!paragraph && input.context.chapter)) {
    const chapter = resolveChapterFromPrompt(input);
    if (chapter) {
      const intro = await loadFileContent(token, book.owner, book.repo, `${chapter.path}/chapter.md`, branch).catch(() => "");
      const paragraphs = await Promise.all(chapter.paragraphs.map((entry) => loadFileContent(token, book.owner, book.repo, entry.path, branch).catch(() => "")));
      const body = [intro, ...paragraphs].map((raw) => parseMarkdown(raw).body.trim()).filter(Boolean).join("\n\n");
      if (body.trim()) return { kind: "chapter", title: chapter.title, body: body.trim() };
    }
  }
  return null;
}

async function getBookInfo(input: PromptInput & { book: BookEntry }): Promise<AssistantMessage> {
  const structure = input.context.structure;
  if (!structure) return makeAssistantMessage("assistant", "Open a book first so I can read its metadata.");
  const lines = [
    `**${structure.title}**`,
    structure.description || "",
    structure.language ? `Language: ${structure.language}` : "",
    `Chapters: ${structure.chapters.length}`,
    `Characters: ${structure.characters.length} · Locations: ${structure.locations.length} · Factions: ${structure.factions.length} · Items: ${structure.items.length} · Secrets: ${structure.secrets.length} · Timeline events: ${structure.timelines.length}`,
  ].filter(Boolean);
  return makeAssistantMessage("assistant", lines.join("\n"));
}

async function getChapterInfo(input: PromptInput & { book: BookEntry; token: string }): Promise<AssistantMessage> {
  const chapter = resolveChapterFromPrompt(input);
  if (!chapter) return makeAssistantMessage("assistant", "Open a chapter or tell me a chapter number, e.g. get chapter 3.");
  const lines = [
    `**${chapter.title}** (${chapter.slug})`,
    `Paragraphs: ${chapter.paragraphs.length}${chapter.hasResume ? " · has resume" : ""}${chapter.hasEvaluation ? " · has evaluation" : ""}`,
    ...chapter.paragraphs.map((paragraph) => `- ${paragraph.number} ${paragraph.title}`),
  ];
  return makeAssistantMessage("assistant", lines.join("\n"));
}

async function getParagraphInfo(input: PromptInput & { book: BookEntry; branch: string; token: string }): Promise<AssistantMessage> {
  const target = resolveParagraphFromPrompt(input);
  if (!target) return makeAssistantMessage("assistant", "Open a paragraph or tell me which one, e.g. get paragraph 2 of chapter 3.");
  const raw = await loadFileContent(input.token, input.book.owner, input.book.repo, target.paragraph.path, input.branch).catch(() => "");
  const { body } = parseMarkdown(raw);
  if (!body.trim()) return makeAssistantMessage("assistant", `**${target.paragraph.title}** is empty.`);
  return makeAssistantMessage("assistant", `**${target.paragraph.title}**\n\n${body.trim()}`);
}

async function getCanonEntityInfo(section: CanonSectionKey, input: PromptInput & { book: BookEntry; branch: string; token: string }): Promise<AssistantMessage> {
  const structure = input.context.structure;
  if (!structure) return makeAssistantMessage("assistant", "Open a book first.");
  const files = canonList(structure, section);
  if (!files.length) return makeAssistantMessage("assistant", `There are no ${section} in this book yet.`);
  const file = findCanonFileByPrompt(files, input.prompt) ?? (files.length === 1 ? files[0] : null);
  if (!file) {
    const names = files.slice(0, 20).map((entry) => `- ${entry.name ?? slugToTitle(slugFromPath(entry.path))}`).join("\n");
    return makeAssistantMessage("assistant", `Which one? Available ${section}:\n${names}`);
  }
  const raw = await loadFileContent(input.token, input.book.owner, input.book.repo, file.path, input.branch).catch(() => "");
  const { frontmatter, body } = parseMarkdown(raw);
  const name = file.name ?? slugToTitle(slugFromPath(file.path));
  const facts = Object.entries(frontmatter)
    .filter(([key]) => !["id", "type"].includes(key))
    .slice(0, 12)
    .map(([key, value]) => `- ${key}: ${formatFrontmatterValue(value)}`)
    .join("\n");
  const sections = [`**${name}**`, facts ? `\n${facts}` : "", body.trim() ? `\n${body.trim()}` : ""].filter(Boolean);
  return makeAssistantMessage("assistant", sections.join("\n"));
}

async function getBodyInfo(input: PromptInput & { book: BookEntry; branch: string; token: string }): Promise<AssistantMessage> {
  const current = currentFilePath(input);
  if (!current) return makeAssistantMessage("assistant", "Open a paragraph, chapter or canon entity first, or tell me which file you mean.");
  const raw = await loadFileContent(input.token, input.book.owner, input.book.repo, current.path, input.branch).catch(() => "");
  const { body } = parseMarkdown(raw);
  if (!body.trim()) return makeAssistantMessage("assistant", `**${current.title}** has no body text.`);
  return makeAssistantMessage("assistant", `**${current.title}**\n\n${body.trim()}`);
}

async function getFrontmatterInfo(input: PromptInput & { book: BookEntry; branch: string; token: string }): Promise<AssistantMessage> {
  const current = currentFilePath(input);
  if (!current) return makeAssistantMessage("assistant", "Open a paragraph, chapter or canon entity first, or tell me which file you mean.");
  const raw = await loadFileContent(input.token, input.book.owner, input.book.repo, current.path, input.branch).catch(() => "");
  const { frontmatter } = parseMarkdown(raw);
  const entries = Object.entries(frontmatter);
  if (!entries.length) return makeAssistantMessage("assistant", `**${current.title}** has no frontmatter.`);
  const lines = entries.map(([key, value]) => `- ${key}: ${formatFrontmatterValue(value)}`);
  return makeAssistantMessage("assistant", `Frontmatter of **${current.title}**:\n${lines.join("\n")}`);
}

function formatFrontmatterValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => String(item)).join(", ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value ?? "");
}

// ─── Destructive tools (return a confirmation gate, never delete directly) ────

async function requestDeleteNote(input: PromptInput & { book: BookEntry }): Promise<AssistantMessage> {
  const path = input.context.noteTargetPath;
  if (!path) return makeAssistantMessage("assistant", "There is no note file associated with this page.");
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    text: `This will delete the note file \`${path}\` (all notes it contains). Confirm to proceed.`,
    action: { kind: "confirm-delete", bookId: input.book.id, target: "note", path, title: path },
  };
}

async function requestDeleteParagraph(input: PromptInput & { book: BookEntry }): Promise<AssistantMessage> {
  const target = resolveParagraphFromPrompt(input);
  if (!target) return makeAssistantMessage("assistant", "Open the paragraph you want to delete first.");
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    text: `This will delete paragraph ${target.paragraph.number} “${target.paragraph.title}” and renumber the following paragraphs. Confirm to proceed.`,
    action: { kind: "confirm-delete", bookId: input.book.id, target: "paragraph", path: target.paragraph.path, title: target.paragraph.title, chapterSlug: target.chapter.slug },
  };
}

async function requestDeleteEntity(input: PromptInput & { book: BookEntry }): Promise<AssistantMessage> {
  const path = resolveCanonPathFromRoute(input);
  if (!path) return makeAssistantMessage("assistant", "Open the canon entity you want to delete first.");
  const title = slugToTitle(slugFromPath(path));
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    text: `This will delete the canon entity \`${path}\`. Confirm to proceed.`,
    action: { kind: "confirm-delete", bookId: input.book.id, target: "entity", path, title },
  };
}

async function createChapterFromPrompt(input: PromptInput & { book: BookEntry; branch: string; token: string }): Promise<AssistantMessage> {
  const structure = input.context.structure;
  if (!structure) return makeAssistantMessage("assistant", "Open a book first so I can create a chapter in the right repository.");
  const answer = await completeForTask(input.settings, [
    buildSystemMessage(input, 'Return ONLY JSON for a new chapter: {"title":"...","summary":"...","body":"..."}. Keep it concise and aligned with the current book context.', "book"),
    buildUserMessage(input, `Create a new chapter. Request: ${input.prompt}`),
  ], "default", { signal: input.signal, label: "copilot:create-chapter" });
  if (!answer) return noAiMessage();
  const parsed = parseJsonObject(answer);
  const title = typeof parsed?.title === "string" ? parsed.title.trim() : "New Chapter";
  const summary = typeof parsed?.summary === "string" ? parsed.summary.trim() : undefined;
  const body = typeof parsed?.body === "string" ? parsed.body.trim() : undefined;
  const nextNumber = (structure.chapters.length || 0) + 1;
  const created = await createChapter(input.token, input.book.owner, input.book.repo, input.branch, { number: nextNumber, title, summary, body });
  return makeAssistantMessage("assistant", `I created chapter ${created.slug} at \`${created.chapterFilePath}\`.`);
}

async function createParagraphFromPrompt(input: PromptInput & { book: BookEntry; branch: string; token: string }): Promise<AssistantMessage> {
  const chapter = input.context.chapter;
  if (!chapter) return makeAssistantMessage("assistant", "Open a chapter first so I know where to create the paragraph.");
  const answer = await completeForTask(input.settings, [
    buildSystemMessage(input, 'Return ONLY JSON for a new paragraph: {"title":"...","summary":"...","body":"..."}. Preserve current chapter context.', "book"),
    buildUserMessage(input, `Create a new paragraph in chapter ${chapter.slug}. Request: ${input.prompt}`),
  ], "default", { signal: input.signal, label: "copilot:create-paragraph" });
  if (!answer) return noAiMessage();
  const parsed = parseJsonObject(answer);
  const title = typeof parsed?.title === "string" ? parsed.title.trim() : "New Paragraph";
  const summary = typeof parsed?.summary === "string" ? parsed.summary.trim() : undefined;
  const body = typeof parsed?.body === "string" ? parsed.body.trim() : undefined;
  const nextNumber = (chapter.paragraphs.length || 0) + 1;
  const created = await createParagraphDocument(input.token, input.book.owner, input.book.repo, input.branch, { chapterSlug: chapter.slug, number: nextNumber, title, summary, body });
  return makeAssistantMessage("assistant", `I created paragraph ${created.slug} at \`${created.paragraphFilePath}\`.`);
}

async function createEntityFromPrompt(input: PromptInput & { book: BookEntry; branch: string; token: string }): Promise<AssistantMessage> {
  const kind = detectEntityKind(input.prompt);
  if (!kind) return makeAssistantMessage("assistant", "Tell me which entity to create: character, location, faction, item, secret, or timeline event.");
  const answer = await completeForTask(input.settings, [
    buildSystemMessage(input, 'Return ONLY JSON for a new canon entity: {"label":"...","summary":"...","body":"...","extraFrontmatter":{...}}.', "book"),
    buildUserMessage(input, `Create a ${kind}. Request: ${input.prompt}`),
  ], "default", { signal: input.signal, label: "copilot:create-entity" });
  if (!answer) return noAiMessage();
  const parsed = parseJsonObject(answer);
  const label = typeof parsed?.label === "string" ? parsed.label.trim() : `New ${kind}`;
  const summary = typeof parsed?.summary === "string" ? parsed.summary.trim() : undefined;
  const body = typeof parsed?.body === "string" ? parsed.body.trim() : undefined;
  const extraFrontmatter = parsed && typeof parsed.extraFrontmatter === "object" && !Array.isArray(parsed.extraFrontmatter)
    ? (parsed.extraFrontmatter as Record<string, unknown>)
    : undefined;
  const created = await createCanonEntity(input.token, input.book.owner, input.book.repo, input.branch, { kind, label, summary, body, extraFrontmatter });
  return makeAssistantMessage("assistant", `I created ${kind} \`${label}\` at \`${created.path}\`.`);
}

async function createScriptFromPrompt(input: PromptInput & { book: BookEntry; branch: string; token: string }): Promise<AssistantMessage> {
  const chapter = input.context.chapter;
  if (!chapter) return makeAssistantMessage("assistant", "Open a chapter first so I know where to create the script.");
  const answer = await completeForTask(input.settings, [
    buildSystemMessage(input, 'Return ONLY JSON for a new script scene: {"title":"...","location":"..."}.'),
    buildUserMessage(input, `Create a new scene script in chapter ${chapter.slug}. Request: ${input.prompt}`),
  ], "default", { signal: input.signal, label: "copilot:create-script" });
  if (!answer) return noAiMessage();
  const parsed = parseJsonObject(answer);
  const title = typeof parsed?.title === "string" ? parsed.title.trim() : "New Scene";
  const location = typeof parsed?.location === "string" ? parsed.location.trim() : undefined;
  const nextNumber = input.context.paragraph ? Number(input.context.paragraph.number) : (chapter.paragraphs.length || 0) + 1;
  await createParagraphScriptArtifact(input.token, input.book.owner, input.book.repo, input.branch, { chapterSlug: chapter.slug, number: nextNumber, title, location });
  return makeAssistantMessage("assistant", `I created a script for \`${title}\` in chapter \`${chapter.slug}\`.`);
}

async function createDraftFromPrompt(input: PromptInput & { book: BookEntry; branch: string; token: string }): Promise<AssistantMessage> {
  if (input.context.chapter) {
    if (input.context.paragraph) {
      await createParagraphDraftArtifact(input.token, input.book.owner, input.book.repo, input.branch, { chapterSlug: input.context.chapter.slug, number: Number(input.context.paragraph.number), title: input.context.paragraph.title });
      return makeAssistantMessage("assistant", `I created a paragraph draft for \`${input.context.paragraph.title}\`.`);
    }
    const match = /^(\d{3})-/.exec(input.context.chapter.slug);
    const number = Number(match?.[1] ?? 1);
    await createChapterDraftArtifacts(input.token, input.book.owner, input.book.repo, input.branch, { number, title: input.context.chapter.title });
    return makeAssistantMessage("assistant", `I created a chapter draft workspace for \`${input.context.chapter.title}\`.`);
  }
  return makeAssistantMessage("assistant", "Open a chapter or paragraph first so I know which draft workspace to create.");
}

async function importAttachmentsIntoBook(input: PromptInput & { book: BookEntry; branch: string; token: string }): Promise<AssistantMessage> {
  if (!input.attachments.length) return makeAssistantMessage("assistant", "Attach at least one file first.");
  const lowered = input.prompt.toLowerCase();
  const prompt = `${input.prompt}\n\nUse the attached files as source material.`;
  if (/(note|notes|appunto|appunti)/.test(lowered)) return createContextNote({ ...input, prompt });
  if (/(character|location|faction|item|secret|timeline|evento)/.test(lowered)) return createEntityFromPrompt({ ...input, prompt });
  if (/(chapter|capitolo)/.test(lowered)) return createChapterFromPrompt({ ...input, prompt });
  return createParagraphFromPrompt({ ...input, prompt });
}

async function writeResume(input: PromptInput & { book: BookEntry; branch: string; token: string }): Promise<AssistantMessage> {
  const chapter = input.context.chapter;
  if (!chapter) return makeAssistantMessage("assistant", "Resume writing works when you are inside a chapter or one of its paragraph/workspace pages.");
  const targetPath = `resumes/chapters/${chapter.slug}.md`;
  const answer = await completeForTask(input.settings, [
    buildSystemMessage(input, "Write a chapter resume suitable for the chapter resume file. Preserve chronology and visible canon. Return only the markdown body, no frontmatter.", "book"),
    buildUserMessage(input, `Write or refresh the resume for chapter ${chapter.slug}. Request: ${input.prompt}`),
  ], "default", { signal: input.signal, label: "copilot:write-resume" });
  if (!answer) return noAiMessage();
  await upsertStructuredMarkdownFile({ token: input.token, owner: input.book.owner, repo: input.book.repo, branch: input.branch, path: targetPath, frontmatter: { type: "resume", id: `resume:chapter:${chapter.slug}`, title: `Resume ${chapter.slug}` }, body: answer.trim(), message: `Update chapter resume ${chapter.slug}` });
  return makeAssistantMessage("assistant", `I wrote the chapter resume to \`${targetPath}\`.\n\n${answer.trim()}`);
}

async function ensureEvaluationGuidelines(input: { token: string; owner: string; repo: string; branch: string; language?: string }): Promise<string> {
  try {
    return await loadFileContent(input.token, input.owner, input.repo, EVALUATION_GUIDELINES_PATH, input.branch);
  } catch {
    const fallback = defaultEvaluationGuidelinesMarkdown(input.language);
    await createFile(input.token, input.owner, input.repo, input.branch, EVALUATION_GUIDELINES_PATH, fallback, "Add default evaluation guidelines").catch(() => undefined);
    return fallback;
  }
}

export type EvaluationCriterionScore = { score: number; explanation: string };

export function extractEvaluationCriteria(guidelinesRaw: string): Record<string, string> {
  const parsed = parseMarkdown(guidelinesRaw);
  const criteria = parsed.frontmatter.criteria;
  if (!criteria || typeof criteria !== "object" || Array.isArray(criteria)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(criteria as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
    else if (value && typeof value === "object" && typeof (value as Record<string, unknown>).description === "string") out[key] = ((value as Record<string, unknown>).description as string).trim();
  }
  return out;
}

export function resolveEvaluationCriteria(guidelinesRaw: string, language?: string): Record<string, string> {
  const criteria = extractEvaluationCriteria(guidelinesRaw);
  return Object.keys(criteria).length ? criteria : defaultEvaluationCriteria(language);
}

function openAiBaseUrlForIntegration(bookIntegration: { provider: string; endpoint?: string }): string {
  return bookIntegration.provider === "github_models" ? GITHUB_MODELS_INFERENCE_URL : (bookIntegration.endpoint || "https://api.openai.com/v1");
}

async function scoreEvaluationWithTool(
  integration: { provider: string; endpoint?: string; apiKey: string; apiVersion?: string },
  model: string,
  prompt: string,
  criteria: Record<string, string>,
): Promise<Record<string, EvaluationCriterionScore>> {
  const toolSchema = {
    type: "object",
    properties: {
      criteria: {
        type: "object",
        properties: Object.fromEntries(Object.entries(criteria).map(([key, description]) => [key, {
          type: "object",
          description,
          properties: {
            score: { type: "number", minimum: 0, maximum: 10 },
            explanation: { type: "string", description: `Short reason for the score of ${key}.` },
          },
          required: ["score", "explanation"],
          additionalProperties: false,
        }])),
        required: Object.keys(criteria),
        additionalProperties: false,
      },
    },
    required: ["criteria"],
    additionalProperties: false,
  };

  const client = integration.provider === "azure_openai"
    ? new AzureOpenAI({ endpoint: integration.endpoint ?? "", apiKey: integration.apiKey, apiVersion: integration.apiVersion || "2024-10-21", dangerouslyAllowBrowser: true })
    : new OpenAI({ apiKey: integration.apiKey, baseURL: openAiBaseUrlForIntegration(integration), dangerouslyAllowBrowser: true });

  const response = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: prompt }],
    tools: [{
      type: "function",
      function: {
        name: "set_scores",
        description: "Return critical numeric evaluation scores with a short reason for each criterion.",
        parameters: toolSchema as never,
      },
    }],
    tool_choice: { type: "function", function: { name: "set_scores" } },
  } as never);

  const call = (response as { choices?: Array<{ message?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }> }).choices?.[0]?.message?.tool_calls?.[0];
  const args = call?.function?.arguments ? JSON.parse(call.function.arguments) as { criteria?: Record<string, { score?: number; explanation?: string }> } : null;
  const scored = args?.criteria ?? {};
  const out: Record<string, EvaluationCriterionScore> = {};
  for (const [key, description] of Object.entries(criteria)) {
    const entry = scored[key];
    out[key] = {
      score: typeof entry?.score === "number" ? Math.max(0, Math.min(10, entry.score)) : 0,
      explanation: typeof entry?.explanation === "string" && entry.explanation.trim() ? entry.explanation.trim() : description,
    };
  }
  return out;
}

export async function scoreEvaluationRouted(settings: AppSettings, prompt: string, criteria: Record<string, string>): Promise<Record<string, EvaluationCriterionScore> | null> {
  if (!Object.keys(criteria).length) return null;
  const candidates = resolveTaskCandidates(settings, "review");
  let lastError: unknown = null;
  for (const candidate of candidates) {
    if (!candidate.integration || !candidate.model) continue;
    try {
      return await scoreEvaluationWithTool(candidate.integration, candidate.model, prompt, criteria);
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) throw lastError;
  return null;
}

async function resolveEvaluationTarget(input: PromptInput & { book: BookEntry; branch: string; token: string }): Promise<
  | { kind: "paragraph"; chapterSlug: string; title: string; targetPath: string; body: string; fileFrontmatter: Record<string, unknown> }
  | { kind: "chapter"; chapterSlug: string; title: string; targetPath: string; body: string; fileFrontmatter: Record<string, unknown> }
  | null
> {
  const lower = input.prompt.toLowerCase();
  const explicitParagraph = /(?:paragrafo|paragraph|scena|scene)\s+\d+/.test(lower);
  const explicitChapterOnly = /(?:capitolo|chapter)\s+\d+/.test(lower) && !explicitParagraph;

  const paragraphTarget = resolveParagraphFromPrompt(input);
  if (paragraphTarget && (explicitParagraph || (input.context.paragraph && !explicitChapterOnly))) {
    const raw = await loadFileContent(input.token, input.book.owner, input.book.repo, paragraphTarget.paragraph.path, input.branch).catch(() => "");
    const parsed = parseMarkdown(raw);
    const paragraphSlug = paragraphTarget.paragraph.path.split("/").pop()?.replace(/\.md$/i, "") ?? paragraphTarget.paragraph.number;
    return {
      kind: "paragraph",
      chapterSlug: paragraphTarget.chapter.slug,
      title: paragraphTarget.paragraph.title,
      targetPath: `evaluations/paragraphs/${paragraphTarget.chapter.slug}/${paragraphSlug}.md`,
      body: parsed.body.trim(),
      fileFrontmatter: parsed.frontmatter,
    };
  }

  const chapter = resolveChapterFromPrompt(input);
  if (!chapter) return null;
  const introRaw = await loadFileContent(input.token, input.book.owner, input.book.repo, `${chapter.path}/chapter.md`, input.branch).catch(() => "");
  const introParsed = parseMarkdown(introRaw);
  const paragraphRaws = await Promise.all(chapter.paragraphs.map((entry) => loadFileContent(input.token, input.book.owner, input.book.repo, entry.path, input.branch).catch(() => "")));
  const body = [
    introParsed.body.trim(),
    ...paragraphRaws.map((raw, index) => {
      const parsed = parseMarkdown(raw);
      const title = chapter.paragraphs[index]?.title;
      return parsed.body.trim() ? `### ${title}\n\n${parsed.body.trim()}` : "";
    }),
  ].filter(Boolean).join("\n\n");
  return {
    kind: "chapter",
    chapterSlug: chapter.slug,
    title: chapter.title,
    targetPath: `evaluations/chapters/${chapter.slug}.md`,
    body,
    fileFrontmatter: introParsed.frontmatter,
  };
}

type ResolvedEvaluationTarget = NonNullable<Awaited<ReturnType<typeof resolveEvaluationTarget>>>;

async function evaluateAndWriteTarget(
  input: PromptInput & { book: BookEntry; branch: string; token: string },
  target: ResolvedEvaluationTarget,
  guidelines: string,
  criteria: Record<string, string>,
): Promise<{ answer: string; path: string }> {
  const targetLabel = target.kind === "paragraph" ? `paragraph in chapter ${target.chapterSlug}` : `chapter ${target.chapterSlug}`;
  const evaluationPayload = [
    `Write or refresh the evaluation for ${targetLabel}. Request: ${input.prompt}`,
    "",
    `Evaluation guidelines (${EVALUATION_GUIDELINES_PATH}):`,
    guidelines.trim(),
    "",
    `Target title: ${target.title}`,
    `Target kind: ${target.kind}`,
    `Target frontmatter: ${JSON.stringify(target.fileFrontmatter, null, 2)}`,
    "",
    "Target body:",
    target.body || "(empty)",
  ].join("\n");
  const answer = await completeForTask(input.settings, [
    buildSystemMessage(
      input,
      "You write Narrarium evaluation files. Follow the provided evaluation-guidelines.md as the evaluation contract. Use its structure, priorities, and sections unless the user explicitly asks otherwise. Be genuinely critical: do not hand out comforting praise, do not soften real flaws, and do not inflate scores implicitly in the prose. Surface weaknesses clearly and precisely. Return only the markdown body, no frontmatter, no code fences, no wrapper commentary.",
      "book",
    ),
    buildUserMessage(input, evaluationPayload),
  ], "review", { signal: input.signal, label: target.kind === "paragraph" ? "copilot:write-paragraph-evaluation" : "copilot:write-chapter-evaluation" });
  if (!answer) throw new Error("No AI integration configured for evaluation.");
  const scorePrompt = [
    "You must assign critical scores from 0 to 10 for each criterion.",
    "Do not be lenient. A high score requires clearly sustained excellence in the actual text.",
    "Give each criterion a short explanation tied to the evidence in the text.",
    "",
    evaluationPayload,
  ].join("\n");
  const scores = await scoreEvaluationRouted(input.settings, scorePrompt, criteria);

  const frontmatter = target.kind === "paragraph"
    ? {
        type: "evaluation",
        id: `evaluation:paragraph:${target.chapterSlug}:${target.targetPath.split("/").pop()?.replace(/\.md$/i, "") ?? "unknown"}`,
        title: `Evaluation ${target.chapterSlug} ${target.title}`,
        chapter: `chapter:${target.chapterSlug}`,
        paragraph: `paragraph:${target.chapterSlug}:${target.targetPath.split("/").pop()?.replace(/\.md$/i, "") ?? "unknown"}`,
        ...(scores ? { scores } : {}),
      }
    : {
        type: "evaluation",
        id: `evaluation:chapter:${target.chapterSlug}`,
        title: `Evaluation ${target.chapterSlug}`,
        ...(scores ? { scores } : {}),
      };

  await upsertStructuredMarkdownFile({
    token: input.token,
    owner: input.book.owner,
    repo: input.book.repo,
    branch: input.branch,
    path: target.targetPath,
    frontmatter,
    body: answer.trim(),
    message: `Update ${target.kind} evaluation ${target.chapterSlug}`,
  });
  return { answer: answer.trim(), path: target.targetPath };
}

async function writeAllParagraphEvaluations(input: PromptInput & { book: BookEntry; branch: string; token: string }): Promise<AssistantMessage> {
  const chapter = resolveChapterFromPrompt(input);
  if (!chapter) return makeAssistantMessage("assistant", "Tell me which chapter to evaluate, for example: evaluate all paragraphs of chapter 1.");
  if (!chapter.paragraphs.length) return makeAssistantMessage("assistant", `Chapter \`${chapter.slug}\` has no paragraphs to evaluate.`);

  const language = input.context.structure?.language;
  const guidelines = await ensureEvaluationGuidelines({ token: input.token, owner: input.book.owner, repo: input.book.repo, branch: input.branch, language });
  const criteria = resolveEvaluationCriteria(guidelines, language);
  const italian = /\b(tutti|paragraf|capitolo|valutazione|scene)\b/i.test(input.prompt);
  const paragraphBodies: Array<{ title: string; body: string }> = [];
  const paths: string[] = [];

  for (let index = 0; index < chapter.paragraphs.length; index++) {
    const paragraph = chapter.paragraphs[index];
    input.onText?.(italian
      ? `Sto valutando il paragrafo ${index + 1} di ${chapter.paragraphs.length}: **${paragraph.title}**…`
      : `Evaluating paragraph ${index + 1} of ${chapter.paragraphs.length}: **${paragraph.title}**…`);
    const raw = await loadFileContent(input.token, input.book.owner, input.book.repo, paragraph.path, input.branch).catch(() => "");
    const parsed = parseMarkdown(raw);
    const slug = paragraph.path.split("/").pop()?.replace(/\.md$/i, "") ?? paragraph.number;
    const target: ResolvedEvaluationTarget = {
      kind: "paragraph",
      chapterSlug: chapter.slug,
      title: paragraph.title,
      targetPath: `evaluations/paragraphs/${chapter.slug}/${slug}.md`,
      body: parsed.body.trim(),
      fileFrontmatter: parsed.frontmatter,
    };
    const result = await evaluateAndWriteTarget(input, target, guidelines, criteria);
    paths.push(result.path);
    paragraphBodies.push({ title: paragraph.title, body: parsed.body.trim() });
  }

  input.onText?.(italian
    ? `Ho completato ${chapter.paragraphs.length} valutazioni. Ora preparo la valutazione complessiva del capitolo…`
    : `Completed ${chapter.paragraphs.length} paragraph evaluations. Now preparing the overall chapter evaluation…`);
  const chapterRaw = await loadFileContent(input.token, input.book.owner, input.book.repo, `${chapter.path}/chapter.md`, input.branch).catch(() => "");
  const chapterParsed = parseMarkdown(chapterRaw);
  const chapterTarget: ResolvedEvaluationTarget = {
    kind: "chapter",
    chapterSlug: chapter.slug,
    title: chapter.title,
    targetPath: `evaluations/chapters/${chapter.slug}.md`,
    body: [chapterParsed.body.trim(), ...paragraphBodies.map((paragraph) => `### ${paragraph.title}\n\n${paragraph.body}`)].filter(Boolean).join("\n\n"),
    fileFrontmatter: chapterParsed.frontmatter,
  };
  const total = await evaluateAndWriteTarget(input, chapterTarget, guidelines, criteria);
  paths.push(total.path);

  const intro = italian
    ? `Ho valutato tutti i ${chapter.paragraphs.length} paragrafi del capitolo e salvato anche la valutazione complessiva.`
    : `I evaluated all ${chapter.paragraphs.length} paragraphs and saved the overall chapter evaluation.`;
  return makeAssistantMessage("assistant", `${intro}\n\n${total.answer}\n\n${paths.map((path) => `- \`${path}\``).join("\n")}`);
}

async function writeEvaluation(input: PromptInput & { book: BookEntry; branch: string; token: string }): Promise<AssistantMessage> {
  const target = await resolveEvaluationTarget(input);
  if (!target) return makeAssistantMessage("assistant", "Tell me which chapter or paragraph to evaluate, for example: evaluate chapter 1 or evaluate paragraph 2 of chapter 1.");
  const guidelines = await ensureEvaluationGuidelines({ token: input.token, owner: input.book.owner, repo: input.book.repo, branch: input.branch, language: input.context.structure?.language });
  const criteria = resolveEvaluationCriteria(guidelines, input.context.structure?.language);
  const result = await evaluateAndWriteTarget(input, target, guidelines, criteria);
  return makeAssistantMessage("assistant", `I wrote the ${target.kind} evaluation to \`${result.path}\`.\n\n${result.answer}`);
}

async function writePlotUpdate(input: PromptInput & { book: BookEntry; branch: string; token: string }): Promise<AssistantMessage> {
  const answer = await completeForTask(input.settings, [
    buildSystemMessage(input, "Update the book plot document in markdown. Keep it concise, structural, and consistent with the loaded canon. Return only the body, no frontmatter.", "book"),
    buildUserMessage(input, `Refresh plot.md for this book. Request: ${input.prompt}`),
  ], "default", { signal: input.signal, label: "copilot:update-plot" });
  if (!answer) return noAiMessage();
  await upsertStructuredMarkdownFile({ token: input.token, owner: input.book.owner, repo: input.book.repo, branch: input.branch, path: "plot.md", frontmatter: { type: "plot", id: "plot:main", title: "Plot" }, body: answer.trim(), message: "Update plot.md" });
  return makeAssistantMessage("assistant", `I updated \`plot.md\`.\n\n${answer.trim()}`);
}

async function rewriteCurrentParagraph(input: PromptInput & { book: BookEntry; branch: string; token: string }): Promise<AssistantMessage> {
  const { context } = input;
  if (!context.paragraph || !context.chapter) return makeAssistantMessage("assistant", "Paragraph rewrite works when you are inside a paragraph page. Open a paragraph first, then ask me to revise it.");
  const paragraphFile = context.relevantFiles.find((entry) => entry.path === context.paragraph?.path);
  const paragraphBody = paragraphFile ? parseMarkdown(paragraphFile.content).body : "";
  const answer = await completeForTask(input.settings, [
    buildSystemMessage(input, "You are Narrarium's prose editor. Rewrite only the paragraph body. Preserve facts, chronology, names, and visible canon. Return only the revised paragraph body, no markdown fences, no commentary. Use any loaded writing-style files if present.", "book"),
    buildUserMessage(input, `Current paragraph body:\n${paragraphBody}\n\nRewrite request: ${input.prompt}`),
  ], "default", { signal: input.signal, label: "copilot:rewrite-paragraph" });
  if (!answer) return noAiMessage();
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    text: `I prepared a revised version of the current paragraph. Review it below and apply it if you want.\n\n${answer.trim()}`,
    action: { kind: "apply-paragraph-rewrite", bookId: input.book.id, chapterSlug: context.chapter.slug, paragraphPath: context.paragraph.path, proposedBody: answer.trim() },
  };
}

async function proposeMultiFileUpdates(input: PromptInput & { book: BookEntry; token: string }): Promise<AssistantMessage> {
  const answer = await completeForTask(input.settings, [
    buildSystemMessage(input, 'You are Narrarium file editor. Propose multi-file changes only for files in the available manifest or obvious notes/workspace files. Return ONLY JSON: {"summary":"...","updates":[{"path":"relative/path.md","content":"FULL NEW FILE CONTENT","reason":"..."}]}. Do not wrap in markdown.'),
    buildUserMessage(input, `User multi-file request: ${input.prompt}`),
  ], "default", { signal: input.signal, label: "copilot:multi-file-edit" });
  if (!answer) return noAiMessage();
  const parsed = parseJsonObject(answer);
  const updates = Array.isArray(parsed?.updates)
    ? parsed.updates.filter((entry): entry is { path: string; content: string; reason?: string } => typeof entry?.path === "string" && typeof entry?.content === "string" && isSafeRelativePath(entry.path)).slice(0, 8)
    : [];
  if (!updates.length) return makeAssistantMessage("assistant", `I could not extract a safe multi-file update plan from the model response. Raw response:\n\n${answer.trim()}`);
  const summary = typeof parsed?.summary === "string" ? parsed.summary : "Multi-file update proposal";
  return { id: crypto.randomUUID(), role: "assistant", text: `${summary}\n\nProposed files:\n${updates.map((entry) => `- ${entry.path}${entry.reason ? `: ${entry.reason}` : ""}`).join("\n")}`, action: { kind: "apply-file-updates", bookId: input.book.id, updates } };
}

async function createContextNote(input: PromptInput & { book: BookEntry; branch: string; token: string }): Promise<AssistantMessage> {
  const targetPath = input.context.noteTargetPath;
  if (!targetPath) return makeAssistantMessage("assistant", "I could not determine where to save a note from the current screen.");
  const answer = await completeForTask(input.settings, [
    buildSystemMessage(input, "You create concise writer notes for the current context. Return only the note body in markdown, no frontmatter and no wrapping commentary."),
    buildUserMessage(input, `Create a note for this request: ${input.prompt}`),
  ], "default", { signal: input.signal, label: "copilot:create-note" });
  if (!answer) return noAiMessage();
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
  const canonSections = [["characters", structure.characters], ["locations", structure.locations], ["factions", structure.factions], ["items", structure.items], ["secrets", structure.secrets], ["timelines", structure.timelines]] as const;
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

async function upsertStructuredMarkdownFile(input: { token: string; owner: string; repo: string; branch: string; path: string; frontmatter: Record<string, unknown>; body: string; message: string }) {
  try {
    const existing = await readFileWithSha(input.token, input.owner, input.repo, input.branch, input.path);
    await updateFile(input.token, input.owner, input.repo, input.branch, input.path, existing.sha, renderMarkdown(input.frontmatter, `${input.body.trim()}\n`), input.message);
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
  } catch {
    const frontmatter = input.path === "notes.md"
      ? { type: "note", id: "note:book:notes", title: input.title, scope: "book", bucket: "notes", entries: [] }
      : chapterDraftNoteFrontmatter(input.path, input.title);
    await createFile(input.token, input.owner, input.repo, input.branch, input.path, renderMarkdown(frontmatter, section), `Add notes ${input.path}`);
  }
}

export async function appendAssistantNote(input: { token: string; owner: string; repo: string; branch: string; path: string; title?: string; noteBody: string }) {
  await upsertNoteFile({
    token: input.token,
    owner: input.owner,
    repo: input.repo,
    branch: input.branch,
    path: input.path,
    title: input.title ?? defaultNoteTitle(input.path),
    noteBody: input.noteBody,
  });
}

function buildSystemMessage(input: PromptInput, instruction: string, taskLanguage?: "book" | "user"): LlmMessage {
  const spokenInstruction = input.spokenMode
    ? "\n\nThis answer will be read aloud. Be conversational, direct, and natural. Use short spoken paragraphs. Avoid tables, dense markdown, long lists, code blocks, and anything that is hard to understand through audio. If you need to list things, use a few concise spoken points."
    : "";
  return { role: "system", content: `${instruction}${spokenInstruction}${languageInstruction(input, taskLanguage)}\n\n${systemContextBundle(input)}` };
}

function languageInstruction(input: PromptInput, taskLanguage?: "book" | "user"): string {
  // For book-content tasks (resume, evaluation, rewrite, entity creation),
  // enforce the book language when it is set so all generated content stays
  // consistent with the book's target language.
  // For copilot (conversational assistant), respond in the language the user writes.
  const bookLang = input.context.structure?.language;
  if (taskLanguage === "book" && bookLang) {
    return `\n\nAlways generate all content in the language of this book: "${bookLang}". This includes the markdown body, headings, and all prose. Conversational replies to the user can mirror the user's message language. Quoted prose from the book must keep its original language.`;
  }
  if (taskLanguage === "user") {
    return `\n\nRespond in the same language the user writes to you. For any book content you generate (bodies, summaries, prose), use the book language: "${bookLang ?? (input.settings.ui.language === "it" ? "it" : "en")}". Quoted prose must keep its original language.`;
  }
  // Default fallback (general assistant / copilot): mirror user language
  return `\n\nRespond in the same language the user writes to you. For any book content you generate, match the book language when you can detect it from context. Quoted prose from the book must keep its original language.`;
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

function detectEntityKind(prompt: string): EntityKind | null {
  const lowered = prompt.toLowerCase();
  if (/(character|personaggio)/.test(lowered)) return "character";
  if (/(location|luogo)/.test(lowered)) return "location";
  if (/(faction|fazione)/.test(lowered)) return "faction";
  if (/(item|oggetto)/.test(lowered)) return "item";
  if (/(secret|segreto)/.test(lowered)) return "secret";
  if (/(timeline|event|evento)/.test(lowered)) return "timeline-event";
  return null;
}

function detectSectionHint(prompt: string): "characters" | "paragraphs" | "canon" | null {
  const lowered = prompt.toLowerCase();
  if (/\b(character|characters|personaggio|personaggi)\b/.test(lowered)) return "characters";
  if (/\b(paragraph|paragraphs|paragrafo|paragrafi|scene|scena)\b/.test(lowered)) return "paragraphs";
  if (/\b(canon|entity|entities|lore)\b/.test(lowered)) return "canon";
  return null;
}

function looksLikeSummary(prompt: string): boolean { return /\b(summary|summar|riassunt|recap|overview)\b/.test(prompt); }
function looksLikeBranchSwitch(prompt: string): boolean { return /\b(branch)\b/.test(prompt) && /\b(switch|checkout|go to|usa il branch|vai sul branch|cambia branch|create|crea|new)\b/.test(prompt); }
function looksLikeWriteResume(prompt: string): boolean { return /\b(resume|riassunto)\b/.test(prompt) && /\b(write|save|refresh|aggiorna|scrivi|salva|crea)\b/.test(prompt); }
function looksLikeUpdatePlot(prompt: string): boolean { return /\b(plot)\b/.test(prompt) && /\b(update|refresh|aggiorna|scrivi|salva|sync)\b/.test(prompt); }
function looksLikeReview(prompt: string): boolean { return /\b(review|critique|feedback|editorial|analy[sz]e|valuta|reviewa)\b/.test(prompt); }
function looksLikeNote(prompt: string): boolean { return /\b(note|notes|appunto|appunti|memo)\b/.test(prompt); }
function looksLikeRewrite(prompt: string): boolean { return /\b(rewrite|revise|fix|improve|polish|sistema|riscrivi|migliora|paragrafo)\b/.test(prompt); }
function looksLikeSearch(prompt: string): boolean { return /\b(search|find|lookup|cerca|trova|keyword|keywords|search for)\b/.test(prompt); }
function looksLikeCreateChapter(prompt: string): boolean { return /\b(create|add|crea|aggiungi)\b/.test(prompt) && /\b(chapter|capitolo)\b/.test(prompt); }
function looksLikeCreateParagraph(prompt: string): boolean { return /\b(create|add|crea|aggiungi)\b/.test(prompt) && /\b(paragraph|paragrafo|scene|scena)\b/.test(prompt); }
function looksLikeCreateEntity(prompt: string): boolean { return /\b(create|add|crea|aggiungi)\b/.test(prompt) && /\b(character|personaggio|location|luogo|faction|fazione|item|oggetto|secret|segreto|timeline|evento)\b/.test(prompt); }
function looksLikeCreateScript(prompt: string): boolean { return /\b(create|add|crea|aggiungi)\b/.test(prompt) && /\b(script|scene script|scaletta scena)\b/.test(prompt); }
function looksLikeCreateDraft(prompt: string): boolean { return /\b(create|add|crea|aggiungi)\b/.test(prompt) && /\b(draft|bozza)\b/.test(prompt); }
function looksLikeImportAttachment(prompt: string): boolean { return /\b(import|attachment|allega|usa allegat|mettilo come|mettilo nel libro)\b/.test(prompt); }
function looksLikeMultiFileEdit(prompt: string): boolean { return /\b(multi[- ]?file|piu file|più file|several files|update files|modifica.*file|aggiorna.*file)\b/.test(prompt); }

function parseJsonObject(value: string): Record<string, unknown> | null {
  const trimmed = value.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function extractBranchName(prompt: string): string | null {
  const match = /(?:branch\s+)([A-Za-z0-9._/-]+)/i.exec(prompt);
  return match?.[1] ?? null;
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
