import { memo, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Bot, ChevronDown, Loader2, MessageSquarePlus, PenLine, UserRound } from "lucide-react";
import { MAX_RULE_CHARACTERS, type PlannedChapter } from "narrarium-engine";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useAutopilotActions } from "@/autopilot/useAutopilotActions";
import type { ChangeEffect, OutlineOrigin } from "@/autopilot/planApprovalModel";
import { cn } from "@/lib/utils";

/** A list under a small title, the title naming the list for a screen reader. Nothing when the list is empty. */
function Listed({ title, items, ordered = false }: { title: string; items: readonly ReactNode[]; ordered?: boolean }) {
  const id = useId();
  if (!items.length) return null;
  const List = ordered ? "ol" : "ul";
  return (
    <div className="space-y-1">
      <h5 id={id} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h5>
      <List aria-labelledby={id} className={cn("space-y-1 text-sm", ordered ? "list-none" : "list-disc pl-5")}>
        {items.map((item, index) => <li key={index}>{item}</li>)}
      </List>
    </div>
  );
}

/** A mark on a chapter, in words with an icon: who wrote its entry of the outline, its ghostwriter, that the author wrote it. */
function Mark({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <li className="inline-flex items-center gap-1 rounded-full border border-layer bg-background px-2 py-0.5 text-xs font-medium text-foreground">{icon}{children}</li>;
}

interface AskProps {
  bookId: string;
  number: number;
  title: string;
  effect: ChangeEffect;
  onSent: (number: number) => void;
}

/**
 * Asking for a change of one chapter: the author's words, sent as the intervention that rewrites (`scope: "rewrite"`) about that chapter, with the
 * effect it always had (a rule of the book, and the plan made again with it, or the written chapters revised). What it does is said under the field.
 * The focus goes into the field when it opens and back to the button when it closes.
 */
function AskForChange({ bookId, number, title, effect, onSent }: AskProps) {
  const { t } = useTranslation();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const { busy, run } = useAutopilotActions(bookId);
  const button = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const opened = useRef(false);
  useEffect(() => {
    if (open) field.current?.focus();
    else if (opened.current) button.current?.focus();
    opened.current = open;
  }, [open]);
  // The words go into a rule, which has a limit: what the chapter's name takes is left out of it.
  const room = Math.max(1, MAX_RULE_CHARACTERS - t("autopilot.approval.change.note", { number, title, text: "" }).length);
  const close = () => {
    setOpen(false);
    setText("");
  };
  const send = async (event: FormEvent) => {
    event.preventDefault();
    const words = text.trim();
    if (!words) return;
    const note = t("autopilot.approval.change.note", { number, title, text: words });
    const done = await run("intervene", (runtime, book) => runtime.intervene(book, { scope: "rewrite", text: note }));
    if (!done) return;
    onSent(number);
    close();
  };
  const sending = busy === "intervene";
  return (
    <div className="space-y-2">
      <Button ref={button} type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-9" aria-label={t("autopilot.approval.change.ask", { number })} aria-expanded={open} aria-controls={open ? `${id}-form` : undefined} onClick={() => (open ? close() : setOpen(true))}>
        <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />{t("autopilot.approval.change.askShort")}
      </Button>
      {open && (
        <form id={`${id}-form`} onSubmit={(event) => void send(event)} className="space-y-2 rounded-lg border border-layer bg-background p-3">
          <Label htmlFor={`${id}-text`} className="text-sm font-medium">{t("autopilot.approval.change.label", { number })}</Label>
          <AutoTextarea ref={field} id={`${id}-text`} value={text} minRows={3} maxLength={room} onChange={(event) => setText(event.target.value)} aria-describedby={`${id}-hint`} className="text-sm" />
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">{t(effect === "replan" ? "autopilot.approval.change.replan" : "autopilot.approval.change.written")}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" className="min-h-11 sm:min-h-9" disabled={!text.trim() || busy !== null}>
              {sending ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" /> : <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />}{t("autopilot.approval.change.send")}
            </Button>
            <Button type="button" variant="ghost" size="sm" className="min-h-11 sm:min-h-9" onClick={close}>{t("autopilot.approval.change.cancel")}</Button>
          </div>
        </form>
      )}
    </div>
  );
}

export interface ApprovalChapterProps {
  bookId: string;
  chapter: PlannedChapter;
  open: boolean;
  onToggle: (number: number) => void;
  origin: OutlineOrigin | undefined;
  /** The name of the ghostwriter of the chapter, when it is not the book's. */
  ghostwriter: string | undefined;
  effect: ChangeEffect;
  onSent: (number: number) => void;
}

/**
 * One chapter of the plan to approve, open: its synopsis, its goal, its point of view, its key events and reveals, its scenes (or when they are
 * planned), who wrote its entry of the outline, its ghostwriter when it is not the book's, and the way to ask for a change. The title stays when
 * the chapter is collapsed, so that the plan can be read as a list of titles. Drawn again only when what it shows changes.
 */
export const ApprovalChapter = memo(function ApprovalChapter({ bookId, chapter, open, onToggle, origin, ghostwriter, effect, onSent }: ApprovalChapterProps) {
  const { t } = useTranslation();
  const id = useId();
  const marks: ReactNode[] = [];
  if (chapter.imported) marks.push(<Mark key="imported" icon={<UserRound className="h-3.5 w-3.5" aria-hidden="true" />}>{t("autopilot.approval.chapters.imported")}</Mark>);
  if (origin === "author") marks.push(<Mark key="outline" icon={<PenLine className="h-3.5 w-3.5" aria-hidden="true" />}>{t("autopilot.approval.chapters.outlineAuthor")}</Mark>);
  if (origin === "autopilot") marks.push(<Mark key="outline" icon={<Bot className="h-3.5 w-3.5" aria-hidden="true" />}>{t("autopilot.approval.chapters.outlineAutopilot")}</Mark>);
  if (ghostwriter) marks.push(<Mark key="ghostwriter" icon={<PenLine className="h-3.5 w-3.5" aria-hidden="true" />}>{t("autopilot.plan.ghostwriter", { name: ghostwriter })}</Mark>);
  const facts = [
    chapter.goal ? { term: t("autopilot.approval.chapters.goal"), value: chapter.goal } : null,
    chapter.pov.length ? { term: t("autopilot.approval.chapters.pov"), value: chapter.pov.join(", ") } : null,
  ].filter((fact): fact is { term: string; value: string } => fact !== null);
  return (
    <article data-plan-approval-chapter={chapter.number} aria-labelledby={`${id}-title`} className="space-y-3 rounded-xl border border-layer bg-background/60 p-3 sm:p-4">
      <div className="flex items-start gap-2">
        <h4 id={`${id}-title`} tabIndex={-1} className="min-w-0 flex-1 break-words rounded-sm text-base font-semibold leading-snug focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="tabular-nums text-muted-foreground">{chapter.number}.</span> {chapter.title}
        </h4>
        <Button type="button" variant="ghost" size="icon" className="h-11 w-11 shrink-0 sm:h-9 sm:w-9" aria-label={t("autopilot.approval.chapters.toggle", { number: chapter.number })} aria-expanded={open} aria-controls={open ? `${id}-body` : undefined} onClick={() => onToggle(chapter.number)}>
          <ChevronDown className={cn("h-4 w-4 transition-transform motion-reduce:transition-none", open && "rotate-180")} aria-hidden="true" />
        </Button>
      </div>
      {marks.length > 0 && <ul className="flex flex-wrap gap-1.5">{marks}</ul>}
      {open && (
        <div id={`${id}-body`} className="space-y-3">
          {chapter.summary && <p className="whitespace-pre-line text-sm">{chapter.summary}</p>}
          {facts.length > 0 && (
            <dl className="grid gap-x-3 gap-y-1 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
              {facts.map((fact) => (
                <div key={fact.term} className="contents">
                  <dt className="font-medium text-muted-foreground">{fact.term}</dt>
                  <dd className="min-w-0 break-words">{fact.value}</dd>
                </div>
              ))}
            </dl>
          )}
          <Listed title={t("autopilot.approval.chapters.keyEvents")} items={chapter.keyEvents} />
          <Listed title={t("autopilot.approval.chapters.reveals")} items={chapter.reveals} />
          {chapter.scenes.length > 0 ? (
            <Listed
              ordered
              title={t("autopilot.approval.chapters.scenes")}
              items={chapter.scenes.map((scene) => (
                <span key={scene.number} className="flex gap-2">
                  <span className="w-6 shrink-0 tabular-nums text-muted-foreground">{scene.number}.</span>
                  <span className="min-w-0"><span className="font-medium">{scene.title}</span>{scene.summary || scene.goal ? <span className="text-muted-foreground"> — {scene.summary || scene.goal}</span> : null}</span>
                </span>
              ))}
            />
          ) : !chapter.imported ? (
            <p className="text-xs text-muted-foreground">{t("autopilot.approval.chapters.noScenes")}</p>
          ) : null}
        </div>
      )}
      {!chapter.imported && <AskForChange bookId={bookId} number={chapter.number} title={chapter.title} effect={effect} onSent={onSent} />}
    </article>
  );
});
