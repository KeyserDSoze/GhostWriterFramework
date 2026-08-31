import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("non-Copilot page safety contracts", () => {
  it("uses a non-empty deep-research router sentinel and unique entity keys", () => {
    const page = source("src/pages/DeepResearchPage.tsx");
    expect(page).toContain('value: "__router__"');
    expect(page).not.toContain('SelectItem key={opt.value} value=""');
    expect(page).toContain('key: `${kind}:${f.path}`');
    expect(page).toContain('value={e.key}');
  });

  it("gates audit and reader-evaluation actions to the loaded route", () => {
    const audit = source("src/pages/AuditPage.tsx");
    const readers = source("src/pages/ReaderEvaluationsPage.tsx");
    expect(audit).toContain("loadedReportPath === target.reportPath");
    expect(audit).toContain("!reportReady");
    expect(readers).toContain("loadedTargetKey === targetKey");
    expect(readers).toContain("latestNonStaleCompletedReaderEvaluations(history)");
  });

  it("has an authenticated child catch-all route", () => {
    expect(source("src/router.tsx")).toContain('{ path: "*", lazy: component(() => import("@/pages/AppNotFoundPage"), "AppNotFoundPage") },');
  });

  it("gates Reader resources, EPUB Markdown, and CSP at their shared boundaries", () => {
    const reader = source("src/pages/ReaderPreviewPage.tsx");
    const epub = source("src/export/bookExport.ts");
    const html = source("index.html");
    expect(reader).toContain("isApprovedRepositoryAssetPath(src)");
    expect(reader).toContain("if (!isApprovedRepositoryAssetPath(path)) return undefined");
    expect(epub).toContain("renderEpubMarkdownHtml");
    expect(epub).not.toContain("marked.parse(");
    expect(html).toContain("object-src 'none'");
    expect(html).toContain("img-src 'self' data: blob:");
    expect(html).toContain("upgrade-insecure-requests");
  });

  it("keeps the anonymous local workspace usable and protects destructive actions", () => {
    const shellRoute = source("src/routes/AppShellRoute.tsx");
    const settings = source("src/pages/SettingsPage.tsx");
    expect(shellRoute).toContain("return <Shell />");
    expect(shellRoute).not.toContain("<AuthGuard>");
    const settingsHook = source("src/drive/useSettings.ts");
    expect(settingsHook).toContain("initializeAccountLocalStore");
    expect(settingsHook).toContain("saveLocalAccountSettings");
    expect(source("src/account/dataSafety.ts")).toContain('confirmation !== "DELETE"');
    expect(source("src/pages/ReaderPreviewPage.tsx")).toContain('window.confirm(t("reader.deleteBookmarkConfirm"))');
    expect(source("src/pages/ReaderSettingsPage.tsx")).toContain('window.confirm(t("reader.deleteBookmarkConfirm"))');
    expect(source("src/pages/CustomActionsPage.tsx")).toContain('window.confirm(t("customActions.deleteConfirm"))');
    expect(settings).toContain('aria-label={t("routing.removeTarget")}');
    expect(settings).toContain('window.confirm(t("routing.removeTargetConfirm"))');
    expect(settings).toContain("credentialsDisabled={false}");
    expect(source("src/pages/AddBookPage.tsx")).toContain('value="local-only"');
    expect(source("src/pages/BookSettingsPage.tsx")).toContain("attachLocalBookToGitHub");
  });
});
