import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutopilotState, outlineChapterPath, outlineEntryDigest, parseMarkdown, serializeOutlineBook, serializeOutlineChapter, type PlannedChapter } from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";
import { chooseOption, optionNames, polyfillRadix } from "./helpers/radix";

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

import i18n from "@/i18n";
import "@/i18n/outline";
import { OutlinePage } from "@/pages/OutlinePage";
import { useSaveStore } from "@/store/saveStore";
import type { BookEntry } from "@/types/settings";

type Language = "en" | "it";
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", addedAt: "2026-11-21T00:00:00.000Z" };
const GHOSTWRITERS = [{ slug: "night-owl", path: "ghostwriters/night-owl.md", name: "Night Owl" }, { slug: "default", path: "ghostwriters/default.md", name: "Default" }];

function structureWith(chapters: Array<{ slug: string; title: string; paragraphs: unknown[] }> = []) {
  return { title: "The Glass Harbor", language: "en", ghostwriter: "default", ghostwriters: GHOSTWRITERS, chapters, readerPersonas: [], loadedBranch: "main" };
}

const author = (number: number, title: string, body: string, ghostwriter?: string) => serializeOutlineChapter({ number, title, body, ghostwriter, origin: "author" });
async function autopilot(number: number, title: string, body: string) {
  return serializeOutlineChapter({ number, title, body, origin: "autopilot", digest: await outlineEntryDigest({ title, body }) });
}

function Page() {
  return (
    <MemoryRouter initialEntries={["/app/books/book-1/outline"]}>
      <Routes><Route path="/app/books/:bookId/outline" element={<OutlinePage />} /></Routes>
    </MemoryRouter>
  );
}

async function open(files: Record<string, string>, chapters: Array<{ slug: string; title: string; paragraphs: unknown[] }> = []) {
  mocks.store = new MemoryBookStore(files);
  mocks.structure = structureWith(chapters);
  const view = render(<Page />);
  await screen.findByRole("heading", { level: 1, name: t("outline.title") });
  await waitFor(() => expect(screen.queryByText(t("outline.loading"))).not.toBeInTheDocument());
  return view;
}

const entryOf = (number: number) => document.getElementById(`outline-chapter-${number}`) as HTMLElement;
/**
 * The one control a name labels, the two ways the page names its controls: `aria-label`, or a `<label for>`. Testing Library's
 * label query walks the whole document for every control, and on a window of 50 entries one query takes seconds in jsdom.
 */
const labelled = (name: string): HTMLElement | null => {
  const byAria = Array.from(document.querySelectorAll<HTMLElement>("[aria-label]")).filter((element) => element.getAttribute("aria-label") === name);
  const byLabel = Array.from(document.querySelectorAll("label"))
    .filter((label) => label.textContent?.trim() === name && label.htmlFor)
    .map((label) => document.getElementById(label.htmlFor))
    .filter((control): control is HTMLElement => control !== null);
  const controls = [...byAria, ...byLabel];
  if (controls.length > 1) throw new Error(`${controls.length} controls are labelled «${name}»`);
  return controls[0] ?? null;
};
const getLabelled = (name: string): HTMLElement => {
  const control = labelled(name);
  if (!control) throw new Error(`no control is labelled «${name}»`);
  return control;
};
const bodyField = (number: number) => getLabelled(t("outline.entry.body", { number })) as HTMLTextAreaElement;
const titleField = (number: number) => getLabelled(t("outline.entry.title", { number })) as HTMLInputElement;
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const file = (number: number) => mocks.store.files.get(outlineChapterPath(number));
const frontmatterOf = (number: number) => parseMarkdown(file(number) ?? "").frontmatter;

beforeAll(async () => {
  polyfillRadix();
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

describe("an empty outline", () => {
  it("explains itself and offers to add the first chapter or to let the autopilot write it", async () => {
    await open({});
    expect(screen.getByRole("heading", { name: t("outline.empty.title") })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("outline.empty.autopilot") })).toHaveAttribute("href", "/app/books/book-1/autopilot/settings");
    expect(screen.queryByRole("button", { name: t("outline.empty.convert") }), "nothing to convert without a synopsis").toBeNull();

    fireEvent.click(button(t("outline.empty.addFirst")));
    await waitFor(() => expect(file(1)).toBeDefined());
    expect(frontmatterOf(1)).toMatchObject({ type: "outline-chapter", number: 1, origin: "author" });
    await waitFor(() => expect(document.activeElement).toBe(titleField(1)));
  });

  it("converts the chapter-by-chapter synopsis of the brief after showing what it will write", async () => {
    const state = createAutopilotState(new Date("2026-11-21T00:00:00.000Z"), { idea: "Glass", synopsis: "A harbor of glass.\nChapter 1: Wake — Mira wakes.\nChapter 2: The key — Mira finds the key." });
    await open({ "autopilot/state.json": JSON.stringify(state) });
    fireEvent.click(button(t("outline.empty.convert")));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Wake")).toBeInTheDocument();
    expect(within(dialog).getByText("A harbor of glass.")).toBeInTheDocument();
    expect(mocks.store.commits, "nothing is written before the author confirms").toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: t("outline.convert.confirm") }));
    await waitFor(() => expect(file(2)).toBeDefined());
    expect(mocks.store.commits).toHaveLength(1);
    expect(parseMarkdown(mocks.store.files.get("outline/book.md")!).body.trim()).toBe("A harbor of glass.");
    expect(frontmatterOf(2)).toMatchObject({ title: "The key", origin: "author" });
  });
});

describe("an outline of mixed entries", () => {
  async function mixed() {
    const files: Record<string, string> = { "outline/book.md": serializeOutlineBook({ body: "A harbor built on glass." }) };
    for (let number = 1; number <= 12; number += 1) {
      files[outlineChapterPath(number)] = number % 3 === 0 ? author(number, `Mine ${number}`, `I wrote ${number}.`) : await autopilot(number, `Planned ${number}`, `The plan says ${number}.`);
    }
    const state = createAutopilotState(new Date("2026-11-21T00:00:00.000Z"), { idea: "Glass" });
    state.plan = { chapters: [{ number: 1, title: "Planned 1", slug: "001-planned-1", summary: "", goal: "", pov: [], keyEvents: [], reveals: [], status: "done", scenes: [] } as PlannedChapter], approved: true, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false };
    files["autopilot/state.json"] = JSON.stringify(state);
    return open(files, [{ slug: "001-planned-1", title: "Planned 1", paragraphs: [{}] }]);
  }

  it("says in words who wrote each entry and what became of its chapter", async () => {
    await mixed();
    expect(within(entryOf(2)).getByText(t("outline.status.autopilot"))).toBeInTheDocument();
    expect(within(entryOf(3)).getByText(t("outline.status.author"))).toBeInTheDocument();
    expect(within(entryOf(1)).getByText(t("outline.status.approved"))).toBeInTheDocument();
    expect(within(entryOf(1)).getByRole("link", { name: t("outline.status.written") })).toHaveAttribute("href", "/app/books/book-1/chapters/001-planned-1");
    expect(screen.getByLabelText(t("outline.book.description"))).toHaveValue("A harbor built on glass.");
  });

  it("gives every field a name that says its chapter", async () => {
    await mixed();
    const names = screen.getAllByRole("textbox").map((field) => field.getAttribute("aria-label") ?? field.id);
    expect(new Set(names).size).toBe(names.length);
    expect(bodyField(7)).toHaveValue("The plan says 7.");
  });

  it("saves an edited entry as the author's, and says that the change is not saved until then", async () => {
    await mixed();
    fireEvent.change(bodyField(2), { target: { value: "Mira loses the key." } });
    expect(within(entryOf(2)).getByText(t("outline.entry.unsaved"))).toBeInTheDocument();
    expect(useSaveStore.getState().current?.dirty).toBe(true);
    expect(frontmatterOf(2).origin, "nothing is written while the author types").toBe("autopilot");

    fireEvent.click(button(t("outline.entry.save", { number: 2 })));
    await waitFor(() => expect(frontmatterOf(2).origin).toBe("author"));
    expect(frontmatterOf(2).digest).toBeUndefined();
    expect(parseMarkdown(file(2)!).body.trim()).toBe("Mira loses the key.");
    await waitFor(() => expect(within(entryOf(2)).getByText(t("outline.status.author"))).toBeInTheDocument());
    expect(useSaveStore.getState().current?.dirty).toBe(false);
    expect(screen.getByRole("status")).toHaveTextContent(t("outline.done.saved", { number: 2 }));
  });

  it("chooses the ghostwriter of a chapter, the book's being the first choice", async () => {
    await mixed();
    const trigger = screen.getByRole("combobox", { name: t("outline.entry.ghostwriter", { number: 4 }) });
    expect(optionNames(trigger)).toEqual([t("outline.entry.ghostwriterDefault"), "Night Owl", "Default"]);
    chooseOption(trigger, "Night Owl");
    fireEvent.click(button(t("outline.entry.save", { number: 4 })));
    await waitFor(() => expect(frontmatterOf(4).ghostwriter).toBe("night-owl"));
  });

  it("inserts, moves and deletes entries, and undoes the last action exactly", async () => {
    await mixed();
    const before = mocks.store.toObject();

    fireEvent.click(button(t("outline.entry.insertAfter", { number: 2 })));
    await waitFor(() => expect(frontmatterOf(13).title).toBe("Mine 12"));
    expect(frontmatterOf(3).title).toBeUndefined();
    await waitFor(() => expect(document.activeElement).toBe(titleField(3)));
    fireEvent.click(button(t("outline.actions.undo")));
    await waitFor(() => expect(mocks.store.toObject()).toEqual(before));

    fireEvent.click(button(t("outline.entry.moveDown", { number: 5 })));
    await waitFor(() => expect(frontmatterOf(6).title).toBe("Planned 5"));
    expect(frontmatterOf(5).title).toBe("Mine 6");

    fireEvent.click(button(t("outline.entry.remove", { number: 1 })));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(t("outline.delete.written"))).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: t("outline.delete.confirm") }));
    await waitFor(() => expect(file(1)).toBeUndefined());
    expect(frontmatterOf(2).title, "the following chapters keep their numbers").toBe("Planned 2");
    fireEvent.click(button(t("outline.actions.undo")));
    await waitFor(() => expect(file(1)).toBeDefined());
    expect(frontmatterOf(6).title).toBe("Planned 5");
  }, 20_000);

  it("does not save over an entry that changed elsewhere, keeps the edit and reloads on request", async () => {
    await mixed();
    fireEvent.change(bodyField(3), { target: { value: "My version." } });
    mocks.store.write(outlineChapterPath(3), author(3, "Mine 3", "Written in another tab."));
    fireEvent.click(button(t("outline.entry.save", { number: 3 })));
    const notice = await screen.findByText(t("outline.changedElsewhere"));
    expect(parseMarkdown(file(3)!).body.trim()).toBe("Written in another tab.");
    expect(bodyField(3)).toHaveValue("My version.");
    fireEvent.click(within(notice.closest("[role=alert]") as HTMLElement).getByRole("button", { name: t("outline.reload") }));
    await waitFor(() => expect(bodyField(3)).toHaveValue("Written in another tab."));
  }, 20_000);
});

describe("a long outline", () => {
  it("draws a window of entries, filters them and jumps to a number", async () => {
    const files: Record<string, string> = {};
    for (let number = 1; number <= 5000; number += 1) files[outlineChapterPath(number)] = author(number, `Title ${number}`, number === 4321 ? "The lighthouse burns." : `Body ${number}`);
    await open(files);
    expect(document.querySelectorAll("[data-outline-entry]").length).toBe(50);
    expect(screen.getAllByRole("navigation", { name: t("outline.window.label") }).map((nav) => nav.textContent)).toEqual(Array(2).fill(expect.stringContaining(t("outline.window.range", { from: 1, to: 50, total: "5,000" }))));

    fireEvent.change(getLabelled(t("outline.filter.label")), { target: { value: "lighthouse" } });
    await waitFor(() => expect(bodyField(4321)).toBeInTheDocument());
    expect(labelled(t("outline.entry.body", { number: 1 }))).toBeNull();
    fireEvent.change(getLabelled(t("outline.filter.label")), { target: { value: "" } });

    fireEvent.change(getLabelled(t("outline.jump.label")), { target: { value: "2500" } });
    fireEvent.click(button(t("outline.jump.button")));
    await waitFor(() => expect(document.activeElement).toBe(titleField(2500)));
  }, 60_000);
});

describe.each<Language>(["en", "it"])("the page in %s", (language) => {
  it("is in the language of the app", async () => {
    await act(async () => { await i18n.changeLanguage(language); });
    await open({ [outlineChapterPath(1)]: author(1, "Uno", "Mira.") });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(language === "it" ? "Scaletta" : "Outline");
    expect(bodyField(1)).toBeInTheDocument();
  });
});
