import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OUTLINE_BOOK_FILE, createAutopilotState, outlineChapterPath, serializeOutlineBook, serializeOutlineChapter, type AutopilotState } from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";
import { polyfillRadix } from "./helpers/radix";
import { AT, FLAT, finding, pitch, subject } from "./helpers/designReviewFixtures";

// The reviews inside the Studio tab of the Synopsis page: they come with it, lazily, when there is something of them to show or a chapter to review; the run that waits for the author's
// choice of a pitch says so and does not offer to go on; and a personal server that cannot review says why the buttons wait.

const mocks = vi.hoisted(() => ({
  store: null as unknown as InstanceType<typeof import("narrarium-engine/testing").MemoryBookStore>,
  book: null as unknown,
  structure: null as unknown,
  runtime: {
    start: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
    pause: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
    refresh: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
    chooseDesignPitch: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
    decideDesignFinding: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
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
import { OutlinePage } from "@/pages/OutlinePage";
import type { BookEntry } from "@/types/settings";

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", addedAt: "2026-11-21T00:00:00.000Z" };
const IDEA = "A harbor town built on glass hides a lie that the tide will tell.";
const STUDIO = "/app/books/book-1/outline?tab=studio";

function Page() {
  return (
    <MemoryRouter initialEntries={[STUDIO]}>
      <Routes><Route path="/app/books/:bookId/outline" element={<OutlinePage />} /></Routes>
    </MemoryRouter>
  );
}

const chapter = (number: number) => serializeOutlineChapter({ number, title: `Chapter ${number}`, body: `Summary ${number}.`, origin: "author" });

async function open(files: Record<string, string>) {
  mocks.store = new MemoryBookStore(files);
  mocks.structure = { title: "The Glass Harbor", language: "en", ghostwriter: "default", ghostwriters: [], chapters: [], readerPersonas: [], loadedBranch: "main" };
  render(<Page />);
  await screen.findByRole("heading", { level: 1, name: t("outline.title") });
  await waitFor(() => expect(screen.queryByText(t("outline.loading"))).not.toBeInTheDocument());
}

const BOOK_FILES = { [OUTLINE_BOOK_FILE]: serializeOutlineBook({ body: IDEA, origin: "author" }) };
const WITH_CHAPTERS = { ...BOOK_FILES, [outlineChapterPath(1)]: chapter(1), [outlineChapterPath(2)]: chapter(2), [outlineChapterPath(3)]: chapter(3) };

function stateFile(patch: (state: AutopilotState) => void): string {
  const state = createAutopilotState(new Date(AT), { idea: IDEA });
  state.status = "paused";
  patch(state);
  return JSON.stringify(state);
}

const pitchesWaiting = (state: AutopilotState) => {
  state.status = "waiting-author";
  state.message = "Choose the pitch the book is designed from.";
  state.design = {
    startedAt: AT,
    chapters: 3,
    rounds: [],
    workflow: { alternatives: 2, pitchChoice: "author" },
    alternatives: { pitches: [pitch("p1", "The Glass Tide"), pitch("p2", "The Salt Ledger")], evaluations: {}, recommended: { id: "p2", reason: "Sharper stakes." } },
  };
};

beforeAll(async () => {
  polyfillRadix();
  await i18n.changeLanguage("en");
  await loadAutopilotTranslations();
});

beforeEach(() => {
  mocks.book = { ...BOOK };
  mocks.runtime.start = vi.fn(async () => undefined);
  mocks.runtime.pause = vi.fn(async () => undefined);
  mocks.runtime.refresh = vi.fn(async () => null);
  mocks.runtime.chooseDesignPitch = vi.fn(async () => undefined);
  mocks.runtime.decideDesignFinding = vi.fn(async () => undefined);
  useAutopilotStore.setState((state) => ({ views: {}, summaries: {}, server: { ...state.server, info: null } }));
});

afterEach(() => {
  cleanup();
});

describe("the reviews in the Studio", () => {
  it("are not there for a Synopsis with no chapter and no review: nothing is loaded for them", async () => {
    await open(BOOK_FILES);
    await screen.findByRole("button", { name: t("design.studio.start") });
    expect(document.querySelector("[data-design-reviews]")).toBeNull();
  });

  it("offer the review of the design on request as soon as the Synopsis has chapters, and ask the autopilot for it", async () => {
    await open(WITH_CHAPTERS);
    const card = await screen.findByRole("region", { name: t("designReview.request.title") });
    fireEvent.click(within(card).getByRole("button", { name: t("designReview.request.whole") }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith("book-1", { design: { reviewOnly: {} } }));
  });

  it("show the alternatives, the rubric and the findings of a design that was reviewed, with the findings' decisions asked of the runtime", async () => {
    await open({
      ...WITH_CHAPTERS,
      "autopilot/state.json": stateFile((state) => {
        state.concept = { done: true, generated: true, secrets: [] };
        state.design = {
          startedAt: AT,
          chapters: 3,
          rounds: [],
          endedAt: AT,
          outcome: "target",
          workflow: { rubric: true, chapterReview: true, coherence: true },
          rubric: { design: subject([FLAT(6), FLAT(8)]) },
          coherence: { sig: "abc12345", round: 1, at: AT, summary: "", findings: [finding({ id: "a-00000001", text: "The tide rule changes.", chapters: [1, 3], requires: [1, 3] })] },
        };
      }),
    });
    const findings = await screen.findByRole("region", { name: t("designReview.findings.title") });
    expect(screen.getByRole("region", { name: t("designReview.rubric.title") })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: t("designReview.alternatives.title") })).not.toBeInTheDocument();
    fireEvent.click(within(findings).getByRole("button", { name: t("designReview.findings.mineLabel", { text: "The tide rule changes." }) }));
    await waitFor(() => expect(mocks.runtime.decideDesignFinding).toHaveBeenCalledWith("book-1", { id: "a-00000001", action: "mine" }));
  });

  it("say a design that waits for the author's choice of a pitch waits for her: going on is not offered, and choosing is", async () => {
    await open({ ...WITH_CHAPTERS, "autopilot/state.json": stateFile(pitchesWaiting) });
    const progress = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-design-progress]");
      if (!found) throw new Error("no progress yet");
      return found;
    });
    expect(progress).toHaveTextContent(t("designReview.alternatives.statusWaiting"));
    expect(progress).toHaveTextContent("Choose the pitch the book is designed from.");
    const resume = within(progress).getByRole("button", { name: t("design.studio.status.resume") });
    expect(resume).toBeDisabled();
    expect(resume).toHaveAccessibleDescription(t("designReview.alternatives.resumeHint"));
    const alternatives = await screen.findByRole("region", { name: t("designReview.alternatives.title") });
    expect(alternatives.querySelector("[data-pitch-waiting]")).toHaveTextContent("The director recommends «The Salt Ledger»: Sharper stakes.");
    fireEvent.click(within(alternatives).getByRole("button", { name: t("designReview.alternatives.chooseLabel", { title: "The Glass Tide" }) }));
    await waitFor(() => expect(mocks.runtime.chooseDesignPitch).toHaveBeenCalledWith("book-1", { id: "p1" }));
    expect(mocks.runtime.start).not.toHaveBeenCalled();
  });

  it("let a design that was paused for another reason go on as it always did", async () => {
    await open({
      ...WITH_CHAPTERS,
      "autopilot/state.json": stateFile((state) => {
        state.design = { startedAt: AT, chapters: 3, rounds: [{ round: 1, score: 7, verdict: "revise", critical: 0, findings: 0, at: AT }] };
        state.message = "Budget reached: raise the limit to continue.";
      }),
    });
    const progress = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-design-progress]");
      if (!found) throw new Error("no progress yet");
      return found;
    });
    expect(progress).toHaveTextContent(t("design.studio.status.paused"));
    expect(within(progress).getByRole("button", { name: t("design.studio.status.resume") })).toBeEnabled();
  });

  it("say why the buttons wait on a personal server that does not have the reviews", async () => {
    mocks.book = { ...BOOK, autopilotHost: "server" };
    useAutopilotStore.setState((state) => ({ server: { ...state.server, info: { serverId: "s", name: "Home", version: "0.1.23", protocol: 1, features: ["autopilot", "autopilot-design"] } as never } }));
    await open(WITH_CHAPTERS);
    const card = await screen.findByRole("region", { name: t("designReview.request.title") });
    const whole = within(card).getByRole("button", { name: t("designReview.request.whole") });
    expect(whole).toBeDisabled();
    expect(whole).toHaveAccessibleDescription(new RegExp(t("designReview.request.blocked.server", { version: "0.1.28" }).slice(0, 40)));
  });
});
