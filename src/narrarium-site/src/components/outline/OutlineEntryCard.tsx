import { memo, useId, useRef, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, BetweenHorizontalEnd, BetweenHorizontalStart, BookOpen, Bot, CheckCircle2, History, Info, Loader2, Lock, PenLine, RefreshCcw, Save, Trash2, TriangleAlert, Undo2 } from "lucide-react";
import type { OutlineChapterEntry } from "narrarium-engine";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { EntryStatus } from "@/outline/outlineModel";
import type { EntryDraft } from "@/components/outline/useOutlineEditor";
import { DesignSection } from "@/components/outline/DesignSection";
import type { Ghostwriter } from "@/types/book";
import { cn } from "@/lib/utils";
import { formatCount } from "@/autopilot/format";

/** The value of the ghostwriter field that stands for the book's ghostwriter: no ghostwriter in the entry. */
const BOOK_GHOSTWRITER = "__book__";

export interface OutlineEntryHandlers {
  onEdit: (number: number, patch: Partial<Pick<EntryDraft, "title" | "body" | "ghostwriter" | "design">>) => void;
  onSave: (number: number) => void;
  onDiscard: (number: number) => void;
  onInsert: (number: number, where: "before" | "after") => void;
  onMove: (number: number, direction: "up" | "down") => void;
  onRemove: (number: number) => void;
  onFocusEntry: (number: number) => void;
}

export interface OutlineEntryCardProps extends OutlineEntryHandlers {
  bookId: string;
  entry: OutlineChapterEntry;
  draft: EntryDraft | undefined;
  dirty: boolean;
  status: EntryStatus;
  ghostwriters: readonly Ghostwriter[];
  first: boolean;
  last: boolean;
  busy: boolean;
  /** What changed in the entry, as «What changed» tells it (what the autopilot will do about a change it has not followed yet): absent when nothing is worth saying. */
  change?: string;
  /** What the page adds to the text of the entry (the assistant of the context menu registers it). */
  renderBody?: (props: { number: number; textareaRef: React.RefObject<HTMLTextAreaElement | null>; value: string; onChange: (value: string) => void }) => ReactNode;
}

function StatusItem({ icon, children, className }: { icon: ReactNode; children: ReactNode; className?: string }) {
  return <li className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium", className)}>{icon}{children}</li>;
}

/**
 * One entry of the Outline: its number and title, what became of it (in words and with an icon, never by colour alone), its fields and its
 * actions. Every field and button names its chapter, so that a screen reader that lists them tells one entry from another.
 */
export const OutlineEntryCard = memo(function OutlineEntryCard(props: OutlineEntryCardProps) {
  const { bookId, entry, draft, dirty, status, ghostwriters, first, last, busy } = props;
  const { t } = useTranslation();
  const number = entry.number;
  const id = useId();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const title = draft?.title ?? entry.title;
  const body = draft?.body ?? entry.body;
  const ghostwriter = draft ? draft.ghostwriter : entry.ghostwriter ?? null;
  const missing = ghostwriter && !ghostwriters.some((candidate) => candidate.slug === ghostwriter) ? ghostwriter : null;
  const headingId = `outline-chapter-${number}-title`;
  const savedTitle = entry.title.trim();

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!event.altKey || busy) return;
    if (event.key === "ArrowUp" && !first) {
      event.preventDefault();
      props.onMove(number, "up");
    } else if (event.key === "ArrowDown" && !last) {
      event.preventDefault();
      props.onMove(number, "down");
    }
  };

  const iconButton = (label: string, icon: ReactNode, onClick: () => void, disabled = false, extra: Record<string, string> = {}) => (
    <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label={label} title={label} onClick={onClick} disabled={busy || disabled} {...extra}>{icon}</Button>
  );

  return (
    <article
      id={`outline-chapter-${number}`}
      tabIndex={-1}
      aria-labelledby={headingId}
      data-outline-entry={number}
      onKeyDown={onKeyDown}
      onFocusCapture={() => props.onFocusEntry(number)}
      className={cn("space-y-3 rounded-2xl border border-layer bg-card p-4 shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring", dirty && "border-primary/60")}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 id={headingId} className="min-w-0 flex-1 font-serif text-lg font-semibold leading-tight">
          {t("outline.entry.heading", { number })}
          <span className="font-sans text-base font-normal text-muted-foreground"> — {savedTitle || t("outline.entry.untitled")}</span>
        </h3>
        <div role="group" aria-label={t("outline.entry.actions", { number })} className="flex flex-wrap items-center gap-0.5">
          {iconButton(t("outline.entry.moveUp", { number }), <ArrowUp className="h-4 w-4" aria-hidden="true" />, () => props.onMove(number, "up"), first, { "aria-keyshortcuts": "Alt+ArrowUp", "data-outline-action": "move-up" })}
          {iconButton(t("outline.entry.moveDown", { number }), <ArrowDown className="h-4 w-4" aria-hidden="true" />, () => props.onMove(number, "down"), last, { "aria-keyshortcuts": "Alt+ArrowDown", "data-outline-action": "move-down" })}
          {iconButton(t("outline.entry.insertBefore", { number }), <BetweenHorizontalStart className="h-4 w-4" aria-hidden="true" />, () => props.onInsert(number, "before"))}
          {iconButton(t("outline.entry.insertAfter", { number }), <BetweenHorizontalEnd className="h-4 w-4" aria-hidden="true" />, () => props.onInsert(number, "after"))}
          {iconButton(t("outline.entry.remove", { number }), <Trash2 className="h-4 w-4 text-destructive" aria-hidden="true" />, () => props.onRemove(number), false, { "data-outline-action": "remove" })}
        </div>
      </div>

      <ul aria-label={t("outline.status.label")} className="flex flex-wrap gap-1.5">
        {status.origin === "autopilot"
          ? <StatusItem icon={<Bot className="h-3.5 w-3.5" aria-hidden="true" />} className="text-muted-foreground">{t("outline.status.autopilot")}</StatusItem>
          : <StatusItem icon={<PenLine className="h-3.5 w-3.5" aria-hidden="true" />} className="border-primary/40 text-foreground">{t("outline.status.author")}</StatusItem>}
        {status.written && (
          <StatusItem icon={<BookOpen className="h-3.5 w-3.5" aria-hidden="true" />} className="text-foreground">
            <Link to={`/app/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(status.written.slug)}`} className="inline-flex min-h-6 items-center underline underline-offset-4">{t("outline.status.written")}</Link>
          </StatusItem>
        )}
        {status.frozen && <StatusItem icon={<Lock className="h-3.5 w-3.5" aria-hidden="true" />} className="text-foreground">{t("outline.status.frozen")}</StatusItem>}
        {status.approved && <StatusItem icon={<CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />} className="text-emerald-700 dark:text-emerald-400">{t("outline.status.approved")}</StatusItem>}
        {status.replan && <StatusItem icon={<RefreshCcw className="h-3.5 w-3.5" aria-hidden="true" />} className="text-amber-800 dark:text-amber-300">{t("outline.status.replan")}</StatusItem>}
        {props.change && <StatusItem icon={<History className="h-3.5 w-3.5" aria-hidden="true" />} className="border-amber-500/50 text-amber-900 dark:text-amber-200">{props.change}</StatusItem>}
      </ul>

      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,16rem)]">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-title`} className="text-xs text-muted-foreground">{t("outline.entry.titleLabel")}</Label>
          <Input id={`${id}-title`} data-outline-field="title" aria-label={t("outline.entry.title", { number })} value={title} maxLength={400} onChange={(event) => props.onEdit(number, { title: event.target.value })} className="h-9" />
        </div>
        <div className="space-y-1.5">
          <Label id={`${id}-ghostwriter-label`} className="text-xs text-muted-foreground">{t("outline.entry.ghostwriterLabel")}</Label>
          <Select value={ghostwriter ?? BOOK_GHOSTWRITER} onValueChange={(value) => props.onEdit(number, { ghostwriter: value === BOOK_GHOSTWRITER ? null : value })}>
            <SelectTrigger className="h-9" aria-label={t("outline.entry.ghostwriter", { number })}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={BOOK_GHOSTWRITER}>{t("outline.entry.ghostwriterDefault")}</SelectItem>
              {ghostwriters.map((candidate) => <SelectItem key={candidate.slug} value={candidate.slug}>{candidate.name || candidate.slug}</SelectItem>)}
              {missing && <SelectItem value={missing}>{t("outline.entry.ghostwriterMissingOption", { slug: missing })}</SelectItem>}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${id}-body`} className="text-xs text-muted-foreground">{t("outline.entry.bodyLabel")}</Label>
        {props.renderBody ? props.renderBody({ number, textareaRef, value: body, onChange: (value) => props.onEdit(number, { body: value }) }) : null}
        <AutoTextarea
          ref={textareaRef}
          id={`${id}-body`}
          data-outline-field="body"
          aria-label={t("outline.entry.body", { number })}
          value={body}
          minRows={3}
          maxHeight={480}
          onChange={(event) => props.onEdit(number, { body: event.target.value })}
          placeholder={t("outline.entry.bodyPlaceholder")}
          className="text-sm leading-6"
        />
      </div>

      <DesignSection number={number} design={entry.design} draft={draft?.design} busy={busy} onChange={(design) => props.onEdit(number, { design })} />

      {(missing || status.warnings.length > 0) && (
        <ul className="space-y-1 text-xs text-amber-800 dark:text-amber-300">
          {missing && <li className="flex items-start gap-1.5"><TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{t("outline.warning.ghostwriterMissing", { slug: missing })}</li>}
          {status.warnings.map((warning, index) => (
            <li key={`${warning.code}-${index}`} className="flex items-start gap-1.5">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0">
                {t(`outline.warning.${warning.code}`, { defaultValue: t("outline.warning.other") })}
                <details className="text-muted-foreground"><summary className="cursor-pointer">{t("outline.warning.details")}</summary><span lang="en" className="break-words">{warning.message}</span></details>
              </span>
            </li>
          ))}
        </ul>
      )}

      {dirty && (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3">
          {/* What saving does to a chapter the autopilot already closed or has in its hands, said before the author saves: it may ask, rewrite the chapter, only report it, or tell it once and decide when the chapter is closed. */}
          {status.afterChange && (
            <p id={`${id}-after-change`} className="flex w-full items-start gap-1.5 text-xs text-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
              {t(`outline.written.${status.afterChange}`, { count: 1, numbers: [formatCount(number)] })}
            </p>
          )}
          <span className="mr-auto inline-flex items-center gap-1.5 text-xs font-medium text-foreground"><PenLine className="h-3.5 w-3.5" aria-hidden="true" />{t("outline.entry.unsaved")}</span>
          <Button type="button" size="sm" variant="ghost" aria-label={t("outline.entry.discard", { number })} onClick={() => props.onDiscard(number)} disabled={busy}><Undo2 className="h-4 w-4" aria-hidden="true" />{t("outline.entry.discardLabel")}</Button>
          <Button type="button" size="sm" aria-label={t("outline.entry.save", { number })} aria-describedby={status.afterChange ? `${id}-after-change` : undefined} onClick={() => props.onSave(number)} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}{t("common.save")}
          </Button>
        </div>
      )}
    </article>
  );
});
