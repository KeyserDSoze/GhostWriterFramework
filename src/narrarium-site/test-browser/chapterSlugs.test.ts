import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";

const octokit = vi.hoisted(() => ({ getRepo: vi.fn(), getTree: vi.fn() }));

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    rest = { repos: { get: octokit.getRepo }, git: { getTree: octokit.getTree } };
  },
}));

import { chapterNumberFromSlug, chapterSlugWithoutNumber, chapterTitleFromSlug, compareChapterFolders, compareChapterSlugs, nextChapterNumber } from "@/lib/chapterSlug";
import { loadBookStructure, reorderChaptersInBook } from "@/github/githubClient";
import { buildLocalBookStructure, getLocalFile as getLocalFileScoped, putLocalRepository, removeLocalRepository } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { useAuthStore } from "@/store/authStore";
import { resolveChapterTarget } from "@/assistant/targetRules";
import { putCleanLocalFile } from "./helpers/localRepositorySeed";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

const getLocalFile = (repoId: string, path: string) => getLocalFileScoped(repoId, path, captureRepositoryOperationScope());

/** In the order a book is read: three digits up to 999, then as many digits as the number needs. */
const READING_ORDER = ["001-the-gate", "002-b", "010-j", "099-x", "100-a", "101-a", "999-x", "1000-the-end", "1001-after", "12345-x", "100000-last"];

describe("chapter folder names", () => {
  it("read the number of a chapter whatever its number of digits", () => {
    expect(chapterNumberFromSlug("001-the-gate")).toBe(1);
    expect(chapterNumberFromSlug("999-x")).toBe(999);
    expect(chapterNumberFromSlug("1000-the-end")).toBe(1000);
    expect(chapterNumberFromSlug("12345-x")).toBe(12345);
    expect(chapterNumberFromSlug("007")).toBe(7);
    expect(chapterNumberFromSlug("0001-padded")).toBe(1);
    expect(chapterNumberFromSlug("100-2024-the-year")).toBe(100);
  });

  it("have no number when the folder is not numbered", () => {
    expect(chapterNumberFromSlug("prologue")).toBeNull();
    expect(chapterNumberFromSlug("")).toBeNull();
    expect(chapterNumberFromSlug("x-1000")).toBeNull();
    expect(chapterNumberFromSlug("12-two-digits")).toBeNull();
    expect(chapterNumberFromSlug("1000x")).toBeNull();
    expect(chapterNumberFromSlug("99999999999999999999-too-big")).toBeNull();
  });

  it("keep the title once the number is taken away", () => {
    expect(chapterSlugWithoutNumber("1000-the-end")).toBe("the-end");
    expect(chapterSlugWithoutNumber("12345-x")).toBe("x");
    expect(chapterSlugWithoutNumber("001-100-years")).toBe("100-years");
    expect(chapterSlugWithoutNumber("007")).toBe("");
    expect(chapterSlugWithoutNumber("prologue")).toBe("prologue");
  });

  it("make a readable title when the chapter has none", () => {
    expect(chapterTitleFromSlug("001-the-gate")).toBe("The Gate");
    expect(chapterTitleFromSlug("1000-the-end")).toBe("The End");
    expect(chapterTitleFromSlug("12345-x")).toBe("X");
    expect(chapterTitleFromSlug("002-100-years-war")).toBe("100 Years War");
    expect(chapterTitleFromSlug("prologue")).toBe("Prologue");
    expect(chapterTitleFromSlug("007")).toBe("007");
  });

  it("sort by number, not by text: 999 comes before 1000 and 12345 after 1001", () => {
    const interleaved = READING_ORDER.map((_, index) => READING_ORDER[(index * 4) % READING_ORDER.length]);
    expect(new Set(interleaved).size).toBe(READING_ORDER.length);
    expect(interleaved.sort(compareChapterSlugs)).toEqual(READING_ORDER);
    expect([...READING_ORDER].reverse().sort(compareChapterSlugs)).toEqual(READING_ORDER);
    expect(compareChapterFolders("chapters/999-x", "chapters/1000-the-end")).toBeLessThan(0);
    expect(compareChapterFolders("chapters/1000-the-end", "chapters/999-x")).toBeGreaterThan(0);
  });

  it("sort like before for the books that fit in three digits, with unnumbered folders last", () => {
    const folders = ["chapters/003-c", "chapters/001-a-b", "chapters/001-a", "chapters/prologue", "chapters/002-b", "chapters/appendix"];
    expect([...folders].sort(compareChapterFolders)).toEqual(["chapters/001-a", "chapters/001-a-b", "chapters/002-b", "chapters/003-c", "chapters/appendix", "chapters/prologue"]);
    expect([...folders].sort(compareChapterFolders)).toEqual([...folders].sort());
    expect(compareChapterSlugs("001-a", "001-a")).toBe(0);
  });

  it("give the next chapter number of a book of any length, without spreading it into arguments", () => {
    expect(nextChapterNumber([])).toBe(1);
    expect(nextChapterNumber(["001-a", "002-b"])).toBe(3);
    expect(nextChapterNumber(["001-a", "1000-the-end", "999-x"])).toBe(1001);
    expect(nextChapterNumber(["prologue", "12345-x"])).toBe(12346);
    const huge = Array.from({ length: 200_000 }, (_, index) => `${String(index + 1).padStart(3, "0")}-chapter`);
    expect(nextChapterNumber(huge)).toBe(200_001);
  });

  it("are found by the number someone asks for in the assistant", () => {
    const chapters = ["999-x", "1000-the-end", "12345-x"].map((slug) => ({ slug, title: slug, paragraphs: [] }));
    expect(resolveChapterTarget("evaluate chapter 1000", chapters, null).value?.slug).toBe("1000-the-end");
    expect(resolveChapterTarget("evaluate chapter 12345", chapters, null).value?.slug).toBe("12345-x");
    expect(resolveChapterTarget("evaluate chapter 999", chapters, null).value?.slug).toBe("999-x");
  });
});

describe("a book with more than 999 chapters in a local working copy", () => {
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

  const chapterFiles = (slugs: string[], withTitle = true) => Object.fromEntries(slugs.map((slug) => [`chapters/${slug}/chapter.md`, withTitle ? `---\ntype: chapter\nid: chapter:${slug}\ntitle: Title of ${slug}\n---\n` : "---\ntype: chapter\n---\n"]));

  it("lists the chapters in reading order", async () => {
    const repo = await seed({ "book.md": "---\ntitle: Long Book\n---\n", ...chapterFiles(["100-a", "1000-the-end", "999-x", "101-a", "12345-x", "001-the-gate"]) });
    const structure = await buildLocalBookStructure(repo);
    expect(structure.chapters.map((chapter) => chapter.slug)).toEqual(["001-the-gate", "100-a", "101-a", "999-x", "1000-the-end", "12345-x"]);
  });

  it("titles a chapter without a title after its name, not after what is left of its number", async () => {
    const repo = await seed({ "book.md": "---\ntitle: Long Book\n---\n", ...chapterFiles(["1000-the-end", "12345-x", "007-seven"], false) });
    const structure = await buildLocalBookStructure(repo);
    expect(Object.fromEntries(structure.chapters.map((chapter) => [chapter.slug, chapter.title]))).toEqual({ "007-seven": "Seven", "1000-the-end": "The End", "12345-x": "X" });
  });

  it("renumbers the chapters of a reorder and keeps the whole title part of their folder", async () => {
    const repo = await seed({ "book.md": "---\ntitle: Long Book\n---\n", ...chapterFiles(["1000-the-end", "1001-epilogue"]) });
    const outcome = await reorderChaptersInBook("token", repo.owner, repo.repo, repo.branch, [{ slug: "1001-epilogue" }, { slug: "1000-the-end" }]);
    expect([...outcome.remap]).toEqual([["1001-epilogue", "001-epilogue"], ["1000-the-end", "002-the-end"]]);
    expect((await getLocalFile(repoId, "chapters/002-the-end/chapter.md"))?.text).toContain("id: chapter:002-the-end");
  });
});

describe("a book with more than 999 chapters on GitHub", () => {
  it("lists the chapters in reading order and titles an untitled one after its name", async () => {
    octokit.getRepo.mockResolvedValue({ data: { default_branch: "main" } });
    const paths = ["chapters/100-a/chapter.md", "chapters/1000-the-end/chapter.md", "chapters/999-x/chapter.md", "chapters/101-a/chapter.md", "chapters/12345-x/chapter.md", "chapters/001-the-gate/chapter.md"];
    octokit.getTree.mockResolvedValue({ data: { tree: paths.map((path) => ({ path, type: "blob", sha: `sha-${path}`, size: 10 })) } });

    const structure = await loadBookStructure("token", "owner", "repo");
    expect(structure.chapters.map((chapter) => chapter.slug)).toEqual(["001-the-gate", "100-a", "101-a", "999-x", "1000-the-end", "12345-x"]);
    expect(Object.fromEntries(structure.chapters.map((chapter) => [chapter.slug, chapter.title]))).toMatchObject({ "1000-the-end": "The End", "12345-x": "X", "001-the-gate": "The Gate" });
  });
});
