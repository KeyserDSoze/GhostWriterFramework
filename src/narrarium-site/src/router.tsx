import { createBrowserRouter, Navigate } from "react-router-dom";
import { Shell } from "@/components/layout/Shell";
import { AuthGuard } from "@/components/auth/AuthGuard";
import { LoginScreen } from "@/components/auth/LoginScreen";
import { BooksPage } from "@/pages/BooksPage";
import { AddBookPage } from "@/pages/AddBookPage";
import { BookPage } from "@/pages/BookPage";
import { BookSettingsPage } from "@/pages/BookSettingsPage";
import { CanonEntityPage } from "@/pages/CanonEntityPage";
import { ChapterPage } from "@/pages/ChapterPage";
import { ParagraphPage } from "@/pages/ParagraphPage";
import { WorkspaceDocPage } from "@/pages/WorkspaceDocPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { AssistantChatsPage } from "@/pages/AssistantChatsPage";
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
      { path: "books/:bookId", element: <BookPage /> },
      { path: "books/:bookId/settings", element: <BookSettingsPage /> },
      { path: "books/:bookId/canon/:section/:slug", element: <CanonEntityPage /> },
      { path: "books/:bookId/chapters/:chapterId/workspace/:workspaceKind", element: <WorkspaceDocPage /> },
      { path: "books/:bookId/chapters/:chapterId/paragraphs/:paragraphNum/workspace/:workspaceKind", element: <WorkspaceDocPage /> },
      {
        path: "books/:bookId/chapters/:chapterId",
        element: <ChapterPage />,
      },
      {
        path: "books/:bookId/chapters/:chapterId/paragraphs/:paragraphNum",
        element: <ParagraphPage />,
      },
      { path: "settings", element: <SettingsPage /> },
    ],
  },
  { path: "*", element: <NotFoundPage /> },
], { basename: routerBasename() });
