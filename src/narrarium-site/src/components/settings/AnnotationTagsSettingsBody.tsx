import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, PencilLine, Plus, Trash2 } from "lucide-react";
import "@/i18n/annotations";
import { Button } from "@/components/ui/button";
import { TagEditor, suggestedMark } from "@/components/annotations/TagEditor";
import { TagLabel } from "@/components/annotations/TagLabel";
import { BUILTIN_TAGS, appLanguage, builtinTag, markToWrite, type AnnotationTagDefinition } from "@/annotations/model";
import { liveAccountTags, pruneAccountTagTombstones, storedAccountTags } from "@/annotations/accountTags";
import type { AppSettings } from "@/types/settings";

/**
 * Settings › Annotation tags: the built-in tags (shown, not changed) and the tags for every book, made, changed, reordered and deleted here. They are
 * account data: the changes are saved with the bar of the settings. A deleted tag stays in the data as a tombstone until it is old, so that a copy of
 * the account data that still has it does not bring it back; the annotations that use it keep their passage and note.
 */
export function AnnotationTagsSettingsBody({ settings, patchSettings }: { settings: AppSettings; patchSettings: (patch: Partial<AppSettings>) => void }) {
  const { t, i18n } = useTranslation();
  const language = appLanguage(i18n.resolvedLanguage ?? i18n.language);
  const all = storedAccountTags(settings.annotations);
  const live = liveAccountTags(all);
  const [editing, setEditing] = useState<{ tag?: AnnotationTagDefinition } | null>(null);

  const write = (tags: AnnotationTagDefinition[]) => {
    patchSettings({ annotations: { ...settings.annotations, tags: pruneAccountTagTombstones(tags, new Date()) } });
  };
  const save = (shown: AnnotationTagDefinition) => {
    const stored = all.find((entry) => entry?.id === shown.id);
    // A value of a newer app that this one shows as the stand-in's is kept while it is not changed.
    const tag = stored ? { ...shown, mark: markToWrite(stored.mark, shown.mark) } : shown;
    write(stored ? all.map((entry) => (entry?.id === tag.id ? tag : entry)) : [...all, tag]);
    setEditing(null);
  };
  const move = (tag: AnnotationTagDefinition, direction: -1 | 1) => {
    const position = live.findIndex((entry) => entry.id === tag.id);
    const other = live[position + direction];
    if (!other) return;
    const next = [...all];
    const from = next.findIndex((entry) => entry?.id === tag.id);
    const to = next.findIndex((entry) => entry?.id === other.id);
    [next[from], next[to]] = [next[to], next[from]];
    write(next);
  };
  const remove = (tag: AnnotationTagDefinition) => {
    if (!window.confirm(t("annotations.settings.deleteConfirm", { name: tag.name }))) return;
    const now = new Date().toISOString();
    write(all.map((entry) => (entry?.id === tag.id ? { ...entry, deletedAt: now, updatedAt: now } : entry)));
  };
  const takenNames = [...BUILTIN_TAGS.map((tag) => builtinTag(tag.id, language)!.name), ...live.map((tag) => tag.name)].map((name) => name.toLocaleLowerCase());

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">{t("annotations.settings.intro")}</p>

      <section aria-labelledby="annotation-tags-builtin" className="space-y-2">
        <h3 id="annotation-tags-builtin" className="font-semibold">{t("annotations.settings.builtinTitle")}</h3>
        <p className="text-sm text-muted-foreground">{t("annotations.settings.builtinDescription")}</p>
        <ul className="divide-y rounded-lg border">
          {BUILTIN_TAGS.map((entry) => {
            const tag = builtinTag(entry.id, language)!;
            return (
              <li key={tag.id} className="space-y-1 px-3 py-2">
                <TagLabel tag={tag} />
                <p className="text-sm text-muted-foreground">{tag.description}</p>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="annotation-tags-custom" className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 id="annotation-tags-custom" className="font-semibold">{t("annotations.settings.customTitle")}</h3>
            <p className="text-sm text-muted-foreground">{t("annotations.settings.customDescription")}</p>
          </div>
          {!editing && <Button size="sm" onClick={() => setEditing({})} className="[@media(pointer:coarse)]:h-11"><Plus aria-hidden="true" />{t("annotations.settings.add")}</Button>}
        </div>
        {editing && (
          <div className="rounded-lg border p-3">
            <TagEditor
              initial={editing.tag}
              takenNames={takenNames}
              suggested={suggestedMark([...BUILTIN_TAGS.map((tag) => tag.mark), ...live.map((tag) => tag.mark)])}
              onSave={save}
              onCancel={() => setEditing(null)}
            />
          </div>
        )}
        {live.length === 0 ? (
          !editing && <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">{t("annotations.settings.empty")}</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {live.map((tag, index) => (
              <li key={tag.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <div className="min-w-0 flex-1 space-y-1">
                  <TagLabel tag={{ id: tag.id, scope: "global", name: tag.name, description: tag.description, mark: tag.mark }} />
                  {tag.description && <p className="text-sm text-muted-foreground">{tag.description}</p>}
                </div>
                <div className="flex items-center gap-1">
                  <Button size="icon" variant="ghost" className="h-9 w-9 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11" disabled={index === 0} aria-label={t("annotations.settings.moveUp", { name: tag.name })} onClick={() => move(tag, -1)}><ChevronUp className="h-4 w-4" /></Button>
                  <Button size="icon" variant="ghost" className="h-9 w-9 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11" disabled={index === live.length - 1} aria-label={t("annotations.settings.moveDown", { name: tag.name })} onClick={() => move(tag, 1)}><ChevronDown className="h-4 w-4" /></Button>
                  <Button size="icon" variant="ghost" className="h-9 w-9 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11" aria-label={t("annotations.tag.edit", { name: tag.name })} onClick={() => setEditing({ tag })}><PencilLine className="h-4 w-4" /></Button>
                  <Button size="icon" variant="ghost" className="h-9 w-9 text-destructive [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11" aria-label={t("annotations.tag.delete", { name: tag.name })} onClick={() => remove(tag)}><Trash2 className="h-4 w-4" /></Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
