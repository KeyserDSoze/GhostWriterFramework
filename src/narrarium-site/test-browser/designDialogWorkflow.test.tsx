import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OUTLINE_BOOK_FILE, createAutopilotState, serializeOutlineBook, type AutopilotState } from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";
import { polyfillRadix } from "./helpers/radix";

// The reviews in the dialog «Design the book»: the pitches, the review of every chapter, the analysis of the structure and the rubric, each with its box, what they add to the
// estimate, and what is sent with the start. A personal server that does not have them gets the plain design.

const mocks = vi.hoisted(() => ({
  store: null as unknown as InstanceType<typeof import("narrarium-engine/testing").MemoryBookStore>,
  book: null as unknown,
  structure: null as unknown,
  runtime: {
    start: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
    pause: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
    refresh: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
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
const at = "2026-11-28T09:00:00.000Z";
const STUDIO = "/app/books/book-1/outline?tab=studio";

function Page({ path = STUDIO }: { path?: string }) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/app/books/:bookId/outline" element={<OutlinePage />} /></Routes>
    </MemoryRouter>
  );
}

async function open(files: Record<string, string> = { [OUTLINE_BOOK_FILE]: serializeOutlineBook({ body: IDEA, origin: "author" }) }, button = "design.studio.start") {
  mocks.store = new MemoryBookStore(files);
  mocks.structure = { title: "The Glass Harbor", language: "en", ghostwriter: "default", ghostwriters: [], chapters: [], readerPersonas: [], loadedBranch: "main" };
  render(<Page />);
  await screen.findByRole("heading", { level: 1, name: t("outline.title") });
  await waitFor(() => expect(screen.queryByText(t("outline.loading"))).not.toBeInTheDocument());
  fireEvent.click(await screen.findByRole("button", { name: t(button) }));
  return screen.findByRole("dialog", { name: t("design.dialog.title") });
}

/** The calls the estimate of the dialog says at most: «12 to 30 AI calls» is 30. */
function estimatedCalls(dialog: HTMLElement): number {
  const text = dialog.querySelector("[data-review-estimate]")?.textContent ?? "";
  const match = /(\d+)(?: to (\d+))? AI calls/.exec(text);
  if (!match) throw new Error(`no estimate in «${text}»`);
  return Number(match[2] ?? match[1]);
}

const box = (dialog: HTMLElement, key: string) => dialog.querySelector(`[data-design-workflow='${key}']`) as HTMLInputElement;

function designedState(patch: (state: AutopilotState) => void = () => undefined): AutopilotState {
  const state = createAutopilotState(new Date(at), { idea: IDEA });
  state.status = "paused";
  state.design = { startedAt: at, chapters: 6, rounds: [], endedAt: at, outcome: "target" };
  patch(state);
  return state;
}

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
  useAutopilotStore.setState((state) => ({ views: {}, summaries: {}, server: { ...state.server, info: null } }));
});

afterEach(async () => {
  // A dialog left open would keep the page behind it inert for the test that follows.
  const dialog = screen.queryByRole("dialog");
  if (dialog) {
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  }
  cleanup();
});

describe("the reviews in the dialog «Design the book»", () => {
  it("offers all of them by default, with three pitches and the director choosing, each box with what it does", async () => {
    const dialog = await open();
    const reviews = within(dialog).getByRole("group", { name: t("designReview.dialog.legend") });
    expect(box(dialog, "rubric")).toBeChecked();
    expect(box(dialog, "chapterReview")).toBeChecked();
    expect(box(dialog, "coherence")).toBeChecked();
    expect(dialog.querySelector<HTMLInputElement>("[data-design-alternatives]")).toBeChecked();
    expect(within(reviews).getByLabelText(t("designReview.dialog.alternatives.count"))).toHaveValue("3");
    expect(dialog.querySelector<HTMLInputElement>("[data-design-choice='director']")).toBeChecked();
    // A box is named by its title alone and described by what it does: a screen reader says the two apart, and a label that is searched for finds only the box it names.
    for (const key of ["chapterReview", "coherence", "rubric"] as const) expect(within(reviews).getByRole("checkbox", { name: t(`designReview.dialog.${key}.label`) })).toBe(box(dialog, key));
    expect(within(reviews).getByRole("radio", { name: t("designReview.dialog.choice.author") })).toBe(dialog.querySelector("[data-design-choice='author']"));
    expect(within(dialog).getByLabelText(t("design.dialog.chapters.label"))).toHaveValue("12");
    expect(box(dialog, "chapterReview")).toHaveAccessibleDescription(t("designReview.dialog.chapterReview.hint"));
    expect(box(dialog, "coherence")).toHaveAccessibleDescription(t("designReview.dialog.coherence.hint"));
    expect(dialog.querySelector<HTMLInputElement>("[data-design-alternatives]")).toHaveAccessibleDescription(t("designReview.dialog.alternatives.hint"));
  });

  it("sends what the boxes say with the start of the design", async () => {
    const dialog = await open();
    fireEvent.click(box(dialog, "coherence"));
    fireEvent.change(within(dialog).getByLabelText(t("designReview.dialog.alternatives.count")), { target: { value: "5" } });
    fireEvent.click(dialog.querySelector("[data-design-choice='author']")!);
    fireEvent.change(within(dialog).getByLabelText(t("design.dialog.chapters.label")), { target: { value: "8" } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("design.dialog.submit", { count: 8 }) }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledTimes(1));
    expect(mocks.runtime.start.mock.calls[0][1].design).toEqual({ chapters: 8, review: null, workflow: { rubric: true, chapterReview: true, alternatives: 5, pitchChoice: "author" } });
  });

  it("sends an empty workflow when every box is off: the design is the plain one", async () => {
    const dialog = await open();
    for (const key of ["rubric", "chapterReview", "coherence"]) fireEvent.click(box(dialog, key));
    fireEvent.click(dialog.querySelector("[data-design-alternatives]")!);
    fireEvent.click(within(dialog).getByRole("button", { name: /^Design/ }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledTimes(1));
    expect(mocks.runtime.start.mock.calls[0][1].design.workflow).toEqual({});
  });

  it("counts the calls of the reviews in the estimate: more with them than without", async () => {
    const dialog = await open();
    const all = estimatedCalls(dialog);
    for (const key of ["rubric", "chapterReview", "coherence"]) fireEvent.click(box(dialog, key));
    fireEvent.click(dialog.querySelector("[data-design-alternatives]")!);
    await waitFor(() => expect(estimatedCalls(dialog)).toBeLessThan(all));
    fireEvent.click(box(dialog, "chapterReview"));
    await waitFor(() => expect(estimatedCalls(dialog)).toBeGreaterThan(0));
    const chapterReview = estimatedCalls(dialog);
    fireEvent.click(box(dialog, "coherence"));
    await waitFor(() => expect(estimatedCalls(dialog)).toBeGreaterThan(chapterReview));
  });

  it("does not let a count of pitches through that the engine would refuse, and says so", async () => {
    const dialog = await open();
    const count = within(dialog).getByLabelText(t("designReview.dialog.alternatives.count"));
    fireEvent.change(count, { target: { value: "9" } });
    expect(count).toHaveAttribute("aria-invalid", "true");
    expect(within(dialog).getByText(t("designReview.dialog.alternatives.problem", { min: 2, max: 6 }))).toBeInTheDocument();
    expect(count).toHaveAccessibleDescription(new RegExp(t("designReview.dialog.alternatives.problem", { min: 2, max: 6 })));
    expect(within(dialog).getByRole("button", { name: /^Design/ })).toBeDisabled();
    fireEvent.change(count, { target: { value: "2" } });
    expect(count).not.toHaveAttribute("aria-invalid");
    expect(within(dialog).getByRole("button", { name: /^Design/ })).toBeEnabled();
    // Off, the count is not asked at all.
    fireEvent.click(dialog.querySelector("[data-design-alternatives]")!);
    expect(within(dialog).queryByLabelText(t("designReview.dialog.alternatives.count"))).not.toBeInTheDocument();
  });

  it("offers again what the design before it did", async () => {
    const state = designedState((draft) => { draft.design!.workflow = { rubric: true, alternatives: 4, pitchChoice: "author" }; draft.concept = { done: false, generated: false, secrets: [] }; });
    const dialog = await open({ [OUTLINE_BOOK_FILE]: serializeOutlineBook({ body: IDEA, origin: "author" }), "autopilot/state.json": JSON.stringify(state) }, "design.studio.again");
    expect(box(dialog, "rubric")).toBeChecked();
    expect(box(dialog, "chapterReview")).not.toBeChecked();
    expect(box(dialog, "coherence")).not.toBeChecked();
    expect(within(dialog).getByLabelText(t("designReview.dialog.alternatives.count"))).toHaveValue("4");
    expect(dialog.querySelector<HTMLInputElement>("[data-design-choice='author']")).toBeChecked();
  });

  it("does not offer the pitches once the book is designed from one: the concept is made", async () => {
    const state = designedState((draft) => { draft.concept = { done: true, generated: true, secrets: [] }; });
    const dialog = await open({ [OUTLINE_BOOK_FILE]: serializeOutlineBook({ body: IDEA, origin: "author" }), "autopilot/state.json": JSON.stringify(state) }, "design.studio.again");
    const alternatives = dialog.querySelector<HTMLInputElement>("[data-design-alternatives]")!;
    expect(alternatives).toBeDisabled();
    expect(alternatives).not.toBeChecked();
    expect(alternatives).toHaveAccessibleDescription(t("designReview.dialog.alternatives.used"));
    fireEvent.click(within(dialog).getByRole("button", { name: /^Design/ }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledTimes(1));
    expect(mocks.runtime.start.mock.calls[0][1].design.workflow).toEqual({ rubric: true, chapterReview: true, coherence: true });
  });

  it("sends the plain design to a personal server that does not have the reviews, and says it must be updated", async () => {
    mocks.book = { ...BOOK, autopilotHost: "server" };
    useAutopilotStore.setState((state) => ({ server: { ...state.server, info: { serverId: "s", name: "Home", version: "0.1.23", protocol: 1, features: ["autopilot", "autopilot-design"] } as never } }));
    const dialog = await open();
    const reviews = dialog.querySelector("[data-design-reviews-fieldset]") as HTMLFieldSetElement;
    expect(reviews).toBeDisabled();
    expect(within(reviews).getByText(t("designReview.oldServer", { version: "0.1.28" }))).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /^Design/ }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledTimes(1));
    expect(mocks.runtime.start.mock.calls[0][1].design).not.toHaveProperty("workflow");
  });

  it("sends them to a personal server that announces them", async () => {
    mocks.book = { ...BOOK, autopilotHost: "server" };
    useAutopilotStore.setState((state) => ({ server: { ...state.server, info: { serverId: "s", name: "Home", version: "0.1.26", protocol: 1, features: ["autopilot", "autopilot-design", "autopilot-design-review"] } as never } }));
    const dialog = await open();
    expect(dialog.querySelector("[data-design-reviews-fieldset]")).toBeEnabled();
    fireEvent.click(within(dialog).getByRole("button", { name: /^Design/ }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledTimes(1));
    expect(mocks.runtime.start.mock.calls[0][1].design.workflow).toEqual({ rubric: true, chapterReview: true, coherence: true, alternatives: 3 });
  });
});
