import { create } from "zustand";
import { BookStructure, Paragraph } from "@/types/book";

interface BooksState {
  structures: Record<string, BookStructure>;
  loadingIds: Set<string>;
  errors: Record<string, string>;
  /** bookId → resolved personal dev branch name */
  workingBranches: Record<string, string>;

  setStructure: (bookId: string, structure: BookStructure) => void;
  setLoading: (bookId: string, loading: boolean) => void;
  setError: (bookId: string, message: string) => void;
  setWorkingBranch: (bookId: string, branch: string) => void;
  updateChapterParagraphs: (
    bookId: string,
    chapterSlug: string,
    paragraphs: Paragraph[],
  ) => void;
}

export const useBooksStore = create<BooksState>()((set) => ({
  structures: {},
  loadingIds: new Set(),
  errors: {},
  workingBranches: {},

  setStructure: (bookId, structure) =>
    set((s) => ({ structures: { ...s.structures, [bookId]: structure } })),

  setLoading: (bookId, loading) =>
    set((s) => {
      const next = new Set(s.loadingIds);
      loading ? next.add(bookId) : next.delete(bookId);
      return { loadingIds: next };
    }),

  setError: (bookId, message) =>
    set((s) => ({ errors: { ...s.errors, [bookId]: message } })),

  setWorkingBranch: (bookId, branch) =>
    set((s) => ({
      workingBranches: { ...s.workingBranches, [bookId]: branch },
    })),

  updateChapterParagraphs: (bookId, chapterSlug, paragraphs) =>
    set((s) => {
      const structure = s.structures[bookId];
      if (!structure) return {};
      const chapters = structure.chapters.map((ch) =>
        ch.slug === chapterSlug ? { ...ch, paragraphs } : ch,
      );
      return {
        structures: { ...s.structures, [bookId]: { ...structure, chapters } },
      };
    }),
}));
