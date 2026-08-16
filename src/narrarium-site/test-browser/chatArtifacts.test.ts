import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { assistantArchiveHistoryLines, buildAssistantSessionMarkdown, hasAssistantSessionArchiveContent } from "@/assistant/chatArtifacts";
import { AssistantArchiveProvenance } from "@/components/assistant/AssistantArchiveProvenance";
import type { AssistantSession } from "@/assistant/store";

describe("assistant chat artifacts", () => {
  it("keeps attachment-only archives visible in history and Markdown exports", () => {
    const session: AssistantSession = {
      id: "session-1", title: "Chat", contextTitle: "Book", updatedAt: "2026-08-15T10:00:00.000Z",
      messages: [], attachments: [], compactSummary: "", compactedMessageCount: 1,
      archive: {
        summary: "", messageCount: 1, actions: [],
        attachments: [{ id: "attachment-1", name: "source-notes.txt", mimeType: "text/plain", kind: "text", sizeBytes: 42 }],
      },
    };
    expect(hasAssistantSessionArchiveContent(session)).toBe(true);
    expect(buildAssistantSessionMarkdown(session)).toMatch(/Archived Conversation \(1 messages\)[\s\S]*Archived Attachments[\s\S]*source-notes\.txt/);
  });

  it("exports attachment-only active history and complete archived action provenance", () => {
    const session: AssistantSession = {
      id: "session-2", title: "Audit", contextTitle: "Book", updatedAt: "2026-08-15T10:00:00.000Z",
      messages: [],
      attachments: [{ id: "active-1", name: "active-notes.txt", mimeType: "text/plain", kind: "text", sizeBytes: 12, textContent: "notes" }],
      compactSummary: "", compactedMessageCount: 1,
      archive: {
        summary: "", messageCount: 1, attachments: [],
        actions: [{
          messageId: "message-1", kind: "apply-file-updates", bookId: "book-1", toolId: "multi-file-edit",
          owner: "writer", repo: "novel", branch: "main", sourceRevision: "head123",
          sourceRevisions: { "plot.md": "plot123", "notes.md": null }, generatedAt: "2026-08-15T09:00:00.000Z", paths: ["plot.md", "notes.md"],
        }],
      },
    };
    const markdown = buildAssistantSessionMarkdown(session);

    expect(markdown).toContain("## Active Attachments");
    expect(markdown).toContain("active-notes.txt (text/plain, text, 12 bytes; id: active-1)");
    expect(markdown).toContain("Tool: multi-file-edit");
    expect(markdown).toContain("Repository: writer/novel");
    expect(markdown).toContain("Branch: main");
    expect(markdown).toContain("Source revision: head123");
    expect(markdown).toContain("Generated: 2026-08-15T09:00:00.000Z");
    expect(markdown).toContain("plot.md=plot123");
    expect(markdown).toContain("notes.md=missing");
    expect(assistantArchiveHistoryLines(session).join("\n")).toContain("Repository: writer/novel");
  });

  it("renders action-only and rolled provenance in loaded history and exports", () => {
    const session: AssistantSession = {
      id: "session-3", title: "Audit only", contextTitle: "Book", updatedAt: "2026-08-15T10:00:00.000Z",
      messages: [], attachments: [], compactSummary: "", compactedMessageCount: 10,
      archive: {
        summary: "", messageCount: 10, attachments: [],
        actions: [{ messageId: "message-10", kind: "navigate", toolId: "navigate", owner: "writer", repo: "novel", branch: "main", sourceRevision: "head", paths: [] }],
        rollup: { algorithm: "SHA-256-chain-v1", actionCount: 9, actionDigest: "a".repeat(64), attachmentCount: 0, attachmentDigest: "" },
      },
    };
    const history = assistantArchiveHistoryLines(session).join("\n");
    expect(hasAssistantSessionArchiveContent(session)).toBe(true);
    expect(history).toContain("Kind: navigate");
    expect(history).toContain("Repository: writer/novel");
    expect(history).toContain(`Rolled actions: 9; SHA-256-chain-v1: ${"a".repeat(64)}`);
    expect(buildAssistantSessionMarkdown(session)).toContain(history);
    render(createElement(AssistantArchiveProvenance, { session }));
    expect(screen.getByText("Kind: navigate", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Repository: writer/novel", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Rolled actions: 9", { exact: false })).toBeInTheDocument();
  });
});
