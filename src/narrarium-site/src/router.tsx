import { createBrowserRouter, Navigate } from "react-router-dom";
import { Shell } from "@/components/layout/Shell";
import { AuthGuard } from "@/components/auth/AuthGuard";
import { LoginScreen } from "@/components/auth/LoginScreen";
import { BooksPage } from "@/pages/BooksPage";
import { AddBookPage } from "@/pages/AddBookPage";
import { BookPage } from "@/pages/BookPage";
import { BookDashboardPage } from "@/pages/BookDashboardPage";
import { AssetGalleryPage } from "@/pages/AssetGalleryPage";
import { ReaderPreviewPage } from "@/pages/ReaderPreviewPage";
import { BookExportPage } from "@/pages/BookExportPage";
import { BookSettingsPage } from "@/pages/BookSettingsPage";
import { CanonEntityPage } from "@/pages/CanonEntityPage";
import { ChapterPage } from "@/pages/ChapterPage";
import { ParagraphPage } from "@/pages/ParagraphPage";
import { ParagraphSplitPage } from "@/pages/ParagraphSplitPage";
import { WorkspaceDocPage } from "@/pages/WorkspaceDocPage";
import { GhostwritersPage } from "@/pages/GhostwritersPage";
import { WritingStylePage } from "@/pages/WritingStylePage";
import { EvaluationStylePage } from "@/pages/EvaluationStylePage";
import { PunctuationStylePage } from "@/pages/PunctuationStylePage";
import { ReaderPersonasPage } from "@/pages/ReaderPersonasPage";
import { ReaderEvaluationsPage } from "@/pages/ReaderEvaluationsPage";
import { PatchNotesPage } from "@/pages/PatchNotesPage";
import { ChapterStageIndexPage } from "@/pages/ChapterStageIndexPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { MigratePage } from "@/pages/MigratePage";
import { CostsPage } from "@/pages/CostsPage";
import { CustomActionsPage } from "@/pages/CustomActionsPage";
import { ReaderSettingsPage } from "@/pages/ReaderSettingsPage";
import { DeepResearchPage } from "@/pages/DeepResearchPage";
import { AppDocsIndexPage, AppDocPage } from "@/pages/AppDocsPage";
import { AssistantChatsPage } from "@/pages/AssistantChatsPage";
import { AuditPage } from "@/pages/AuditPage";
import {
  DocPage,
  DocsIndexPage,
  HomePage,
  McpPage,
  NotFoundPage,
  PrivacyPage,
  TermsPage,
} from "@/pages/PublicPages";

function routerBasename(): string {
  const base = import.meta.env.BASE_URL;
  if (!base || base === "/") return "/";
  return base.replace(/\/$/, "");
}

export const router = createBrowserRouter([
  { path: "/", element: <HomePage /> },
  { path: "/docs", element: <DocsIndexPage /> },
  { path: "/docs/*", element: <DocPage /> },
  { path: "/mcp", element: <McpPage /> },
  { path: "/privacy", element: <PrivacyPage /> },
  { path: "/terms", element: <TermsPage /> },
  {
    path: "/login",
    element: <LoginScreen />,
  },
  { path: "/bms", element: <Navigate to="/app" replace /> },
  { path: "/bms/*", element: <Navigate to="/app" replace /> },
  {
    path: "/app",
    element: (
      <AuthGuard>
        <Shell />
      </AuthGuard>
    ),
    children: [
      { index: true, element: <Navigate to="books" replace /> },
      { path: "books", element: <BooksPage /> },
      { path: "books/add", element: <AddBookPage /> },
      { path: "chats", element: <AssistantChatsPage /> },
      { path: "patch-notes", element: <PatchNotesPage /> },
      { path: "books/:bookId", element: <BookPage /> },
      { path: "books/:bookId/dashboard", element: <BookDashboardPage /> },
      { path: "books/:bookId/assets", element: <AssetGalleryPage /> },
      { path: "books/:bookId/reader", element: <ReaderPreviewPage /> },
      { path: "books/:bookId/export", element: <BookExportPage /> },
      { path: "books/:bookId/research", element: <DeepResearchPage /> },
      { path: "books/:bookId/ghostwriters", element: <GhostwritersPage /> },
      { path: "books/:bookId/writing-style", element: <WritingStylePage /> },
      { path: "books/:bookId/evaluation-style", element: <EvaluationStylePage /> },
      { path: "books/:bookId/punctuation-style", element: <PunctuationStylePage /> },
      { path: "books/:bookId/simulated-readers", element: <ReaderPersonasPage /> },
      { path: "books/:bookId/settings", element: <BookSettingsPage /> },
      { path: "books/:bookId/audit", element: <AuditPage /> },
      { path: "books/:bookId/canon/:section/:slug", element: <CanonEntityPage /> },
      { path: "books/:bookId/chapters/:chapterId/workspace/:workspaceKind", element: <WorkspaceDocPage /> },
      { path: "books/:bookId/chapters/:chapterId/writing-style", element: <WritingStylePage /> },
      { path: "books/:bookId/chapters/:chapterId/drafts", element: <ChapterStageIndexPage stage="drafts" /> },
      { path: "books/:bookId/chapters/:chapterId/scripts", element: <ChapterStageIndexPage stage="scripts" /> },
      { path: "books/:bookId/chapters/:chapterId/paragraphs/:paragraphNum/workspace/:workspaceKind", element: <WorkspaceDocPage /> },
      { path: "books/:bookId/chapters/:chapterId/reader-evaluations", element: <ReaderEvaluationsPage /> },
      { path: "books/:bookId/chapters/:chapterId/paragraphs/:paragraphNum/reader-evaluations", element: <ReaderEvaluationsPage /> },
      { path: "books/:bookId/chapters/:chapterId/audit", element: <AuditPage /> },
      { path: "books/:bookId/chapters/:chapterId/paragraphs/:paragraphNum/audit", element: <AuditPage /> },
      { path: "books/:bookId/chapters/:chapterId/paragraphs/:paragraphNum/split", element: <ParagraphSplitPage /> },
      {
        path: "books/:bookId/chapters/:chapterId",
        element: <ChapterPage />,
      },
      {
        path: "books/:bookId/chapters/:chapterId/paragraphs/:paragraphNum",
        element: <ParagraphPage />,
      },
      { path: "settings", element: <SettingsPage /> },
      { path: "settings/ai-router", element: <SettingsPage /> },
      { path: "settings/deep-search", element: <SettingsPage /> },
      { path: "settings/tools", element: <SettingsPage /> },
      { path: "settings/github", element: <SettingsPage /> },
      { path: "settings/speech", element: <SettingsPage /> },
      { path: "settings/repository", element: <SettingsPage /> },
      { path: "reader-settings", element: <ReaderSettingsPage /> },
      { path: "custom-actions", element: <CustomActionsPage /> },
      { path: "migrate", element: <MigratePage /> },
      { path: "costs", element: <CostsPage /> },
      { path: "docs", element: <AppDocsIndexPage /> },
      { path: "docs/*", element: <AppDocPage /> },
    ],
  },
  { path: "*", element: <NotFoundPage /> },
], { basename: routerBasename() });
