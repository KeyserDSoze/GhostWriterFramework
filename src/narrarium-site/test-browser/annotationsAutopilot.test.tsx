import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_OPTIONS, defaultDirector, serializeDirector, type AutopilotFinalReview, type ReviewRecord } from "narrarium-engine";

const mocks = vi.hoisted(() => ({
  files: new Map<string, string>(),
  runtime: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
}));

// What the dialog reads of the book: the director's profile and the records of the frozen chapters.
vi.mock("@/autopilot/useBookFiles", () => ({
  useBookFiles: (_bookId: string, paths: readonly string[]) => ({ files: new Map(paths.flatMap((path) => (mocks.files.has(path) ? [[path, mocks.files.get(path) as string]] : []))), failed: false }),
}));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/autopilot/useRunEstimate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/useRunEstimate")>()),
  useRunEstimateSources: () => ({
    sources: { book: { read: true, directorFile: true, directorRounds: 2, context: {}, designWritten: false, outline: { entries: 12, lastChapter: 12, words: 1200 } }, ai: null, aiFrom: "browser", activities: [], state: null, chapters: null, canonEntries: 0, currency: "USD" },
    reading: false,
    server: { status: "idle" },
    host: "browser",
  }),
}));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import ReviseAnnotationsDialog from "@/components/autopilot/result/ReviseAnnotationsDialog";
import { AnnotationsRunLine } from "@/components/autopilot/result/AnnotationsRunLine";
import { CampaignChip } from "@/components/autopilot/band/parts";
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { judgedPlan } from "./helpers/autopilotFixtures";
import { seedRun } from "./helpers/autopilotBand";
import { LOCAL_BOOK, t } from "./helpers/quickCommands";
import { SERVER_INFO } from "./helpers/fakeBookServer";

const SERVER_INFO_OF = (features: string[]) => ({ ...SERVER_INFO, serverVersion: "0.1.22", features });
const chapterFile = (slug: string) => `chapters/${slug}/chapter.md`;
const frozenBy = (by: "author" | "autopilot") => `---\ntype: chapter\nid: chapter:x\nnumber: 1\ntitle: X\nfrozen:\n  at: 2026-11-21T10:00:00.000Z\n  by: ${by}\n  digest: 0123456789abcdef\n  files: {}\n---\n# X\n`;

const PLAN = judgedPlan();
const note = (n: number, id: string, extra: Record<string, unknown> = {}) => ({
  id, chapter: PLAN[n - 1].slug, paragraph: "001-scene-1-title", quote: "the old gate", prefix: "", suffix: "", offset: 0, tag: "rewrite", comment: "Sharper.", status: "open",
  createdAt: "2026-11-25T10:00:00.000Z", updatedAt: "2026-11-25T10:00:00.000Z", createdOnDevice: "d-1a2b3c4d", ...extra,
}) as never;
const NOTES = [note(2, "a-1"), note(2, "a-2", { paragraph: "002-scene-2-title" }), note(4, "a-3"), note(6, "a-4", { tag: "keep" }), note(8, "a-5", { status: "later" }), note(10, "a-6", { status: "handled" })];

function finished(book: BookEntry = LOCAL_BOOK, patch: Record<string, unknown> = {}) {
  return seedRun({ book, status: "completed", phase: "completed", chapters: judgedPlan(), message: "Done.", statePatch: { finalDone: true, ...patch }, stats: { cost: 1, aiCalls: 10, inputTokens: 1000, outputTokens: 500 } });
}

function show(notes = NOTES, book: BookEntry = LOCAL_BOOK) {
  const onClose = vi.fn();
  const onStarted = vi.fn();
  render(<MemoryRouter><ReviseAnnotationsDialog open onClose={onClose} onStarted={onStarted} book={book} branch="main" structure={undefined} notes={notes} /></MemoryRouter>);
  return { onClose, onStarted };
}
const dialog = () => screen.findByRole("dialog", { name: t("autopilot.annotations.title") });

beforeAll(async () => { await loadAutopilotTranslations(); });
beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.files = new Map();
  mocks.runtime = {
    refresh: vi.fn(async () => null),
    reviseAnnotations: vi.fn(async () => ({ campaign: null, frozen: { mode: "ask", changes: [], pending: [], warnings: [] } })),
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

describe("«Have the autopilot answer your notes»", () => {
  it("counts only the notes that are changes to make, by chapter, with what the review costs and the rewrites it adds", async () => {
    finished();
    show();
    const shown = await dialog();
    // Open notes only (not later, handled, nor the one that asks to keep a passage): chapters 2 (two notes in two scenes) and 4.
    expect(shown.querySelector("[data-annotations-summary]")).toHaveTextContent("To answer: 3 notes in 2 chapters");
    expect([...shown.querySelectorAll("[data-annotations-chapter]")].map((row) => row.getAttribute("data-annotations-chapter"))).toEqual([PLAN[1].slug, PLAN[3].slug]);
    expect(shown.querySelector("[data-review-estimate]")).not.toBeNull();
    expect(shown.querySelector("[data-review-estimate]")).toHaveTextContent("Plus about 3 calls to rewrite the scenes.");
    expect(within(shown).getByRole("button", { name: "Answer 3 notes" })).toBeEnabled();
  });

  it("holds back the chapters of the author's until they are included, and sends the ids, the language and the words", async () => {
    mocks.files.set(chapterFile(PLAN[3].slug), frozenBy("author"));
    finished();
    const { onClose, onStarted } = show();
    const shown = await dialog();
    const yours = await within(shown).findByRole("checkbox", { name: /Chapter 4|\b4\b/ });
    expect(yours).not.toBeChecked();
    expect(shown.querySelector("[data-annotations-summary]")).toHaveTextContent("To answer: 2 notes in 1 chapter");
    fireEvent.click(yours);
    expect(shown.querySelector("[data-annotations-summary]")).toHaveTextContent("To answer: 3 notes in 2 chapters");
    fireEvent.change(within(shown).getByLabelText(t("autopilot.annotations.words")), { target: { value: "Keep the voice." } });
    fireEvent.click(within(shown).getByRole("button", { name: "Answer 3 notes" }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledTimes(1));
    expect(mocks.runtime.reviseAnnotations).toHaveBeenCalledWith("book-1", { ids: ["a-1", "a-2", "a-3"], include: [4], accountTags: [], language: "en", note: "Keep the voice." });
    expect(mocks.runtime.reviseAnnotations.mock.invocationCallOrder[0]).toBeLessThan(mocks.runtime.start.mock.invocationCallOrder[0]);
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it("says what to do when the autopilot has not written the book, and offers nothing to send", async () => {
    show();
    const shown = await dialog();
    expect(shown.querySelector("[data-annotations-no-plan]")).toHaveTextContent(t("autopilot.annotations.noPlan"));
    expect(within(shown).queryByRole("button", { name: /^Answer/ })).toBeNull();
  });

  it("says that an older personal server cannot do it, and sends nothing", async () => {
    const server = { ...LOCAL_BOOK, autopilotHost: "server" as const };
    finished(server);
    useAutopilotStore.setState((store) => ({ server: { ...store.server, info: SERVER_INFO_OF(["autopilot", "autopilot-outline-apply", "autopilot-review-book"]) } }));
    show(NOTES, server);
    const shown = await dialog();
    expect(within(shown).getByText(t("autopilot.annotations.oldServer"))).toBeInTheDocument();
    expect(within(shown).getByRole("button", { name: /^Answer/ })).toBeDisabled();
  });

  it("says it in Italian", async () => {
    await i18n.changeLanguage("it");
    finished();
    show();
    const shown = await dialog();
    expect(shown.querySelector("[data-annotations-summary]")).toHaveTextContent("Da rispondere: 3 note in 2 capitoli");
    expect(within(shown).getByRole("button", { name: "Rispondi a 3 note" })).toBeInTheDocument();
  });
});

describe("the band and the result of a campaign of annotations", () => {
  const campaign = { id: "c", reason: "annotations" as const, total: 3, done: 1, current: 2, waiting: [3], annotations: { notes: 5, handled: 2, heldBack: [] } };
  it("says how many chapters and notes are answered, and the chapter being worked", () => {
    render(<CampaignChip campaign={campaign} />);
    const chip = document.querySelector("[data-campaign='annotations']")!;
    expect(chip).toHaveTextContent("Answering your notes: 1 of 3 chapters");
    expect(chip).toHaveTextContent("2 of 5 notes");
    expect(chip).toHaveTextContent(t("autopilot.campaign.current", { number: 2 }));
  });

  it("says what the campaign did once it is over, and that the author stopped it", () => {
    const record = { campaignId: "c", startedAt: "2026-11-26T08:00:00.000Z", endedAt: "2026-11-26T09:00:00.000Z", notes: 5, handled: 4, chapters: [2, 4] };
    const { rerender } = render(<AnnotationsRunLine record={record} />);
    expect(document.querySelector("[data-annotations-result]")).toHaveTextContent("The autopilot answered 4 of 5 notes in 2 chapters.");
    rerender(<AnnotationsRunLine record={{ ...record, cancelled: true }} />);
    expect(document.querySelector("[data-annotations-result]")).toHaveTextContent("You stopped the autopilot's answer to your notes: 4 of 5 were answered.");
  });
});
