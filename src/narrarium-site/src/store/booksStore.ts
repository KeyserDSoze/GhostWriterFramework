import { create } from "zustand";
import { BookStructure, Paragraph } from "@/types/book";

export interface CloneProgress {
  done: number;
  total: number;
  path?: string;
}

interface BooksState {
  structures: Record<string, BookStructure>;
  loadingIds: Set<string>;
  errors: Record<string, string>;
  /** bookId → resolved personal dev branch name */
  workingBranches: Record<string, string>;
  cloneProgress: Record<string, CloneProgress | undefined>;

  setStructure: (bookId: string, structure: BookStructure) => void;
  setLoading: (bookId: string, loading: boolean) => void;
  setError: (bookId: string, message: string) => void;
  setWorkingBranch: (bookId: string, branch: string) => void;
  setCloneProgress: (bookId: string, progress?: CloneProgress) => void;
  clearBook: (bookId: string) => void;
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
  cloneProgress: {},

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

  setCloneProgress: (bookId, progress) =>
    set((s) => ({ cloneProgress: { ...s.cloneProgress, [bookId]: progress } })),

  clearBook: (bookId) =>
    set((s) => {
      const structures = { ...s.structures };
      delete structures[bookId];
      const errors = { ...s.errors };
      delete errors[bookId];
      const workingBranches = { ...s.workingBranches };
      delete workingBranches[bookId];
      const cloneProgress = { ...s.cloneProgress };
      delete cloneProgress[bookId];
      const loadingIds = new Set(s.loadingIds);
      loadingIds.delete(bookId);
      return { structures, errors, workingBranches, cloneProgress, loadingIds };
    }),

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
