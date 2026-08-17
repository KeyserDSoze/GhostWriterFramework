import { create } from "zustand";
import { BookStructure, Paragraph } from "@/types/book";
import type { LegacyAdoptionTarget } from "@/auth/legacyAdoptionConsent";

export interface CloneProgress {
  done: number;
  total: number;
  path?: string;
  phase?: "cloning" | "migrating" | "repairing" | "finalizing";
}

export const LEGACY_REPOSITORY_AUTH_REQUIRED = "LEGACY_REPOSITORY_AUTH_REQUIRED" as const;
export const LEGACY_REPOSITORY_COPY_CONFLICT = "LEGACY_REPOSITORY_COPY_CONFLICT" as const;
export const LEGACY_REPOSITORY_ADOPTION_DECLINED = "LEGACY_REPOSITORY_ADOPTION_DECLINED" as const;
export const LEGACY_REPOSITORY_CHANGED = "LEGACY_REPOSITORY_CHANGED" as const;
export type LegacyBookStructureErrorCode = typeof LEGACY_REPOSITORY_AUTH_REQUIRED | typeof LEGACY_REPOSITORY_COPY_CONFLICT | typeof LEGACY_REPOSITORY_ADOPTION_DECLINED | typeof LEGACY_REPOSITORY_CHANGED;

export interface BookStructureLoadError {
  code: LegacyBookStructureErrorCode | "BOOK_STRUCTURE_LOAD_FAILED";
  message?: string;
  adoptionTarget?: LegacyAdoptionTarget;
}

interface BooksState {
  structures: Record<string, BookStructure>;
  loadingIds: Set<string>;
  activeStructureOperations: Record<string, { token: string; epoch: number; generation: number; count: number }>;
  errors: Record<string, BookStructureLoadError>;
  /** bookId → resolved personal dev branch name */
  workingBranches: Record<string, string>;
  cloneProgress: Record<string, CloneProgress | undefined>;
  structureGenerations: Record<string, number>;
  structureLoadEpoch: number;

  setStructure: (bookId: string, structure: BookStructure, generation?: number) => void;
  invalidateStructure: (bookId: string) => number;
  beginStructureOperation: (bookId: string, token: string, epoch: number, generation: number) => void;
  endStructureOperation: (bookId: string, token: string) => void;
  setError: (bookId: string, error?: BookStructureLoadError) => void;
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
  activeStructureOperations: {},
  errors: {},
  workingBranches: {},
  cloneProgress: {},
  structureGenerations: {},
  structureLoadEpoch: 0,

  setStructure: (bookId, structure, generation) =>
    set((s) => generation !== undefined && (s.structureGenerations[bookId] ?? 0) !== generation
      ? {}
      : { structures: { ...s.structures, [bookId]: structure } }),

  invalidateStructure: (bookId) => {
    let generation = 0;
    set((s) => {
      generation = (s.structureGenerations[bookId] ?? 0) + 1;
      const structures = { ...s.structures };
      delete structures[bookId];
      return { structures, structureGenerations: { ...s.structureGenerations, [bookId]: generation } };
    });
    return generation;
  },

  beginStructureOperation: (bookId, token, epoch, generation) =>
    set((s) => {
      const current = s.activeStructureOperations[bookId];
      const operation = current?.token === token
        ? { ...current, count: current.count + 1 }
        : { token, epoch, generation, count: 1 };
      const loadingIds = new Set(s.loadingIds);
      loadingIds.add(bookId);
      return { activeStructureOperations: { ...s.activeStructureOperations, [bookId]: operation }, loadingIds };
    }),

  endStructureOperation: (bookId, token) =>
    set((s) => {
      const current = s.activeStructureOperations[bookId];
      if (!current || current.token !== token) return {};
      const activeStructureOperations = { ...s.activeStructureOperations };
      if (current.count > 1) {
        activeStructureOperations[bookId] = { ...current, count: current.count - 1 };
        return { activeStructureOperations };
      }
      delete activeStructureOperations[bookId];
      const loadingIds = new Set(s.loadingIds);
      loadingIds.delete(bookId);
      return { activeStructureOperations, loadingIds };
    }),

  setError: (bookId, error) =>
    set((s) => {
      const errors = { ...s.errors };
      if (error) errors[bookId] = error;
      else delete errors[bookId];
      return { errors };
    }),

  setWorkingBranch: (bookId, branch) =>
    set((s) => ({
      workingBranches: { ...s.workingBranches, [bookId]: branch },
    })),

  setCloneProgress: (bookId, progress) =>
    set((s) => {
      const cloneProgress = { ...s.cloneProgress };
      if (progress) cloneProgress[bookId] = progress;
      else delete cloneProgress[bookId];
      return { cloneProgress };
    }),

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
      const activeStructureOperations = { ...s.activeStructureOperations };
      delete activeStructureOperations[bookId];
      return {
        structures,
        errors,
        workingBranches,
        cloneProgress,
        loadingIds,
        activeStructureOperations,
        structureGenerations: { ...s.structureGenerations, [bookId]: (s.structureGenerations[bookId] ?? 0) + 1 },
      };
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
