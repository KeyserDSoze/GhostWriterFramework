import { createHashRouter, Navigate } from "react-router-dom";
import { Shell } from "@/components/layout/Shell";
import { AuthGuard } from "@/components/auth/AuthGuard";
import { LoginScreen } from "@/components/auth/LoginScreen";
import { BooksPage } from "@/pages/BooksPage";
import { AddBookPage } from "@/pages/AddBookPage";
import { BookPage } from "@/pages/BookPage";
import { ChapterPage } from "@/pages/ChapterPage";
import { ParagraphPage } from "@/pages/ParagraphPage";
import { SettingsPage } from "@/pages/SettingsPage";

export const router = createHashRouter([
  {
    path: "/login",
    element: <LoginScreen />,
  },
  {
    element: (
      <AuthGuard>
        <Shell />
      </AuthGuard>
    ),
    children: [
      { index: true, element: <Navigate to="/books" replace /> },
      { path: "books", element: <BooksPage /> },
      { path: "books/add", element: <AddBookPage /> },
      { path: "books/:bookId", element: <BookPage /> },
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
  { path: "*", element: <Navigate to="/books" replace /> },
]);
