import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { outlineChapterPath, parseMarkdown, serializeOutlineBook, serializeOutlineChapter } from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";
import { polyfillRadix } from "./helpers/radix";

const mocks = vi.hoisted(() => ({
  store: null as unknown as InstanceType<typeof import("narrarium-engine/testing").MemoryBookStore>,
  structure: null as unknown,
  complete: vi.fn(),
}));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", addedAt: "2026-11-21T00:00:00.000Z" }, structure: mocks.structure, loading: false, error: undefined, reload: vi.fn() }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/outline/outlineSource", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/outline/outlineSource")>();
  return { ...original, browserOutlineSource: () => original.storeOutlineSource(mocks.store) };
});
vi.mock("@/assistant/router", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/assistant/router")>()), completeTextRouted: mocks.complete }));

import i18n from "@/i18n";
import "@/i18n/outline";
import { GlobalContextMenu } from "@/components/editor/GlobalContextMenu";
import { OutlinePage } from "@/pages/OutlinePage";
import { useSettingsStore } from "@/store/settingsStore";
import { useBooksStore } from "@/store/booksStore";
import { useSaveStore } from "@/store/saveStore";
import { DEFAULT_SETTINGS, type CustomAction } from "@/types/settings";
import { resolveCustomActionTarget } from "@/custom-actions/customActions";

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const BOOK = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only" as const, addedAt: "2026-11-21T00:00:00.000Z" };
const entry = (number: number, title: string, body: string) => serializeOutlineChapter({ number, title, body, origin: "author" });
const MIRA = "---\ntype: character\nname: Mira\n---\nA glassmaker's daughter. She lost her left hand in the fire.\n";

function structure() {
  return {
    title: "The Glass Harbor", language: "en", ghostwriter: "default", ghostwriters: [], chapters: [], readerPersonas: [], loadedBranch: "main",
    characters: [{ path: "characters/mira.md", sha: "", size: 0, name: "Mira" }], locations: [], factions: [], items: [], timelines: [], secrets: [],
  };
}

async function open() {
  mocks.store = new MemoryBookStore({
    "outline/book.md": serializeOutlineBook({ body: "A harbor built on glass hides a lie." }),
    [outlineChapterPath(1)]: entry(1, "Wake", "Mira wakes in the glass harbor."),
    [outlineChapterPath(2)]: entry(2, "The key", "Mira finds the key."),
    [outlineChapterPath(3)]: entry(3, "The council", "The council lies."),
    "characters/mira.md": MIRA,
  });
  mocks.structure = structure();
  render(
    <MemoryRouter initialEntries={["/app/books/book-1/outline"]}>
      <Routes><Route path="/app/books/:bookId/outline" element={<><OutlinePage /><GlobalContextMenu /></>} /></Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByLabelText(t("outline.entry.body", { number: 2 }))).toBeInTheDocument());
}

const body = (number: number) => screen.getByLabelText(t("outline.entry.body", { number })) as HTMLTextAreaElement;
const menuItem = (name: string) => screen.getByRole("button", { name });

beforeAll(async () => {
  polyfillRadix();
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false })) as typeof window.matchMedia;
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  mocks.complete.mockReset();
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, customActions: [] } });
});

afterEach(() => {
  cleanup();
  useSaveStore.setState({ current: null });
  useBooksStore.setState({ structures: {} });
});

describe("the context menu on a text area of the outline", () => {
  it("offers improve, summarize and the two actions of the outline", async () => {
    await open();
    fireEvent.contextMenu(body(2), { clientX: 20, clientY: 20 });
    for (const name of [t("outline.assist.improveEntry"), t("outline.assist.summarizeEntry"), t("outline.assist.develop"), t("outline.assist.check")]) expect(menuItem(name)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("ctx.improveAll") }), "an entry is not a paragraph").toBeNull();
  });

  it("develops a chapter from the description, the nearby chapters and the canon, and applies it only when asked, without saving", async () => {
    mocks.complete.mockResolvedValue("Mira finds the key under the pier.\n- She hides it from the council.");
    await open();
    fireEvent.contextMenu(body(2), { clientX: 20, clientY: 20 });
    fireEvent.click(menuItem(t("outline.assist.develop")));
    const dialog = await screen.findByRole("dialog", { name: t("outline.assist.developTitle", { number: 2 }) });
    await within(dialog).findByText(t("outline.assist.proposed"));

    const [, messages, capability] = mocks.complete.mock.calls[0] as [unknown, Array<{ role: string; content: string }>, string];
    expect(capability).toBe("editor-actions");
    const request = messages.map((message) => message.content).join("\n");
    for (const part of ["A harbor built on glass hides a lie.", "Mira wakes in the glass harbor.", "The council lies.", "characters/mira.md", "lost her left hand"]) expect(request).toContain(part);
    expect(body(2).value, "nothing changes before Apply").toBe("Mira finds the key.");

    fireEvent.click(within(dialog).getByRole("button", { name: t("outline.assist.apply") }));
    await waitFor(() => expect(body(2).value).toBe("Mira finds the key under the pier.\n- She hides it from the council."));
    expect(screen.getByRole("button", { name: t("outline.entry.save", { number: 2 }) })).toBeInTheDocument();
    expect(mocks.store.commits, "applying is an unsaved change, never a write").toHaveLength(0);
    expect(parseMarkdown(mocks.store.files.get(outlineChapterPath(2))!).body.trim()).toBe("Mira finds the key.");
  });

  it("checks a chapter against the canon and lists what does not hold, leaving the text alone on Cancel", async () => {
    mocks.complete.mockResolvedValue(JSON.stringify({ issues: ["Mira uses both hands, but the canon says she lost her left hand."], revised: "Mira finds the key with her right hand." }));
    await open();
    fireEvent.contextMenu(body(2), { clientX: 20, clientY: 20 });
    fireEvent.click(menuItem(t("outline.assist.check")));
    const dialog = await screen.findByRole("dialog", { name: t("outline.assist.checkTitle", { number: 2 }) });
    expect(await within(dialog).findByText("Mira uses both hands, but the canon says she lost her left hand.")).toBeInTheDocument();
    expect(mocks.complete.mock.calls[0][2]).toBe("review");
    fireEvent.click(within(dialog).getByRole("button", { name: t("common.cancel") }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(body(2).value).toBe("Mira finds the key.");
  });

  it("does not apply an answer over a text that changed while the assistant worked", async () => {
    let answer: (text: string) => void = () => undefined;
    mocks.complete.mockImplementation(() => new Promise<string>((resolve) => { answer = resolve; }));
    await open();
    fireEvent.contextMenu(body(2), { clientX: 20, clientY: 20 });
    fireEvent.click(menuItem(t("outline.assist.develop")));
    await waitFor(() => expect(mocks.complete).toHaveBeenCalled());
    fireEvent.change(body(2), { target: { value: "Typed meanwhile." } });
    await act(async () => { answer("A developed text."); });
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: t("outline.assist.apply") }));
    expect(await within(dialog).findByText(new RegExp(t("outline.assist.stale").slice(0, 30)))).toBeInTheDocument();
    expect(body(2).value).toBe("Typed meanwhile.");
  });

  it("shows the author's custom actions that apply to the book", async () => {
    const custom: CustomAction = { id: "tighten", name: "Tighten the plan", prompt: "Make it tighter.", capability: "default", targetTypes: ["book"], activation: "element", injections: { includeBody: true, includeFrontmatter: false, includeContext: false, includeGhostwriter: false }, outputMode: "show", enabled: true };
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK], customActions: [custom] } });
    useBooksStore.setState({ structures: { "book-1": structure() as never } });
    await open();
    fireEvent.contextMenu(body(2), { clientX: 20, clientY: 20 });
    // A touch screen lists the actions in the menu itself; a pointer opens them in a submenu.
    const submenu = screen.queryByRole("button", { name: t("customActions.menu") });
    if (submenu) fireEvent.mouseEnter(submenu.parentElement!);
    expect(await screen.findByRole("button", { name: "Tighten the plan" })).toBeInTheDocument();
  });
});

describe("the target of a custom action on the outline", () => {
  it("is the book, with the outline's description as its file", () => {
    const settings = { ...DEFAULT_SETTINGS, books: [BOOK] };
    const target = resolveCustomActionTarget({ pathname: "/app/books/book-1/outline", settings, books: settings.books, structures: { "book-1": structure() as never }, workingBranches: { "book-1": "main" } });
    expect(target).toMatchObject({ type: "book", filePath: "outline/book.md" });
  });
});
