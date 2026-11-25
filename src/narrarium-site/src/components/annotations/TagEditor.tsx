import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n/annotations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MarkIcon, MarkSample } from "@/components/annotations/TagLabel";
import {
  MARK_COLORS,
  MARK_ICONS,
  MARK_UNDERLINES,
  TAG_DESCRIPTION_MAX,
  TAG_NAME_MAX,
  createTagId,
  type AnnotationTagDefinition,
  type MarkStyle,
} from "@/annotations/model";
import { cn } from "@/lib/utils";

const OPTION = "inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 [@media(pointer:coarse)]:min-h-11";
const chosen = (selected: boolean) => (selected ? "border-primary bg-primary/10 font-medium" : "border-field hover:bg-accent/60");

/** A new mark: the next combination of the palette that the existing tags do not use yet. */
export function suggestedMark(existing: readonly MarkStyle[]): MarkStyle {
  const used = new Set(existing.map((mark) => `${mark.underline}|${mark.color}|${mark.icon}`));
  for (let index = 0; index < MARK_COLORS.length * MARK_UNDERLINES.length; index += 1) {
    const mark: MarkStyle = {
      color: MARK_COLORS[(index + 3) % MARK_COLORS.length],
      underline: MARK_UNDERLINES[(index + 2) % MARK_UNDERLINES.length],
      icon: MARK_ICONS[(index + 5) % MARK_ICONS.length],
    };
    if (!used.has(`${mark.underline}|${mark.color}|${mark.icon}`)) return mark;
  }
  return { color: "teal", underline: "dotted", icon: "flag" };
}

/**
 * The form of a tag: its name, the mark it draws (underline, icon, colour, each a group of radio buttons with a visible name) and its description, which
 * is also the instruction for the AI. Used for the tags of every book (Settings) and for the tags of one book (the reader, the list of a chapter).
 */
export function TagEditor({ initial, takenNames, suggested, onSave, onCancel, saveLabel, busy }: {
  initial?: AnnotationTagDefinition;
  /** Names of the other tags, lower case: a second tag with one of them is refused. */
  takenNames: readonly string[];
  suggested?: MarkStyle;
  onSave: (tag: AnnotationTagDefinition) => void | Promise<void>;
  onCancel: () => void;
  saveLabel?: string;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  const base = useId();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [mark, setMark] = useState<MarkStyle>(initial?.mark ?? suggested ?? { underline: "dotted", color: "teal", icon: "flag" });
  const [tried, setTried] = useState(false);
  const trimmed = name.trim();
  const taken = takenNames.includes(trimmed.toLocaleLowerCase()) && trimmed.toLocaleLowerCase() !== initial?.name.trim().toLocaleLowerCase();
  const problem = !trimmed ? t("annotations.tagEditor.nameRequired") : taken ? t("annotations.tagEditor.nameTaken") : "";

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setTried(true);
    if (problem) return;
    const now = new Date().toISOString();
    void onSave({
      ...(initial ?? {}),
      id: initial?.id ?? createTagId(trimmed),
      name: trimmed,
      description: description.trim(),
      mark,
      createdAt: initial?.createdAt ?? now,
      updatedAt: now,
    });
  };

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="grid gap-2">
        <Label htmlFor={`${base}-name`}>{t("annotations.tagEditor.name")}</Label>
        <Input
          id={`${base}-name`}
          value={name}
          maxLength={TAG_NAME_MAX}
          placeholder={t("annotations.tagEditor.namePlaceholder")}
          onChange={(event) => setName(event.target.value)}
          aria-invalid={tried && Boolean(problem)}
          aria-describedby={tried && problem ? `${base}-name-problem` : undefined}
          autoComplete="off"
          className="[@media(pointer:coarse)]:h-11"
        />
        {tried && problem && <p id={`${base}-name-problem`} className="text-sm text-destructive">{problem}</p>}
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("annotations.tagEditor.underline")}</legend>
        <div className="flex flex-wrap gap-2">
          {MARK_UNDERLINES.map((underline) => (
            <label key={underline} className={cn(OPTION, chosen(mark.underline === underline))}>
              <input type="radio" name={`${base}-underline`} className="sr-only" checked={mark.underline === underline} onChange={() => setMark({ ...mark, underline })} />
              <span className="annotation-mark-sample px-0.5" data-mark-color={mark.color} data-mark-underline={underline}>{t(`annotations.underline.${underline}`)}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("annotations.tagEditor.icon")}</legend>
        <div className="flex flex-wrap gap-2">
          {MARK_ICONS.map((icon) => (
            <label key={icon} className={cn(OPTION, "min-w-9 justify-center px-2 [@media(pointer:coarse)]:min-w-11", chosen(mark.icon === icon))} title={t(`annotations.icon.${icon}`)}>
              <input type="radio" name={`${base}-icon`} className="sr-only" checked={mark.icon === icon} onChange={() => setMark({ ...mark, icon })} />
              <span data-mark-color={mark.color} className="annotation-mark-icon inline-flex"><MarkIcon icon={icon} /></span>
              <span className="sr-only">{t(`annotations.icon.${icon}`)}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("annotations.tagEditor.color")}</legend>
        <div className="flex flex-wrap gap-2">
          {MARK_COLORS.map((color) => (
            <label key={color} className={cn(OPTION, chosen(mark.color === color))}>
              <input type="radio" name={`${base}-color`} className="sr-only" checked={mark.color === color} onChange={() => setMark({ ...mark, color })} />
              <span data-mark-color={color} className="annotation-mark-icon inline-flex h-4 w-4 rounded-full border-2 border-current bg-current" aria-hidden="true" />
              <span>{t(`annotations.color.${color}`)}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-2">
        <Label htmlFor={`${base}-description`}>{t("annotations.tagEditor.description")}</Label>
        <Textarea
          id={`${base}-description`}
          value={description}
          maxLength={TAG_DESCRIPTION_MAX}
          rows={3}
          onChange={(event) => setDescription(event.target.value)}
          aria-describedby={`${base}-description-hint`}
        />
        <p id={`${base}-description-hint`} className="text-xs text-muted-foreground">{t("annotations.tagEditor.descriptionHint")}</p>
      </div>

      <div className="rounded-md border border-dashed p-3 text-sm" aria-live="polite">
        <span className="mr-2 text-xs uppercase tracking-wide text-muted-foreground">{t("annotations.tagEditor.preview")}</span>
        <MarkSample mark={mark}>{trimmed || t("annotations.tagEditor.previewText")}</MarkSample>
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy} className="[@media(pointer:coarse)]:h-11">{t("annotations.tagEditor.cancel")}</Button>
        <Button type="submit" disabled={busy} className="[@media(pointer:coarse)]:h-11">{saveLabel ?? (initial ? t("annotations.tagEditor.save") : t("annotations.tagEditor.create"))}</Button>
      </div>
    </form>
  );
}
