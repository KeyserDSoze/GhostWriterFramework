import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OUTLINE_CHANGES_FILE, chapterFreezeRecord, createAutopilotState, outlineChapterPath, outlineEntryDigest, renderMarkdown, serializeOutlineChapter, serializeOutlineJournal, type PlannedChapter, type ReviseChaptersInput } from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";
import { polyfillRadix } from "./helpers/radix";

// «Apply to the book» on the Synopsis page: what each written chapter whose entry changed starts with, the confirmation of the chapters to rewrite, the campaign it
// records and the autopilot it starts, a run that takes it without a start, a personal server too old for it, and the progress that can be cancelled.

const mocks = vi.hoisted(() => ({
  store: null as unknown as InstanceType<typeof import("narrarium-engine/testing").MemoryBookStore>,
  book: null as unknown,
  structure: null as unknown,
  runtime: {
    reviseChapters: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
    cancelRevisionCampaign: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
    start: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
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
// The estimate reads the files and the models of the book: here it says only which chapters it was asked for.
vi.mock("@/components/outline/ApplyEstimate", () => ({ default: ({ numbers }: { numbers: number[] }) => <p data-testid="estimate">{numbers.join(",")}</p> }));

import i18n from "@/i18n";
import "@/i18n/outline";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { useAutopilotStore } from "@/autopilot/store";
import { OutlinePage } from "@/pages/OutlinePage";
import type { BookEntry } from "@/types/settings";

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", addedAt: "2026-11-21T00:00:00.000Z" };
const ENTRIES: Array<[number, string, string]> = [[1, "Dawn", "Mira wakes."], [2, "Key", "Mira finds the key."], [3, "Vault", "The vault opens."], [4, "Sea", "The sea rises."]];
const slug = (number: number) => `00${number}-chapter-${number}`;
const scene = { number: 1, title: "S", goal: "", beats: [], characters: [], revisions: 0, status: "reviewed" as const };

function Page() {
  return (
    <MemoryRouter initialEntries={["/app/books/book-1/outline"]}>
      <Routes><Route path="/app/books/:bookId/outline" element={<OutlinePage />} /></Routes>
    </MemoryRouter>
  );
}

/**
 * Four chapters the autopilot wrote and approved from its entries, chapter 4 then frozen by the author by hand; Brainstorming changed the entry of chapter 1,
 * swapped 3 and 4 and added chapter 5.
 */
async function open(extra: { campaign?: unknown; status?: string } = {}) {
  const files: Record<string, string> = {};
  const digests = new Map<number, string>();
  for (const [number, title, body] of ENTRIES) {
    digests.set(number, await outlineEntryDigest({ title, body }));
    files[`chapters/${slug(number)}/chapter.md`] = renderMarkdown({ type: "chapter", id: `chapter:${slug(number)}`, title, frozen: chapterFreezeRecord({ at: "2026-11-19T00:00:00.000Z", by: number === 4 ? "author" : "autopilot", chapterBody: `# ${title}`, scenes: [{ name: "001-scene.md", body: "Text." }] }) }, `# ${title}`);
    files[`chapters/${slug(number)}/001-scene.md`] = "Text.";
  }
  const now: Array<[number, string, string]> = [[1, "Dawn", "Mira wakes at night."], [2, "Key", "Mira finds the key."], [3, "Sea", "The sea rises."], [4, "Vault", "The vault opens."], [5, "Return", "Mira comes back."]];
  for (const [number, title, body] of now) files[outlineChapterPath(number)] = serializeOutlineChapter({ number, title, body, origin: "author" });
  const after = new Map(await Promise.all(now.map(async ([number, title, body]) => [number, await outlineEntryDigest({ title, body })] as const)));
  files[OUTLINE_CHANGES_FILE] = serializeOutlineJournal({ series: [{ id: "brainstorm", at: "2026-11-21T00:00:00.000Z", by: "brainstorming", chapters: [
    { chapter: 1, change: "modified", title: "Dawn", before: digests.get(1)!, after: after.get(1)!, summary: "" },
    { chapter: 3, change: "moved", from: 4, title: "Sea", was: "Vault", before: digests.get(3)!, after: after.get(3)!, summary: "" },
    { chapter: 4, change: "moved", from: 3, title: "Vault", was: "Sea", before: digests.get(4)!, after: after.get(4)!, summary: "" },
    { chapter: 5, change: "created", title: "Return", after: after.get(5)!, summary: "" },
  ] }] });
  const state = createAutopilotState(new Date("2026-11-20T00:00:00.000Z"), { idea: "Glass" });
  state.plan = { chapters: ENTRIES.map(([number, title]) => ({ number, title, slug: slug(number), summary: "", goal: "", pov: [], keyEvents: [], reveals: [], status: "done", outlineDigest: digests.get(number), scenes: [scene] }) as PlannedChapter), approved: true, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false };
  state.status = (extra.status ?? "completed") as typeof state.status;
  files["autopilot/state.json"] = JSON.stringify({ ...state, ...(extra.campaign ? { campaign: extra.campaign } : {}) });
  mocks.store = new MemoryBookStore(files);
  mocks.structure = { title: "The Glass Harbor", language: "en", ghostwriter: "default", ghostwriters: [], chapters: ENTRIES.map(([number, title]) => ({ slug: slug(number), title, paragraphs: [{}] })), readerPersonas: [], loadedBranch: "main" };
  render(<Page />);
  await screen.findByRole("heading", { level: 1, name: t("outline.title") });
  await waitFor(() => expect(document.querySelector("[data-outline-changes]")).not.toBeNull());
  return { after };
}

const changes = () => document.querySelector<HTMLElement>("[data-outline-changes]")!;
const dialog = () => screen.getByRole("dialog");
const chapterBox = (number: number) => dialog().querySelector<HTMLElement>(`[data-apply-chapter="${number}"]`)!;
const radio = (number: number, choice: string) => within(chapterBox(number)).getByRole("radio", { name: t(`outline.apply.choice.${choice}`) }) as HTMLInputElement;

async function openPanel() {
  fireEvent.click(within(changes()).getByRole("button", { name: t("outline.changes.applyOpen") }));
  await waitFor(() => expect(dialog().querySelector("[data-apply-chapter]")).not.toBeNull());
}

beforeAll(async () => {
  polyfillRadix();
  await i18n.changeLanguage("en");
  await loadAutopilotTranslations();
});

beforeEach(() => {
  mocks.book = { ...BOOK };
  mocks.runtime.reviseChapters = vi.fn(async () => ({ campaign: null, frozen: { mode: "ask", changes: [], pending: [], warnings: [] } }));
  mocks.runtime.cancelRevisionCampaign = vi.fn(async () => ({ campaign: null, frozen: { mode: "ask", changes: [], pending: [], warnings: [] } }));
  mocks.runtime.start = vi.fn(async () => undefined);
  mocks.runtime.refresh = vi.fn(async () => null);
  useAutopilotStore.setState((state) => ({ views: {}, summaries: {}, server: { ...state.server, info: null } }));
});

afterEach(() => {
  cleanup();
});

describe("Apply to the book", () => {
  it("lists every written chapter whose entry changed with what the autopilot would do, starts each from its default, and tells the other changes", async () => {
    await open();
    await openPanel();
    expect(within(dialog()).getByRole("heading", { name: t("outline.apply.title") })).toBeInTheDocument();
    expect(mocks.runtime.refresh, "the log of the book, for the speed of the estimate").toHaveBeenCalledWith("book-1", { join: true });
    expect([...dialog().querySelectorAll("[data-apply-chapter]")].map((element) => Number((element as HTMLElement).dataset.applyChapter))).toEqual([1, 3, 4]);
    // The autopilot wrote and froze 1 and 3: rewritten by default. The author froze 4 by hand: left for later by default.
    expect([radio(1, "follow").checked, radio(3, "follow").checked, radio(4, "later").checked]).toEqual([true, true, true]);
    for (const number of [1, 3, 4]) expect(chapterBox(number)).toHaveTextContent(t("outline.apply.without.ask"));
    expect(chapterBox(4)).toHaveTextContent(t("outline.apply.status.frozen.author"));
    expect(chapterBox(3)).toHaveTextContent(t("outline.changes.kind.moved", { from: 4 }));
    // Each chapter is a group of choices named by its chapter, which says what the setting would do.
    const group = within(dialog()).getByRole("group", { name: `${t("outline.changes.chapter", { number: 1 })} — Dawn` });
    expect(within(group).getAllByRole("radio")).toHaveLength(3);
    expect(group).toHaveAccessibleDescription(t("outline.apply.without.ask"));
    expect(dialog().querySelector('[data-apply-told="5"]')).toHaveTextContent(t("outline.changes.outcome.extends"));
    expect(await within(dialog()).findByTestId("estimate")).toHaveTextContent("1,3");
    fireEvent.click(radio(3, "keep"));
    expect(within(dialog()).getByTestId("estimate")).toHaveTextContent(/^1$/);
  });

  it("asks to confirm the approved chapters it rewrites, then records the choices and starts the autopilot", async () => {
    const { after } = await open();
    await openPanel();
    fireEvent.change(within(dialog()).getByLabelText(t("outline.apply.note")), { target: { value: "The vault comes first." } });
    fireEvent.change(within(chapterBox(1)).getByLabelText(t("outline.apply.instruction")), { target: { value: "At night." } });
    fireEvent.click(within(dialog()).getByRole("button", { name: t("outline.apply.applyStart") }));
    const confirm = dialog().querySelector<HTMLElement>("[data-outline-apply-confirm]")!;
    await waitFor(() => expect(document.activeElement).toBe(within(confirm).getByRole("heading", { name: t("outline.apply.confirm.title", { count: 2 }) })));
    expect(within(confirm).getAllByRole("listitem").map((item) => item.textContent?.split(" · ")[0])).toEqual([`${t("outline.changes.chapter", { number: 1 })} — Dawn`, `${t("outline.changes.chapter", { number: 3 })} — Sea`]);
    expect(confirm).toHaveTextContent(t("outline.apply.confirm.untouched", { count: 1, numbers: ["4"] }));
    expect(mocks.runtime.reviseChapters, "nothing before the confirmation").not.toHaveBeenCalled();
    fireEvent.click(within(dialog()).getByRole("button", { name: t("outline.apply.confirm.rewriteStart", { count: 2 }) }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith("book-1"));
    const input = mocks.runtime.reviseChapters.mock.calls[0][1] as ReviseChaptersInput;
    expect(mocks.runtime.reviseChapters.mock.calls[0][0]).toBe("book-1");
    expect(input).toEqual({
      reason: "outline-change",
      note: "The vault comes first.",
      chapters: [
        { number: 1, mode: "follow", fingerprint: after.get(1), instruction: "At night." },
        { number: 3, mode: "follow", fingerprint: after.get(3) },
        { number: 4, mode: "later", fingerprint: after.get(4) },
      ],
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("starts nothing when the autopilot runs: the run takes the chapters at its next step", async () => {
    await open({ status: "running" });
    useAutopilotStore.setState({ views: { "book-1": { snapshot: { running: true } } as never } });
    await openPanel();
    fireEvent.click(within(dialog()).getByRole("button", { name: t("outline.apply.apply") }));
    expect(dialog()).toHaveTextContent(t("outline.apply.confirm.running"));
    fireEvent.click(within(dialog()).getByRole("button", { name: t("outline.apply.confirm.rewrite", { count: 2 }) }));
    await waitFor(() => expect(mocks.runtime.reviseChapters).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.runtime.start).not.toHaveBeenCalled();
  });

  it("starts the autopilot when the run its state names is not going on any more (the runtime says so once the choices are recorded)", async () => {
    await open({ status: "running" });
    useAutopilotStore.setState({ views: { "book-1": { snapshot: { running: false }, busyInAnotherTab: false } as never } });
    await openPanel();
    fireEvent.click(within(dialog()).getByRole("button", { name: t("outline.apply.apply") }));
    fireEvent.click(within(dialog()).getByRole("button", { name: t("outline.apply.confirm.rewrite", { count: 2 }) }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith("book-1"));
  });

  it("records the choices without a confirmation when nothing is rewritten", async () => {
    await open();
    await openPanel();
    fireEvent.click(radio(1, "keep"));
    fireEvent.click(radio(3, "later"));
    fireEvent.click(within(dialog()).getByRole("button", { name: t("outline.apply.apply") }));
    await waitFor(() => expect(mocks.runtime.reviseChapters).toHaveBeenCalledTimes(1));
    expect((mocks.runtime.reviseChapters.mock.calls[0][1] as ReviseChaptersInput).chapters.map((chapter) => chapter.mode)).toEqual(["keep", "later", "later"]);
    expect(mocks.runtime.start).not.toHaveBeenCalled();
  });

  it("says that a personal server too old for it cannot apply the Synopsis, and sends nothing", async () => {
    mocks.book = { ...BOOK, autopilotHost: "server" };
    useAutopilotStore.setState((state) => ({ server: { ...state.server, info: { serverId: "s", name: "Home", version: "0.1.18", protocol: 1, features: ["autopilot", "autopilot-frozen"] } as never } }));
    await open();
    await openPanel();
    expect(within(dialog()).getByText(t("outline.apply.oldServer"))).toBeInTheDocument();
    expect(within(dialog()).getByRole("button", { name: t("outline.apply.applyStart") })).toBeDisabled();
  });

  it("shows the chapters being rewritten, in place of the panel, and cancels the ones that wait", async () => {
    await open({ status: "running", campaign: { id: "c", reason: "outline-change", createdAt: "2026-11-21T00:00:00.000Z", chapters: [{ number: 1, mode: "follow", status: "working" }, { number: 3, mode: "follow", status: "waiting" }, { number: 4, mode: "later", status: "done" }] } });
    await waitFor(() => expect(changes().querySelector("[data-outline-campaign]")).not.toBeNull());
    const progress = changes().querySelector<HTMLElement>("[data-outline-campaign]")!;
    expect(progress).toHaveTextContent(t("outline.changes.campaign.progress", { done: 0, total: 2 }));
    expect(progress).toHaveTextContent(t("outline.changes.campaign.current", { number: 1 }));
    expect(within(changes()).queryByRole("button", { name: t("outline.changes.applyOpen") }), "one campaign at a time").toBeNull();
    expect(changes().querySelector('[data-outline-change="3"]')).toHaveTextContent(t("outline.changes.held.applying"));
    fireEvent.click(within(progress).getByRole("button", { name: t("outline.changes.campaign.cancel") }));
    await waitFor(() => expect(mocks.runtime.cancelRevisionCampaign).toHaveBeenCalledWith("book-1"));
  });

  it("does not take a review of the book for the Synopsis being applied: no progress, no chapter held, and the apply waits for the review to end", async () => {
    const review = { targetScore: 8, scope: [1, 2, 3, 4], round: 1, windowStart: 1, phase: "chapters", start: { lowest: 6, book: 6.5, below: 2 }, history: [], stalled: 0 };
    await open({ status: "running", campaign: { id: "r", reason: "review-target", createdAt: "2026-11-21T00:00:00.000Z", chapters: [{ number: 1, mode: "follow", status: "working" }, { number: 3, mode: "follow", status: "waiting" }], review } });
    await waitFor(() => expect(changes().querySelector("[data-outline-apply-held]")).not.toBeNull());
    expect(changes().querySelector("[data-outline-campaign]"), "the box of the Synopsis is not the review's").toBeNull();
    expect(changes().querySelector("[data-outline-apply-held]")).toHaveTextContent(t("outline.changes.applyHeld"));
    expect(within(changes()).queryByRole("button", { name: t("outline.changes.applyOpen") })).toBeNull();
    expect(changes().querySelector('[data-outline-change="3"]')).not.toHaveTextContent(t("outline.changes.held.applying"));
  });
});
