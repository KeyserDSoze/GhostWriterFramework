import { useCallback, useEffect, useMemo } from "react";
import { create } from "zustand";
import { useSettingsStore } from "@/store/settingsStore";
import { useBooksStore } from "@/store/booksStore";
import { loadBookTemplate } from "@/narrarium/bookTemplate";
import { resolveGitHubRemoteToken, type BookEntry } from "@/types/settings";
import type { ReaderFailure } from "@/readerAccess/errors";
import { classifyWorkflowFailure } from "@/readerAccess/creation";
import { applyReaderUpdate, type ReaderUpdateOutcome } from "@/readerUpdate/apply";
import { CustomizedWorkflowRefused } from "@/readerUpdate/commit";
import type { ReaderUpdateInputs } from "@/readerUpdate/decision";
import { inspectReaderUpdate, type ReaderUpdateInspection } from "@/readerUpdate/inspect";

export type ReaderUpdateFailure =
  | { kind: "refused-customized" }
  /** The working copy changed between the check and the commit. */
  | { kind: "changed" }
  | { kind: "github"; failure: ReaderFailure }
  | { kind: "other" };

interface Entry {
  inspection: ReaderUpdateInspection | null;
  checking: boolean;
  applying: boolean;
  outcome: ReaderUpdateOutcome | null;
  failure: ReaderUpdateFailure | null;
}

const EMPTY: Entry = { inspection: null, checking: false, applying: false, outcome: null, failure: null };

/** What was found for each book and branch, so that the tab of the reader and the notice of the GitHub tab show the same thing and one refreshes the other. */
const useReaderUpdateStore = create<{ entries: Record<string, Entry>; patch: (key: string, change: Partial<Entry>) => void }>((set) => ({
  entries: {},
  patch: (key, change) => set((state) => ({ entries: { ...state.entries, [key]: { ...(state.entries[key] ?? EMPTY), ...change } } })),
}));

export function describeUpdateFailure(error: unknown): ReaderUpdateFailure {
  if (error instanceof CustomizedWorkflowRefused) return { kind: "refused-customized" };
  if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "REPOSITORY_CONFLICT") return { kind: "changed" };
  const failure = classifyWorkflowFailure(error);
  return failure.kind === "other" && failure.status === undefined ? { kind: "other" } : { kind: "github", failure };
}

/** The working branch the update is committed on: the one the book works on, the way every other change does. */
export function useWorkingBranch(book: BookEntry): string {
  const { workingBranches, structures } = useBooksStore();
  return book.activeBranch ?? workingBranches[book.id] ?? structures[book.id]?.defaultBranch ?? "main";
}

/** The check of a book's reader and the one commit that updates it. `remote` is what GitHub said of Pages and the passwords, when the caller has read it. */
export function useReaderUpdate(book: BookEntry, remote?: ReaderUpdateInputs["remote"]) {
  const settings = useSettingsStore((state) => state.settings);
  const token = resolveGitHubRemoteToken(book, settings);
  const branch = useWorkingBranch(book);
  const key = `${book.id}|${branch}`;
  const entry = useReaderUpdateStore((state) => state.entries[key]) ?? EMPTY;
  const patch = useReaderUpdateStore((state) => state.patch);
  const pagesOn = remote?.pagesOn ?? null;
  const passwordsSet = remote?.passwordsSet ?? null;
  const remoteKey = useMemo(() => ({ pagesOn, passwordsSet }), [pagesOn, passwordsSet]);

  const check = useCallback(async () => {
    patch(key, { checking: true });
    try {
      const inspection = await inspectReaderUpdate({ book, branch, token, remote: remoteKey, loadTemplate: loadBookTemplate });
      patch(key, { inspection, checking: false });
    } catch {
      patch(key, { checking: false, inspection: null });
    }
  }, [book, branch, token, remoteKey, key, patch]);

  useEffect(() => { void check(); }, [check]);

  const apply = useCallback(async (options: { replaceEdits: boolean }): Promise<ReaderUpdateOutcome | null> => {
    const current = useReaderUpdateStore.getState().entries[key]?.inspection;
    if (!current || current.decision.kind !== "update" || useReaderUpdateStore.getState().entries[key]?.applying) return null;
    patch(key, { applying: true, failure: null, outcome: null });
    try {
      const outcome = await applyReaderUpdate({ book, branch, token, update: current.decision, workflowHash: current.workflowHash, replaceEdits: options.replaceEdits });
      patch(key, { applying: false, outcome });
      await check();
      return outcome;
    } catch (error) {
      patch(key, { applying: false, failure: describeUpdateFailure(error) });
      return null;
    }
  }, [book, branch, token, key, patch, check]);

  return { ...entry, branch, check, apply, dismissFailure: () => patch(key, { failure: null }) };
}
