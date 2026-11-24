import { resolveBookExportProfiles, resolveBookExportSettings, type BookEntry, type BookExportProfile, type BookExportSettings } from "@/types/settings";

/**
 * The export presets of a book while they are being edited: the presets, which one is selected and its settings. The dialog of the export page and the
 * Export tab of the book's settings edit the same draft, through these functions, and write it back with `applyExportDraft`.
 */
export interface ExportDraft {
  profiles: BookExportProfile[];
  selectedId: string;
  settings: BookExportSettings;
}

export function exportDraftOfBook(book: BookEntry): ExportDraft {
  const profiles = resolveBookExportProfiles(book);
  const selectedId = book.defaultExportProfileId ?? profiles[0]?.id ?? "default";
  return { profiles, selectedId, settings: resolveBookExportSettings(book, selectedId) };
}

/** A change of the selected preset's settings is a change of that preset too. */
export function patchExportSettings(draft: ExportDraft, patch: Partial<BookExportSettings>): ExportDraft {
  const settings = { ...draft.settings, ...patch };
  return { ...draft, settings, profiles: draft.profiles.map((profile) => (profile.id === draft.selectedId ? { ...profile, settings } : profile)) };
}

/** Selecting another preset shows its settings; the book-level presentation (`keep`) stays what it is being edited to. */
export function selectExportPreset(draft: ExportDraft, book: BookEntry, id: string, keep?: Partial<BookExportSettings>): ExportDraft {
  const profile = draft.profiles.find((entry) => entry.id === id);
  if (!profile) return draft;
  return { ...draft, selectedId: id, settings: { ...resolveBookExportSettings({ ...book, exportProfiles: draft.profiles }, id), ...(keep ?? {}) } };
}

export function renameExportPreset(draft: ExportDraft, name: string): ExportDraft {
  return { ...draft, profiles: draft.profiles.map((profile) => (profile.id === draft.selectedId ? { ...profile, name } : profile)) };
}

/** A new preset starts as a copy of the settings being edited and becomes the selected one. A blank name adds nothing. */
export function addExportPreset(draft: ExportDraft, name: string, id: string = crypto.randomUUID()): ExportDraft {
  const trimmed = name.trim();
  if (!trimmed) return draft;
  return { ...draft, profiles: [...draft.profiles, { id, name: trimmed, settings: { ...draft.settings } }], selectedId: id };
}

/** The selected preset goes; the first of the rest is selected. The last preset is never removed. */
export function removeExportPreset(draft: ExportDraft, book: BookEntry, keep?: Partial<BookExportSettings>): ExportDraft {
  if (draft.profiles.length <= 1) return draft;
  const profiles = draft.profiles.filter((profile) => profile.id !== draft.selectedId);
  const selectedId = profiles[0]?.id ?? "default";
  return { profiles, selectedId, settings: { ...resolveBookExportSettings({ ...book, exportProfiles: profiles, defaultExportProfileId: selectedId }, selectedId), ...(keep ?? {}) } };
}

export function isExportDraftDirty(draft: ExportDraft, book: BookEntry): boolean {
  const initial = exportDraftOfBook(book);
  return JSON.stringify([initial.profiles, initial.selectedId, initial.settings]) !== JSON.stringify([draft.profiles, draft.selectedId, draft.settings]);
}

/** The book with the draft written into it: the settings at book level, and the presets with the selected one as the default. */
export function applyExportDraft(book: BookEntry, draft: ExportDraft): BookEntry {
  return { ...book, exportSettings: { ...(book.exportSettings ?? {}), ...draft.settings }, exportProfiles: draft.profiles, defaultExportProfileId: draft.selectedId };
}
