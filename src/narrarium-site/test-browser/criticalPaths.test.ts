import { describe, expect, it } from "vitest";
import { validateAssistantAction, sourceRevisionFromFiles } from "@/assistant/actionValidation";
import { isMediaOperationOwned } from "@/assistant/mediaOwnership";
import { isExplicitNavigationPrompt, matchesToolKeyword } from "@/assistant/orchestratorRules";
import { isAssistantRequestOwned } from "@/assistant/sessionOwnership";
import { resolveChapterTarget, resolveParagraphTarget } from "@/assistant/targetRules";
import { assistantActionToolId, policyTargetEnabled, quickActionToolId } from "@/assistant/toolPolicy";
import { assertCloudStatus, resumableMigrationSteps } from "@/drive/migrationSafety";

describe("Copilot critical paths", () => {
  it("fails closed for missing nested story targets", () => {
    const chapters = [{ slug: "001-start", title: "Start", paragraphs: [{ number: "001", title: "One", path: "chapters/001-start/001-one.md" }] }];
    const chapter = resolveChapterTarget("paragraph 2 of chapter 99", chapters, chapters[0]);
    const paragraph = resolveParagraphTarget("paragraph 2 of chapter 99", chapter, chapters[0], chapters[0].paragraphs[0]);
    expect(chapter.value).toBeNull();
    expect(paragraph.value).toBeNull();
  });

  it("guards routing and request ownership", () => {
    expect(isExplicitNavigationPrompt("go to chapter 2")).toBe(true);
    expect(matchesToolKeyword("show pull requests", "pr")).toBe(false);
    expect(isAssistantRequestOwned({ requestId: "r", sessionId: "s" }, "r", "s", "s", false)).toBe(true);
    expect(isMediaOperationOwned(2, 1, false)).toBe(false);
  });

  it("revalidates persisted action provenance and canonical tools", () => {
    const revisions = { "chapters/001-start/001-one.md": "sha" };
    const action = {
      kind: "apply-paragraph-rewrite" as const,
      bookId: "book",
      chapterSlug: "001-start",
      paragraphPath: "chapters/001-start/001-one.md",
      proposedBody: "New",
      toolId: "rewrite-current-paragraph",
      owner: "owner",
      repo: "repo",
      branch: "draft",
      sourceRevision: sourceRevisionFromFiles(revisions),
      sourceRevisions: revisions,
      generatedAt: new Date().toISOString(),
    };
    expect(assistantActionToolId(action)).toBe("rewrite-current-paragraph");
    expect(validateAssistantAction({ action, owner: "owner", repo: "repo", branch: "draft", expectedToolId: "rewrite-current-paragraph", toolEnabled: true, sourceRevision: sourceRevisionFromFiles(revisions) })).toBeNull();
    expect(policyTargetEnabled(quickActionToolId("search"), () => false)).toBe(false);
  });

  it("keeps cloud failures explicit and retries unverified migration steps", () => {
    expect(() => assertCloudStatus(false, 429, "migration read")).toThrow("429");
    expect(resumableMigrationSteps(["settings", "costs"], [{ step: "settings", ok: true, verified: true }])).toEqual(["costs"]);
  });
});
