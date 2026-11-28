import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, PencilLine, Plus, Trash2 } from "lucide-react";
import "@/i18n/annotations";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { TagEditor, suggestedMark } from "@/components/annotations/TagEditor";
import { TagLabel } from "@/components/annotations/TagLabel";
import { usePublicNotice } from "@/components/annotations/usePublicNotice";
import { AnnotationsFileError } from "@/annotations/repository";
import { useBookAnnotations } from "@/annotations/useBookAnnotations";
import type { AnnotationTagDefinition } from "@/annotations/model";

/**
 * The tags made for ONE book (`annotations/tags.yml`): listed, made, changed and deleted. On the list of a chapter and on the page of the notes of the book.
 * A deleted tag leaves its annotations with their passage and note, under «Removed tag». The first tag of a GitHub book asks for the notice about a public
 * repository, as the first annotation does.
 */
export function BookTagsPanel({ bookId }: { bookId: string | undefined }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const base = useId();
  const annotations = useBookAnnotations(bookId);
  const notice = usePublicNotice(annotations.book);
  const [tagEditor, setTagEditor] = useState<{ tag?: AnnotationTagDefinition } | null>(null);
  const [busy, setBusy] = useState(false);
  const takenNames = annotations.catalog.map((tag) => tag.name.toLocaleLowerCase());

  const describe = (cause: unknown) => (cause instanceof AnnotationsFileError ? cause.message : cause instanceof Error ? cause.message : String(cause));
  const saveTag = async (tag: AnnotationTagDefinition) => {
    if (!(await notice.confirm("tag"))) return;
    setBusy(true);
    try {
      await annotations.saveBookTag(tag);
      setTagEditor(null);
    } catch (cause) {
      toast({ title: t("annotations.reader.saveFailed"), description: describe(cause), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };
  const removeTag = async (tag: AnnotationTagDefinition) => {
    if (!window.confirm(t("annotations.list.deleteTagConfirm", { name: tag.name }))) return;
    try {
      await annotations.deleteBookTag(tag.id);
    } catch (cause) {
      toast({ title: t("annotations.reader.saveFailed"), description: describe(cause), variant: "destructive" });
    }
  };

  return (
    <>
      <section aria-labelledby={`${base}-title`} className="space-y-3 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 id={`${base}-title`} className="text-lg font-semibold">{t("annotations.list.bookTags")}</h2>
            <p className="text-sm text-muted-foreground">{t("annotations.list.bookTagsDescription")}</p>
          </div>
          {!tagEditor && <Button size="sm" onClick={() => setTagEditor({})} className="[@media(pointer:coarse)]:h-11"><Plus aria-hidden="true" />{t("annotations.list.newTag")}</Button>}
        </div>
        {annotations.tagsError && <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertDescription>{t("annotations.reader.unreadable", { chapter: t("annotations.list.bookTags"), path: "annotations/tags.yml", detail: annotations.tagsError })}</AlertDescription></Alert>}
        {tagEditor && (
          <div className="rounded-lg border p-3">
            <TagEditor
              initial={tagEditor.tag}
              takenNames={takenNames}
              suggested={suggestedMark(annotations.catalog.map((tag) => tag.mark))}
              onSave={saveTag}
              onCancel={() => setTagEditor(null)}
              busy={busy}
            />
          </div>
        )}
        {annotations.bookTags.length === 0 ? (
          !tagEditor && <p className="text-sm text-muted-foreground">{t("annotations.list.noBookTags")}</p>
        ) : (
          <ul className="divide-y">
            {annotations.bookTags.map((tag) => (
              <li key={tag.id} className="flex flex-wrap items-center gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <TagLabel tag={{ ...tag, scope: "book" }} />
                  {tag.description && <p className="mt-1 text-sm text-muted-foreground">{tag.description}</p>}
                </div>
                <Button size="icon" variant="ghost" className="[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11" aria-label={t("annotations.tag.edit", { name: tag.name })} onClick={() => setTagEditor({ tag })}><PencilLine className="h-4 w-4" /></Button>
                <Button size="icon" variant="ghost" className="text-destructive [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11" aria-label={t("annotations.tag.delete", { name: tag.name })} onClick={() => void removeTag(tag)}><Trash2 className="h-4 w-4" /></Button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {notice.element}
    </>
  );
}
