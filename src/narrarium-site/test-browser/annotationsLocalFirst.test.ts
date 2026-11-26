import "fake-indexeddb/auto";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import "@/i18n/annotations";
import { localWorkspaceScope } from "@/account/deviceIdentity";
import { getLocalFile, getLocalRepositoryStatusSnapshot, listUnpushedLocalCommits } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { resetBookStructureLoadCoordinator } from "@/hooks/useBookStructure";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { AnnotationsFileError, changeBookTags, changeChapterAnnotations, deviceTag } from "@/annotations/repository";
import { liveAnnotations, parseBookTags, parseChapterAnnotations, upsertAnnotation, upsertTag } from "@/annotations/format";
import { resetAnnotationOverridesForTests, useBookAnnotations } from "@/annotations/useBookAnnotations";
import type { Annotation, AnnotationTagDefinition } from "@/annotations/model";
import { blockNetwork, createLinkedBookWithoutCredential, createLocalOnlyBook, resetLocalWorkspace, type LocalFirstBook } from "./helpers/localFirst";

// The annotations are files of the book: each one is a local commit of the working copy, published by the next sync. They are read and written without
// GitHub, for a book kept on this device, for a GitHub book without a credential and offline.

const CHAPTER = "001-the-gate";
const PATH = `annotations/chapters/${CHAPTER}.yml`;
const SCENE = "The gate stood open beneath a sky the color of old steel. Mara waited by the wall, counting the lanterns one by one, and nobody came.";
const FILES = [
  { path: `chapters/${CHAPTER}/chapter.md`, content: "---\ntype: chapter\nid: chapter:001-the-gate\nnumber: 1\ntitle: The Gate\n---\n\nThe first chapter.\n" },
  { path: `chapters/${CHAPTER}/001-opening.md`, content: `---\ntype: paragraph\nid: paragraph:001-the-gate:001-opening\nchapter: chapter:001-the-gate\nnumber: 1\ntitle: Opening\n---\n\n${SCENE}\n` },
];

function annotation(id: string, patch: Partial<Annotation> = {}): Annotation {
  const quote = "the color of old steel";
  const offset = SCENE.indexOf(quote);
  return {
    id,
    chapter: CHAPTER,
    paragraph: "001-opening",
    quote,
    prefix: SCENE.slice(Math.max(0, offset - 32), offset),
    suffix: SCENE.slice(offset + quote.length, offset + quote.length + 32),
    offset,
    tag: "rewrite",
    comment: "Find an image of hers.",
    status: "open",
    createdAt: "2026-11-25T10:00:00.000Z",
    updatedAt: "2026-11-25T10:00:00.000Z",
    createdOnDevice: "d-1a2b3c4d",
    ...patch,
  };
}

const SLOW: AnnotationTagDefinition = { id: "slow-pace-k3x9", name: "Slow pace", description: "Cut what does not move the scene.", mark: { underline: "dotted", color: "teal", icon: "clock" }, createdAt: "2026-11-25T10:00:00.000Z", updatedAt: "2026-11-25T10:00:00.000Z" };

const target = (book: LocalFirstBook) => ({ token: book.token, book: book.book, branch: book.branch });
const fileText = async (book: LocalFirstBook, path: string) => (await getLocalFile(book.meta.id, path, captureRepositoryOperationScope()))?.text ?? null;

vi.setConfig({ testTimeout: 60_000 });
beforeAll(() => i18n.changeLanguage("en"));
beforeEach(async () => {
  await resetLocalWorkspace();
  resetAnnotationOverridesForTests();
  resetBookStructureLoadCoordinator();
});
afterEach(() => {
  vi.unstubAllGlobals();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
});

describe.each([
  ["a book kept on this device", () => createLocalOnlyBook("The Annotated Gate", FILES)],
  ["a GitHub book without a credential", () => createLinkedBookWithoutCredential({ files: FILES })],
] as const)("the annotations of %s", (_name, make) => {
  it("are saved as a local commit of the working copy, one after the other, without a single request", async () => {
    const network = blockNetwork();
    const book = await make();
    await changeChapterAnnotations({ ...target(book), chapterSlug: CHAPTER, change: (file) => upsertAnnotation(file, annotation("a-mi4k2000-aaaaaa")), message: `Annotate ${CHAPTER}` });
    await changeChapterAnnotations({ ...target(book), chapterSlug: CHAPTER, change: (file) => upsertAnnotation(file, annotation("a-mi4k3000-bbbbbb", { tag: "keep", comment: "" })), message: `Annotate ${CHAPTER}` });

    const text = await fileText(book, PATH);
    const parsed = parseChapterAnnotations(text!, CHAPTER);
    expect(parsed.ok && liveAnnotations(parsed.file).map((entry) => [entry.id, entry.tag])).toEqual([["a-mi4k2000-aaaaaa", "rewrite"], ["a-mi4k3000-bbbbbb", "keep"]]);
    const status = await getLocalRepositoryStatusSnapshot(book.book.owner, book.book.repo, book.branch, localWorkspaceScope());
    expect(status?.status.dirty).toBe(0);
    const commits = await listUnpushedLocalCommits(book.meta.id);
    expect(commits.flatMap((commit) => commit.files.map((file) => file.path))).toContain(PATH);
    expect(network.requests).toEqual([]);
  });

  it("wait for each other when two are saved at once: both are in the file", async () => {
    const network = blockNetwork();
    const book = await make();
    await Promise.all(["a-mi4k2000-aaaaaa", "a-mi4k3000-bbbbbb", "a-mi4k4000-cccccc"].map((id) => changeChapterAnnotations({ ...target(book), chapterSlug: CHAPTER, change: (file) => upsertAnnotation(file, annotation(id)), message: `Annotate ${CHAPTER}` })));
    const parsed = parseChapterAnnotations((await fileText(book, PATH))!, CHAPTER);
    expect(parsed.ok && liveAnnotations(parsed.file)).toHaveLength(3);
    expect(network.requests).toEqual([]);
  });

  it("never replace a file they cannot read, nor one of a newer version", async () => {
    blockNetwork();
    const broken = "version: 1\nchapter: chapter:001-the-gate\nannotations: [unclosed\n";
    const newer = "version: 2\nchapter: chapter:001-the-gate\nannotations: []\n";
    for (const content of [broken, newer]) {
      await resetLocalWorkspace();
      const book = await (_name === "a book kept on this device"
        ? createLocalOnlyBook("The Annotated Gate", [...FILES, { path: PATH, content }])
        : createLinkedBookWithoutCredential({ files: [...FILES, { path: PATH, content }] }));
      const write = changeChapterAnnotations({ ...target(book), chapterSlug: CHAPTER, change: (file) => upsertAnnotation(file, annotation("a-mi4k2000-aaaaaa")), message: `Annotate ${CHAPTER}` });
      await expect(write).rejects.toBeInstanceOf(AnnotationsFileError);
      await expect(write).rejects.toMatchObject({ problem: content === broken ? "unreadable" : "newer-version", path: PATH });
      expect(await fileText(book, PATH)).toBe(content);
    }
  });

  it("have tags of the book in their own file", async () => {
    const network = blockNetwork();
    const book = await make();
    await changeBookTags({ ...target(book), change: (file) => upsertTag(file, SLOW), message: "Add the tag Slow pace" });
    const parsed = parseBookTags((await fileText(book, "annotations/tags.yml"))!);
    expect(parsed.ok && parsed.file.tags).toEqual([SLOW]);
    expect(network.requests).toEqual([]);
  });
});

describe("the annotations of a book on the screen", () => {
  it("show what this tab saved at once, with the tags of the book, of the account and the built-in ones, and nothing goes to GitHub", async () => {
    const network = blockNetwork();
    const book = await createLocalOnlyBook("The Annotated Gate", FILES);
    const global: AnnotationTagDefinition = { ...SLOW, id: "doubt-1a2b", name: "Doubt" };
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [book.book], annotations: { tags: [global, { ...global, id: "gone-3c4d", name: "Gone", deletedAt: "2026-11-24T00:00:00.000Z" }] } } });

    const { result } = renderHook(() => useBookAnnotations(book.book.id));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.chapters.size).toBe(0);
    expect(result.current.catalog.map((entry) => [entry.id, entry.scope])).toEqual([
      ["rewrite", "builtin"], ["dislike", "builtin"], ["inconsistency", "builtin"], ["expand", "builtin"], ["keep", "builtin"], ["doubt-1a2b", "global"],
    ]);

    await act(() => result.current.saveBookTag(SLOW));
    await act(() => result.current.saveAnnotation(annotation("a-mi4k2000-aaaaaa", { tag: SLOW.id })));
    expect(result.current.catalog[result.current.catalog.length - 1]).toMatchObject({ id: SLOW.id, scope: "book" });
    expect(result.current.bookTags.map((entry) => entry.id)).toEqual([SLOW.id]);
    expect(result.current.chapters.get(CHAPTER)?.annotations.map((entry) => entry.id)).toEqual(["a-mi4k2000-aaaaaa"]);

    await act(() => result.current.deleteAnnotation({ id: "a-mi4k2000-aaaaaa", chapter: CHAPTER }));
    expect(result.current.chapters.get(CHAPTER)?.annotations).toEqual([]);
    await act(() => result.current.deleteBookTag(SLOW.id));
    expect(result.current.bookTags).toEqual([]);
    expect(network.requests).toEqual([]);
  });

  it("say which file cannot be read, and show the others", async () => {
    blockNetwork();
    const book = await createLocalOnlyBook("The Annotated Gate", [...FILES, { path: PATH, content: "annotations: [unclosed\n" }, { path: "annotations/chapters/002-the-courtyard.yml", content: "version: 1\nchapter: chapter:002-the-courtyard\nannotations: []\n" }]);
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [book.book] } });
    const { result } = renderHook(() => useBookAnnotations(book.book.id));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.chapters.get(CHAPTER)).toMatchObject({ path: PATH, annotations: [] });
    expect(result.current.chapters.get(CHAPTER)?.error).toBeTruthy();
    expect(result.current.chapters.get("002-the-courtyard")?.error).toBeUndefined();
  });
});

describe("the device an annotation was made on", () => {
  it("is a short tag derived from the device, never its id, the same every time", async () => {
    const first = await deviceTag();
    expect(first).toMatch(/^d-[0-9a-f]{8}$/);
    expect(await deviceTag()).toBe(first);
  });
});
