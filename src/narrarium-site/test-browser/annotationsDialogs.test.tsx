import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef, type MutableRefObject } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import "@/i18n/annotations";
import { AnnotateDialog } from "@/components/annotations/AnnotateDialog";
import { AnnotationEditorDialog } from "@/components/annotations/AnnotationEditorDialog";
import { TagEditor } from "@/components/annotations/TagEditor";
import { ReaderAnnotationMenu, type ReaderMenuApi } from "@/components/annotations/reader/ReaderAnnotationMenu";
import type { ReaderSelection } from "@/components/annotations/reader/readerSelection";
import { QUOTE_MAX, builtinTag, tagCatalog, type Annotation, type AnnotationTagDefinition, type AppLanguage } from "@/annotations/model";

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const LANGUAGES: AppLanguage[] = ["en", "it"];

const SLOW: AnnotationTagDefinition = {
  id: "slow-pace-k3x9",
  name: "Slow pace",
  description: "The pace slows here.",
  mark: { underline: "dotted", color: "teal", icon: "clock" },
  createdAt: "2026-11-25T10:00:00.000Z",
  updatedAt: "2026-11-25T10:00:00.000Z",
};

function annotation(patch: Partial<Annotation> = {}): Annotation {
  return {
    id: "a-mi4k2000-aaaaaa",
    chapter: "001-the-gate",
    paragraph: "001-opening",
    quote: "the color of old steel",
    prefix: "The gate stood open beneath a sky ",
    suffix: ". Mara waited by the wall",
    offset: 34,
    tag: "rewrite",
    comment: "Too familiar an image.",
    status: "open",
    createdAt: "2026-11-25T10:00:00.000Z",
    updatedAt: "2026-11-25T10:00:00.000Z",
    createdOnDevice: "d-1a2b3c4d",
    ...patch,
  };
}

const tagName = (id: string, language: AppLanguage) => builtinTag(id, language)!.name;

beforeAll(() => i18n.changeLanguage("en"));
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await i18n.changeLanguage("en");
});

describe("the dialog that annotates a passage", () => {
  it.each(LANGUAGES)("shows the passage, starts from the last tag used, and saves the chosen tag with the note (%s)", async (language) => {
    await i18n.changeLanguage(language);
    const onSave = vi.fn(async () => true);
    const onClose = vi.fn();
    render(<AnnotateDialog request={{ quote: "the color of old steel", tagId: "keep" }} catalog={tagCatalog({ language, book: [SLOW] })} onClose={onClose} onSave={onSave} onCreateTag={async () => true} />);

    const dialog = screen.getByRole("dialog", { name: t("annotations.dialog.title") });
    expect(within(dialog).getByText("the color of old steel")).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: tagName("keep", language) })).toBeChecked();
    // A tag of the book says so to a screen reader: its mark alone does not.
    expect(within(dialog).getByRole("radio", { name: `Slow pace (${t("annotations.tag.scope.book")})` })).not.toBeChecked();
    fireEvent.click(within(dialog).getByRole("radio", { name: tagName("rewrite", language) }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: t("annotations.dialog.note") }), { target: { value: "  Find an image of hers.  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("annotations.dialog.save") }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith({ tagId: "rewrite", note: "Find an image of hers." });
  });

  it("stays open when the annotation could not be saved", async () => {
    const onClose = vi.fn();
    render(<AnnotateDialog request={{ quote: "nobody came" }} catalog={tagCatalog({ language: "en" })} onClose={onClose} onSave={async () => false} onCreateTag={async () => true} />);
    // Without a last tag it starts from the first of the catalogue.
    expect(screen.getByRole("radio", { name: tagName("rewrite", "en") })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: t("annotations.dialog.save") }));
    await waitFor(() => expect(screen.getByRole("button", { name: t("annotations.dialog.save") })).toBeEnabled());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("makes a new tag of the book on the spot, refuses a name already taken, and chooses the new tag", async () => {
    const onCreateTag = vi.fn(async () => true);
    const catalog = tagCatalog({ language: "en" });
    // The reader keeps the request while the dialog is open.
    const request = { quote: "nobody came" };
    const { rerender } = render(<AnnotateDialog request={request} catalog={catalog} onClose={() => undefined} onSave={async () => true} onCreateTag={onCreateTag} />);

    fireEvent.click(screen.getByRole("button", { name: t("annotations.menu.newTag") }));
    const dialog = screen.getByRole("dialog", { name: t("annotations.dialog.newTag") });
    const name = within(dialog).getByRole("textbox", { name: t("annotations.tagEditor.name") });
    fireEvent.change(name, { target: { value: "to REWRITE" } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("annotations.tagEditor.create") }));
    expect(within(dialog).getByText(t("annotations.tagEditor.nameTaken"))).toBeInTheDocument();
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(onCreateTag).not.toHaveBeenCalled();

    fireEvent.change(name, { target: { value: "Slow pace" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: t("annotations.underline.dashed") }));
    fireEvent.click(within(dialog).getByRole("radio", { name: t("annotations.icon.clock") }));
    fireEvent.click(within(dialog).getByRole("radio", { name: t("annotations.color.violet") }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: t("annotations.tagEditor.description") }), { target: { value: "Cut what does not move the scene." } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("annotations.tagEditor.create") }));

    await waitFor(() => expect(onCreateTag).toHaveBeenCalledTimes(1));
    const created = (onCreateTag.mock.calls[0] as unknown as [AnnotationTagDefinition])[0];
    expect(created).toMatchObject({ name: "Slow pace", description: "Cut what does not move the scene.", mark: { underline: "dashed", icon: "clock", color: "violet" } });
    expect(created.id).toMatch(/^slow-pace-[a-z0-9]{4}$/);
    expect(created.createdAt).toBe(created.updatedAt);

    // The reader adds the tag to the catalogue; the dialog is back on the passage with the new tag chosen.
    rerender(<AnnotateDialog request={request} catalog={tagCatalog({ language: "en", book: [created] })} onClose={() => undefined} onSave={async () => true} onCreateTag={onCreateTag} />);
    await waitFor(() => expect(screen.getByRole("dialog", { name: t("annotations.dialog.title") })).toBeInTheDocument());
    expect(screen.getByRole("radio", { name: `Slow pace (${t("annotations.tag.scope.book")})` })).toBeChecked();
  });

  it("opens on the form of a new tag when the menu asked for it, with the note written there", () => {
    render(<AnnotateDialog request={{ quote: "nobody came", note: "Shorter", newTag: true }} catalog={tagCatalog({ language: "en" })} onClose={() => undefined} onSave={async () => true} onCreateTag={async () => true} />);
    expect(screen.getByRole("dialog", { name: t("annotations.dialog.newTag") })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("annotations.tagEditor.cancel") }));
    expect(screen.getByRole("textbox", { name: t("annotations.dialog.note") })).toHaveValue("Shorter");
  });

  it("refuses a passage longer than a scene's worth of marks", () => {
    render(<AnnotateDialog request={{ quote: "x".repeat(QUOTE_MAX + 1) }} catalog={tagCatalog({ language: "en" })} onClose={() => undefined} onSave={async () => true} onCreateTag={async () => true} />);
    expect(screen.getByRole("alert")).toHaveTextContent(t("annotations.dialog.tooLong", { max: QUOTE_MAX }));
    expect(screen.getByRole("button", { name: t("annotations.dialog.save") })).toBeDisabled();
  });
});

describe("the form of a tag", () => {
  it.each(LANGUAGES)("names every choice of the mark, wants a name, and keeps what it does not know of the tag it changes (%s)", async (language) => {
    await i18n.changeLanguage(language);
    const onSave = vi.fn();
    const known = { ...SLOW, extra: { sticky: true } };
    render(<TagEditor initial={known} takenNames={["slow pace", "to rewrite"]} onSave={onSave} onCancel={() => undefined} />);

    for (const group of ["underline", "icon", "color"]) expect(screen.getByRole("group", { name: t(`annotations.tagEditor.${group}`) })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: t("annotations.underline.dotted") })).toBeChecked();
    expect(screen.getByRole("radio", { name: t("annotations.icon.clock") })).toBeChecked();
    expect(screen.getByRole("radio", { name: t("annotations.color.teal") })).toBeChecked();

    const name = screen.getByRole("textbox", { name: t("annotations.tagEditor.name") });
    fireEvent.change(name, { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: t("annotations.tagEditor.save") }));
    expect(screen.getByText(t("annotations.tagEditor.nameRequired"))).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();

    // Its own name is not «taken».
    fireEvent.change(name, { target: { value: "Slow Pace" } });
    fireEvent.click(screen.getByRole("radio", { name: t("annotations.underline.wavy") }));
    fireEvent.click(screen.getByRole("radio", { name: t("annotations.icon.star") }));
    fireEvent.click(screen.getByRole("radio", { name: t("annotations.color.rose") }));
    fireEvent.click(screen.getByRole("button", { name: t("annotations.tagEditor.save") }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0] as AnnotationTagDefinition;
    expect(saved).toMatchObject({ id: SLOW.id, name: "Slow Pace", createdAt: SLOW.createdAt, mark: { underline: "wavy", icon: "star", color: "rose" }, extra: { sticky: true } });
    expect(saved.updatedAt > SLOW.updatedAt).toBe(true);
  });
});

describe("the dialog of an annotation", () => {
  const catalog = tagCatalog({ language: "en", book: [SLOW] });
  const show = (targets: Parameters<typeof AnnotationEditorDialog>[0]["targets"], handlers: { onSave?: (value: Annotation) => Promise<boolean>; onDelete?: (value: Annotation) => Promise<boolean>; onClose?: () => void } = {}) => render(
    <MemoryRouter>
      <AnnotationEditorDialog targets={targets} catalog={catalog} onClose={handlers.onClose ?? (() => undefined)} onSave={handlers.onSave ?? (async () => true)} onDelete={handlers.onDelete ?? (async () => true)} />
    </MemoryRouter>,
  );

  it("says where the passage is now, and changes its tag, note and status", async () => {
    const onSave = vi.fn(async () => true);
    const onClose = vi.fn();
    show([{ annotation: annotation(), state: "moved", sceneHref: "/app/books/b/chapters/001-the-gate/paragraphs/001" }], { onSave, onClose });

    const dialog = screen.getByRole("dialog", { name: t("annotations.edit.title") });
    expect(within(dialog).getByText(t("annotations.anchor.moved"))).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: t("annotations.edit.openScene") })).toHaveAttribute("href", "/app/books/b/chapters/001-the-gate/paragraphs/001");
    expect(within(dialog).getByRole("radio", { name: t("annotations.status.open") })).toBeChecked();
    fireEvent.click(within(dialog).getByRole("radio", { name: `Slow pace (${t("annotations.tag.scope.book")})` }));
    fireEvent.click(within(dialog).getByRole("radio", { name: t("annotations.status.handled") }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: t("annotations.dialog.note") }), { target: { value: "Done." } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("annotations.edit.save") }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const saved = (onSave.mock.calls[0] as unknown as [Annotation])[0];
    expect(saved).toMatchObject({ id: "a-mi4k2000-aaaaaa", tag: SLOW.id, comment: "Done.", status: "handled", quote: "the color of old steel", createdAt: "2026-11-25T10:00:00.000Z" });
    expect(saved.updatedAt > "2026-11-25T10:00:00.000Z").toBe(true);
  });

  it("writes back as they were a status of a newer app and a tag that is gone, unless the author chose others", async () => {
    const onSave = vi.fn(async () => true);
    show([{ annotation: annotation({ status: "snoozed", tag: "gone-1a2b" }), state: "exact" }], { onSave });
    // A passage in its place has no notice.
    for (const state of ["moved", "edited", "orphaned"]) expect(screen.queryByText(t(`annotations.anchor.${state}`))).toBeNull();
    // The tag that is gone is offered and chosen, under its stand-in name.
    expect(screen.getByRole("radio", { name: t("annotations.tag.missing") })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: t("annotations.edit.save") }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect((onSave.mock.calls[0] as unknown as [Annotation])[0]).toMatchObject({ status: "snoozed", tag: "gone-1a2b" });
  });

  it("deletes only after the author confirms", async () => {
    const onDelete = vi.fn(async () => true);
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    show([{ annotation: annotation() }], { onDelete });
    fireEvent.click(screen.getByRole("button", { name: t("annotations.edit.delete") }));
    expect(confirm).toHaveBeenCalledWith(t("annotations.edit.deleteConfirm"));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: t("annotations.edit.delete") }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
  });

  it("chooses among the annotations on the same words", () => {
    show([{ annotation: annotation() }, { annotation: annotation({ id: "a-mi4k3000-bbbbbb", tag: "keep", comment: "Keep it." }) }]);
    const group = screen.getByRole("group", { name: t("annotations.mark.overlap", { count: 2 }) });
    expect(within(group).getByRole("button", { name: tagName("rewrite", "en") })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(group).getByRole("button", { name: tagName("keep", "en") }));
    expect(within(group).getByRole("button", { name: tagName("keep", "en") })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("textbox", { name: t("annotations.dialog.note") })).toHaveValue("Keep it.");
  });
});

describe("«Annotate» in the menu of a selection", () => {
  const selection = (): ReaderSelection => ({
    chapterSlug: "001-the-gate",
    paragraphSlug: "001-opening",
    paragraphNumber: "001",
    anchor: { quote: "nobody came", prefix: "one by one, and ", suffix: ".", offset: 120 },
    range: document.createRange(),
  });
  function menuApi(): MutableRefObject<ReaderMenuApi> {
    const ref = createRef<ReaderMenuApi>() as MutableRefObject<ReaderMenuApi>;
    ref.current = {
      catalog: tagCatalog({ language: "en", book: [SLOW] }),
      shortcut: "Ctrl+Alt+M",
      annotate: vi.fn(async () => true),
      openDialog: vi.fn(),
      edit: vi.fn(),
      remove: vi.fn(async () => undefined),
    };
    return ref;
  }

  it("on a computer opens a submenu: a note, the tags (one saves the annotation with the note), a new tag and more options", async () => {
    const api = menuApi();
    const current = selection();
    const close = vi.fn();
    render(<ReaderAnnotationMenu context={{ kind: "selection", selection: current }} close={close} touch={false} menuX={100} api={api} />);

    const annotate = screen.getByRole("button", { name: /^Annotate/ });
    expect(annotate).toHaveTextContent("(Ctrl+Alt+M)");
    expect(annotate).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(annotate);
    expect(annotate).toHaveAttribute("aria-expanded", "true");
    fireEvent.change(screen.getByRole("textbox", { name: t("annotations.menu.note") }), { target: { value: " Shorter " } });
    const tags = screen.getByRole("group", { name: t("annotations.menu.tagsLabel") });
    expect(within(tags).getAllByRole("button").map((button) => button.textContent)).toEqual([...tagCatalog({ language: "en" }).map((tag) => tag.name), "Slow pace"]);
    fireEvent.click(within(tags).getByRole("button", { name: "Slow pace" }));

    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(api.current.annotate).toHaveBeenCalledWith(current, SLOW.id, "Shorter");

    fireEvent.click(screen.getByRole("button", { name: t("annotations.menu.newTag") }));
    expect(api.current.openDialog).toHaveBeenCalledWith(current, { note: "Shorter", newTag: true });
    fireEvent.click(screen.getByRole("button", { name: t("annotations.menu.moreOptions") }));
    expect(api.current.openDialog).toHaveBeenLastCalledWith(current, { note: "Shorter", newTag: false });
  });

  it("on a touch screen has its items in the menu itself", () => {
    render(<ReaderAnnotationMenu context={{ kind: "selection", selection: selection() }} close={() => undefined} touch menuX={0} api={menuApi()} />);
    expect(screen.getByRole("textbox", { name: t("annotations.menu.note") })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Annotate/ })).toBeNull();
  });

  it("lets Escape close the menu from the note, and keeps the other keys to the note", () => {
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    render(<ReaderAnnotationMenu context={{ kind: "selection", selection: selection() }} close={() => undefined} touch menuX={0} api={menuApi()} />);
    const note = screen.getByRole("textbox", { name: t("annotations.menu.note") });
    fireEvent.keyDown(note, { key: "m", ctrlKey: true });
    expect(onWindowKey).not.toHaveBeenCalled();
    fireEvent.keyDown(note, { key: "Escape" });
    expect(onWindowKey).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", onWindowKey);
  });

  it("on a mark edits or deletes its annotations", () => {
    const api = menuApi();
    const close = vi.fn();
    render(<ReaderAnnotationMenu context={{ kind: "mark", ids: ["a-1", "a-2"] }} close={close} touch={false} menuX={0} api={api} />);
    fireEvent.click(screen.getByRole("button", { name: t("annotations.menu.editAnnotation") }));
    expect(api.current.edit).toHaveBeenCalledWith(["a-1", "a-2"]);
    fireEvent.click(screen.getByRole("button", { name: t("annotations.menu.deleteAnnotation") }));
    expect(api.current.remove).toHaveBeenCalledWith(["a-1", "a-2"]);
    expect(close).toHaveBeenCalledTimes(2);
  });
});
