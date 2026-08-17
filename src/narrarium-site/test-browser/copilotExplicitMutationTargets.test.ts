import { describe, expect, it } from "vitest";
import { runAssistantPrompt } from "@/assistant/service";
import { DEFAULT_SETTINGS, type AppSettings, type BookEntry } from "@/types/settings";
import type { LoadedWriterContext } from "@/assistant/context";

const chapter = { slug: "001-current", title: "Current", path: "chapters/001-current", paragraphs: [{ number: "001", title: "Scene", path: "chapters/001-current/001-scene.md" }] };
const book = { id: "book", name: "Book", owner: "owner", repo: "repo", tokenIndex: null, addedAt: "now" } satisfies BookEntry;
const context = {
  route: { kind: "paragraph", bookId: "book", chapterId: chapter.slug, paragraphNum: "001" },
  branchReady: true,
  branch: "main",
  book,
  structure: { defaultBranch: "main", chapters: [chapter], researchFiles: [], readerEvaluationFiles: [] },
  chapter,
  paragraph: chapter.paragraphs[0],
  relevantFiles: [],
  availableFiles: [],
  loadedFilePaths: [],
} as unknown as LoadedWriterContext;
const settings = {
  ...DEFAULT_SETTINGS,
  aiIntegrations: [{ id: "ai", name: "AI", provider: "openai", apiKey: "key", chatModels: [{ id: "model", name: "model", capabilities: ["default", "chat-resume"] }] }],
} as AppSettings;

function prompt(text: string) {
  return runAssistantPrompt({ prompt: text, context, settings, book, branch: "main", token: "token", history: [], compactSummary: "", compactedMessageCount: 0, attachments: [], accountScope: null });
}

describe("explicit mutation targets", () => {
  it.each([
    "create a paragraph in chapter 99",
    "create a script in chapter 99",
    "create a draft for chapter 99",
    "write the resume for chapter 99",
  ])("never falls back to the ambient chapter: %s", async (request) => {
    const message = await prompt(request);
    expect(message.text).toContain("could not find the requested chapter");
    expect(message.mutation).toBeUndefined();
    expect(message.action).toBeUndefined();
  });
});
