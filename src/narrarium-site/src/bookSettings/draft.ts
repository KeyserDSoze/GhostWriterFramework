import { DEFAULT_AUDIT_SETTINGS, resolveBookAuditSettings, type AuditSettings, type BookEntry, type BookExportSettings } from "@/types/settings";
import { applyExportDraft, exportDraftOfBook, isExportDraftDirty, type ExportDraft } from "@/bookSettings/exportDraft";

export type TokenMode = "default" | "custom" | string;

/** The part of the book's export settings that is the book's own presentation: the General tab edits it, whatever preset is selected. */
export type BookPresentation = Pick<BookExportSettings, "metadataVisibility" | "paragraphSeparator" | "customParagraphSeparator">;

/** Everything the tabs of a book's settings edit before Save. One draft, so that a change in one tab survives a visit to another. */
export interface BookSettingsDraft {
  name: string;
  tokenMode: TokenMode;
  customToken: string;
  customTokenLabel: string;
  /** `__auto__` follows the personal working branch. */
  activeBranch: string;
  presentation: BookPresentation;
  audit: AuditSettings;
  exportDraft: ExportDraft;
}

export const AUTO_BRANCH = "__auto__";

export function initialTokenMode(book: BookEntry): TokenMode {
  if (book.bookToken) return "custom";
  if (book.tokenIndex != null) return String(book.tokenIndex);
  return "default";
}

export function presentationOf(settings: BookExportSettings): BookPresentation {
  return { metadataVisibility: settings.metadataVisibility, paragraphSeparator: settings.paragraphSeparator, customParagraphSeparator: settings.customParagraphSeparator };
}

export function draftOfBook(book: BookEntry): BookSettingsDraft {
  const exportDraft = exportDraftOfBook(book);
  return {
    name: book.name,
    tokenMode: initialTokenMode(book),
    customToken: book.bookToken ?? "",
    customTokenLabel: book.bookTokenLabel ?? "",
    activeBranch: book.activeBranch ?? AUTO_BRANCH,
    presentation: presentationOf(exportDraft.settings),
    audit: resolveBookAuditSettings(book),
    exportDraft,
  };
}

export function isDraftDirty(draft: BookSettingsDraft, book: BookEntry): boolean {
  const initial = draftOfBook(book);
  return draft.name !== initial.name
    || draft.tokenMode !== initial.tokenMode
    || draft.customToken !== initial.customToken
    || draft.customTokenLabel !== initial.customTokenLabel
    || draft.activeBranch !== initial.activeBranch
    || JSON.stringify(draft.presentation) !== JSON.stringify(initial.presentation)
    || JSON.stringify(draft.audit) !== JSON.stringify(initial.audit)
    || isExportDraftDirty(draft.exportDraft, book);
}

/** The book with the draft written into it. Presets are written only when they were edited, so that saving the General tab does not rewrite them. */
export function applyDraft(book: BookEntry, draft: BookSettingsDraft): BookEntry {
  const usingCustom = draft.tokenMode === "custom";
  const exported = isExportDraftDirty(draft.exportDraft, book) ? applyExportDraft(book, draft.exportDraft) : book;
  return {
    ...exported,
    name: draft.name.trim() || book.name || book.repo,
    tokenIndex: draft.tokenMode === "default" || usingCustom ? null : Number(draft.tokenMode),
    bookToken: usingCustom ? draft.customToken.trim() || undefined : undefined,
    bookTokenLabel: usingCustom ? draft.customTokenLabel.trim() || `${book.repo} PAT` : undefined,
    // Picking another token for the book ends the move to the GitHub connection; saving without touching the token keeps it.
    useGitHubConnection: draft.tokenMode === initialTokenMode(book) ? book.useGitHubConnection : undefined,
    activeBranch: draft.activeBranch === AUTO_BRANCH ? undefined : draft.activeBranch,
    exportSettings: { ...(exported.exportSettings ?? {}), ...draft.presentation },
    auditSettings: resolveBookAuditSettings({ ...book, auditSettings: draft.audit }),
  };
}

export const DEFAULT_AUDIT = DEFAULT_AUDIT_SETTINGS;
