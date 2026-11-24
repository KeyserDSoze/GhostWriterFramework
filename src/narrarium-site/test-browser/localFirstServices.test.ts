import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createParagraphDraftArtifact, createParagraphScriptArtifact, createChapterResumeArtifact } from "@/narrarium/workspace";
import { createNote } from "@/narrarium/notes";
import { openCanonDossier } from "@/narrarium/openDossier";
import { loadReaderPersonas } from "@/narrarium/readerPanel";
import { loadBookExportSnapshot } from "@/export/bookExport";
import { loadReaderBook } from "@/pages/ReaderPreviewPage";
import { loadRewriteWorkingCopyText } from "@/narrarium/rewriteFromReaderFeedback";
import { reorderParagraphsInChapter } from "@/github/githubClient";
import { buildLocalBookStructure, getLocalFile, listUnpushedLocalCommits, writeLocalBinaryScoped } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { commitLocalChanges } from "@/repository/repositoryService";
import { resolveRepositoryHeadForMutation } from "@/repository/safeRepositoryMutation";
import { localWorkspaceScope } from "@/account/deviceIdentity";
import { useDossierStore } from "@/store/dossierStore";
import { DEFAULT_SETTINGS, resolveBookExportSettings } from "@/types/settings";
import { blockNetwork, createLocalOnlyBook, resetLocalWorkspace, type LocalFirstBook } from "./helpers/localFirst";

// The services behind the pages of a book kept on this device, with every request failing as offline: each works from the working copy and none asks GitHub.

const CHAPTER = "001-the-gate";
const files = [
  { path: `chapters/${CHAPTER}/chapter.md`, content: "---\ntype: chapter\nid: chapter:001-the-gate\nnumber: 1\ntitle: The Gate\n---\n\nThe first chapter.\n" },
  { path: `chapters/${CHAPTER}/001-opening.md`, content: "---\ntype: paragraph\nid: paragraph:001-the-gate:001-opening\nnumber: 1\ntitle: Opening\n---\n\nThe gate stood open.\n" },
  { path: `chapters/${CHAPTER}/002-closing.md`, content: "---\ntype: paragraph\nid: paragraph:001-the-gate:002-closing\nnumber: 2\ntitle: Closing\n---\n\nThe gate closed.\n" },
  { path: "characters/mara.md", content: "---\ntype: character\nid: character:mara\nname: Mara\n---\n\nThe gatekeeper.\n" },
  { path: "assets/book/cover.md", content: "---\ntype: asset\npath: assets/book/cover.png\nalt_text: The glass gate\n---\n" },
];
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let network: ReturnType<typeof blockNetwork>;
let local: LocalFirstBook;

beforeEach(async () => {
  await resetLocalWorkspace();
  // The IndexedDB of these tests keeps a picture only as a Blob it can clone: the one of Node, as a browser keeps its own.
  vi.stubGlobal("Blob", NodeBlob);
  network = blockNetwork();
  local = await createLocalOnlyBook("The Glass Gate", files);
  // The author saved once: the book has a local commit it can never push, as books kept on this device do.
  await commitLocalChanges({ bookId: local.book.id, owner: "", repo: "", branch: local.branch, accountIdentity: localWorkspaceScope() }, "Save local book changes").catch(() => undefined);
  const scope = captureRepositoryOperationScope();
  await writeLocalBinaryScoped(local.meta.id, "assets/book/cover.png", PNG, scope);
  await writeLocalBinaryScoped(local.meta.id, "assets/characters/mara/primary.png", PNG, scope);
  local.structure = await buildLocalBookStructure(local.meta);
  URL.createObjectURL = vi.fn(() => `blob:local-${Math.random()}`);
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(network.requests).toEqual([]);
});

describe("a book kept on this device, with GitHub out of reach", () => {
  it("shows its cover and its pictures in the reader", async () => {
    const book = await loadReaderBook({ book: local.book, structure: local.structure, token: local.token, branch: local.branch, readerSettings: { ...DEFAULT_SETTINGS.reader, showImages: true }, presentationSettings: resolveBookExportSettings(local.book), entities: [], objectUrls: [] });
    expect(book.coverUrl).toMatch(/^blob:local-/);
    expect(book.chapters[0].paragraphs.map((paragraph) => paragraph.text)).toEqual([expect.stringContaining("The gate stood open."), expect.stringContaining("The gate closed.")]);
  });

  it("exports its chapters", async () => {
    const snapshot = await loadBookExportSnapshot({ token: local.token, book: local.book, branch: local.branch, structure: local.structure, scope: "full", exportSettings: { ...resolveBookExportSettings(local.book), includeImages: true } });
    expect(snapshot.chapters).toHaveLength(1);
    expect(snapshot.chapters[0].paragraphs).toHaveLength(2);
    expect(snapshot.coverAsset).toMatchObject({ path: "assets/book/cover.png", altText: "The glass gate" });
  });

  it("opens a canon entity in the dossier with its picture", async () => {
    const mara = local.structure.characters.find((entry) => entry.path === "characters/mara.md")!;
    expect(mara.imagePath).toBe("assets/characters/mara/primary.png");
    await openCanonDossier({ token: local.token, owner: local.book.owner, repo: local.book.repo, branch: local.branch, bookId: local.book.id, section: "characters", file: mara });
    expect(useDossierStore.getState().docked).toMatchObject({ path: "characters/mara.md", imageUrl: expect.stringMatching(/^blob:local-/) });
  });

  it("creates notes, drafts, scripts and resumes next to its local commit", async () => {
    await createNote(local.token, local.book.owner, local.book.repo, local.branch, { title: "A gate of glass", body: "# A gate of glass\n" });
    await createParagraphDraftArtifact(local.token, local.book.owner, local.book.repo, local.branch, { chapterSlug: CHAPTER, number: 1, title: "Opening", paragraphSlug: "001-opening" });
    const script = await createParagraphScriptArtifact(local.token, local.book, local.branch, { chapterSlug: CHAPTER, number: 1, title: "Opening", paragraphSlug: "001-opening" });
    expect(script.changed).toBe(true);
    await createChapterResumeArtifact(local.token, local.book.owner, local.book.repo, local.branch, { chapterSlug: CHAPTER });
    const scope = captureRepositoryOperationScope();
    for (const path of [`drafts/${CHAPTER}/001-opening.md`, `scripts/${CHAPTER}/001-opening.md`, `resumes/chapters/${CHAPTER}.md`]) expect(await getLocalFile(local.meta.id, path, scope), path).not.toBeNull();
  });

  it("deletes a scene of a chapter, with the check of the working copy and no remote check", async () => {
    const chapter = local.structure.chapters[0];
    const closing = chapter.paragraphs[1];
    const head = await resolveRepositoryHeadForMutation({ token: local.token, book: local.book, branch: local.branch });
    const outcome = await reorderParagraphsInChapter(local.token, local.book.owner, local.book.repo, local.branch, chapter.path, chapter.paragraphs, [chapter.paragraphs[0]], "Delete paragraph 002: Closing", { expectedRemoteHeadSha: head, expectedParagraphHashes: { [closing.path]: closing.revision! } });
    expect(outcome.paragraphs.map((paragraph) => paragraph.path)).toEqual([`chapters/${CHAPTER}/001-opening.md`]);
    expect(await getLocalFile(local.meta.id, closing.path, captureRepositoryOperationScope())).toBeNull();
  });

  it("lists its simulated readers and reads the drafts of a rewrite from the working copy", async () => {
    expect((await loadReaderPersonas({ token: local.token, book: local.book, branch: local.branch, structure: local.structure })).length).toBeGreaterThan(0);
    const context = { token: local.token, book: local.book, branch: local.branch, accountScope: localWorkspaceScope() } as Parameters<typeof loadRewriteWorkingCopyText>[0];
    await expect(loadRewriteWorkingCopyText(context, `drafts/${CHAPTER}/002-closing.md`)).resolves.toBeNull();
    await expect(loadRewriteWorkingCopyText(context, `chapters/${CHAPTER}/001-opening.md`)).resolves.toContain("The gate stood open.");
  });

  it("keeps every change in the one local commit of the book", async () => {
    await createNote(local.token, local.book.owner, local.book.repo, local.branch, { title: "Another", body: "# Another\n" });
    expect((await listUnpushedLocalCommits(local.meta.id)).length).toBeLessThanOrEqual(1);
  });
});
