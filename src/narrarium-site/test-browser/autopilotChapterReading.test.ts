import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalWorkingCopyMissingError } from "@/autopilot/browserStore";
import {
  arrowStep,
  chapterLinkClick,
  chapterNeighbours,
  compareScenePaths,
  FIRST_SCENES,
  isPlainClick,
  isSceneFile,
  MORE_SCENES,
  moreScenes,
  sceneNumber,
  sceneTitle,
} from "@/autopilot/chapterReading";
import { readChapterScenes } from "@/autopilot/chapterText";
import { putLocalRepository, removeLocalRepository } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { useAuthStore } from "@/store/authStore";
import type { BookEntry } from "@/types/settings";
import { deleteLocalFile, putCleanLocalFile } from "./helpers/localRepositorySeed";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

const book: BookEntry = { id: "book-reading", owner: "owner", repo: "reading", name: "The Glass Harbor", tokenIndex: null, addedAt: "2026-11-27T00:00:00.000Z" };
let repoId = "";

afterEach(async () => {
  if (repoId) await removeLocalRepository(repoId, captureRepositoryOperationScope());
  repoId = "";
});

async function seed(files: Record<string, string>, cloneComplete = true): Promise<string> {
  const repo = await putLocalRepository({ bookId: book.id, owner: book.owner, repo: book.repo, branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: "2026-11-27T00:00:00.000Z", cloneComplete }, captureRepositoryOperationScope());
  for (const [path, text] of Object.entries(files)) await putCleanLocalFile({ repoId: repo.id, path, kind: "text", text, size: new TextEncoder().encode(text).length });
  repoId = repo.id;
  return repo.id;
}

const click = (patch: Partial<Parameters<typeof isPlainClick>[0]> = {}) => ({ button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, defaultPrevented: false, ...patch });

describe("which click opens a chapter in the window", () => {
  it("is the main button with no key held; every other one follows the link, as a link does", () => {
    expect(isPlainClick(click())).toBe(true);
    for (const patch of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { button: 2 }, { defaultPrevented: true }]) {
      expect(isPlainClick(click(patch)), JSON.stringify(patch)).toBe(false);
    }
  });

  it("is handled in the place of the link, with the link given to the window so that the focus goes back to it", () => {
    const open = vi.fn();
    const link = document.createElement("a");
    const preventDefault = vi.fn();
    chapterLinkClick(open, "002-the-tide")?.({ ...click(), currentTarget: link, preventDefault });
    expect(open).toHaveBeenCalledWith("002-the-tide", link);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it("leaves the link alone for a click that asks for another tab, and for a page that cannot open the window", () => {
    const open = vi.fn();
    const preventDefault = vi.fn();
    chapterLinkClick(open, "002-the-tide")?.({ ...click({ ctrlKey: true }), currentTarget: document.createElement("a"), preventDefault });
    expect(open).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(chapterLinkClick(undefined, "002-the-tide"), "no window to open: the link has no handler at all").toBeUndefined();
  });
});

describe("the chapters around one", () => {
  const plan = [{ slug: "001-a" }, { slug: "002-b" }, { slug: "003-c" }, { slug: "004-d" }];

  it("are the ones before and after it among the chapters the book has, by their folders", () => {
    const has = new Set(["001-a", "002-b", "004-d"]);
    expect(chapterNeighbours(plan, has, "002-b")).toEqual({ previous: "001-a", next: "004-d", position: 2, total: 3 });
    expect(chapterNeighbours(plan, has, "001-a")).toEqual({ previous: null, next: "002-b", position: 1, total: 3 });
    expect(chapterNeighbours(plan, has, "004-d")).toEqual({ previous: "002-b", next: null, position: 3, total: 3 });
  });

  it("say nothing of a chapter the book does not have, and of a book with no chapter", () => {
    expect(chapterNeighbours(plan, new Set(["001-a"]), "003-c")).toEqual({ previous: null, next: null, position: 0, total: 1 });
    expect(chapterNeighbours([], new Set(), "001-a")).toEqual({ previous: null, next: null, position: 0, total: 0 });
  });

  it("tell two folders with one number apart: the folder is the chapter, not its number", () => {
    const twins = [{ slug: "003-old" }, { slug: "003-new" }, { slug: "004-next" }];
    expect(chapterNeighbours(twins, new Set(["003-old", "003-new", "004-next"]), "003-new")).toEqual({ previous: "003-old", next: "004-next", position: 2, total: 3 });
  });
});

describe("the arrow keys of the window", () => {
  const key = (value: string, patch: Record<string, unknown> = {}) => ({ key: value, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, target: document.body, ...patch });

  it("go to the chapter before (left) and after (right), and nothing else does", () => {
    expect(arrowStep(key("ArrowLeft"))).toBe(-1);
    expect(arrowStep(key("ArrowRight"))).toBe(1);
    expect(arrowStep(key("ArrowUp"))).toBe(0);
    expect(arrowStep(key("PageDown"))).toBe(0);
    expect(arrowStep(key("a"))).toBe(0);
  });

  it("are left to the browser with a modifier (Alt+Left is the way back), in a field, and in a table that scrolls sideways", () => {
    for (const patch of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { defaultPrevented: true }]) expect(arrowStep(key("ArrowRight", patch)), JSON.stringify(patch)).toBe(0);
    const field = document.createElement("input");
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const region = document.createElement("div");
    region.setAttribute("data-own-arrows", "");
    const cell = document.createElement("td");
    region.append(cell);
    for (const target of [field, editor, cell]) expect(arrowStep(key("ArrowRight", { target })), target.tagName).toBe(0);
    const plain = document.createElement("div");
    plain.setAttribute("contenteditable", "false");
    expect(arrowStep(key("ArrowRight", { target: plain }))).toBe(1);
  });
});

describe("the files the window may read", () => {
  it("are the Markdown files directly in the folder of the chapter, and not its chapter.md", () => {
    expect(isSceneFile("chapters/001-a/001-scene.md", "001-a")).toBe(true);
    expect(isSceneFile("chapters/001-a/chapter.md", "001-a")).toBe(false);
  });

  it("are never the canon, a secret in particular, nor another chapter's file, nor a path that goes out of the folder", () => {
    for (const path of ["secrets/the-lie.md", "characters/mira.md", "chapters/002-b/001-scene.md", "chapters/001-a/drafts/001-scene.md", "chapters/001-a/../../secrets/the-lie.md", "chapters/001-a/001-scene.txt", "chapters/001-a/.md", "chapters/001-ab/001-scene.md", "book.md"]) {
      expect(isSceneFile(path, "001-a"), path).toBe(false);
    }
  });
});

describe("the scenes of a chapter", () => {
  it("are in the order of their numbers, which go past 999", () => {
    const paths = ["chapters/c/1000-late.md", "chapters/c/002-two.md", "chapters/c/999-nine.md", "chapters/c/010-ten.md", "chapters/c/001-one.md"];
    expect([...paths].sort(compareScenePaths).map((path) => sceneNumber(path))).toEqual([1, 2, 10, 999, 1000]);
  });

  it("have the number their file begins with, and none when it begins with a letter", () => {
    expect(sceneNumber("chapters/001-a/007-the-tide.md")).toBe(7);
    expect(sceneNumber("chapters/001-a/prologue.md")).toBeNull();
  });

  it("have the title their frontmatter says, else the words of their file name", () => {
    expect(sceneTitle("chapters/a/002-the-tide-table.md", "  Low Water ")).toBe("Low Water");
    expect(sceneTitle("chapters/a/002-the-tide-table.md")).toBe("The tide table");
    expect(sceneTitle("chapters/a/002-the-tide-table.md", 42)).toBe("The tide table");
    expect(sceneTitle("chapters/a/003.md")).toBeNull();
  });

  it("are drawn a few at first and a few more each time, up to the last", () => {
    expect(FIRST_SCENES).toBeGreaterThan(0);
    expect(moreScenes(FIRST_SCENES, 100)).toBe(FIRST_SCENES + MORE_SCENES);
    expect(moreScenes(98, 100)).toBe(100);
    expect(moreScenes(100, 100)).toBe(100);
  });
});

describe("the text of a chapter in the working copy", () => {
  const SCENE_ONE = "---\ntype: paragraph\ntitle: The Gate\n---\nMira reached the gate.";
  const SCENE_TWO = "---\ntype: paragraph\n---\nThe tide came in.";

  it("is its scenes, in order, read from the folder of the chapter alone", async () => {
    await seed({
      "book.md": "---\ntype: book\n---\n",
      "chapters/001-wake/chapter.md": "---\ntype: chapter\n---\nThe chapter's own notes.",
      "chapters/001-wake/002-tide.md": SCENE_TWO,
      "chapters/001-wake/001-gate.md": SCENE_ONE,
      "chapters/001-wake/drafts/001-gate.md": "A draft that is not a scene.",
      "chapters/002-key/001-key.md": "The next chapter's text.",
      "secrets/the-lie.md": "---\ntype: secret\nreveal_in: chapter:009\n---\nThe harbor master is the thief.",
      "characters/mira.md": "---\ntype: character\n---\nMira.",
    });
    const scenes = await readChapterScenes(book, "main", "001-wake");
    expect(scenes).toEqual([
      { path: "chapters/001-wake/001-gate.md", text: SCENE_ONE },
      { path: "chapters/001-wake/002-tide.md", text: SCENE_TWO },
    ]);
    expect(JSON.stringify(scenes)).not.toContain("harbor master");
  });

  it("leaves out a scene that was deleted since", async () => {
    const id = await seed({ "chapters/001-wake/001-gate.md": SCENE_ONE, "chapters/001-wake/002-tide.md": SCENE_TWO });
    await deleteLocalFile(id, "chapters/001-wake/002-tide.md");
    expect((await readChapterScenes(book, "main", "001-wake")).map((scene) => scene.path)).toEqual(["chapters/001-wake/001-gate.md"]);
  });

  it("is nothing for a chapter without scenes", async () => {
    await seed({ "chapters/001-wake/chapter.md": "---\ntype: chapter\n---\n" });
    expect(await readChapterScenes(book, "main", "001-wake")).toEqual([]);
  });

  it("is not read for a book that has no working copy here yet, or whose copy is not whole", async () => {
    await expect(readChapterScenes(book, "main", "001-wake")).rejects.toBeInstanceOf(LocalWorkingCopyMissingError);
    await seed({ "chapters/001-wake/001-gate.md": SCENE_ONE }, false);
    await expect(readChapterScenes(book, "main", "001-wake")).rejects.toBeInstanceOf(LocalWorkingCopyMissingError);
  });
});
