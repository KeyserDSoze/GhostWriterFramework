import "fake-indexeddb/auto";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ toast: vi.fn(), complete: vi.fn() }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: vi.fn(async () => undefined), load: async () => undefined, syncStatus: "idle", lastSynced: null }) }));
vi.mock("@/assistant/router", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/assistant/router")>()), completeTextRouted: mocks.complete }));

import i18n from "@/i18n";
import "@/i18n/annotations";
import "@/i18n/annotationsPage";
import { BookAnnotationsPage } from "@/pages/BookAnnotationsPage";
import { resetBookStructureLoadCoordinator } from "@/hooks/useBookStructure";
import { getLocalFile } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { resetAnnotationOverridesForTests } from "@/annotations/useBookAnnotations";
import { liveAnnotations, parseChapterAnnotations } from "@/annotations/format";
import { builtinTag, type AppLanguage } from "@/annotations/model";
import { blockNetwork, createLocalOnlyBook, resetLocalWorkspace, type LocalFirstBook } from "./helpers/localFirst";
import { BELL, BOOK_FILES, GATE, IDS, OPENING } from "./helpers/annotationsBook";

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const LANGUAGES: AppLanguage[] = ["en", "it"];

function Where() {
  const location = useLocation();
  return <span data-testid="where" data-state={JSON.stringify(location.state ?? null)}>{location.pathname + location.search}</span>;
}

async function openPage(book: LocalFirstBook, search = "") {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, language: i18n.language === "it" ? "it" : "en" }, books: [book.book] } });
  render(
    <MemoryRouter initialEntries={[`/app/books/${book.book.id}/annotations${search}`]}>
      <Routes>
        <Route path="/app/books/:bookId/annotations" element={<><BookAnnotationsPage /><Where /></>} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByRole("heading", { level: 1, name: t("annotationsPage.title") });
}

/** The button of the filter by status: the other buttons named like a status are the ones of the notes. */
const statusButton = (status: string) => within(screen.getByRole("group", { name: t("annotationsPage.status") })).getByRole("button", { name: new RegExp(`^${t(`annotations.status.${status}`)}`) });
const cards = () => Array.from(document.querySelectorAll<HTMLElement>("[data-note-id]"));
const ids = () => cards().map((card) => card.dataset.noteId);
const card = (id: string) => document.querySelector<HTMLElement>(`[data-note-id="${id}"]`)!;
const fileOf = async (book: LocalFirstBook, path: string) => (await getLocalFile(book.meta.id, path, captureRepositoryOperationScope()))?.text ?? "";
const notesOf = async (book: LocalFirstBook, chapter: string) => {
  const parsed = parseChapterAnnotations(await fileOf(book, `annotations/chapters/${chapter}.yml`), chapter);
  return parsed.ok ? liveAnnotations(parsed.file) : [];
};

vi.setConfig({ testTimeout: 60_000 });
beforeAll(() => i18n.changeLanguage("en"));
beforeEach(async () => {
  await resetLocalWorkspace();
  resetAnnotationOverridesForTests();
  resetBookStructureLoadCoordinator();
  mocks.toast.mockReset();
  mocks.complete.mockReset();
});
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});


const note = () => document.querySelector<HTMLElement>("[data-triage-note]");
const position = () => document.querySelector("[data-triage-position]")?.textContent;
const press = (key: string, target: Element | Window = window) => fireEvent.keyDown(target, { key });

describe("the triage of the notes", () => {
  beforeEach(() => localStorage.clear());

  it.each(LANGUAGES)("goes through the open notes one at a time in the order of the book, with a progress bar and an announcement for each decision (%s)", async (language) => {
    await i18n.changeLanguage(language);
    const network = blockNetwork();
    const book = await createLocalOnlyBook("The Annotated Gate", BOOK_FILES);
    await openPage(book, "?triage=1");
    await waitFor(() => expect(note()?.dataset.triageNote).toBe(IDS.steel));
    expect(position()).toBe(t("annotationsPage.triage.position", { position: 1, total: 3 }));
    const bar = screen.getByRole("progressbar", { name: t("annotationsPage.triage.progress") });
    expect(bar).toHaveAttribute("aria-valuenow", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "3");
    expect(note()).toHaveTextContent("the color of old steel");
    expect(screen.getByRole("button", { name: new RegExp(t("annotationsPage.mark.handled")) })).toHaveAttribute("aria-keyshortcuts", "H");

    press("h");
    await waitFor(() => expect(note()?.dataset.triageNote).toBe(IDS.gone));
    await waitFor(() => expect(document.querySelector("[data-triage-status]")).toHaveTextContent(t("annotationsPage.triage.done", { status: t("annotations.status.handled"), count: 2 })));
    expect(position()).toBe(t("annotationsPage.triage.position", { position: 2, total: 3 }));
    expect((await notesOf(book, GATE)).find((entry) => entry.id === IDS.steel)).toMatchObject({ status: "handled", resolution: { by: "author" } });
    // The heading of the next note has the focus, so that the keyboard does not start from the top of the page.
    await waitFor(() => expect(document.activeElement?.tagName).toBe("H3"));

    press("D");
    await waitFor(() => expect(note()?.dataset.triageNote).toBe(IDS.rope));
    expect((await notesOf(book, GATE)).find((entry) => entry.id === IDS.gone)).toMatchObject({ status: "dismissed" });
    press("l");
    expect(await screen.findByText(t("annotationsPage.triage.allDone"))).toBeInTheDocument();
    expect((await notesOf(book, BELL))[0]).toMatchObject({ status: "later" });
    expect(screen.getByText(t("annotationsPage.triage.laterLeft", { count: 2 }))).toBeInTheDocument();
    expect(network.requests).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: t("annotationsPage.triage.backToList") }));
    await waitFor(() => expect(screen.getByTestId("where")).not.toHaveTextContent("triage"));
  });

  it("skips a note without changing it, remembers it on this device and resumes from the next one; start over shows it again", async () => {
    blockNetwork();
    const book = await createLocalOnlyBook("The Annotated Gate", BOOK_FILES);
    await openPage(book, "?triage=1");
    await waitFor(() => expect(note()).not.toBeNull());
    press("s");
    await waitFor(() => expect(note()?.dataset.triageNote).toBe(IDS.gone));
    expect(JSON.parse(localStorage.getItem(`narrarium.annotations.triage.${book.book.id}`)!)).toEqual([IDS.steel]);
    expect((await notesOf(book, GATE)).find((entry) => entry.id === IDS.steel)).toMatchObject({ status: "open" });
    cleanup();
    await openPage(book, "?triage=1");
    await waitFor(() => expect(note()?.dataset.triageNote).toBe(IDS.gone));
    expect(position()).toBe(t("annotationsPage.triage.position", { position: 1, total: 2 }));
    press("s"); press("s");
    await screen.findByText(t("annotationsPage.triage.allDone"));
    fireEvent.click(screen.getByRole("button", { name: t("annotationsPage.triage.startOver", { count: 3 }) }));
    await waitFor(() => expect(note()?.dataset.triageNote).toBe(IDS.steel));
    expect(localStorage.getItem(`narrarium.annotations.triage.${book.book.id}`)).toBeNull();
  });

  it("does not take the letters while something is being typed or a window is open, and leaves modified keys to the browser", async () => {
    mocks.complete.mockResolvedValue("ok");
    blockNetwork();
    const book = await createLocalOnlyBook("The Annotated Gate", BOOK_FILES);
    await openPage(book, "?triage=1");
    await waitFor(() => expect(note()).not.toBeNull());
    fireEvent.keyDown(window, { key: "h", ctrlKey: true });
    fireEvent.keyDown(window, { key: "h", metaKey: true });
    fireEvent.click(document.querySelector('[data-triage-action="reason"]')!);
    const box = await screen.findByLabelText(t("annotationsPage.reason.write"));
    press("h", box);
    press("h");
    expect(note()?.dataset.triageNote).toBe(IDS.steel);
    expect((await notesOf(book, GATE)).find((entry) => entry.id === IDS.steel)).toMatchObject({ status: "open" });
  });

  it("decides on a swipe of a touch screen, to the right handled and to the left later, and ignores a vertical scroll", async () => {
    blockNetwork();
    const book = await createLocalOnlyBook("The Annotated Gate", BOOK_FILES);
    await openPage(book, "?triage=1");
    await waitFor(() => expect(note()).not.toBeNull());
    const swipe = (dx: number, dy = 0) => {
      const card = note()!;
      fireEvent.pointerDown(card, { pointerType: "touch", clientX: 200, clientY: 200 });
      fireEvent.pointerUp(card, { pointerType: "touch", clientX: 200 + dx, clientY: 200 + dy });
    };
    swipe(10, 160);
    swipe(-30);
    expect(note()?.dataset.triageNote).toBe(IDS.steel);
    swipe(140);
    await waitFor(() => expect(note()?.dataset.triageNote).toBe(IDS.gone));
    expect((await notesOf(book, GATE)).find((entry) => entry.id === IDS.steel)).toMatchObject({ status: "handled" });
    swipe(-140);
    await waitFor(() => expect(note()?.dataset.triageNote).toBe(IDS.rope));
    expect((await notesOf(book, GATE)).find((entry) => entry.id === IDS.gone)).toMatchObject({ status: "later" });
  });

  it("retries a note with the AI from the triage, and the note leaves the queue once the fix is applied", async () => {
    mocks.complete.mockResolvedValue(OPENING.replace("a sky the color of old steel", "a sky like wet slate"));
    blockNetwork();
    const book = await createLocalOnlyBook("The Annotated Gate", BOOK_FILES);
    await openPage(book, "?triage=1");
    await waitFor(() => expect(note()).not.toBeNull());
    press("f");
    const dialog = await screen.findByRole("dialog", { name: t("annotationsPage.fix.title") });
    await within(dialog).findByText(t("annotationsPage.fix.reviewTitle"));
    fireEvent.click(within(dialog).getByRole("button", { name: t("annotationsPage.fix.apply") }));
    await within(dialog).findByText(t("annotationsPage.fix.applied"));
    fireEvent.click(within(dialog).getAllByRole("button").find((button) => button.textContent?.trim() === t("annotationsPage.fix.close"))!);
    await waitFor(() => expect(note()?.dataset.triageNote).toBe(IDS.gone));
    expect((await notesOf(book, GATE)).find((entry) => entry.id === IDS.steel)).toMatchObject({ status: "handled", resolution: { by: "ai" } });
  });

  it("opens the paragraph of the note with its button and its key, and shows the note in the reader", async () => {
    blockNetwork();
    const book = await createLocalOnlyBook("The Annotated Gate", BOOK_FILES);
    await openPage(book, "?triage=1");
    await waitFor(() => expect(note()).not.toBeNull());
    expect(screen.getByRole("link", { name: new RegExp(t("annotationsPage.showInReader")) })).toHaveAttribute("href", `/app/books/${book.book.id}/reader`);
    press("p");
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(`/chapters/${GATE}/paragraphs/001`));
  });

  it("is started from the list, scoped to a chapter by the filter", async () => {
    blockNetwork();
    const book = await createLocalOnlyBook("The Annotated Gate", BOOK_FILES);
    await openPage(book, `?chapter=${BELL}`);
    await waitFor(() => expect(cards()).toHaveLength(1));
    fireEvent.click(document.querySelector("[data-triage-start]")!);
    await waitFor(() => expect(note()?.dataset.triageNote).toBe(IDS.rope));
    expect(position()).toBe(t("annotationsPage.triage.position", { position: 1, total: 1 }));
  });
});

describe("fixing several notes with the AI", () => {
  it("says what it will cost before it starts, then asks for each note in turn and leaves each change to the author", async () => {
    mocks.complete.mockResolvedValue(OPENING.replace("a sky the color of old steel", "a sky like wet slate"));
    blockNetwork();
    const book = await createLocalOnlyBook("The Annotated Gate", BOOK_FILES);
    await openPage(book);
    await waitFor(() => expect(cards()).toHaveLength(4));
    fireEvent.click(within(card(IDS.steel)).getByRole("checkbox"));
    fireEvent.click(within(card(IDS.oranges)).getByRole("checkbox"));
    fireEvent.click(document.querySelector("[data-bulk-fix]")!);
    const ask = await screen.findByRole("dialog", { name: t("annotationsPage.bulkFix.title", { count: 2 }) });
    expect(within(ask).getByText(/About 2 AI calls/)).toBeInTheDocument();
    expect(mocks.complete).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole("button", { name: t("annotationsPage.bulkFix.start") }));
    const first = await screen.findByRole("dialog", { name: t("annotationsPage.fix.title") });
    await within(first).findByText(t("annotationsPage.fix.reviewTitle"));
    expect(document.querySelector("[data-fix-queue]")).toHaveTextContent(t("annotationsPage.bulkFix.progress", { position: 1, total: 2 }));
    fireEvent.click(within(first).getAllByRole("button").find((button) => [t("annotationsPage.fix.cancel"), t("annotationsPage.fix.close")].includes(button.textContent?.trim() ?? ""))!);
    await waitFor(() => expect(document.querySelector("[data-fix-queue]")).toHaveTextContent(t("annotationsPage.bulkFix.progress", { position: 2, total: 2 })));
    await waitFor(() => expect(mocks.complete).toHaveBeenCalledTimes(2));
    // Nothing was written: every change waits for the author.
    expect((await notesOf(book, GATE)).every((entry) => entry.status !== "handled" || entry.id === IDS.lanterns)).toBe(true);
    fireEvent.click(within(document.querySelector("[data-fix-queue]") as HTMLElement).getByRole("button", { name: t("annotationsPage.bulkFix.cancel"), hidden: true }));
    await waitFor(() => expect(document.querySelector("[data-fix-queue]")).toBeNull());
  });
});
