import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { BookOpen, Check, Clock, FileText, MessageCircle, PencilLine, Sparkles, Trash2, X } from "lucide-react";
import "@/i18n/annotationsPage";
import { Button } from "@/components/ui/button";
import { TagLabel } from "@/components/annotations/TagLabel";
import { AnchorNotice } from "@/components/annotations/AnchorNotice";
import { annotationStatus, isPendingStatus, type Annotation, type AnnotationStatus, type ResolvedTag } from "@/annotations/model";
import type { AnchorState } from "@/annotations/anchoring";
import { cn } from "@/lib/utils";

export interface NoteCardActions {
  onSelect: (annotation: Annotation, selected: boolean) => void;
  onStatus: (annotation: Annotation, status: AnnotationStatus) => void;
  onFix: (annotation: Annotation) => void;
  onReason: (annotation: Annotation) => void;
  onEdit: (annotation: Annotation) => void;
  onDelete: (annotation: Annotation) => void;
}

/** The status buttons of a note: the one it has is pressed, and each says what it does. Handled, later and dismissed (open again is the fourth). */
const STATUS_BUTTONS: Array<{ status: AnnotationStatus; icon: typeof Check }> = [
  { status: "handled", icon: Check },
  { status: "later", icon: Clock },
  { status: "dismissed", icon: X },
];

const BUTTON = "[@media(pointer:coarse)]:h-11";

/**
 * A note on the page of the notes: its tag, its status and how it was handled, its passage and its words, where it is (scene) and, once looked at, where the
 * passage is now; and what can be done with it: close it as handled, later or dismissed, fix it with the AI, think about it with the AI, show it in the reader,
 * open its paragraph, edit it or delete it. The checkbox selects it for the changes made to several notes at once.
 */
export function NoteCard({ annotation, tag, sceneTitle, sceneNumber, bookId, selected, anchor, actions }: {
  annotation: Annotation;
  tag: ResolvedTag;
  sceneTitle: string;
  sceneNumber?: string;
  bookId: string;
  selected: boolean;
  /** Where the passage is now, when it is known (the page does not read every scene of a book; the dialogs find it when they need it). */
  anchor?: AnchorState;
  actions: NoteCardActions;
}) {
  const { t } = useTranslation();
  const status = annotationStatus(annotation.status);
  const pending = isPendingStatus(status);
  const resolution = annotation.resolution;
  const paragraphHref = sceneNumber ? `/app/books/${bookId}/chapters/${annotation.chapter}/paragraphs/${sceneNumber}` : undefined;
  const label = annotation.quote.length > 60 ? `${annotation.quote.slice(0, 59)}…` : annotation.quote;

  return (
    <li className={cn("space-y-2 rounded-xl border bg-card p-3 sm:p-4", selected && "border-primary/60 ring-1 ring-primary/30")} data-note-id={annotation.id} data-note-status={status}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <label className="inline-flex min-h-6 cursor-pointer items-center gap-2 [@media(pointer:coarse)]:min-h-11">
          <input type="checkbox" checked={selected} onChange={(event) => actions.onSelect(annotation, event.target.checked)} className="h-4 w-4 [@media(pointer:coarse)]:h-5 [@media(pointer:coarse)]:w-5" />
          <span className="sr-only">{t("annotationsPage.select", { quote: label })}</span>
        </label>
        <TagLabel tag={tag} showScope />
        <span className={cn("ml-auto rounded-full border px-2 py-0.5 text-xs", pending ? "border-primary/40 text-primary" : "text-muted-foreground")}>{t(`annotations.status.${status}`)}</span>
      </div>
      <blockquote className="border-l-4 border-primary/40 pl-3 font-serif text-sm sm:text-base">{annotation.quote}</blockquote>
      {annotation.comment && <p className="whitespace-pre-wrap break-words text-sm">{annotation.comment}</p>}
      <p className="text-xs text-muted-foreground">{sceneNumber ? `${sceneNumber} · ` : ""}{sceneTitle}</p>
      {anchor && anchor !== "exact" && <AnchorNotice state={anchor} />}
      {resolution && status === "handled" && (
        <p className="text-xs text-muted-foreground" data-note-resolution="">
          {t(`annotationsPage.resolution.${resolution.by === "ai" || resolution.by === "autopilot" ? resolution.by : "author"}`)}
          {resolution.summary ? ` — ${resolution.summary}` : ""}
        </p>
      )}

      <div className="flex flex-wrap gap-2" role="group" aria-label={t("annotationsPage.statusGroup", { quote: label })}>
        {STATUS_BUTTONS.map(({ status: value, icon: Icon }) => (
          <Button key={value} type="button" size="sm" variant={status === value ? "default" : "outline"} aria-pressed={status === value} onClick={() => actions.onStatus(annotation, status === value ? "open" : value)} className={BUTTON} title={status === value ? t("annotationsPage.reopenHint") : undefined}>
            <Icon aria-hidden="true" />{t(`annotationsPage.mark.${value}`)}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={() => actions.onFix(annotation)} className={BUTTON} data-note-action="fix"><Sparkles aria-hidden="true" />{t("annotationsPage.fixWithAi")}</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => actions.onReason(annotation)} className={BUTTON} data-note-action="reason"><MessageCircle aria-hidden="true" />{t("annotationsPage.reasonTogether")}</Button>
        <Button asChild size="sm" variant="outline" className={BUTTON}>
          <Link to={`/app/books/${bookId}/reader`} state={{ annotationId: annotation.id }}><BookOpen aria-hidden="true" />{t("annotationsPage.showInReader")}</Link>
        </Button>
        {paragraphHref && <Button asChild size="sm" variant="outline" className={BUTTON}><Link to={paragraphHref}><FileText aria-hidden="true" />{t("annotationsPage.openParagraph")}</Link></Button>}
        <Button type="button" size="sm" variant="ghost" onClick={() => actions.onEdit(annotation)} className={BUTTON}><PencilLine aria-hidden="true" />{t("annotationsPage.edit")}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => actions.onDelete(annotation)} className={cn("text-destructive", BUTTON)}><Trash2 aria-hidden="true" />{t("annotationsPage.delete")}</Button>
      </div>
    </li>
  );
}
