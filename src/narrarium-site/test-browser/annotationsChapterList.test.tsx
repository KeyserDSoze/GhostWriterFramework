import "fake-indexeddb/auto";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ load: async () => undefined, save: vi.fn(async () => undefined), resolveOfflineConflict: async () => undefined, syncStatus: "idle", lastSynced: null }) }));

import i18n from "@/i18n";
import "@/i18n/annotations";
import { ChapterAnnotationsPage } from "@/pages/ChapterAnnotationsPage";
import { resetBookStructureLoadCoordinator } from "@/hooks/useBookStructure";
import { getLocalFile } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { resetAnnotationOverridesForTests } from "@/annotations/useBookAnnotations";
import { liveAnnotations, parseChapterAnnotations } from "@/annotations/format";
import { builtinTag, type AppLanguage } from "@/annotations/model";
import { blockNetwork, createLocalOnlyBook, resetLocalWorkspace, type LocalFirstBook } from "./helpers/localFirst";

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const LANGUAGES: AppLanguage[] = ["en", "it"];

const CHAPTER = "001-the-gate";
const PATH = `annotations/chapters/${CHAPTER}.yml`;
const OPENING = "The gate stood open beneath a sky the color of old steel. Mara waited by the wall, counting the lanterns one by one, and nobody came.";
const COURTYARD = "Inside, the courtyard smelled of rain and oranges. Somebody had left a lamp burning in the gatehouse window.";

function entry(id: string, paragraph: string, text: string, quote: string, extra: Record<string, string>, offset?: number): string {
  const at = offset ?? text.indexOf(quote);
  return [
    `  - id: ${id}`,
    `    paragraph: paragraph:${CHAPTER}:${paragraph}`,
    `    quote: ${JSON.stringify(quote)}`,
    `    prefix: ${JSON.stringify(text.slice(Math.max(0, at - 32), at))}`,
    `    suffix: ${JSON.stringify(text.slice(at + quote.length, at + quote.length + 32))}`,
    `    offset: ${at}`,
    ...Object.entries({ tag: "rewrite", comment: "", status: "open", ...extra }).map(([key, value]) => `    ${key}: ${JSON.stringify(value)}`),
    "    createdAt: 2026-11-25T10:00:00.000Z",
    "    updatedAt: 2026-11-25T10:00:00.000Z",
    "    createdOnDevice: d-1a2b3c4d",
  ].join("\n");
}

const ANNOTATIONS = [
  "version: 1",
  `chapter: chapter:${CHAPTER}`,
  "annotations:",
  entry("a-mi4k2000-aaaaaa", "001-opening", OPENING, "the color of old steel", { comment: "Too familiar an image." }),
  entry("a-mi4k3000-bbbbbb", "001-opening", OPENING, "counting the lanterns one by one", { tag: "keep", status: "handled", comment: "Done already." }),
  entry("a-mi4k4000-cccccc", "002-the-courtyard", COURTYARD, "smelled of rain and oranges", { tag: "slow-pace-k3x9", status: "later", comment: "Shorter." }),
  // Cut from the text since: it was after the first passage.
  entry("a-mi4k5000-dddddd", "001-opening", "The gate stood open beneath a sky the color of old steel. Somewhere far off there was a bell that nobody rang, ever, in all those years.", "a bell that nobody rang", { tag: "dislike", comment: "Cut in the last pass." }),
  "",
].join("\n");
const TAGS = "version: 1\ntags:\n  - id: slow-pace-k3x9\n    name: Slow pace\n    description: Cut what does not move the scene.\n    mark:\n      underline: dotted\n      color: teal\n      icon: clock\n    createdAt: 2026-11-25T10:00:00.000Z\n    updatedAt: 2026-11-25T10:00:00.000Z\n";

const FILES = [
  { path: `chapters/${CHAPTER}/chapter.md`, content: `---\ntype: chapter\nid: chapter:${CHAPTER}\nnumber: 1\ntitle: The Gate\n---\n\nThe first chapter.\n` },
  { path: `chapters/${CHAPTER}/001-opening.md`, content: `---\ntype: paragraph\nid: paragraph:${CHAPTER}:001-opening\nchapter: chapter:${CHAPTER}\nnumber: 1\ntitle: Opening\n---\n\n${OPENING}\n` },
  { path: `chapters/${CHAPTER}/002-the-courtyard.md`, content: `---\ntype: paragraph\nid: paragraph:${CHAPTER}:002-the-courtyard\nchapter: chapter:${CHAPTER}\nnumber: 2\ntitle: The courtyard\n---\n\n${COURTYARD}\n` },
  { path: PATH, content: ANNOTATIONS },
  { path: "annotations/tags.yml", content: TAGS },
];

function Where() {
  const location = useLocation();
  return <span data-testid="where" data-state={JSON.stringify(location.state ?? null)}>{location.pathname}</span>;
}

async function openList(book: LocalFirstBook, search = "") {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, language: i18n.language === "it" ? "it" : "en" }, books: [book.book] } });
  render(
    <MemoryRouter initialEntries={[`/app/books/${book.book.id}/chapters/${CHAPTER}/annotations${search}`]}>
      <Routes>
        <Route path="/app/books/:bookId/chapters/:chapterId/annotations" element={<ChapterAnnotationsPage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByRole("heading", { level: 1, name: t("annotations.list.heading", { chapter: "The Gate" }) });
}

const items = () => screen.queryAllByRole("listitem").filter((item) => item.querySelector("blockquote"));
const quotes = () => items().map((item) => item.querySelector("blockquote")!.textContent);

vi.setConfig({ testTimeout: 60_000 });
beforeAll(() => i18n.changeLanguage("en"));
beforeEach(async () => {
  await resetLocalWorkspace();
  resetAnnotationOverridesForTests();
  resetBookStructureLoadCoordinator();
  mocks.toast.mockReset();
});
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("the list of the annotations of a chapter", () => {
  it.each(LANGUAGES)("shows those to review scene by scene, where each passage is now, from the working copy alone (%s)", async (language) => {
    await i18n.changeLanguage(language);
    const network = blockNetwork();
    const book = await createLocalOnlyBook("The Annotated Gate", FILES);
    await openList(book);

    await waitFor(() => expect(quotes()).toEqual(["the color of old steel", "a bell that nobody rang", "smelled of rain and oranges"]));
    expect(screen.getByRole("combobox", { name: t("annotations.list.filterStatus") })).toHaveValue("pending");
    expect(screen.getByRole("heading", { level: 2, name: "001 · Opening" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "002 · The courtyard" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(t("annotations.list.count", { count: 3 }));

    const [steel, bell, oranges] = items();
    expect(within(steel).getByText(builtinTag("rewrite", language)!.name)).toBeInTheDocument();
    expect(within(steel).getByText(t("annotations.tag.scope.builtin"))).toBeInTheDocument();
    expect(within(steel).getByRole("link", { name: t("annotations.list.openScene") })).toHaveAttribute("href", `/app/books/${book.book.id}/chapters/${CHAPTER}/paragraphs/001`);
    expect(within(oranges).getByText("Slow pace")).toBeInTheDocument();
    expect(within(oranges).getByText(t("annotations.status.later"))).toBeInTheDocument();
    // A passage no longer in the text keeps its quote and says so; it cannot be shown in the reader.
    expect(await within(bell).findByText(t("annotations.anchor.orphaned"))).toBeInTheDocument();
    expect(within(bell).queryByRole("link", { name: new RegExp(t("annotations.list.showInReader")) })).toBeNull();
    expect(network.requests).toEqual([]);
  });

  it("filters by status, tag and scene, keeps the filters in the address, and shows a passage in the reader", async () => {
    blockNetwork();
    const book = await createLocalOnlyBook("The Annotated Gate", FILES);
    await openList(book, "?scene=002-the-courtyard");
    await waitFor(() => expect(quotes()).toEqual(["smelled of rain and oranges"]));
    expect(screen.getByRole("combobox", { name: t("annotations.list.filterScene") })).toHaveValue("002-the-courtyard");

    fireEvent.change(screen.getByRole("combobox", { name: t("annotations.list.filterScene") }), { target: { value: "" } });
    fireEvent.change(screen.getByRole("combobox", { name: t("annotations.list.filterStatus") }), { target: { value: "handled" } });
    await waitFor(() => expect(quotes()).toEqual(["counting the lanterns one by one"]));
    fireEvent.change(screen.getByRole("combobox", { name: t("annotations.list.filterStatus") }), { target: { value: "all" } });
    fireEvent.change(screen.getByRole("combobox", { name: t("annotations.list.filterTag") }), { target: { value: "keep" } });
    await waitFor(() => expect(quotes()).toEqual(["counting the lanterns one by one"]));
    // Only the tags in use are offered.
    expect(within(screen.getByRole("combobox", { name: t("annotations.list.filterTag") })).getAllByRole("option").map((option) => (option as HTMLOptionElement).value)).toEqual(["", "rewrite", "dislike", "keep", "slow-pace-k3x9"]);

    fireEvent.click(within(items()[0]).getByRole("link", { name: t("annotations.list.showInReader") }));
    expect(screen.getByTestId("where")).toHaveTextContent(`/app/books/${book.book.id}/reader`);
    expect(JSON.parse(screen.getByTestId("where").dataset.state!)).toEqual({ annotationId: "a-mi4k3000-bbbbbb" });
  });

  it("changes an annotation, which leaves the list of those to review, and writes it in the book", async () => {
    const network = blockNetwork();
    const book = await createLocalOnlyBook("The Annotated Gate", FILES);
    await openList(book);
    await waitFor(() => expect(items()).toHaveLength(3));

    fireEvent.click(within(items()[0]).getByRole("button", { name: t("annotations.edit.action") }));
    const dialog = screen.getByRole("dialog", { name: t("annotations.edit.title") });
    fireEvent.click(within(dialog).getByRole("radio", { name: t("annotations.status.handled") }));
    fireEvent.click(within(dialog).getByRole("button", { name: t("annotations.edit.save") }));

    await waitFor(() => expect(quotes()).toEqual(["a bell that nobody rang", "smelled of rain and oranges"]));
    const parsed = parseChapterAnnotations((await getLocalFile(book.meta.id, PATH, captureRepositoryOperationScope()))!.text!, CHAPTER);
    expect(parsed.ok && liveAnnotations(parsed.file).find((item) => item.id === "a-mi4k2000-aaaaaa")?.status).toBe("handled");
    expect(network.requests).toEqual([]);
  });

  it("makes, changes and deletes the tags of the book", async () => {
    blockNetwork();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const book = await createLocalOnlyBook("The Annotated Gate", FILES);
    await openList(book);
    const section = screen.getByRole("region", { name: t("annotations.list.bookTags") });
    await waitFor(() => expect(within(section).getByText("Slow pace")).toBeInTheDocument());

    fireEvent.click(within(section).getByRole("button", { name: t("annotations.list.newTag") }));
    fireEvent.change(within(section).getByRole("textbox", { name: t("annotations.tagEditor.name") }), { target: { value: "Doubt" } });
    fireEvent.click(within(section).getByRole("button", { name: t("annotations.tagEditor.create") }));
    const edit = await within(section).findByRole("button", { name: t("annotations.tag.edit", { name: "Doubt" }) });

    fireEvent.click(edit);
    fireEvent.change(within(section).getByRole("textbox", { name: t("annotations.tagEditor.name") }), { target: { value: "Doubts" } });
    fireEvent.click(within(section).getByRole("button", { name: t("annotations.tagEditor.save") }));
    await within(section).findByRole("button", { name: t("annotations.tag.edit", { name: "Doubts" }) });

    fireEvent.click(within(section).getByRole("button", { name: t("annotations.tag.delete", { name: "Slow pace" }) }));
    expect(confirm).toHaveBeenCalledWith(t("annotations.list.deleteTagConfirm", { name: "Slow pace" }));
    await waitFor(() => expect(within(section).queryByText("Slow pace")).toBeNull());
    // The annotation with the deleted tag keeps its passage and note, under the stand-in.
    const oranges = items().find((item) => item.textContent?.includes("smelled of rain"))!;
    expect(within(oranges).getByText(t("annotations.tag.missing"))).toBeInTheDocument();
    expect(within(oranges).getByText("Shorter.")).toBeInTheDocument();
  });
});
