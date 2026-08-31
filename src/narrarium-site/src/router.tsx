import { createBrowserRouter, Navigate, Outlet } from "react-router-dom";
import type { ComponentType } from "react";
import { RouteErrorFallback } from "@/components/layout/RouteErrorFallback";
import { RouteLoadingFallback } from "@/components/layout/RouteLoadingFallback";

function routerBasename(): string {
  const base = import.meta.env.BASE_URL;
  if (!base || base === "/") return "/";
  return base.replace(/\/$/, "");
}

const component = <T extends Record<string, unknown>, K extends keyof T>(loader: () => Promise<T>, name: K) => async () => {
  const RouteComponent = (await loader())[name] as ComponentType;
  return { Component: () => <><span className="sr-only" data-route-ready={String(name)} /><RouteComponent /></> };
};
const routeError = <RouteErrorFallback />;

function RootRoute() {
  return <Outlet />;
}

export const router = createBrowserRouter([
  { Component: RootRoute, HydrateFallback: RouteLoadingFallback, children: [
  { path: "/", errorElement: routeError, lazy: component(() => import("@/pages/public/PublicBasics"), "HomePage") },
  { path: "/docs", errorElement: routeError, lazy: component(() => import("@/pages/public/PublicDocs"), "DocsIndexPage") },
  { path: "/docs/:docSlug", errorElement: routeError, lazy: component(() => import("@/pages/public/PublicDocs"), "DocPage") },
  { path: "/mcp", errorElement: routeError, lazy: component(() => import("@/pages/public/PublicDocs"), "McpPage") },
  { path: "/privacy", lazy: component(() => import("@/pages/public/PublicBasics"), "PrivacyPage") },
  { path: "/terms", lazy: component(() => import("@/pages/public/PublicBasics"), "TermsPage") },
  { path: "/msal-popup.html", lazy: component(() => import("@/pages/MicrosoftAuthPopupPage"), "MicrosoftAuthPopupPage") },
  { errorElement: routeError, lazy: component(() => import("@/routes/AuthProvidersRoute"), "AuthProvidersRoute"), children: [
    { path: "/login", lazy: component(() => import("@/components/auth/LoginScreen"), "LoginScreen") },
    { path: "/auth/github/callback", lazy: component(() => import("@/pages/GitHubOAuthCallbackPage"), "GitHubOAuthCallbackPage") },
    { path: "/app", lazy: component(() => import("@/routes/AppShellRoute"), "AppShellRoute"), children: [
      { index: true, element: <Navigate to="books" replace /> },
      { path: "books", lazy: component(() => import("@/pages/BooksPage"), "BooksPage") },
      { path: "books/add", lazy: component(() => import("@/pages/AddBookPage"), "AddBookPage") },
      { path: "chats", lazy: component(() => import("@/pages/AssistantChatsPage"), "AssistantChatsPage") },
      { path: "patch-notes", lazy: component(() => import("@/pages/PatchNotesPage"), "PatchNotesPage") },
      { path: "books/:bookId", lazy: component(() => import("@/pages/BookPage"), "BookPage") },
      { path: "books/:bookId/dashboard", lazy: component(() => import("@/pages/BookDashboardPage"), "BookDashboardPage") },
      { path: "books/:bookId/assets", lazy: component(() => import("@/pages/AssetGalleryPage"), "AssetGalleryPage") },
      { path: "books/:bookId/reader", lazy: component(() => import("@/pages/ReaderPreviewPage"), "ReaderPreviewPage") },
      { path: "books/:bookId/export", lazy: component(() => import("@/pages/BookExportPage"), "BookExportPage") },
      { path: "books/:bookId/research", lazy: component(() => import("@/pages/DeepResearchPage"), "DeepResearchPage") },
      { path: "books/:bookId/research/:researchSlug", lazy: component(() => import("@/pages/DeepResearchPage"), "DeepResearchPage") },
      { path: "books/:bookId/ghostwriters", lazy: component(() => import("@/pages/GhostwritersPage"), "GhostwritersPage") },
      { path: "books/:bookId/evaluation-style", lazy: component(() => import("@/pages/EvaluationStylePage"), "EvaluationStylePage") },
      { path: "books/:bookId/simulated-readers", lazy: component(() => import("@/pages/ReaderPersonasPage"), "ReaderPersonasPage") },
      { path: "books/:bookId/settings", lazy: component(() => import("@/pages/BookSettingsPage"), "BookSettingsPage") },
      { path: "books/:bookId/audit", lazy: component(() => import("@/pages/AuditPage"), "AuditPage") },
      { path: "books/:bookId/canon/:section/:slug", lazy: component(() => import("@/pages/CanonEntityPage"), "CanonEntityPage") },
      { path: "books/:bookId/chapters/:chapterId/workspace/:workspaceKind", lazy: component(() => import("@/pages/WorkspaceDocPage"), "WorkspaceDocPage") },
      { path: "books/:bookId/chapters/:chapterId/drafts", lazy: component(() => import("@/routes/StageRoutes"), "DraftStageRoute") },
      { path: "books/:bookId/chapters/:chapterId/scripts", lazy: component(() => import("@/routes/StageRoutes"), "ScriptStageRoute") },
      { path: "books/:bookId/chapters/:chapterId/paragraphs/:paragraphNum/workspace/:workspaceKind", lazy: component(() => import("@/pages/WorkspaceDocPage"), "WorkspaceDocPage") },
      { path: "books/:bookId/chapters/:chapterId/reader-evaluations", lazy: component(() => import("@/pages/ReaderEvaluationsPage"), "ReaderEvaluationsPage") },
      { path: "books/:bookId/chapters/:chapterId/paragraphs/:paragraphNum/reader-evaluations", lazy: component(() => import("@/pages/ReaderEvaluationsPage"), "ReaderEvaluationsPage") },
      { path: "books/:bookId/chapters/:chapterId/audit", lazy: component(() => import("@/pages/AuditPage"), "AuditPage") },
      { path: "books/:bookId/chapters/:chapterId/paragraphs/:paragraphNum/audit", lazy: component(() => import("@/pages/AuditPage"), "AuditPage") },
      { path: "books/:bookId/chapters/:chapterId/paragraphs/:paragraphNum/split", lazy: component(() => import("@/pages/ParagraphSplitPage"), "ParagraphSplitPage") },
      { path: "books/:bookId/chapters/:chapterId", lazy: component(() => import("@/pages/ChapterPage"), "ChapterPage") },
      { path: "books/:bookId/chapters/:chapterId/paragraphs/:paragraphNum", lazy: component(() => import("@/pages/ParagraphPage"), "ParagraphPage") },
      { path: "settings", lazy: component(() => import("@/pages/SettingsPage"), "SettingsPage") },
      { path: "settings/ai-router", lazy: component(() => import("@/pages/SettingsPage"), "SettingsPage") },
      { path: "settings/deep-search", lazy: component(() => import("@/pages/SettingsPage"), "SettingsPage") },
      { path: "settings/tools", lazy: component(() => import("@/pages/SettingsPage"), "SettingsPage") },
      { path: "settings/github", lazy: component(() => import("@/pages/SettingsPage"), "SettingsPage") },
      { path: "settings/speech", lazy: component(() => import("@/pages/SettingsPage"), "SettingsPage") },
      { path: "settings/repository", lazy: component(() => import("@/pages/SettingsPage"), "SettingsPage") },
      { path: "account-sync", lazy: component(() => import("@/pages/AccountSyncPage"), "AccountSyncPage") },
      { path: "reader-settings", lazy: component(() => import("@/pages/ReaderSettingsPage"), "ReaderSettingsPage") },
      { path: "custom-actions", lazy: component(() => import("@/pages/CustomActionsPage"), "CustomActionsPage") },
      { path: "migrate", lazy: component(() => import("@/pages/MigratePage"), "MigratePage") },
      { path: "costs", lazy: component(() => import("@/pages/CostsPage"), "CostsPage") },
      { path: "docs", lazy: component(() => import("@/pages/AppDocsPage"), "AppDocsIndexPage") },
      { path: "docs/:docSlug", lazy: component(() => import("@/pages/AppDocsPage"), "AppDocPage") },
      { path: "*", lazy: component(() => import("@/pages/AppNotFoundPage"), "AppNotFoundPage") },
    ] },
  ] },
  { path: "/bms", element: <Navigate to="/app" replace /> },
  { path: "/bms/*", element: <Navigate to="/app" replace /> },
  { path: "*", lazy: component(() => import("@/pages/public/PublicBasics"), "NotFoundPage") },
  ] },
], { basename: routerBasename() });
