import { describe, expect, it } from "vitest";
import { validateAssistantAction, sourceRevisionFromFiles } from "@/assistant/actionValidation";
import { isMediaOperationOwned } from "@/assistant/mediaOwnership";
import { isExplicitNavigationPrompt, matchesToolKeyword } from "@/assistant/orchestratorRules";
import { isAssistantRequestOwned } from "@/assistant/sessionOwnership";
import { resolveChapterTarget, resolveParagraphTarget } from "@/assistant/targetRules";
import { assistantActionToolId, policyTargetEnabled, quickActionToolId } from "@/assistant/toolPolicy";
import { assertCloudStatus, resumableMigrationSteps } from "@/drive/migrationSafety";
import { chooseToolMatch } from "@/assistant/orchestrator";
import { ensureBuiltinCopilotToolsRegistered } from "@/assistant/tools/builtinTools";
import { copilotToolRegistry } from "@/assistant/tools/registry";
import type { AppSettings } from "@/types/settings";

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
    expect(assistantActionToolId({ ...action, kind: "confirm-create-from-research", researchPath: "research/topic.md", entityKind: "character", label: "Ada", body: "# Ada", extraFrontmatter: {}, destinationPath: "characters/ada.md" })).toBe("create-from-research");
    const researchRevisions = { "research/topic.md": "research-sha", "characters/ada.md": null };
    const researchAction = { ...action, kind: "confirm-create-from-research" as const, researchPath: "research/topic.md", entityKind: "character" as const, label: "Ada", body: "# Ada", extraFrontmatter: {}, destinationPath: "characters/ada.md", toolId: "create-from-research", sourceRevision: sourceRevisionFromFiles(researchRevisions), sourceRevisions: researchRevisions };
    expect(validateAssistantAction({ action: researchAction, owner: "owner", repo: "repo", branch: "draft", expectedToolId: "create-from-research", toolEnabled: true, sourceRevision: sourceRevisionFromFiles(researchRevisions) })).toBeNull();
    expect(validateAssistantAction({ action: { ...researchAction, sourceRevisions: { "unrelated.md": "sha" } }, owner: "owner", repo: "repo", branch: "draft", expectedToolId: "create-from-research", toolEnabled: true, sourceRevision: researchAction.sourceRevision })).toBe("invalid-action");
    expect(validateAssistantAction({ action: researchAction, owner: "owner", repo: "repo", branch: "draft", expectedToolId: "create-from-research", toolEnabled: true, sourceRevision: sourceRevisionFromFiles({ ...researchRevisions, "research/topic.md": "changed" }) })).toBe("source-revision-mismatch");
    expect(policyTargetEnabled(quickActionToolId("search"), () => false)).toBe(false);
  });

  it("keeps cloud failures explicit and retries unverified migration steps", () => {
    expect(() => assertCloudStatus(false, 429, "migration read")).toThrow("429");
    expect(resumableMigrationSteps(["settings", "costs"], [{ step: "settings", ok: true, verified: true }])).toEqual(["costs"]);
  });

  it("registers and governs multi-file edit dispatch", () => {
    ensureBuiltinCopilotToolsRegistered();
    const tool = copilotToolRegistry.get("multi-file-edit");
    expect(tool).toMatchObject({ handlerId: "multi-file-edit", mutatesData: true, requiresLlm: true, destructive: false });
    const enabled = chooseToolMatch({ prompt: "update multiple files", lowered: "update multiple files", settings: {} as AppSettings }, new Set(["multi-file-edit"]));
    expect(enabled).toMatchObject({ toolId: "multi-file-edit", handlerId: "multi-file-edit", enabled: true, mutationIntent: "positive" });
    const settings = { copilotTools: { toolOverrides: { "multi-file-edit": { enabled: false } } } } as unknown as AppSettings;
    expect(chooseToolMatch({ prompt: "aggiorna più file", lowered: "aggiorna più file", settings }, new Set(["multi-file-edit"]))).toMatchObject({ enabled: false, mutationIntent: "positive" });
  });

  it("requires exact per-target provenance before multi-file apply", () => {
    const revisions = { "chapters/a.md": "sha-a", "notes/new.md": null };
    const action = {
      kind: "apply-file-updates" as const,
      bookId: "book",
      updates: [{ path: "chapters/a.md", content: "A" }, { path: "notes/new.md", content: "B" }],
      toolId: "multi-file-edit",
      owner: "owner",
      repo: "repo",
      branch: "draft",
      sourceRevision: sourceRevisionFromFiles(revisions),
      sourceRevisions: revisions,
      generatedAt: new Date().toISOString(),
    };
    expect(validateAssistantAction({ action, owner: "owner", repo: "repo", branch: "draft", expectedToolId: "multi-file-edit", toolEnabled: true, sourceRevision: sourceRevisionFromFiles(revisions) })).toBeNull();
    expect(validateAssistantAction({ action: { ...action, sourceRevisions: { "chapters/a.md": "sha-a" } }, owner: "owner", repo: "repo", branch: "draft", expectedToolId: "multi-file-edit", toolEnabled: true, sourceRevision: action.sourceRevision })).toBe("invalid-action");
  });
});
