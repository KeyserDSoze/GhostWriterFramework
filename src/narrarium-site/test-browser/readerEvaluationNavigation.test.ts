import { describe, expect, it, vi } from "vitest";

// Catalog validation is covered separately; these tests isolate intent precedence.
vi.mock("@/assistant/tools/catalogValidation", () => ({ validateToolCatalog: () => undefined }));

import { chooseToolMatch } from "@/assistant/orchestrator";
import { resolveNavigateAction } from "@/assistant/planner";
import type { LoadedWriterContext } from "@/assistant/context";
import type { AppSettings } from "@/types/settings";

const chapter = {
  slug: "001-start",
  title: "Start",
  path: "chapters/001-start",
  paragraphs: [{ number: "001", title: "Opening", path: "chapters/001-start/001-opening.md" }],
};
const context = {
  structure: { chapters: [chapter] },
  chapter,
  paragraph: chapter.paragraphs[0],
} as unknown as LoadedWriterContext;
const settings = {} as AppSettings;
const handlers = new Set(["open-reader-evaluations", "open-reader", "navigate"]);

describe("reader-evaluation navigation intent", () => {
  it.each([
    "open reader evaluations",
    "show reader evaluations",
    "apri valutazioni lettori",
    "mostra valutazioni dei lettori",
  ])("routes the bilingual specific intent before generic reader navigation: %s", (prompt) => {
    expect(resolveNavigateAction(prompt, context, "book")).toMatchObject({
      to: "/app/books/book/chapters/001-start/paragraphs/001/reader-evaluations",
      label: "Reader evaluations",
    });
    expect(chooseToolMatch({ prompt, lowered: prompt.toLowerCase(), settings }, handlers)).toMatchObject({
      toolId: "open-reader-evaluations",
      handlerId: "open-reader-evaluations",
    });
  });

  it.each([
    "open reader evaluations for paragraph 1",
    "apri valutazioni lettori del paragrafo 1",
  ])("routes explicit bilingual paragraph targets to their reader evaluations: %s", (prompt) => {
    expect(resolveNavigateAction(prompt, context, "book")).toMatchObject({
      to: "/app/books/book/chapters/001-start/paragraphs/001/reader-evaluations",
      label: "Reader evaluations",
    });
    expect(chooseToolMatch({ prompt, lowered: prompt.toLowerCase(), settings }, handlers)).toMatchObject({
      toolId: "open-reader-evaluations",
      handlerId: "open-reader-evaluations",
    });
  });

  it.each([
    ["open reader", "/app/books/book/reader", "open-reader"],
    ["apri lettore", "/app/books/book/reader", "open-reader"],
  ])("preserves generic reader navigation: %s", (prompt, route, toolId) => {
    expect(resolveNavigateAction(prompt, context, "book")).toMatchObject({ to: route });
    expect(chooseToolMatch({ prompt, lowered: prompt.toLowerCase(), settings }, handlers)).toMatchObject({ toolId });
  });
});
