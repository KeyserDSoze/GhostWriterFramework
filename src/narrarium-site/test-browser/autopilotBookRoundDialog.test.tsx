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
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { judgedPlan } from "./helpers/autopilotFixtures";
import { seedRun } from "./helpers/autopilotBand";
import { LOCAL_BOOK, t } from "./helpers/quickCommands";
import { SERVER_INFO } from "./helpers/fakeBookServer";

const SERVER_INFO_OF = (features: string[]) => ({ ...SERVER_INFO, serverVersion: "0.1.22", features });
const CORE = ["autopilot", "autopilot-outline-apply", "autopilot-review-book", "autopilot-review-policy", "autopilot-review-targets"];

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

function show(book: BookEntry = LOCAL_BOOK) {
  return render(<MemoryRouter><AutopilotResult bookId={book.id} linkedSlugs={new Set(["003-chapter-3"])} review={{ book, branch: "main" }} /></MemoryRouter>);
}

const dialog = () => screen.findByRole("dialog", { name: t("autopilot.reviewBook.title") });
const openDialog = async () => {
  fireEvent.click(screen.getByRole("button", { name: t("autopilot.result.actions.review") }));
  return dialog();
};
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

describe("«Review the book again»: the round for the whole book", () => {
  it("offers the three ways, off as the settings of the book have it, each with what it does, and says so to a screen reader", async () => {
    finished();
    show();
    const shown = await openDialog();
    const group = within(shown).getByRole("radiogroup", { name: t("autopilot.review.bookRound.title") });
    expect(within(group).getAllByRole("radio").map((radio) => (radio as HTMLInputElement).checked)).toEqual([true, false, false]);
    expect(round(shown, "apply")).toHaveAccessibleDescription(t("autopilot.review.bookRound.apply.hint"));
    expect(round(shown, "ask")).toHaveAccessibleDescription(t("autopilot.review.bookRound.ask.hint"));
  });

  it("with every chapter at the target and the book under it, says so, and does not let the review begin until the round for the book is chosen", async () => {
    finished();
    show();
    const shown = await openDialog();
    expect(within(shown).getByRole("heading", { name: "0 chapters under 8/10 will be reviewed again" })).toBeInTheDocument();
    expect(shown.querySelector("[data-review-nothing]")).toHaveTextContent(t("autopilot.reviewBook.nothingBookOff", { target: "8/10", book: "7.4/10" }));
    expect(within(shown).getByRole("button", { name: "Review 0 chapters" })).toBeDisabled();

    fireEvent.click(round(shown, "ask"));
    expect(shown.querySelector("[data-review-nothing]")).toHaveTextContent(t("autopilot.reviewBook.nothingBook", { target: "8/10", book: "7.4/10" }));
    expect(shown.querySelector("[data-review-book-round-cost]")).toHaveTextContent(t("autopilot.reviewBook.bookRoundCost"));
    const submit = within(shown).getByRole("button", { name: t("autopilot.reviewBook.submitBook") });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledTimes(1));
    expect(mocks.runtime.reviewBook).toHaveBeenCalledWith("book-1", expect.objectContaining({ targetScore: 8, bookRound: "ask" }));
    expect(mocks.runtime.reviewBook.mock.invocationCallOrder[0]).toBeLessThan(mocks.runtime.start.mock.invocationCallOrder[0]);
  });

  it("does not begin a review at the book that is not under the target: the target raised over the book's vote is the way to review", async () => {
    finished({ finalReview: { ...REVIEW, score: 8.5 } });
    show();
    const shown = await openDialog();
    fireEvent.click(round(shown, "apply"));
    expect(shown.querySelector("[data-review-nothing]")).toHaveTextContent(t("autopilot.reviewBook.nothing", { target: "8/10", book: "8.5/10" }));
    expect(within(shown).getByRole("button", { name: "Review 0 chapters" })).toBeDisabled();
    fireEvent.change(within(shown).getByLabelText(t("autopilot.review.target.label")), { target: { value: "9" } });
    await waitFor(() => expect(shown.querySelector("[data-review-book-next]")).not.toBeNull());
    expect(within(shown).getByRole("button", { name: t("autopilot.reviewBook.submitBook") })).toBeEnabled();
  });

  it("sends the round with the chapters under the target when there are some, and says what it adds to the cost", async () => {
    finished({}, LOCAL_BOOK, undefined, judgedPlan());
    show();
    const shown = await openDialog();
    fireEvent.click(round(shown, "apply"));
    expect(shown.querySelector("[data-review-book-round-cost]")).not.toBeNull();
    const submit = await within(shown).findByRole("button", { name: /^Review \d+ chapters?$/ });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledTimes(1));
    expect(mocks.runtime.reviewBook).toHaveBeenCalledWith("book-1", expect.objectContaining({ bookRound: "apply" }));
  });

  it("starts from what the settings of the book say, sends nothing when the author leaves it, and sends «off» when the author turns it off for this review", async () => {
    finished({ options: { ...DEFAULT_OPTIONS, review: { bookRound: "apply" } } }, LOCAL_BOOK, undefined, judgedPlan());
    show();
    const shown = await openDialog();
    expect(round(shown, "apply")).toBeChecked();
    const submit = await within(shown).findByRole("button", { name: /^Review \d+ chapters?$/ });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    await waitFor(() => expect(mocks.runtime.reviewBook).toHaveBeenCalledTimes(1));
    expect("bookRound" in (mocks.runtime.reviewBook.mock.calls[0][1] as object), "the same as the settings: the review inherits it").toBe(false);

    cleanup();
    mocks.runtime.reviewBook.mockClear();
    finished({ options: { ...DEFAULT_OPTIONS, review: { bookRound: "apply" } } }, LOCAL_BOOK, undefined, judgedPlan());
    show();
    const again = await openDialog();
    fireEvent.click(round(again, "off"));
    const second = await within(again).findByRole("button", { name: /^Review \d+ chapters?$/ });
    await waitFor(() => expect(second).toBeEnabled());
    fireEvent.click(second);
    await waitFor(() => expect(mocks.runtime.reviewBook).toHaveBeenCalledTimes(1));
    expect(mocks.runtime.reviewBook).toHaveBeenCalledWith("book-1", expect.objectContaining({ bookRound: "off" }));
  });

  it("on a personal server that predates the round: says so, offers none, and sends none, though the review goes on as it always did", async () => {
    const server = { ...LOCAL_BOOK, autopilotHost: "server" as const };
    finished({}, server, "online", judgedPlan());
    useAutopilotStore.setState((store) => ({ server: { ...store.server, info: SERVER_INFO_OF(CORE) } }));
    show(server);
    const shown = await openDialog();
    expect(within(shown).getByText(t("autopilot.review.bookRound.oldServer", { version: "0.1.23" }))).toBeInTheDocument();
    for (const mode of ["off", "apply", "ask"] as const) expect(round(shown, mode)).toBeDisabled();
    expect(round(shown, "off")).toBeChecked();
    const submit = await within(shown).findByRole("button", { name: /^Review \d+ chapters?$/ });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    await waitFor(() => expect(mocks.runtime.reviewBook).toHaveBeenCalledTimes(1));
    expect("bookRound" in (mocks.runtime.reviewBook.mock.calls[0][1] as object)).toBe(false);
  });

  it("is in Italian when the app is", async () => {
    await act(async () => { await i18n.changeLanguage("it"); });
    finished();
    show();
    fireEvent.click(screen.getByRole("button", { name: "Rivedi di nuovo il libro" }));
    const shown = await screen.findByRole("dialog", { name: "Rivedi di nuovo il libro" });
    fireEvent.click(within(shown).getByRole("radio", { name: "Mostrami prima le correzioni" }));
    expect(within(shown).getByRole("button", { name: "Chiedi le correzioni del libro" })).toBeEnabled();
  });
});
