import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BRIEF, DEFAULT_OPTIONS, createAutopilotState, defaultDirector, normalizeOptions, serializeDirector, type AutopilotState } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ director: null as string | null, estimateState: null as unknown }));

// The director's profile is what a blank field means: the card reads `director.md` of the book.
vi.mock("@/autopilot/useBookFiles", () => ({
  useBookFiles: (_bookId: string, paths: readonly string[]) => ({ files: new Map(paths.includes("director.md") && mocks.director ? [["director.md", mocks.director]] : []), failed: false }),
}));
vi.mock("@/autopilot/useRunEstimate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/useRunEstimate")>()),
  useRunEstimateSources: () => ({
    sources: { book: { read: true, directorFile: true, directorRounds: 2, context: {}, designWritten: false, outline: { entries: 4, lastChapter: 4, words: 400 } }, ai: null, aiFrom: "browser", activities: [], state: mocks.estimateState, chapters: null, canonEntries: 0, currency: "USD" },
    reading: false,
    server: { status: "idle" },
    host: "browser",
  }),
}));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { SetupCard } from "@/components/autopilot/config/SetupCard";
import { RunPreview } from "@/components/autopilot/config/RunPreview";
import { EMPTY_OUTLINE_BRIEF } from "@/autopilot/outlineBrief";
import { policyUpdate, readReviewForm, reviewFormOf, samePolicy, typedNumber } from "@/autopilot/reviewPolicy";
import type { BookEntry } from "@/types/settings";

const T0 = "2026-11-26T10:00:00.000Z";
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: T0 };
const FORM = { outline: { brief: EMPTY_OUTLINE_BRIEF, chapters: 4, lastChapter: 4, readable: true, loaded: true, reload: vi.fn() }, tab: "review", onTab: vi.fn(), onReset: vi.fn(), profiles: null };
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

const runtime = { start: vi.fn(async () => undefined), configure: vi.fn(async () => undefined) };
const run = vi.fn(async (_name: string, action: (runtime: unknown, bookId: string) => Promise<unknown>) => {
  await action(runtime, BOOK.id);
  return true;
});

const existing = (options: Record<string, unknown> = {}) => ({ ...createAutopilotState(new Date(T0), { ...DEFAULT_BRIEF, idea: "A glass harbor" }), options: { ...DEFAULT_OPTIONS, ...options } }) as AutopilotState;
const field = (key: string, options?: Record<string, unknown>) => screen.getByLabelText(t(`autopilot.review.${key}.label`, options)) as HTMLInputElement;
const drawn = () => screen.findByLabelText(t("autopilot.review.target.label"));

function openForm(state: AutopilotState | null = null, props: Record<string, unknown> = {}) {
  render(<MemoryRouter><SetupCard book={BOOK} state={state} {...FORM} running={false} busy={false} disabled={false} run={run as never} {...props} /></MemoryRouter>);
}

function type(input: HTMLInputElement, text: string) {
  fireEvent.change(input, { target: { value: text } });
  fireEvent.blur(input);
}

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  mocks.director = null;
  mocks.estimateState = null;
  runtime.start.mockClear();
  runtime.configure.mockClear();
});

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

describe("the form of the review, as the engine reads it", () => {
  it("reads blank fields as the defaults, a decimal comma as a point, and says what is wrong with a value", () => {
    expect(readReviewForm(reviewFormOf(DEFAULT_OPTIONS))).toEqual({ policy: {}, budgetLimit: 0, budgetTokens: 0, problems: {}, valid: true });
    const read = readReviewForm({ target: "8,5", rounds: "4", readerRounds: "2", campaignRounds: "3", money: "2,75", tokens: "900000" });
    expect(read).toEqual({ policy: { targetScore: 8.5, maxRounds: 4, readerRounds: 2, campaignMaxRounds: 3 }, budgetLimit: 2.75, budgetTokens: 900000, problems: {}, valid: true });
    expect(readReviewForm({ target: "8.3", rounds: "0", readerRounds: "1.5", campaignRounds: "0", money: "-1", tokens: "lots" }).problems).toEqual({ target: "step", rounds: "range", readerRounds: "number", money: "range", tokens: "number" });
    expect(readReviewForm({ ...reviewFormOf(DEFAULT_OPTIONS), target: "11" }).problems).toEqual({ target: "range" });
    expect(readReviewForm({ ...reviewFormOf(DEFAULT_OPTIONS), campaignRounds: "0" }).policy, "0 rounds of a review is no limit").toEqual({});
    expect([typedNumber(""), typedNumber(" 7 "), typedNumber("1.000,50"), typedNumber("7,5"), Number.isNaN(typedNumber("7a"))]).toEqual([null, 7, 1000.5, 7.5, true]);
  });

  it("sends every field of the policy, with null for the ones left to the director, which the engine reads as taking them back", () => {
    expect(policyUpdate({ targetScore: 8 })).toEqual({ targetScore: 8, maxRounds: null, readerRounds: null, campaignMaxRounds: null });
    const before = normalizeOptions({ review: { targetScore: 9, maxRounds: 5 } });
    expect(normalizeOptions({ review: policyUpdate({ targetScore: 8 }) }, before).review).toEqual({ targetScore: 8 });
    expect(normalizeOptions({ review: policyUpdate({}) }, before).review).toBeUndefined();
    expect([samePolicy(undefined, {}), samePolicy({ targetScore: 8 }, { targetScore: 8 }), samePolicy({ targetScore: 8 }, { targetScore: 8, maxRounds: 3 })]).toEqual([true, true, false]);
  });
});

describe("the card «Review» of the configuration", () => {
  it("has a labelled field for each value, with one line that says what it does, and the director's values as what a blank field means", async () => {
    mocks.director = serializeDirector({ ...defaultDirector("en"), approvalScore: 7.5, maxReviewRounds: 3 });
    openForm();
    await drawn();
    await waitFor(() => expect(field("target")).toHaveAttribute("placeholder", "7.5 (the director's)"));
    expect(field("rounds")).toHaveAttribute("placeholder", "3 (the director's)");
    for (const key of ["target", "rounds", "readerRounds", "campaignRounds", "tokens"]) {
      expect(field(key)).toHaveAccessibleDescription(t(`autopilot.review.${key}.hint`));
    }
    expect(field("money", { currency: "USD" })).toHaveAccessibleDescription(/Spent so far: \$0\.00/);
    expect(screen.getByRole("region", { name: t("autopilot.review.title") })).toBeInTheDocument();
  });

  it("starts the autopilot with the policy typed, field by field", async () => {
    openForm();
    await drawn();
    type(field("target"), "8,5");
    type(field("rounds"), "4");
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.actions.start") }));
    await waitFor(() => expect(runtime.start).toHaveBeenCalledTimes(1));
    const [, started] = runtime.start.mock.calls[0] as unknown as [string, { options: Record<string, unknown> }];
    expect(started.options.review).toEqual({ targetScore: 8.5, maxRounds: 4, readerRounds: null, campaignMaxRounds: null });
    expect(normalizeOptions(started.options).review).toEqual({ targetScore: 8.5, maxRounds: 4 });
  });

  it("shows the policy the book has, and a field emptied goes back to the director's", async () => {
    openForm(existing({ review: { targetScore: 9, maxRounds: 5, campaignMaxRounds: 2 } }));
    await drawn();
    expect([field("target").value, field("rounds").value, field("readerRounds").value, field("campaignRounds").value]).toEqual(["9", "5", "", "2"]);
    type(field("target"), "");
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.setup.save") }));
    await waitFor(() => expect(runtime.configure).toHaveBeenCalledTimes(1));
    const [, saved] = runtime.configure.mock.calls[0] as unknown as [string, { options: Record<string, unknown> }];
    expect(saved.options.review).toEqual({ targetScore: null, maxRounds: 5, readerRounds: null, campaignMaxRounds: 2 });
  });

  it("says what is wrong under the field, takes the focus there, and saves nothing", async () => {
    openForm();
    await drawn();
    type(field("target"), "8.2");
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.actions.start") }));
    await waitFor(() => expect(field("target")).toHaveFocus());
    expect(field("target")).toHaveAttribute("aria-invalid", "true");
    expect(field("target")).toHaveAccessibleDescription(new RegExp(t("autopilot.review.problems.step").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it("keeps the readers' rounds closed while the readers are off, and says why", async () => {
    openForm(existing({ readers: false }));
    await drawn();
    expect(field("readerRounds")).toBeDisabled();
    expect(field("readerRounds")).toHaveAccessibleDescription(t("autopilot.review.readerRounds.off"));
  });

  it("on a personal server that predates the policy: the score and the rounds are the director's, the caps still work, and no policy is sent", async () => {
    openForm(existing(), { reviewPolicyUnsupported: true });
    await drawn();
    expect(screen.getByText(t("autopilot.review.oldServer", { version: "0.1.19" }))).toBeInTheDocument();
    for (const key of ["target", "rounds", "readerRounds", "campaignRounds"]) expect(field(key)).toBeDisabled();
    expect(field("money", { currency: "USD" })).toBeEnabled();
    type(field("money", { currency: "USD" }), "5");
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.setup.save") }));
    await waitFor(() => expect(runtime.configure).toHaveBeenCalledTimes(1));
    const [, saved] = runtime.configure.mock.calls[0] as unknown as [string, { options: Record<string, unknown> }];
    expect(saved.options.budgetLimit).toBe(5);
    expect("review" in saved.options).toBe(false);
  });

  it("shows the estimate of the run with the new values once one changed, and not before", async () => {
    render(<MemoryRouter><SetupCard book={BOOK} state={existing()} {...FORM} running={false} busy={false} disabled={false} run={run as never} branch="main" /></MemoryRouter>);
    await drawn();
    expect(document.querySelector("[data-review-estimate]")).toBeNull();
    type(field("rounds"), "6");
    await waitFor(() => expect(document.querySelector("[data-review-estimate]")).not.toBeNull());
    expect(document.querySelector("[data-review-estimate]")?.textContent).toContain(t("autopilot.review.estimate.run"));
    expect(document.querySelector("[data-review-estimate]")?.textContent).toMatch(/AI calls/);
  });

  it("says, for a finished book, that nothing is left for a run: the values are for the chapters to come and for a review of the book", async () => {
    const finished = { ...existing(), finalDone: true, plan: { approved: true, rounds: 1, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false, chapters: [1, 2, 3, 4].map((number) => ({ number, title: `C${number}`, slug: `00${number}-c`, summary: "", goal: "", keyEvents: [], reveals: [], status: "done", scenes: [{ number: 1, title: "S", goal: "", beats: [], characters: [], status: "reviewed", revisions: 0 }] })) } } as unknown as AutopilotState;
    mocks.estimateState = finished;
    render(<MemoryRouter><SetupCard book={BOOK} state={finished} {...FORM} running={false} busy={false} disabled={false} run={run as never} branch="main" /></MemoryRouter>);
    await drawn();
    type(field("rounds"), "6");
    await waitFor(() => expect(document.querySelector("[data-review-estimate='nothing']")).not.toBeNull());
    expect(document.querySelector("[data-review-estimate='nothing']")?.textContent).toBe(t("autopilot.review.estimate.nothing"));
  });

  it("makes the preview of the run say the rounds of the policy, next to the director's", () => {
    const inputs = { sources: { book: { read: true, directorFile: true, directorRounds: 2, context: {}, designWritten: false, outline: { entries: 4, lastChapter: 4, words: 400 } }, ai: null, aiFrom: "browser" as const, activities: [], state: null, chapters: null, canonEntries: 0, currency: "USD" }, reading: false, server: { status: "idle" as const }, host: "browser" as const };
    const { rerender } = render(<MemoryRouter><RunPreview inputs={inputs} form={{ brief: DEFAULT_BRIEF, options: { ...DEFAULT_OPTIONS, review: { maxRounds: 5 } } }} dirty={false} bookId="book-1" /></MemoryRouter>);
    expect(document.querySelector("[data-estimate='rounds']")?.textContent).toContain("The review of this run allows up to 5 rounds of review per chapter (your director: 2).");
    rerender(<MemoryRouter><RunPreview inputs={inputs} form={{ brief: DEFAULT_BRIEF, options: DEFAULT_OPTIONS }} dirty={false} bookId="book-1" /></MemoryRouter>);
    expect(document.querySelector("[data-estimate='rounds']")?.textContent).toContain("Your director allows up to 2 rounds of review per chapter.");
  });

  it("is in Italian when the app is", async () => {
    await i18n.changeLanguage("it");
    openForm();
    expect(await screen.findByLabelText("Voto da raggiungere")).toBeInTheDocument();
    expect(screen.getByLabelText("Giri del direttore per capitolo")).toBeInTheDocument();
    expect(screen.getByLabelText("Tetto di spesa (USD)")).toHaveAccessibleDescription(/Non si azzera mai/);
  });
});
