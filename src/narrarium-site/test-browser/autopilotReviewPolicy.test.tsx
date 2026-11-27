import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { hasReaderTargets, policyUpdate, policyWithoutReaderTargets, readReviewForm, reviewFormOf, samePolicy, typedNumber } from "@/autopilot/reviewPolicy";
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
    expect(readReviewForm(reviewFormOf(DEFAULT_OPTIONS))).toEqual({ policy: {}, budgetLimit: 0, budgetTokens: 0, problems: {}, readerProblems: {}, valid: true });
    const read = readReviewForm({ target: "8,5", rounds: "4", readerRounds: "2", campaignRounds: "3", money: "2,75", tokens: "900000" });
    expect(read).toEqual({ policy: { targetScore: 8.5, maxRounds: 4, readerRounds: 2, campaignMaxRounds: 3 }, budgetLimit: 2.75, budgetTokens: 900000, problems: {}, readerProblems: {}, valid: true });
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

  describe("the targets for the readers", () => {
    const blank = reviewFormOf(DEFAULT_OPTIONS);

    it("reads the average, the target of each reader and the readers that do not count, and says what is wrong with each", () => {
      const read = readReviewForm({ ...blank, readersTarget: "7,5", readerTargets: { a: "8", b: "", c: " 6.5 " }, readersExcluded: ["z", "z", "y"] });
      expect(read.policy).toEqual({ readersTarget: 7.5, readerTargets: { a: 8, c: 6.5 }, readersExcluded: ["z", "y"] });
      expect(read).toMatchObject({ problems: {}, readerProblems: {}, valid: true });
      const wrong = readReviewForm({ ...blank, readersTarget: "11", readerTargets: { a: "0.5", b: "7.25", c: "x", d: "10" } });
      expect(wrong.problems).toEqual({ readersTarget: "range" });
      expect(wrong.readerProblems).toEqual({ a: "range", b: "tenth", c: "number" });
      expect([wrong.valid, wrong.policy.readerTargets]).toEqual([false, { d: 10 }]);
      expect(readReviewForm({ ...blank, readersTarget: "7.25" }).problems).toEqual({ readersTarget: "tenth" });
      expect(readReviewForm(blank).policy, "a book without them has none").toEqual({});
    });

    it("shows the form of what the options say, and reads it back as it was", () => {
      const options = normalizeOptions({ review: { targetScore: 8, readersTarget: 7.5, readerTargets: { a: 8 }, readersExcluded: ["b"] } });
      const form = reviewFormOf(options);
      expect([form.readersTarget, form.readerTargets, form.readersExcluded]).toEqual(["7.5", { a: "8" }, ["b"]]);
      expect(readReviewForm(form).policy).toEqual(options.review);
    });

    it("sends the targets only when there is one or the book had one to take back, so that a server that predates them is never sent a field it has nothing of", () => {
      expect(policyUpdate({ targetScore: 8 })).toEqual({ targetScore: 8, maxRounds: null, readerRounds: null, campaignMaxRounds: null });
      expect(policyUpdate({ targetScore: 8 }, { targetScore: 8 })).not.toHaveProperty("readersTarget");
      expect(policyUpdate({ readersTarget: 7.5, readerTargets: { a: 8 }, readersExcluded: ["b"] })).toMatchObject({ readersTarget: 7.5, readerTargets: { a: 8 }, readersExcluded: ["b"] });
      expect(policyUpdate({}, { readersTarget: 7, readerTargets: { a: 8 }, readersExcluded: ["b"] })).toMatchObject({ readersTarget: null, readerTargets: null, readersExcluded: null });
      const before = normalizeOptions({ review: { readersTarget: 7, readerTargets: { a: 8 }, readersExcluded: ["b"] } });
      expect(normalizeOptions({ review: policyUpdate({}, before.review) }, before).review, "emptied, they go back").toBeUndefined();
      expect(policyWithoutReaderTargets({ targetScore: 8, readersTarget: 7, readerTargets: { a: 8 }, readersExcluded: ["b"] })).toEqual({ targetScore: 8 });
      expect([hasReaderTargets({ targetScore: 8 }), hasReaderTargets({ readersTarget: 7 }), hasReaderTargets({ readersExcluded: ["a"] }), hasReaderTargets({ readerTargets: {} })]).toEqual([false, true, true, false]);
    });

    it("tells two policies apart by the targets for the readers too, whatever the order of what they list", () => {
      expect(samePolicy({ readersTarget: 7 }, { readersTarget: 7 })).toBe(true);
      expect(samePolicy({ readersTarget: 7 }, {})).toBe(false);
      expect(samePolicy({ readerTargets: { a: 8, b: 6 } }, { readerTargets: { b: 6, a: 8 } })).toBe(true);
      expect(samePolicy({ readerTargets: { a: 8 } }, { readerTargets: { a: 7 } })).toBe(false);
      expect(samePolicy({ readersExcluded: ["a", "b"] }, { readersExcluded: ["b", "a"] })).toBe(true);
      expect(samePolicy({ readersExcluded: ["a"] }, undefined)).toBe(false);
    });
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

  describe("and the targets for the readers", () => {
    const readersPart = () => document.querySelector<HTMLElement>("[data-reader-targets]") as HTMLElement;
    const average = () => screen.getByLabelText(t("autopilot.review.readers.average.label")) as HTMLInputElement;
    const targetOf = (name: string) => screen.getByLabelText(t("autopilot.review.readers.table.targetLabel", { name })) as HTMLInputElement;
    const countsOf = (name: string) => screen.getByLabelText(t("autopilot.review.readers.table.countsLabel", { name })) as HTMLInputElement;
    const startAndRead = async () => {
      fireEvent.click(screen.getByRole("button", { name: t("autopilot.actions.start") }));
      await waitFor(() => expect(runtime.start).toHaveBeenCalledTimes(1));
      return (runtime.start.mock.calls[0] as unknown as [string, { options: Record<string, unknown> }])[1].options.review as Record<string, unknown>;
    };

    it("has the average of the readers and a table with each active reader: its weight (the director's), its target and whether it counts, each said in a line", async () => {
      mocks.director = serializeDirector({ ...defaultDirector("en"), readerWeights: { "standard-critical": 3, "standard-plot": 0 } });
      openForm();
      await drawn();
      expect(screen.getByRole("heading", { level: 3, name: t("autopilot.review.readers.title") })).toBeInTheDocument();
      expect(average()).toHaveAccessibleDescription(t("autopilot.review.readers.average.hint"));
      const table = within(readersPart()).getByRole("table", { name: t("autopilot.review.readers.table.label") });
      expect(within(table).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Reader", "Weight", "Target", "Counts"]);
      // The panel's first five readers that the director does not ignore: the plot reader has a weight of 0, so the sixth takes its place.
      expect(within(table).getAllByRole("rowheader").map((header) => header.textContent)).toEqual(["General Reader", "Emotional Reader", "Critical Reader", "Character Reader", "Style Reader"]);
      const critical = within(table).getByRole("row", { name: /Critical Reader/ });
      expect(critical).toHaveTextContent("×3");
      expect(critical).toHaveTextContent(t("autopilot.review.readers.table.weightText", { weight: 3 }));
      expect(targetOf("Critical Reader")).toHaveAttribute("placeholder", t("autopilot.review.readers.table.targetPlaceholder"));
      expect(countsOf("Critical Reader")).toBeChecked();
      expect(screen.getByText(t("autopilot.review.readers.table.hint"))).toBeInTheDocument();
      expect(screen.getByText(t("autopilot.review.readers.intro"))).toBeInTheDocument();
    });

    it("starts the autopilot with the targets typed: the average, a target for a reader, and a reader that does not count", async () => {
      openForm();
      await drawn();
      type(average(), "7,5");
      type(targetOf("Emotional Reader"), "8");
      fireEvent.click(countsOf("Critical Reader"));
      expect(countsOf("Critical Reader")).not.toBeChecked();
      expect(targetOf("Critical Reader"), "a reader that does not count is not asked a target").toBeDisabled();
      const review = await startAndRead();
      expect(review).toMatchObject({ readersTarget: 7.5, readerTargets: { "standard-emotional": 8 }, readersExcluded: ["standard-critical"] });
      expect(normalizeOptions({ review }).review).toEqual({ readersTarget: 7.5, readerTargets: { "standard-emotional": 8 }, readersExcluded: ["standard-critical"] });
    });

    it("shows the targets the book has, and taking them away sends null for each, which the engine reads as taking them back", async () => {
      openForm(existing({ review: { readersTarget: 7, readerTargets: { "standard-general": 8 }, readersExcluded: ["standard-critical"] } }));
      await drawn();
      expect([average().value, targetOf("General Reader").value, countsOf("Critical Reader").checked]).toEqual(["7", "8", false]);
      type(average(), "");
      type(targetOf("General Reader"), "");
      fireEvent.click(countsOf("Critical Reader"));
      fireEvent.click(screen.getByRole("button", { name: t("autopilot.setup.save") }));
      await waitFor(() => expect(runtime.configure).toHaveBeenCalledTimes(1));
      const [, saved] = runtime.configure.mock.calls[0] as unknown as [string, { options: Record<string, unknown> }];
      expect(saved.options.review).toEqual({ targetScore: null, maxRounds: null, readerRounds: null, campaignMaxRounds: null, readersTarget: null, readerTargets: null, readersExcluded: null });
      expect(normalizeOptions({ review: saved.options.review }, normalizeOptions({ review: { readersTarget: 7, readerTargets: { a: 8 }, readersExcluded: ["b"] } })).review).toBeUndefined();
    });

    it("says what is wrong under the field of a reader or of the average, takes the focus there, and sends nothing", async () => {
      openForm();
      await drawn();
      type(targetOf("General Reader"), "11");
      type(average(), "7.25");
      fireEvent.click(screen.getByRole("button", { name: t("autopilot.actions.start") }));
      await waitFor(() => expect(average()).toHaveFocus());
      expect(average()).toHaveAttribute("aria-invalid", "true");
      expect(average()).toHaveAccessibleDescription(new RegExp(t("autopilot.review.problems.tenth").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      expect(targetOf("General Reader")).toHaveAttribute("aria-invalid", "true");
      expect(targetOf("General Reader")).toHaveAccessibleDescription(t("autopilot.review.problems.range", { min: 1, max: 10 }));
      expect(runtime.start).not.toHaveBeenCalled();
    });

    it("keeps it all closed while the readers are off, and says why", async () => {
      openForm(existing({ readers: false }));
      await drawn();
      expect(readersPart()).toHaveTextContent(t("autopilot.review.readers.off"));
      expect(average()).toBeDisabled();
      expect(targetOf("General Reader")).toBeDisabled();
      expect(countsOf("General Reader")).toBeDisabled();
    });

    it("on a personal server that has the policy but not the targets: it says so, offers none, and never sends what the book has of them", async () => {
      openForm(existing({ review: { targetScore: 8, readersTarget: 7 } }), { reviewTargetsUnsupported: true });
      await drawn();
      expect(readersPart()).toHaveTextContent(t("autopilot.review.readers.oldServer", { version: "0.1.21" }));
      expect(average()).toBeDisabled();
      expect(field("target")).toBeEnabled();
      type(field("rounds"), "4");
      fireEvent.click(screen.getByRole("button", { name: t("autopilot.setup.save") }));
      await waitFor(() => expect(runtime.configure).toHaveBeenCalledTimes(1));
      const [, saved] = runtime.configure.mock.calls[0] as unknown as [string, { options: { review: Record<string, unknown> } }];
      expect(saved.options.review).toEqual({ targetScore: 8, maxRounds: 4, readerRounds: null, campaignMaxRounds: null });
    });

    it("says what the targets add to the estimate of the run, in one line, once they are set", async () => {
      render(<MemoryRouter><SetupCard book={BOOK} state={existing()} {...FORM} running={false} busy={false} disabled={false} run={run as never} branch="main" /></MemoryRouter>);
      await drawn();
      type(average(), "7.5");
      const delta = await waitFor(() => {
        const found = document.querySelector("[data-review-readers-delta]");
        expect(found).not.toBeNull();
        return found as HTMLElement;
      });
      expect(delta.textContent).toMatch(/^What the readers' targets add: .* AI calls/);
    });

    it("is in Italian when the app is", async () => {
      await i18n.changeLanguage("it");
      openForm();
      expect(await screen.findByLabelText("Media dei lettori da raggiungere")).toBeInTheDocument();
      expect(screen.getByRole("heading", { level: 3, name: "Obiettivi dei lettori" })).toBeInTheDocument();
      expect(screen.getByLabelText("Obiettivo di General Reader")).toBeInTheDocument();
      expect(screen.getByLabelText("General Reader conta nella media e negli obiettivi")).toBeChecked();
    });
  });

  it("is in Italian when the app is", async () => {
    await i18n.changeLanguage("it");
    openForm();
    expect(await screen.findByLabelText("Voto da raggiungere")).toBeInTheDocument();
    expect(screen.getByLabelText("Giri del direttore per capitolo")).toBeInTheDocument();
    expect(screen.getByLabelText("Tetto di spesa (USD)")).toHaveAccessibleDescription(/Non si azzera mai/);
  });
});
