import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OUTLINE_BOOK_FILE, createAutopilotState, outlineChapterPath, outlineEntryDigest, serializeOutlineBook, serializeOutlineChapter, type AutopilotState, type DesignProposalsDecision } from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";
import { polyfillRadix } from "./helpers/radix";

// «Review and complete» in the Studio (#125): which design runs and why, the dialog that starts it with its mode, and the review table of its proposals, chapter by
// chapter, with one apply.

const mocks = vi.hoisted(() => ({
  store: null as unknown as InstanceType<typeof import("narrarium-engine/testing").MemoryBookStore>,
  book: null as unknown,
  structure: null as unknown,
  runtime: {
    start: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
    pause: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
    refresh: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
    applyDesignProposals: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
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
import { DESIGN_COMPLETE_SERVER_VERSION } from "@/autopilot/designComplete";
import { OutlinePage } from "@/pages/OutlinePage";
import type { BookEntry } from "@/types/settings";

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", addedAt: "2026-11-21T00:00:00.000Z" };
const IDEA = "A harbor town built on glass hides a lie that the tide will tell.";
const STUDIO = "/app/books/book-1/outline?tab=studio";
const at = "2026-11-28T06:00:00.000Z";

function Page() {
  return (
    <MemoryRouter initialEntries={[STUDIO]}>
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

/** The Synopsis of a book whose chapters the author wrote (`count`), a description, and what else the test needs. */
function written(count: number, extra: Record<string, string> = {}, missing: number[] = []): Record<string, string> {
  const files: Record<string, string> = { [OUTLINE_BOOK_FILE]: serializeOutlineBook({ body: IDEA, origin: "author" }), ...extra };
  for (let number = 1; number <= count; number += 1) {
    files[outlineChapterPath(number)] = serializeOutlineChapter({ number, title: `The Tide ${number}`, ...(missing.includes(number) ? {} : { body: `Mira follows the water in chapter ${number}.` }), origin: "author" });
  }
  return files;
}

/** A «Review and complete» that is over, with its proposals for chapters 1 and 2 and a character to create. */
async function proposals(): Promise<AutopilotState> {
  const state = createAutopilotState(new Date(at), { idea: IDEA });
  // Chapter 2 is as it was when its proposals were made; chapter 1 changed since.
  const digest = await outlineEntryDigest({ title: "The Tide 2", body: "Mira follows the water in chapter 2." });
  state.design = {
    startedAt: at, chapters: 2, endedAt: at, outcome: "target", mode: "complete",
    rounds: [{ round: 1, score: 8.5, verdict: "approve", readers: 7, critical: 1, findings: 0, at }],
    completion: {
      chapters: [1, 2],
      entries: {
        1: {
          number: 1, title: "The Tide 1", digest: "0123456789abcdef",
          fields: [
            { id: "f1-setting", key: "setting", value: "The lamp room", status: "waiting" },
            { id: "f1-scenes", key: "scenes", value: ["The dive", "The shard"], status: "waiting" },
            { id: "f1-cliffhanger", key: "cliffhanger", value: true, status: "waiting" },
          ],
          findings: [
            { id: "d1-1-0", source: "director", severity: "critical", criterion: "coherence", text: "Mira knows about the wall before anyone tells her.", suggestion: "Let her overhear it first.", status: "waiting" },
            { id: "r1-tess-1-0", source: "reader", reader: "tess", by: "Tess", severity: "minor", criterion: "engagement", text: "The opening image is familiar.", status: "waiting" },
          ],
        },
        2: { number: 2, title: "The Tide 2", digest, fields: [{ id: "f2-goal", key: "goal", value: "Mira chooses the town.", status: "waiting" }], findings: [] },
      },
      canon: [{ id: "c-character-tessa-lune", kind: "character", name: "Tessa Lune", description: "The keeper's niece, who saw the crack.", chapters: [1], status: "waiting" }],
      readings: [{ slug: "tess", name: "Tess", round: 1, score: 7, summary: "I would read it." }],
      awaitingAuthor: true,
    },
  };
  state.status = "paused";
  return state;
}

const proposalsSection = () => waitFor(() => {
  const found = document.querySelector<HTMLElement>("[data-design-proposals]");
  if (!found) throw new Error("no proposals yet");
  return found;
});

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
  mocks.runtime.applyDesignProposals = vi.fn(async (_book: string, decision: DesignProposalsDecision) => ({ applied: decision.apply.length, skipped: 6 - decision.apply.length, outdated: 0, chapters: [1, 2], created: ["characters/tessa-lune.md"], held: [] }));
  useAutopilotStore.setState((state) => ({ views: {}, summaries: {}, server: { ...state.server, info: null } }));
});

afterEach(() => cleanup());

describe("which design runs, and why", () => {
  it("offers to review and complete a book whose every chapter is the author's, says so before it starts, and starts it with its mode and no number of chapters", async () => {
    await open(written(3));
    const button = await screen.findByRole("button", { name: t("design.studio.startComplete") });
    expect(button).toBeEnabled();
    expect(button).toHaveAccessibleDescription(t("design.mode.studio.complete", { count: 3 }));
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: t("design.dialog.title") });
    expect(within(dialog).getByRole("radio", { name: t("design.mode.complete.label") })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: t("design.mode.plan.label") })).not.toBeChecked();
    expect(dialog.querySelector("[data-design-mode-reason]")).toHaveTextContent(t("design.mode.reason.written", { count: 3 }));
    expect(within(dialog).queryByLabelText(t("design.dialog.chapters.label"))).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(t("design.dialog.rounds.label")), { target: { value: "2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("design.dialog.submitComplete", { count: 3 }) }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledTimes(1));
    expect(mocks.runtime.start).toHaveBeenCalledWith("book-1", { design: { mode: "complete", review: { maxRounds: 2 } }, options: { readersOnPlan: true, budgetLimit: 0 } });
  });

  it("designs a book whose chapters are not all written, names the ones missing, and lets the author review and complete the ones there are instead", async () => {
    await open(written(4, {}, [2, 4]));
    const button = await screen.findByRole("button", { name: t("design.studio.start") });
    await waitFor(() => expect(button).toHaveAccessibleDescription(t("design.mode.studio.missing", { count: 2, written: 2 })));
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: t("design.dialog.title") });
    expect(within(dialog).getByRole("radio", { name: t("design.mode.plan.label") })).toBeChecked();
    expect(dialog.querySelector("[data-design-mode-reason]")).toHaveTextContent(t("design.mode.reason.missing", { count: 2, list: "2, 4" }));
    fireEvent.click(within(dialog).getByRole("radio", { name: t("design.mode.complete.label") }));
    expect(within(dialog).queryByLabelText(t("design.dialog.chapters.label"))).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: t("design.dialog.submitComplete", { count: 2 }) }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith("book-1", { design: { mode: "complete", review: null }, options: { readersOnPlan: true, budgetLimit: 0 } }));
  });

  it("does not offer it on a personal server that does not review and complete, and says from which version it can; without a description only it can run", async () => {
    mocks.book = { ...BOOK, autopilotHost: "server" };
    useAutopilotStore.setState((state) => ({ server: { ...state.server, info: { serverId: "s", name: "Home", version: "0.1.24", protocol: 1, features: ["autopilot", "autopilot-design"] } as never } }));
    await open(written(2));
    const start = await screen.findByRole("button", { name: t("design.studio.start") });
    await waitFor(() => expect(start).toHaveAccessibleDescription(t("design.mode.studio.plan")));
    fireEvent.click(start);
    const dialog = await screen.findByRole("dialog", { name: t("design.dialog.title") });
    const complete = within(dialog).getByRole("radio", { name: t("design.mode.complete.label") });
    expect(complete).toBeDisabled();
    expect(complete).toHaveAccessibleDescription(`Your personal server is older than ${DESIGN_COMPLETE_SERVER_VERSION} and cannot review and complete a book: update it to do this from here.`);
    expect(within(dialog).getByRole("radio", { name: t("design.mode.plan.label") })).toBeChecked();
    cleanup();
    useAutopilotStore.setState((state) => ({ server: { ...state.server, info: null } }));
    mocks.book = { ...BOOK };
    const files = written(2);
    delete files[OUTLINE_BOOK_FILE];
    await open(files);
    fireEvent.click(await screen.findByRole("button", { name: t("design.studio.startComplete") }));
    const second = await screen.findByRole("dialog", { name: t("design.dialog.title") });
    expect(within(second).getByRole("radio", { name: t("design.mode.plan.label") })).toBeDisabled();
    expect(within(second).getByRole("radio", { name: t("design.mode.plan.label") })).toHaveAccessibleDescription(t("design.mode.blocked.description"));
  });
});

describe("the proposals of Review and complete", () => {
  it("are listed chapter by chapter, everything but the minor findings chosen, and one apply sends the chosen ones", async () => {
    await open(written(2, { "autopilot/state.json": JSON.stringify(await proposals()) }));
    const section = await proposalsSection();
    expect(section).toHaveAttribute("data-design-proposals", "waiting");
    expect(within(section).getByRole("heading", { name: t("design.complete.title") })).toBeInTheDocument();
    expect(section).toHaveTextContent(t("design.complete.intro", { count: 7, chapters: "2" }));
    const one = section.querySelector<HTMLElement>("[data-proposals-chapter='1']")!;
    fireEvent.click(within(one).getByText(/^Chapter 1/));
    expect(within(one).getByRole("checkbox", { name: /Setting/ })).toBeChecked();
    expect(within(one).getByText("The lamp room")).toBeInTheDocument();
    expect(within(one).getByText("The dive")).toBeInTheDocument();
    expect(within(one).getByText(t("design.complete.yes"))).toBeInTheDocument();
    const critical = one.querySelector<HTMLElement>("[data-proposal='d1-1-0']")!;
    expect(critical).toHaveTextContent("Critical · Narrative coherence · the director");
    expect(within(critical).getByRole("checkbox")).toBeChecked();
    expect(within(one.querySelector<HTMLElement>("[data-proposal='r1-tess-1-0']")!).getByRole("checkbox")).not.toBeChecked();
    expect(one).toHaveTextContent(t("design.complete.changed"));
    expect(section.querySelector("[data-proposals-chapter='2']")).not.toHaveTextContent(t("design.complete.changed"));
    const canon = section.querySelector<HTMLElement>("[data-proposals-canon]")!;
    expect(within(canon).getByRole("checkbox", { name: /Tessa Lune/ })).toBeChecked();
    // The author leaves the scenes out, and takes the minor finding.
    fireEvent.click(within(one).getByRole("checkbox", { name: /Planned scenes/ }));
    fireEvent.click(within(one.querySelector<HTMLElement>("[data-proposal='r1-tess-1-0']")!).getByRole("checkbox"));
    expect(section).toHaveTextContent(t("design.complete.chosen", { count: 6, total: 7 }));
    fireEvent.click(within(section).getByRole("button", { name: t("design.complete.apply", { count: 6 }) }));
    await waitFor(() => expect(mocks.runtime.applyDesignProposals).toHaveBeenCalledTimes(1));
    expect(mocks.runtime.applyDesignProposals).toHaveBeenCalledWith("book-1", { run: at, apply: ["f1-setting", "f1-cliffhanger", "d1-1-0", "r1-tess-1-0", "f2-goal", "c-character-tessa-lune"] });
    await waitFor(() => expect(section).toHaveAttribute("data-design-proposals", "decided"));
    expect(section).toHaveTextContent(`${t("design.complete.result", { count: 6, chapters: "2" })} ${t("design.complete.created", { count: 1 })}`);
    expect(within(section).getByRole("button", { name: t("design.studio.ready.write") })).toBeEnabled();
    expect(mocks.runtime.start).not.toHaveBeenCalled();
  });

  it("chooses a whole chapter, or none at all, and says what a locked decision held", async () => {
    mocks.runtime.applyDesignProposals = vi.fn(async () => ({ applied: 1, skipped: 6, outdated: 1, chapters: [1], created: [], held: ["d-001 «Chapter 2 stays as it is.» covers outline/chapters/002.md."] }));
    await open(written(2, { "autopilot/state.json": JSON.stringify(await proposals()) }));
    const section = await proposalsSection();
    fireEvent.click(within(section).getByRole("button", { name: t("design.complete.none") }));
    expect(within(section).getByRole("button", { name: t("design.complete.applyNone") })).toBeEnabled();
    const two = section.querySelector<HTMLElement>("[data-proposals-chapter='2']")!;
    fireEvent.click(within(two).getByText(/^Chapter 2/));
    fireEvent.click(within(two).getByRole("button", { name: t("design.complete.chapterAll", { number: "2" }) }));
    expect(section).toHaveTextContent(t("design.complete.chosen", { count: 1, total: 7 }));
    fireEvent.click(within(section).getByRole("button", { name: t("design.complete.apply", { count: 1 }) }));
    await waitFor(() => expect(mocks.runtime.applyDesignProposals).toHaveBeenCalledWith("book-1", { run: at, apply: ["f2-goal"] }));
    const held = await waitFor(() => {
      const found = section.querySelector<HTMLElement>("[data-design-held]");
      if (!found) throw new Error("not said yet");
      return found;
    });
    expect(held).toHaveTextContent(t("design.complete.held", { count: 1 }));
    expect(held).toHaveTextContent("Chapter 2 stays as it is.");
    expect(section).toHaveTextContent(t("design.complete.outdated", { count: 1 }));
  });

  it("cannot be applied while the review goes on, and says what was decided once it was", async () => {
    const going = await proposals();
    delete going.design!.endedAt;
    delete going.design!.outcome;
    going.status = "paused";
    await open(written(2, { "autopilot/state.json": JSON.stringify(going) }));
    const section = await proposalsSection();
    expect(section).toHaveAttribute("data-design-proposals", "active");
    expect(section).toHaveTextContent(t("design.complete.active"));
    expect(within(section).getByRole("button", { name: t("design.complete.apply", { count: 6 }) })).toBeDisabled();
    cleanup();
    const decided = await proposals();
    decided.design!.completion!.decided = { at, applied: 4, skipped: 3 };
    await open(written(2, { "autopilot/state.json": JSON.stringify(decided) }));
    const done = await proposalsSection();
    expect(done).toHaveAttribute("data-design-proposals", "decided");
    expect(done).toHaveTextContent("Applied: 4 · left out: 3");
  });

  it("speaks Italian when the interface does", async () => {
    await i18n.changeLanguage("it");
    await open(written(2, { "autopilot/state.json": JSON.stringify(await proposals()) }));
    const section = await proposalsSection();
    expect(within(section).getByRole("heading", { name: "Proposte di Rivedi e completa" })).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Applica 6 proposte" })).toBeInTheDocument();
  });
});
