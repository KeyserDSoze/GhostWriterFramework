import { beforeEach, describe, expect, it } from "vitest";
import { runAssistantPrompt } from "@/assistant/service";
import type { LoadedWriterContext } from "@/assistant/context";
import type { AppSettings } from "@/types/settings";
import { useFeedbackRewriteWorkflowStore, type FeedbackRewriteOperationIdentity } from "@/store/feedbackRewriteWorkflowStore";
import { isValidAssistantActionShape } from "@/assistant/actionValidation";
import { feedbackRewriteResultSummary, restoreResultPatch } from "@/components/book/FeedbackRewriteWorkflowDialog";
import type { RewriteOperationManifest } from "@/narrarium/rewriteFromReaderFeedback";

const settings = { ui: { language: "en" }, copilotTools: { toolOverrides: {} } } as unknown as AppSettings;
const book = { id: "book-id", name: "Book", owner: "owner", repo: "repo", tokenIndex: null, addedAt: "now" };
const chapter = { slug: "chapter-1", title: "Chapter 1", path: "chapters/chapter-1", number: "1", paragraphs: [{ number: "1", title: "Opening", path: "chapters/chapter-1/paragraphs/1-opening.md" }] };
const context = { route: { kind: "chapter", bookId: "book-id", chapterId: "chapter-1" }, branchReady: true, branch: "main", structure: { defaultBranch: "main", chapters: [chapter] }, chapter, paragraph: null, relevantFiles: [] } as unknown as LoadedWriterContext;
const routeOnlyChapterContext = { route: { kind: "chapter", bookId: "book-id", chapterId: "chapter-1" }, branchReady: false, branch: "main", structure: null, chapter: null, paragraph: null, relevantFiles: [] } as unknown as LoadedWriterContext;
const routeOnlyParagraphContext = { route: { kind: "paragraph", bookId: "book-id", chapterId: "chapter-1", paragraphNum: "001" }, branchReady: false, branch: "main", structure: null, chapter: null, paragraph: null, relevantFiles: [] } as unknown as LoadedWriterContext;
const parityChapter = { slug: "001-first-light", title: "First Light", path: "chapters/001-first-light", number: "001", paragraphs: [{ number: "001", title: "Opening", path: "chapters/001-first-light/paragraphs/001-opening.md" }] };
const parityLoadedParagraphContext = { route: { kind: "paragraph", bookId: "book-id", chapterId: parityChapter.slug, paragraphNum: "001" }, branchReady: true, branch: "main", structure: { defaultBranch: "main", chapters: [parityChapter] }, chapter: parityChapter, paragraph: parityChapter.paragraphs[0], relevantFiles: [] } as unknown as LoadedWriterContext;
const parityRouteOnlyParagraphContext = { route: { kind: "paragraph", bookId: "book-id", chapterId: parityChapter.slug, paragraphNum: "001" }, branchReady: false, branch: "main", structure: null, chapter: null, paragraph: null, relevantFiles: [] } as unknown as LoadedWriterContext;

function activeIdentity(overrides: Partial<FeedbackRewriteOperationIdentity> = {}): FeedbackRewriteOperationIdentity {
  return { bookId: "book-id", operationId: "operation-1", scope: "chapter", chapterSlug: "chapter-1", requestId: 7, ownerSessionId: "session-1", ownerRequestId: "workflow-request-1", ...overrides };
}

describe("feedback rewrite cancellation ownership", () => {
  beforeEach(() => useFeedbackRewriteWorkflowStore.setState({ open: false, intent: null, abortController: null, abortable: false, operationIdentity: null }));

  it.each([
    ["book", { bookId: "other-book" }],
    ["operation", { operationId: "other-operation" }],
    ["scope", { scope: "paragraph", paragraphSlug: "opening" }],
    ["workflow request", { requestId: 8 }],
    ["session", { ownerSessionId: "session-2" }],
    ["request owner", { ownerRequestId: "workflow-request-2" }],
  ] as const)("rejects a mismatched %s", (_label, override) => {
    const controller = new AbortController();
    const identity = activeIdentity();
    useFeedbackRewriteWorkflowStore.setState({ abortController: controller, abortable: true, operationIdentity: identity });
    expect(useFeedbackRewriteWorkflowStore.getState().cancelActive(activeIdentity(override))).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });

  it.each([
    ["ambient paragraph", "cancel feedback rewrite", activeIdentity({ scope: "paragraph", chapterSlug: parityChapter.slug, paragraphSlug: "001-opening" })],
    ["current paragraph", "cancel feedback rewrite for current paragraph", activeIdentity({ scope: "paragraph", chapterSlug: parityChapter.slug, paragraphSlug: "001-opening" })],
    ["numeric paragraph", "cancel feedback rewrite for paragraph 1", activeIdentity({ scope: "paragraph", chapterSlug: parityChapter.slug, paragraphSlug: "001-opening" })],
    ["named paragraph", "cancel feedback rewrite for paragraph named \"Opening\"", activeIdentity({ scope: "paragraph", chapterSlug: parityChapter.slug, paragraphSlug: "001-opening" })],
    ["numeric chapter", "cancel feedback rewrite for chapter 1", activeIdentity({ chapterSlug: parityChapter.slug })],
    ["named chapter", "cancel feedback rewrite for chapter named \"First Light\"", activeIdentity({ chapterSlug: parityChapter.slug })],
  ] as const)("keeps loaded and route-only %s scope resolution in parity", async (_label, prompt, identity) => {
    const actions = [];
    for (const targetContext of [parityLoadedParagraphContext, parityRouteOnlyParagraphContext]) {
      const controller = new AbortController();
      useFeedbackRewriteWorkflowStore.setState({ abortController: controller, abortable: true, operationIdentity: identity });
      const message = await runAssistantPrompt({ prompt, context: targetContext, settings, book, branch: "main", token: "", history: [], compactSummary: "", compactedMessageCount: 0, attachments: [], accountScope: null, requestOwner: { sessionId: "session-1", requestId: "cancel-request" } });
      expect(controller.signal.aborted).toBe(false);
      actions.push(message.action);
    }
    expect(actions[0]).toMatchObject({ kind: "confirm-cancel-feedback-rewrite", operationId: identity.operationId, scope: identity.scope, chapterSlug: identity.chapterSlug, paragraphSlug: identity.paragraphSlug });
    expect(actions[1]).toMatchObject({ kind: "confirm-cancel-feedback-rewrite", operationId: identity.operationId, scope: identity.scope, chapterSlug: identity.chapterSlug, paragraphSlug: identity.paragraphSlug });
  });

  it.each([
    ["numeric chapter", "cancel feedback rewrite for chapter 2", activeIdentity({ chapterSlug: parityChapter.slug })],
    ["named chapter", "cancel feedback rewrite for chapter named \"Elsewhere\"", activeIdentity({ chapterSlug: parityChapter.slug })],
    ["numeric paragraph", "cancel feedback rewrite for paragraph 2", activeIdentity({ scope: "paragraph", chapterSlug: parityChapter.slug, paragraphSlug: "001-opening" })],
    ["named paragraph", "cancel feedback rewrite for paragraph named \"Elsewhere\"", activeIdentity({ scope: "paragraph", chapterSlug: parityChapter.slug, paragraphSlug: "001-opening" })],
  ] as const)("rejects loaded and route-only %s target mismatches equally", async (_label, prompt, identity) => {
    for (const targetContext of [parityLoadedParagraphContext, parityRouteOnlyParagraphContext]) {
      const controller = new AbortController();
      useFeedbackRewriteWorkflowStore.setState({ abortController: controller, abortable: true, operationIdentity: identity });
      const message = await runAssistantPrompt({ prompt, context: targetContext, settings, book, branch: "main", token: "", history: [], compactSummary: "", compactedMessageCount: 0, attachments: [], accountScope: null, requestOwner: { sessionId: "session-1", requestId: "cancel-request" } });
      expect(message.action).toBeUndefined();
      expect(message.text).toContain("does not exactly match");
      expect(controller.signal.aborted).toBe(false);
    }
  });

  it("only aborts the exactly matching operation", () => {
    const controller = new AbortController();
    const identity = activeIdentity();
    useFeedbackRewriteWorkflowStore.setState({ abortController: controller, abortable: true, operationIdentity: identity });
    expect(useFeedbackRewriteWorkflowStore.getState().cancelActive(identity)).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it("does not replace an active workflow with a concurrent target", () => {
    const controller = new AbortController();
    const identity = activeIdentity();
    useFeedbackRewriteWorkflowStore.setState({
      open: true,
      requestId: identity.requestId,
      intent: { mode: "generate", scope: "chapter", bookId: identity.bookId, chapterSlug: identity.chapterSlug, ownerSessionId: identity.ownerSessionId, ownerRequestId: identity.ownerRequestId },
      abortController: controller,
      abortable: true,
      operationIdentity: identity,
    });
    useFeedbackRewriteWorkflowStore.getState().openWorkflow({ mode: "generate", scope: "chapter", bookId: "other-book", chapterSlug: "chapter-2" });
    expect(useFeedbackRewriteWorkflowStore.getState()).toMatchObject({ requestId: 7, operationIdentity: identity, intent: { bookId: "book-id", chapterSlug: "chapter-1" } });
    expect(controller.signal.aborted).toBe(false);
  });

  it("identifies the exact active operation before cancellation and keeps completed writes explicit", async () => {
    const controller = new AbortController();
    useFeedbackRewriteWorkflowStore.setState({ abortController: controller, abortable: true, operationIdentity: activeIdentity() });
    const message = await runAssistantPrompt({ prompt: "cancel feedback rewrite", context, settings, book, branch: "main", token: "token", history: [], compactSummary: "", compactedMessageCount: 0, attachments: [], accountScope: null, requestOwner: { sessionId: "session-1", requestId: "copilot-request-1" } });
    expect(message.text).toContain("operation-1");
    expect(message.text).toContain("chapter-1");
    expect(message.text).toContain("Completed writes will be kept");
    expect(message.text.toLowerCase()).not.toContain("rolled back");
    expect(message.action).toMatchObject({ kind: "confirm-cancel-feedback-rewrite", bookId: "book-id", operationId: "operation-1", scope: "chapter", chapterSlug: "chapter-1", workflowRequestId: 7, ownerSessionId: "session-1", ownerRequestId: "workflow-request-1" });
    expect(isValidAssistantActionShape(message.action!)).toBe(true);
    expect(controller.signal.aborted).toBe(false);
  });

  it("does not propose cancellation from another session or target", async () => {
    const controller = new AbortController();
    useFeedbackRewriteWorkflowStore.setState({ abortController: controller, abortable: true, operationIdentity: activeIdentity({ chapterSlug: "chapter-2" }) });
    const message = await runAssistantPrompt({ prompt: "cancel feedback rewrite", context, settings, book, branch: "main", token: "token", history: [], compactSummary: "", compactedMessageCount: 0, attachments: [], accountScope: null, requestOwner: { sessionId: "session-2", requestId: "copilot-request-2" } });
    expect(message.action).toBeUndefined();
    expect(message.text).toContain("does not exactly match");
    expect(controller.signal.aborted).toBe(false);
  });

  it.each([
    ["chapter", "cancel feedback rewrite", routeOnlyChapterContext, activeIdentity()],
    ["paragraph", "cancel feedback rewrite", routeOnlyParagraphContext, activeIdentity({ scope: "paragraph", paragraphSlug: "001-opening" })],
    ["explicit paragraph", "cancel feedback rewrite for paragraph 1", routeOnlyParagraphContext, activeIdentity({ scope: "paragraph", paragraphSlug: "001-opening" })],
  ] as const)("identifies an exact route-only %s operation", async (_label, prompt, routeContext, identity) => {
    const controller = new AbortController();
    useFeedbackRewriteWorkflowStore.setState({ abortController: controller, abortable: true, operationIdentity: identity });
    const message = await runAssistantPrompt({ prompt, context: routeContext, settings, book, branch: "main", token: "", history: [], compactSummary: "", compactedMessageCount: 0, attachments: [], accountScope: null, requestOwner: { sessionId: "session-1", requestId: "cancel-request" } });
    expect(message.action).toMatchObject({ kind: "confirm-cancel-feedback-rewrite", bookId: identity.bookId, operationId: identity.operationId, scope: identity.scope, chapterSlug: identity.chapterSlug, paragraphSlug: identity.paragraphSlug, workflowRequestId: identity.requestId, ownerSessionId: identity.ownerSessionId, ownerRequestId: identity.ownerRequestId });
    expect(controller.signal.aborted).toBe(false);
  });

  it.each([
    ["book", routeOnlyChapterContext, { bookId: "other-book" }],
    ["chapter", routeOnlyChapterContext, { chapterSlug: "chapter-2" }],
    ["scope", routeOnlyChapterContext, { scope: "paragraph", paragraphSlug: "001-opening" }],
    ["paragraph ordinal", routeOnlyParagraphContext, { scope: "paragraph", paragraphSlug: "002-second" }],
    ["session", routeOnlyParagraphContext, { scope: "paragraph", paragraphSlug: "001-opening", ownerSessionId: "session-2" }],
  ] as const)("rejects a concurrent route-only %s mismatch", async (_label, routeContext, overrides) => {
    const controller = new AbortController();
    useFeedbackRewriteWorkflowStore.setState({ abortController: controller, abortable: true, operationIdentity: activeIdentity(overrides as Partial<FeedbackRewriteOperationIdentity>) });
    const message = await runAssistantPrompt({ prompt: "cancel feedback rewrite", context: routeContext, settings, book, branch: "main", token: "", history: [], compactSummary: "", compactedMessageCount: 0, attachments: [], accountScope: null, requestOwner: { sessionId: "session-1", requestId: "cancel-request" } });
    expect(message.action).toBeUndefined();
    expect(message.text).toContain("does not exactly match");
    expect(controller.signal.aborted).toBe(false);
  });

  it("dialog results count completed writes without claiming restoration", () => {
    const manifest = {
      status: "cancelled",
      modifiedFiles: [{ path: "drafts/one.md", status: "completed" }, { path: "drafts/two.md", status: "pending" }],
    } as RewriteOperationManifest;
    expect(feedbackRewriteResultSummary(manifest)).toEqual({ completedWrites: 1, restorationVerified: false });
    expect(feedbackRewriteResultSummary({ ...manifest, status: "rolledBack" })).toEqual({ completedWrites: 1, restorationVerified: true });
  });

  it("reports rollback failure as failure and only rolledBack as success", () => {
    const failed = { status: "failed", error: "Atomic restore failed", modifiedFiles: [{ path: "drafts/one.md", status: "completed" }] } as RewriteOperationManifest;
    expect(restoreResultPatch(failed)).toMatchObject({ phase: "failed", error: "Atomic restore failed" });
    expect(feedbackRewriteResultSummary(failed)).toEqual({ completedWrites: 1, restorationVerified: false });

    const restored = { ...failed, status: "rolledBack", error: undefined } as RewriteOperationManifest;
    expect(restoreResultPatch(restored)).toMatchObject({ phase: "completed", error: null });
    expect(feedbackRewriteResultSummary(restored).restorationVerified).toBe(true);
  });
});
