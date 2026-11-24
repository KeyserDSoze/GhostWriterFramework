import { describe, expect, it } from "vitest";
import { BOOK_SETTINGS_TABS, bookSettingsHash, bookSettingsTabOfHash, bookSettingsTabState } from "@/bookSettings/tabs";
import { addExportPreset, applyExportDraft, exportDraftOfBook, isExportDraftDirty, patchExportSettings, removeExportPreset, renameExportPreset, selectExportPreset } from "@/bookSettings/exportDraft";
import { AUTO_BRANCH, applyDraft, draftOfBook, initialTokenMode, isDraftDirty } from "@/bookSettings/draft";
import { describeTokenStatus } from "@/bookSettings/tokenStatus";
import { workingBranchState } from "@/bookSettings/branchState";
import { DEFAULT_BOOK_EXPORT_SETTINGS, type BookEntry } from "@/types/settings";

const book = (patch: Partial<BookEntry> = {}): BookEntry => ({ id: "b1", owner: "me", repo: "book", name: "The Book", tokenIndex: null, addedAt: "2026-11-01T00:00:00.000Z", ...patch });
const local = (patch: Partial<BookEntry> = {}): BookEntry => book({ storageMode: "local-only", owner: "", repo: "", activeBranch: "local:abc", ...patch });

describe("the tabs of a book's settings", () => {
  it("are General, GitHub, Online reader, Export and Audit, in that order", () => {
    expect([...BOOK_SETTINGS_TABS]).toEqual(["general", "github", "reader", "export", "audit"]);
  });

  it("are chosen by the address: the name of the tab, case and encoding aside, and a few older names", () => {
    expect(bookSettingsTabOfHash("#github")).toBe("github");
    expect(bookSettingsTabOfHash("#Reader")).toBe("reader");
    expect(bookSettingsTabOfHash("#%67eneral")).toBe("general");
    expect(bookSettingsTabOfHash("#online-reader")).toBe("reader");
    expect(bookSettingsTabOfHash("#repository")).toBe("github");
    expect(bookSettingsTabOfHash("#nothing")).toBeUndefined();
    expect(bookSettingsTabOfHash("")).toBeUndefined();
    expect(bookSettingsTabOfHash("#%E0%A4%A")).toBeUndefined();
    expect(bookSettingsHash("audit")).toBe("#audit");
  });

  it("are all there for every book; only the Online reader of a book that lives on this device says it cannot be used yet", () => {
    expect(bookSettingsTabState(book()).every((entry) => entry.available)).toBe(true);
    const states = bookSettingsTabState(local());
    expect(states.filter((entry) => !entry.available)).toEqual([{ tab: "reader", available: false, reason: "needs-github" }]);
    expect(states.map((entry) => entry.tab)).toEqual([...BOOK_SETTINGS_TABS]);
  });
});

describe("the export presets while they are edited", () => {
  it("start from the book: its presets, the selected one and its settings", () => {
    const draft = exportDraftOfBook(book());
    expect(draft.profiles).toEqual([{ id: "default", name: "Default", settings: {} }]);
    expect(draft.selectedId).toBe("default");
    expect(draft.settings).toEqual(DEFAULT_BOOK_EXPORT_SETTINGS);
    expect(isExportDraftDirty(draft, book())).toBe(false);
  });

  it("change the selected preset with a change of its settings, and are then dirty", () => {
    const draft = patchExportSettings(exportDraftOfBook(book()), { fontSize: 14 });
    expect(draft.settings.fontSize).toBe(14);
    expect(draft.profiles[0].settings).toMatchObject({ fontSize: 14 });
    expect(isExportDraftDirty(draft, book())).toBe(true);
  });

  it("add a preset as a copy that is selected, refuse a blank name, rename, and remove the selected one but never the last", () => {
    const start = patchExportSettings(exportDraftOfBook(book()), { fontSize: 14 });
    expect(addExportPreset(start, "   ")).toBe(start);
    const added = addExportPreset(start, " Ebook ", "ebook");
    expect(added.profiles.map((profile) => profile.name)).toEqual(["Default", "Ebook"]);
    expect(added.selectedId).toBe("ebook");
    expect(added.profiles[1].settings).toMatchObject({ fontSize: 14 });
    expect(renameExportPreset(added, "E-book").profiles[1].name).toBe("E-book");
    const removed = removeExportPreset(added, book());
    expect(removed.profiles.map((profile) => profile.id)).toEqual(["default"]);
    expect(removed.selectedId).toBe("default");
    expect(removeExportPreset(removed, book())).toBe(removed);
  });

  it("show another preset's settings, but keep the book's presentation as it is being edited", () => {
    const base = book({ exportProfiles: [{ id: "a", name: "A", settings: { fontSize: 11 } }, { id: "b", name: "B", settings: { fontSize: 15, paragraphSeparator: "star" } }], defaultExportProfileId: "a" });
    const draft = exportDraftOfBook(base);
    expect(draft.settings.fontSize).toBe(11);
    const other = selectExportPreset(draft, base, "b", { paragraphSeparator: "custom" });
    expect(other.settings).toMatchObject({ fontSize: 15, paragraphSeparator: "custom" });
    expect(other.selectedId).toBe("b");
    expect(selectExportPreset(draft, base, "missing")).toBe(draft);
  });

  it("are written back as the book's settings, its presets and the default preset", () => {
    const draft = addExportPreset(patchExportSettings(exportDraftOfBook(book()), { fontSize: 14 }), "Ebook", "ebook");
    const written = applyExportDraft(book(), draft);
    expect(written.exportProfiles?.map((profile) => profile.id)).toEqual(["default", "ebook"]);
    expect(written.defaultExportProfileId).toBe("ebook");
    expect(written.exportSettings).toMatchObject({ fontSize: 14 });
  });
});

describe("what the tabs edit before Save", () => {
  it("is not dirty when nothing was touched, and the book is written back unchanged in what matters", () => {
    const base = book({ activeBranch: "dev" });
    const draft = draftOfBook(base);
    expect(isDraftDirty(draft, base)).toBe(false);
    const written = applyDraft(base, draft);
    expect(written).toMatchObject({ name: "The Book", activeBranch: "dev", tokenIndex: null });
    expect(written.exportProfiles).toBeUndefined();
    expect(written.defaultExportProfileId).toBeUndefined();
  });

  it("is dirty after any edit in any tab: name, token, branch, presentation, audit, export", () => {
    const base = book();
    const draft = draftOfBook(base);
    expect(isDraftDirty({ ...draft, name: "Other" }, base)).toBe(true);
    expect(isDraftDirty({ ...draft, tokenMode: "custom" }, base)).toBe(true);
    expect(isDraftDirty({ ...draft, customToken: "github_pat_x" }, base)).toBe(true);
    expect(isDraftDirty({ ...draft, activeBranch: "feature" }, base)).toBe(true);
    expect(isDraftDirty({ ...draft, presentation: { ...draft.presentation, paragraphSeparator: "none" } }, base)).toBe(true);
    expect(isDraftDirty({ ...draft, audit: { ...draft.audit, enabled: !draft.audit.enabled } }, base)).toBe(true);
    expect(isDraftDirty({ ...draft, exportDraft: patchExportSettings(draft.exportDraft, { fontSize: 9 }) }, base)).toBe(true);
    expect(isDraftDirty({ ...draft, name: "Other" }, { ...base, name: "Other" })).toBe(false);
  });

  it("writes the presentation of the General tab without rewriting the presets, and the presets only when they were edited", () => {
    const base = book();
    const general = applyDraft(base, { ...draftOfBook(base), presentation: { ...draftOfBook(base).presentation, paragraphSeparator: "none" } });
    expect(general.exportSettings).toMatchObject({ paragraphSeparator: "none" });
    expect(general.exportProfiles).toBeUndefined();
    const draft = draftOfBook(base);
    const exported = applyDraft(base, { ...draft, exportDraft: patchExportSettings(draft.exportDraft, { fontSize: 9 }), presentation: { ...draft.presentation, paragraphSeparator: "asterisks" } });
    expect(exported.exportProfiles).toHaveLength(1);
    expect(exported.exportSettings).toMatchObject({ fontSize: 9, paragraphSeparator: "asterisks" });
  });

  it("maps the token and the branch: custom token with its label, a named token by index, the automatic branch as none", () => {
    const base = book();
    const draft = draftOfBook(base);
    expect(applyDraft(base, { ...draft, tokenMode: "custom", customToken: " github_pat_x ", customTokenLabel: "" })).toMatchObject({ bookToken: "github_pat_x", bookTokenLabel: "book PAT", tokenIndex: null });
    expect(applyDraft(base, { ...draft, tokenMode: "2" })).toMatchObject({ tokenIndex: 2, bookToken: undefined });
    expect(applyDraft(book({ activeBranch: "dev" }), { ...draft, activeBranch: AUTO_BRANCH }).activeBranch).toBeUndefined();
    expect(initialTokenMode(book({ bookToken: "x" }))).toBe("custom");
    expect(initialTokenMode(book({ tokenIndex: 1 }))).toBe("1");
  });

  it("keeps the move to the GitHub connection unless another token is picked, and never leaves a book without a name", () => {
    const base = book({ useGitHubConnection: true });
    expect(applyDraft(base, draftOfBook(base)).useGitHubConnection).toBe(true);
    expect(applyDraft(base, { ...draftOfBook(base), tokenMode: "0" }).useGitHubConnection).toBeUndefined();
    expect(applyDraft(local(), { ...draftOfBook(local()), name: "  " }).name).toBe("The Book");
  });
});

describe("what the settings say of the token", () => {
  const app = (patch: Record<string, unknown> = {}) => ({ credentialKind: "app" as const, identity: { provider: "github" as const, providerAccountId: "1", displayName: "Ada L.", username: "ada" }, accessTokenExpiry: Date.parse("2026-11-26T20:00:00.000Z"), refreshToken: "ghr_x", rememberMe: true, ...patch });
  const now = Date.parse("2026-11-26T12:00:00.000Z");

  it("for the GitHub app: who is connected, that it renews itself, and until when the current token lasts", () => {
    expect(describeTokenStatus({ source: "app", connection: app(), now })).toEqual({ key: "bookSettings.tokenStatus.appRenewsUntil", params: { user: "ada", time: "2026-11-26T20:00:00.000Z" } });
    expect(describeTokenStatus({ source: "app", connection: app({ accessTokenExpiry: undefined }), now })).toEqual({ key: "bookSettings.tokenStatus.appRenews", params: { user: "ada" } });
    expect(describeTokenStatus({ source: "app", connection: app({ accessTokenExpiry: now - 1 }), now }).key).toBe("bookSettings.tokenStatus.appRenews");
  });

  it("for a connection this device does not renew: until when it lasts, and that it ended", () => {
    expect(describeTokenStatus({ source: "app", connection: app({ refreshToken: undefined }), now }).key).toBe("bookSettings.tokenStatus.appSessionUntil");
    expect(describeTokenStatus({ source: "app", connection: app({ refreshToken: undefined, accessTokenExpiry: now - 1 }), now })).toEqual({ key: "bookSettings.tokenStatus.appExpired", params: { user: "ada" } });
    expect(describeTokenStatus({ source: "app", connection: app({ refreshToken: undefined, accessTokenExpiry: undefined }), now }).key).toBe("bookSettings.tokenStatus.appConnected");
  });

  it("for any other token: the expiry GitHub reported, or that it is unknown", () => {
    expect(describeTokenStatus({ source: "default-pat", health: { expiresAt: "2026-11-28T00:00:00.000Z" }, now })).toEqual({ key: "repoStatus.expiration.seven-days", params: { date: "2026-11-28T00:00:00.000Z" } });
    expect(describeTokenStatus({ source: "book-pat", health: null, now })).toEqual({ key: "repoStatus.expiration.unknown" });
    expect(describeTokenStatus({ source: "default-pat", health: { expiresAt: "2026-11-01T00:00:00.000Z" }, now }).key).toBe("repoStatus.expiration.expired");
    // An app source without an app connection in the store (not hydrated yet) falls back to what GitHub reported.
    expect(describeTokenStatus({ source: "app", health: null, now })).toEqual({ key: "repoStatus.expiration.unknown" });
  });
});

describe("where the working branch is", () => {
  it("only on this device before the book is connected, published as the branch on GitHub after", () => {
    expect(workingBranchState({ storageMode: "local-only", activeBranch: "local:abc" }, undefined)).toEqual({ kind: "device" });
    expect(workingBranchState({ storageMode: "github", activeBranch: "dev-ada" }, "main")).toEqual({ kind: "github", branch: "dev-ada" });
    expect(workingBranchState({ storageMode: undefined, activeBranch: undefined }, "main")).toEqual({ kind: "github", branch: "main" });
    expect(workingBranchState({ storageMode: "github", activeBranch: undefined }, undefined)).toEqual({ kind: "github", branch: "main" });
  });
});
