import { createBrowserRouter, Navigate, Outlet } from "react-router-dom";
import type { ComponentType } from "react";
import { RouteErrorFallback } from "@/components/layout/RouteErrorFallback";
import { RouteLoadingFallback } from "@/components/layout/RouteLoadingFallback";
import type { AppPageName, AppPages } from "@/routes/appPages";

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
/** A page of the app that cannot be shown is shown so in the shell, which stays: the sidebar, the live panel and the autopilots that run in this tab. */
const appRouteError = <RouteErrorFallback inShell />;

/**
 * One loader for several routes gives them one page component, so React keeps the page mounted when the author moves
 * between them (AI Integrations and AI Router). A remount would reload the settings from disk and drop unsaved edits.
 */
const sharedRoute = <T,>(load: () => Promise<T>) => {
  let pending: Promise<T> | undefined;
  return () => (pending ??= load().catch((error: unknown) => { pending = undefined; throw error; }));
};

/**
 * The router imports by itself only the routes of a first visit, each once: Vite writes the list of the files an imported chunk needs (it preloads
 * them together) in the chunk of the `import()`, and the router is in the entry, which every route loads. The other pages of the app are loaded
 * through `routes/appPages`, which carries their lists (see there), and which is asked for together with the shell of the app.
 */
const publicBasics = () => import("@/pages/public/PublicBasics");
const publicDocs = () => import("@/pages/public/PublicDocs");
let appPagesLoad: Promise<{ appPages: AppPages }> | undefined;
/** Asked for once and kept: an `import()` of a module already loaded still waits for a task of the browser, a frame after a click. */
const loadAppPages = () => (appPagesLoad ??= import("@/routes/appPages").catch((error: unknown) => { appPagesLoad = undefined; throw error; }));
type AppPageModule<N extends AppPageName> = Awaited<ReturnType<AppPages[N]>>;
/** The component of a page of the app: the export named like the page, or another export of its module, which must then be named. */
type AppPageExport<N extends AppPageName> = N extends keyof AppPageModule<N> ? [exportName?: keyof AppPageModule<N> & string] : [exportName: keyof AppPageModule<N> & string];
const appPage = <N extends AppPageName>(name: N, ...[exportName]: AppPageExport<N>) =>
  component(() => loadAppPages().then((pages) => pages.appPages[name]() as Promise<Record<string, unknown>>), exportName ?? name);
const appShellRoute = component(() => import("@/routes/AppShellRoute"), "AppShellRoute");
const appShell = () => {
  void loadAppPages().catch(() => undefined);
  return appShellRoute();
};
const aiSettingsPage = sharedRoute(appPage("SettingsPage"));

function RootRoute() {
  return <Outlet />;
}

export const router = createBrowserRouter([
  { Component: RootRoute, HydrateFallback: RouteLoadingFallback, children: [
  { path: "/", errorElement: routeError, lazy: component(publicBasics, "HomePage") },
  { path: "/docs", errorElement: routeError, lazy: component(publicDocs, "DocsIndexPage") },
  { path: "/docs/:docSlug", errorElement: routeError, lazy: component(publicDocs, "DocPage") },
  { path: "/mcp", errorElement: routeError, lazy: component(() => import("@/pages/public/McpPage"), "McpPage") },
  { path: "/privacy", lazy: component(publicBasics, "PrivacyPage") },
  { path: "/terms", lazy: component(publicBasics, "TermsPage") },
  { errorElement: routeError, lazy: component(() => import("@/routes/AuthProvidersRoute"), "AuthProvidersRoute"), children: [
    { path: "/login", lazy: component(() => import("@/components/auth/LoginScreen"), "LoginScreen") },
    { path: "/auth/github/callback", lazy: component(() => import("@/pages/GitHubOAuthCallbackPage"), "GitHubOAuthCallbackPage") },
    { path: "/app", lazy: appShell, children: [{ errorElement: appRouteError, children: [
      { index: true, element: <Navigate to="books" replace /> },
      { path: "books", lazy: component(() => import("@/pages/BooksPage"), "BooksPage") },
      { path: "books/add", lazy: appPage("AddBookPage") },
      { path: "chats", lazy: appPage("AssistantChatsPage") },
      { path: "patch-notes", lazy: appPage("PatchNotesPage") },
      { path: "autopilot", lazy: appPage("AutopilotHubPage") },
      { path: "books/:bookId", lazy: appPage("BookPage") },
      { path: "books/:bookId/dashboard", lazy: appPage("BookDashboardPage") },
      { path: "books/:bookId/outline", lazy: appPage("OutlinePage") },
      { path: "books/:bookId/autopilot", lazy: appPage("AutopilotPage") },
      { path: "books/:bookId/autopilot/settings", lazy: appPage("AutopilotSettingsPage") },
      { path: "books/:bookId/director", lazy: appPage("DirectorPage") },
      { path: "books/:bookId/assets", lazy: appPage("AssetGalleryPage") },
      { path: "books/:bookId/reader", lazy: appPage("ReaderPreviewPage") },
      { path: "books/:bookId/export", lazy: appPage("BookExportPage") },
      { path: "books/:bookId/research", lazy: appPage("DeepResearchPage") },
      { path: "books/:bookId/research/:researchSlug", lazy: appPage("DeepResearchPage") },
      { path: "books/:bookId/ghostwriters", lazy: appPage("GhostwritersPage") },
      { path: "books/:bookId/evaluation-style", lazy: appPage("EvaluationStylePage") },
      { path: "books/:bookId/simulated-readers", lazy: appPage("ReaderPersonasPage") },
      { path: "books/:bookId/settings", lazy: appPage("BookSettingsPage") },
      { path: "books/:bookId/audit", lazy: appPage("AuditPage") },
      { path: "books/:bookId/canon/:section/:slug", lazy: appPage("CanonEntityPage") },
      { path: "books/:bookId/chapters/:chapterId/workspace/:workspaceKind", lazy: appPage("WorkspaceDocPage") },
      { path: "books/:bookId/chapters/:chapterId/drafts", lazy: appPage("StageRoutes", "DraftStageRoute") },
      { path: "books/:bookId/chapters/:chapterId/scripts", lazy: appPage("StageRoutes", "ScriptStageRoute") },
      { path: "books/:bookId/chapters/:chapterId/paragraphs/:paragraphNum/workspace/:workspaceKind", lazy: appPage("WorkspaceDocPage") },
      { path: "books/:bookId/chapters/:chapterId/reader-evaluations", lazy: appPage("ReaderEvaluationsPage") },
      { path: "books/:bookId/chapters/:chapterId/paragraphs/:paragraphNum/reader-evaluations", lazy: appPage("ReaderEvaluationsPage") },
      { path: "books/:bookId/chapters/:chapterId/audit", lazy: appPage("AuditPage") },
      { path: "books/:bookId/chapters/:chapterId/annotations", lazy: appPage("ChapterAnnotationsPage") },
      { path: "books/:bookId/chapters/:chapterId/paragraphs/:paragraphNum/audit", lazy: appPage("AuditPage") },
      { path: "books/:bookId/chapters/:chapterId/paragraphs/:paragraphNum/split", lazy: appPage("ParagraphSplitPage") },
      { path: "books/:bookId/chapters/:chapterId", lazy: appPage("ChapterPage") },
      { path: "books/:bookId/chapters/:chapterId/paragraphs/:paragraphNum", lazy: appPage("ParagraphPage") },
      { path: "settings", lazy: appPage("SettingsPage") },
      { path: "settings/ai-integrations", lazy: aiSettingsPage },
      { path: "settings/ai-router", lazy: aiSettingsPage },
      { path: "settings/deep-search", lazy: appPage("SettingsPage") },
      { path: "settings/tools", lazy: appPage("SettingsPage") },
      { path: "settings/github", lazy: appPage("SettingsPage") },
      { path: "settings/speech", lazy: appPage("SettingsPage") },
      { path: "settings/repository", lazy: appPage("SettingsPage") },
      { path: "settings/server", lazy: appPage("SettingsPageWithAutopilotTexts", "SettingsPage") },
      { path: "settings/costs", lazy: appPage("SettingsPage") },
      { path: "account-sync", lazy: appPage("AccountSyncPage") },
      { path: "reader-settings", lazy: appPage("ReaderSettingsPage") },
      { path: "custom-actions", lazy: appPage("CustomActionsPage") },
      { path: "migrate", lazy: appPage("MigratePage") },
      { path: "costs", lazy: appPage("CostsPage") },
      { path: "docs", lazy: appPage("AppDocsPage", "AppDocsIndexPage") },
      { path: "docs/:docSlug", lazy: appPage("AppDocsPage", "AppDocPage") },
      { path: "*", lazy: appPage("AppNotFoundPage") },
    ] }] },
  ] },
  { path: "/bms", element: <Navigate to="/app" replace /> },
  { path: "/bms/*", element: <Navigate to="/app" replace /> },
  { path: "*", lazy: component(publicBasics, "NotFoundPage") },
  ] },
], { basename: routerBasename() });
