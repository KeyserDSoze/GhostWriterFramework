import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OUTLINE_BOOK_FILE, createAutopilotState, outlineChapterPath, outlineEntryDigest, parseMarkdown, readOutlineChapter, serializeBibleWorld, serializeOutlineBook, serializeOutlineChapter, wholeDesignPatch, outlineDesignOf, type AutopilotState, type PlannedChapter } from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";
import { polyfillRadix } from "./helpers/radix";

// The Synopsis page with its tabs: the design of an entry in its card, the Studio (the design run of the autopilot: the dialog that starts it, its progress, the design ready
// to approve or to write from) and the Bible (the book's files composed, the rules of the world edited, the findings of the checks).

const mocks = vi.hoisted(() => ({
  store: null as unknown as InstanceType<typeof import("narrarium-engine/testing").MemoryBookStore>,
  book: null as unknown,
  structure: null as unknown,
  runtime: {
    start: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
    pause: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
    refresh: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
    describeError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  },
}));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: mocks.structure, loading: false, error: undefined, reload: vi.fn() }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/outline/outlineSource", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/outline/outlineSource")>();
  return { ...original, browserOutlineSource: () => original.storeOutlineSource(mocks.store) };
});
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/autopilot/useBookFiles", () => ({ useBookFiles: () => ({ files: new Map(), failed: false }) }));

import i18n from "@/i18n";
import "@/i18n/outline";
import "@/i18n/design";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { useAutopilotStore } from "@/autopilot/store";
import { OutlinePage } from "@/pages/OutlinePage";
import type { BookEntry } from "@/types/settings";

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", addedAt: "2026-11-21T00:00:00.000Z" };
const IDEA = "A harbor town built on glass hides a lie that the tide will tell.";
const at = "2026-11-26T09:00:00.000Z";
const TAB_NAMES = ["Synopsis", "Bible", "Studio"];

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
  await loadAutopilotTranslations();
});

beforeEach(() => {
  mocks.book = { ...BOOK };
  mocks.runtime.start = vi.fn(async () => undefined);
  mocks.runtime.pause = vi.fn(async () => undefined);
  mocks.runtime.refresh = vi.fn(async () => null);
  useAutopilotStore.setState((state) => ({ views: {}, summaries: {}, server: { ...state.server, info: null } }));
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

  it("calls the author to design the book, and the call opens the Studio", async () => {
    await open({ [OUTLINE_BOOK_FILE]: serializeOutlineBook({ body: IDEA, origin: "author" }) });
    const tabs = screen.getByRole("tablist", { name: t("outline.tabs.label") });
    const cta = document.querySelector<HTMLElement>("[data-design-cta]")!;
    expect(within(cta).getByRole("heading", { name: t("outline.designCta.title") })).toBeInTheDocument();
    fireEvent.click(within(cta).getByRole("button", { name: t("outline.designCta.open") }));
    await screen.findByRole("heading", { name: t("design.studio.title") });
    expect(search).toBe("?tab=studio");
    expect(within(tabs).getByRole("tab", { name: "Studio" })).toHaveAttribute("aria-selected", "true");
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

describe("the Studio", () => {
  it("cannot design a book without a description, and says why", async () => {
    await open({}, "/app/books/book-1/outline?tab=studio");
    const button = await screen.findByRole("button", { name: t("design.studio.start") });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(t("design.studio.blocked.description"));
  });

  it("cannot design a book on a personal server that does not announce it, and says from which version it can", async () => {
    mocks.book = { ...BOOK, autopilotHost: "server" };
    useAutopilotStore.setState((state) => ({ server: { ...state.server, info: { serverId: "s", name: "Home", version: "0.1.19", protocol: 1, features: ["autopilot", "autopilot-review-policy"] } as never } }));
    await open({ [OUTLINE_BOOK_FILE]: serializeOutlineBook({ body: IDEA, origin: "author" }) }, "/app/books/book-1/outline?tab=studio");
    const button = await screen.findByRole("button", { name: t("design.studio.start") });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("Your personal server is older than 0.1.20 and cannot design a book: update it to do this from here.");
  });

  it("starts a design run with the chapters and the policy of the dialog, and nothing that writes", async () => {
    await open({ [OUTLINE_BOOK_FILE]: serializeOutlineBook({ body: IDEA, origin: "author" }) }, "/app/books/book-1/outline?tab=studio");
    fireEvent.click(await screen.findByRole("button", { name: t("design.studio.start") }));
    const dialog = await screen.findByRole("dialog", { name: t("design.dialog.title") });
    expect(within(dialog).getByLabelText(t("design.dialog.chapters.label"))).toHaveValue("12");
    fireEvent.change(within(dialog).getByLabelText(t("design.dialog.chapters.label")), { target: { value: "8" } });
    fireEvent.change(within(dialog).getByLabelText(t("autopilot.review.target.label")), { target: { value: "8.5" } });
    fireEvent.change(within(dialog).getByLabelText(t("design.dialog.rounds.label")), { target: { value: "4" } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("design.dialog.submit", { count: 8 }) }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledTimes(1));
    // The reviews of the dialog are on by default: the design is judged on the rubric, chapter by chapter and as a whole, after the pitches.
    expect(mocks.runtime.start).toHaveBeenCalledWith("book-1", { design: { chapters: 8, review: { targetScore: 8.5, maxRounds: 4 }, workflow: { rubric: true, chapterReview: true, coherence: true, alternatives: 3 } }, options: { readersOnPlan: true, budgetLimit: 0 } });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("asks the wildcards first when the author ticks it: the run's policy gets the room before the review of the design, and the dialog says what a consultation adds", async () => {
    await open({ [OUTLINE_BOOK_FILE]: serializeOutlineBook({ body: IDEA, origin: "author" }) }, "/app/books/book-1/outline?tab=studio");
    fireEvent.click(await screen.findByRole("button", { name: t("design.studio.start") }));
    const dialog = await screen.findByRole("dialog", { name: t("design.dialog.title") });
    const room = within(dialog).getByRole("checkbox", { name: t("design.dialog.wildcards.label") });
    expect(room).not.toBeChecked();
    expect(room).toHaveAccessibleDescription(t("design.dialog.wildcards.hint"));
    fireEvent.click(room);
    expect(room).toBeChecked();
    expect(dialog.querySelector("[data-design-wildcards-estimate]")).toHaveTextContent(t("autopilot.review.wildcards.estimateNoPrice", { voices: 4, calls: "5–10" }));
    fireEvent.click(within(dialog).getByRole("button", { name: t("design.dialog.submit", { count: 12 }) }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledTimes(1));
    expect(mocks.runtime.start).toHaveBeenCalledWith("book-1", { design: { chapters: 12, review: null, workflow: { rubric: true, chapterReview: true, coherence: true, alternatives: 3 } }, options: { readersOnPlan: true, budgetLimit: 0, review: { wildcards: { design: true } } } });
  });

  it("keeps the room the run has at a stall when the author leaves the design without it, and offers nothing of it to a personal server that predates it", async () => {
    const state = createAutopilotState(new Date(at), { idea: IDEA });
    state.options = { ...state.options, review: { wildcards: { design: true, plateau: true, voices: 3 } } };
    await open({ [OUTLINE_BOOK_FILE]: serializeOutlineBook({ body: IDEA, origin: "author" }), "autopilot/state.json": JSON.stringify(state) }, "/app/books/book-1/outline?tab=studio");
    fireEvent.click(await screen.findByRole("button", { name: t("design.studio.start") }));
    const dialog = await screen.findByRole("dialog", { name: t("design.dialog.title") });
    const room = within(dialog).getByRole("checkbox", { name: t("design.dialog.wildcards.label") });
    await waitFor(() => expect(room).toBeChecked());
    fireEvent.click(room);
    fireEvent.click(within(dialog).getByRole("button", { name: t("design.dialog.submit", { count: 12 }) }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledTimes(1));
    expect((mocks.runtime.start.mock.calls[0] as unknown as [string, { options: { review?: unknown } }])[1].options.review).toEqual({ wildcards: { plateau: true, voices: 3, design: false } });
    cleanup();

    mocks.book = { ...BOOK, autopilotHost: "server" };
    useAutopilotStore.setState((current) => ({ server: { ...current.server, info: { serverId: "s", name: "Home", version: "0.1.23", protocol: 1, features: ["autopilot", "autopilot-review-policy", "autopilot-design", "autopilot-outline-brief"] } as never } }));
    mocks.runtime.start.mockClear();
    await open({ [OUTLINE_BOOK_FILE]: serializeOutlineBook({ body: IDEA, origin: "author" }) }, "/app/books/book-1/outline?tab=studio");
    fireEvent.click(await screen.findByRole("button", { name: t("design.studio.start") }));
    const old = await screen.findByRole("dialog", { name: t("design.dialog.title") });
    const off = within(old).getByRole("checkbox", { name: t("design.dialog.wildcards.label") });
    expect(off).toBeDisabled();
    expect(off).toHaveAccessibleDescription(t("design.dialog.wildcards.oldServer", { version: "0.1.27" }));
  });

  it("follows a design that goes on: its reviews, its last vote, and the way to go on with it", async () => {
    const state = readyState();
    delete state.design!.endedAt;
    delete state.design!.outcome;
    state.design!.rounds = state.design!.rounds.slice(0, 1);
    state.plan!.approved = false;
    state.message = "Budget reached: raise the limit to continue.";
    await open({ [OUTLINE_BOOK_FILE]: serializeOutlineBook({ body: IDEA, origin: "author" }), "autopilot/state.json": JSON.stringify(state) }, "/app/books/book-1/outline?tab=studio");
    const progress = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-design-progress]");
      if (!found) throw new Error("no progress yet");
      return found;
    });
    expect(progress).toHaveTextContent(t("design.studio.status.paused"));
    expect(progress).toHaveTextContent("Budget reached: raise the limit to continue.");
    expect(progress).toHaveTextContent("Review 1 of 3 done · Last vote of the director: 7/10 (target the director's)");
    fireEvent.click(within(progress).getByRole("button", { name: t("design.studio.status.resume") }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith("book-1"));
  });

  it("shows the design ready with what it made, records the author's approval in the Synopsis, and starts the writing autopilot", async () => {
    await open({
      [OUTLINE_BOOK_FILE]: serializeOutlineBook({ body: IDEA, origin: "author" }),
      [outlineChapterPath(1)]: await designed(1, "Dawn"),
      [outlineChapterPath(2)]: await designed(2, "Storm"),
      "autopilot/state.json": JSON.stringify(readyState()),
      "secrets/the-wall.md": "---\ntype: secret\ntitle: The Wall Is Failing\n---\n\nThe sea wall cracked.",
      "locations/glass-harbor.md": "---\ntype: location\nname: Glass Harbor\n---\n",
      "items/the-ledger.md": "---\ntype: item\nname: The Ledger\n---\n",
    }, "/app/books/book-1/outline?tab=studio");
    const ready = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-design-ready]");
      if (!found) throw new Error("not ready yet");
      return found;
    });
    expect(within(ready).getByRole("heading", { name: t("design.studio.ready.title") })).toBeInTheDocument();
    await waitFor(() => expect(ready.querySelector("[data-design-counts]")).toHaveTextContent("2 chapters, 1 secret, 2 world entries"));
    expect(ready).toHaveTextContent(t("design.studio.ready.outcome.target", { score: "8.5/10" }));
    expect(document.querySelector("[data-design-rounds]")).toHaveTextContent("Review 1: 7/10, sent back · 1 critical inconsistency · 2 findings of the checks");
    fireEvent.click(within(ready).getByRole("button", { name: t("design.studio.ready.approve") }));
    await waitFor(() => expect(ready.querySelector("[data-design-approved]")).not.toBeNull());
    expect(parseMarkdown(mocks.store.files.get(OUTLINE_BOOK_FILE)!).frontmatter.design_approved).toMatchObject({ run: at });
    expect(parseMarkdown(mocks.store.files.get(OUTLINE_BOOK_FILE)!).body).toBe(IDEA);
    fireEvent.click(within(ready).getByRole("button", { name: t("design.studio.ready.write") }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith("book-1"));
    expect(mocks.runtime.start.mock.calls[0]).toHaveLength(1);
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
