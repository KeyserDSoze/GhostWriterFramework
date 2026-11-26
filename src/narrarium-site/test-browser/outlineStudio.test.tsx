import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OUTLINE_BOOK_FILE, createAutopilotState, outlineChapterPath, outlineEntryDigest, readOutlineChapter, serializeBibleWorld, serializeOutlineBook, serializeOutlineChapter, wholeDesignPatch, outlineDesignOf, type AutopilotState, type PlannedChapter } from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";
import { polyfillRadix } from "./helpers/radix";

// The Synopsis page with its tabs: the design of an entry in its card and the Bible (the book's files composed, the rules of the world edited, the findings of the
// checks).

const mocks = vi.hoisted(() => ({
  store: null as unknown as InstanceType<typeof import("narrarium-engine/testing").MemoryBookStore>,
  book: null as unknown,
  structure: null as unknown,
}));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: mocks.structure, loading: false, error: undefined, reload: vi.fn() }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/outline/outlineSource", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/outline/outlineSource")>();
  return { ...original, browserOutlineSource: () => original.storeOutlineSource(mocks.store) };
});

import i18n from "@/i18n";
import "@/i18n/outline";
import "@/i18n/design";
import { OutlinePage } from "@/pages/OutlinePage";
import type { BookEntry } from "@/types/settings";

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", addedAt: "2026-11-21T00:00:00.000Z" };
const IDEA = "A harbor town built on glass hides a lie that the tide will tell.";
const at = "2026-11-26T09:00:00.000Z";
const TAB_NAMES = ["Synopsis", "Bible"];

let search = "";
function Where() {
  search = useLocation().search;
  return null;
}

function Page({ path = "/app/books/book-1/outline" }: { path?: string }) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/app/books/:bookId/outline" element={<><OutlinePage /><Where /></>} /></Routes>
    </MemoryRouter>
  );
}

async function open(files: Record<string, string>, path?: string) {
  mocks.store = new MemoryBookStore(files);
  mocks.structure = { title: "The Glass Harbor", language: "en", ghostwriter: "default", ghostwriters: [], chapters: [], readerPersonas: [], loadedBranch: "main" };
  render(<Page path={path} />);
  await screen.findByRole("heading", { level: 1, name: t("outline.title") });
  await waitFor(() => expect(screen.queryByText(t("outline.loading"))).not.toBeInTheDocument());
}

async function designed(number: number, title: string) {
  const design = { goal: `Goal of chapter ${number}.`, pov: ["Mira Vale"], characters: ["Mira Vale"], setting: "Glass Harbor", events: [`Event ${number}`], ending: "A door closes.", reveals: number === 2 ? ["The Wall Is Failing"] : [] };
  const patch = wholeDesignPatch(design);
  const body = `Summary of chapter ${number}.`;
  const digest = await outlineEntryDigest({ title, body, design: outlineDesignOf({ design: patch }) });
  return serializeOutlineChapter({ number, title, body, design: patch, origin: "autopilot", digest });
}

function readyState(): AutopilotState {
  const state = createAutopilotState(new Date(at), { idea: IDEA });
  state.concept = { done: true, generated: true, secrets: [{ slug: "the-wall", title: "The Wall Is Failing", revealChapter: 2 }] };
  state.plan = { chapters: [1, 2].map((number) => ({ number, title: `Chapter ${number}`, slug: `00${number}-chapter-${number}`, summary: "", goal: "", pov: [], keyEvents: [], reveals: [], status: "planned", scenes: [] }) as PlannedChapter), approved: true, rounds: 1, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: true };
  state.design = { startedAt: at, chapters: 2, rounds: [{ round: 1, score: 7, verdict: "revise", critical: 1, findings: 2, at }, { round: 2, score: 8.5, verdict: "approve", critical: 0, findings: 0, at }], endedAt: at, outcome: "target" };
  state.status = "paused";
  return state;
}

beforeAll(async () => {
  polyfillRadix();
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  mocks.book = { ...BOOK };
});

afterEach(() => {
  cleanup();
});

describe("the tabs of the Synopsis page", () => {
  it("opens on the Synopsis, keeps the tab in the address, and opens the Bible in its tab and the Synopsis again", async () => {
    await open({ [OUTLINE_BOOK_FILE]: serializeOutlineBook({ body: IDEA, origin: "author" }) });
    const tabs = screen.getByRole("tablist", { name: t("outline.tabs.label") });
    expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(TAB_NAMES);
    expect(within(tabs).getByRole("tab", { name: "Synopsis" })).toHaveAttribute("aria-selected", "true");
    fireEvent.mouseDown(within(tabs).getByRole("tab", { name: "Bible" }), { button: 0 });
    await screen.findByRole("heading", { name: t("design.bible.title") });
    expect(search).toBe("?tab=bible");
    expect(within(tabs).getByRole("tab", { name: "Bible" })).toHaveAttribute("aria-selected", "true");
    fireEvent.mouseDown(within(tabs).getByRole("tab", { name: "Synopsis" }), { button: 0 });
    await waitFor(() => expect(search).toBe(""));
    expect(screen.getByLabelText(t("outline.book.idea"))).toHaveValue(IDEA);
  });
});

describe("the design of an entry in its card", () => {
  it("is closed with how much of it there is, opens with its fields named with the chapter, and is saved with the entry as the author's", async () => {
    await open({ [OUTLINE_BOOK_FILE]: serializeOutlineBook({ body: IDEA, origin: "author" }), [outlineChapterPath(1)]: await designed(1, "Dawn"), [outlineChapterPath(2)]: serializeOutlineChapter({ number: 2, title: "Storm", body: "The storm breaks.", origin: "author" }) });
    const toggle1 = screen.getByRole("button", { name: /Design of chapter 1/ });
    expect(toggle1).toHaveAttribute("aria-expanded", "false");
    expect(toggle1).toHaveTextContent("6 of 17 fields");
    const toggle2 = screen.getByRole("button", { name: /Design of chapter 2/ });
    expect(toggle2).toHaveTextContent(t("outline.design.empty"));
    fireEvent.click(toggle2);
    expect(toggle2).toHaveAttribute("aria-expanded", "true");
    fireEvent.change(screen.getByLabelText("Narrative goal of chapter 2"), { target: { value: "The storm breaks the wall." } });
    fireEvent.change(screen.getByLabelText("Main events of chapter 2"), { target: { value: "The storm\nThe wall cracks" } });
    fireEvent.click(screen.getByLabelText("Ends on a cliffhanger of chapter 2"));
    fireEvent.click(screen.getByRole("button", { name: t("outline.entry.save", { number: 2 }) }));
    await waitFor(async () => {
      const { entry } = await readOutlineChapter(outlineChapterPath(2), 2, mocks.store.files.get(outlineChapterPath(2))!);
      expect(entry.design).toEqual({ goal: "The storm breaks the wall.", events: ["The storm", "The wall cracks"], cliffhanger: true });
      expect(entry.body).toBe("The storm breaks.");
      expect(entry.origin).toBe("author");
    });
  });
});

describe("the Bible", () => {
  it("composes the cast, the world and the secrets with their ledger, edits the rules of the world in bible/, and points the findings to their chapter", async () => {
    await open({
      [OUTLINE_BOOK_FILE]: serializeOutlineBook({ body: IDEA, origin: "author" }),
      [outlineChapterPath(1)]: await designed(1, "Dawn"),
      [outlineChapterPath(2)]: await designed(2, "Storm"),
      "autopilot/state.json": JSON.stringify(readyState()),
      "characters/mira-vale.md": "---\ntype: character\nname: Mira Vale\narc: From silence to voice\n---\n\n# Mira Vale\n\nA stubborn young glassmaker.",
      "locations/glass-harbor.md": "---\ntype: location\nname: Glass Harbor\natmosphere: Cold light\n---\n",
      "secrets/the-wall.md": "---\ntype: secret\ntitle: The Wall Is Failing\nclues:\n  - chapter: 1\n    note: Salt in the cellar\nlearned_by:\n  - character: character:mira-vale\n    chapter: 3\n---\n\n# The Wall Is Failing\n\nThe sea wall cracked years ago.",
      "bible/world.md": serializeBibleWorld({ rules: ["Glass remembers"] }),
      "story-design.md": "---\ntype: note\ntitle: Story Design\n---\n\n> A harbor that lies.\n\n# Story Design\n\nThree movements.",
    }, "/app/books/book-1/outline?tab=bible");
    const bible = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-bible]");
      if (!found) throw new Error("not read yet");
      return found;
    });
    expect(within(bible).getByRole("link", { name: t("design.bible.open", { name: "Mira Vale" }) })).toHaveAttribute("href", "/app/books/book-1/canon/characters/mira-vale");
    const secret = bible.querySelector<HTMLElement>("[data-bible-secret='the-wall']")!;
    // The state of the autopilot is read after the Synopsis: the reveal the plan gives the secret comes with it.
    await waitFor(() => expect(secret.querySelector("[data-secret-reveal]")).toHaveTextContent(t("design.bible.secret.planned", { number: 2 })));
    expect(secret).toHaveTextContent("Chapter 1: Salt in the cellar");
    expect(secret).toHaveTextContent("Mira Vale, chapter 3");
    expect(secret).toHaveTextContent("In chapter 2 the point of view of Mira Vale reveals the secret «The Wall Is Failing», which Mira Vale only learns in chapter 3.");
    // The story design is read as text: its logline and its body, without its title or the marks of the markdown.
    expect(within(bible).getByRole("heading", { name: t("design.bible.premise.storyDesign") }).nextElementSibling?.textContent).toBe("A harbor that lies.\n\nThree movements.");
    const rules = within(bible).getByLabelText(t("design.bible.world.rules"));
    expect(rules).toHaveValue("Glass remembers");
    fireEvent.change(rules, { target: { value: "Glass remembers\nThe tide never lies" } });
    fireEvent.click(within(bible).getByRole("button", { name: t("design.bible.world.save") }));
    await waitFor(() => expect(mocks.store.files.get("bible/world.md")).toContain("- The tide never lies"));
    const checks = bible.querySelector<HTMLElement>("[data-bible-checks]")!;
    fireEvent.click(within(checks).getAllByRole("button", { name: t("design.bible.checks.show", { number: 2 }) })[0]);
    await waitFor(() => expect(search).toBe(""));
  });
});
