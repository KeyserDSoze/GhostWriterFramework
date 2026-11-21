import { describe, expect, it } from "vitest";
import { slugCode } from "narrarium/slug";
import { defaultPublishRepositoryName, defaultRepositoryName } from "@/narrarium/bookScaffold";

/** GitHub accepts letters, digits, dots, hyphens and underscores in a repository name, and refuses an empty one. */
const REPOSITORY = /^book-[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

describe("the repository name suggested for a new book", () => {
  it("is never empty for a title in a script with no Latin reading", () => {
    for (const title of ["海辺の町", "李明", "الميناء", "바닷가의 아침", "נמל שקט", "शांत बंदरगाह", "ท่าเรือเงียบสงบ"]) {
      expect(defaultRepositoryName(title), title).toBe(`book-${slugCode(title)}`);
      expect(defaultRepositoryName(title), title).toMatch(REPOSITORY);
    }
  });

  it("is always the same for the same title and different for different titles", () => {
    expect(defaultRepositoryName("海辺の町")).toBe(defaultRepositoryName("海辺の町"));
    expect(defaultRepositoryName("海辺の町")).not.toBe(defaultRepositoryName("山の町"));
    expect(defaultRepositoryName("海辺の町")).toBe("book-" + slugCode("海辺の町"));
  });

  it("reads Cyrillic and Greek", () => {
    expect(defaultRepositoryName("Тихая гавань")).toBe("book-tikhaya-gavan");
    expect(defaultRepositoryName("Η μικρή πόλη")).toBe("book-i-mikri-poli");
  });

  it("stays blank for a blank title, so the author is asked for a name", () => {
    expect(defaultRepositoryName("")).toBe("");
    expect(defaultRepositoryName("   ")).toBe("");
  });

  it("keeps the names suggested for Latin titles", () => {
    expect(defaultRepositoryName("The Clockmaker's Daughter")).toBe("book-the-clockmaker-s-daughter");
    expect(defaultRepositoryName("Città di sale")).toBe("book-citta-di-sale");
    expect(defaultRepositoryName("My Book v1.2")).toBe("book-my-book-v1.2");
    expect(defaultRepositoryName("  Crème brûlée!  ")).toBe("book-creme-brulee");
    expect(defaultRepositoryName("___")).toBe("book-___");
    expect(defaultRepositoryName("Глава 1")).toBe("book-1");
  });
});

describe("the repository name suggested when a book on this device is published", () => {
  it("is never just a hyphen for a title in another script", () => {
    expect(defaultPublishRepositoryName("海辺の町")).toBe(`book-${slugCode("海辺の町")}`);
    expect(defaultPublishRepositoryName("Тихая гавань")).toBe("book-tikhaya-gavan");
    expect(defaultPublishRepositoryName("الميناء")).toMatch(REPOSITORY);
    expect(defaultPublishRepositoryName("海辺の町")).toBe(defaultPublishRepositoryName("海辺の町"));
    expect(defaultPublishRepositoryName("海辺の町")).not.toBe(defaultPublishRepositoryName("山の町"));
  });

  it("keeps the name suggested for Latin titles", () => {
    expect(defaultPublishRepositoryName("The Glass Harbor")).toBe("the-glass-harbor");
    expect(defaultPublishRepositoryName("My Book v1.2")).toBe("my-book-v1.2");
    expect(defaultPublishRepositoryName("Città di sale")).toBe("citt-di-sale");
  });
});
