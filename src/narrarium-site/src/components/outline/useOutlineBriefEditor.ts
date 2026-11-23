import { useCallback, useState } from "react";
import { BookConflictError, type BookFileChange, type OutlineBriefFields } from "narrarium-engine";
import { OUTLINE_BRIEF_FILE, parseOutlineBrief, sameBriefFields, serializeOutlineBrief } from "@/autopilot/outlineBrief";
import type { OutlineFile } from "@/outline/outlineModel";
import type { OutlineSource } from "@/outline/outlineSource";

/** What a save of the brief's fields said: `saved`, nothing to save, the file changed elsewhere, or a refusal (with the engine's words). */
export type OutlineBriefSaveResult = { status: "saved" | "unchanged" | "conflict" | "failed"; message?: string };

/**
 * The fields of the brief the Scaletta page edits (genre, audience, words per scene, synopsis: `outline/_brief.md`), and what the author typed and has not
 * saved. The idea is not here: it is the description of the book, which the page saves with the outline. The file is saved through the outline's own
 * commit, expecting the version it was read at: a version that changed elsewhere is never overwritten, and the save says so instead.
 */
export function useOutlineBriefEditor({ file, source, refresh }: { file: OutlineFile | undefined; source: OutlineSource | null; refresh: () => Promise<void> }) {
  const saved: OutlineBriefFields = parseOutlineBrief(file?.content).brief;
  const [draft, setDraft] = useState<OutlineBriefFields | null>(null);
  const brief = draft ?? saved;
  const dirty = draft !== null && !sameBriefFields(draft, saved);

  const edit = useCallback((patch: Partial<OutlineBriefFields>) => {
    setDraft((current) => ({ ...(current ?? parseOutlineBrief(file?.content).brief), ...patch }));
  }, [file?.content]);

  const save = useCallback(async (): Promise<OutlineBriefSaveResult> => {
    if (!source || !draft) return { status: "unchanged" };
    if (sameBriefFields(draft, saved) && file) return { status: "unchanged" };
    const change: BookFileChange = { path: OUTLINE_BRIEF_FILE, content: serializeOutlineBrief(draft), expectedHash: file ? file.hash : null };
    try {
      await source.commit([change], "Outline: update the brief of the book");
    } catch (error) {
      if (error instanceof BookConflictError) return { status: "conflict" };
      return { status: "failed", message: error instanceof Error ? error.message : String(error) };
    }
    setDraft(null);
    await refresh();
    return { status: "saved" };
  }, [draft, file, refresh, saved, source]);

  return { brief, dirty, edit, save };
}
