import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import "@/i18n/annotations";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { TagPicker } from "@/components/annotations/TagPicker";
import { AnchorNotice } from "@/components/annotations/AnchorNotice";
import { ANNOTATION_STATUSES, COMMENT_MAX, annotationStatus, resolveTag, type Annotation, type AnnotationStatus, type ResolvedTag } from "@/annotations/model";
import type { AnchorState } from "@/annotations/anchoring";
import { cn } from "@/lib/utils";

export interface AnnotationEditTarget {
  annotation: Annotation;
  state?: AnchorState;
  /** The scene, to work on it by hand. */
  sceneHref?: string;
}

/**
 * The popover of an annotation, as a dialog: its passage and where it is now, its tag, its note and its status, and Delete. Several annotations on the
 * same words are chosen among at the top.
 */
export function AnnotationEditorDialog({ targets, catalog, onClose, onSave, onDelete }: {
  targets: readonly AnnotationEditTarget[] | null;
  catalog: readonly ResolvedTag[];
  onClose: () => void;
  onSave: (annotation: Annotation) => Promise<boolean>;
  onDelete: (annotation: Annotation) => Promise<boolean>;
}) {
  const { t, i18n } = useTranslation();
  const base = useId();
  const [index, setIndex] = useState(0);
  const target = targets?.[Math.min(index, (targets?.length ?? 1) - 1)] ?? null;
  const [tagId, setTagId] = useState("");
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<AnnotationStatus>("open");
  const [busy, setBusy] = useState(false);

  useEffect(() => { setIndex(0); }, [targets]);
  useEffect(() => {
    if (!target) return;
    setTagId(target.annotation.tag);
    setNote(target.annotation.comment);
    setStatus(annotationStatus(target.annotation.status));
    setBusy(false);
  }, [target]);

  if (!targets || !target) return null;
  const annotation = target.annotation;
  // The tag of the annotation is offered even when it is gone, so that saving does not change it unasked.
  const tags = catalog.some((tag) => tag.id === annotation.tag) ? catalog : [...catalog, resolveTag(catalog, annotation.tag, t("annotations.tag.missing"))];
  const keepsUnknownStatus = annotation.status !== status && annotationStatus(annotation.status) === status;

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const changed: Annotation = {
      ...annotation,
      tag: tagId,
      comment: note.trim(),
      // A status of a newer app is written back as it was unless the author chose another.
      status: keepsUnknownStatus ? annotation.status : status,
      updatedAt: new Date().toISOString(),
    };
    const saved = await onSave(changed);
    setBusy(false);
    if (saved) onClose();
  };

  const remove = async () => {
    if (busy || !window.confirm(t("annotations.edit.deleteConfirm"))) return;
    setBusy(true);
    const deleted = await onDelete(annotation);
    setBusy(false);
    if (deleted) onClose();
  };

  const created = annotation.createdAt ? new Date(annotation.createdAt) : null;

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("annotations.edit.title")}</DialogTitle>
          <DialogDescription>{t("annotations.edit.description")}</DialogDescription>
        </DialogHeader>
        {targets.length > 1 && (
          <div role="group" aria-label={t("annotations.mark.overlap", { count: targets.length })} className="flex flex-wrap gap-2">
            {targets.map((entry, position) => (
              <Button
                key={entry.annotation.id}
                type="button"
                size="sm"
                variant={position === index ? "default" : "outline"}
                aria-pressed={position === index}
                onClick={() => setIndex(position)}
                className="[@media(pointer:coarse)]:h-11"
              >
                {resolveTag(catalog, entry.annotation.tag, t("annotations.tag.missing")).name}
              </Button>
            ))}
          </div>
        )}
        <figure className="rounded-md border-l-4 border-primary/50 bg-muted/40 px-3 py-2">
          <blockquote className="line-clamp-5 font-serif text-sm">{annotation.quote}</blockquote>
          {created && !Number.isNaN(created.getTime()) && (
            <figcaption className="mt-1 text-xs text-muted-foreground">{t("annotations.edit.created", { date: created.toLocaleString(i18n.resolvedLanguage) })}</figcaption>
          )}
        </figure>
        {target.state && target.state !== "exact" && <AnchorNotice state={target.state} />}
        <form onSubmit={(event) => void save(event)} className="space-y-4">
          <TagPicker catalog={tags} value={tagId} onChange={setTagId} legend={t("annotations.dialog.tag")} name={`${base}-tag`} />
          <div className="grid gap-2">
            <Label htmlFor={`${base}-note`}>{t("annotations.dialog.note")}</Label>
            <Textarea id={`${base}-note`} value={note} maxLength={COMMENT_MAX} rows={3} placeholder={t("annotations.dialog.notePlaceholder")} onChange={(event) => setNote(event.target.value)} />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("annotations.edit.status")}</legend>
            <div className="flex flex-wrap gap-2">
              {ANNOTATION_STATUSES.map((value) => (
                <label key={value} className={cn("inline-flex min-h-9 cursor-pointer items-center rounded-full border px-3 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 [@media(pointer:coarse)]:min-h-11", status === value ? "border-primary bg-primary/10 font-medium" : "border-field hover:bg-accent/60")}>
                  <input type="radio" name={`${base}-status`} value={value} checked={status === value} onChange={() => setStatus(value)} className="sr-only" />
                  {t(`annotations.status.${value}`)}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => void remove()} disabled={busy} className="text-destructive [@media(pointer:coarse)]:h-11">
                <Trash2 aria-hidden="true" />{t("annotations.edit.delete")}
              </Button>
              {target.sceneHref && (
                <Button asChild variant="ghost" className="[@media(pointer:coarse)]:h-11"><Link to={target.sceneHref}>{t("annotations.edit.openScene")}</Link></Button>
              )}
            </div>
            <Button type="submit" disabled={busy || !tagId} className="[@media(pointer:coarse)]:h-11">{t("annotations.edit.save")}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
