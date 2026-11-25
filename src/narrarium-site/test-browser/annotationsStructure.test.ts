import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@octokit/rest", () => ({ Octokit: class { rest = {}; } }));

import { renameParagraphWithCompanions, reorderChaptersInBook, reorderParagraphsInChapter } from "@/github/githubClient";
import { buildLocalBookStructure, getLocalFile as getLocalFileScoped, putLocalRepository, removeLocalRepository } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { useAuthStore } from "@/store/authStore";
import { putCleanLocalFile } from "./helpers/localRepositorySeed";
import { ANNOTATION_TAGS_PATH, annotationsChapterPath, emptyBookTags, emptyChapterAnnotations, liveAnnotations, parseChapterAnnotations, serializeBookTags, serializeChapterAnnotations, upsertAnnotation } from "@/annotations/format";
import type { Annotation } from "@/annotations/model";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });
const getLocalFile = (repoId: string, path: string) => getLocalFileScoped(repoId, path, captureRepositoryOperationScope());

function annotation(chapter: string, paragraph: string, id: string): Annotation {
  return { id, chapter, paragraph, quote: "the gate", prefix: "", suffix: " stood", offset: 0, tag: "rewrite", comment: "", status: "open", createdAt: "2026-11-25T10:00:00.000Z", updatedAt: "2026-11-25T10:00:00.000Z", createdOnDevice: "d-1" };
}

const chapterMd = (slug: string, number: number) => `---\ntype: chapter\nid: chapter:${slug}\nnumber: ${number}\ntitle: Title ${slug}\n---\n`;
const sceneMd = (chapter: string, slug: string, number: number) => `---\ntype: paragraph\nid: paragraph:${chapter}:${slug}\nchapter: chapter:${chapter}\nnumber: ${number}\ntitle: ${slug}\n---\n\nThe gate stood open.\n`;

describe("the annotations in the working copy", () => {
  let repoId = "";

  afterEach(async () => {
    if (repoId) await removeLocalRepository(repoId, captureRepositoryOperationScope());
    repoId = "";
  });

  async function seed(files: Record<string, string>) {
    const suffix = crypto.randomUUID();
    const repo = await putLocalRepository({ bookId: `book-${suffix}`, owner: "owner", repo: `repo-${suffix}`, branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: new Date().toISOString(), cloneComplete: true }, captureRepositoryOperationScope());
    repoId = repo.id;
    await Promise.all(Object.entries(files).map(([path, text]) => putCleanLocalFile({ repoId, path, kind: "text", text, size: new TextEncoder().encode(text).byteLength })));
    return repo;
  }

  const annotationsOf = (chapter: string, ...entries: Annotation[]) => serializeChapterAnnotations(entries.reduce(upsertAnnotation, emptyChapterAnnotations(chapter)));

  it("are in the structure of the book with their text, and nothing else of annotations/ is", async () => {
    const text = annotationsOf("001-a", annotation("001-a", "001-x", "a-1"));
    const repo = await seed({
      "book.md": "---\ntitle: Book\n---\n",
      "chapters/001-a/chapter.md": chapterMd("001-a", 1),
      [annotationsChapterPath("001-a")]: text,
      [ANNOTATION_TAGS_PATH]: serializeBookTags(emptyBookTags()),
      "annotations/readme.md": "# not ours",
    });
    const structure = await buildLocalBookStructure(repo);
    expect(structure.annotationFiles?.map((file) => [file.path, file.content === text || file.path === ANNOTATION_TAGS_PATH])).toEqual([
      ["annotations/chapters/001-a.yml", true],
      ["annotations/tags.yml", true],
    ]);
    // They are not searchable texts of the book (the Copilot's search reads .md and .txt).
    expect(structure.searchableFiles?.some((file) => file.path.endsWith(".yml"))).toBe(false);
  });

  it("move with their chapter when the chapters are reordered, with the references to its scenes rewritten", async () => {
    const repo = await seed({
      "book.md": "---\ntitle: Book\n---\n",
      "chapters/001-a/chapter.md": chapterMd("001-a", 1),
      "chapters/001-a/001-x.md": sceneMd("001-a", "001-x", 1),
      "chapters/002-b/chapter.md": chapterMd("002-b", 2),
      [annotationsChapterPath("001-a")]: annotationsOf("001-a", annotation("001-a", "001-x", "a-1")),
      [annotationsChapterPath("002-b")]: annotationsOf("002-b", annotation("002-b", "001-y", "a-2")),
    });
    await reorderChaptersInBook("token", repo.owner, repo.repo, repo.branch, [{ slug: "002-b" }, { slug: "001-a" }]);
    const old = await getLocalFile(repoId, annotationsChapterPath("001-a"));
    expect(old === null || old.status === "deleted").toBe(true);
    const moved = await getLocalFile(repoId, annotationsChapterPath("002-a"));
    expect(moved?.text).toContain("chapter: chapter:002-a");
    expect(moved?.text).toContain("paragraph: paragraph:002-a:001-x");
    const parsed = parseChapterAnnotations(moved!.text!, "002-a");
    expect(parsed.ok && liveAnnotations(parsed.file)[0]).toMatchObject({ id: "a-1", chapter: "002-a", paragraph: "001-x" });
    expect((await getLocalFile(repoId, annotationsChapterPath("001-b")))?.text).toContain("paragraph: paragraph:001-b:001-y");
    const structure = await buildLocalBookStructure(repo);
    expect(structure.annotationFiles?.map((file) => file.path)).toEqual(["annotations/chapters/001-b.yml", "annotations/chapters/002-a.yml"]);
  });

  it("follow their scene when the scenes are reordered or renamed", async () => {
    const repo = await seed({
      "book.md": "---\ntitle: Book\n---\n",
      "chapters/001-a/chapter.md": chapterMd("001-a", 1),
      "chapters/001-a/001-first.md": sceneMd("001-a", "001-first", 1),
      "chapters/001-a/002-second.md": sceneMd("001-a", "002-second", 2),
      [annotationsChapterPath("001-a")]: annotationsOf("001-a", annotation("001-a", "001-first", "a-1"), annotation("001-a", "002-second", "a-2")),
    });
    const structure = await buildLocalBookStructure(repo);
    const chapter = structure.chapters[0];
    const outcome = await reorderParagraphsInChapter("token", repo.owner, repo.repo, repo.branch, chapter.path, chapter.paragraphs, [chapter.paragraphs[1], chapter.paragraphs[0]]);
    const afterReorder = parseChapterAnnotations((await getLocalFile(repoId, annotationsChapterPath("001-a")))!.text!, "001-a");
    expect(afterReorder.ok && liveAnnotations(afterReorder.file).map((entry) => [entry.id, entry.paragraph])).toEqual([["a-1", "002-first"], ["a-2", "001-second"]]);

    const second = outcome.paragraphs.find((paragraph) => paragraph.path.endsWith("001-second.md"))!;
    const current = (await getLocalFile(repoId, second.path))!.text!;
    await renameParagraphWithCompanions("token", repo.owner, repo.repo, repo.branch, chapter.path, second, "chapters/001-a/001-the-bell.md", current, "Rename");
    const afterRename = parseChapterAnnotations((await getLocalFile(repoId, annotationsChapterPath("001-a")))!.text!, "001-a");
    expect(afterRename.ok && liveAnnotations(afterRename.file).map((entry) => [entry.id, entry.paragraph])).toEqual([["a-1", "002-first"], ["a-2", "001-the-bell"]]);
  });
});
