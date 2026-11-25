import { useId, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import { Highlighter, PencilLine, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import "@/i18n/annotations";
import { TagLabel } from "@/components/annotations/TagLabel";
import type { ResolvedTag } from "@/annotations/model";
import type { ReaderSelection } from "@/components/annotations/reader/readerSelection";

/** What the reader gives the menu: the tags, and what each item does. Read when an item is used, so that it is always the latest. */
export interface ReaderMenuApi {
  catalog: readonly ResolvedTag[];
  shortcut: string;
  annotate: (selection: ReaderSelection, tagId: string, note: string) => Promise<boolean>;
  openDialog: (selection: ReaderSelection, options: { note: string; newTag: boolean }) => void;
  edit: (ids: string[]) => void;
  remove: (ids: string[]) => Promise<void>;
}

export type ReaderMenuContext = { kind: "selection"; selection: ReaderSelection } | { kind: "mark"; ids: string[] };

const ITEM = "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 [@media(pointer:coarse)]:min-h-11";
const SUBMENU_WIDTH = 264;
const MENU_WIDTH = 234;

/**
 * «Annotate» in the menu of a selection of the reader: a note field, the tags (choosing one saves the annotation with the note), «New tag…» and
 * «More options…» (the dialog). On a computer it is a submenu; on a touch screen its items are in the menu itself. On a mark: edit and delete.
 */
export function ReaderAnnotationMenu({ context, close, touch, menuX, api }: { context: ReaderMenuContext; close: () => void; touch: boolean; menuX: number; api: MutableRefObject<ReaderMenuApi> }) {
  const { t } = useTranslation();
  const noteId = useId();
  const [open, setOpen] = useState(touch);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const submenu = useRef<HTMLDivElement | null>(null);
  const [lift, setLift] = useState(0);

  // The submenu opens beside its item and goes up as far as it must to stay on the screen.
  useLayoutEffect(() => {
    if (!open || touch || !submenu.current) return;
    const rect = submenu.current.getBoundingClientRect();
    const overflow = rect.bottom + lift - (window.innerHeight - 8);
    const next = Math.max(0, Math.min(overflow, rect.top + lift - 8));
    if (next !== lift) setLift(next);
  });

  if (context.kind === "mark") {
    return (
      <div className="flex flex-col">
        <button type="button" className={ITEM} onClick={() => { close(); api.current.edit(context.ids); }}>
          <PencilLine className="h-4 w-4 shrink-0" aria-hidden="true" /><span>{t("annotations.menu.editAnnotation")}</span>
        </button>
        <button type="button" className={ITEM} onClick={() => { close(); void api.current.remove(context.ids); }}>
          <Trash2 className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" /><span>{t("annotations.menu.deleteAnnotation")}</span>
        </button>
      </div>
    );
  }

  const selection = context.selection;
  const save = async (tagId: string) => {
    if (busy) return;
    setBusy(true);
    const saved = await api.current.annotate(selection, tagId, note.trim());
    setBusy(false);
    if (saved) close();
  };

  const body = (
    <div className="flex flex-col gap-1 p-1">
      <label htmlFor={noteId} className="px-1.5 pt-1 text-xs font-medium text-muted-foreground">{t("annotations.menu.note")}</label>
      <input
        id={noteId}
        type="text"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        // The keys type the note (no shortcut of the page takes them); Escape still closes the menu.
        onKeyDown={(event) => { if (event.key !== "Escape") event.stopPropagation(); }}
        className="mx-1 h-9 rounded-md border border-field bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11"
        autoComplete="off"
      />
      <div role="group" aria-label={t("annotations.menu.tagsLabel")} className="mt-1 flex max-h-64 flex-col overflow-y-auto">
        <p className="px-1.5 pb-0.5 text-xs font-medium text-muted-foreground" aria-hidden="true">{t("annotations.menu.tagsLabel")}</p>
        {api.current.catalog.map((tag) => (
          <button key={tag.id} type="button" disabled={busy} className={ITEM} title={tag.description || undefined} onClick={() => void save(tag.id)}>
            <TagLabel tag={tag} />
          </button>
        ))}
      </div>
      <div className="my-1 h-px bg-border" />
      <button type="button" className={ITEM} onClick={() => { close(); api.current.openDialog(selection, { note: note.trim(), newTag: true }); }}>
        <Plus className="h-4 w-4 shrink-0" aria-hidden="true" /><span>{t("annotations.menu.newTag")}</span>
      </button>
      <button type="button" className={ITEM} onClick={() => { close(); api.current.openDialog(selection, { note: note.trim(), newTag: false }); }}>
        <SlidersHorizontal className="h-4 w-4 shrink-0" aria-hidden="true" /><span>{t("annotations.menu.moreOptions")}</span>
      </button>
    </div>
  );

  if (touch) {
    return (
      <div>
        <p className="flex items-center gap-2 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><Highlighter className="h-3.5 w-3.5" aria-hidden="true" />{t("annotations.annotate")}</p>
        {body}
      </div>
    );
  }

  const toLeft = menuX + MENU_WIDTH + SUBMENU_WIDTH + 16 > window.innerWidth;
  return (
    <div className="relative" onMouseEnter={() => setOpen(true)}>
      <button type="button" className={ITEM} aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((value) => !value)}>
        <Highlighter className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">{t("annotations.annotate")}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">({api.current.shortcut})</span>
        <span className="shrink-0 text-xs text-muted-foreground" aria-hidden="true">▶</span>
      </button>
      {open && (
        <div
          ref={submenu}
          data-no-context-menu
          className={`absolute z-[75] overflow-y-auto rounded-xl border border-layer bg-popover text-popover-foreground shadow-2xl ${toLeft ? "right-full mr-1" : "left-full ml-1"}`}
          style={{ width: SUBMENU_WIDTH, top: -lift, maxHeight: "calc(100dvh - 16px)" }}
        >
          {body}
        </div>
      )}
    </div>
  );
}
