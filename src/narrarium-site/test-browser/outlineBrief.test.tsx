import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OUTLINE_BOOK_FILE, parseMarkdown, serializeOutlineBook, serializeOutlineChapter } from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";
import { OUTLINE_BRIEF_FILE, parseOutlineBrief, serializeOutlineBrief } from "@/autopilot/outlineBrief";
import i18n from "@/i18n";
import "@/i18n/outline";
import { OutlinePage } from "@/pages/OutlinePage";
import { useSaveStore } from "@/store/saveStore";
import type { BookEntry } from "@/types/settings";

// The brief of the book, at the top of the Scaletta: five fields and the synopsis, saved as `outline/_brief.md` with the commit of the outline.

const mocks = vi.hoisted(() => ({
  store: null as unknown as InstanceType<typeof import("narrarium-engine/testing").MemoryBookStore>,
  book: null as unknown,
  structure: null as unknown,
  reload: vi.fn(),
}));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: mocks.structure, loading: false, error: undefined, reload: mocks.reload }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/outline/outlineSource", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/outline/outlineSource")>();
  return { ...original, browserOutlineSource: () => original.storeOutlineSource(mocks.store) };
});

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", addedAt: "2026-11-21T00:00:00.000Z" };
const IDEA = "A keeper who counts the ships.";
const BRIEF = serializeOutlineBrief({ genre: "mystery", audience: "adults", wordsPerScene: 1400, synopsis: "Chapter 1: the count." });
const BOOK_MD = serializeOutlineBook({ body: IDEA, origin: "author" });

function Page() {
  return (
    <MemoryRouter initialEntries={["/app/books/book-1/outline"]}>
      <Routes><Route path="/app/books/:bookId/outline" element={<OutlinePage />} /></Routes>
    </MemoryRouter>
  );
}

async function open(files: Record<string, string>) {
  mocks.store = new MemoryBookStore(files);
  mocks.structure = { title: "The Glass Harbor", language: "en", ghostwriter: "default", ghostwriters: [], chapters: [], readerPersonas: [], loadedBranch: "main" };
  render(<Page />);
  await screen.findByRole("heading", { level: 1, name: t("outline.title") });
  await waitFor(() => expect(screen.queryByText(t("outline.loading"))).not.toBeInTheDocument());
  await screen.findByRole("heading", { name: t("outline.book.title") });
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const fieldsOnDisk = () => parseOutlineBrief(mocks.store.files.get(OUTLINE_BRIEF_FILE)).brief;
const card = () => screen.getByRole("region", { name: t("outline.book.title") });
const saveAll = () => fireEvent.click(within(card()).getByRole("button", { name: t("outline.book.save") }));
const bookBody = () => parseMarkdown(mocks.store.files.get(OUTLINE_BOOK_FILE) ?? "").body.trim();

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  mocks.book = { ...BOOK };
  mocks.reload.mockClear();
});

afterEach(async () => {
  cleanup();
  useSaveStore.setState({ current: null });
  await act(async () => { await i18n.changeLanguage("en"); });
});

describe("the book on the Scaletta, in one card", () => {
  it("is at the top of the page, above the entries, with ONE field for the idea and the brief's fields beside it", async () => {
    await open({ [OUTLINE_BOOK_FILE]: BOOK_MD, [OUTLINE_BRIEF_FILE]: BRIEF, "outline/chapters/001.md": serializeOutlineChapter({ number: 1, title: "The count", origin: "author" }) });
    const entries = screen.getByRole("heading", { name: t("outline.count", { count: 1 }) });
    expect(card().compareDocumentPosition(entries) & Node.DOCUMENT_POSITION_FOLLOWING, "the card comes first").toBeTruthy();
    // Exactly one field for the idea: the description of the book, with its own label and help line.
    expect(screen.getAllByRole("textbox", { name: t("outline.book.idea") })).toHaveLength(1);
    expect(screen.queryByLabelText(t("outline.brief.idea")), "no second idea field").toBeNull();
    expect(screen.queryByText("Rough description of the book")).toBeNull();
    expect(field(t("outline.book.idea"))).toHaveValue(IDEA);
    expect(within(card()).getByText(t("outline.book.ideaHelp"))).toBeInTheDocument();
    expect(field(t("outline.brief.genre"))).toHaveValue("mystery");
    expect(field(t("outline.brief.audience"))).toHaveValue("adults");
    expect(field(t("outline.brief.words"))).toHaveValue(1400);
    expect(field(t("outline.brief.words"))).toHaveAttribute("min", "200");
    expect(field(t("outline.brief.words"))).toHaveAttribute("max", "8000");
    expect(field(t("outline.brief.words"))).toHaveAttribute("step", "100");
    expect(field(t("outline.brief.synopsis"))).toHaveValue("Chapter 1: the count.");
  });

  it("saves all of it with one button: the idea and the title into the book, the brief's fields into _brief.md, each in its own commit", async () => {
    await open({ [OUTLINE_BOOK_FILE]: BOOK_MD, [OUTLINE_BRIEF_FILE]: BRIEF });
    fireEvent.change(field(t("outline.book.idea")), { target: { value: "A keeper who counts the ships that never arrive." } });
    fireEvent.change(field(t("outline.book.workingTitle")), { target: { value: "The Count" } });
    fireEvent.change(field(t("outline.brief.genre")), { target: { value: "fantasy" } });
    fireEvent.change(field(t("outline.brief.words")), { target: { value: "1800" } });
    fireEvent.blur(field(t("outline.brief.words")));
    expect(within(card()).getByText(t("outline.book.unsaved"))).toBeInTheDocument();
    expect(mocks.store.commits, "nothing is written before the save").toHaveLength(0);
    saveAll();
    await waitFor(() => expect(mocks.store.commits).toHaveLength(2));
    // The description of the book: its body is the idea, its frontmatter keeps the title and the type.
    const book = parseMarkdown(mocks.store.files.get(OUTLINE_BOOK_FILE)!);
    expect(book.body.trim()).toBe("A keeper who counts the ships that never arrive.");
    expect(book.frontmatter).toMatchObject({ type: "outline", title: "The Count" });
    // The fields: frontmatter of _brief.md, without an idea, and the synopsis as its body.
    expect(fieldsOnDisk()).toEqual({ genre: "fantasy", audience: "adults", wordsPerScene: 1800, synopsis: "Chapter 1: the count." });
    expect(parseMarkdown(mocks.store.files.get(OUTLINE_BRIEF_FILE)!).frontmatter).not.toHaveProperty("idea");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(t("outline.brief.result.saved")));
    expect(within(card()).queryByText(t("outline.book.unsaved"))).not.toBeInTheDocument();
  });

  it("saves the same with Ctrl+S, the page's save", async () => {
    await open({ [OUTLINE_BOOK_FILE]: BOOK_MD, [OUTLINE_BRIEF_FILE]: BRIEF });
    fireEvent.change(field(t("outline.brief.audience")), { target: { value: "young adults" } });
    await waitFor(() => expect(useSaveStore.getState().current?.dirty ?? false).toBe(true));
    await act(async () => { await useSaveStore.getState().current?.save(); });
    await waitFor(() => expect(fieldsOnDisk().audience).toBe("young adults"));
  });

  it("refuses an idea too long to be kept whole, says so, and writes nothing: the text is never cut", async () => {
    await open({ [OUTLINE_BOOK_FILE]: BOOK_MD, [OUTLINE_BRIEF_FILE]: BRIEF });
    const long = "x".repeat(1_000_001);
    fireEvent.change(field(t("outline.book.idea")), { target: { value: long } });
    fireEvent.change(field(t("outline.brief.genre")), { target: { value: "fantasy" } });
    saveAll();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/1000001|1 000 001|1,000,001/);
    expect(alert).toHaveTextContent(/shorten|accorci/i);
    // The description is refused whole: its file is not written. The brief's own fields are a separate commit, and it is the only one.
    expect(mocks.store.commits.map((commit) => commit.paths)).toEqual([[OUTLINE_BRIEF_FILE]]);
    expect(bookBody()).toBe(IDEA);
    expect(field(t("outline.book.idea")).value.length, "what was typed stays, whole").toBe(1_000_001);
  });

  it("does not overwrite a brief that changed elsewhere: the save says so, and what the author typed stays", async () => {
    await open({ [OUTLINE_BOOK_FILE]: BOOK_MD, [OUTLINE_BRIEF_FILE]: BRIEF });
    fireEvent.change(field(t("outline.brief.genre")), { target: { value: "my own genre" } });
    // Another tab writes the brief first: the file no longer has the version the page was read at.
    mocks.store.files.set(OUTLINE_BRIEF_FILE, serializeOutlineBrief({ genre: "written elsewhere", audience: "", wordsPerScene: 1400, synopsis: "" }));
    saveAll();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(t("outline.brief.result.conflict")));
    expect(fieldsOnDisk().genre).toBe("written elsewhere");
    expect(field(t("outline.brief.genre"))).toHaveValue("my own genre");
  });

  it("writes the brief of a book that has no brief file yet: saving it creates the file", async () => {
    await open({ [OUTLINE_BOOK_FILE]: BOOK_MD });
    fireEvent.change(field(t("outline.brief.genre")), { target: { value: "fantasy" } });
    saveAll();
    await waitFor(() => expect(fieldsOnDisk().genre).toBe("fantasy"));
    expect(bookBody()).toBe(IDEA);
    expect(parseOutlineBrief(BRIEF).brief.wordsPerScene).toBe(1400);
  });
});
