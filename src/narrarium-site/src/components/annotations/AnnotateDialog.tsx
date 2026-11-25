import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import "@/i18n/annotations";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { TagPicker } from "@/components/annotations/TagPicker";
import { TagEditor, suggestedMark } from "@/components/annotations/TagEditor";
import { COMMENT_MAX, QUOTE_MAX, type AnnotationTagDefinition, type ResolvedTag } from "@/annotations/model";

export interface AnnotateRequest {
  quote: string;
  /** The tag to start with (the last one used); the first of the catalogue otherwise. */
  tagId?: string;
  note?: string;
  /** Open on the form of a new tag of the book («New tag…» of the menu). */
  newTag?: boolean;
}

/**
 * The dialog that annotates a selected passage: the passage, its tag (radio buttons, arrows to move), a note, and a new tag of the book made on the
 * spot. On a phone it is the sheet the toolbar of the selection opens; on a computer the shortcut and «Annotate» of the reader open it.
 */
export function AnnotateDialog({ request, catalog, onClose, onSave, onCreateTag }: {
  request: AnnotateRequest | null;
  catalog: readonly ResolvedTag[];
  onClose: () => void;
  onSave: (input: { tagId: string; note: string }) => Promise<boolean>;
  onCreateTag: (tag: AnnotationTagDefinition) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const base = useId();
  const [tagId, setTagId] = useState("");
  const [note, setNote] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!request) return;
    setTagId(request.tagId && catalog.some((tag) => tag.id === request.tagId) ? request.tagId : catalog[0]?.id ?? "");
    setNote(request.note ?? "");
    setCreating(Boolean(request.newTag));
    setBusy(false);
    // The catalogue is read when the dialog opens: a tag made in it is chosen by the creation itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const tooLong = Boolean(request && request.quote.length > QUOTE_MAX);
  const takenNames = useMemo(() => catalog.map((tag) => tag.name.toLocaleLowerCase()), [catalog]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!request || !tagId || tooLong || busy) return;
    setBusy(true);
    const saved = await onSave({ tagId, note: note.trim() });
    setBusy(false);
    if (saved) onClose();
  };

  const createTag = async (tag: AnnotationTagDefinition) => {
    setBusy(true);
    const created = await onCreateTag(tag);
    setBusy(false);
    if (!created) return;
    setTagId(tag.id);
    setCreating(false);
  };

  return (
    <Dialog open={Boolean(request)} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{creating ? t("annotations.dialog.newTag") : t("annotations.dialog.title")}</DialogTitle>
          <DialogDescription>{creating ? t("annotations.dialog.newTagDescription") : t("annotations.dialog.description")}</DialogDescription>
        </DialogHeader>
        {request && (
          <figure className="rounded-md border-l-4 border-primary/50 bg-muted/40 px-3 py-2">
            <figcaption className="text-xs uppercase tracking-wide text-muted-foreground">{t("annotations.dialog.passage")}</figcaption>
            <blockquote className="mt-1 line-clamp-4 font-serif text-sm">{request.quote}</blockquote>
          </figure>
        )}
        {tooLong && <p role="alert" className="text-sm text-destructive">{t("annotations.dialog.tooLong", { max: QUOTE_MAX })}</p>}
        {creating ? (
          <TagEditor
            takenNames={takenNames}
            suggested={suggestedMark(catalog.map((tag) => tag.mark))}
            onSave={createTag}
            onCancel={() => setCreating(false)}
            busy={busy}
          />
        ) : (
          <form onSubmit={(event) => void save(event)} className="space-y-4">
            <TagPicker catalog={catalog} value={tagId} onChange={setTagId} legend={t("annotations.dialog.tag")} name={`${base}-tag`} />
            <Button type="button" variant="ghost" size="sm" onClick={() => setCreating(true)} className="-ml-2 [@media(pointer:coarse)]:h-11">
              <Plus aria-hidden="true" />{t("annotations.menu.newTag")}
            </Button>
            <div className="grid gap-2">
              <Label htmlFor={`${base}-note`}>{t("annotations.dialog.note")}</Label>
              <Textarea id={`${base}-note`} value={note} maxLength={COMMENT_MAX} rows={3} placeholder={t("annotations.dialog.notePlaceholder")} onChange={(event) => setNote(event.target.value)} />
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" onClick={onClose} disabled={busy} className="[@media(pointer:coarse)]:h-11">{t("annotations.dialog.cancel")}</Button>
              <Button type="submit" disabled={busy || !tagId || tooLong} className="[@media(pointer:coarse)]:h-11">{busy ? t("annotations.dialog.saving") : t("annotations.dialog.save")}</Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
