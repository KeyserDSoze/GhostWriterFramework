import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutopilotCampaignSummary, AutopilotLimitReached, AutopilotStateSummary } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ runtime: null as unknown as Record<string, ReturnType<typeof vi.fn>> }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { LimitPanel, suggestedCap } from "@/components/autopilot/LimitPanel";
import { AutopilotDock } from "@/components/autopilot/AutopilotDock";
import { CampaignChip } from "@/components/autopilot/band/parts";
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { LOCAL_BOOK, makeRuntime, seedBar, t } from "./helpers/quickCommands";
import { seedRun } from "./helpers/autopilotBand";

const AT = "2026-11-26T10:00:00.000Z";
const REVIEW_CAMPAIGN: AutopilotCampaignSummary = {
  id: "review-1",
  reason: "review-target",
  total: 3,
  done: 1,
  current: 4,
  waiting: [7],
  review: { round: 2, roundsThisRun: 1, maxRounds: 3, targetScore: 8, phase: "chapters", lowest: 6.5, book: 7, budgetLimit: 5 },
};

function summaryWith(patch: Partial<AutopilotStateSummary>): AutopilotStateSummary {
  const { summary } = seedBar({ status: "paused" });
  return { ...(summary as AutopilotStateSummary), stats: { ...(summary as AutopilotStateSummary).stats, cost: 2.51, currency: "USD" }, ...patch };
}

function panel(limit: AutopilotLimitReached, patch: Partial<AutopilotStateSummary> = {}) {
  const summary = summaryWith({ limitReached: limit, ...patch });
  return render(<MemoryRouter><LimitPanel bookId={LOCAL_BOOK.id} summary={summary} /></MemoryRouter>);
}

const MONEY: AutopilotLimitReached = { kind: "money", used: 2.51, limit: 2.5, currency: "USD", at: AT };
const ROUNDS: AutopilotLimitReached = { kind: "review-rounds", used: 2, limit: 2, at: AT };

beforeAll(async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.runtime = {
    start: vi.fn(async () => undefined),
    cancelRevisionCampaign: vi.fn(async () => ({ campaign: null, frozen: { mode: "ask", changes: [], pending: [], warnings: [] } })),
    describeError: vi.fn((error: unknown) => String(error)),
  };
});

afterEach(async () => {
  cleanup();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [] });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("the panel of the limit that stopped the autopilot", () => {
  it("says the money cap with its numbers, offers a new cap half as much again, and starts the autopilot with it", async () => {
    panel(MONEY);
    const region = screen.getByRole("region", { name: t("autopilot.limit.title.money") });
    expect(region).toHaveTextContent("This book has spent $2.51 over all its runs, and its cap is $2.50. The cap never resets: raise it to go on.");
    const field = within(region).getByLabelText("New cap (USD)");
    expect(field).toHaveValue("4");
    fireEvent.click(within(region).getByRole("button", { name: "Raise to $4.00 and go on" }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith("book-1", { options: { budgetLimit: 4 } }));
  });

  it("keeps what the author typed when a summary of the same stop arrives, and offers a new value for another stop", () => {
    const view = panel(MONEY);
    const field = () => screen.getByLabelText("New cap (USD)");
    fireEvent.change(field(), { target: { value: "7" } });
    view.rerender(<MemoryRouter><LimitPanel bookId={LOCAL_BOOK.id} summary={summaryWith({ limitReached: { ...MONEY } })} /></MemoryRouter>);
    expect(field()).toHaveValue("7");
    view.rerender(<MemoryRouter><LimitPanel bookId={LOCAL_BOOK.id} summary={summaryWith({ limitReached: { ...MONEY, used: 4.2, limit: 4, at: "2026-11-26T11:00:00.000Z" } })} /></MemoryRouter>);
    expect(field()).toHaveValue("6");
  });

  it("refuses a cap that is not over what the book used: it would stop again at once", () => {
    panel(MONEY);
    const region = screen.getByRole("region", { name: t("autopilot.limit.title.money") });
    const field = within(region).getByLabelText("New cap (USD)");
    fireEvent.change(field, { target: { value: "2,5" } });
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription("Write a cap over $2.51, what the book has already used.");
    expect(within(region).getByRole("button", { name: /Raise to/ })).toBeDisabled();
  });

  it("for the rounds of a review: the numbers of the review, more rounds with one click, or the review stopped", async () => {
    panel(ROUNDS, { campaign: { ...REVIEW_CAMPAIGN, held: true, current: null, review: { ...REVIEW_CAMPAIGN.review!, round: 3, roundsThisRun: 2, maxRounds: 2 } } });
    const region = screen.getByRole("region", { name: t("autopilot.limit.title.review-rounds") });
    expect(region).toHaveTextContent("2 rounds of the review done since the start, as many as you allowed (2).");
    expect(region).toHaveTextContent("Review to 8/10, round 3 next: the lowest chapter is 6.5/10, the book 7/10.");
    fireEvent.change(within(region).getByLabelText("More rounds"), { target: { value: "3" } });
    fireEvent.click(within(region).getByRole("button", { name: "Go on for 3 more rounds" }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith("book-1", { options: { review: { campaignMaxRounds: 3 } } }));
    fireEvent.click(within(region).getByRole("button", { name: t("autopilot.limit.stop") }));
    await waitFor(() => expect(mocks.runtime.cancelRevisionCampaign).toHaveBeenCalledWith("book-1"));
  });

  it("is not there while the autopilot runs, nor when no limit stopped it", () => {
    const view = panel(MONEY, { status: "running" });
    expect(view.container).toBeEmptyDOMElement();
    cleanup();
    const quiet = render(<MemoryRouter><LimitPanel bookId={LOCAL_BOOK.id} summary={summaryWith({})} /></MemoryRouter>);
    expect(quiet.container).toBeEmptyDOMElement();
  });

  it("suggests caps that read well", () => {
    expect(suggestedCap(MONEY)).toBe(4);
    expect(suggestedCap({ kind: "money", used: 0.4, limit: 0.4, at: AT })).toBe(1);
    expect(suggestedCap({ kind: "tokens", used: 1_200_400, limit: 1_200_000, at: AT })).toBe(1_800_000);
  });

  it("is in Italian when the app is", async () => {
    await act(async () => { await i18n.changeLanguage("it"); });
    panel(MONEY);
    const region = screen.getByRole("region", { name: "Il tetto di spesa ha fermato l'autopilot" });
    expect(region).toHaveTextContent(/Il tetto non si azzera mai: alzalo per continuare\./);
    expect(within(region).getByRole("button", { name: /Alza a .*4,00.* e continua/ })).toBeInTheDocument();
  });
});

describe("the mini-player of a book that a cap stopped", () => {
  it("says which cap, with its numbers, and leads to the panel on the page of the autopilot", () => {
    mocks.runtime = { ...makeRuntime(), ...mocks.runtime };
    seedRun({ status: "paused", dockOpen: true, statePatch: { limitReached: MONEY } });
    useAutopilotStore.setState({ dockTab: "book" });
    render(<MemoryRouter initialEntries={["/app/books/book-1"]}><AutopilotDock /></MemoryRouter>);
    const notice = document.querySelector<HTMLAnchorElement>("[data-dock-limit='money']");
    expect(notice?.textContent).toBe("Money cap reached: $2.51 of $2.50. Open to raise it.");
    expect(notice?.getAttribute("href")).toBe("/app/books/book-1/autopilot#autopilot-limit");
  });
});

describe("the state of a review of the book in the band, the dock and the hub", () => {
  it("says the target, the round of the ones allowed, the chapter being worked and what the book spent of its cap", () => {
    render(<CampaignChip campaign={REVIEW_CAMPAIGN} spent={{ cost: 1.2, currency: "USD" }} />);
    expect(document.querySelector("[data-campaign]")?.textContent).toBe("Review to 8/10: round 2(1 of 3 allowed now)· chapter 4 now· $1.20 of $5.00");
  });

  it("says when the director judges the book, and when the review waits for the author", () => {
    const { rerender } = render(<CampaignChip campaign={{ ...REVIEW_CAMPAIGN, current: null, review: { ...REVIEW_CAMPAIGN.review!, phase: "verdict", maxRounds: undefined, budgetLimit: 0 } }} spent={{ cost: 1.2, currency: "USD" }} />);
    expect(document.querySelector("[data-campaign]")?.textContent).toBe(`Review to 8/10: round 2· ${t("autopilot.campaign.verdict")}`);
    rerender(<CampaignChip campaign={{ ...REVIEW_CAMPAIGN, held: true }} />);
    expect(document.querySelector("[data-campaign]")?.textContent).toContain(t("autopilot.campaign.held"));
  });

  it("keeps the Synopsis being applied as it was", () => {
    render(<CampaignChip campaign={{ id: "c", reason: "outline-change", total: 2, done: 1, current: 3, waiting: [] }} />);
    expect(document.querySelector("[data-campaign]")?.textContent).toBe(`${t("autopilot.campaign.chip.outline-change", { done: 1, total: 2 })}· ${t("autopilot.campaign.current", { number: 3 })}`);
  });
});
