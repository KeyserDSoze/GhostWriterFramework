import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_OPTIONS, defaultDirector, serializeDirector, type AutopilotFinalReview, type PlannedChapter } from "narrarium-engine";

const mocks = vi.hoisted(() => ({
  files: new Map<string, string>(),
  runtime: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
}));

// What the dialog and the block read of the book: the director's profile and the records of the frozen chapters.
vi.mock("@/autopilot/useBookFiles", () => ({
  useBookFiles: (_bookId: string, paths: readonly string[]) => ({ files: new Map(paths.flatMap((path) => (mocks.files.has(path) ? [[path, mocks.files.get(path) as string]] : []))), failed: false }),
}));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/autopilot/useRunEstimate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/useRunEstimate")>()),
  useRunEstimateSources: () => ({
    sources: { book: { read: true, directorFile: true, directorRounds: 2, context: {}, designWritten: false, outline: { entries: 12, lastChapter: 12, words: 1200 } }, ai: null, aiFrom: "browser", activities: [], state: null, chapters: null, canonEntries: 0, currency: "USD", models: [] },
    reading: false,
    server: { status: "idle" },
    host: "browser",
  }),
}));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AutopilotResult } from "@/components/autopilot/AutopilotResult";
import { BookRoundSlot } from "@/components/autopilot/BookRoundSlot";
import { CampaignChip } from "@/components/autopilot/band/parts";
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { judgedPlan, planOf } from "./helpers/autopilotFixtures";
import { seedRun } from "./helpers/autopilotBand";
import { LOCAL_BOOK, t } from "./helpers/quickCommands";
import { bookRound, correction, endedReview, reviewCampaign, roundRecord } from "./helpers/autopilotBookRound";

/** The book of the owner's case: every chapter at 9, the director's vote of the book 7.4. */
const REVIEW: AutopilotFinalReview = { verdict: "revise", score: 7.4, text: "The ending is not earned.", at: "2026-11-21T10:30:00.000Z" };
const highPlan = (): PlannedChapter[] => judgedPlan().map((entry) => ({ ...entry, score: 9, rounds: [{ director: 9, accepted: 0, rejected: 0 }] }));

function finished(patch: Record<string, unknown> = {}, book: BookEntry = LOCAL_BOOK, server?: Parameters<typeof seedRun>[0]["server"], chapters = highPlan()) {
  return seedRun({
    book,
    status: "completed",
    phase: "completed",
    chapters,
    message: "The book is complete.",
    statePatch: { finalDone: true, finalReview: REVIEW, ...patch },
    stats: { cost: 17.62, aiCalls: 366, inputTokens: 1_240_000, outputTokens: 402_000 },
    ...(server ? { server } : {}),
  });
}

/** The owner's case with a target of 9 for the book (the policy's own): the director's vote of the book is under it. */
const underNine = (patch: Record<string, unknown> = {}) => ({ options: { ...DEFAULT_OPTIONS, review: { targetScore: 9 } }, ...patch });

function show(book: BookEntry = LOCAL_BOOK) {
  return render(<MemoryRouter><AutopilotResult bookId={book.id} linkedSlugs={new Set(["003-chapter-3"])} review={{ book, branch: "main" }} /></MemoryRouter>);
}

const dialog = () => screen.findByRole("dialog", { name: t("autopilot.reviewBook.title") });
const round = (shown: HTMLElement, mode: "off" | "apply" | "ask") => within(shown).getByRole("radio", { name: t(`autopilot.review.bookRound.${mode}.label`) }) as HTMLInputElement;

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.files = new Map([["director.md", serializeDirector({ ...defaultDirector("en"), approvalScore: 7, maxReviewRounds: 2 })]]);
  mocks.runtime = {
    refresh: vi.fn(async () => null),
    frozenStatus: vi.fn(async () => ({ mode: "ask", changes: [], pending: [], warnings: [] })),
    reviewBook: vi.fn(async () => ({ campaign: null, frozen: { mode: "ask", changes: [], pending: [], warnings: [] } })),
    decideBookCorrections: vi.fn(async () => ({ campaign: null, frozen: { mode: "ask", changes: [], pending: [], warnings: [] } })),
    start: vi.fn(async () => undefined),
    describeError: vi.fn((error: unknown) => String(error)),
  };
});

afterEach(async () => {
  cleanup();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [] });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("«The book as a whole» in the result of a finished book", () => {
  it("says the book's vote is under the target and that the chapters have theirs, and offers to review the book as a whole with the round on", async () => {
    finished(underNine());
    show();
    const block = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-result-book-round]");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(within(block).getByRole("heading", { level: 3, name: t("autopilot.result.bookRound.title") })).toBeInTheDocument();
    expect(block.querySelector("[data-book-below]")).toHaveTextContent("The book's vote is below the target: 7.4/10 (target 9/10).");
    expect(block).toHaveTextContent(t("autopilot.result.bookRound.allChapters"));
    expect(block).toHaveTextContent(t("autopilot.result.bookRound.offHint"));
    fireEvent.click(within(block).getByRole("button", { name: t("autopilot.result.bookRound.action") }));
    const shown = await dialog();
    expect(round(shown, "ask"), "the window starts from the way that shows the corrections first").toBeChecked();
  });

  it("is not there for a book at its target that was never reviewed as a whole", async () => {
    finished({ finalReview: { ...REVIEW, score: 8 } });
    show();
    await waitFor(() => expect(document.querySelector("[data-autopilot-result]")).not.toBeNull());
    expect(document.querySelector("[data-result-book-round]")).toBeNull();
  });

  it("tells, round by round, what the director asked of the book in the last review, with what became of each correction", async () => {
    const rounds = [
      { round: 1, ...roundRecord() },
      { round: 2, ...roundRecord({ score: 7.6, corrections: [correction(3, { status: "applied" }), correction(4, { held: "author", status: "left-out", why: "author" }), correction(9, { status: "left-out", why: "gone" })] }) },
    ];
    finished({ finalReview: { ...REVIEW, score: 9 }, reviews: [endedReview(rounds)] });
    show();
    const block = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-result-book-round]");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(block.querySelector("[data-book-below]"), "the book is at the target now").toBeNull();
    expect(within(block).getByRole("heading", { level: 4, name: t("autopilot.result.bookRound.asked") })).toBeInTheDocument();
    const first = block.querySelector<HTMLDetailsElement>("[data-book-round-history='1']") as HTMLDetailsElement;
    const second = block.querySelector<HTMLDetailsElement>("[data-book-round-history='2']") as HTMLDetailsElement;
    expect([first.open, second.open], "the last round is open").toEqual([false, true]);
    expect(first.querySelector("summary")).toHaveTextContent("Round 1 · the book got 7.4/10 · 2 corrections (carried out: 1, left out: 1)");
    expect([...second.querySelectorAll("[data-correction-status]")].map((node) => node.textContent)).toEqual(["carried out", "left out · the chapter is yours", "left out · the chapter is no longer in the plan"]);
    expect(second.querySelector("[data-correction-held]")).toHaveTextContent(t("autopilot.bookRound.correction.held"));
    // The chapter that has a page is a link to it; the others are named.
    expect(within(second).getByRole("link", { name: "Open chapter 3" })).toHaveAttribute("href", "/app/books/book-1/chapters/003-chapter-3");
    expect(within(second).queryByRole("link", { name: "Open chapter 9" })).toBeNull();
    expect(second).toHaveTextContent("Plant the setup of the ending in chapter 3.");
    expect(second).toHaveTextContent(POINT_ONE);
  });

  it("is in Italian when the app is", async () => {
    await act(async () => { await i18n.changeLanguage("it"); });
    finished({ finalReview: { ...REVIEW, score: 9 }, reviews: [endedReview([{ round: 1, ...roundRecord() }])] });
    show();
    await waitFor(() => expect(document.querySelector("[data-result-book-round]")).not.toBeNull());
    expect(screen.getByRole("heading", { level: 4, name: "Cosa ha chiesto il direttore al libro" })).toBeInTheDocument();
    expect(document.querySelector("[data-book-round-history='1'] summary")).toHaveTextContent("Giro 1 · il libro ha preso 7,4/10 · 2 correzioni (eseguite: 1, lasciate fuori: 1)");
  });
});

const POINT_ONE = "major: The ending is not earned — Plant its setup earlier";

describe("the corrections that wait for the author, on the live page", () => {
  const slot = (state: Parameters<typeof BookRoundSlot>[0]["state"]) => render(<MemoryRouter><BookRoundSlot bookId="book-1" state={state} linkedSlugs={new Set(["003-chapter-3"])} /></MemoryRouter>);
  const proposed = (patch = {}, review = {}) => ({ plan: planOf(judgedPlan()), campaign: reviewCampaign(bookRound(patch), review) });

  it("draws nothing for a book with no review in a book-level round, and nothing for a round that ended", () => {
    const { container } = slot({ plan: planOf(judgedPlan()) });
    expect(container).toBeEmptyDOMElement();
    cleanup();
    expect(slot(proposed({ status: "stopped" })).container).toBeEmptyDOMElement();
  });

  it("lists what the director asks for in the order of the book: the chapter, what to change, why and the points it answers, with the author's chapter unticked and said", async () => {
    const state = proposed({ corrections: [correction(3), correction(4, { held: "author" }), correction(9, { cites: [1, 2], change: "Cut the detour of the second scene.", reason: "The middle drags." })] });
    slot(state);
    const panel = await screen.findByRole("region", { name: t("autopilot.bookRound.proposal.title") });
    expect(panel).toHaveTextContent(t("autopilot.bookRound.proposal.intro", { book: "7.4/10", target: "9/10" }));
    expect(panel).toHaveTextContent("The director says: Two chapters carry the weight of the ending.");
    const list = within(panel).getByRole("list", { name: t("autopilot.bookRound.proposal.list") });
    const items = [...list.querySelectorAll<HTMLElement>("[data-book-correction]")];
    expect(items.map((item) => item.getAttribute("data-chapter"))).toEqual(["3", "4", "9"]);
    expect(items[0]).toHaveTextContent("Chapter 3 — Title 3");
    expect(items[0]).toHaveTextContent("Plant the setup of the ending in chapter 3.");
    expect(items[0]).toHaveTextContent("The ending pays off a promise that chapter 3 never made.");
    expect(items[0]).toHaveTextContent(POINT_ONE);
    expect(items[2]).toHaveTextContent("Tighten the middle chapters");
    const boxes = within(list).getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((box) => box.checked)).toEqual([true, false, true]);
    expect(within(items[1]).getByText(t("autopilot.bookRound.correction.held"))).toBeInTheDocument();
    expect(boxes[0]).toHaveAccessibleName(new RegExp(`^${t("autopilot.bookRound.correction.choose", { number: 3 })}`));
    expect(boxes[0]).toHaveAccessibleDescription("Plant the setup of the ending in chapter 3.");
    expect(within(panel).getByRole("status")).toHaveTextContent("Chosen: 2 of 3.");
  });

  it("carries out what is ticked: the decision names the round and the corrections, and the autopilot is started after it", async () => {
    slot(proposed({ corrections: [correction(3), correction(4, { held: "author" }), correction(9)] }));
    const panel = await screen.findByRole("region", { name: t("autopilot.bookRound.proposal.title") });
    fireEvent.click(within(panel).getAllByRole("checkbox")[1]);
    expect(within(panel).getByRole("status")).toHaveTextContent("Chosen: 3 of 3.");
    fireEvent.click(within(panel).getAllByRole("checkbox")[2]);
    fireEvent.click(within(panel).getByRole("button", { name: "Carry out 2 corrections" }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledTimes(1));
    expect(mocks.runtime.decideBookCorrections).toHaveBeenCalledWith("book-1", { round: 2, action: "apply", chosen: [1, 2] });
    expect(mocks.runtime.decideBookCorrections.mock.invocationCallOrder[0]).toBeLessThan(mocks.runtime.start.mock.invocationCallOrder[0]);
  });

  it("with none ticked there is nothing to carry out, and leaving them all out declines the round and lets the review end", async () => {
    slot(proposed());
    const panel = await screen.findByRole("region", { name: t("autopilot.bookRound.proposal.title") });
    for (const box of within(panel).getAllByRole("checkbox")) fireEvent.click(box);
    expect(within(panel).getByRole("button", { name: t("autopilot.bookRound.proposal.applyNone") })).toBeDisabled();
    expect(within(panel).getByRole("status")).toHaveTextContent("Chosen: 0 of 2.");
    const decline = within(panel).getByRole("button", { name: t("autopilot.bookRound.proposal.decline") });
    expect(decline).toHaveAccessibleDescription(t("autopilot.bookRound.proposal.declineHint"));
    fireEvent.click(decline);
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledTimes(1));
    expect(mocks.runtime.decideBookCorrections).toHaveBeenCalledWith("book-1", { round: 2, action: "decline" });
  });

  it("says that a plateau breaker gave the director something to read, when it did", async () => {
    slot(proposed({ plateau: { consulted: true } }));
    const panel = await screen.findByRole("region", { name: t("autopilot.bookRound.proposal.title") });
    expect(panel).toHaveTextContent(t("autopilot.bookRound.progress.taken"));
  });

  it("while the director is asked, and while the corrections are carried out, says where the round is and which correction is done", async () => {
    slot(proposed({ status: "asking", corrections: [] }));
    const asking = await screen.findByRole("region", { name: t("autopilot.bookRound.progress.title") });
    expect(asking).toHaveTextContent("Round 2: the director is asked for the corrections of the whole book (it gave the book 7.4/10, target 9/10).");
    expect(within(asking).queryByRole("list")).toBeNull();
    cleanup();

    slot(proposed({ status: "applying", corrections: [correction(3, { status: "applied" }), correction(9), correction(4, { status: "left-out", why: "author", held: "author" })] }));
    const applying = await screen.findByRole("region", { name: t("autopilot.bookRound.progress.title") });
    expect(within(applying).getByRole("status")).toHaveTextContent("Round 2: corrections carried out, 1 of 3.");
    expect([...applying.querySelectorAll("[data-correction-status]")].map((node) => node.textContent)).toEqual(["carried out", "waiting for its turn", "left out · the chapter is yours"]);
    expect(within(applying).queryByRole("checkbox")).toBeNull();
  });

  it("is in Italian when the app is", async () => {
    await act(async () => { await i18n.changeLanguage("it"); });
    slot(proposed());
    const panel = await screen.findByRole("region", { name: "Il direttore chiede correzioni dell'intero libro" });
    expect(within(panel).getByRole("button", { name: "Esegui 2 correzioni" })).toBeEnabled();
    expect(within(panel).getByRole("button", { name: "Lasciale fuori tutte" })).toBeEnabled();
    expect(within(panel).getByRole("status")).toHaveTextContent("Scelte: 2 su 2.");
  });
});

describe("the chip of the band while the review is in a round for the whole book", () => {
  const campaign = (status: "asking" | "proposed" | "applying", extra: Record<string, unknown> = {}) => ({
    id: "c", reason: "review-target" as const, total: 0, done: 0, current: null, waiting: [],
    review: { round: 2, roundsThisRun: 2, targetScore: 9, phase: "book" as const, lowest: 9, book: 7.4, budgetLimit: 0, bookRound: { status, corrections: 3, applied: 1 }, ...extra },
  });

  it("says the director is asked, that the corrections wait for the author, or how many are carried out and the chapter being worked", () => {
    const { container, rerender } = render(<CampaignChip campaign={campaign("asking")} />);
    expect(container).toHaveTextContent(/Review to 9\/10: round 2/);
    expect(container).toHaveTextContent("· the director lists the corrections of the book");
    rerender(<CampaignChip campaign={campaign("proposed")} />);
    expect(container).toHaveTextContent("· corrections of the book wait for you");
    rerender(<CampaignChip campaign={{ ...campaign("applying", { phase: "chapters" }), current: 4 }} />);
    expect(container).toHaveTextContent("· corrections of the book: 1 of 3");
    expect(container).toHaveTextContent("· chapter 4 now");
  });
});
