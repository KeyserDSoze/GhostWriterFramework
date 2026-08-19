import { expect, test } from "vitest";
import { contextualNavigationDirection } from "@/hooks/useGlobalShortcuts";
import { resolveContextualNavigation } from "@/lib/contextualNavigation";

test("Alt arrow keys drive contextual navigation without consuming Ctrl/Cmd shortcuts", () => {
  expect(contextualNavigationDirection({ key: "ArrowLeft", altKey: true, ctrlKey: false, metaKey: false, shiftKey: false })).toBe(-1);
  expect(contextualNavigationDirection({ key: "ArrowRight", altKey: true, ctrlKey: false, metaKey: false, shiftKey: false })).toBe(1);
  expect(contextualNavigationDirection({ key: "ArrowRight", altKey: false, ctrlKey: true, metaKey: false, shiftKey: false })).toBe(0);
  expect(contextualNavigationDirection({ key: "n", altKey: false, ctrlKey: true, metaKey: false, shiftKey: false })).toBe(0);
  expect(contextualNavigationDirection({ key: "b", altKey: false, ctrlKey: true, metaKey: false, shiftKey: false })).toBe(0);
});

test("contextual next preserves the view and crosses into the next chapter", () => {
  const structure = {
    chapters: [
      { slug: "001-one", title: "One", path: "chapters/001-one", paragraphs: [{ number: "001", title: "End", path: "chapters/001-one/001-end.md" }] },
      { slug: "002-two", title: "Two", path: "chapters/002-two", paragraphs: [{ number: "001", title: "Start", path: "chapters/002-two/001-start.md" }] },
    ],
  } as any;
  expect(resolveContextualNavigation(structure, "/app/books/book/chapters/001-one/paragraphs/001/workspace/draft", "book").nextHref)
    .toBe("/app/books/book/chapters/002-two/paragraphs/001/workspace/draft");
  expect(resolveContextualNavigation(structure, "/app/books/book/chapters/001-one", "book").nextHref)
    .toBe("/app/books/book/chapters/002-two");
});
