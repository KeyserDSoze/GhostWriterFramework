import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OUTLINE_BOOK_FILE, createAutopilotState, outlineChapterPath, readDesignSnapshot, serializeOutlineBook, serializeOutlineChapter, type AutopilotState, type PlannedChapter } from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";
import { polyfillRadix } from "./helpers/radix";

// Phase 4 of #108 in the Studio: the votes of the reviews of a design in a chart, and what each reviewer said in each review.

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

function Page() {
  return (
    <MemoryRouter initialEntries={["/app/books/book-1/outline?tab=studio"]}>
      <Routes><Route path="/app/books/:bookId/outline" element={<OutlinePage />} /></Routes>
    </MemoryRouter>
  );
}

async function open(files: Record<string, string>) {
  mocks.store = new MemoryBookStore(files);
  mocks.structure = { title: "The Glass Harbor", language: "en", ghostwriter: "default", ghostwriters: [], chapters: [], readerPersonas: [], loadedBranch: "main" };
  render(<Page />);
  await screen.findByRole("heading", { level: 1, name: t("outline.title") });
  await waitFor(() => expect(screen.queryByText(t("outline.loading"))).not.toBeInTheDocument());
}

/** A design the director approved at its second review, with what the reviewers said in each. */
function readyState(): AutopilotState {
  const state = createAutopilotState(new Date(at), { idea: IDEA });
  state.concept = { done: true, generated: true, secrets: [] };
  state.plan = { chapters: [1, 2].map((number) => ({ number, title: `Chapter ${number}`, slug: `00${number}-chapter-${number}`, summary: "", goal: "", pov: [], keyEvents: [], reveals: [], status: "planned", scenes: [] }) as PlannedChapter), approved: true, rounds: 1, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: true };
  state.design = {
    startedAt: at, chapters: 2, endedAt: at, outcome: "target", review: { targetScore: 8 },
    rounds: [
      { round: 1, score: 6.5, verdict: "revise", readers: 7, critical: 1, findings: 0, at, texts: { summary: "The reveal costs Mira nothing.", counterProposal: "Reveal the wall in chapter 3, through Orrin.", changes: ["Chapter 2: make the reveal cost Mira her trust."], critical: ["Critical — Chapter 1: Orrin cannot know yet."], readers: [{ slug: "tess", name: "Tess", score: 7, text: "I would read it.", counterProposal: "Open on the flood." }] } },
      { round: 2, score: 8.5, verdict: "approve", readers: 7.5, critical: 0, findings: 0, at, texts: { summary: "Now the reveal hurts." } },
    ],
  };
  state.status = "paused";
  return state;
}

const entry = (number: number, body: string) => serializeOutlineChapter({ number, title: `Chapter ${number}`, body, origin: "author" });
const BIBLE_WORLD = "---\ntype: bible\nid: bible:world\nrules:\n  - Glass breaks.\n---\n";

beforeAll(async () => {
  polyfillRadix();
  await i18n.changeLanguage("en");
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.book = { ...BOOK };
  mocks.runtime.start = vi.fn(async () => undefined);
  mocks.runtime.pause = vi.fn(async () => undefined);
  mocks.runtime.refresh = vi.fn(async () => null);
  useAutopilotStore.setState((state) => ({ views: {}, summaries: {}, server: { ...state.server, info: null } }));
});

afterEach(() => cleanup());

const history = () => waitFor(() => {
  const found = document.querySelector<HTMLElement>("[data-design-history]");
  if (!found) throw new Error("no history yet");
  return found;
});
const versionsIn = (store: MemoryBookStore) => [...store.files.keys()].filter((path) => path.startsWith("history/design/")).sort();

describe("the reviews of the design", () => {
  it("draw the votes in a chart that says its figures in words, and keep what each reviewer said in each review", async () => {
    await open({ [OUTLINE_BOOK_FILE]: serializeOutlineBook({ body: IDEA, origin: "author" }), [outlineChapterPath(1)]: entry(1, "One."), "autopilot/state.json": JSON.stringify(readyState()) });
    const chart = await screen.findByRole("img", { name: /The votes of the reviews of the design/ });
    expect(chart).toHaveAccessibleName("The votes of the reviews of the design Review 1: the director 6.5/10, the readers 7/10. Review 2: the director 8.5/10, the readers 7.5/10. The target is 8/10.");
    expect(chart.querySelector("[data-chart-target]")).not.toBeNull();
    const first = document.querySelector<HTMLElement>("[data-round-texts='1']")!;
    fireEvent.click(within(first).getByText(t("design.studio.rounds.said", { round: 1 })));
    expect(first).toHaveTextContent("The reveal costs Mira nothing.");
    expect(first).toHaveTextContent(`${t("design.studio.rounds.counter")}Reveal the wall in chapter 3, through Orrin.`);
    expect(first).toHaveTextContent("Chapter 2: make the reveal cost Mira her trust.");
    expect(first).toHaveTextContent("Critical — Chapter 1: Orrin cannot know yet.");
    expect(first.querySelector("[data-round-reader='tess']")).toHaveTextContent("Tess (7/10): I would read it.Counter-proposal: Open on the flood.");
    expect(document.querySelector("[data-round-texts='2']")).toHaveTextContent(t("design.studio.rounds.said", { round: 2 }));
  });
});

