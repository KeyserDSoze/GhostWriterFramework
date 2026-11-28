import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_OPTIONS, defaultDirector, serializeDirector, type AutopilotFinalReview, type ReviewRecord } from "narrarium-engine";

const mocks = vi.hoisted(() => ({
  files: new Map<string, string>(),
  runtime: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
  /** The AI configuration the estimate reads: none, or a priced one. */
  ai: null as unknown,
}));

// What the dialog reads of the book: the director's profile and the records of the frozen chapters.
vi.mock("@/autopilot/useBookFiles", () => ({
  useBookFiles: (_bookId: string, paths: readonly string[]) => ({ files: new Map(paths.flatMap((path) => (mocks.files.has(path) ? [[path, mocks.files.get(path) as string]] : []))), failed: false }),
}));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/autopilot/useRunEstimate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/useRunEstimate")>()),
  useRunEstimateSources: () => ({
    sources: { book: { read: true, directorFile: true, directorRounds: 2, context: {}, designWritten: false, outline: { entries: 12, lastChapter: 12, words: 1200 } }, ai: mocks.ai, aiFrom: "browser", activities: [], state: null, chapters: null, canonEntries: 0, currency: "USD" },
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
import "@/i18n/costs";
import { defaultReviewTarget, reviewCandidates, reviewRounds, chapterScores } from "@/autopilot/resultModel";
import { judgedPlan } from "./helpers/autopilotFixtures";
import { seedRun } from "./helpers/autopilotBand";
import { LOCAL_BOOK, t } from "./helpers/quickCommands";
import { SERVER_INFO } from "./helpers/fakeBookServer";

const SERVER_INFO_OF = (features: string[]) => ({ ...SERVER_INFO, serverVersion: "0.1.18", features });

const REVIEW: AutopilotFinalReview = { verdict: "revise", score: 6.5, text: "The middle drags.", at: "2026-11-21T10:30:00.000Z" };
const chapterFile = (slug: string) => `chapters/${slug}/chapter.md`;
const frozenBy = (by: "author" | "autopilot") => `---\ntype: chapter\nid: chapter:x\nnumber: 1\ntitle: X\nfrozen:\n  at: 2026-11-21T10:00:00.000Z\n  by: ${by}\n  digest: 0123456789abcdef\n  files: {}\n---\n# X\n`;

function finished(patch: Record<string, unknown> = {}, book: BookEntry = LOCAL_BOOK, server?: Parameters<typeof seedRun>[0]["server"]) {
  const chapters = judgedPlan();
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
  return render(<MemoryRouter><AutopilotResult bookId={book.id} linkedSlugs={new Set()} review={{ book, branch: "main" }} /></MemoryRouter>);
}

const dialog = () => screen.findByRole("dialog", { name: t("autopilot.reviewBook.title") });
const openDialog = async () => {
  fireEvent.click(screen.getByRole("button", { name: t("autopilot.result.actions.review") }));
  return dialog();
};

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.ai = null;
  mocks.files = new Map([["director.md", serializeDirector({ ...defaultDirector("en"), approvalScore: 7, maxReviewRounds: 2 })]]);
  mocks.runtime = {
    refresh: vi.fn(async () => null),
    frozenStatus: vi.fn(async () => ({ mode: "ask", changes: [{ kind: "frozen", number: 6, slug: "006-chapter-6", title: "Chapter 6", fingerprint: "f", actions: [] }], pending: [], warnings: [] })),
    reviewBook: vi.fn(async () => ({ campaign: null, frozen: { mode: "ask", changes: [], pending: [], warnings: [] } })),
    start: vi.fn(async () => undefined),
    allowBudgetOverrun: vi.fn(),
    describeError: vi.fn((error: unknown) => String(error)),
  };
});

afterEach(async () => {
  cleanup();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [] });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("the model of a review of the book", () => {
  it("sums the rounds of review of the chapters, and starts a new review one point over the target in force, 8 at least", () => {
    expect(reviewRounds(chapterScores(judgedPlan()))).toEqual({ rounds: 20, most: 3, chapters: 12 });
    expect(reviewRounds([])).toBeNull();
    expect([defaultReviewTarget(6), defaultReviewTarget(7), defaultReviewTarget(8), defaultReviewTarget(9.5), defaultReviewTarget(8.3)]).toEqual([8, 8, 9, 10, 9.5]);
  });

  it("takes the chapters under the target in the order of the book, and tells the author's and the changed ones apart, as the engine does", () => {
    const chapters = judgedPlan();
    const freezes = new Map<string, "author" | "autopilot">([[chapters[3].slug, "author"], [chapters[7].slug, "autopilot"]]);
    const candidates = reviewCandidates(chapters, 8, freezes, new Set([6]));
    expect(candidates.map((entry) => [entry.number, entry.vote, entry.kind])).toEqual([[2, 7.5, "review"], [4, 6, "author"], [6, 7, "changed"], [8, 5.5, "review"], [10, 7.5, "review"], [12, 7.5, "review"]]);
    const imported = chapters.map((chapter, index) => (index === 1 ? { ...chapter, imported: true } : chapter));
    expect(reviewCandidates(imported, 8, new Map(), new Set())[0].kind, "written before the autopilot, and not frozen by it").toBe("author");
    expect(reviewCandidates(imported, 8, new Map([[chapters[1].slug, "autopilot"]]), new Set())[0].kind, "imported by a plan made again, but the autopilot's").toBe("review");
  });
});

describe("«Review the book again» against the budget", () => {
  const PRICED = { aiIntegrations: [{ id: "cloud", name: "Cloud", provider: "openai", endpoint: "https://api.example.test/v1", apiKey: "sk-secret", chatModels: [{ id: "m1", name: "writer-1", capabilities: ["default"], supportsToolCalls: true, maxInputTokens: 128_000, maxOutputTokens: 16_000, pricing: { inputPerMTok: 2, outputPerMTok: 8 } }] }], defaultWritingIntegrationId: "cloud", costCurrency: "USD" };

  it("says what a round is estimated at against what is left, and starts it past the budgets when the author says so", async () => {
    mocks.ai = PRICED;
    finished();
    useSettingsStore.setState((store) => ({ settings: { ...store.settings, costCurrency: "USD", costBudgets: { global: { USD: { total: 0.5 } } } } }));
    show();
    const shown = await openDialog();
    await waitFor(() => expect(shown.querySelector("[data-budget-outlook]")).not.toBeNull());
    const box = shown.querySelector<HTMLElement>("[data-budget-outlook]")!;
    expect(box.getAttribute("data-budget-outlook")).toBe("stops");
    expect(box.querySelector("[data-outlook-text]")?.textContent).toMatch(/This run is estimated at .*you have \$0\.50 left in the budget \(All books, in total\): it would stop before it finishes\./);
    fireEvent.click(within(box).getByRole("button", { name: "Start anyway" }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledTimes(1));
    expect(mocks.runtime.allowBudgetOverrun).toHaveBeenCalledWith("book-1");
    expect(mocks.runtime.reviewBook.mock.invocationCallOrder[0]).toBeLessThan(mocks.runtime.allowBudgetOverrun.mock.invocationCallOrder[0]);
    expect(mocks.runtime.allowBudgetOverrun.mock.invocationCallOrder[0]).toBeLessThan(mocks.runtime.start.mock.invocationCallOrder[0]);
  });

  it("does not start past the budgets when the author starts the review as it is", async () => {
    mocks.ai = PRICED;
    finished();
    useSettingsStore.setState((store) => ({ settings: { ...store.settings, costCurrency: "USD", costBudgets: { global: { USD: { total: 0.5 } } } } }));
    show();
    const shown = await openDialog();
    await waitFor(() => expect(shown.querySelector("[data-budget-outlook]")).not.toBeNull());
    fireEvent.click(within(shown).getByRole("button", { name: /^Review \d+ chapters?$/ }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledTimes(1));
    expect(mocks.runtime.allowBudgetOverrun).not.toHaveBeenCalled();
  });

  it("says nothing when no budget limits the run", async () => {
    mocks.ai = PRICED;
    finished();
    show();
    const shown = await openDialog();
    await waitFor(() => expect(shown.querySelector("[data-review-estimate]")).not.toBeNull());
    expect(shown.querySelector("[data-budget-outlook]")).toBeNull();
  });
});

describe("«Review the book again» on the card of a finished book", () => {
  it("is the first action, and opens the dialog with the target one point over the director's, the chapters under it and what a round costs", async () => {
    mocks.files.set(chapterFile(judgedPlan()[3].slug), frozenBy("author"));
    finished();
    show();
    const actions = screen.getByRole("group", { name: t("autopilot.result.actions.label") });
    expect(within(actions).getAllByRole("button")[0]).toHaveTextContent(t("autopilot.result.actions.review"));
    const shown = await openDialog();
    const target = within(shown).getByLabelText(t("autopilot.review.target.label")) as HTMLInputElement;
    expect(target.value).toBe("8");
    expect(within(shown).getByLabelText(t("autopilot.review.rounds.label"))).toHaveValue("2");
    await waitFor(() => expect(within(shown).getByRole("heading", { name: "4 chapters under 8/10 will be reviewed again" })).toBeInTheDocument());
    const listed = [...shown.querySelectorAll("[data-review-chapter]")].map((item) => Number(item.getAttribute("data-review-chapter")));
    expect(listed).toEqual([2, 8, 10, 12]);
    expect(within(shown).getByRole("checkbox", { name: /Chapter 4/ })).not.toBeChecked();
    expect(within(shown).getByText(t("autopilot.reviewBook.changedTitle"))).toBeInTheDocument();
    expect(shown.querySelector("[data-review-estimate]")?.textContent).toContain("One round: 4 chapters reviewed again");
    expect(within(shown).getByLabelText(t("autopilot.review.money.label", { currency: "USD" }))).toHaveAccessibleDescription(/Spent so far: \$17\.62, with no cap/);
  });

  it("records the review with what the author chose, the author's chapter included, and starts the autopilot", async () => {
    mocks.files.set(chapterFile(judgedPlan()[3].slug), frozenBy("author"));
    finished();
    show();
    const shown = await openDialog();
    await waitFor(() => expect(within(shown).getByRole("checkbox", { name: /Chapter 4/ })).toBeInTheDocument());
    fireEvent.click(within(shown).getByRole("checkbox", { name: /Chapter 4/ }));
    fireEvent.change(within(shown).getByLabelText(t("autopilot.review.rounds.label")), { target: { value: "4" } });
    fireEvent.change(within(shown).getByLabelText(t("autopilot.review.campaignRounds.label")), { target: { value: "3" } });
    fireEvent.change(within(shown).getByLabelText(t("autopilot.review.money.label", { currency: "USD" })), { target: { value: "25" } });
    expect(within(shown).getByLabelText(t("autopilot.review.money.label", { currency: "USD" }))).toHaveAccessibleDescription(/Spent so far: \$17\.62 of \$25\.00/);
    const submit = within(shown).getByRole("button", { name: "Review 5 chapters" });
    fireEvent.click(submit);
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledTimes(1));
    expect(mocks.runtime.reviewBook).toHaveBeenCalledWith("book-1", { targetScore: 8, maxRounds: 4, readerRounds: 1, campaignMaxRounds: 3, budgetLimit: 25, include: [4] });
    expect(mocks.runtime.reviewBook.mock.invocationCallOrder[0]).toBeLessThan(mocks.runtime.start.mock.invocationCallOrder[0]);
  });

  it("follows the target: more chapters under a higher one, none under a low one (and nothing to send), a problem for one that is not on a half point", async () => {
    finished();
    show();
    const shown = await openDialog();
    const target = within(shown).getByLabelText(t("autopilot.review.target.label"));
    fireEvent.change(target, { target: { value: "9,5" } });
    // Every chapter is under 9.5; chapter 6 changed since it was frozen, and waits for the decision about that change.
    await waitFor(() => expect(within(shown).getByRole("heading", { name: "11 chapters under 9.5/10 will be reviewed again" })).toBeInTheDocument());
    fireEvent.change(target, { target: { value: "5" } });
    expect(within(shown).getByText(t("autopilot.reviewBook.nothing", { target: "5/10", book: "6.5/10" }))).toBeInTheDocument();
    expect(within(shown).getByRole("button", { name: "Review 0 chapters" })).toBeDisabled();
    // Said once to a screen reader when the values stop changing.
    await waitFor(() => expect(shown.querySelector("[data-review-announcement]")?.textContent).toBe("0 chapters under 5/10 will be reviewed again"), { timeout: 20_000 });
    fireEvent.change(target, { target: { value: "8.2" } });
    expect(target).toHaveAttribute("aria-invalid", "true");
    expect(target).toHaveAccessibleDescription(new RegExp(t("autopilot.review.problems.step").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("says that an older personal server cannot do it, and sends nothing", async () => {
    const server = { ...LOCAL_BOOK, autopilotHost: "server" as const };
    finished({}, server, "online");
    useAutopilotStore.setState((store) => ({ server: { ...store.server, info: SERVER_INFO_OF(["autopilot", "autopilot-outline-apply"]) } }));
    show(server);
    const shown = await openDialog();
    expect(within(shown).getByText(t("autopilot.reviewBook.oldServer", { version: "0.1.19" }))).toBeInTheDocument();
    await waitFor(() => expect(shown.querySelectorAll("[data-review-chapter]").length).toBeGreaterThan(0));
    expect(within(shown).getByRole("button", { name: /Review \d+ chapters/ })).toBeDisabled();
  });

  describe("with targets for the readers", () => {
    const average = (shown: HTMLElement) => within(shown).getByLabelText(t("autopilot.review.readers.average.label")) as HTMLInputElement;
    const heading = (shown: HTMLElement) => shown.querySelector<HTMLElement>("h3[id$='-chapters']") as HTMLElement;

    it("offers the average and each reader, and takes up the chapters whose readers' vote is under a target, saying why: the director may be content with them", async () => {
      finished();
      show();
      const shown = await openDialog();
      expect(within(shown).getByRole("heading", { level: 3, name: t("autopilot.review.readers.title") })).toBeInTheDocument();
      expect(within(shown).getByRole("table", { name: t("autopilot.review.readers.table.label") })).toBeInTheDocument();
      // Chapter 6 changed since it was frozen: it waits for the decision about that change, and is not among the ones reviewed.
      await waitFor(() => expect(heading(shown)).toHaveTextContent("5 chapters under 8/10 will be reviewed again"));
      fireEvent.change(average(shown), { target: { value: "8" } });
      // The readers' last vote of chapters 1 and 7 is a 7 and a 7.6, under 8: the director is content with them (8), so the readers are asked, and the review is whole only if a target is missed.
      const expected = reviewCandidates(judgedPlan(), 8, new Map(), new Set([6]), { average: 8, each: {}, excluded: new Set() }).filter((entry) => entry.kind === "review");
      await waitFor(() => expect(heading(shown)).toHaveTextContent(`${expected.length} chapters under 8/10 or under a target of the readers will be taken up`));
      expect([...shown.querySelectorAll("[data-review-chapter]")].map((item) => Number(item.getAttribute("data-review-chapter")))).toEqual(expected.map((entry) => entry.number));
      const first = shown.querySelector("[data-review-chapter='1']") as HTMLElement;
      expect(first).toHaveTextContent("readers 7/10");
      expect(first).toHaveTextContent(t("autopilot.reviewBook.readersOnly"));
      expect(shown.querySelector("[data-review-chapter='2']")).not.toHaveTextContent(t("autopilot.reviewBook.readersOnly"));
      // The estimate says how many only need their readers' vote, and what the targets add.
      expect(shown.querySelector("[data-review-estimate]")?.textContent).toContain(t("autopilot.reviewBook.estimateReadersOnly", { count: expected.filter((entry) => entry.why === "readers").length }));
      expect(shown.querySelector("[data-review-readers-delta]")).not.toBeNull();
    });

    it("sends the review's own targets with it: the average, a target for a reader and a reader that does not count", async () => {
      finished();
      show();
      const shown = await openDialog();
      fireEvent.change(average(shown), { target: { value: "7,5" } });
      fireEvent.change(within(shown).getByLabelText(t("autopilot.review.readers.table.targetLabel", { name: "Emotional Reader" })), { target: { value: "8" } });
      fireEvent.click(within(shown).getByLabelText(t("autopilot.review.readers.table.countsLabel", { name: "Critical Reader" })));
      await waitFor(() => expect(within(shown).getByRole("button", { name: /^Review \d+ chapters?$/ })).toBeEnabled());
      fireEvent.click(within(shown).getByRole("button", { name: /^Review \d+ chapters?$/ }));
      await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledTimes(1));
      expect(mocks.runtime.reviewBook).toHaveBeenCalledWith("book-1", expect.objectContaining({ targetScore: 8, readersTarget: 7.5, readerTargets: { "standard-emotional": 8 }, readersExcluded: ["standard-critical"] }));
    });

    it("starts from the targets of the run, and sends nothing of them when there are none", async () => {
      finished({ options: { ...DEFAULT_OPTIONS, review: { readersTarget: 7, readerTargets: { "standard-general": 8 }, readersExcluded: ["standard-critical"] } } });
      show();
      const shown = await openDialog();
      expect(average(shown).value).toBe("7");
      expect((within(shown).getByLabelText(t("autopilot.review.readers.table.targetLabel", { name: "General Reader" })) as HTMLInputElement).value).toBe("8");
      expect(within(shown).getByLabelText(t("autopilot.review.readers.table.countsLabel", { name: "Critical Reader" }))).not.toBeChecked();
    });

    it("says what is wrong with a vote for the readers, and does not let the review go on", async () => {
      finished();
      show();
      const shown = await openDialog();
      fireEvent.change(average(shown), { target: { value: "7.25" } });
      expect(average(shown)).toHaveAttribute("aria-invalid", "true");
      expect(average(shown)).toHaveAccessibleDescription(new RegExp(t("autopilot.review.problems.tenth").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      await waitFor(() => expect(within(shown).getByRole("button", { name: /^Review \d+ chapters?$/ })).toBeDisabled());
    });

    it("on a personal server that reviews the book but predates the targets: says so, offers none, and sends none", async () => {
      const server = { ...LOCAL_BOOK, autopilotHost: "server" as const };
      finished({ options: { ...DEFAULT_OPTIONS, review: { readersTarget: 7 } } }, server, "online");
      useAutopilotStore.setState((store) => ({ server: { ...store.server, info: SERVER_INFO_OF(["autopilot", "autopilot-outline-apply", "autopilot-review-book", "autopilot-review-policy"]) } }));
      show(server);
      const shown = await openDialog();
      expect(within(shown).getByText(t("autopilot.reviewBook.oldServerTargets", { version: "0.1.21" }))).toBeInTheDocument();
      expect(average(shown)).toBeDisabled();
      expect(average(shown).value, "what the run has of them is not the review's: none is sent").toBe("");
      await waitFor(() => expect(shown.querySelectorAll("[data-review-chapter]").length).toBeGreaterThan(0));
      fireEvent.click(within(shown).getByRole("button", { name: /^Review \d+ chapters?$/ }));
      await waitFor(() => expect(mocks.runtime.reviewBook).toHaveBeenCalledTimes(1));
      const input = mocks.runtime.reviewBook.mock.calls[0][1] as Record<string, unknown>;
      expect(Object.keys(input).filter((key) => key.startsWith("readers") || key === "readerTargets")).toEqual([]);
    });

    it("is in Italian when the app is", async () => {
      await act(async () => { await i18n.changeLanguage("it"); });
      finished();
      show();
      fireEvent.click(screen.getByRole("button", { name: "Rivedi di nuovo il libro" }));
      const shown = await screen.findByRole("dialog", { name: "Rivedi di nuovo il libro" });
      fireEvent.change(within(shown).getByLabelText("Media dei lettori da raggiungere"), { target: { value: "8" } });
      await waitFor(() => expect(within(shown).getByRole("heading", { name: /sotto 8\/10 o sotto un obiettivo dei lettori verranno ripresi/ })).toBeInTheDocument());
    });
  });

  it("says how the last review of the book ended, under the verdict", () => {
    const record: ReviewRecord = { targetScore: 8, rounds: 3, outcome: "target", from: { lowest: 5.5, book: 6.5, below: 6 }, to: { lowest: 8, book: 8.5, below: 0 }, startedAt: "2026-11-21T10:00:00.000Z", endedAt: "2026-11-21T12:00:00.000Z" };
    finished({ reviews: [record] });
    show();
    expect(document.querySelector("[data-result-review]")?.textContent).toBe("Reviewed again to 8/10: the target was reached in 3 rounds, and the book went from 6.5/10 to 8.5/10.");
  });

  it("is in Italian when the app is", async () => {
    await act(async () => { await i18n.changeLanguage("it"); });
    finished();
    show();
    fireEvent.click(screen.getByRole("button", { name: "Rivedi di nuovo il libro" }));
    const shown = await screen.findByRole("dialog", { name: "Rivedi di nuovo il libro" });
    expect(within(shown).getByLabelText("Voto da raggiungere")).toHaveValue("8");
    await waitFor(() => expect(within(shown).getByRole("heading", { name: /capitoli sotto 8\/10 verranno rivisti di nuovo/ })).toBeInTheDocument());
  });
});
