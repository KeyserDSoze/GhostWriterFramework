import type { ReactElement } from "react";
import { render, screen, type RenderResult } from "@testing-library/react";
import { serializeOutlineBook, serializeOutlineChapter } from "narrarium-engine";
import { serializeOutlineBrief, type OutlineBriefFields } from "@/autopilot/outlineBrief";

/** The brief and two chapter entries of a book's Scaletta, as the configuration of the autopilot reads them from its store. */
export const SCALETTA_IDEA = "A harbor built on glass.";
export const SCALETTA_SYNOPSIS = "Chapter 1: the wall cracks.\nChapter 2: the council lies.";

/** The idea of the book is the description of `outline/book.md`; the other fields are `outline/_brief.md`. */
function briefFiles(idea: string, fields: OutlineBriefFields): Record<string, string> {
  return {
    "outline/book.md": serializeOutlineBook({ body: idea, origin: "author" }),
    "outline/_brief.md": serializeOutlineBrief(fields),
  };
}

export function scalettaFiles(brief: Partial<OutlineBriefFields & { idea: string }> | null = {}): Record<string, string> {
  const { idea = SCALETTA_IDEA, ...fields } = brief ?? {};
  return {
    ...(brief ? briefFiles(idea, { genre: "mystery", audience: "adults", wordsPerScene: 1400, synopsis: SCALETTA_SYNOPSIS, ...fields }) : {}),
    "outline/chapters/001.md": serializeOutlineChapter({ number: 1, title: "The wall", origin: "author" }),
    "outline/chapters/002.md": serializeOutlineChapter({ number: 2, title: "The lie", origin: "author" }),
  };
}

/**
 * Draws a page that reads the Scaletta, and waits until the brief is read: what the page saves or starts waits for it too, as it does for a person.
 */
export async function renderWithScaletta(element: ReactElement): Promise<RenderResult> {
  const view = render(element);
  await screen.findByText(SCALETTA_IDEA);
  return view;
}

/** The Scaletta of a book with `chapters` chapter entries and the brief's words per scene: what a size creates, or a book that has that many. */
export function sizeFiles(chapters: number, wordsPerScene: number): Record<string, string> {
  const entries = Object.fromEntries(Array.from({ length: chapters }, (_, index) => [`outline/chapters/${String(index + 1).padStart(3, "0")}.md`, serializeOutlineChapter({ number: index + 1, origin: "autopilot" })]));
  return { ...briefFiles(SCALETTA_IDEA, { genre: "mystery", audience: "adults", wordsPerScene, synopsis: SCALETTA_SYNOPSIS }), ...entries };
}
