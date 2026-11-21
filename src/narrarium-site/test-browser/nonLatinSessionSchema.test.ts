import { describe, expect, it } from "vitest";
import { parseAssistantSession, parseAssistantSessionJson, serializeAssistantSession } from "@/assistant/sessionSchema";

const session = (action: Record<string, unknown>) => ({
  id: "session-1", title: "Chat", contextTitle: "Book", updatedAt: "2026-11-21T10:00:00.000Z", attachments: [],
  messages: [{ id: "message-1", role: "assistant", text: "Proposal", action }],
});

const provenance = { toolId: "rewrite-current-paragraph", owner: "writer", repo: "novel", branch: "main", sourceRevision: "head1", sourceRevisions: {}, generatedAt: "2026-11-21T10:00:00.000Z" };

const rewrite = (chapterSlug: string, paragraphPath: string) => ({ ...provenance, kind: "apply-paragraph-rewrite", bookId: "book-1", chapterSlug, paragraphPath, proposedBody: "New text." });
const deleteParagraph = (chapterSlug: string, path: string) => ({ ...provenance, toolId: "delete-current-paragraph", kind: "confirm-delete", bookId: "book-1", target: "paragraph", path, title: "Scene", chapterSlug });
const cancel = (chapterSlug: string, paragraphSlug: string) => ({ ...provenance, toolId: "cancel-feedback-rewrite", kind: "confirm-cancel-feedback-rewrite", bookId: "book-1", operationId: "operation-1", scope: "paragraph", chapterSlug, paragraphSlug, workflowRequestId: 1, ownerSessionId: "session-1", ownerRequestId: "request-1" });

describe("a chat that proposes changes to chapters and scenes with names in any script", () => {
  it.each([
    ["001-глава-первая", "001-тихая-гавань"],
    ["002-海辺の朝", "001-朝の港"],
    ["003-chapter", "001-scene"],
    ["001-the-gate", "001-arrival"],
    ["004-Ελληνικά", "001-الميناء"],
  ])("keeps its pending actions for chapter %s after it is saved and opened again", (chapterSlug, paragraphSlug) => {
    const actions = [
      rewrite(chapterSlug, `chapters/${chapterSlug}/${paragraphSlug}.md`),
      deleteParagraph(chapterSlug, `chapters/${chapterSlug}/${paragraphSlug}.md`),
      cancel(chapterSlug, paragraphSlug),
    ];
    for (const action of actions) {
      const reopened = parseAssistantSessionJson(serializeAssistantSession(parseAssistantSession(session(action))));
      expect(reopened.quarantinedActions, String(action.kind)).toEqual([]);
      expect(reopened.messages[0].action, String(action.kind)).toMatchObject({ kind: action.kind, chapterSlug });
    }
  });

  it("still refuses a chapter name that is not a safe name", () => {
    for (const chapterSlug of ["../book", "001/extra", "", ".", "..", "-leading", "a\\b", "a\nb", "x".repeat(200), "bad slug!"]) {
      const parsed = parseAssistantSession(session(rewrite(chapterSlug, "chapters/001-x/001-y.md")));
      expect(parsed.messages[0].action, JSON.stringify(chapterSlug)).toBeUndefined();
      expect(parsed.quarantinedActions, JSON.stringify(chapterSlug)).toHaveLength(1);
    }
    const unsafeParagraph = parseAssistantSession(session(cancel("001-x", "../secret")));
    expect(unsafeParagraph.messages[0].action).toBeUndefined();
  });

  it("still refuses an identifier that is not a plain identifier where it must be one", () => {
    const parsed = parseAssistantSession(session({ ...rewrite("001-x", "chapters/001-x/001-y.md"), toolId: "тул" }));
    expect(parsed.messages[0].action).toBeUndefined();
    const book = parseAssistantSession(session({ ...rewrite("001-x", "chapters/001-x/001-y.md"), bookId: "книга" }));
    expect(book.messages[0].action).toBeUndefined();
  });
});
