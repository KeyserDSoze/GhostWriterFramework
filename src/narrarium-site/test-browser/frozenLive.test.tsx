import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectorQuestion, PendingFrozenReview } from "narrarium-engine";

const mocks = vi.hoisted(() => ({
  book: null as unknown,
  runtime: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
  toast: vi.fn(),
}));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: undefined, loading: false, error: undefined, reload: vi.fn() }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: vi.fn(async () => true) }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AutopilotPage } from "@/pages/AutopilotPage";
import { AutopilotControlBand } from "@/components/autopilot/AutopilotControlBand";
import { AutopilotDock } from "@/components/autopilot/AutopilotDock";
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { seedRun } from "./helpers/autopilotBand";
import { LOCAL_BOOK, makeRuntime } from "./helpers/quickCommands";

type Language = "en" | "it";
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const BOOK_ID = LOCAL_BOOK.id;
const T0 = "2026-11-22T10:00:00.000Z";

function Page() {
  return (
    <MemoryRouter initialEntries={[`/app/books/${BOOK_ID}/autopilot`]}>
      <Routes><Route path="/app/books/:bookId/autopilot" element={<AutopilotPage />} /></Routes>
    </MemoryRouter>
  );
}

/** The summary the engine sends says how many frozen chapters changed and wait for the author. */
function withFrozenChanges(count: number) {
  useAutopilotStore.setState((store) => ({ summaries: { ...store.summaries, [BOOK_ID]: { ...store.summaries[BOOK_ID]!, frozenChanges: count } } }));
}

const FROZEN_QUESTION: DirectorQuestion = {
  id: "frozen-3-abc", kind: "frozen-change", askedAt: T0, chapterNumber: 3,
  question: "Hai modificato il capitolo 3, congelato il 2026-11-21. Cosa devo fare?",
  context: "Modificato: 002-the-pier.md.",
  options: ["Rivedi e aggiorna il libro da questa modifica", "Solo una review del capitolo", "Segna come rivisto"],
  choices: [{ id: "review-and-update", label: "Rivedi e aggiorna il libro da questa modifica" }, { id: "review-only", label: "Solo una review del capitolo" }, { id: "mark-reviewed", label: "Segna come rivisto" }],
  frozen: { kind: "frozen", number: 3, slug: "003-the-key", fingerprint: "abc", title: "The key", by: "autopilot", frozenAt: "2026-11-21T11:00:00.000Z" },
};

const OUTLINE_QUESTION: DirectorQuestion = {
  id: "outline-4-def", kind: "outline-change", askedAt: T0, chapterNumber: 4,
  question: "The outline of chapter 4 changed after the chapter was written. What should I do?",
  context: "",
  options: ["Rewrite the chapter to follow the outline", "Keep the text, update only the outline", "Mark as reviewed"],
  choices: [{ id: "rewrite-to-outline", label: "Rewrite the chapter to follow the outline" }, { id: "keep-text", label: "Keep the text, update only the outline" }, { id: "mark-reviewed", label: "Mark as reviewed" }],
  frozen: { kind: "outline", number: 4, slug: "004-the-flood", fingerprint: "def" },
};

const queued = (patch: Partial<PendingFrozenReview>): PendingFrozenReview => ({ id: `review-${patch.number}`, kind: "frozen", number: 3, action: "review-and-update", fingerprint: "abc", at: T0, ...patch });

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.book = LOCAL_BOOK;
  mocks.runtime = { ...makeRuntime(), answer: vi.fn(async () => undefined), frozenStatus: vi.fn(async () => ({ mode: "ask", changes: [], pending: [], warnings: [] })) };
  mocks.toast.mockReset();
});

afterEach(async () => {
  cleanup();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false, pageDockOpen: false, dockTab: "live", whereIntent: null, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await act(async () => { await i18n.changeLanguage("en"); });
});

describe.each<Language>(["en", "it"])("how many frozen chapters changed (%s)", (language) => {
  beforeEach(async () => {
    await act(async () => { await i18n.changeLanguage(language); });
  });

  it("is said in the band, in every size of it", () => {
    seedRun({ status: "paused" });
    withFrozenChanges(2);
    for (const variant of ["full", "slim", "compact"] as const) {
      const view = render(<MemoryRouter><AutopilotControlBand bookId={BOOK_ID} variant={variant} /></MemoryRouter>);
      expect(screen.getByText(t("autopilot.frozen.changed", { count: 2 })), variant).toBeInTheDocument();
      view.unmount();
    }
    expect(t("autopilot.frozen.changed", { count: 2 })).toBe(language === "en" ? "2 frozen chapters changed" : "2 capitoli congelati modificati");
    expect(t("autopilot.frozen.changed", { count: 1 })).toBe(language === "en" ? "1 frozen chapter changed" : "1 capitolo congelato modificato");
  });

  it("is said in the mini-player", () => {
    seedRun({ status: "paused" });
    useAutopilotStore.setState({ dockOpen: true, dockTab: "book" });
    withFrozenChanges(1);
    render(<MemoryRouter initialEntries={["/app/books"]}><AutopilotDock /></MemoryRouter>);
    expect(screen.getByText(t("autopilot.frozen.changed", { count: 1 }))).toBeInTheDocument();
  });
});

describe("the band of a book where no frozen chapter changed", () => {
  it("says nothing of the frozen chapters", () => {
    seedRun({ status: "paused" });
    render(<MemoryRouter><AutopilotControlBand bookId={BOOK_ID} /></MemoryRouter>);
    expect(screen.queryByText(t("autopilot.frozen.changed", { count: 1 }))).not.toBeInTheDocument();
    expect(document.querySelector("[data-frozen-changes]")).toBeNull();
  });
});

describe("the Live page", () => {
  it("asks the engine for the frozen chapters when it opens, so that the count is known before a run", async () => {
    seedRun({ status: "paused" });
    render(<Page />);
    await waitFor(() => expect(mocks.runtime.frozenStatus).toHaveBeenCalledWith(BOOK_ID));
  });

  it("lists the decisions that wait for the next run, and the one in progress", async () => {
    seedRun({ status: "paused", statePatch: { pendingReviews: [queued({ number: 3 }), queued({ number: 5, kind: "outline", action: "rewrite-to-outline", auto: true, started: { at: T0, phase: "rewrite", before: { title: "The flood", summary: "", keyEvents: [] } } })] } });
    render(<Page />);
    const list = await screen.findByRole("region", { name: t("autopilot.frozen.queue.title") });
    const items = within(list).getAllByRole("listitem").map((item) => item.textContent);
    expect(items[0]).toContain(t("autopilot.frozen.queue.item", { number: 3, action: t("frozen.actions.review-and-update") }));
    expect(items[0]).toContain(t("autopilot.frozen.queue.nextRun"));
    expect(items[1]).toContain(t("autopilot.frozen.queue.item", { number: 5, action: t("frozen.actions.rewrite-to-outline") }));
    expect(items[1]).toContain(t("autopilot.frozen.queue.started"));
    expect(items[1]).toContain(t("autopilot.frozen.queue.auto"));
  });
});

describe.each<Language>(["en", "it"])("a question about a change (%s)", (language) => {
  beforeEach(async () => {
    await act(async () => { await i18n.changeLanguage(language); });
  });

  it("offers the choices as buttons in the language of the app, each with what it does, and answers with the id of the one chosen", async () => {
    seedRun({ status: "waiting-author", question: FROZEN_QUESTION });
    render(<Page />);
    const card = await screen.findByRole("region", { name: t("autopilot.question.kinds.frozen-change") });
    expect(card).toHaveTextContent(FROZEN_QUESTION.question);
    const choices = ["review-and-update", "review-only", "mark-reviewed"];
    for (const id of choices) expect(within(card).getByRole("button", { name: t(`frozen.actions.${id}`) })).toHaveAccessibleDescription(t(`frozen.actionHelp.${id}`));
    // Keeping the text is one of the choices: no other button says it.
    expect(within(card).queryByRole("button", { name: t("autopilot.question.accept") })).not.toBeInTheDocument();
    expect(within(card).getByRole("link", { name: t("autopilot.question.openChapter", { number: 3 }) })).toHaveAttribute("href", `/app/books/${BOOK_ID}/chapters/003-the-key`);
    fireEvent.click(within(card).getByRole("button", { name: t("frozen.actions.review-only") }));
    await waitFor(() => expect(mocks.runtime.answer).toHaveBeenCalledWith(BOOK_ID, { questionId: FROZEN_QUESTION.id, answer: "review-only", choice: "review-only", accept: false }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith(BOOK_ID));
  });

  it("says by the field that words of the author start a review that calls the AI", async () => {
    seedRun({ status: "waiting-author", question: FROZEN_QUESTION });
    render(<Page />);
    const card = await screen.findByRole("region", { name: t("autopilot.question.kinds.frozen-change") });
    const field = within(card).getByLabelText(t("autopilot.question.answer"));
    expect(field).toHaveAccessibleDescription(t("autopilot.question.freeTextFrozen"));
    fireEvent.change(field, { target: { value: "Keep the hidden key in chapter 5." } });
    fireEvent.click(within(card).getByRole("button", { name: t("autopilot.question.send") }));
    await waitFor(() => expect(mocks.runtime.answer).toHaveBeenCalledWith(BOOK_ID, { questionId: FROZEN_QUESTION.id, answer: "Keep the hidden key in chapter 5.", accept: false }));
  });

  it("about the outline of a written chapter, has its own heading, choices and way to the Outline", async () => {
    seedRun({ status: "waiting-author", question: OUTLINE_QUESTION });
    render(<Page />);
    const card = await screen.findByRole("region", { name: t("autopilot.question.kinds.outline-change") });
    expect(within(card).getAllByRole("button").map((button) => button.textContent).slice(0, 3)).toEqual(["rewrite-to-outline", "keep-text", "mark-reviewed"].map((id) => t(`frozen.actions.${id}`)));
    expect(within(card).getByLabelText(t("autopilot.question.answer"))).toHaveAccessibleDescription(t("autopilot.question.freeTextOutline"));
    expect(within(card).getByRole("link", { name: t("autopilot.question.openOutline") })).toHaveAttribute("href", `/app/books/${BOOK_ID}/outline`);
  });

  it("is named for what it is about in the mini-player too", () => {
    seedRun({ status: "waiting-author", question: FROZEN_QUESTION });
    useAutopilotStore.setState({ dockOpen: true, dockTab: "book" });
    render(<MemoryRouter initialEntries={["/app/books"]}><AutopilotDock /></MemoryRouter>);
    expect(screen.getByText(`${t("autopilot.question.kinds.frozen-change")}:`)).toBeInTheDocument();
  });
});

describe("a question of the director", () => {
  it("keeps its heading, its options and the button that accepts the work", async () => {
    seedRun({ status: "waiting-author", question: { id: "q-1", kind: "chapter-approval", question: "Approve chapter 2?", context: "", options: ["Yes", "No"], askedAt: T0 } });
    render(<Page />);
    const card = await screen.findByRole("region", { name: t("autopilot.question.title") });
    expect(within(card).getByRole("button", { name: "Yes" })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: t("autopilot.question.accept") })).toBeInTheDocument();
    expect(within(card).getByLabelText(t("autopilot.question.answer"))).not.toHaveAccessibleDescription();
    fireEvent.click(within(card).getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(mocks.runtime.answer).toHaveBeenCalledWith(BOOK_ID, { questionId: "q-1", answer: "Yes", accept: false }));
  });
});
