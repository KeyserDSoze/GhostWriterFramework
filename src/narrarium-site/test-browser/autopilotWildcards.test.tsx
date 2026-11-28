import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BRIEF, DEFAULT_OPTIONS, createAutopilotState, normalizeOptions, type AutopilotEvent, type AutopilotState } from "narrarium-engine";

// The review of a run reads the director's profile and estimates the run: neither is what these tests are about.
vi.mock("@/autopilot/useBookFiles", () => ({ useBookFiles: () => ({ files: new Map(), failed: false }) }));
vi.mock("@/autopilot/useRunEstimate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/useRunEstimate")>()),
  useRunEstimateSources: () => ({
    sources: { book: { read: true, directorFile: false, context: {}, designWritten: false, outline: { entries: 4, lastChapter: 4, words: 400 } }, ai: null, aiFrom: "browser", activities: [], state: null, chapters: null, canonEntries: 0, currency: "USD" },
    reading: false,
    server: { status: "idle" },
    host: "browser",
  }),
}));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { SetupCard } from "@/components/autopilot/config/SetupCard";
import { EMPTY_OUTLINE_BRIEF } from "@/autopilot/outlineBrief";
import { presentFeedEvent } from "@/autopilot/format";
import { policyUpdate, policyWithoutWildcards, readReviewForm, reviewFormOf, samePolicy, serverHasWildcards } from "@/autopilot/reviewPolicy";
import { autopilotRoomEstimate } from "@/autopilot/wildcardsEstimate";
import { useSettingsStore } from "@/store/settingsStore";
import type { BookEntry } from "@/types/settings";

// The room of the wildcards in the autopilot (#127), in the web app: the part of the Review tab that turns it on (before the review of a design, when a review of the book stalls) with
// its voices, consultations and money cap, what one consultation costs, what a personal server that predates it is never sent, and how the run says what the room did.

const T0 = "2026-11-27T10:00:00.000Z";
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: T0 };
const FORM = { outline: { brief: EMPTY_OUTLINE_BRIEF, chapters: 4, lastChapter: 4, readable: true, loaded: true, reload: vi.fn() }, tab: "review", onTab: vi.fn(), onReset: vi.fn(), profiles: null };
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const runtime = { start: vi.fn(async () => undefined), configure: vi.fn(async () => undefined) };
const run = vi.fn(async (_name: string, action: (runtime: unknown, bookId: string) => Promise<unknown>) => {
  await action(runtime, BOOK.id);
  return true;
});
const existing = (options: Record<string, unknown> = {}) => ({ ...createAutopilotState(new Date(T0), { ...DEFAULT_BRIEF, idea: "A glass harbor" }), options: { ...DEFAULT_OPTIONS, ...options } }) as AutopilotState;
const blank = reviewFormOf(DEFAULT_OPTIONS);

function openForm(state: AutopilotState | null = null, props: Record<string, unknown> = {}) {
  render(<MemoryRouter><SetupCard book={BOOK} state={state} {...FORM} running={false} busy={false} disabled={false} run={run as never} {...props} /></MemoryRouter>);
}
const part = () => document.querySelector<HTMLElement>("[data-wildcards-field]") as HTMLElement;
const drawn = async () => { await screen.findByRole("heading", { level: 3, name: t("autopilot.review.wildcards.title") }); return part(); };
const toggle = (key: "design" | "plateau") => within(part()).getByRole("checkbox", { name: t(`autopilot.review.wildcards.${key}.label`) }) as HTMLInputElement;
const number = (key: "voices" | "rounds" | "money") => within(part()).getByLabelText(key === "money" ? t("autopilot.review.wildcards.money.label", { currency: "USD" }) : t(`autopilot.review.wildcards.${key}.label`)) as HTMLInputElement;
const type = (input: HTMLInputElement, text: string) => { fireEvent.change(input, { target: { value: text } }); fireEvent.blur(input); };
const started = async () => {
  fireEvent.click(screen.getByRole("button", { name: t("autopilot.actions.start") }));
  await waitFor(() => expect(runtime.start).toHaveBeenCalledTimes(1));
  return (runtime.start.mock.calls[0] as unknown as [string, { options: { review?: Record<string, unknown> } }])[1].options.review;
};
const saved = async () => {
  fireEvent.click(screen.getByRole("button", { name: t("autopilot.setup.save") }));
  await waitFor(() => expect(runtime.configure).toHaveBeenCalledTimes(1));
  return (runtime.configure.mock.calls[0] as unknown as [string, { options: { review?: Record<string, unknown> } }])[1].options.review;
};

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
  useSettingsStore.setState((store) => ({ settings: { ...store.settings, costCurrency: "USD", costRates: [], costRelabels: [] } }));
});

beforeEach(() => {
  runtime.start.mockClear();
  runtime.configure.mockClear();
});

afterEach(async () => {
  cleanup();
  await act(async () => { await i18n.changeLanguage("en"); });
});

describe("the room in the form of the review, as the engine reads it", () => {
  it("is off for a book that has none; a switch turns it on, and its numbers are read in their ranges only then", () => {
    expect([blank.wildcardsDesign, blank.wildcardsPlateau, blank.wildcardsVoices]).toEqual([false, false, ""]);
    expect(readReviewForm(blank).policy).toEqual({});
    expect(readReviewForm({ ...blank, wildcardsVoices: "0", wildcardsMoney: "-1" }), "with both off there is no room, and nothing to be wrong").toMatchObject({ policy: {}, problems: {}, valid: true });
    expect(readReviewForm({ ...blank, wildcardsDesign: true, wildcardsVoices: "3", wildcardsMoney: "0,40" }).policy).toEqual({ wildcards: { design: true, voices: 3, moneyCap: 0.4 } });
    expect(readReviewForm({ ...blank, wildcardsDesign: true, wildcardsRounds: "2" }).policy, "the consultations at a stall mean something only with the stall on").toEqual({ wildcards: { design: true } });
    expect(readReviewForm({ ...blank, wildcardsPlateau: true, wildcardsRounds: "2" }).policy).toEqual({ wildcards: { plateau: true, rounds: 2 } });
    expect(readReviewForm({ ...blank, wildcardsPlateau: true, wildcardsVoices: "9", wildcardsRounds: "4", wildcardsMoney: "x" }).problems).toEqual({ wildcardsVoices: "range", wildcardsRounds: "range", wildcardsMoney: "number" });
    expect(readReviewForm({ ...blank, wildcardsDesign: true, wildcardsVoices: "2.5" }).problems).toEqual({ wildcardsVoices: "number" });
    const options = normalizeOptions({ review: { targetScore: 8, wildcards: { design: true, plateau: true, voices: 6, rounds: 2, moneyCap: 0.5 } } });
    const form = reviewFormOf(options);
    expect([form.wildcardsDesign, form.wildcardsPlateau, form.wildcardsVoices, form.wildcardsRounds, form.wildcardsMoney]).toEqual([true, true, "6", "2", "0.5"]);
    expect(readReviewForm(form).policy).toEqual(options.review);
  });

  it("sends the room whole, only when there is one or the book had one to take back, and tells two policies apart by it", () => {
    expect(policyUpdate({ targetScore: 8 })).not.toHaveProperty("wildcards");
    expect(policyUpdate({ wildcards: { design: true } })).toMatchObject({ wildcards: { design: true } });
    expect(policyUpdate({}, { wildcards: { plateau: true } })).toMatchObject({ wildcards: null });
    const before = normalizeOptions({ review: { wildcards: { plateau: true, voices: 3 } } });
    expect(normalizeOptions({ review: policyUpdate({}, before.review) }, before).review, "turned off, it goes back").toBeUndefined();
    expect(normalizeOptions({ review: policyUpdate({ wildcards: { design: true } }, before.review) }, before).review, "given whole").toEqual({ wildcards: { design: true } });
    expect(policyWithoutWildcards({ targetScore: 8, wildcards: { design: true } })).toEqual({ targetScore: 8 });
    expect([
      samePolicy({ wildcards: { design: true, voices: 3 } }, { wildcards: { voices: 3, design: true } }),
      samePolicy({ wildcards: { design: true } }, { wildcards: { design: true, voices: 3 } }),
      samePolicy({ wildcards: { design: true } }, {}),
      samePolicy({}, undefined),
    ]).toEqual([true, false, false, true]);
    expect([serverHasWildcards({ features: ["autopilot-wildcards"] }), serverHasWildcards({ features: ["autopilot-review-book-round"] }), serverHasWildcards(null)]).toEqual([true, false, false]);
  });

  it("estimates one consultation: its voices and the director's triage, with no cost when the models have no price", () => {
    const estimate = autopilotRoomEstimate(useSettingsStore.getState().settings, { voices: 3, chapters: 12 });
    expect(estimate.calls).toEqual({ min: 4, max: 8 });
    expect(estimate.cost).toBeNull();
    expect(autopilotRoomEstimate(useSettingsStore.getState().settings, { voices: 5, chapters: 30 }).inputTokens.min).toBeGreaterThan(estimate.inputTokens.min);
  });
});

describe("the part «Wildcards» of the Review tab", () => {
  it("is a region with a heading, two switches each with a line that says what it does, and its numbers closed while the room is off", async () => {
    openForm();
    const region = await drawn();
    expect(region).toHaveTextContent(t("autopilot.review.wildcards.intro"));
    for (const key of ["design", "plateau"] as const) {
      expect(toggle(key)).not.toBeChecked();
      expect(toggle(key)).toHaveAccessibleDescription(t(`autopilot.review.wildcards.${key}.hint`));
    }
    for (const key of ["voices", "rounds", "money"] as const) expect(number(key)).toBeDisabled();
    expect(number("voices")).toHaveAccessibleDescription(t("autopilot.review.wildcards.voices.hint"));
    expect(region.querySelector("[data-wildcards-estimate]")).toBeNull();
  });

  it("starts the autopilot with the room as the part says, and says what a consultation costs", async () => {
    openForm();
    await drawn();
    fireEvent.click(toggle("design"));
    expect(number("voices")).toBeEnabled();
    expect(number("rounds"), "the consultations at a stall stay closed while the stall is off").toBeDisabled();
    type(number("voices"), "3");
    expect(part().querySelector("[data-wildcards-estimate]")).toHaveTextContent(t("autopilot.review.wildcards.estimateNoPrice", { voices: 3, calls: "4–8" }));
    const review = await started();
    expect(review).toMatchObject({ wildcards: { design: true, voices: 3 } });
    expect(normalizeOptions({ review }).review).toEqual({ wildcards: { design: true, voices: 3 } });
  });

  it("says that the stall needs a round for the book as a whole, until one is chosen", async () => {
    openForm();
    await drawn();
    fireEvent.click(toggle("plateau"));
    expect(part().querySelector("[data-wildcards-needs-book-round]")).toHaveTextContent(t("autopilot.review.wildcards.needsBookRound"));
    fireEvent.click(screen.getByRole("radio", { name: t("autopilot.review.bookRound.apply.label") }));
    expect(part().querySelector("[data-wildcards-needs-book-round]")).toBeNull();
    type(number("rounds"), "2");
    expect(await started()).toMatchObject({ bookRound: "apply", wildcards: { plateau: true, rounds: 2 } });
  });

  it("says what is wrong under a number, takes the focus there, and starts nothing", async () => {
    openForm();
    await drawn();
    fireEvent.click(toggle("design"));
    type(number("voices"), "12");
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.actions.start") }));
    await waitFor(() => expect(number("voices")).toHaveFocus());
    expect(number("voices")).toHaveAttribute("aria-invalid", "true");
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it("shows the room the book has, and turning both switches off sends null, which the engine reads as taking it back", async () => {
    openForm(existing({ review: { wildcards: { design: true, plateau: true, voices: 5 } } }));
    await drawn();
    expect([toggle("design").checked, toggle("plateau").checked, number("voices").value]).toEqual([true, true, "5"]);
    fireEvent.click(toggle("design"));
    fireEvent.click(toggle("plateau"));
    const review = await saved();
    expect(review).toMatchObject({ wildcards: null });
    expect(normalizeOptions({ review }, normalizeOptions({ review: { wildcards: { design: true } } })).review).toBeUndefined();
  });

  it("keeps it closed while a run goes on", async () => {
    openForm(existing({ review: { wildcards: { design: true } } }), { running: true });
    await drawn();
    for (const key of ["design", "plateau"] as const) expect(toggle(key)).toBeDisabled();
  });

  it("on a personal server that predates it: says so, offers it off, and never sends what the book has of it", async () => {
    openForm(existing({ review: { targetScore: 8, wildcards: { design: true } } }), { reviewWildcardsUnsupported: true });
    await drawn();
    expect(part()).toHaveTextContent(t("autopilot.review.wildcards.oldServer", { version: "0.1.27" }));
    for (const key of ["design", "plateau"] as const) {
      expect(toggle(key)).toBeDisabled();
      expect(toggle(key)).not.toBeChecked();
    }
    type(screen.getByLabelText(t("autopilot.review.rounds.label")) as HTMLInputElement, "4");
    expect(await saved()).toEqual({ targetScore: 8, maxRounds: 4, readerRounds: null, campaignMaxRounds: null });
  });

  it("is in Italian when the app is", async () => {
    await act(async () => { await i18n.changeLanguage("it"); });
    openForm();
    expect(await screen.findByRole("heading", { level: 3, name: "Fuori dal coro" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Prima della valutazione di un progetto" })).toHaveAccessibleDescription(/Un pre-mortem del piano/);
    expect(screen.getByRole("checkbox", { name: "Quando una revisione del libro si blocca" })).toBeInTheDocument();
  });
});

describe("what the run says of the room", () => {
  const insight = (body: Record<string, unknown>): AutopilotEvent => ({ type: "insight", tone: "ok", title: "The engine's own words", bookId: "book-1", at: T0, seq: 1, ...body }) as AutopilotEvent;
  const text = (language: "en" | "it", body: Record<string, unknown>) => presentFeedEvent(i18n.getFixedT(language), insight(body))?.text ?? "";

  it("says the voices, the ideas and the ones the director accepted, in both languages; without the numbers, the engine's words", () => {
    const triaged = { code: "wildcardsTriaged", figures: { voices: 4, ideas: 11, accepted: 2 } };
    expect(text("en", triaged)).toBe("Wildcards (Fuori dal coro) · voices: 4 · ideas: 11 · accepted by the director: 2");
    expect(text("it", triaged)).toBe("Fuori dal coro · voci: 4 · idee: 11 · accolte dal direttore: 2");
    expect(text("en", { code: "wildcardsTriaged" })).toBe("The engine's own words");
    expect(text("en", { code: "wildcardsNone", tone: "warning" })).toBe(t("autopilot.insight.wildcardsNone"));
    expect(text("it", { code: "wildcardsNone", tone: "warning" })).toContain("Nessun Fuori dal coro");
  });
});
