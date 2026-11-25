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
    // Changed on purpose (the pages of the app moved out of the entry): the route names its page, which is loaded through its own module.
    expect(source("src/router.tsx")).toContain('{ path: "*", lazy: appPage("AppNotFoundPage") },');
    expect(source("src/routes/appPages.ts")).toContain('AppNotFoundPage: () => import("@/pages/AppNotFoundPage"),');
  });

  it("gates Reader resources, EPUB Markdown, and CSP at their shared boundaries", () => {
    const reader = source("src/pages/ReaderPreviewPage.tsx");
    // The images of a scene are taken out of its Markdown by the text helpers of the reader, which the annotations share.
    const readerText = source("src/narrarium/readerText.ts");
    const epub = source("src/export/bookExport.ts");
    // The policy is written once, in csp.ts, and index.html takes it from there.
    const html = source("csp.ts");
    expect(source("index.html")).toContain('content="%NARRARIUM_CSP%"');
    expect(readerText).toContain("isApprovedRepositoryAssetPath(src)");
    expect(reader).toContain('from "@/narrarium/readerText"');
    expect(reader).toContain("if (!isApprovedRepositoryAssetPath(path)) return undefined");
    expect(epub).toContain("renderEpubMarkdownHtml");
    expect(epub).not.toContain("marked.parse(");
    expect(html).toContain("object-src 'none'");
    expect(html).toContain("img-src 'self' data: blob:");
    expect(html).toContain("upgrade-insecure-requests");
    // Plain HTTP is allowed only towards this computer (the personal server started with npx).
    expect(html).toContain("connect-src 'self' https: http://127.0.0.1:* http://localhost:*");
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
    // The old trash button of a routing target (with its confirmation) is gone: a target is now cleared from its own cell, with an undo, and what
    // removes many things at once, deleting a whole tab of the router, still asks first and says how many rows lose it.
    expect(source("src/components/settings/router/RouterSection.tsx")).toContain('window.confirm(t("routing.tabs.deleteConfirm"');
    expect(settings).toContain("credentialsDisabled={false}");
    expect(source("src/pages/AddBookPage.tsx")).toContain('value="local-only"');
    expect(source("src/components/book/settings/useAttachToGitHub.ts")).toContain("attachLocalBookToGitHub");
  });
});
