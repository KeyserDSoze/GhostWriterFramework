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

describe("the page of the notes of a book", () => {
  it.each(LANGUAGES)("lists what waits by chapter in the order of the book, with each note's tag, scene and how it was handled, from the working copy alone (%s)", async (language) => {
    await i18n.changeLanguage(language);
    const network = blockNetwork();
    const book = await createLocalOnlyBook("The Annotated Gate", BOOK_FILES);
    await openPage(book);

    await waitFor(() => expect(ids()).toEqual([IDS.steel, IDS.gone, IDS.oranges, IDS.rope]));
    const headings = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(headings.slice(0, 2).map((text) => text?.replace(/\s+/g, " ").trim())).toEqual([
      `The Gate ${t("annotationsPage.chapterCount", { count: 3, pending: 3 })}`,
      `The Bell ${t("annotationsPage.chapterCount", { count: 1, pending: 1 })}`,
    ]);
    const steel = card(IDS.steel);
    expect(within(steel).getByText(builtinTag("rewrite", language)!.name)).toBeInTheDocument();
    expect(within(steel).getByText("Too familiar an image: find one of hers.")).toBeInTheDocument();
    expect(within(steel).getByText("001 · Opening")).toBeInTheDocument();
    expect(within(steel).getByRole("link", { name: t("annotationsPage.openParagraph") })).toHaveAttribute("href", `/app/books/${book.book.id}/chapters/${GATE}/paragraphs/001`);
    expect(within(steel).getByRole("link", { name: t("annotationsPage.showInReader") })).toHaveAttribute("href", `/app/books/${book.book.id}/reader`);
    expect(within(card(IDS.oranges)).getByText("Slow pace")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(t("annotationsPage.count", { count: 4 }));
    // What was handled is behind the filter, and says by whom.
    fireEvent.click(statusButton("handled"));
    await waitFor(() => expect(ids()).toEqual([IDS.lanterns]));
    expect(within(card(IDS.lanterns)).getByText(new RegExp(t("annotationsPage.resolution.ai")))).toHaveTextContent("Rewrote the count.");
    expect(network.requests).toEqual([]);
  });

  it("counts every status on the filter buttons, narrows by chapter, tag and words, keeps them in the address and clears them", async () => {
    blockNetwork();
    const book = await createLocalOnlyBook("The Annotated Gate", BOOK_FILES);
    await openPage(book);
    await waitFor(() => expect(cards()).toHaveLength(4));
    const counts = Object.fromEntries(["pending", "open", "later", "handled", "dismissed", "all"].map((status) => [status, statusButton(status).textContent?.match(/(\d+)$/)?.[1]]));
    expect(counts).toEqual({ pending: "4", open: "3", later: "1", handled: "1", dismissed: "0", all: "5" });

    fireEvent.change(screen.getByLabelText(t("annotationsPage.chapter")), { target: { value: BELL } });
    await waitFor(() => expect(ids()).toEqual([IDS.rope]));
    expect(screen.getByTestId("where")).toHaveTextContent(`?chapter=${BELL}`);
    fireEvent.change(screen.getByLabelText(t("annotationsPage.chapter")), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText(t("annotationsPage.tag")), { target: { value: "dislike" } });
    await waitFor(() => expect(ids()).toEqual([IDS.gone]));
    // Only the tags in use are offered, each with how many notes it has.
    expect(within(screen.getByLabelText(t("annotationsPage.tag"))).getAllByRole("option").map((option) => option.textContent)).toEqual([t("annotationsPage.allTags"), "Don't like it (1)", "Inconsistency (1)", "Keep it (1)", "Slow pace (1)", "To rewrite (1)"]);
    fireEvent.change(screen.getByLabelText(t("annotationsPage.tag")), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText(t("annotationsPage.search")), { target: { value: "ORANGES shorter" } });
    await waitFor(() => expect(ids()).toEqual([IDS.oranges]));
    fireEvent.change(screen.getByLabelText(t("annotationsPage.search")), { target: { value: "nothing like this" } });
    expect(await screen.findByText(t("annotationsPage.noMatch"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("annotationsPage.clear") }));
    await waitFor(() => expect(ids()).toHaveLength(4));
    expect(screen.getByTestId("where")).toHaveTextContent(new RegExp(`/annotations$`));
  });

  it("starts from the filters of its address, so that a link can open one chapter or one status", async () => {
    blockNetwork();
    const book = await createLocalOnlyBook("The Annotated Gate", BOOK_FILES);
    await openPage(book, `?chapter=${GATE}&status=later`);
    await waitFor(() => expect(ids()).toEqual([IDS.oranges]));
    expect(screen.getByLabelText(t("annotationsPage.chapter"))).toHaveValue(GATE);
    expect(statusButton("later")).toHaveAttribute("aria-pressed", "true");
  });

  it("closes a note as handled by the author, puts it off, dismisses it and opens it again, each a write in the book", async () => {
    const network = blockNetwork();
    const book = await createLocalOnlyBook("The Annotated Gate", BOOK_FILES);
    await openPage(book);
    await waitFor(() => expect(cards()).toHaveLength(4));
    const status = async (id: string) => (await notesOf(book, id === IDS.rope ? BELL : GATE)).find((note) => note.id === id);

    fireEvent.click(within(card(IDS.steel)).getByRole("button", { name: t("annotationsPage.mark.handled") }));
    await waitFor(() => expect(ids()).not.toContain(IDS.steel));
    expect(await status(IDS.steel)).toMatchObject({ status: "handled", resolution: { by: "author" } });
    fireEvent.click(within(card(IDS.gone)).getByRole("button", { name: t("annotationsPage.mark.dismissed") }));
    await waitFor(() => expect(ids()).not.toContain(IDS.gone));
    expect(await status(IDS.gone)).toMatchObject({ status: "dismissed" });
    expect((await status(IDS.gone))).not.toHaveProperty("resolution");
    fireEvent.click(within(card(IDS.oranges)).getByRole("button", { name: t("annotationsPage.mark.later") }));
    // Later is still to review, and the button says what pressing it again does.
    await waitFor(() => expect(within(card(IDS.oranges)).getByRole("button", { name: t("annotationsPage.mark.later") })).toHaveAttribute("aria-pressed", "false"));
    expect(await status(IDS.oranges)).toMatchObject({ status: "open" });
    expect(screen.getByRole("status")).toHaveTextContent(t("annotationsPage.changed", { count: 1, status: t("annotations.status.open") }));
    expect(network.requests).toEqual([]);

    fireEvent.click(statusButton("all"));
    await waitFor(() => expect(ids()).toHaveLength(5));
    fireEvent.click(within(card(IDS.steel)).getByRole("button", { name: t("annotationsPage.mark.handled") }));
    await waitFor(() => expect(within(card(IDS.steel)).getByRole("button", { name: t("annotationsPage.mark.handled") })).toHaveAttribute("aria-pressed", "false"));
    expect(await status(IDS.steel)).toMatchObject({ status: "open" });
    expect(await status(IDS.steel)).not.toHaveProperty("resolution");
  });

  it("changes several notes at once: selects them, marks them handled in one write for each chapter, and deletes them after asking", async () => {
    const network = blockNetwork();
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
    const book = await createLocalOnlyBook("The Annotated Gate", BOOK_FILES);
    await openPage(book);
    await waitFor(() => expect(cards()).toHaveLength(4));
    expect(screen.queryByTestId("bulk")).toBeNull();

    fireEvent.click(within(card(IDS.steel)).getByRole("checkbox", { name: t("annotationsPage.select", { quote: "the color of old steel" }) }));
    fireEvent.click(within(card(IDS.rope)).getByRole("checkbox"));
    expect(document.querySelector("[data-bulk-count]")).toHaveTextContent(t("annotationsPage.selected", { count: 2 }));
    fireEvent.change(screen.getByLabelText(t("annotationsPage.bulkStatus")), { target: { value: "handled" } });
    fireEvent.click(document.querySelector("[data-bulk-apply]")!);
    await waitFor(() => expect(ids()).toEqual([IDS.gone, IDS.oranges]));
    expect((await notesOf(book, GATE)).find((note) => note.id === IDS.steel)).toMatchObject({ status: "handled", resolution: { by: "author" } });
    expect((await notesOf(book, BELL))[0]).toMatchObject({ status: "handled" });
    expect(screen.getByRole("status")).toHaveTextContent(t("annotationsPage.changed", { count: 2, status: t("annotations.status.handled") }));
    // The selection went with the notes that left the list.
    expect(document.querySelector("[data-bulk-count]")).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: t("annotationsPage.selectAll", { count: 2 }) }));
    expect(document.querySelector("[data-bulk-count]")).toHaveTextContent(t("annotationsPage.selected", { count: 2 }));
    const bulk = screen.getByRole("region", { name: t("annotationsPage.bulk") });
    fireEvent.click(within(bulk).getByRole("button", { name: t("annotationsPage.delete") }));
    expect(confirm).toHaveBeenCalledWith(t("annotationsPage.deleteConfirm", { count: 2 }));
    expect(ids()).toHaveLength(2);
    fireEvent.click(within(bulk).getByRole("button", { name: t("annotationsPage.delete") }));
    await waitFor(() => expect(ids()).toEqual([]));
    expect((await notesOf(book, GATE)).map((note) => note.id)).toEqual([IDS.lanterns, IDS.steel].sort());
    expect(await screen.findByText(t("annotationsPage.noMatch"))).toBeInTheDocument();
    expect(network.requests).toEqual([]);
  });

  it("says what to do in a book with no notes, and names a file it cannot read", async () => {
    blockNetwork();
    const book = await createLocalOnlyBook("Quiet", BOOK_FILES.filter((file) => !file.path.startsWith("annotations/")));
    await openPage(book);
    expect(await screen.findByText(t("annotationsPage.empty"))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("annotationsPage.openReader") })).toHaveAttribute("href", `/app/books/${book.book.id}/reader`);
    cleanup();
    resetBookStructureLoadCoordinator();
    resetAnnotationOverridesForTests();
    await resetLocalWorkspace();
    const broken = await createLocalOnlyBook("Broken", BOOK_FILES.map((file) => (file.path.endsWith(`${BELL}.yml`) ? { ...file, content: "annotations: [unclosed\n" } : file)));
    await openPage(broken);
    await waitFor(() => expect(cards()).toHaveLength(3));
    expect(screen.getByRole("alert")).toHaveTextContent(`annotations/chapters/${BELL}.yml`);
  });

  it("has the tags of this book and of every book on the same page", async () => {
    blockNetwork();
    const book = await createLocalOnlyBook("The Annotated Gate", BOOK_FILES);
    await openPage(book);
    expect(await screen.findByRole("region", { name: t("annotations.list.bookTags") })).toHaveTextContent("Slow pace");
    expect(screen.getByRole("region", { name: t("annotationsPage.tags.globalTitle") })).toContainElement(screen.getByRole("region", { name: t("annotations.settings.customTitle") }));
  });
});

describe("fixing a note with the AI", () => {
  const REPLY = OPENING.replace("a sky the color of old steel", "a sky like wet slate");

  async function openFix(search = "") {
    const network = blockNetwork();
    const book = await createLocalOnlyBook("The Annotated Gate", BOOK_FILES);
    await openPage(book, search);
    await waitFor(() => expect(cards().length).toBeGreaterThan(0));
    return { book, network };
  }
  const dialog = () => screen.getByRole("dialog", { name: t("annotationsPage.fix.title") });
  const sceneOf = (book: LocalFirstBook) => fileOf(book, `chapters/${GATE}/001-opening.md`);

  it("asks the model at once with the passage, the note and the tag's instruction, shows the change word by word, and writes the scene only on Apply, closing the note", async () => {
    mocks.complete.mockResolvedValue(REPLY);
    const { book, network } = await openFix();
    const original = await sceneOf(book);
    fireEvent.click(within(card(IDS.steel)).getByRole("button", { name: t("annotationsPage.fixWithAi") }));

    await within(dialog()).findByText(t("annotationsPage.fix.reviewTitle"));
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    const [, messages, capability, options] = mocks.complete.mock.calls[0] as [unknown, Array<{ role: string; content: string }>, string, { label: string; accountScope: string }];
    expect(capability).toBe("rewrite-from-reader-feedback");
    expect(options.label).toBe("annotation:fix");
    expect(messages[0].content).toContain("Rewrite ONLY what the note asks for");
    expect(messages[1].content).toContain("the color of old steel");
    expect(messages[1].content).toContain("Too familiar an image: find one of hers.");
    expect(messages[1].content).toContain(builtinTag("rewrite", "en")!.description);
    expect(messages[1].content).toContain("BLOCKS TO REWRITE:\nThe gate stood open");
    // The change is shown word by word, and named for a screen reader; nothing is written yet.
    const text = dialog().querySelector("[data-fix-text]")!;
    expect(text.querySelector("del")).toHaveTextContent(/the color of old steel/);
    expect(text.querySelector("ins")).toHaveTextContent(/like wet slate/);
    expect(await sceneOf(book)).toBe(original);

    fireEvent.click(within(dialog()).getByRole("button", { name: t("annotationsPage.fix.apply") }));
    await within(dialog()).findByText(t("annotationsPage.fix.applied"));
    const written = await sceneOf(book);
    expect(written).toBe(original.replace(OPENING, REPLY));
    expect((await notesOf(book, GATE)).find((note) => note.id === IDS.steel)).toMatchObject({ status: "handled", resolution: { by: "ai", summary: t("annotationsPage.fix.resolution") } });
    expect(network.requests).toEqual([]);
  });

  it("lets the author skip the change, edit the proposal and ask again with an instruction before anything is written", async () => {
    mocks.complete.mockResolvedValueOnce(REPLY).mockResolvedValueOnce(REPLY.replace("wet slate", "river stone"));
    const { book } = await openFix();
    const original = await sceneOf(book);
    fireEvent.click(within(card(IDS.steel)).getByRole("button", { name: t("annotationsPage.fixWithAi") }));
    await within(dialog()).findByText(t("annotationsPage.fix.reviewTitle"));

    // Skipping the only change leaves nothing to apply.
    fireEvent.click(within(dialog()).getByRole("button", { name: t("annotationsPage.fix.skip") }));
    expect(within(dialog()).getByRole("button", { name: t("annotationsPage.fix.apply") })).toBeDisabled();
    expect(within(dialog()).getByText(t("annotationsPage.fix.nothingChanges"))).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole("button", { name: t("annotationsPage.fix.keep") }));
    expect(within(dialog()).getByRole("button", { name: t("annotationsPage.fix.apply") })).toBeEnabled();

    // Editing the proposal works the changes out again.
    fireEvent.click(within(dialog()).getByRole("button", { name: t("annotationsPage.fix.edit") }));
    fireEvent.change(within(dialog()).getByLabelText(t("annotationsPage.fix.editLabel")), { target: { value: REPLY.replace("wet slate", "hammered tin") } });
    expect(dialog().querySelector("ins")).toHaveTextContent(/hammered tin/);

    fireEvent.change(within(dialog()).getByLabelText(t("annotationsPage.fix.instruction")), { target: { value: "Make it a stone." } });
    fireEvent.click(within(dialog()).getByRole("button", { name: t("annotationsPage.fix.retry") }));
    await waitFor(() => expect(mocks.complete).toHaveBeenCalledTimes(2));
    expect((mocks.complete.mock.calls[1][1] as Array<{ content: string }>)[1].content).toContain("The author adds: Make it a stone.");
    await waitFor(() => expect(dialog().querySelector("ins")).toHaveTextContent(/river stone/));
    expect(await sceneOf(book)).toBe(original);
  });

  it("undoes the fix: the scene and the note are as they were", async () => {
    mocks.complete.mockResolvedValue(REPLY);
    const { book } = await openFix();
    const original = await sceneOf(book);
    fireEvent.click(within(card(IDS.steel)).getByRole("button", { name: t("annotationsPage.fixWithAi") }));
    await within(dialog()).findByText(t("annotationsPage.fix.reviewTitle"));
    fireEvent.click(within(dialog()).getByRole("button", { name: t("annotationsPage.fix.apply") }));
    await within(dialog()).findByText(t("annotationsPage.fix.applied"));
    fireEvent.click(within(dialog()).getByRole("button", { name: t("annotationsPage.fix.undo") }));
    await waitFor(async () => expect(await sceneOf(book)).toBe(original));
    await waitFor(() => expect(within(dialog()).getByRole("button", { name: t("annotationsPage.fix.apply") })).toBeInTheDocument());
    expect((await notesOf(book, GATE)).find((note) => note.id === IDS.steel)).toMatchObject({ status: "open" });
    expect((await notesOf(book, GATE)).find((note) => note.id === IDS.steel)).not.toHaveProperty("resolution");
  });

  it("refuses to write a scene that changed since it was read, and to undo one that changed after the fix", async () => {
    mocks.complete.mockResolvedValue(REPLY);
    const { book } = await openFix();
    fireEvent.click(within(card(IDS.steel)).getByRole("button", { name: t("annotationsPage.fixWithAi") }));
    await within(dialog()).findByText(t("annotationsPage.fix.reviewTitle"));
    const { updateFile } = await import("@/github/githubClient");
    const current = await getLocalFile(book.meta.id, `chapters/${GATE}/001-opening.md`, captureRepositoryOperationScope());
    await updateFile(book.token, book.book.owner, book.book.repo, book.branch, `chapters/${GATE}/001-opening.md`, current!.currentHash, `${current!.text}\nAn edit by hand.\n`, "Edit");
    fireEvent.click(within(dialog()).getByRole("button", { name: t("annotationsPage.fix.apply") }));
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(t("annotationsPage.fix.problem.stale"));
    expect((await notesOf(book, GATE)).find((note) => note.id === IDS.steel)).toMatchObject({ status: "open" });
  });

  it("says when the passage is no longer in the text, and when the AI does not answer, and writes nothing", async () => {
    mocks.complete.mockRejectedValueOnce(new Error("The provider is down."));
    const { book } = await openFix();
    const original = await sceneOf(book);
    fireEvent.click(within(card(IDS.gone)).getByRole("button", { name: t("annotationsPage.fixWithAi") }));
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(t("annotationsPage.fix.problem.orphaned"));
    expect(within(dialog()).getByRole("link", { name: t("annotationsPage.openParagraph") })).toHaveAttribute("href", `/app/books/${book.book.id}/chapters/${GATE}/paragraphs/001`);
    expect(mocks.complete).not.toHaveBeenCalled();
    fireEvent.click(within(dialog()).getByRole("button", { name: t("annotationsPage.fix.cancel") }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(within(card(IDS.steel)).getByRole("button", { name: t("annotationsPage.fixWithAi") }));
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(`${t("annotationsPage.fix.problem.ai")} The provider is down.`);
    expect(within(dialog()).getByRole("button", { name: t("annotationsPage.fix.ask") })).toBeEnabled();
    expect(await sceneOf(book)).toBe(original);
  });

  it("tells the author that a frozen chapter is changed after approval, and says nothing for a chapter that is not frozen", async () => {
    mocks.complete.mockResolvedValue(REPLY);
    blockNetwork();
    const frozenFiles = BOOK_FILES.map((file) => (file.path === `chapters/${GATE}/chapter.md` ? { ...file, content: file.content.replace("title: The Gate\n", "title: The Gate\nfrozen:\n  version: 1\n  at: 2026-11-20T10:00:00.000Z\n") } : file));
    const book = await createLocalOnlyBook("The Annotated Gate", frozenFiles);
    await openPage(book);
    await waitFor(() => expect(cards().length).toBeGreaterThan(0));
    fireEvent.click(within(card(IDS.steel)).getByRole("button", { name: t("annotationsPage.fixWithAi") }));
    await within(dialog()).findByText(t("annotationsPage.fix.reviewTitle"));
    expect(dialog().querySelector("[data-fix-frozen]")).toHaveTextContent(t("annotationsPage.fix.frozen"));
    fireEvent.click(within(dialog()).getByRole("button", { name: t("annotationsPage.fix.cancel") }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(within(card(IDS.rope)).getByRole("button", { name: t("annotationsPage.fixWithAi") }));
    await waitFor(() => expect(mocks.complete).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("dialog", { name: t("annotationsPage.fix.title") }).querySelector("[data-fix-frozen]")).toBeNull();
  });

  it("works the same in Italian", async () => {
    await i18n.changeLanguage("it");
    mocks.complete.mockResolvedValue(REPLY);
    await openFix();
    fireEvent.click(within(card(IDS.steel)).getByRole("button", { name: t("annotationsPage.fixWithAi") }));
    await within(dialog()).findByText(t("annotationsPage.fix.reviewTitle"));
    expect(t("annotationsPage.fix.reviewTitle")).toBe("Rivedi la proposta");
    expect(dialog().querySelector("del")).toHaveTextContent(/Tolto:/);
  });
});

describe("reasoning together about notes", () => {
  const dialog = () => screen.getByRole("dialog", { name: new RegExp(t("annotationsPage.reason.title").slice(0, 10)) });

  async function openPageWith() {
    const network = blockNetwork();
    const book = await createLocalOnlyBook("The Annotated Gate", BOOK_FILES);
    await openPage(book);
    await waitFor(() => expect(cards().length).toBeGreaterThan(0));
    return { book, network };
  }

  it("talks about one note with the passage and the scene around it, streams the answer, and can end in a proposal that opens the fix with what was said", async () => {
    mocks.complete.mockImplementation(async (_settings, _messages, _capability, options: { onText?: (text: string) => void }) => {
      options.onText?.("Try the lantern");
      return "Try the lantern first, then the wall.";
    });
    const { network } = await openPageWith();
    fireEvent.click(within(card(IDS.steel)).getByRole("button", { name: t("annotationsPage.reasonTogether") }));
    expect(await screen.findByRole("dialog", { name: t("annotationsPage.reason.title") })).toBeInTheDocument();
    const box = screen.getByLabelText(t("annotationsPage.reason.write"));
    fireEvent.change(box, { target: { value: "It feels flat. What would you do?" } });
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });

    await screen.findByText("Try the lantern first, then the wall.");
    const [, messages, capability, options] = mocks.complete.mock.calls[0] as [unknown, Array<{ role: string; content: string }>, string, { label: string }];
    expect(capability).toBe("copilot");
    expect(options.label).toBe("annotation:reason");
    expect(messages[0].content).toContain("You change nothing yourself");
    expect(messages[1].content).toContain("It feels flat. What would you do?");
    expect(messages[1].content).toContain("PASSAGE: the color of old steel");
    expect(messages[1].content).toContain("NOTE: Too familiar an image: find one of hers.");
    // The scene around the passage, read from the working copy.
    await waitFor(() => expect(screen.getByLabelText(t("annotationsPage.reason.conversation"))).toBeInTheDocument());

    mocks.complete.mockResolvedValueOnce("Then the wall.");
    fireEvent.change(box, { target: { value: "Yes, shorter." } });
    fireEvent.click(screen.getByRole("button", { name: t("annotationsPage.reason.send") }));
    await screen.findByText("Then the wall.");
    const second = mocks.complete.mock.calls[1][1] as Array<{ role: string; content: string }>;
    expect(second.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(second[3].content).toBe("Yes, shorter.");

    mocks.complete.mockResolvedValueOnce("The gate stood open beneath a sky like wet slate. Mara waited by the wall, counting the lanterns one by one, and nobody came.");
    fireEvent.click(screen.getByRole("button", { name: t("annotationsPage.reason.propose") }));
    const fix = await screen.findByRole("dialog", { name: t("annotationsPage.fix.title") });
    await within(fix).findByText(t("annotationsPage.fix.reviewTitle"));
    const request = (mocks.complete.mock.calls[2][1] as Array<{ content: string }>)[1].content;
    expect(request).toContain("What the author said in the conversation: It feels flat. What would you do? / Yes, shorter.");
    expect(request).toContain("The last thing proposed: Then the wall.");
    expect(network.requests).toEqual([]);
  });

  it("says how many notes a chapter or the book conversation sends, and offers no fix for them", async () => {
    mocks.complete.mockResolvedValue("The chapter leans on the same image.");
    await openPageWith();
    fireEvent.click(within(document.querySelector<HTMLElement>(`[data-notes-chapter="${GATE}"]`)!).getByRole("button", { name: t("annotationsPage.reasonChapter") }));
    const chapter = await screen.findByRole("dialog", { name: t("annotationsPage.reason.titleChapter", { chapter: "The Gate" }) });
    expect(within(chapter).getByText(t("annotationsPage.reason.sends", { count: 3 }))).toBeInTheDocument();
    fireEvent.change(within(chapter).getByLabelText(t("annotationsPage.reason.write")), { target: { value: "What do you see across these notes?" } });
    fireEvent.click(within(chapter).getByRole("button", { name: t("annotationsPage.reason.send") }));
    await within(chapter).findByText("The chapter leans on the same image.");
    expect(within(chapter).queryByRole("button", { name: t("annotationsPage.reason.propose") })).toBeNull();
    const material = (mocks.complete.mock.calls[0][1] as Array<{ content: string }>)[1].content;
    expect(material).toContain("[1] The Gate / 001-opening");
    expect(material).toContain("[3] The Gate / 002-the-courtyard");
    expect(material).not.toContain("Who rang it, then?");
    fireEvent.click(within(chapter).getAllByRole("button").find((button) => button.textContent?.trim() === t("annotationsPage.reason.close"))!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(document.querySelector<HTMLElement>("[data-reason-all]")!);
    const whole = await screen.findByRole("dialog", { name: t("annotationsPage.reason.titleBook") });
    expect(within(whole).getByText(t("annotationsPage.reason.sends", { count: 4 }))).toBeInTheDocument();
  });

  it("shows the problem when the AI does not answer, and the stop and start over buttons", async () => {
    mocks.complete.mockRejectedValueOnce(new Error("No model is set."));
    await openPageWith();
    fireEvent.click(within(card(IDS.steel)).getByRole("button", { name: t("annotationsPage.reasonTogether") }));
    const box = await screen.findByLabelText(t("annotationsPage.reason.write"));
    fireEvent.change(box, { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: t("annotationsPage.reason.send") }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No model is set.");
    fireEvent.click(screen.getByRole("button", { name: t("annotationsPage.reason.startOver") }));
    expect(screen.queryByText("Hello")).toBeNull();
    expect(dialog()).toBeInTheDocument();
  });
});
