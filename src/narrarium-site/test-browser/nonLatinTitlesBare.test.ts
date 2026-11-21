import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";

// A screen test that replaces the translation hooks must still be able to load the book code, so the code that
// reads a book never depends on the translations being set up: it falls back to English.
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { loadBookStructure } from "@/github/githubClient";
import { generatedNameLabel, renumberedTitle } from "@/lib/fallbackTitle";
import { buildLocalBookStructure, putLocalRepository, removeLocalRepository } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { useAuthStore } from "@/store/authStore";
import { putCleanLocalFile } from "./helpers/localRepositorySeed";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

describe("the names of untitled things before any translation is loaded", () => {
  it("are in English, with the number and the date", () => {
    expect(generatedNameLabel("002-scene")).toBe("Scene 2");
    expect(generatedNameLabel("012-chapter")).toBe("Chapter 12");
    expect(generatedNameLabel("character-0crj2m")).toBe("Character");
    expect(generatedNameLabel("timeline-event-0crj2m")).toBe("Timeline event");
    expect(generatedNameLabel("2026-11-21-research-0crj2m")).toBe("Research 2026-11-21");
    expect(generatedNameLabel("001-the-gate")).toBeNull();
    expect(renumberedTitle("Scene 3", "003-scene", "001-scene")).toBe("Scene 1");
  });

  it("are given by the structure of a book read from a working copy", async () => {
    const suffix = crypto.randomUUID();
    const repo = await putLocalRepository({ bookId: `book-${suffix}`, owner: "owner", repo: `repo-${suffix}`, branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: new Date().toISOString(), cloneComplete: true }, captureRepositoryOperationScope());
    try {
      for (const [path, text] of Object.entries({ "chapters/001-chapter/chapter.md": "---\ntype: chapter\n---\n", "chapters/001-chapter/002-scene.md": "---\ntype: paragraph\n---\n", "characters/character-0crj2m.md": "---\ntype: character\n---\n" })) {
        await putCleanLocalFile({ repoId: repo.id, path, kind: "text", text, size: text.length });
      }
      const structure = await buildLocalBookStructure(repo);
      expect(structure.chapters.map((chapter) => chapter.title)).toEqual(["Chapter 1"]);
      expect(structure.chapters[0].paragraphs.map((scene) => scene.title)).toEqual(["Scene 2"]);
      expect(structure.characters.map((file) => file.name)).toEqual(["Character"]);
      expect(typeof loadBookStructure).toBe("function");
    } finally {
      await removeLocalRepository(repo.id, captureRepositoryOperationScope());
    }
  });
});
