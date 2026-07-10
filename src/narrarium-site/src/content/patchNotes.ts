import rawPatchNotes from "./patch-notes.json";

export interface LocalizedPatchNote {
  title: string;
  summary: string;
  changes: string[];
}

export interface PatchNote {
  version: string;
  date: string;
  en: LocalizedPatchNote;
  it: LocalizedPatchNote;
}

export const patchNotes = rawPatchNotes as PatchNote[];

export function patchNoteFor(version: string): PatchNote | undefined {
  return patchNotes.find((note) => note.version === version);
}

export function localizedPatchNote(note: PatchNote, language?: string): LocalizedPatchNote {
  return language?.toLowerCase().startsWith("it") ? note.it : note.en;
}

export const PATCH_NOTES_SEEN_KEY = "narrarium-patch-notes-seen-version";
export const ONBOARDING_COMPLETED_KEY = "narrarium-onboarding-completed";
